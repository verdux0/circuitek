"""
Navegador (Chrome sin cabeza + Playwright) contra `npx vite preview --port 4173`.
Uso: python tools/verify_panels.py http://localhost:4173/ carpeta-de-capturas
(GLITCH_CHROME=/ruta/a/chrome si no lo encuentra.)
"""
"""Resizable panels check. Usage: python panels_check.py URL OUTDIR"""
import asyncio, sys
from pathlib import Path
from playwright.async_api import async_playwright

URL = sys.argv[1]
OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
import os, shutil
CHROME = next((p for p in [os.environ.get("GLITCH_CHROME"), r"C:\Program Files\Google\Chrome\Application\chrome.exe", "/usr/bin/google-chrome", shutil.which("google-chrome") or ""] if p and os.path.exists(p)), None)
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)


async def width(pg, sel):
    return await pg.evaluate(f"document.querySelector('{sel}').getBoundingClientRect().width")


async def drag(pg, loc, dx, dy, steps=12):
    b = await loc.bounding_box()
    x, y = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
    await pg.mouse.move(x, y)
    await pg.mouse.down()
    await pg.mouse.move(x + dx, y + dy, steps=steps)
    await pg.wait_for_timeout(80)
    await pg.mouse.up()
    await pg.wait_for_timeout(250)


async def desktop(p):
    b = await p.chromium.launch(executable_path=CHROME, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    ctx = await b.new_context(viewport={"width": 1400, "height": 900})
    pg = await ctx.new_page()
    errors, external = [], []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
    pg.on("request", lambda r: not r.url.startswith(("http://localhost", "data:", "blob:")) and external.append(r.url))
    await pg.goto(URL)
    await pg.evaluate("localStorage.removeItem('circuitek:layout')")
    await pg.reload()
    await pg.wait_for_function("!!window.__glitch")
    await pg.evaluate("window.__glitch.loadSample()")
    await pg.wait_for_timeout(500)
    left0 = await width(pg, "#dock-left")
    stage0 = await width(pg, "#stage")
    sep = pg.locator('#dock-left .dock-sep-col')
    check("left separator has ARIA", await sep.get_attribute("role") == "separator" and await sep.get_attribute("aria-orientation") == "vertical",
          f"now={await sep.get_attribute('aria-valuenow')} min={await sep.get_attribute('aria-valuemin')} max={await sep.get_attribute('aria-valuemax')}")
    await drag(pg, sep, 120, 0)
    left1 = await width(pg, "#dock-left")
    stage1 = await width(pg, "#stage")
    check("drag widens the left column", abs(left1 - (left0 + 120)) <= 2, f"{left0} -> {left1}")
    check("viewer shrinks to match", abs((stage0 - stage1) - (left1 - left0)) <= 3, f"stage {stage0} -> {stage1}")
    # Keyboard
    await sep.focus()
    await pg.keyboard.press("ArrowLeft")
    left2 = await width(pg, "#dock-left")
    check("arrow key narrows by 10", abs(left2 - (left1 - 10)) <= 1, f"{left1} -> {left2}")
    focused = await pg.evaluate("document.activeElement?.dataset?.sep")
    check("separator keeps focus after a step", focused == "col-left", str(focused))
    await pg.keyboard.press("Shift+ArrowLeft")
    left3 = await width(pg, "#dock-left")
    check("Shift+arrow = 40", abs(left3 - (left2 - 40)) <= 1, f"{left2} -> {left3}")
    # Max limit
    await drag(pg, pg.locator('#dock-left .dock-sep-col'), 900, 0)
    lmax = await width(pg, "#dock-left")
    check("max width respected", lmax <= 520, str(lmax))
    # Double click resets
    await pg.locator('#dock-left .dock-sep-col').dblclick()
    await pg.wait_for_timeout(250)
    check("double click resets width", abs(await width(pg, "#dock-left") - 264) <= 1, str(await width(pg, "#dock-left")))
    # Fold the right column by dragging far
    await drag(pg, pg.locator('#dock-right .dock-sep-col'), 400, 0)
    rfold = await width(pg, "#dock-right")
    check("dragging far folds the column", rfold <= 30 and await pg.locator('#dock-right .dock-unfold').count() == 1, str(rfold))
    await pg.screenshot(path=str(OUT / "paneles-escritorio-plegado.png"))
    await pg.locator('#dock-right .dock-unfold').click()
    await pg.wait_for_timeout(250)
    check("unfold button restores it", abs(await width(pg, "#dock-right") - 272) <= 1, str(await width(pg, "#dock-right")))
    # Block separator in the right column
    bs = pg.locator('#dock-right .dock-sep-block')
    h0 = await pg.evaluate("document.querySelector('#dock-right .dock-block').getBoundingClientRect().height")
    await drag(pg, bs, 0, 90)
    h1 = await pg.evaluate("document.querySelector('#dock-right .dock-block').getBoundingClientRect().height")
    check("block separator moves the split", abs((h1 - h0) - 90) <= 4, f"{h0:.0f} -> {h1:.0f}")
    # Fold a block with its button
    await pg.locator('#dock-left .dock-block').nth(1).locator('.dock-fold').click()
    await pg.wait_for_timeout(250)
    folded = await pg.evaluate("document.querySelectorAll('#dock-left .dock-block')[1].getBoundingClientRect().height")
    check("fold button folds a block to its header", folded < 40, f"{folded:.0f}px")
    # Widen the left one again, then reload: kept
    await drag(pg, pg.locator('#dock-left .dock-sep-col'), 60, 0)
    before = await width(pg, "#dock-left")
    await pg.wait_for_timeout(500)  # debounced save
    await pg.reload()
    await pg.wait_for_function("!!window.__glitch")
    await pg.wait_for_timeout(500)
    after = await width(pg, "#dock-left")
    folded2 = await pg.evaluate("document.querySelectorAll('#dock-left .dock-block')[1].classList.contains('collapsed')")
    check("layout survives a reload", abs(after - before) <= 1 and folded2, f"{before} -> {after}, folded={folded2}")
    await pg.screenshot(path=str(OUT / "paneles-escritorio.png"))
    # Garbage in storage -> default, no errors
    await pg.evaluate("localStorage.setItem('circuitek:layout', '{not json')")
    await pg.reload()
    await pg.wait_for_function("!!window.__glitch")
    check("garbage in storage gives the default", abs(await width(pg, "#dock-left") - 264) <= 1)
    # Reset from the Ventana menu
    await drag(pg, pg.locator('#dock-left .dock-sep-col'), 80, 0)
    await pg.locator('.menu-title', has_text="Ventana").click()
    await pg.locator('[role=menuitem]', has_text="Restablecer diseño").click()
    await pg.wait_for_timeout(300)
    check("Ventana > Restablecer diseño", abs(await width(pg, "#dock-left") - 264) <= 1, str(await width(pg, "#dock-left")))
    check("no console errors (desktop)", not errors, "; ".join(errors)[:300])
    check("no external requests (desktop)", not external, "; ".join(external)[:300])
    await b.close()


async def phone(p):
    b = await p.chromium.launch(executable_path=CHROME, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    ctx = await b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=3)
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await pg.goto(URL)
    await pg.wait_for_function("!!window.__glitch")
    await pg.evaluate("window.__glitch.loadSample()")
    await pg.wait_for_timeout(500)
    await pg.locator('.dock-icon[data-panel="layers"]').tap()
    await pg.wait_for_timeout(400)
    sheet = pg.locator('.dock-sheet')
    bb = await sheet.bounding_box()
    area = await pg.evaluate("document.getElementById('dock-float').getBoundingClientRect().toJSON()")
    check("panel opens as a bottom sheet", bb and abs(bb["x"] - area["x"]) < 2 and abs((bb["y"] + bb["height"]) - (area["y"] + area["height"])) < 2 and abs(bb["width"] - area["width"]) < 2,
          f"sheet={bb} area={area['width']}x{area['height']}")
    grip = pg.locator('.dock-sheet-grip')
    gb = await grip.bounding_box()
    check("grab handle is a 40 px touch target", gb["height"] >= 40, str(gb["height"]))
    h0 = bb["height"]
    # Touch drag with pointer events (CDP touch)
    cdp = await ctx.new_cdp_session(pg)
    x, y = gb["x"] + gb["width"] / 2, gb["y"] + 10
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    for k in range(1, 11):
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y - 12 * k}]})
        await pg.wait_for_timeout(20)
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    await pg.wait_for_timeout(400)
    h1 = (await pg.locator('.dock-sheet').bounding_box())["height"]
    check("dragging the handle up makes the sheet taller (touch)", h1 - h0 > 80, f"{h0:.0f} -> {h1:.0f}")
    scroll = await pg.evaluate("document.scrollingElement.scrollTop")
    check("the page did not scroll", scroll == 0, str(scroll))
    await pg.screenshot(path=str(OUT / "paneles-movil.png"))
    check("no errors (phone)", not errors, "; ".join(errors)[:300])
    await b.close()


async def main():
    async with async_playwright() as p:
        await desktop(p)
        await phone(p)
    print(f"\n{sum(results)}/{len(results)} OK")

asyncio.run(main())
