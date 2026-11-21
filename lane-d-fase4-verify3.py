#!/usr/bin/env python3
"""Lane D (Fase 4) verification round 3 — two loose ends from verify2.

1. RMS-max after R (chase page): verify2's single-instant analyser
   windows read RMS 0 in 3/3 samples taken right after an R press,
   while 4/4 samples after a plain click read > 0. Sample the probe
   20x over ~2 s after R and take the MAX: if max > 0 the graph is
   sounding after the switch (bursty scheduling under a starved
   headless clock), if every sample is 0 something about the switch
   silences it.
2. Dialog lift at 1280x800 (city page): verify2's test C measured
   everything but died at the screenshot step before saving. This
   run measures the rects with the dialog open (at 800x500, then
   resized to 1280x800 — DOM reflows instantly, no full-res frame
   needed), then with it closed, plus the SAVED flash and respect.
   No screenshots: the rects are the evidence.

Writes lane-d-fase4-report3.json incrementally after each step.
Usage: python3 lane-d-fase4-verify3.py
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PORT = 8909
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


def save(report):
    (HERE / "lane-d-fase4-report3.json").write_text(json.dumps(report, indent=2))


def start_server():
    log = open(HERE / "lane-d-fase4-serve3.log", "ab")
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


def new_page(browser, shot, w=800, h=500):
    page = browser.new_page(viewport={"width": w, "height": h})
    errors = []
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}")
            if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("requestfailed", lambda r: errors.append(f"requestfailed: {r.url}"))
    page.goto(f"{BASE}/?shot={shot}", wait_until="load", timeout=120000)
    page.wait_for_function("window.__azure && window.__azure.radio",
                           timeout=120000)
    time.sleep(3)
    return page, errors


def main() -> int:
    server = start_server()
    report = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=[
                "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            try:
                # ---- 1. RMS-max after R ----
                try:
                    page, errors = new_page(browser, "chase")
                    r = {"errors": errors}
                    page.mouse.click(400, 100)
                    time.sleep(1.0)
                    page.keyboard.press("KeyR")
                    time.sleep(0.5)
                    samples = []
                    for _ in range(20):
                        samples.append(page.evaluate(RADIO_JS))
                        time.sleep(0.1)
                    r["samples_after_R"] = samples
                    r["max_rms"] = max(s["debug"]["rms"] or 0 for s in samples)
                    r["nonzero_count"] = sum(
                        1 for s in samples if (s["debug"]["rms"] or 0) > 0)
                    r["steps_first"] = samples[0]["debug"]["stepsScheduled"]
                    r["steps_last"] = samples[-1]["debug"]["stepsScheduled"]
                    r["station"] = samples[-1]["station"]
                    r["chip"] = samples[-1]["chip"]
                    page.close()
                    report["rms_max_after_R"] = r
                    print("rms_max_after_R: station=%s chip=%r max_rms=%s "
                          "nonzero=%d/20 steps %s->%s errors=%s"
                          % (r["station"], r["chip"], r["max_rms"],
                             r["nonzero_count"], r["steps_first"],
                             r["steps_last"], r["errors"]), flush=True)
                except Exception as exc:
                    report["rms_max_after_R"] = {"error": repr(exc)}
                    print(f"rms_max_after_R FAILED: {exc!r}", flush=True)
                    try:
                        page.close()
                    except Exception:
                        pass
                save(report)

                # ---- 2. dialog lift at 1280x800 ----
                try:
                    page, errors = new_page(browser, "city")
                    c = {"errors": errors}
                    c["baseline_800"] = page.evaluate(RECTS_JS)
                    c["baseline_800_overlaps"] = overlaps(c["baseline_800"])
                    page.evaluate(
                        "() => window.__azure.dialog.show('ROOK', "
                        "'You washed up on my shore owing me a favour, kid. "
                        "Time to pay it off — one small job, no questions.')")
                    time.sleep(1.0)
                    c["open_800"] = page.evaluate(RECTS_JS)
                    c["open_800_overlaps"] = overlaps(c["open_800"])
                    save(report)  # persist before the resize
                    page.set_viewport_size({"width": 1280, "height": 800})
                    time.sleep(2)
                    c["open_1280"] = page.evaluate(RECTS_JS)
                    c["open_1280_overlaps"] = overlaps(c["open_1280"])
                    c["dialog_open"] = page.evaluate("() => window.__dialogOpen")
                    save(report)
                    page.evaluate("() => window.__azure.dialog.hide()")
                    time.sleep(0.5)
                    c["closed_1280"] = page.evaluate(RECTS_JS)
                    c["closed_1280_overlaps"] = overlaps(c["closed_1280"])
                    save(report)
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
                    page.close()
                    report["hud_dialog_lift"] = c
                    for key in ("open_800", "open_1280", "closed_1280"):
                        print(key, "overlaps:", c[key + "_overlaps"]
                              if key + "_overlaps" in c else c.get(key.replace("_800", "_800_overlaps")),
                              flush=True)
                    print("dialog rects @1280:", {k: c["open_1280"][k] for k in
                          ("azure-dialog", "hud-fase3-mission",
                           "hud-objective", "minimap")}, flush=True)
                    print("saved:", c["saved_flash"], "->", c["saved_after"],
                          "respect:", c["respect_250"], "errors:", c["errors"],
                          flush=True)
                except Exception as exc:
                    report["hud_dialog_lift"] = {"error": repr(exc)}
                    print(f"hud_dialog_lift FAILED: {exc!r}", flush=True)
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
