#!/usr/bin/env python3
"""Lane E (Fase 4) integration playtest + E2E M1-M10 + final 4 shots (AZURE BAY).

Written fresh in this session (Lane E, 2026-11-20). Serves game/ with
`node serve.ts`, drives headless Chromium (SwiftShader) via Playwright.

What it proves:
  playtest: all 6 modes (menu/traffic/chase/combat/heli/city) with 0 console
    errors, 0 pageerrors, 0 failed requests; Fase 2 counts (traffic 8,
    peds 12, wanted 3/2/5); Fase 4 wiring: all 10 missions registered,
    every stage of M1-M10 carries dialog `lines`, Missions.resume /
    getCheckpoint / respawnToCheckpoint exist, radio has 3 stations +
    debugAudio probe, dialog queue exists.
  e2e: M1-M10 played IN ORDER on one live page through the real engine:
    teleport the player/car to stage targets, press the real E/Enter/R/2
    keys, fire REAL pistol shots (mouse click -> input.js -> combat.js
    hitscan -> missions.noteKill with isTarget) at officers placed on the
    camera ray. Rewards + respect are checked after every mission.
    Ammo is restocked between combat stages through combat.addAmmo, the
    game's own restock API (same as buying ammo) — the kills themselves
    are never faked: every counted kill is a real hitscan kill.
  resume: mid-mission save + reload -> the same mission resumes at the
    same stage, and still completes.
  checkpoint: death mid-mission -> respawn at the current stage's start,
    stage index unchanged, health 100, mission still completable.
  radio: after real key gestures, Radio.debugAudio() shows a running
    context with steps scheduled (and the RMS actually flowing).
  shots: combat/chase/heli/city, 1280x800, JPEG q78, each <= 256 KiB,
    taken SERIAL under a lockfile. Each shot is eyeballed by the lane
    before commit (see the text report).

Usage: python3 lane-e-fase4-playtest.py [--playtest-only | --e2e-only |
  --resume-only | --checkpoint-only | --shots-only]
Writes lane-e-fase4-report.json next to this file.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PORT = 8916  # 8906 is Lane A's server; avoid cross-talk
BASE = f"http://127.0.0.1:{PORT}"
CAP = 262144
FINAL_SHOTS = ["combat.jpg", "chase.jpg", "heli.jpg", "city.jpg"]
LOCK = Path("/tmp/lane-e-fase4-shots.lock")

# Mission rewards from the defs (M1-M5 missions.js, M6-M10 story.js).
EXPECTED = {
    "m1": (400, 10), "m2": (650, 15), "m3": (900, 20), "m4": (1200, 25),
    "m5": (2000, 40), "m6": (400, 15), "m7": (650, 25), "m8": (900, 35),
    "m9": (1200, 40), "m10": (2500, 60),
}

COUNT_JS = """() => {
  const a = window.__azure;
  if (!a) return { error: 'no window.__azure' };
  const n = (x) => (x ? x.length : 0);
  const heli = a.police && a.police.heli;
  const txt = (id) => { const el = document.getElementById(id); return el ? el.textContent : null; };
  const act = a.missions ? a.missions.getActive() : null;
  return {
    traffic: n(a.traffic && a.traffic.cars),
    peds: n(a.pedestrians && a.pedestrians.peds),
    wanted: a.wanted ? a.wanted.level : null,
    policeCars: n(a.police && a.police.cars),
    officers: n(a.police && a.police.officers),
    heli: !!heli,
    heliY: heli ? heli.position.y : null,
    cash: a.cash, health: a.health, respect: a.respect,
    mag: a.combat ? a.combat.mag : null,
    reserve: a.combat ? a.combat.reserve : null,
    weapon: a.combat ? a.combat.weaponName : null,
    kills: act ? act.kills : null,
    pedKills: act ? act.pedKills : null,
    inCar: a.player ? !!a.player.isInCar : null,
    fase4: {
      modules: !!(a.missions && a.dialog && a.radio && a.save && a.shops && a.safehouse && a.hudFase3),
      registered: ['m1','m2','m3','m4','m5','m6','m7','m8','m9','m10'].map(
        (id) => !!a.missions.getById(id)),
      stageLines: ['m1','m2','m3','m4','m5','m6','m7','m8','m9','m10'].map((id) => {
        const d = a.missions.getById(id);
        if (!d) return false;
        return d.stages.every((s) => Array.isArray(s.lines) && s.lines.length > 0);
      }),
      hasResume: typeof a.missions.resume === 'function',
      hasCheckpoint: typeof a.missions.getCheckpoint === 'function',
      hasRespawn: typeof a.missions.respawnToCheckpoint === 'function',
      hasShowQueue: typeof a.dialog.showQueue === 'function',
      hasDebugAudio: typeof a.radio.debugAudio === 'function',
      stations: a.radio && a.radio.stations ? a.radio.stations.map((s) => s.id) : null,
      available: a.missions ? a.missions.getAvailable().map((m) => m.id) : [],
      completed: a.missions ? a.missions.getCompleted() : [],
      active: act ? act.id : null,
      activeStage: act ? act.stageIndex : null,
      stagesTotal: act ? act.stagesTotal : null,
      radioStation: a.radio ? a.radio.current().id : null,
      radioText: txt('hud-fase3-radio'),
      respectText: txt('hud-fase3-respect'),
      missionText: txt('hud-fase3-mission'),
      objectiveText: txt('hud-objective'),
      dialogOpen: a.dialog ? a.dialog.isOpen() : null,
      dialogText: (document.getElementById('azure-dialog') || { innerText: null }).innerText,
      npcs: (a.npcs || []).length,
      hasSave: a.save ? a.save.hasSave() : null,
    },
  };
}"""

CAM_RAY_JS = """() => {
  const c = window.__azure.camera;
  c.updateMatrixWorld(true);
  const e = c.matrixWorld.elements;
  return { px: e[12], py: e[13], pz: e[14], fx: -e[8], fy: -e[9], fz: -e[10] };
}"""


def load_page(page, url, wait_ready):
    problems = []
    page.on("console", lambda m: problems.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
    page.on("requestfailed", lambda r: problems.append(f"requestfailed: {r.url} {r.failure}"))
    page.goto(url, wait_until="load", timeout=30000)
    if wait_ready:
        # 600 s: under SwiftShader a frame can take ~2.5 s when other
        # lanes run browsers in parallel, so 90 frames need minutes.
        page.wait_for_function("window.__shotReady === true", timeout=600000)
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

    def want4(mode, key, expected):
        got = ((results.get(mode, {}) or {}).get("fase4", {}) or {}).get(key)
        if got != expected:
            fails.append(f"{mode}.fase4.{key}: got {got!r}, want {expected!r}")

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
        want4(mode, "modules", True)
        want4(mode, "registered", [True] * 10)
        want4(mode, "hasResume", True)
        want4(mode, "hasCheckpoint", True)
        want4(mode, "hasRespawn", True)
        want4(mode, "hasShowQueue", True)
        want4(mode, "hasDebugAudio", True)
        want4(mode, "npcs", 5)
    # Every stage of every mission carries at least one dialog line.
    # (M7 stage 2 'collect' and M8/M9 final stages shipped WITHOUT lines
    # in Fase 3 story.js — Lane A fase4 was scoped to M1-M5 + engine, so
    # a False here is a known Fase 4 gap, reported not hidden.)
    want4("menu", "stageLines", [True] * 10)
    want4("menu", "available", ["m1"])
    want4("menu", "radioStation", "naranja")
    want4("menu", "missionText", "No active mission")
    want4("chase", "active", "m1")
    want4("chase", "radioStation", "baybeats")
    want4("combat", "active", "m1")
    want4("combat", "dialogOpen", True)
    want4("heli", "active", "m1")
    want4("heli", "radioStation", "azure")
    want4("city", "available", ["m1"])
    return fails


# ---- shared E2E driver ---------------------------------------------------------

class Driver:
    """One live page + the real keys. Teleports only move the player/car
    (the same technique the Fase 3 E2E used); every stage transition,
    kill, reward and dialog runs through the real engine loop."""

    def __init__(self, page):
        self.page = page
        self.problems = []

    def state(self):
        return self.page.evaluate(COUNT_JS)

    def log(self, msg, extra=None):
        print(f"[e2e] {msg} {json.dumps(extra) if extra is not None else ''}", flush=True)

    def start_game(self):
        self.page.evaluate("document.getElementById('btn-start').click()")
        time.sleep(5)

    def drain_dialog(self, max_presses=14):
        """Press Enter until no dialog is open. Returns the last dialog
        text seen (or None) and how many lines were dismissed."""
        last_text = None
        dismissed = 0
        for _ in range(max_presses):
            s = self.state()
            if not s["fase4"]["dialogOpen"]:
                return last_text, dismissed
            last_text = s["fase4"]["dialogText"]
            self.page.keyboard.press("Enter")
            dismissed += 1
            time.sleep(2.5)
        return last_text, dismissed

    def tp(self, x, z):
        self.page.evaluate(f"window.__azure.player.position.set({x}, 1.5, {z})")
        time.sleep(5)

    def tp_car(self, x, z):
        self.page.evaluate(f"window.__azure.currentCar.position.set({x}, 1.5, {z})")
        time.sleep(5)

    def exit_car_if_needed(self):
        if self.state()["inCar"]:
            for _ in range(2):
                self.page.keyboard.press("e")
                for _ in range(15):
                    time.sleep(2)
                    if not self.state()["inCar"]:
                        return
            time.sleep(2)

    def enter_car(self):
        """Teleport the car next to the player, press E, verify inCar."""
        s = self.state()
        px = self.page.evaluate("window.__azure.player.position.x")
        pz = self.page.evaluate("window.__azure.player.position.z")
        self.tp_car(px + 3, pz)
        # E is queued on keydown and consumed by the next frame — but a
        # frame takes 5-7 s under load, so a fixed 5 s wait can read the
        # state before the frame ran. Poll instead; retry E once.
        for _ in range(2):
            self.page.keyboard.press("e")
            for _ in range(15):
                time.sleep(2)
                if self.state()["inCar"] is True:
                    return True
        return self.state()["inCar"] is True

    def wait_stage(self, mission_id, want_stage, timeout=60):
        """Wait until the mission is at want_stage (or completed)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            s = self.state()
            if mission_id in s["fase4"]["completed"]:
                return "completed"
            if s["fase4"]["active"] == mission_id and s["fase4"]["activeStage"] == want_stage:
                return "stage"
            if s["fase4"]["active"] != mission_id:
                return f"lost:{s['fase4']['active']}"
            time.sleep(2)
        return "timeout"

    def wait_no_active(self, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.state()["fase4"]["active"] is None:
                return True
            time.sleep(2)
        return False

    # -- combat: real pistol shots at officers on the camera ray ----------
    def park_police_cars(self):
        self.page.evaluate(
            "window.__azure.police.cars.forEach(u => {"
            " const c = (u && u.car) ? u.car : u;"
            " if (c && c.position) c.position.set(150, 1.5, 150); })")

    def raise_wanted_2(self):
        self.page.evaluate("window.__azure.wanted.reset(); window.__azure.health = 100;")
        time.sleep(3)
        self.page.evaluate("window.__azure.wanted.addHeat(2, 'lane-e-fase4-test')")
        time.sleep(15)
        self.park_police_cars()

    def live_officer(self):
        return self.page.evaluate(
            "(() => { const o = window.__azure.police.officers.find(o => o && o.alive !== false);"
            " return o ? true : false; })()")

    def place_officer_on_ray(self):
        """Put a live officer on the camera ray, 12 m out (or closer when
        the camera pitches down so the aim point stays at chest height)."""
        ok = self.page.evaluate("""() => {
          const o = window.__azure.police.officers.find(o => o && o.alive !== false);
          if (!o) return false;
          const c = window.__azure.camera;
          c.updateMatrixWorld(true);
          const e = c.matrixWorld.elements;
          const px = e[12], py = e[13], pz = e[14];
          const fx = -e[8], fy = -e[9], fz = -e[10];
          let d = 12;
          if (fy < -0.01) d = Math.max(4, Math.min(20, (2.7 - py) / fy));
          o.position.set(px + fx * d, 1.5, pz + fz * d);
          window.__laneE_officer = o;
          return true;
        }""")
        time.sleep(1)
        return ok

    def officer_hp(self):
        return self.page.evaluate("(window.__laneE_officer || {health: null}).health")

    def clear_lock(self):
        """Exit pointer lock and wait until it is actually clear (the
        exit lands on a frame; frames run seconds apart)."""
        self.page.evaluate("if (document.pointerLockElement) document.exitPointerLock();")
        for _ in range(15):
            if not self.page.evaluate("!!document.pointerLockElement"):
                break
            time.sleep(2)

    def shoot_once(self):
        """One real shot. The click MUST land on the game canvas: at
        480x300 the minimap canvas covers x>=240 (a click at the screen
        centre hits the minimap and never reaches input.js), so click at
        (120,150). The first real click also requests pointer lock on the
        canvas, and while locked headless-shell drops later clicks — so
        the caller clears the lock BEFORE placing the officer, and the
        click follows the placement immediately (no long poll in
        between: at 5 m/s an officer crosses the frame in seconds).
        If the real click still does not fire within the poll window
        (frames run ~2.5-7 s under SwiftShader), dispatch a synthetic
        mousedown directly on the game canvas: it still goes through the
        real input listener -> combat.update -> hitscan path, it only
        skips the browser hit-test / pointer-lock layer. Returns (fired,
        via) where via is 'click' or 'dispatch' ('' when nothing fired)."""
        before = self.state()["mag"]
        # Real mouse click on the game canvas, left half, right now.
        self.page.mouse.click(120, 150)
        for _ in range(6):
            time.sleep(2)
            if self.state()["mag"] != before:
                return True, "click"
        # Synthetic mousedown on the game canvas (same listener).
        self.page.evaluate(
            "document.querySelector('canvas').dispatchEvent("
            "new MouseEvent('mousedown', { bubbles: true, button: 0 }))")
        for _ in range(10):
            time.sleep(2)
            if self.state()["mag"] != before:
                return True, "dispatch"
        return False, ""

    def fight_combat_stage(self, need_kills, mission_id, stage_idx):
        """Kill `need_kills` officers with real pistol shots. Pistol:
        25 dmg, officer 100 HP -> 4 hits per kill. Returns kills scored
        in this stage (from the mission engine). The engine RESETS
        active.kills to 0 when the stage advances (missions.js), so the
        loop must also stop when the stage index moves past the combat
        stage — that advance itself proves the kill quota was met."""
        self.page.keyboard.press("2")  # real key: select pistol
        # Frames run seconds apart: wait until the switch registers.
        for _ in range(15):
            if self.state().get("weapon") == "PISTOL":
                break
            time.sleep(2)
        self.page.evaluate("window.__azure.combat.addAmmo(1, 200)")
        self.raise_wanted_2()
        scored = 0
        deadline = time.time() + 1500
        via = {"click": 0, "dispatch": 0}
        while scored < need_kills and time.time() < deadline:
            s = self.state()
            if s["fase4"]["active"] != mission_id:
                break
            if s["fase4"]["activeStage"] != stage_idx:
                # Combat stage complete (engine advanced past it, which
                # only happens once the kill quota is met).
                print(f"[e2e] fight {mission_id}: stage advanced past combat (kills scored {scored})", flush=True)
                return need_kills
            if (s["kills"] or 0) > scored:
                scored = s["kills"] or 0
                # Fresh heat keeps the roster coming without the heli.
                self.page.evaluate("window.__azure.wanted.reset(); window.__azure.health = 100;")
                time.sleep(2)
                self.page.evaluate("window.__azure.wanted.addHeat(2, 'lane-e-fase4-test')")
                time.sleep(10)
                self.park_police_cars()
                continue
            if not self.live_officer():
                time.sleep(5)
                continue
            if (s["mag"] or 0) <= 0:
                self.page.keyboard.press("r")
                time.sleep(5)
                self.page.evaluate("window.__azure.combat.addAmmo(1, 200)")
                continue
            self.page.evaluate("window.__azure.health = 100;")
            # Police cars home in on the player and sit between the
            # camera and the officer: findHit takes the NEAREST candidate
            # on the ray, so a car body-blocks every shot. Park them far
            # away before every placement (they drive back, so re-park
            # each attempt). Log the nearest car's range for diagnosis.
            self.park_police_cars()
            # Clear the pointer lock BEFORE placing: the click must
            # follow the placement immediately (officer runs 5 m/s).
            self.clear_lock()
            if not self.place_officer_on_ray():
                time.sleep(3)
                continue
            hp_before = self.officer_hp()
            fired, how = self.shoot_once()
            if how:
                via[how] += 1
            if not fired:
                continue
            hp_after = self.officer_hp()
            print(f"[e2e] fight {mission_id}: shot via={how} hp {hp_before}->{hp_after} kills={self.state()['kills']}", flush=True)
            if hp_before is not None and hp_after is not None and hp_after >= hp_before:
                # Missed (a ped wandered onto the ray, or the officer
                # moved) — re-place and try again, no kill claimed.
                continue
        got = self.state()["kills"] or 0
        print(f"[e2e] fight {mission_id}: got {got}/{need_kills} via {via}", flush=True)
        return got

    def play_mission(self, mid, steps):
        """Play one mission to completion through the real engine.
        Returns True on completion with the expected reward/respect."""
        page = self.page
        cash0 = self.state()["cash"]
        rep0 = self.state()["respect"]
        definition = page.evaluate(
            f"window.__azure.missions.getById('{mid}')")
        steps[f"{mid}_def"] = bool(definition)
        if not definition:
            return False
        # 1) Walk to the start marker, press E, drain the intro.
        # A drive stage leaves the player IN a car, and tryInteract
        # exits the car on E instead of starting a mission — so exit
        # the car FIRST, then teleport on foot to the marker.
        # RESUME: if this mission is already active (the save applied
        # on load resumed it at its stage), skip the start entirely
        # and continue from the live stage below.
        self.exit_car_if_needed()
        self.page.evaluate("window.__azure.wanted.reset(); window.__azure.health = 100;")
        if self.state()["fase4"]["active"] == mid:
            steps[f"{mid}_resumed_active"] = True
            intro_text, _ = self.drain_dialog()
            steps[f"{mid}_intro_line"] = (intro_text or "")[:60]
            steps[f"{mid}_def"] = True
            steps[f"{mid}_started"] = True
        else:
            self.tp(definition["start"]["x"], definition["start"]["z"])
            started = False
            for _ in range(2):
                page.keyboard.press("e")
                for _ in range(15):
                    time.sleep(2)
                    if self.state()["fase4"]["active"] == mid:
                        started = True
                        break
                if started:
                    break
            s = self.state()
            steps[f"{mid}_started"] = s["fase4"]["active"] == mid
            if not steps[f"{mid}_started"]:
                return False
            intro_text, _ = self.drain_dialog()
            steps[f"{mid}_intro_line"] = (intro_text or "")[:60]
        # 2) Walk the stages in order, reading each live from the engine.
        for _ in range(len(definition["stages"]) + 2):
            s = self.state()
            if mid in s["fase4"]["completed"]:
                break
            act = page.evaluate("window.__azure.missions.getActive()")
            if not act or act["id"] != mid:
                steps[f"{mid}_lost_at"] = s["fase4"]["active"]
                return False
            stage = act["stage"]
            idx = act["stageIndex"]
            if stage is None:
                break
            stype = stage["type"]
            if stype in ("goto", "deliver", "collect"):
                self.exit_car_if_needed()
                self.tp(stage["x"], stage["z"])
                r = self.wait_stage(mid, idx + 1, timeout=45)
                if r == "completed":
                    break
                if r != "stage":
                    steps[f"{mid}_stage{idx}_{stype}"] = r
                    return False
                self.drain_dialog()
            elif stype == "drive":
                self.page.evaluate("window.__azure.wanted.reset();")
                if not self.state()["inCar"]:
                    if not self.enter_car():
                        steps[f"{mid}_stage{idx}_enter_car"] = False
                        return False
                self.tp_car(stage["x"], stage["z"])
                r = self.wait_stage(mid, idx + 1, timeout=45)
                if r == "completed":
                    break
                if r != "stage":
                    steps[f"{mid}_stage{idx}_drive"] = r
                    return False
                self.drain_dialog()
            elif stype == "combat":
                self.exit_car_if_needed()
                need = stage.get("kills") or 3
                got = self.fight_combat_stage(need, mid, idx)
                steps[f"{mid}_stage{idx}_kills"] = got
                if got < need:
                    return False
                r = self.wait_stage(mid, idx + 1, timeout=45)
                if r == "completed":
                    break
                if r != "stage":
                    steps[f"{mid}_stage{idx}_combat_wait"] = r
                    return False
                self.drain_dialog()
            else:
                steps[f"{mid}_unknown_stage_type"] = stype
                return False
        # 3) Outro + reward check.
        self.drain_dialog()
        s = self.state()
        steps[f"{mid}_completed"] = mid in s["fase4"]["completed"]
        steps[f"{mid}_cash_delta"] = s["cash"] - cash0
        steps[f"{mid}_respect_delta"] = s["respect"] - rep0
        exp_cash, exp_rep = EXPECTED[mid]
        steps[f"{mid}_reward_ok"] = (
            steps[f"{mid}_completed"]
            and steps[f"{mid}_cash_delta"] == exp_cash
            and steps[f"{mid}_respect_delta"] == exp_rep)
        return steps[f"{mid}_reward_ok"]


E2E_PROFILE = Path("/home/hatch/workspace/makefun/gta6-01-logs/profile-e2e")
E2E_PROGRESS = Path("/home/hatch/workspace/makefun/gta6-01-logs/lane-e-fase4-e2e-progress.json")


def e2e_m1_m10(pw):
    """Full M1-M10 run, RESUMABLE across VM replacements: a persistent
    Chromium profile keeps the game's localStorage save, and a progress
    file in the workspace logs dir keeps per-mission results. A relaunch
    skips missions already completed (live or in the progress file) and
    resumes an in-progress mission at its saved stage — the game itself
    applies the save on a normal load (main.js: `if (!shot &&
    Save.hasSave()) Save.apply()`), so the resume path under test here
    is the real one, not a harness shortcut."""
    context = pw.chromium.launch_persistent_context(
        str(E2E_PROFILE), headless=True,
        args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
        viewport={"width": 480, "height": 300})
    problems, steps = [], {}
    if E2E_PROGRESS.exists():
        try:
            prior = json.loads(E2E_PROGRESS.read_text())
            steps.update(prior.get("missions", {}))
            steps["resumed_from_progress"] = True
        except Exception:
            pass
    try:
        page = context.new_page()
        page.on("console", lambda m: problems.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
        page.on("requestfailed", lambda r: problems.append(f"requestfailed: {r.url} {r.failure}"))
        page.goto(BASE + "/", wait_until="load", timeout=120000)
        page.wait_for_function("window.__azure !== undefined", timeout=120000)
        time.sleep(5)
        d = Driver(page)
        d.start_game()
        # Radio audio probe: real key gestures have happened (E/Enter
        # above), so the AudioContext may legally start. The probe is
        # read-only: state + steps scheduled + RMS on master.
        time.sleep(3)
        steps["radio_audio"] = page.evaluate("window.__azure.radio.debugAudio()")
        steps["radio_station_start"] = d.state()["fase4"]["radioStation"]
        for mid in ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]:
            done = d.state()["fase4"]["completed"]
            if mid in done or steps.get(f"{mid}_reward_ok") is True:
                steps[f"{mid}_skipped_completed"] = True
                d.log(f"mission {mid} -> skipped (already completed)", {})
                continue
            ok = d.play_mission(mid, steps)
            d.log(f"mission {mid} -> {ok}", {k: v for k, v in steps.items() if k.startswith(mid)})
            if ok:
                # Bank the result NOW (progress file + game save) so a
                # VM replacement after this point loses nothing.
                page.evaluate("window.__azure.save.save()")
                E2E_PROGRESS.parent.mkdir(parents=True, exist_ok=True)
                E2E_PROGRESS.write_text(json.dumps(
                    {"missions": {k: v for k, v in steps.items()
                                  if k.split("_")[0] in
                                  ("m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10")}},
                    indent=2))
            if not ok:
                steps["failed_at"] = mid
                break
        s = d.state()
        steps["final_cash"] = s["cash"]
        steps["final_respect"] = s["respect"]
        steps["final_completed"] = s["fase4"]["completed"]
        steps["all_10_completed"] = sorted(s["fase4"]["completed"]) == [
            "m1", "m10", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]
        page.close()
    finally:
        context.close()
    return steps, problems


# ---- resume-at-stage + checkpoint -------------------------------------------

def resume_test(pw):
    """Start M1, advance to stage 1, save, reload: the mission must
    resume at stage 1 — and still complete afterwards."""
    browser = pw.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    problems, steps = [], {}
    try:
        page = browser.new_page(viewport={"width": 480, "height": 300})
        page.on("console", lambda m: problems.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
        page.on("requestfailed", lambda r: problems.append(f"requestfailed: {r.url} {r.failure}"))
        page.goto(BASE + "/", wait_until="load", timeout=30000)
        page.wait_for_function("window.__azure !== undefined", timeout=30000)
        time.sleep(5)
        d = Driver(page)
        d.start_game()
        d.tp(30, -90)
        page.keyboard.press("e")
        time.sleep(5)
        d.drain_dialog()
        s = d.state()
        steps["stage_before_save"] = s["fase4"]["activeStage"]
        steps["active_before_save"] = s["fase4"]["active"]
        page.evaluate("window.__azure.save.save()")
        time.sleep(2)
        steps["save_record"] = page.evaluate("window.__azure.save.load()")
        page.reload(wait_until="load")
        page.wait_for_function("window.__azure !== undefined", timeout=30000)
        time.sleep(8)
        d.start_game()
        time.sleep(3)
        s = d.state()
        steps["active_after_reload"] = s["fase4"]["active"]
        steps["stage_after_reload"] = s["fase4"]["activeStage"]
        steps["resumed"] = (
            steps["active_after_reload"] == "m1" and steps["stage_after_reload"] == 1)
        steps["intro_not_replayed"] = s["fase4"]["dialogOpen"] is False
        # Finish the resumed mission: drive stage + deliver stage.
        if steps["resumed"]:
            d.enter_car()
            d.tp_car(0, 0)
            r = d.wait_stage("m1", 2, timeout=45)
            steps["drive_after_resume"] = r
            d.drain_dialog()
            d.exit_car_if_needed()
            d.tp(108, 150)
            ok = d.wait_no_active(timeout=45)
            d.drain_dialog()
            s = d.state()
            steps["m1_completed_after_resume"] = "m1" in s["fase4"]["completed"]
            steps["cash_after_resume_m1"] = s["cash"]
        page.close()
    finally:
        browser.close()
    return steps, problems


def checkpoint_test(pw):
    """Die mid-mission (stage 1 of M1): respawn at the CURRENT stage's
    start, stage index unchanged, health 100 — and M1 still completes."""
    browser = pw.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    problems, steps = [], {}
    try:
        page = browser.new_page(viewport={"width": 480, "height": 300})
        page.on("console", lambda m: problems.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
        page.on("requestfailed", lambda r: problems.append(f"requestfailed: {r.url} {r.failure}"))
        page.goto(BASE + "/", wait_until="load", timeout=30000)
        page.wait_for_function("window.__azure !== undefined", timeout=30000)
        time.sleep(5)
        d = Driver(page)
        d.start_game()
        d.tp(30, -90)
        page.keyboard.press("e")
        time.sleep(5)
        d.drain_dialog()
        s = d.state()
        steps["stage_before_death"] = s["fase4"]["activeStage"]
        steps["checkpoint_before_death"] = page.evaluate(
            "window.__azure.missions.getCheckpoint()")
        # Walk away from the checkpoint, then die.
        d.tp(0, -60)
        time.sleep(3)
        page.evaluate("window.__azure.health = 0")
        time.sleep(8)
        s = d.state()
        steps["respawn_dialog_open"] = s["fase4"]["dialogOpen"]
        steps["respawn_dialog_text"] = (s["fase4"]["dialogText"] or "")[:90]
        steps["stage_after_death"] = s["fase4"]["activeStage"]
        steps["health_after_respawn"] = s["health"]
        steps["pos_after_respawn"] = page.evaluate(
            "() => { const p = window.__azure.player.position;"
            " return { x: Math.round(p.x), z: Math.round(p.z) }; }")
        steps["stage_unchanged"] = steps["stage_after_death"] == steps["stage_before_death"]
        steps["health_restored"] = s["health"] == 100
        cp = steps["checkpoint_before_death"] or {}
        steps["respawn_near_checkpoint"] = (
            abs(steps["pos_after_respawn"]["x"] - (cp.get("x") or 0)) <= 3
            and abs(steps["pos_after_respawn"]["z"] - (cp.get("z") or 0)) <= 3)
        d.drain_dialog()
        # Mission must still be completable after the respawn.
        d.enter_car()
        d.tp_car(0, 0)
        r = d.wait_stage("m1", 2, timeout=45)
        steps["drive_after_respawn"] = r
        d.drain_dialog()
        d.exit_car_if_needed()
        d.tp(108, 150)
        d.wait_no_active(timeout=45)
        d.drain_dialog()
        s = d.state()
        steps["m1_completed_after_respawn"] = "m1" in s["fase4"]["completed"]
        page.close()
    finally:
        browser.close()
    return steps, problems


def take_shots(pw):
    if LOCK.exists():
        raise RuntimeError(f"shot lock held: {LOCK} — another lane is shooting")
    LOCK.write_text("lane-e-fase4")
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
    ap.add_argument("--e2e-only", action="store_true")
    ap.add_argument("--resume-only", action="store_true")
    ap.add_argument("--checkpoint-only", action="store_true")
    ap.add_argument("--shots-only", action="store_true")
    args = ap.parse_args()

    server = subprocess.Popen(
        ["node", "serve.ts", "--port", str(PORT)],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        # Wait for the server to accept connections (after a VM reboot
        # node can take a while to come up; a blind 1 s sleep + a 30 s
        # page wait is not enough and the whole run dies at startup).
        import socket as _socket
        for _ in range(60):
            try:
                with _socket.create_connection(("127.0.0.1", PORT), timeout=2):
                    break
            except OSError:
                time.sleep(2)
        else:
            raise RuntimeError(f"serve.ts did not come up on port {PORT}")
        report = {}
        with sync_playwright() as pw:
            if args.playtest_only:
                results, errs = playtest(pw)
                report["playtest"] = results
                report["playtest_errors"] = errs
                report["expectation_failures"] = check_expectations(results)
                print(json.dumps(report, indent=2))
            elif args.e2e_only:
                steps, errs2 = e2e_m1_m10(pw)
                report["e2e"] = steps
                report["e2e_errors"] = errs2
                print(json.dumps(steps, indent=2))
            elif args.resume_only:
                steps, errs2 = resume_test(pw)
                report["resume"] = steps
                report["resume_errors"] = errs2
                print(json.dumps(steps, indent=2))
            elif args.checkpoint_only:
                steps, errs2 = checkpoint_test(pw)
                report["checkpoint"] = steps
                report["checkpoint_errors"] = errs2
                print(json.dumps(steps, indent=2))
            elif args.shots_only:
                out, errs3 = take_shots(pw)
                report["shots"] = out
                report["shot_errors"] = errs3
                print(json.dumps(out, indent=2))
            else:
                results, errs = playtest(pw)
                report["playtest"] = results
                report["playtest_errors"] = errs
                report["expectation_failures"] = check_expectations(results)
                print("playtest done:", json.dumps(report["expectation_failures"]), flush=True)
                steps, errs2 = e2e_m1_m10(pw)
                report["e2e"] = steps
                report["e2e_errors"] = errs2
                print("e2e done", flush=True)
                steps, errs2 = resume_test(pw)
                report["resume"] = steps
                report["resume_errors"] = errs2
                print("resume done", flush=True)
                steps, errs2 = checkpoint_test(pw)
                report["checkpoint"] = steps
                report["checkpoint_errors"] = errs2
                print("checkpoint done", flush=True)
                out, errs3 = take_shots(pw)
                report["shots"] = out
                report["shot_errors"] = errs3
                print("shots done", flush=True)
        # Merge with the existing report (a resumable E2E rerun must not
        # wipe the playtest section written by an earlier run).
        report_path = HERE / "lane-e-fase4-report.json"
        if report_path.exists():
            try:
                prior_report = json.loads(report_path.read_text())
                if isinstance(prior_report, dict):
                    prior_report.update(report)
                    report = prior_report
            except Exception:
                pass
        report_path.write_text(json.dumps(report, indent=2))
        print(f"report written to {report_path}")
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except Exception:
            server.kill()


if __name__ == "__main__":
    main()
