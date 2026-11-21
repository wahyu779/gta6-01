#!/usr/bin/env python3
"""Lane I integration #2: playtest + retake the 4 final screenshots (AZURE BAY).

Written fresh in this session (Lane I, 2026-11-20). Serves game/ with
`node serve.ts`, drives headless Chromium (SwiftShader) via Playwright.

Playtest expectations (from the game's own staging modes):
  menu    : traffic 8 cars, peds 12, wanted 0, no heli
  traffic : traffic 8, peds 12
  chase   : wanted 3, police cars present, player car ahead of police
  combat  : wanted 2, pistol out, muzzle flash present
  heli    : wanted 5, heli present and airborne
  city    : wide city view, skyline present
Every load must produce 0 console errors, 0 pageerrors, 0 failed requests.

Screenshots: combat.jpg / chase.jpg / heli.jpg / city.jpg, 1280x800,
JPEG quality 78, each <= 256 KiB. shots.json must list exactly those 4.

Usage: python3 lane-i-playtest.py [--playtest-only | --shots-only]
Writes lane-i-report.json next to this file.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PORT = 8903
BASE = f"http://127.0.0.1:{PORT}"
CAP = 262144
FINAL_SHOTS = ["combat.jpg", "chase.jpg", "heli.jpg", "city.jpg"]

COUNT_JS = """() => {
  const a = window.__azure;
  if (!a) return { error: 'no window.__azure' };
  const n = (x) => (x ? x.length : 0);
  const heli = a.police && a.police.heli;
  return {
    traffic: n(a.traffic && a.traffic.cars),
    peds: n(a.pedestrians && a.pedestrians.peds),
    pedsAlive: (a.pedestrians?.peds || []).filter(p => p && p.alive !== false).length,
    wanted: a.wanted ? a.wanted.level : null,
    policeCars: n(a.police && a.police.cars),
    officers: n(a.police && a.police.officers),
    heli: !!heli,
    heliY: heli ? heli.position.y : null,
    starsLit: document.querySelectorAll('.star.lit, .wanted-star.lit').length,
    hudText: (document.querySelector('#hud') || document.body).innerText.slice(0, 400),
  };
}"""


def load_page(page, url, wait_ready):
    problems = []
    page.on("console", lambda m: problems.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
    page.on("requestfailed", lambda r: problems.append(f"requestfailed: {r.url} {r.failure}"))
    page.goto(url, wait_until="load", timeout=30000)
    if wait_ready:
        page.wait_for_function("window.__shotReady === true", timeout=300000)
    else:
        page.wait_for_function("window.__azure !== undefined", timeout=30000)
        time.sleep(20)
    return problems


def playtest(pw):
    browser = pw.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    results, problems = {}, []
    try:
        page = browser.new_page(viewport={"width": 480, "height": 300})
        problems += [f"menu: {p}" for p in load_page(page, BASE + "/", False)]
        results["menu"] = page.evaluate(COUNT_JS)
        page.close()
        for mode in ("traffic", "chase", "combat", "heli", "city"):
            page = browser.new_page(viewport={"width": 480, "height": 300})
            problems += [f"{mode}: {p}" for p in load_page(page, f"{BASE}/?shot={mode}", True)]
            results[mode] = page.evaluate(COUNT_JS)
            page.close()
    finally:
        browser.close()
    return results, problems


def take_shots(pw):
    browser = pw.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    out, problems = {}, []
    try:
        shots = json.loads((HERE / "shots.json").read_text())
        assert [s["name"] for s in shots] == FINAL_SHOTS, f"shots.json mismatch: {[s['name'] for s in shots]}"
        for shot in shots:
            dest = HERE / "screenshots" / shot["name"]
            page = browser.new_page(viewport={"width": 480, "height": 300})
            problems += [f"{shot['name']}: {p}" for p in load_page(page, BASE + "/" + shot["query"], True)]
            page.set_viewport_size({"width": 1280, "height": 800})
            time.sleep(8)
            page.screenshot(path=str(dest), type="jpeg", quality=78, timeout=180000)
            size = dest.stat().st_size
            out[shot["name"]] = {"bytes": size, "over_cap": size > CAP, "query": shot["query"]}
            print(f"wrote {shot['name']} ({size} bytes){' OVER CAP!' if size > CAP else ''}", flush=True)
            page.close()
    finally:
        browser.close()
    return out, problems


def check_expectations(results):
    fails = []
    def want(mode, key, expected):
        got = results.get(mode, {}).get(key)
        if got != expected:
            fails.append(f"{mode}.{key}: got {got}, want {expected}")
    want("menu", "traffic", 8)
    want("menu", "peds", 12)
    want("menu", "wanted", 0)
    want("menu", "heli", False)
    want("traffic", "traffic", 8)
    want("traffic", "peds", 12)
    want("chase", "wanted", 3)
    want("combat", "wanted", 2)
    want("heli", "wanted", 5)
    want("heli", "heli", True)
    if results.get("heli", {}).get("heliY") is not None and results["heli"]["heliY"] < 5:
        fails.append(f"heli.heliY too low: {results['heli']['heliY']}")
    if results.get("chase", {}).get("policeCars", 0) < 1:
        fails.append("chase.policeCars: no police cars")
    if results.get("combat", {}).get("officers", 0) < 1:
        fails.append("combat.officers: no officers")
    return fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--playtest-only", action="store_true")
    ap.add_argument("--shots-only", action="store_true")
    args = ap.parse_args()

    server = subprocess.Popen(
        ["node", "serve.ts", "--port", str(PORT)],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        time.sleep(1)
        report = {}
        with sync_playwright() as pw:
            if not args.shots_only:
                results, errs = playtest(pw)
                report["playtest"] = results
                report["playtest_errors"] = errs
                report["expectation_failures"] = check_expectations(results)
                print(json.dumps(results, indent=2))
                print(f"playtest errors: {len(errs)}; expectation failures: {len(report['expectation_failures'])}")
                for e in errs + report["expectation_failures"]:
                    print("  !", e)
            if not args.playtest_only:
                shots, errs = take_shots(pw)
                report["shots"] = shots
                report["shot_errors"] = errs
                print(f"shot errors: {len(errs)}")
                for e in errs:
                    print("  !", e)
        (HERE / "lane-i-report.json").write_text(json.dumps(report, indent=2))
        bad = report.get("playtest_errors", []) + report.get("shot_errors", []) + report.get("expectation_failures", [])
        bad += [f"{k} over cap" for k, v in report.get("shots", {}).items() if v["over_cap"]]
        return 1 if bad else 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    sys.exit(main())
