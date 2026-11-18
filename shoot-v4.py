#!/usr/bin/env python3
"""Token Radar v4 screenshots: board, detail, farm-filtered, out-of-sample.

Renders out/dashboard/index.html at 1440x900 with the VM's headless
Chrome for Testing, driven by Playwright (plain `chrome --screenshot`
captures a blank frame for the scrolled views on this long page — the
JS scroll never paints under virtual time — so Playwright drives the
same binary with explicit waits after each scroll instead).

Every shot is checked against the gate: at most 512 KiB, long side at
most 1440, short side at least 800. A PNG over the cap is re-saved as
JPEG q85 under the same stem (the gate accepts both).

Run after main.ts; then re-run main.ts so the dossier picks up the new
screenshots.
"""
import os
import sys

from playwright.sync_api import sync_playwright

CHROME = os.path.expanduser(
    "~/workspace/tools/chrome-for-testing/chrome-linux64/chrome"
)
ROOT = os.path.expanduser(
    "~/workspace/makefun/token-radar-01/work/build-v4"
)
PAGE = f"file://{ROOT}/out/dashboard/index.html"
OUT = os.path.join(ROOT, "screenshots")
VIEWPORT = {"width": 1440, "height": 900}
CHROME_FLAGS = ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"]


def shrink(path):
    """Check size/dimensions; convert an oversize PNG to JPEG q85."""
    from PIL import Image

    with Image.open(path) as im:
        w, h = im.size
    size = os.path.getsize(path)
    print(f"{os.path.basename(path)}: {w}x{h}, {size} bytes ({size / 1024:.0f} KB)")
    assert max(w, h) <= 1440, "long side over 1440"
    assert min(w, h) >= 800, "short side under 800"
    if size <= 512 * 1024:
        return path
    jpg = path[:-4] + ".jpg"
    with Image.open(path) as im:
        im.convert("RGB").save(jpg, "JPEG", quality=85, optimize=True)
    os.remove(path)
    size = os.path.getsize(jpg)
    print(f"  converted to JPEG {os.path.basename(jpg)}: {size} bytes ({size / 1024:.0f} KB)")
    assert size <= 512 * 1024, "still over the cap after JPEG conversion"
    return jpg


def main():
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME,
            args=CHROME_FLAGS,
        )

        # 1 — board overview: KPI strip, verdict tabs, top rows.
        pg = browser.new_page(viewport=VIEWPORT)
        pg.goto(PAGE)
        pg.wait_for_selector("table#board tbody tr", timeout=15000)
        pg.wait_for_timeout(400)
        pg.screenshot(path=os.path.join(OUT, "1-board.png"))
        pg.close()

        # 2 — detail view of the top row, framed mid-panel: the implied
        # value row stays visible at the top, the sensitivity grid sits
        # in the middle, and the farm plan starts at the bottom. The
        # offset is measured from the live page, not hard-coded.
        pg = browser.new_page(viewport=VIEWPORT)
        pg.goto(PAGE + "#detail/polymarket-international")
        pg.wait_for_selector("#detail-panel:not([hidden])", timeout=15000)
        pg.evaluate("""() => {
          const h = [...document.querySelectorAll('#detail-body h3')]
            .find((x) => x.textContent.startsWith('Farm plan'));
          const farmY = h.getBoundingClientRect().top + window.scrollY;
          window.scrollTo(0, farmY - 730);
        }""")
        pg.wait_for_timeout(400)
        pg.screenshot(path=os.path.join(OUT, "2-detail.png"))
        pg.close()

        # 3 — the board filtered to FARM verdicts.
        pg = browser.new_page(viewport=VIEWPORT)
        pg.goto(PAGE + "#verdict/FARM")
        pg.wait_for_selector("table#board tbody tr", timeout=15000)
        pg.wait_for_timeout(400)
        pg.screenshot(path=os.path.join(OUT, "3-filtered.png"))
        pg.close()

        # 4 — the out-of-sample panel: headline checks beside the odds
        # calibration panel, with the calibration curve just below.
        pg = browser.new_page(viewport=VIEWPORT)
        pg.goto(PAGE)
        pg.wait_for_selector("#oos-head table", timeout=15000)
        pg.evaluate("document.querySelector('#oos').scrollIntoView()")
        pg.wait_for_timeout(400)
        pg.screenshot(path=os.path.join(OUT, "4-outofsample.png"))
        pg.close()

        browser.close()

    for name in sorted(os.listdir(OUT)):
        if name.endswith((".png", ".jpg")):
            shrink(os.path.join(OUT, name))
    total = sum(
        os.path.getsize(os.path.join(OUT, n))
        for n in os.listdir(OUT)
        if n.endswith((".png", ".jpg"))
    )
    print(f"all screenshots verified ({total / 1024:.0f} KB total)")


if __name__ == "__main__":
    sys.exit(main())
