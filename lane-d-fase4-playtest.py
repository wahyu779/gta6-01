#!/usr/bin/env python3
"""Lane D (Fase 4) verification for AZURE BAY — radio audio + HUD polish.

Written fresh in this session (Lane D, 2026-11-20). Serves game/ with
`node serve.ts`, drives headless Chromium (SwiftShader) via Playwright.

Checks, per shot (combat / chase / heli / city, 1280x800 after
__shotReady):
  * HUD geometry: bounding rects of every HUD chip (Fase 1 + Fase 3 +
    dialog + minimap); any pairwise overlap between two VISIBLE
    elements is reported with the intersecting area.
  * console errors / pageerrors / failed requests.
Radio checks (real browser, real gesture):
  * chase (in car): before any gesture no AudioContext exists yet
    (startAudio is a no-op until the first gesture, so no suspended
    context and no autoplay warning at load); after a mouse click it
    must be 'running', scheduler on, steps increasing, and analyser
    RMS > 0 (oscillators really flowing to the destination, not just
    a HUD label). R must switch the station and the HUD chip must
    follow, RMS staying > 0.
  * combat (on foot): after a click audio runs; R must NOT switch the
    station (on foot R is reload).
SAVED / respect checks (city page): Save.save() flashes the SAVED chip
for ~2 s; HudFase3.respectText(250) reads RESPECTED.
Screenshots go to lane-d-fase4-shots/ (verification only — the final
screenshots/ are retaken separately with take-shot.py if HUD moves).

Usage: python3 lane-d-fase4-playtest.py
Writes lane-d-fase4-report.json next to this file.
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PORT = 8906
BASE = f"http://127.0.0.1:{PORT}"
SHOTS_DIR = HERE / "lane-d-fase4-shots"
SHOTS_DIR.mkdir(exist_ok=True)
SERVE_LOG = HERE / "lane-d-fase4-serve.log"


def start_server():
    """Start serve.ts with output to a log file (not a pipe nobody reads:
    a previous run lost its server mid-run and the piped output died
    with the driver, so the cause was unrecoverable)."""
    log = open(SERVE_LOG, "ab")
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
    raise RuntimeError(f"serve.ts on {PORT} did not come up; see {SERVE_LOG}")


def ensure_server(proc):
    """Restart the server if it died (or stopped answering) since the
    last shot — a dead server must not kill the whole run."""
    alive = proc is not None and proc.poll() is None
    if alive:
        try:
            urllib.request.urlopen(BASE + "/", timeout=5)
            return proc
        except Exception:
            alive = False
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    print("server dead/unreachable — restarting", flush=True)
    return start_server()

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
      overflowX: el.scrollWidth > el.clientWidth + 1,
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
    """Pairwise intersections between visible elements (area in px^2)."""
    vis = {k: v for k, v in rects.items() if v and v["visible"]}
    found = []
    keys = sorted(vis)
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            ra, rb = vis[a], vis[b]
            ix = max(0, min(ra["x"] + ra["w"], rb["x"] + rb["w"]) - max(ra["x"], rb["x"]))
            iy = max(0, min(ra["y"] + ra["h"], rb["y"] + rb["h"]) - max(ra["y"], rb["y"]))
            if ix > 0 and iy > 0:
                found.append({"a": a, "b": b, "area": ix * iy,
                              "ix": ix, "iy": iy})
    return found


def sample_rms(page, n=5, gap=0.3):
    """Sample the radio debug probe n times; return the samples."""
    out = []
    for _ in range(n):
        out.append(page.evaluate(RADIO_JS))
        time.sleep(gap)
    return out


def check_shot(browser, name, radio_test=None):
    # Settle at a tiny viewport: SwiftShader fragment cost scales with
    # pixels, and the cell is shared with other lanes' renders — at
    # 320x200 the 90-frame settle is ~2x faster than 480x300. The
    # engine handles resize and the staging re-applies every frame,
    # so resizing to 1280x800 after the flag keeps the exact staged
    # composition (same trick as take-shot.py, one notch smaller).
    page = browser.new_page(viewport={"width": 320, "height": 200})
    errors = []
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}")
            if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("requestfailed", lambda r: errors.append(f"requestfailed: {r.url}"))
    page.goto(f"{BASE}/?shot={name}", wait_until="load", timeout=120000)
    page.wait_for_function("window.__shotReady === true", timeout=900000)
    page.set_viewport_size({"width": 1280, "height": 800})
    time.sleep(8)  # let full-res frames present with staging applied
    rects = page.evaluate(RECTS_JS)
    result = {
        "shot": name,
        "errors": errors,
        "rects": rects,
        "overlaps": overlaps(rects),
        "overflowX": [k for k, v in rects.items() if v and v.get("overflowX")],
    }
    page.screenshot(path=str(SHOTS_DIR / f"{name}-verify.jpg"),
                    type="jpeg", quality=78, timeout=180000)
    if radio_test == "car":
        # In-car radio: probe BEFORE any gesture, then click, then R.
        result["radio_before_gesture"] = page.evaluate(RADIO_JS)
        page.mouse.click(640, 200)
        time.sleep(1.0)
        result["radio_after_gesture"] = sample_rms(page)
        page.keyboard.press("KeyR")
        time.sleep(1.0)
        result["radio_after_R"] = sample_rms(page, n=3)
    elif radio_test == "foot":
        result["radio_before_gesture"] = page.evaluate(RADIO_JS)
        page.mouse.click(640, 200)
        time.sleep(1.0)
        result["radio_after_gesture"] = sample_rms(page)
        page.keyboard.press("KeyR")
        time.sleep(1.0)
        result["radio_after_R"] = sample_rms(page, n=3)
    elif radio_test == "saved":
        before = page.evaluate(RADIO_JS)
        page.evaluate("window.__azure.save.save()")
        time.sleep(0.3)
        saved_visible = page.evaluate(
            "() => { const el = document.getElementById('hud-fase3-saved');"
            " return el ? getComputedStyle(el).display : 'missing'; }")
        respect = page.evaluate(
            "() => window.__azure.hudFase3.respectText(250)")
        respect_chip = page.evaluate(
            "() => { const el = document.getElementById('hud-fase3-respect');"
            " return el ? el.textContent : null; }")
        time.sleep(2.5)
        saved_after = page.evaluate(
            "() => { const el = document.getElementById('hud-fase3-saved');"
            " return el ? getComputedStyle(el).display : 'missing'; }")
        result["saved"] = {"before": before, "flash_display": saved_visible,
                           "after_2_5s": saved_after,
                           "respectText_250": respect,
                           "respect_chip": respect_chip}
    page.close()
    return result


def write_report(report):
    (HERE / "lane-d-fase4-report.json").write_text(json.dumps(report, indent=2))


def print_shot(r):
    name = r["shot"]
    print(f"== {name}: errors={len(r.get('errors', []))} "
          f"overlaps={r.get('overlaps')} overflowX={r.get('overflowX')}", flush=True)
    for e in r.get("errors", []):
        print(f"   {e}", flush=True)
    if "radio_after_gesture" in r:
        b = r["radio_before_gesture"]["debug"]
        a = r["radio_after_gesture"][-1]["debug"]
        print(f"   radio before: state={b['state']} rms={b['rms']} "
              f"steps={b['stepsScheduled']}", flush=True)
        print(f"   radio after click: state={a['state']} "
              f"rms={a['rms']} steps={a['stepsScheduled']} "
              f"sched={a['schedulerRunning']} gain={a['masterGain']}", flush=True)
        rr = r["radio_after_R"][-1]
        print(f"   radio after R: station={rr['station']} "
              f"chip={rr['chip']!r} rms={rr['debug']['rms']} "
              f"steps={rr['debug']['stepsScheduled']}", flush=True)
    if "saved" in r:
        print(f"   saved: {r['saved']}", flush=True)


def main() -> int:
    server = start_server()
    report = {"shots": {}}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=[
                "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            try:
                for name, kind in (("chase", "car"), ("combat", "foot"),
                                   ("heli", None), ("city", "saved")):
                    try:
                        server = ensure_server(server)
                        report["shots"][name] = check_shot(browser, name, kind)
                    except Exception as exc:  # one shot must not kill the run
                        report["shots"][name] = {"shot": name, "error": repr(exc),
                                                 "errors": [], "overlaps": [],
                                                 "overflowX": []}
                        print(f"== {name}: FAILED {exc!r}", flush=True)
                    write_report(report)
                    if "error" not in report["shots"][name]:
                        print_shot(report["shots"][name])
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
