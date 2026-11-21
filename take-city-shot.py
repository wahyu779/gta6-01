#!/usr/bin/env python3
"""Retake the AZURE BAY city screenshot (?shot=city) with headless Chromium.

Serves game/ via `node serve.ts` on 127.0.0.1:8901, opens the shot URL at
1280x800, waits for window.__shotReady, then captures a JPEG (q78) to
screenshots/city.jpg. Prints console/page errors so a broken render
is visible instead of silent. Usage: python3 take-city-shot.py

Same settle trick as take-combat-shot.py: headless SwiftShader renders
this scene at ~1 frame per 3 s at 1280x800, so the 90-frame settle runs
at 480x300 (fragment cost ~7x lower, ~1 min), then the viewport is
resized to 1280x800 — the engine handles resize, and the city staging
re-applies its held camera pose every frame.
"""
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PORT = 8901
URL = f"http://127.0.0.1:{PORT}/?shot=city"
OUT = HERE / "screenshots" / "city.jpg"


def main() -> int:
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
            page = browser.new_page(viewport={"width": 480, "height": 300})
            errors = []
            page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.goto(URL, wait_until="load", timeout=30000)
            # The game signals a settled scene at frame 90 for city.
            page.wait_for_function("window.__shotReady === true", timeout=300000)
            page.set_viewport_size({"width": 1280, "height": 800})
            # Let a couple of full-res frames present with the held
            # staging camera still applied every frame.
            time.sleep(8)
            page.screenshot(path=str(OUT), type="jpeg", quality=78, timeout=180000)
            browser.close()
        size = OUT.stat().st_size
        print(f"wrote {OUT} ({size} bytes)")
        if size > 262144:
            print("OVER the 256 KiB cap!")
            return 1
        for line in errors:
            print("  !", line)
        if errors:
            print(f"{len(errors)} console/page errors (see above)")
        return 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    sys.exit(main())
