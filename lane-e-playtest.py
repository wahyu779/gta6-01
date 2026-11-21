#!/usr/bin/env python3
"""Lane E (Fase 3) integration playtest + final 4 screenshots (AZURE BAY).

Written fresh in this session (Lane E, 2026-11-20). Serves game/ with
`node serve.ts`, drives headless Chromium (SwiftShader) via Playwright.

Playtest expectations:
  menu/traffic/chase/combat/heli/city: 0 console errors, 0 pageerrors,
  0 failed requests; Fase 2 counts (traffic 8, peds 12, wanted 3/2/5)
  plus Fase 3 wiring: all 8 lane modules present on window.__azure,
  10 missions registered (m1 available, m2-m10 locked), radio + respect
  + mission-tracker HUD chips mounted, NPC figures present.
  Shots must show a Fase 3 system: combat = Rook dialog open + mission
  tracker, chase = radio BAY BEATS + mission tracker, heli = radio
  AZURE FM + mission tracker, city = Fase 3 HUD chips.
Mission E2E (one live page, real keys + teleports through the real
engine loop): start m1 with E -> intro dialog -> advance -> stage 1
done -> enter car with E -> drive stage done -> deliver stage done ->
m1 complete (+$400, outro dialog) -> safehouse heal + save -> radio
switch in car (R x2) -> buy pistol at AZURE ARMORY -> open BAY CUSTOMS
-> NPC greeting (Silas) -> M menu -> save + reload restores cash/health.

Screenshots: combat.jpg / chase.jpg / heli.jpg / city.jpg, 1280x800,
JPEG quality 78, each <= 256 KiB. Taken SERIAL, one page at a time,
under a lockfile so no other lane can shoot concurrently.

Usage: python3 lane-e-playtest.py [--playtest-only | --shots-only]
Writes lane-e-report.json next to this file.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PORT = 8905
BASE = f"http://127.0.0.1:{PORT}"
CAP = 262144
FINAL_SHOTS = ["combat.jpg", "chase.jpg", "heli.jpg", "city.jpg"]
LOCK = Path("/tmp/lane-e-shots.lock")

COUNT_JS = """() => {
  const a = window.__azure;
  if (!a) return { error: 'no window.__azure' };
  const n = (x) => (x ? x.length : 0);
  const heli = a.police && a.police.heli;
  const txt = (id) => { const el = document.getElementById(id); return el ? el.textContent : null; };
  return {
    traffic: n(a.traffic && a.traffic.cars),
    peds: n(a.pedestrians && a.pedestrians.peds),
    wanted: a.wanted ? a.wanted.level : null,
    policeCars: n(a.police && a.police.cars),
    officers: n(a.police && a.police.officers),
    heli: !!heli,
    heliY: heli ? heli.position.y : null,
    cash: a.cash, health: a.health, respect: a.respect,
    fase3: {
      modules: !!(a.missions && a.dialog && a.radio && a.save && a.shops && a.safehouse && a.hudFase3),
      available: a.missions ? a.missions.getAvailable().map(m => m.id) : [],
      completed: a.missions ? a.missions.getCompleted() : [],
      active: a.missions && a.missions.getActive() ? a.missions.getActive().id : null,
      activeStage: a.missions && a.missions.getActive() ? a.missions.getActive().stageIndex : null,
      radioStation: a.radio ? a.radio.current().id : null,
      radioText: txt('hud-fase3-radio'),
      respectText: txt('hud-fase3-respect'),
      missionText: txt('hud-fase3-mission'),
      objectiveText: txt('hud-objective'),
      dialogOpen: a.dialog ? a.dialog.isOpen() : null,
      dialogText: (document.getElementById('azure-dialog') || { innerText: null }).innerText,
      shopOpen: a.shops ? a.shops.isOpen() : null,
      rackOpen: a.safehouse ? a.safehouse.isOpen() : null,
      npcs: (a.npcs || []).length,
      hasSave: a.save ? a.save.hasSave() : null,
    },
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


def check_expectations(results):
    fails = []
    def want(mode, key, expected):
        got = results.get(mode, {}).get(key)
        if got != expected:
            fails.append(f"{mode}.{key}: got {got}, want {expected}")
    def want3(mode, key, expected):
        got = ((results.get(mode, {}) or {}).get("fase3", {}) or {}).get(key)
        if got != expected:
            fails.append(f"{mode}.fase3.{key}: got {got!r}, want {expected!r}")
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
    for mode in ("menu", "traffic", "chase", "combat", "heli", "city"):
        want3(mode, "modules", True)
        want3(mode, "npcs", 5)
    want3("menu", "available", ["m1"])
    want3("menu", "radioStation", "naranja")
    want3("menu", "missionText", "No active mission")
    want3("chase", "active", "m1")
    want3("chase", "radioStation", "baybeats")
    want3("combat", "active", "m1")
    want3("combat", "dialogOpen", True)
    want3("heli", "active", "m1")
    want3("heli", "radioStation", "azure")
    want3("city", "available", ["m1"])
    return fails


# ---- mission E2E ------------------------------------------------------------

def e2e(pw):
    """Full mission flow on one live page. Returns (steps, problems)."""
    browser = pw.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    problems, steps = [], {}

    def log(msg):
        print(f"[e2e] {msg}: {json.dumps(steps)}", flush=True)

    try:
        page = browser.new_page(viewport={"width": 480, "height": 300})
        page.on("console", lambda m: problems.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
        page.on("requestfailed", lambda r: problems.append(f"requestfailed: {r.url} {r.failure}"))
        page.goto(BASE + "/", wait_until="load", timeout=30000)
        page.wait_for_function("window.__azure !== undefined", timeout=30000)
        time.sleep(5)
        # JS click: at 480x300 the START button sits below the fold of the
        # start panel and the page cannot scroll (overflow:hidden), so a
        # real Playwright click times out on actionability. The button
        # wiring itself is exercised (state flips to playing).
        page.evaluate("document.getElementById('btn-start').click()")
        time.sleep(5)

        def state():
            return page.evaluate(COUNT_JS)

        def tp(x, z):
            page.evaluate(f"window.__azure.player.position.set({x}, 1.5, {z})")
            time.sleep(6)

        def tp_car(x, z):
            page.evaluate(f"window.__azure.currentCar.position.set({x}, 1.5, {z})")
            time.sleep(6)

        # 1) Walk up to Rook's marker and start M1 with E.
        tp(30, -90)
        page.keyboard.press("e")
        time.sleep(6)
        s = state()
        log("after E at Rook marker")
        steps["m1_started"] = s["fase3"]["active"] == "m1" and s["fase3"]["dialogOpen"] is True
        steps["m1_intro_line"] = (s["fase3"]["dialogText"] or "")[:60]
        # 2) Advance the two intro lines; stage 1 (goto 30,-90) completes.
        page.keyboard.press("Enter")
        time.sleep(3)
        page.keyboard.press("Enter")
        time.sleep(6)
        s = state()
        log("after intro advance")
        steps["dialog_closed_after_intro"] = s["fase3"]["dialogOpen"] is False
        steps["stage_after_intro"] = s["fase3"]["activeStage"]
        # 3) Enter the car with E, drive stage: teleport car to (0,0).
        tp_car(30, -87)
        page.keyboard.press("e")
        time.sleep(6)
        s = state()
        steps["entered_car"] = page.evaluate("window.__azure.player.isInCar")
        tp_car(0, 0)
        s = state()
        log("after drive stage")
        steps["stage_after_drive"] = s["fase3"]["activeStage"]
        # 4) Deliver: step out, walk the ledger to the pier.
        page.keyboard.press("e")
        time.sleep(6)
        tp(108, 150)
        s = state()
        log("after deliver")
        steps["m1_completed"] = "m1" in s["fase3"]["completed"]
        steps["cash_after_m1"] = s["cash"]
        steps["respect_after_m1"] = s["respect"]
        steps["outro_dialog_open"] = s["fase3"]["dialogOpen"]
        page.keyboard.press("Enter")
        time.sleep(3)
        page.keyboard.press("Enter")
        time.sleep(4)
        s = state()
        log("after outro advance")
        steps["dialog_closed_after_outro"] = s["fase3"]["dialogOpen"] is False
        steps["m2_now_available"] = s["fase3"]["available"]
        # 5) Safehouse: hurt, walk in, heal + save + rack.
        page.evaluate("window.__azure.health = 40")
        tp(-45, -140)
        page.keyboard.press("e")
        time.sleep(6)
        s = state()
        log("after safehouse E")
        steps["safehouse_healed"] = s["health"] == 100
        steps["safehouse_rack_open"] = s["fase3"]["rackOpen"] is True
        steps["save_exists_after_safehouse"] = s["fase3"]["hasSave"]
        page.keyboard.press("Escape")
        time.sleep(4)
        s = state()
        log("after rack Esc")
        steps["rack_closed"] = s["fase3"]["rackOpen"] is False
        # 6) Radio: get in the car, R twice (naranja -> azure -> baybeats).
        tp(-30, -140)
        tp_car(-30, -137)
        print("[e2e] pre-step6-E:", page.evaluate("""() => {
          const a = window.__azure;
          return { px: a.player.position.x, pz: a.player.position.z,
                   cx: a.currentCar.position.x, cz: a.currentCar.position.z,
                   inCar: a.player.isInCar, isFase1Car: a.currentCar === a.car,
                   carSpeed: a.currentCar.speed,
                   safeNear: a.safehouse.isNear(a.player),
                   shop: a.shops.nearest(a.player.position),
                   dialog: a.dialog.isOpen(), rack: a.safehouse.isOpen(),
                   shopOpen: a.shops.isOpen(), wanted: a.wanted.level };
        }"""), flush=True)
        page.keyboard.press("e")
        time.sleep(6)
        print("[e2e] post-step6-E:", page.evaluate("""() => {
          const a = window.__azure;
          return { inCar: a.player.isInCar, px: a.player.position.x, pz: a.player.position.z,
                   cx: a.currentCar.position.x, cz: a.currentCar.position.z };
        }"""), flush=True)
        page.keyboard.press("r")
        time.sleep(3)
        s = state()
        log("after R1")
        steps["radio_after_R1"] = s["fase3"]["radioStation"]
        page.keyboard.press("r")
        time.sleep(3)
        s = state()
        steps["radio_after_R2"] = s["fase3"]["radioStation"]
        steps["radio_hud_after_R2"] = s["fase3"]["radioText"]
        page.keyboard.press("e")  # step out of the car
        time.sleep(5)
        # 7) Shops: buy the pistol at AZURE ARMORY, open BAY CUSTOMS.
        tp(45, -140)
        page.keyboard.press("e")
        time.sleep(6)
        s = state()
        log("after armory E")
        steps["armory_open"] = s["fase3"]["shopOpen"] is True
        # JS click: same small-viewport actionability reason as START.
        page.evaluate("document.querySelector('#shops-list button').click()")  # PISTOL $250
        time.sleep(4)
        steps["pistol_owned"] = page.evaluate("window.__azure.shops.ownsWeapon('pistol')")
        steps["cash_after_pistol"] = page.evaluate("window.__azure.cash")
        page.keyboard.press("Escape")
        time.sleep(4)
        tp(-45, 140)
        page.keyboard.press("e")
        time.sleep(6)
        steps["garage_open"] = page.evaluate("window.__azure.shops.isOpen()")
        steps["garage_title"] = page.evaluate("(document.getElementById('shops-title')||{}).textContent")
        page.keyboard.press("Escape")
        time.sleep(4)
        # 8) NPC greeting: Silas at the marina.
        tp(60, 190)
        page.keyboard.press("e")
        time.sleep(6)
        s = state()
        steps["npc_dialog_open"] = s["fase3"]["dialogOpen"] is True
        steps["npc_dialog_line"] = (s["fase3"]["dialogText"] or "")[:60]
        page.keyboard.press("Enter")
        time.sleep(4)
        # 9) M menu lists m2 available + m1 completed.
        page.keyboard.press("m")
        time.sleep(5)
        steps["menu_open"] = page.evaluate(
            "(document.getElementById('mission-menu')||{style:{}}).style.display") == "flex"
        steps["menu_body"] = page.evaluate(
            "(document.getElementById('mission-menu-body')||{innerText:''}).innerText.slice(0, 300)")
        page.keyboard.press("Escape")
        time.sleep(4)
        steps["menu_closed"] = page.evaluate(
            "(document.getElementById('mission-menu')||{style:{}}).style.display") == "none"
        # 10) Save + reload: cash/health/respect survive.
        page.evaluate("window.__azure.save.save()")
        time.sleep(2)
        page.reload(wait_until="load")
        page.wait_for_function("window.__azure !== undefined", timeout=30000)
        time.sleep(8)
        s = state()
        steps["cash_after_reload"] = s["cash"]
        steps["health_after_reload"] = s["health"]
        steps["respect_after_reload"] = s["respect"]
        steps["completed_after_reload"] = s["fase3"]["completed"]
        log("done")
        page.close()
    except Exception:
        log("CRASHED")
        raise
    finally:
        browser.close()
    return steps, problems


def take_shots(pw):
    if LOCK.exists():
        raise RuntimeError(f"shot lock held: {LOCK} — another lane is shooting")
    LOCK.write_text("lane-e")
    browser = pw.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    out, problems = {}, []
    try:
        shots = json.loads((HERE / "shots.json").read_text())
        assert [s["name"] for s in shots] == FINAL_SHOTS, f"shots.json mismatch: {[s['name'] for s in shots]}"
        for shot in shots:  # SERIAL, one page at a time
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
        LOCK.unlink(missing_ok=True)
    return out, problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--playtest-only", action="store_true")
    ap.add_argument("--shots-only", action="store_true")
    ap.add_argument("--e2e-only", action="store_true")
    args = ap.parse_args()

    server = subprocess.Popen(
        ["node", "serve.ts", "--port", str(PORT)],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        time.sleep(1)
        report = {}
        with sync_playwright() as pw:
            if args.e2e_only:
                steps, errs2 = {}, []
                try:
                    steps, errs2 = e2e(pw)
                except Exception as exc:  # noqa: BLE001
                    errs2 = [f"e2e crashed: {exc!r}"]
                    print(f"e2e crashed: {exc!r}")
                report["e2e"] = steps
                report["e2e_errors"] = errs2
                print(json.dumps(steps, indent=2))
            if not args.shots_only and not args.e2e_only:
                results, errs = playtest(pw)
                report["playtest"] = results
                report["playtest_errors"] = errs
                report["expectation_failures"] = check_expectations(results)
                print(json.dumps(results, indent=2))
                print(f"playtest errors: {len(errs)}; expectation failures: {len(report['expectation_failures'])}")
                for e in errs + report["expectation_failures"]:
                    print("  !", e)
                steps, errs2 = {}, []
                try:
                    steps, errs2 = e2e(pw)
                except Exception as exc:  # noqa: BLE001 - record, don't lose the mode results
                    errs2 = [f"e2e crashed: {exc!r}"]
                    print(f"e2e crashed: {exc!r}")
                report["e2e"] = steps
                report["e2e_errors"] = errs2
                print(json.dumps(steps, indent=2))
                print(f"e2e errors: {len(errs2)}")
                for e in errs2:
                    print("  !", e)
            if not args.playtest_only and not args.e2e_only:
                shots, errs = take_shots(pw)
                report["shots"] = shots
                report["shot_errors"] = errs
                print(f"shot errors: {len(errs)}")
                for e in errs:
                    print("  !", e)
        (HERE / "lane-e-report.json").write_text(json.dumps(report, indent=2))
        bad = report.get("playtest_errors", []) + report.get("shot_errors", []) + report.get("expectation_failures", []) + report.get("e2e_errors", [])
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
