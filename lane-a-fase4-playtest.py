#!/usr/bin/env python3
"""Lane A (Fase 4) E2E playtest — AZURE BAY missions 6-10 + mission resume.

Written fresh in this session (Lane A, 2026-11-20). Serves game/ with
`node serve.ts`, drives headless Chromium (SwiftShader) via Playwright.

Run 1 — M1-M10 LIVE: plays every mission end to end on one live page
through the real engine loop (real E presses, real mouse clicks for the
combat stages, teleports only to move the player/car between stage
targets — the same driver technique Lane E used for M1). Verifies per
mission: intro dialog shown, every stage completes, outro dialog shown,
cash +reward and respect +respect land, next mission unlocks. M10 also
records wanted level + heli presence during the finale combat/drive.
Ammo for the combat stages is bought for real cash at AZURE ARMORY
(PISTOL AMMO x24, $60/pack) — no harness ammo cheat.

Run 2 — RESUME: fresh page, play M1, start M2, finish stage 1, reload:
the mission must come back as M2 at stage 2 (stage index + progress in
localStorage `azure-bay-save-v1`), and reaching the stage-2 target must
advance it. Then a progress-resume check: M3 combat stage with 1/3
kills, reload, kills must still read 1, and 2 more officer kills must
finish the stage. Also probes resume() refusals (bad id, bad stage).

Usage: python3 lane-a-fase4-playtest.py [--e2e-only | --resume-only]
Writes lane-a-fase4-report.json next to this file.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PORT = 8906
BASE = f"http://127.0.0.1:{PORT}"
# Click point for firing: the screen-centre ray is what the hitscan
# uses, but a Playwright click must land ON the game canvas — (240,150)
# is the exact horizontal centre of a 480-wide viewport, which is the
# minimap's left border edge (minimap is right:16px, 220px + 2px border:
# 480-16-224 = 240), so every click hit the minimap and no shot ever
# fired (M3: 120 clicks, 0 kills). (150,120) is clear game canvas.
CLICK_X, CLICK_Y = 150, 120

STATE_JS = """() => {
  const a = window.__azure;
  if (!a) return { error: 'no window.__azure' };
  const act = a.missions ? a.missions.getActive() : null;
  let saveRaw = null;
  try { saveRaw = JSON.parse(localStorage.getItem('azure-bay-save-v1') || 'null'); } catch (e) { saveRaw = { parseError: String(e) }; }
  const officers = (a.police && a.police.officers) || [];
  const aliveOfficers = officers.filter(o => o && o.alive !== false && o.position);
  const px = a.player.position.x, pz = a.player.position.z;
  let nearestOfficer = null;
  for (const o of aliveOfficers) {
    const d = Math.hypot(o.position.x - px, o.position.z - pz);
    if (!nearestOfficer || d < nearestOfficer.d) nearestOfficer = { d: Math.round(d * 10) / 10, x: o.position.x, z: o.position.z, health: o.health };
  }
  return {
    cash: a.cash, health: a.health, respect: a.respect,
    wanted: a.wanted ? a.wanted.level : null, heat: a.wanted ? Math.round(a.wanted.heat * 10) / 10 : null,
    heli: !!(a.police && a.police.heli),
    officersAlive: aliveOfficers.length,
    nearestOfficer,
    active: act ? { id: act.id, stageIndex: act.stageIndex, kills: act.kills, pedKills: act.pedKills, collected: act.collected, stageText: act.stage ? act.stage.text : null, stageType: act.stage ? act.stage.type : null } : null,
    completed: a.missions ? a.missions.getCompleted() : [],
    available: a.missions ? a.missions.getAvailable().map(m => m.id) : [],
    dialogOpen: a.dialog ? a.dialog.isOpen() : null,
    dialogText: (document.getElementById('azure-dialog') || { innerText: null }).innerText,
    inCar: a.player.isInCar,
    px: Math.round(px * 10) / 10, pz: Math.round(pz * 10) / 10,
    mag: a.combat ? a.combat.mag : null, reserve: a.combat ? a.combat.reserve : null,
    weapon: a.combat ? a.combat.weaponName : null,
    hudObjective: (document.getElementById('hud-objective') || { textContent: null }).textContent,
    save: saveRaw ? { cash: saveRaw.cash, active: saveRaw.missions ? saveRaw.missions.active : null, completed: saveRaw.missions ? saveRaw.missions.completed : null } : null,
  };
}"""


class Driver:
    def __init__(self, page):
        self.page = page
        self.problems = []
        self.log_lines = []

    def log(self, msg):
        print(f"[lane-a] {msg}", flush=True)
        self.log_lines.append(msg)

    def state(self):
        return self.page.evaluate(STATE_JS)

    def dismiss_dialogs(self, max_presses=12):
        """Advance open dialog chains with Enter until the box stays
        closed. Frames run ~1s under SwiftShader, so a stage-lines box
        can open a second or two AFTER the stage advances — this waits
        until the dialog has stayed closed for 2 straight seconds
        instead of trusting a single closed read."""
        texts = []
        t0 = time.time()
        closed_since = None
        presses = 0
        while time.time() - t0 < 40:
            s = self.state()
            if s.get("dialogOpen"):
                if s.get("dialogText"):
                    texts.append(s["dialogText"].replace("\n", " | ")[:160])
                if presses >= max_presses:
                    return texts
                self.page.keyboard.press("Enter")
                presses += 1
                time.sleep(1.0)
                closed_since = None
            else:
                if closed_since is None:
                    closed_since = time.time()
                elif time.time() - closed_since >= 2.0:
                    return texts
                time.sleep(0.5)
        return texts

    def wait_in_car(self, want, timeout=15):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.state().get("inCar") == want:
                return True
            time.sleep(0.5)
        return False

    def tp(self, x, z):
        self.page.evaluate(f"window.__azure.player.position.set({x}, 1.5, {z})")
        time.sleep(1.5)

    def tp_car(self, x, z):
        self.page.evaluate(f"window.__azure.currentCar.position.set({x}, 1.5, {z})")
        time.sleep(1.5)

    def wait_advance(self, mid, prev_idx, timeout=30):
        """Wait until the mission completes or its stage index moves."""
        t0 = time.time()
        while time.time() - t0 < timeout:
            s = self.state()
            if mid in (s.get("completed") or []):
                return "completed"
            act = s.get("active")
            if act and act["id"] == mid and act["stageIndex"] != prev_idx:
                return f"stage->{act['stageIndex']}"
            if act and act["id"] != mid:
                return f"wrong-active:{act['id']}"
            # A stage-lines dialog can arrive a frame or two AFTER the
            # advance that opened it; while it is open the modal gate
            # freezes the world (no mission progress), so a collect/goto
            # the driver already teleported onto would never register
            # (M6 stage 1 timed out exactly this way under load).
            # Drain it one box per poll so the world unfreezes.
            if s.get("dialogOpen"):
                self.page.keyboard.press("Enter")
            time.sleep(0.5)
        return "timeout"

    def start_mission(self, mid):
        """Walk to the mission marker, start it with E, clear the intro."""
        s0 = self.state()
        cash0, rep0 = s0["cash"], s0["respect"]
        defn = self.page.evaluate(f"window.__azure.missions.getById('{mid}')")
        assert defn, f"no def for {mid}"
        self.tp(defn["start"]["x"], defn["start"]["z"])
        # Press E until the mission is active (retry every ~5 s): a
        # single press can be consumed while the player is not yet in
        # range or while a dialog is up — the resume run's M1 failed
        # exactly this way ("did not start / no intro dialog") while
        # the same flow worked in the E2E. Once active, wait for the
        # intro dialog WITHOUT pressing E again (a retry press would
        # dismiss the intro before it is read). The first box shown
        # must be the intro (dialog queue fix), not a stage line.
        self.page.keyboard.press("e")
        last_e = time.time()
        t0 = time.time()
        started = False
        while time.time() - t0 < 60:
            s = self.state()
            if s["active"] and s["active"]["id"] == mid:
                started = True
                break
            if time.time() - last_e > 5:
                self.page.keyboard.press("e")
                last_e = time.time()
            time.sleep(0.5)
        assert started, f"{mid} did not start"
        intro = None
        t0 = time.time()
        while time.time() - t0 < 30:
            s = self.state()
            if s.get("dialogOpen") and s.get("dialogText"):
                intro = (s.get("dialogText") or "")[:160]
                break
            time.sleep(0.5)
        assert intro is not None, f"{mid} did not start / no intro dialog"
        self.dismiss_dialogs()
        s = self.state()
        return {
            "intro_first_line": intro,
            "stage_after_intro": s["active"]["stageIndex"] if s["active"] else None,
            "cash_before": cash0, "respect_before": rep0,
            "reward": defn["reward"], "respect_gain": defn["respect"],
            "stages": len(defn["stages"]),
        }

    def combat_stage(self, need_kills, timeout=1500):
        """Fight the active combat stage with real SMG fire.

        The SMG is held down (mouse.down): it is automatic, so every
        frame whose cooldown has cleared fires — 1 shot per 2 frames
        (0.09 s cooldown, dt capped at 0.05 s), 9 hits per officer kill,
        ~26 frames per kill including reload amortisation, versus ~36
        for the pistol (4 hits x 7 frames + the same reload). Frames
        run 3-10 s under SwiftShader + parallel-lane load, so the
        pistol's per-shot click timing would waste most of its wall
        time; holding the trigger does not.

        Officers chase to ~0.5 m, where the screen-centre hitscan ray
        hits regardless of camera yaw (verified by geometry: at <=0.5 m
        past the player the perpendicular error stays under the 0.6 m
        tolerance at any angle). Under SwiftShader the engine's dt cap
        (engine.js: 0.05 s) makes game time run far slower than wall
        time, so an officer needs minutes to walk its 16 m spawn
        distance to the player — the driver closes that distance by
        teleporting next to the officer instead of waiting (same driver
        technique as the stage-target teleports; the shooting itself —
        real held trigger, real hitscan, real kills — is unchanged).
        Health is topped up by the driver so a stray ram/shot cannot
        trigger the death respawn mid-stage (that path is Lane B's,
        tested separately).
        Returns (ok, detail dict).
        """
        self.page.keyboard.press("3")  # SMG
        # Frames run seconds under SwiftShader: wait until the switch
        # lands before shooting.
        t0 = time.time()
        while time.time() - t0 < 25:
            if self.state().get("weapon") == "SMG":
                break
            time.sleep(0.5)
        # WIN CONDITION (fixed 2026-11-20): the stage ADVANCING, not
        # kills reaching need. The engine resets active.kills to 0 the
        # frame the stage advances (verified live: kills 2 -> 0 with the
        # stage-2 lines dialog opening, and noteKill does not count in a
        # non-combat stage), so when need == the stage target the poller
        # can never observe kills == need — the old condition spun until
        # the 1500 s timeout and reported a phantom 0-kill failure (M3,
        # first full E2E). kills >= need is kept as the win for a
        # partial bank (resume test: bank exactly 1 of 3).
        s0 = self.state()
        start_act = s0.get("active") or {}
        start_idx = start_act.get("stageIndex")
        start_id = start_act.get("id")
        if start_idx is None:
            return False, {"reason": "no active mission at combat start"}
        t0 = time.time()
        rounds0 = None
        max_officers_seen = 0
        try:
            self.page.mouse.move(CLICK_X, CLICK_Y)
            self.page.mouse.down()
            while time.time() - t0 < timeout:
                s = self.state()
                act = s.get("active")
                if not act:
                    return False, {"reason": "no active mission"}
                if rounds0 is None:
                    rounds0 = (s["mag"] or 0) + (s["reserve"] or 0)
                left = (s["mag"] or 0) + (s["reserve"] or 0)
                if start_id in (s.get("completed") or []):
                    return True, {"seconds": round(time.time() - t0, 1),
                                  "rounds_used": rounds0 - left,
                                  "max_officers_alive": max_officers_seen,
                                  "via": "mission completed"}
                if act["stageIndex"] != start_idx:
                    return True, {"seconds": round(time.time() - t0, 1),
                                  "rounds_used": rounds0 - left,
                                  "max_officers_alive": max_officers_seen,
                                  "via": f"stage advanced {start_idx}->{act['stageIndex']}"}
                if act["kills"] >= need_kills:
                    return True, {"seconds": round(time.time() - t0, 1),
                                  "rounds_used": rounds0 - left,
                                  "max_officers_alive": max_officers_seen,
                                  "via": "kills reached"}
                max_officers_seen = max(max_officers_seen, s["officersAlive"])
                if s["dialogOpen"]:
                    self.page.mouse.up()
                    self.dismiss_dialogs()
                    self.page.mouse.move(CLICK_X, CLICK_Y)
                    self.page.mouse.down()
                    continue
                if s["health"] is not None and s["health"] < 80:
                    self.page.evaluate("window.__azure.health = 100")
                if s["wanted"] is not None and s["wanted"] < 2:
                    self.page.evaluate("window.__azure.wanted.addHeat(2, 'playtest')")
                if s["mag"] == 0:
                    self.page.mouse.up()
                    self.page.keyboard.press("r")
                    # Reload is 1.2 s of game time = 24 frames; poll
                    # until the mag refills (or the reserve runs dry).
                    rt0 = time.time()
                    while time.time() - rt0 < 400:
                        if (self.state().get("mag") or 0) > 0:
                            break
                        time.sleep(5)
                    self.page.mouse.move(CLICK_X, CLICK_Y)
                    self.page.mouse.down()
                    continue
                no = s.get("nearestOfficer")
                if not no:
                    time.sleep(2)
                    continue
                if no["d"] > 0.7:
                    # Close the distance: teleport onto the officer.
                    # (See the docstring: under SwiftShader the officer
                    # would otherwise take minutes to walk over.)
                    self.page.evaluate(
                        f"window.__azure.player.position.set({no['x']}, 1.5, {no['z']})")
                    time.sleep(2)
                    continue
                time.sleep(2)
            s = self.state()
            return False, {"reason": "timeout",
                           "kills": (s.get("active") or {}).get("kills"),
                           "stageIndex": (s.get("active") or {}).get("stageIndex"),
                           "officersAlive": s["officersAlive"],
                           "max_officers_alive": max_officers_seen}
        finally:
            try:
                self.page.mouse.up()
            except Exception:
                pass  # page/browser already gone: don't mask the real error

    def play_mission(self, mid, extra=None):
        """Play one whole mission live. Returns its report dict."""
        extra = extra or {}
        rep = self.start_mission(mid)
        rep["stage_log"] = []
        for _ in range(6):  # missions have 3-4 stages; 6 is a safe cap
            s = self.state()
            act = s.get("active")
            if not act:
                break
            if act["id"] != mid:
                rep["stage_log"].append(f"ERROR active switched to {act['id']}")
                break
            idx = act["stageIndex"]
            st = act["stageType"]
            stage = self.page.evaluate(
                f"window.__azure.missions.getById('{mid}').stages[{idx}]")
            entry = {"stage": idx, "type": st, "text": act["stageText"]}
            if st in ("goto", "deliver", "collect"):
                # Clear any late-arriving stage-lines dialog first: while
                # it is open the modal gate freezes the world, so the
                # teleport below would never register the stage.
                self.dismiss_dialogs()
                self.tp(stage["x"], stage["z"])
                res = self.wait_advance(mid, idx, timeout=30)
            elif st == "drive":
                s2 = self.state()
                if not s2["inCar"]:
                    # Clear a late-arriving stage-lines dialog first:
                    # while it is open the modal gate drains the E press,
                    # so the car entry never happens (M8 failed exactly
                    # this way twice — the lines dialog arrived after the
                    # previous stage's dismiss and ate the drive E).
                    self.dismiss_dialogs()
                    self.tp_car(s2["px"] + 2, s2["pz"])
                    self.page.keyboard.press("e")
                    entry["entered_car"] = self.wait_in_car(True, timeout=15)
                    if not entry["entered_car"]:
                        # One retry: a dialog may have arrived during the
                        # wait and eaten the E; dismiss it and press E again.
                        self.dismiss_dialogs()
                        self.page.keyboard.press("e")
                        entry["entered_car"] = self.wait_in_car(True, timeout=15)
                    if not entry["entered_car"]:
                        rep["stage_log"].append(entry)
                        rep["failed"] = f"drive stage {idx}: could not enter car"
                        return rep
                if extra.get("m10_drive_probe"):
                    s3 = self.state()
                    entry["wanted_before_drive"] = s3["wanted"]
                    entry["heli_before_drive"] = s3["heli"]
                self.tp_car(stage["x"], stage["z"])
                res = self.wait_advance(mid, idx, timeout=30)
                # The next stage's lines dialog opens on the advance and
                # swallows E while it is up — clear it BEFORE stepping
                # out, or the exit press is eaten and the player stays
                # in the car (and a later on-foot teleport is then
                # overwritten every frame by the car position).
                lines = self.dismiss_dialogs()
                if lines:
                    entry["stage_lines"] = lines
                self.page.keyboard.press("e")  # step out
                entry["exited_car"] = self.wait_in_car(False, timeout=8)
                if not entry["exited_car"]:
                    self.page.keyboard.press("e")
                    entry["exited_car"] = self.wait_in_car(False, timeout=8)
            elif st == "combat":
                need = stage.get("kills") or 3
                if extra.get("m10_combat_probe"):
                    s3 = self.state()
                    entry["wanted_at_combat_start"] = s3["wanted"]
                    entry["heli_at_combat_start"] = s3["heli"]
                ok, detail = self.combat_stage(need)
                entry["combat"] = detail
                if not ok:
                    rep["stage_log"].append(entry)
                    rep["failed"] = f"combat stage {idx} did not finish: {detail}"
                    return rep
                res = self.wait_advance(mid, idx, timeout=10)
                if extra.get("m10_combat_probe"):
                    s3 = self.state()
                    entry["wanted_after_combat"] = s3["wanted"]
                    entry["heli_after_combat"] = s3["heli"]
            else:
                rep["failed"] = f"unknown stage type {st}"
                return rep
            entry["result"] = res
            if res == "timeout":
                rep["stage_log"].append(entry)
                rep["failed"] = f"stage {idx} ({st}) timed out"
                return rep
            # Stage lines dialog (if any) opens on advance — it can
            # arrive a frame or two late, so dismiss_dialogs settles.
            lines = self.dismiss_dialogs()
            if lines:
                entry["stage_lines"] = lines
            rep["stage_log"].append(entry)
            if res == "completed":
                break
        s = self.state()
        rep["completed"] = mid in (s.get("completed") or [])
        rep["cash_after"] = s["cash"]
        rep["respect_after"] = s["respect"]
        rep["cash_delta"] = s["cash"] - rep["cash_before"]
        rep["respect_delta"] = s["respect"] - rep["respect_before"]
        rep["outro_first_line"] = (s.get("dialogText") or "")[:160] if s.get("dialogOpen") else None
        rep["outro_dialog_open"] = s.get("dialogOpen")
        self.dismiss_dialogs()
        return rep

    def buy_smg(self, ammo_packs=4):
        """Buy the SMG ($600) + SMG ammo packs ($90 x60) at AZURE ARMORY
        (45,-140) with real cash. The SMG is the combat weapon: held
        down it fires every other frame, ~26 frames per officer kill
        versus ~36 for the pistol (see combat_stage)."""
        self.tp(45, -140)
        self.page.keyboard.press("e")
        time.sleep(3)

        def shop_click(needle, exclude=None):
            if not self.page.evaluate("window.__azure.shops.isOpen()"):
                self.page.keyboard.press("e")
                time.sleep(3)
            return self.page.evaluate("""(args) => {
              const btns = [...document.querySelectorAll('#shops-list button')];
              const b = btns.find(x => x.textContent.includes(args[0])
                && !(args[1] && x.textContent.includes(args[1])));
              if (!b || b.disabled) return false;
              b.click();
              return true;
            }""", [needle, exclude])

        bought_smg = shop_click("SMG", "AMMO")
        time.sleep(2)
        packs = 0
        for _ in range(ammo_packs):
            if shop_click("SMG AMMO"):
                packs += 1
            time.sleep(2)
        self.page.keyboard.press("Escape")
        time.sleep(3)
        # The combat getters report the CURRENT weapon (fists: Infinity),
        # so switch to the SMG first to read its real mag/reserve.
        self.page.keyboard.press("3")
        t0 = time.time()
        while time.time() - t0 < 25:
            if self.state().get("weapon") == "SMG":
                break
            time.sleep(0.5)
        s2 = self.state()
        return {"smg_bought": bought_smg, "ammo_packs_bought": packs,
                "mag_after": s2["mag"], "reserve_after": s2["reserve"],
                "cash_after": s2["cash"]}


def new_page(pw, problems, init_save=None):
    browser = pw.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    # device_scale_factor 0.5 halves the SwiftShader backing store
    # (layout stays 480x300 CSS px, so click coordinates are unchanged)
    # — measured ~1.5x faster frames under load.
    ctx = browser.new_context(viewport={"width": 480, "height": 300}, device_scale_factor=0.5)
    if init_save:
        # Runs before any page script on navigation, so the game module
        # reads the restored save on its first load. init_save is the
        # checkpoint dict {localStorage key: raw string}.
        ctx.add_init_script(";".join(
            f"localStorage.setItem({json.dumps(k)}, {json.dumps(v)})"
            for k, v in init_save.items() if v is not None))
    page = ctx.new_page()
    page.on("console", lambda m: problems.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
    page.on("requestfailed", lambda r: problems.append(f"requestfailed: {r.url} {r.failure}"))
    page.on("crash", lambda pg: problems.append("page crashed (renderer died)"))
    page.goto(BASE + "/", wait_until="load", timeout=30000)
    page.wait_for_function("window.__azure !== undefined", timeout=30000)
    time.sleep(5)
    page.evaluate("document.getElementById('btn-start').click()")
    time.sleep(8)
    return browser, page



PARTIAL_FILE = HERE / "lane-a-fase4-report-partial.json"


def dump_partial(report):
    """Flush the partial report to a SEPARATE file after each mission,
    so a VM restart or a crash mid-run keeps the completed missions
    (see AGENTS.md: evidence goes to persistent storage continuously).
    The final report merges this file in, so a crash never wipes the
    missions that already finished."""
    try:
        PARTIAL_FILE.write_text(json.dumps({"partial": True, **report}, indent=2))
    except Exception:
        pass


def load_partial():
    try:
        return json.loads(PARTIAL_FILE.read_text())
    except Exception:
        return {}


# Restart-proof E2E: the VM is replaced unannounced every ~1 h, which
# kills a ~40 min E2E run mid-chain (three runs lost this way). After
# every mission the RAW localStorage save is checkpointed to the
# workspace; a relaunch with --resume-e2e restores it via an init
# script (before the game module reads the save) and continues from
# the first incomplete mission. The save persists cash, respect,
# weapons/ammo and the completed list, so the resumed run is the same
# game state, not a fresh one. Checkpoints are only written when no
# mission is active (right after a completion), so a restore never
# lands mid-mission.
SAVE_CHECKPOINT = HERE / "lane-a-e2e-save.json"
# The game keeps TWO localStorage keys: azure-bay-save-v1 (cash,
# weapons, active mission) and azurebay.missions.v1 (the AUTHORITATIVE
# completed list, persisted by missions.js on finish). A checkpoint
# must capture both — restoring only the first brings the cash back
# but leaves completed empty (verified live: cash 900 restored, m1
# not in completed, m2 not available).


def dump_save_checkpoint(page):
    """Persist the live save (both keys); True when written."""
    try:
        data = page.evaluate("""() => {
          const out = {};
          for (const k of ['azure-bay-save-v1', 'azurebay.missions.v1']) {
            out[k] = localStorage.getItem(k);
          }
          return out;
        }""")
        if not data.get("azure-bay-save-v1"):
            return False
        SAVE_CHECKPOINT.write_text(json.dumps(data))
        return True
    except Exception:
        return False


def load_save_checkpoint():
    try:
        return json.loads(SAVE_CHECKPOINT.read_text())
    except Exception:
        return None
def run_e2e(pw, resume=False):
    problems = []
    report = {}
    browser = None
    try:
        init_save = load_save_checkpoint() if resume else None
        browser, page = new_page(pw, problems, init_save=init_save)
        d = Driver(page)
        # Sanity: 10 missions registered, only m1 available (fresh) or
        # the next mission after the checkpoint (resume).
        s = d.state()
        report["boot"] = {
            "available": s["available"], "completed": s["completed"],
            "resumed": bool(init_save),
            "registered_m6_m10": d.page.evaluate(
                "['m6','m7','m8','m9','m10'].map(id => !!window.__azure.missions.getById(id))"),
        }
        done = set(s.get("completed") or [])
        if init_save:
            d.log(f"resumed from checkpoint: completed={sorted(done)} cash={s['cash']}")

        def play(mid, extra=None):
            """Play one mission unless the checkpoint already has it."""
            if mid in done:
                rep = {"completed": True, "skipped": "already in checkpoint"}
                report[mid] = rep
                d.log(f"{mid}: skipped (already completed in checkpoint)")
                return rep
            rep = d.play_mission(mid, extra or {})
            report[mid] = rep
            dump_partial({"e2e": report})
            d.log(f"{mid}: completed={rep.get('completed')} cash+{rep.get('cash_delta')} respect+{rep.get('respect_delta')}")
            if rep.get("completed"):
                done.add(mid)
                dump_save_checkpoint(page)
            return rep

        for mid in ["m1", "m2"]:
            rep = play(mid)
            if rep.get("failed"):
                report["failed_at"] = mid
                return report, problems
        # Stock up on the SMG + ammo before the first combat mission
        # (m3) — unless the checkpoint already has the SMG equipped.
        if d.state().get("weapon") != "SMG":
            report["ammo_buy"] = d.buy_smg(ammo_packs=4)
            dump_partial({"e2e": report})
            dump_save_checkpoint(page)
            d.log(f"ammo: {report['ammo_buy']}")
        else:
            report["ammo_buy"] = {"skipped": "SMG already owned (checkpoint)"}
            d.log("ammo: skipped (SMG already owned)")
        for mid in ["m3", "m4", "m5"]:
            rep = play(mid)
            if rep.get("failed"):
                report["failed_at"] = mid
                return report, problems
        for mid, extra in [("m6", {}), ("m7", {}), ("m8", {}),
                            ("m9", {}), ("m10", {"m10_combat_probe": True, "m10_drive_probe": True})]:
            rep = play(mid, extra)
            if rep.get("failed"):
                report["failed_at"] = mid
                return report, problems
        s = d.state()
        report["final"] = {"completed": s["completed"], "cash": s["cash"],
                           "respect": s["respect"], "available": s["available"]}
        page.close()
    finally:
        if browser:
            browser.close()
    return report, problems


def run_resume(pw):
    problems = []
    report = {}
    browser = None
    try:
        browser, page = new_page(pw, problems)
        d = Driver(page)
        # resume() refusal probes (no mission active yet). Every one
        # must refuse: a probe that wrongly SUCCEEDS activates a mission
        # and blocks the real flow (the locked-m2 probe once activated
        # M2 on a fresh save, so M1 could never start afterwards).
        report["resume_probes"] = d.page.evaluate("""() => ({
          bad_id: window.__azure.missions.resume({ id: 'nope', stageIndex: 0 }),
          bad_stage: window.__azure.missions.resume({ id: 'm2', stageIndex: 99 }),
          locked: window.__azure.missions.resume({ id: 'm2', stageIndex: 0 }),
        })""")
        for name, want in (("bad_id", "not-found"), ("bad_stage", "bad-stage"), ("locked", "locked")):
            got = report["resume_probes"][name]
            assert got.get("ok") is False and got.get("reason") == want, \
                f"resume probe {name} should refuse ({want}): {got}"
        # Play M1 so M2 unlocks, then start M2 and finish stage 1.
        rep1 = d.play_mission("m1")
        report["m1"] = {"completed": rep1.get("completed")}
        if rep1.get("failed"):
            report["failed_at"] = "m1"
            return report, problems
        start = d.start_mission("m2")
        s = d.state()
        report["m2_stage1"] = {
            "stage_after_intro": s["active"]["stageIndex"] if s["active"] else None,
            "save_active": (s.get("save") or {}).get("active"),
        }
        # The stage-1 collect target IS the start spot: the intro close
        # completes it, the auto-save on stage advance writes stage 1.
        assert s["active"] and s["active"]["stageIndex"] == 1, f"m2 not at stage 1: {s['active']}"
        assert (s.get("save") or {}).get("active", {}).get("stage") == 1, "save record has no m2 stage 1"
        assert (s.get("save") or {}).get("active", {}).get("id") == "m2"
        # Reload: the mission must come back at stage 2 (index 1).
        page.reload(wait_until="domcontentloaded", timeout=120000)  # full "load" (assets) exceeds 30 s under lane load; __azure wait below covers readiness
        page.wait_for_function("window.__azure !== undefined", timeout=30000)
        time.sleep(8)
        s = d.state()
        report["after_reload"] = {
            "active": s["active"],
            "hud_objective": s["hudObjective"],
            "save_active": (s.get("save") or {}).get("active"),
            "completed": s["completed"],
        }
        assert s["active"] and s["active"]["id"] == "m2" and s["active"]["stageIndex"] == 1, \
            f"resume failed: {s['active']}"
        assert "west" in (s["active"]["stageText"] or ""), "wrong stage text after resume"
        # Continue playing: reach the stage-2 target, it must advance.
        page.evaluate("document.getElementById('btn-start').click()")
        time.sleep(5)
        d.dismiss_dialogs()
        d.tp(-60, 140)
        res = d.wait_advance("m2", 1, timeout=30)
        s = d.state()
        report["m2_continued"] = {
            "wait_result": res,
            "stage_after_target": s["active"]["stageIndex"] if s["active"] else None,
        }
        assert res == "stage->2", f"resumed m2 did not advance: {res}"
        # Progress resume: finish M2, start M3, bank 1/3 combat kills.
        for _ in range(4):
            s = d.state()
            act = s.get("active")
            if not act:
                break
            idx = act["stageIndex"]
            stage = d.page.evaluate(f"window.__azure.missions.getById('m2').stages[{idx}]")
            d.tp(stage["x"], stage["z"])
            d.wait_advance("m2", idx, timeout=30)
            time.sleep(1)
            d.dismiss_dialogs()
        s = d.state()
        assert "m2" in s["completed"], f"m2 did not complete: {s}"
        d.start_mission("m3")
        d.tp(0, -60)  # stage 1 goto -> combat stage (index 1)
        res = d.wait_advance("m3", 0, timeout=30)
        assert res == "stage->1", f"m3 did not reach combat stage: {res}"
        d.dismiss_dialogs()
        # Bank exactly 1 officer kill, then reload mid-stage.
        ok, detail = d.combat_stage(1, timeout=180)
        assert ok, f"could not bank 1 kill in m3: {detail}"
        s = d.state()
        report["m3_partial"] = {"kills_before_reload": s["active"]["kills"],
                                "save_active": (s.get("save") or {}).get("active")}
        assert s["active"]["kills"] == 1, f"kills not 1: {s['active']}"
        page.reload(wait_until="domcontentloaded", timeout=120000)  # full "load" (assets) exceeds 30 s under lane load; __azure wait below covers readiness
        page.wait_for_function("window.__azure !== undefined", timeout=30000)
        time.sleep(8)
        s = d.state()
        report["m3_after_reload"] = {"active": s["active"],
                                     "save_active": (s.get("save") or {}).get("active")}
        assert s["active"] and s["active"]["id"] == "m3" and s["active"]["stageIndex"] == 1, \
            f"m3 resume failed: {s['active']}"
        assert s["active"]["kills"] == 1, f"kills did not survive reload: {s['active']}"
        page.evaluate("document.getElementById('btn-start').click()")
        time.sleep(5)
        d.dismiss_dialogs()
        ok, detail = d.combat_stage(3, timeout=300)
        assert ok, f"resumed m3 combat did not finish: {detail}"
        res = d.wait_advance("m3", 1, timeout=10)
        report["m3_finished_after_resume"] = {"wait_result": res, "combat": detail}
        assert res == "stage->2", f"m3 did not advance after resumed kills: {res}"
        page.close()
    finally:
        if browser:
            browser.close()
    return report, problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--e2e-only", action="store_true")
    ap.add_argument("--resume-only", action="store_true")
    ap.add_argument("--resume-e2e", action="store_true",
                    help="resume the E2E from the workspace save checkpoint")
    args = ap.parse_args()

    server = subprocess.Popen(
        ["node", "serve.ts", "--port", str(PORT)],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        time.sleep(1)
        report = {}
        with sync_playwright() as pw:
            if not args.resume_only:
                if not args.resume_e2e:
                    try:
                        SAVE_CHECKPOINT.unlink()
                    except Exception:
                        pass
                try:
                    steps, errs = run_e2e(pw, resume=args.resume_e2e)
                except Exception as exc:  # noqa: BLE001
                    steps = {"crashed": repr(exc), **load_partial().get("e2e", {})}
                    errs = [f"e2e crashed: {exc!r}"]
                    print(f"e2e crashed: {exc!r}")
                report["e2e"] = steps
                report["e2e_errors"] = errs
                print(json.dumps(steps, indent=2))
            if not args.e2e_only:
                try:
                    steps, errs = run_resume(pw)
                except Exception as exc:  # noqa: BLE001
                    steps = {"crashed": repr(exc), **load_partial().get("resume", {})}
                    errs = [f"resume crashed: {exc!r}"]
                    print(f"resume crashed: {exc!r}")
                report["resume"] = steps
                report["resume_errors"] = errs
                print(json.dumps(steps, indent=2))
        (HERE / "lane-a-fase4-report.json").write_text(json.dumps(report, indent=2))
        bad = report.get("e2e_errors", []) + report.get("resume_errors", [])
        bad += [f"e2e failed at {report['e2e'].get('failed_at')}" for _ in [0]
                if isinstance(report.get("e2e"), dict) and report["e2e"].get("failed_at")]
        bad += [f"resume failed at {report['resume'].get('failed_at')}" for _ in [0]
                if isinstance(report.get("resume"), dict) and report["resume"].get("failed_at")]
        bad += ["e2e crashed" for _ in [0]
                if isinstance(report.get("e2e"), dict) and report["e2e"].get("crashed")]
        bad += ["resume crashed" for _ in [0]
                if isinstance(report.get("resume"), dict) and report["resume"].get("crashed")]
        print(f"errors: {len(bad)}")
        for e in bad:
            print("  !", e)
        return 1 if bad else 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    sys.exit(main())
