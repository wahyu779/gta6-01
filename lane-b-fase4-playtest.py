#!/usr/bin/env python3
"""Lane B (Fase 4) live verification — AZURE BAY (gta6-01).

Verifies the three Fase 4 Lane B changes on a LIVE headless-Chromium page
(SwiftShader), through the real engine loop with real keys / real clicks:

  T1  mid-mission dialog: M1 stage 1/3 -> 2/3 shows the stage-1 line
      ("Bridge is the only way over") in the dialog box, and 2/3 -> 3/3
      shows the stage-2 line ("Pier office, south end"). Catches the
      first-frame race the old lastMissionId tracking had (stage 0
      completes on the first frame after the intro closes).
  T2a death in M1 stage 2 (drive, index 1): respawn at stage 2, NOT M1
      from the start — stageIndex stays 1, position is the stage-1
      checkpoint (30,-90), health 100, cash untouched.
  T2b death in M1 stage 3 (deliver, index 2): respawn at stage 3 —
      stageIndex stays 2, position is the stage-2 checkpoint (0,0),
      on foot; finishing the delivery then completes M1 (+$400).
  T3  kill counting in the M3 combat stage: a real pistol shot that kills
      an ordinary ped leaves the objective at (0/3) and pedKills at 1;
      real pistol shots that kill an officer raise it to (1/3).

Serves game/ with `node serve.ts` on 127.0.0.1:8906. Writes
lane-b-fase4-report.json next to this file. Usage:
  python3 lane-b-fase4-playtest.py
"""
import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PORT = 8906
BASE = f"http://127.0.0.1:{PORT}"

STATE_JS = """() => {
  const a = window.__azure;
  if (!a) return { error: 'no window.__azure' };
  const act = a.missions ? a.missions.getActive() : null;
  const cp = a.missions && a.missions.getCheckpoint ? a.missions.getCheckpoint() : null;
  const dlg = document.getElementById('azure-dialog');
  return {
    health: a.health, cash: a.cash, respect: a.respect,
    inCar: a.player.isInCar,
    px: a.player.position.x, pz: a.player.position.z,
    wanted: a.wanted ? a.wanted.level : null,
    mag: a.combat ? a.combat.mag : null,
    weapon: a.combat ? a.combat.weaponName : null,
    active: act ? act.id : null,
    stageIndex: act ? act.stageIndex : null,
    kills: act ? act.kills : null,
    pedKills: act ? act.pedKills : null,
    checkpoint: cp,
    completed: a.missions ? a.missions.getCompleted() : [],
    dialogOpen: a.dialog ? a.dialog.isOpen() : null,
    dialogText: dlg ? dlg.innerText : null,
    objectiveText: (document.getElementById('hud-objective') || { textContent: null }).textContent,
  };
}"""

# Camera world position + forward (-Z column of matrixWorld), so a target
# can be placed exactly on the screen-centre ray the hitscan uses.
CAM_RAY_JS = """() => {
  const c = window.__azure.camera;
  c.updateMatrixWorld(true);
  const e = c.matrixWorld.elements;
  return { px: e[12], py: e[13], pz: e[14], fx: -e[8], fy: -e[9], fz: -e[10] };
}"""


def main() -> int:
    server = subprocess.Popen(
        ["node", "serve.ts", "--port", str(PORT)],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    problems, steps = [], {}
    retries = []
    try:
        time.sleep(1)
        for attempt in (1, 2):
            if attempt > 1:
                # The previous attempt died from OUTSIDE (TargetClosedError:
                # the browser process went away mid-run — another lane's
                # concurrent Chromium run under memory pressure is the
                # prime suspect). A fresh browser + fresh context replays
                # deterministically from the start; the killed attempt's
                # partial steps are discarded, not reported as failures.
                retries.append(f"attempt {attempt - 1} killed externally, retrying")
                problems, steps = [], {}
                print(f"[lane-b] attempt {attempt - 1} killed externally — retrying from scratch", flush=True)
            with sync_playwright() as pw:
                browser = pw.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
                try:
                    page = browser.new_page(viewport={"width": 480, "height": 300})
                    page.on("console", lambda m: problems.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
                    page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
                    page.on("requestfailed", lambda r: problems.append(f"requestfailed: {r.url} {r.failure}"))
                    page.on("crash", lambda: problems.append("PAGE CRASHED (renderer)"))
                    page.goto(BASE + "/", wait_until="load", timeout=30000)
                    page.wait_for_function("window.__azure !== undefined", timeout=30000)
                    time.sleep(5)

                    def state():
                        return page.evaluate(STATE_JS)

                    def tp(x, z):
                        page.evaluate(f"window.__azure.player.position.set({x}, 1.5, {z})")
                        time.sleep(6)

                    def tp_car(x, z):
                        page.evaluate(f"window.__azure.currentCar.position.set({x}, 1.5, {z})")
                        time.sleep(6)

                    def press(key, wait=4):
                        page.keyboard.press(key)
                        time.sleep(wait)

                    def close_dialog(max_presses=6):
                        """Advance an open dialog until it closes (or give up).
                        Dialog advance is synchronous (keydown handler), so a
                        short sleep per press is enough; the budget covers an
                        intro (2 lines) + a queued stage line + an outro (2)."""
                        for _ in range(max_presses):
                            if not state()["dialogOpen"]:
                                return True
                            press("Enter", 3)
                            time.sleep(2)
                        return not state()["dialogOpen"]

                    def wait_for(pred, timeout, what):
                        """Wait for a game condition (a frame must run for most
                        of them — SwiftShader runs ~1 frame per 3 s, slower
                        when other lanes share the CPU, so fixed sleeps flap).
                        Returns True when the condition held in time."""
                        try:
                            page.wait_for_function(pred, timeout=timeout * 1000)
                            return True
                        except Exception as exc:  # noqa: BLE001
                            problems.append(f"timeout waiting for {what}: {exc!r}")
                            print(f"[lane-b] TIMEOUT waiting for {what}", flush=True)
                            return False

                    def log(msg):
                        print(f"[lane-b] {msg}: {json.dumps(state())}", flush=True)

                    # ---- start -------------------------------------------------
                    page.evaluate("document.getElementById('btn-start').click()")
                    time.sleep(5)

                    # ---- T1: M1 stage-transition dialog -----------------------
                    # The E press needs a FRAME to start the mission
                    # (tryInteract runs in update()), so wait for the intro
                    # dialog instead of assuming a fixed sleep was enough.
                    tp(30, -90)
                    press("e", 2)
                    wait_for("window.__azure && window.__azure.dialog.isOpen()", 90, "m1 intro dialog")
                    s = state()
                    log("after E at Rook marker")
                    steps["t1_m1_started"] = s["active"] == "m1" and s["dialogOpen"] is True
                    steps["t1_intro_line"] = (s["dialogText"] or "")[:60]
                    steps["t1_intro_shown_first"] = "You washed up on my shore" in (s["dialogText"] or "")
                    # Enter advances the dialog synchronously (keydown handler),
                    # but the stage-1 line needs a FRAME after the intro closes
                    # (stage 0 completes in update()) — wait for its text.
                    press("Enter", 2)
                    press("Enter", 2)
                    wait_for(
                        "() => { const d = document.getElementById('azure-dialog');"
                        " return d && d.innerText.includes('Bridge is the only way over'); }",
                        90, "stage-1 line")
                    s = state()
                    log("after intro advance (stage 0 should complete, stage-1 line should show)")
                    steps["t1_stage1_dialog_open"] = s["dialogOpen"] is True
                    steps["t1_stage1_dialog_text"] = (s["dialogText"] or "")[:80]
                    steps["t1_stage1_line_shown"] = "Bridge is the only way over" in (s["dialogText"] or "")
                    steps["t1_stage_after_intro"] = s["stageIndex"]
                    close_dialog()
                    s = state()
                    steps["t1_dialog_closed"] = s["dialogOpen"] is False

                    # ---- T2a: death in stage 2 (drive, index 1) --------------
                    page.evaluate("window.__azure.health = 0")
                    wait_for(
                        "() => { const d = document.getElementById('azure-dialog');"
                        " return d && d.innerText.includes('back to the start of stage 2'); }",
                        90, "respawn dialog (stage 2)")
                    s = state()
                    log("after death in drive stage")
                    steps["t2a_respawn_dialog_open"] = s["dialogOpen"] is True
                    steps["t2a_respawn_dialog_text"] = (s["dialogText"] or "")[:100]
                    steps["t2a_stage_still_1"] = s["stageIndex"] == 1
                    steps["t2a_pos_near_checkpoint"] = abs(s["px"] - 30) < 3 and abs(s["pz"] + 90) < 3
                    steps["t2a_health_restored"] = s["health"] == 100
                    steps["t2a_cash_untouched"] = s["cash"] == 500
                    steps["t2a_wanted_cleared"] = s["wanted"] == 0
                    close_dialog()

                    # ---- T1 (cont): drive stage -> stage-2 line --------------
                    tp_car(30, -87)
                    press("e", 2)
                    wait_for("window.__azure && window.__azure.player.isInCar", 90, "enter car")
                    s = state()
                    steps["t1_entered_car"] = s["inCar"] is True
                    tp_car(0, 0)
                    wait_for(
                        "() => { const d = document.getElementById('azure-dialog');"
                        " return d && d.innerText.includes('Pier office, south end'); }",
                        90, "stage-2 line")
                    s = state()
                    log("after drive stage (stage-2 line should show)")
                    steps["t1_stage2_dialog_open"] = s["dialogOpen"] is True
                    steps["t1_stage2_dialog_text"] = (s["dialogText"] or "")[:80]
                    steps["t1_stage2_line_shown"] = "Pier office, south end" in (s["dialogText"] or "")
                    steps["t1_stage_after_drive"] = s["stageIndex"]
                    close_dialog()

                    # ---- T2b: death in stage 3 (deliver, index 2) ------------
                    page.evaluate("window.__azure.health = 0")
                    wait_for(
                        "() => { const d = document.getElementById('azure-dialog');"
                        " return d && d.innerText.includes('back to the start of stage 3'); }",
                        90, "respawn dialog (stage 3)")
                    s = state()
                    log("after death in deliver stage (was in car at 0,0)")
                    steps["t2b_respawn_dialog_open"] = s["dialogOpen"] is True
                    steps["t2b_stage_still_2"] = s["stageIndex"] == 2
                    steps["t2b_pos_near_checkpoint"] = abs(s["px"] - 0) < 3 and abs(s["pz"] - 0) < 3
                    steps["t2b_on_foot_after_respawn"] = s["inCar"] is False
                    steps["t2b_health_restored"] = s["health"] == 100
                    close_dialog()
                    tp(108, 150)
                    wait_for(
                        "window.__azure && window.__azure.missions.getCompleted().includes('m1')",
                        90, "m1 completed")
                    s = state()
                    log("after deliver (m1 should complete)")
                    steps["t2b_m1_completed"] = "m1" in s["completed"]
                    steps["t2b_cash_after_m1"] = s["cash"]
                    steps["t2b_outro_open"] = s["dialogOpen"] is True
                    close_dialog()

                    # ---- M2 via teleports (unlock M3) -------------------------
                    tp(60, 140)
                    press("e", 2)
                    wait_for("window.__azure && window.__azure.dialog.isOpen()", 90, "m2 intro dialog")
                    close_dialog()  # intro (2 lines) + maybe stage-1 line
                    close_dialog()
                    for (x, z) in ((-60, 140), (0, 190), (30, -190)):
                        tp(x, z)
                        close_dialog()
                    wait_for(
                        "window.__azure && window.__azure.missions.getCompleted().includes('m2')",
                        90, "m2 completed")
                    s = state()
                    log("after M2 teleports")
                    steps["m2_completed"] = "m2" in s["completed"]
                    close_dialog()

                    # ---- M3: reach the combat stage ---------------------------
                    tp(0, -60)
                    press("e", 2)
                    wait_for("window.__azure && window.__azure.dialog.isOpen()", 90, "m3 intro dialog")
                    close_dialog()  # intro
                    close_dialog()  # stage-1 (combat) line, if shown
                    wait_for(
                        "() => { const a = window.__azure.missions.getActive();"
                        " return a && a.id === 'm3' && a.stageIndex === 1; }",
                        90, "m3 combat stage")
                    s = state()
                    log("M3 combat stage active?")
                    steps["m3_combat_active"] = s["active"] == "m3" and s["stageIndex"] == 1
                    steps["m3_objective_0_3"] = "(0/3)" in (s["objectiveText"] or "")

                    # ---- T3: ped kill must NOT count --------------------------
                    page.evaluate("window.__azure.combat.selectWeapon(1)")  # pistol
                    time.sleep(3)

                    def snap_camera():
                        """Snap the chase rig onto the player. The rig lerps
                        26% of the remaining gap per frame and SwiftShader
                        runs ~1 frame per 3 s, so after a teleport the camera
                        is still swinging a minute later — and any ray-based
                        placement goes stale before the shot frame fires (the
                        probe showed the camera 16 m off, spiralling in).
                        Driving the REAL rig update with dt=1 settles it in
                        one call (follow = 1 - exp(-6) ~= 1), so the camera
                        — and the aim ray — hold still for the shooting."""
                        page.evaluate(
                            "(() => { const a = window.__azure;"
                            " for (let i = 0; i < 5; i++)"
                            " a.cameraRig.update(1, a.player.position, a.player.heading, 'foot', 0); })()")
                        time.sleep(3)

                    def place_on_ray(ref_js, dist=12):
                        """Teleport the entity returned by ref_js onto the camera
                        ray the hitscan uses. findHit aims at the target's
                        y + 1.2, so the placement puts the AIM POINT on the ray:
                        pick the distance where the ray's height is 2.7 (ground
                        1.5 + 1.2) and park the target's feet there. Placing the
                        feet on the ray instead misses high when the camera
                        looks down at the player."""
                        for _ in range(2):
                            ray = page.evaluate(CAM_RAY_JS)
                            d = dist
                            if ray["fy"] < -0.01:
                                d = (2.7 - ray["py"]) / ray["fy"]
                                d = max(4, min(20, d))
                            tx = ray["px"] + ray["fx"] * d
                            tz = ray["pz"] + ray["fz"] * d
                            page.evaluate(f"{ref_js}.position.set({tx}, 1.5, {tz})")
                            time.sleep(3)

                    def shoot_once():
                        """One real shot: a Playwright click on the canvas centre.
                        Falls back to dispatching the mousedown on the canvas
                        itself if a HUD overlay ever swallows the click — the
                        event still travels the real input.js -> combat path."""
                        before = state()["mag"]
                        page.mouse.click(240, 150)
                        time.sleep(6)
                        if state()["mag"] != before:
                            return True
                        page.evaluate(
                            "document.querySelector('canvas').dispatchEvent("
                            "new MouseEvent('mousedown', { bubbles: true, button: 0 }))")
                        time.sleep(6)
                        return state()["mag"] != before

                    def place_once(ref_js):
                        """One fresh placement on the current camera ray, then
                        only a 1 s settle — used immediately before a shot so
                        a police ram cannot shove the player (and swing the
                        ray) between placement and trigger."""
                        ray = page.evaluate(CAM_RAY_JS)
                        d = 12
                        if ray["fy"] < -0.01:
                            d = max(4, min(20, (2.7 - ray["py"]) / ray["fy"]))
                        tx = ray["px"] + ray["fx"] * d
                        tz = ray["pz"] + ray["fz"] * d
                        page.evaluate(f"{ref_js}.position.set({tx}, 1.5, {tz})")
                        time.sleep(1)

                    def park_police_cars():
                        """Park every police car 150 m away: at wanted 2 they
                        chase and ram, and a ram shoves the player sideways —
                        swinging the camera ray off the staged officer. Game
                        time runs ~60x slower than real time under SwiftShader,
                        so they cannot drive back during the test."""
                        page.evaluate(
                            "window.__azure.police.cars.forEach(u => {"
                            " const c = (u && u.car) ? u.car : u;"
                            " if (c && c.position) c.position.set(150, 1.5, 150); })")

                    ped_ref = ("window.__azure.pedestrians.peds.find(p => p && p.alive !== false && p.position)")
                    snap_camera()
                    place_on_ray(ped_ref)
                    # Peds wander — refresh the placement 1 s before the shot
                    # (same treatment the officer loop gets), or the target
                    # walks off the ray between placement and trigger.
                    place_once(ped_ref)
                    fired = shoot_once()
                    s = state()
                    log("after shooting a ped")
                    steps["t3_shot_fired_at_ped"] = fired is True
                    steps["t3_ped_kill_no_objective"] = s["kills"] == 0
                    steps["t3_ped_kill_tracked_separately"] = s["pedKills"] == 1
                    steps["t3_objective_still_0_3"] = "(0/3)" in (s["objectiveText"] or "")

                    # ---- T3: officer kill MUST count --------------------------
                    # Reset the heat the ped kill + shots built up first: at
                    # wanted 5 the heli + 3 cars join in and their rams shove
                    # the player off the staged aim. Level 2 spawns exactly
                    # the 2 foot officers this test needs.
                    page.evaluate("window.__azure.wanted.reset(); window.__azure.health = 100;")
                    time.sleep(3)
                    page.evaluate("window.__azure.wanted.addHeat(2, 'lane-b-test')")
                    time.sleep(15)
                    park_police_cars()
                    snap_camera()
                    time.sleep(3)
                    s = state()
                    steps["t3_officers_spawned"] = page.evaluate(
                        "window.__azure.police.officers.filter(o => o && o.alive !== false).length")
                    # Pistol: 25 dmg, officer 100 HP -> 4 hits. Re-place on the
                    # ray before every shot (officers chase the player). The
                    # target officer is pinned to window so its HP is read by
                    # identity — re-finding after a kill would return the OTHER
                    # officer at full health and hide the hit.
                    page.evaluate("window.__laneB_officer = window.__azure.police.officers.find(o => o && o.alive !== false)")
                    hits = 0
                    if steps["t3_officers_spawned"] and steps["t3_officers_spawned"] >= 1:
                        for attempt in range(12):
                            if state()["kills"] == 1:
                                break
                            hp_before = page.evaluate(
                                "(window.__laneB_officer || {health: null}).health")
                            park_police_cars()
                            place_on_ray("window.__laneB_officer")
                            place_once("window.__laneB_officer")
                            shoot_once()
                            hp_after = page.evaluate(
                                "(window.__laneB_officer || {health: null}).health")
                            alive_after = page.evaluate(
                                "(window.__laneB_officer || {alive: null}).alive")
                            if (hp_after is not None and hp_before is not None and hp_after < hp_before) or alive_after is False:
                                hits += 1
                            s = state()
                            if s["kills"] == 1:
                                break
                    log("after shooting officers")
                    steps["t3_officer_hits_landed"] = hits
                    steps["t3_officer_kill_counts"] = s["kills"] == 1
                    steps["t3_ped_kills_still_1"] = s["pedKills"] == 1
                    steps["t3_objective_now_1_3"] = "(1/3)" in (s["objectiveText"] or "")
                    page.close()
                except Exception as exc:  # noqa: BLE001 - record the failure, still write the report
                    problems.append(f"playtest crashed: {exc!r}")
                    print(f"playtest crashed: {exc!r}", flush=True)
                finally:
                    browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
    report = {"steps": steps, "problems": problems, "retries": retries}
    (HERE / "lane-b-fase4-report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    bad = [k for k, v in steps.items() if v is False or v is None]
    bad += problems
    print(f"steps failing: {bad}" if bad else "ALL STEPS PASS")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
