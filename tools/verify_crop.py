"""
Navegador (Chrome sin cabeza + Playwright) contra `npx vite preview --port 4173`.
Uso: python tools/verify_crop.py http://localhost:4173/ carpeta-de-capturas
(GLITCH_CHROME=/ruta/a/chrome si no lo encuentra.)
"""
"""Crop tool check. Usage: python crop_check.py URL OUTDIR"""
import asyncio, base64, io, sys
from pathlib import Path
from PIL import Image, ImageChops
from playwright.async_api import async_playwright

URL = sys.argv[1]
OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
import os, shutil
CHROME = next((p for p in [os.environ.get("GLITCH_CHROME"), r"C:\Program Files\Google\Chrome\Application\chrome.exe", "/usr/bin/google-chrome", shutil.which("google-chrome") or ""] if p and os.path.exists(p)), None)
results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)


async def png(pg, scale=1):
    b64 = await pg.evaluate(f"window.__glitch.exportPng({scale})")
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGBA")


async def setup(pg):
    await pg.goto(URL)
    await pg.wait_for_function("!!window.__glitch")
    await pg.evaluate("window.__glitch.clearProjects()")
    await pg.evaluate("window.__glitch.loadSample()")
    # A glitch with a pattern that depends on the line position (to see that cropping does not move it).
    await pg.evaluate("window.__glitch.setState({v:2,seed:7,effect:80,filter:40,cables:[{a:'RG',b:'HCLK',amount:100},{a:'OD',b:'HCLK',amount:80}],stages:{buffer:{on:true,p:{stride:6,repeat:30,echo:0}}}})")
    await pg.wait_for_timeout(800)


async def drag(pg, x0, y0, x1, y1, steps=10):
    await pg.mouse.move(x0, y0)
    await pg.mouse.down()
    await pg.mouse.move(x1, y1, steps=steps)
    await pg.mouse.up()
    await pg.wait_for_timeout(150)


async def desktop(p):
    b = await p.chromium.launch(executable_path=CHROME, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = await (await b.new_context(viewport={"width": 1400, "height": 900})).new_page()
    errors, external = [], []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
    pg.on("request", lambda r: not r.url.startswith(("http://localhost", "data:", "blob:")) and external.append(r.url))
    await setup(pg)
    full = await png(pg)
    check("full export", full.size == (1600, 1200), str(full.size))
    h0 = await pg.evaluate("window.__glitch.historySize()")
    await pg.locator("#stage").click(position={"x": 5, "y": 5})  # focus the page (deselects)
    await pg.keyboard.press("c")
    await pg.wait_for_timeout(300)
    check("C opens the tool", await pg.locator(".crop-ui").is_visible() and await pg.locator(".crop-bar").is_visible())
    box = await pg.locator(".crop-box").bounding_box()
    # Draw a new rectangle: from 25 % to 75 % of the canvas on screen (starting outside the current one is impossible: it covers the canvas,
    # so first shrink it with the SE handle, then draw a new one outside it).
    se = pg.locator(".crop-h-se")
    sb = await se.bounding_box()
    await drag(pg, sb["x"] + 22, sb["y"] + 22, box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
    r1 = await pg.locator(".crop-box").bounding_box()
    check("SE handle resizes", abs(r1["width"] - box["width"] * 0.5) < 6, f"{box['width']:.0f} -> {r1['width']:.0f}")
    await drag(pg, box["x"] + box["width"] * 0.6, box["y"] + box["height"] * 0.6, box["x"] + box["width"] * 0.95, box["y"] + box["height"] * 0.9)
    r2 = await pg.locator(".crop-box").bounding_box()
    check("drag outside draws a new rectangle", abs(r2["x"] - (box["x"] + box["width"] * 0.6)) < 4, f"x={r2['x']:.0f}")
    await drag(pg, r2["x"] + r2["width"] / 2, r2["y"] + r2["height"] / 2, r2["x"] + r2["width"] / 2 - 100, r2["y"] + r2["height"] / 2 - 50)
    r3 = await pg.locator(".crop-box").bounding_box()
    check("drag inside moves it", abs(r3["x"] - (r2["x"] - 100)) < 3 and abs(r3["width"] - r2["width"]) < 1, f"x {r2['x']:.0f} -> {r3['x']:.0f}")
    # Aspect 1:1
    await pg.select_option(".crop-aspect", "1:1")
    await pg.wait_for_timeout(100)
    r4 = await pg.locator(".crop-box").bounding_box()
    check("1:1 preset", abs(r4["width"] - r4["height"]) < 2, f"{r4['width']:.0f}x{r4['height']:.0f}")
    # Arrows move by 1 / 10 doc px
    await pg.locator(".crop-box").focus()
    before = await pg.locator(".crop-pw").input_value()
    await pg.keyboard.press("Shift+ArrowRight")
    r5 = await pg.locator(".crop-box").bounding_box()
    zoom = (await pg.evaluate("window.__glitch.view()"))["zoom"]
    check("Shift+arrow moves 10 px", abs((r5["x"] - r4["x"]) - 10 * zoom) < 1.5, f"{r5['x'] - r4['x']:.2f} vs {10 * zoom:.2f}")
    await pg.screenshot(path=str(OUT / "recorte-en-curso.png"))
    # Typed size
    await pg.select_option(".crop-aspect", "free")
    await pg.fill(".crop-pw", "640")
    await pg.fill(".crop-ph", "360")
    await pg.locator(".crop-ph").press("Tab")
    w = await pg.locator(".crop-pw").input_value()
    h = await pg.locator(".crop-ph").input_value()
    check("typed width / height", (w, h) == ("640", "360"), f"{w}x{h}")
    # Enter applies: ONE history step
    await pg.locator(".crop-box").focus()
    await pg.keyboard.press("Enter")
    await pg.wait_for_timeout(500)
    d = await pg.evaluate("window.__glitch.getDoc()")
    h1 = await pg.evaluate("window.__glitch.historySize()")
    check("Enter applies the crop (normalised in the document)", d.get("crop") and abs(d["crop"]["w"] * 1600 - 640) < 1 and abs(d["crop"]["h"] * 1200 - 360) < 1, str(d.get("crop")))
    check("one undo step per applied crop", h1 - h0 == 1, f"{h0} -> {h1}")
    check("tool closed", not await pg.locator(".crop-ui").is_visible())
    await pg.wait_for_timeout(400)
    await pg.screenshot(path=str(OUT / "recorte-aplicado.png"))
    # Export = the crop, and the SAME pixels as that region of the uncropped export (glitch pattern unchanged)
    cropped = await png(pg)
    cx, cy = round(d["crop"]["x"] * 1600), round(d["crop"]["y"] * 1200)
    region = full.crop((cx, cy, cx + cropped.size[0], cy + cropped.size[1]))
    diff = ImageChops.difference(region, cropped).getbbox()
    check("PNG export has the crop's size", cropped.size == (640, 360), str(cropped.size))
    check("cropped export = same pixels as the full export (pattern unchanged)", diff is None, f"diff bbox={diff}")
    # GIF / MP4 dialog sizes follow the crop
    await pg.locator('.menu-title', has_text="Archivo").click()
    await pg.locator('[role=menuitem]', has_text="Exportar como").click()
    await pg.locator('[role=menuitem]', has_text="GIF").click()
    await pg.wait_for_timeout(500)
    note = await pg.locator(".ex-note, [class*=ex-note]").first.text_content()
    check("GIF plan uses the crop (480 wide, 16:9)", "480×270" in (note or ""), (note or "")[:80])
    await pg.keyboard.press("Escape")
    await pg.wait_for_timeout(200)
    # Esc cancels without changes
    await pg.keyboard.press("c")
    await pg.wait_for_timeout(200)
    box = await pg.locator(".crop-box").bounding_box()
    await drag(pg, box["x"] + 30, box["y"] + 30, box["x"] + 80, box["y"] + 60)
    await pg.keyboard.press("Escape")
    await pg.wait_for_timeout(200)
    d2 = await pg.evaluate("window.__glitch.getDoc()")
    check("Esc cancels (crop unchanged)", d2.get("crop") == d["crop"] and not await pg.locator(".crop-ui").is_visible())
    # Undo removes the crop
    await pg.keyboard.press("Control+z")
    await pg.wait_for_timeout(300)
    check("Ctrl+Z undoes the crop", not (await pg.evaluate("window.__glitch.getDoc()")).get("crop"))
    await pg.keyboard.press("Control+Shift+z")
    await pg.wait_for_timeout(300)
    # Reopen shows the whole canvas with the current crop; Restablecer + ✓ removes it
    await pg.keyboard.press("c")
    await pg.wait_for_timeout(200)
    pw = await pg.locator(".crop-pw").input_value()
    check("reopening shows the current crop", pw == "640", pw)
    await pg.locator(".crop-reset").click()
    await pg.locator(".crop-ok").click()
    await pg.wait_for_timeout(300)
    check("Restablecer + ✓ removes the crop", not (await pg.evaluate("window.__glitch.getDoc()")).get("crop"))
    # Delete cropped pixels
    await pg.keyboard.press("c")
    await pg.fill(".crop-pw", "800")
    await pg.locator(".crop-pw").press("Tab")
    await pg.check(".crop-discard")
    await pg.locator(".crop-ok").click()
    await pg.wait_for_timeout(300)
    d3 = await pg.evaluate("window.__glitch.getDoc()")
    check("'eliminar píxeles' crops the canvas itself", d3["w"] == 800 and not d3.get("crop"), f"{d3['w']}x{d3['h']}")
    await pg.keyboard.press("Control+z")
    await pg.wait_for_timeout(300)
    check("...and Ctrl+Z gives the canvas back", (await pg.evaluate("window.__glitch.getDoc()"))["w"] == 1600)
    check("no console errors", not errors, "; ".join(errors)[:300])
    check("no external requests", not external, "; ".join(external)[:200])
    await b.close()


async def phone(p):
    b = await p.chromium.launch(executable_path=CHROME, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    ctx = await b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await setup(pg)
    await pg.locator('.menu-title', has_text="Imagen").tap()
    await pg.locator('[role=menuitem]', has_text="Recortar…").tap()
    await pg.wait_for_timeout(400)
    check("phone: tool opens from Imagen ▸ Recortar…", await pg.locator(".crop-ui").is_visible())
    hb = await pg.locator(".crop-h-ne").bounding_box()
    check("phone: handles have a 44 px grab area", hb["width"] >= 44 and hb["height"] >= 44, f"{hb['width']}x{hb['height']}")
    box = await pg.locator(".crop-box").bounding_box()
    cdp = await ctx.new_cdp_session(pg)
    x, y = hb["x"] + 22, hb["y"] + 22
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    for k in range(1, 9):
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x - 10 * k, "y": y + 8 * k}]})
        await pg.wait_for_timeout(20)
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    await pg.wait_for_timeout(200)
    b2 = await pg.locator(".crop-box").bounding_box()
    check("phone: touch drag on a handle resizes", b2["width"] < box["width"] - 50 and b2["height"] < box["height"] - 40, f"{box['width']:.0f}x{box['height']:.0f} -> {b2['width']:.0f}x{b2['height']:.0f}")
    check("phone: page did not scroll", await pg.evaluate("document.scrollingElement.scrollTop") == 0)
    await pg.screenshot(path=str(OUT / "recorte-movil.png"))
    await pg.locator(".crop-ok").tap()
    await pg.wait_for_timeout(300)
    check("phone: ✓ applies", bool((await pg.evaluate("window.__glitch.getDoc()")).get("crop")))
    check("phone: no errors", not errors, "; ".join(errors)[:300])
    await b.close()


async def main():
    async with async_playwright() as p:
        await desktop(p)
        await phone(p)
    print(f"\n{sum(results)}/{len(results)} OK")

asyncio.run(main())
