#!/usr/bin/env python3
"""Retake one AZURE BAY screenshot (?shot=<name>) with headless Chromium.

Serves game/ via `node serve.ts` on 127.0.0.1:8901, opens the shot URL at
1280x800, waits for window.__shotReady, then captures a JPEG (q78) to
screenshots/<name>.jpg. Prints console/page errors so a broken render
is visible instead of silent. Usage: python3 take-shot.py combat|chase
"""
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PORT = 8901


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in ("combat", "chase", "heli", "city", "traffic", "driving", "onfoot"):
        print("usage: take-shot.py <combat|chase|heli|city|traffic|driving|onfoot>", file=sys.stderr)
        return 2
    name = sys.argv[1]
    url = f"http://127.0.0.1:{PORT}/?shot={name}"
    out = HERE / "screenshots" / f"{name}.jpg"

    server = subprocess.Popen(
        ["node", "serve.ts", "--port", str(PORT)],
        cwd=HERE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=[
                "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader",
            ])
            # Wait for the settled scene at a small viewport: headless
            # SwiftShader renders this scene at ~1 frame per 3 s at
            # 1280x800, so 90 frames would take ~5 min. At 480x300 the
            # fragment cost is ~7x lower and the wait is ~1 min. The
            # engine handles resize (camera aspect + renderer size), and
            # the shot staging re-applies every frame, so resizing
            # after the flag fires keeps the exact staged composition.
            page = browser.new_page(viewport={"width": 480, "height": 300})
            errors = []
            page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.goto(url, wait_until="load", timeout=30000)
            # The game signals a settled scene at frame 90 (frame 30 for
            # heli). Game dt is clamped to 0.05 s, so the staged scene is
            # only ~4.5 s into game time when the flag fires.
            page.wait_for_function("window.__shotReady === true", timeout=300000)
            page.set_viewport_size({"width": 1280, "height": 800})
            # Let a couple of full-res frames present with the staging
            # (muzzle flash + light bar) still applied every frame.
            time.sleep(8)
            page.screenshot(path=str(out), type="jpeg", quality=78, timeout=180000)
            browser.close()
        size = out.stat().st_size
        print(f"wrote {out} ({size} bytes)")
        if size > 262144:
            print(f"WARNING: {out} exceeds 256 KiB ({size} bytes)", file=sys.stderr)
            return 1
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    raise SystemExit(main())
