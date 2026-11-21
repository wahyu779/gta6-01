#!/usr/bin/env python3
"""Lane D integration: playtest + retake the 4 final screenshots for AZURE BAY.

Written fresh in this session (Lane D). Serves game/ via `node serve.ts`,
drives headless Chromium (SwiftShader) with Playwright, and:

  1. Playtest: loads the plain game (menu) and each ?shot= staging mode,
     reads window.__azure counts (traffic cars, peds, wanted level, heli),
     and records console errors / page errors / failed requests.
  2. Retakes screenshots/combat.jpg, chase.jpg, heli.jpg, city.jpg at
     1280x800 JPEG q78 (small-viewport settle, then resize — SwiftShader
     renders ~1 frame / 3 s at full res, so settling happens at 480x300).
  3. Checks every shot is <= 256 KiB.

Usage: python3 lane-d-playtest.py [--shots-only | --playtest-only]
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PORT = 8902
BASE = f"http://127.0.0.1:{PORT}"
SHOTS = json.loads((HERE / "shots.json").read_text())
CAP = 262144


def counts(page):
    return page.evaluate(
        """() => {
          const a = window.__azure;
          if (!a) return {error: 'no window.__azure'};
          const len = (x) => (x ? x.length : 0);
          return {
            traffic: len(a.traffic && a.traffic.cars),
            peds: len(a.pedestrians && a.pedestrians.peds),
            pedsAlive: (a.pedestrians?.peds || []).filter(p => p && p.alive !== false).length,
            wanted: a.wanted ? a.wanted.level : null,
            policeCars: len(a.police && a.police.cars),
            officers: len(a.police && a.police.officers),
            heli: !!(a.police && a.police.heli),
            heliPos: a.police && a.police.heli ? [a.police.heli.position.x, a.police.heli.position.y, a.police.heli.position.z] : null,
            health: undefined,
          };
        }"""
    )


def load_settled(page, url, wait_ready=True, timeout_ms=300000):
    errors = []
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("requestfailed", lambda r: errors.append(f"requestfailed: {r.url} {r.failure}"))
    page.goto(url, wait_until="load", timeout=30000)
    if wait_ready:
        page.wait_for_function("window.__shotReady === true", timeout=timeout_ms)
    else:
        # Plain game: no __shotReady; let the menu scene idle a while.
        page.wait_for_function("window.__azure !== undefined", timeout=30000)
        time.sleep(20)
    return errors


def playtest(pw):
    browser = pw.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    results = {}
    all_errors = []
    try:
        # Plain menu load.
        page = browser.new_page(viewport={"width": 480, "height": 300})
        errs = load_settled(page, BASE + "/", wait_ready=False)
        results["menu"] = counts(page)
        all_errors += [f"menu: {e}" for e in errs]
        page.close()
        # Each staging mode.
        for shot in ("traffic", "chase", "combat", "heli", "city"):
            page = browser.new_page(viewport={"width": 480, "height": 300})
            errs = load_settled(page, f"{BASE}/?shot={shot}")
            results[shot] = counts(page)
            all_errors += [f"{shot}: {e}" for e in errs]
            page.close()
    finally:
        browser.close()
    return results, all_errors


def take_shots(pw):
    browser = pw.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    out = {}
    all_errors = []
    try:
        for shot in SHOTS:
            name, query = shot["name"], shot["query"]
            dest = HERE / "screenshots" / name
            page = browser.new_page(viewport={"width": 480, "height": 300})
            errs = load_settled(page, BASE + "/" + query)
            page.set_viewport_size({"width": 1280, "height": 800})
            time.sleep(8)
            page.screenshot(path=str(dest), type="jpeg", quality=78, timeout=180000)
            size = dest.stat().st_size
            out[name] = {"bytes": size, "over_cap": size > CAP, "query": query}
            all_errors += [f"{name}: {e}" for e in errs]
            print(f"wrote {name} ({size} bytes){' OVER CAP!' if size > CAP else ''}", flush=True)
            page.close()
    finally:
        browser.close()
    return out, all_errors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots-only", action="store_true")
    ap.add_argument("--playtest-only", action="store_true")
    args = ap.parse_args()

    server = subprocess.Popen(
        ["node", "serve.ts", "--port", str(PORT)],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        time.sleep(1)
        with sync_playwright() as pw:
            report = {}
            if not args.shots_only:
                results, errs = playtest(pw)
                report["playtest"] = results
                report["playtest_errors"] = errs
                print(json.dumps(results, indent=2))
                print(f"playtest errors: {len(errs)}")
                for e in errs:
                    print("  !", e)
            if not args.playtest_only:
                shots, errs = take_shots(pw)
                report["shots"] = shots
                report["shot_errors"] = errs
                print(f"shot errors: {len(errs)}")
                for e in errs:
                    print("  !", e)
        (HERE / "lane-d-report.json").write_text(json.dumps(report, indent=2))
        bad = report.get("playtest_errors", []) + report.get("shot_errors", [])
        return 1 if bad else 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    sys.exit(main())
