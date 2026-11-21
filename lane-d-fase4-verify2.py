#!/usr/bin/env python3
"""Lane D (Fase 4) TARGETED verification — radio audio + HUD dialog lift.

The full 4-shot settle run (lane-d-fase4-playtest.py) could not finish
in this cell: runs 2-6 died to a dead server, CPU starvation (load 17
on 1.5 CPUs, 4 concurrent SwiftShader renders), a runtime restart,
and a killed browser. This script verifies the same two questions
without waiting for __shotReady (90 frames), which is the slow part:

  A. Radio (chase page, player in car from stageShot at load):
     before gesture no AudioContext; after a click state 'running',
     scheduler on, steps increasing, analyser RMS > 0; R switches the
     station and the HUD chip follows, RMS staying > 0.
  B. Radio on foot (combat page): after a click audio runs; R must NOT
     switch the station (on foot R is reload).
  C. HUD dialog lift (city page): open Rook's intro dialog directly
     via Dialog.show() and measure rects — the mission tracker and the
     objective must sit ABOVE the dialog box with zero overlaps; after
     Dialog.hide() both return to their resting spots. Also the SAVED
     flash (Save.save()) and respectText(250) -> RESPECTED.

One browser, small viewport, ~2 min total. Usage:
  python3 lane-d-fase4-verify2.py
Writes lane-d-fase4-report2.json next to this file.
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PORT = 8908
BASE = f"http://127.0.0.1:{PORT}"

HUD_IDS = [
    "hud-health", "hud-wanted", "hud-cash", "hud-time", "hud-speed",
    "hud-ammo", "hud-objective", "hud-fase3-radio", "hud-fase3-respect",
    "hud-fase3-mission", "hud-fase3-saved", "azure-dialog", "minimap",
]

RECTS_JS = """() => {
  const out = {};
  for (const id of %s) {
    const el = document.getElementById(id);
    if (!el) { out[id] = null; continue; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const visible = cs.display !== 'none' && cs.visibility !== 'hidden'
      && r.width > 0 && r.height > 0;
    out[id] = {
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      visible,
      text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 90),
    };
  }
  return out;
}""" % json.dumps(HUD_IDS)

RADIO_JS = """() => {
  const r = window.__azure && window.__azure.radio;
  if (!r || typeof r.debugAudio !== 'function') return null;
  const chip = document.getElementById('hud-fase3-radio');
  return {
    debug: r.debugAudio(),
    station: r.current() ? r.current().id : null,
    label: r.label(),
    chip: chip ? chip.textContent.trim() : null,
    dialogOpen: !!window.__dialogOpen,
  };
}"""


def overlaps(rects):
    vis = {k: v for k, v in rects.items() if v and v["visible"]}
    found = []
    keys = sorted(vis)
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            ra, rb = vis[a], vis[b]
            ix = max(0, min(ra["x"] + ra["w"], rb["x"] + rb["w"]) - max(ra["x"], rb["x"]))
            iy = max(0, min(ra["y"] + ra["h"], rb["y"] + rb["h"]) - max(ra["y"], rb["y"]))
            if ix > 0 and iy > 0:
                found.append({"a": a, "b": b, "area": ix * iy, "ix": ix, "iy": iy})
    return found


def start_server():
    log = open(HERE / "lane-d-fase4-serve2.log", "ab")
    proc = subprocess.Popen(
        ["node", "serve.ts", "--port", str(PORT)],
        cwd=HERE, stdout=log, stderr=subprocess.STDOUT, text=True)
    for _ in range(20):
        try:
            urllib.request.urlopen(BASE + "/", timeout=2)
            return proc
        except Exception:
            if proc.poll() is not None:
                break
            time.sleep(0.5)
    raise RuntimeError(f"serve.ts on {PORT} did not come up")


def new_page(browser, shot):
    page = browser.new_page(viewport={"width": 800, "height": 500})
    errors = []
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}")
            if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("requestfailed", lambda r: errors.append(f"requestfailed: {r.url}"))
    page.goto(f"{BASE}/?shot={shot}", wait_until="load", timeout=120000)
    page.wait_for_function("window.__azure && window.__azure.radio",
                           timeout=120000)
    time.sleep(3)  # let the game boot + a few frames run
    return page, errors


def save(report):
    """Write the report after EVERY test: the cell keeps killing
    browsers/runs mid-flight, so a result only exists once it is on
    disk."""
    (HERE / "lane-d-fase4-report2.json").write_text(json.dumps(report, indent=2))


def main() -> int:
    server = start_server()
    report = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=[
                "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            try:
                # ---- A. radio in car (chase) ----
                try:
                    page, errors = new_page(browser, "chase")
                    a = {"errors": errors}
                    a["before"] = page.evaluate(RADIO_JS)
                    page.mouse.click(400, 100)
                    time.sleep(1.5)
                    a["after_click"] = [page.evaluate(RADIO_JS) for _ in range(3)]
                    for _ in range(3):
                        time.sleep(0.3)
                    page.keyboard.press("KeyR")
                    time.sleep(1.0)
                    a["after_R"] = [page.evaluate(RADIO_JS) for _ in range(2)]
                    a["rects"] = page.evaluate(RECTS_JS)
                    a["overlaps"] = overlaps(a["rects"])
                    page.close()
                    report["radio_in_car"] = a
                    print("A radio_in_car:", json.dumps({
                        "before": a["before"]["debug"],
                        "after_click": a["after_click"][-1]["debug"],
                        "after_R": a["after_R"][-1],
                        "errors": a["errors"], "overlaps": a["overlaps"],
                    }, indent=1), flush=True)
                except Exception as exc:
                    report["radio_in_car"] = {"error": repr(exc)}
                    print(f"A radio_in_car FAILED: {exc!r}", flush=True)
                    try:
                        page.close()
                    except Exception:
                        pass
                save(report)

                # ---- B. radio on foot (combat) ----
                try:
                    page, errors = new_page(browser, "combat")
                    b = {"errors": errors}
                    b["before"] = page.evaluate(RADIO_JS)
                    page.mouse.click(400, 100)
                    time.sleep(1.5)
                    b["after_click"] = page.evaluate(RADIO_JS)
                    page.keyboard.press("KeyR")
                    time.sleep(1.0)
                    b["after_R"] = page.evaluate(RADIO_JS)
                    b["rects"] = page.evaluate(RECTS_JS)
                    b["overlaps"] = overlaps(b["rects"])
                    page.close()
                    report["radio_on_foot"] = b
                    print("B radio_on_foot:", json.dumps({
                        "before": b["before"]["debug"],
                        "after_click": b["after_click"]["debug"],
                        "after_R_station": b["after_R"]["station"],
                        "after_R_chip": b["after_R"]["chip"],
                        "errors": b["errors"], "overlaps": b["overlaps"],
                    }, indent=1), flush=True)
                except Exception as exc:
                    report["radio_on_foot"] = {"error": repr(exc)}
                    print(f"B radio_on_foot FAILED: {exc!r}", flush=True)
                    try:
                        page.close()
                    except Exception:
                        pass
                save(report)

                # ---- C. HUD dialog lift (city) ----
                try:
                    page, errors = new_page(browser, "city")
                    c = {"errors": errors}
                    c["baseline_rects"] = page.evaluate(RECTS_JS)
                    c["baseline_overlaps"] = overlaps(c["baseline_rects"])
                    page.evaluate(
                        "() => window.__azure.dialog.show('ROOK', "
                        "'You washed up on my shore owing me a favour, kid. "
                        "Time to pay it off — one small job, no questions.')")
                    time.sleep(1.0)
                    c["dialog_open_rects"] = page.evaluate(RECTS_JS)
                    c["dialog_open_overlaps"] = overlaps(c["dialog_open_rects"])
                    c["dialog_open"] = page.evaluate("() => window.__dialogOpen")
                    page.evaluate("() => window.__azure.dialog.hide()")
                    time.sleep(0.5)
                    c["dialog_closed_rects"] = page.evaluate(RECTS_JS)
                    c["dialog_closed_overlaps"] = overlaps(c["dialog_closed_rects"])
                    # SAVED flash + respect on the same page
                    page.evaluate("() => window.__azure.save.save()")
                    time.sleep(0.3)
                    c["saved_flash"] = page.evaluate(
                        "() => { const el = document.getElementById('hud-fase3-saved');"
                        " return el ? getComputedStyle(el).display : 'missing'; }")
                    c["respect_250"] = page.evaluate(
                        "() => window.__azure.hudFase3.respectText(250)")
                    time.sleep(2.5)
                    c["saved_after"] = page.evaluate(
                        "() => { const el = document.getElementById('hud-fase3-saved');"
                        " return el ? getComputedStyle(el).display : 'missing'; }")
                    page.screenshot(path=str(HERE / "lane-d-fase4-shots" / "dialog-lift-verify.jpg"),
                                    type="jpeg", quality=78, timeout=120000)
                    page.close()
                    report["hud_dialog_lift"] = c
                    print("C hud_dialog_lift:", json.dumps({
                        "baseline_overlaps": c["baseline_overlaps"],
                        "dialog_open": c["dialog_open"],
                        "dialog_open_overlaps": c["dialog_open_overlaps"],
                        "dialog_open_rects": {k: c["dialog_open_rects"][k] for k in
                                              ("azure-dialog", "hud-fase3-mission",
                                               "hud-objective", "minimap")},
                        "dialog_closed_overlaps": c["dialog_closed_overlaps"],
                        "saved_flash": c["saved_flash"], "saved_after": c["saved_after"],
                        "respect_250": c["respect_250"],
                        "errors": c["errors"],
                    }, indent=1), flush=True)
                except Exception as exc:
                    report["hud_dialog_lift"] = {"error": repr(exc)}
                    print(f"C hud_dialog_lift FAILED: {exc!r}", flush=True)
                    try:
                        page.close()
                    except Exception:
                        pass
                save(report)
            finally:
                browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
