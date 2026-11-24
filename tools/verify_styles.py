"""
Navegador (Chrome sin cabeza + Playwright) contra `npx vite preview --port 4173`.
Uso: python tools/verify_styles.py http://localhost:4173/ carpeta-de-capturas
(GLITCH_CHROME=/ruta/a/chrome si no lo encuentra.)
"""
"""Layer styles check. Usage: python fx_check.py URL OUTDIR"""
import asyncio, base64, io, sys, time
from pathlib import Path
from PIL import Image, ImageChops, ImageStat
from playwright.async_api import async_playwright

URL = sys.argv[1]
OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
import os, shutil
CHROME = next((p for p in [os.environ.get("GLITCH_CHROME"), r"C:\Program Files\Google\Chrome\Application\chrome.exe", "/usr/bin/google-chrome", shutil.which("google-chrome") or ""] if p and os.path.exists(p)), None)
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)


def img(b64):
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


async def text_row(pg):
    return pg.locator('.layer-row', has=pg.locator('.layer-name', has_text="T ·")).first


async def setup(pg):
    await pg.goto(URL)
    await pg.wait_for_function("!!window.__glitch")
    await pg.evaluate("window.__glitch.clearProjects()")
    await pg.evaluate("window.__glitch.loadSample()")
    await pg.evaluate("window.__glitch.setState({v:2,seed:1,effect:0,filter:50,cables:[],stages:{}})")
    await pg.evaluate("window.__glitch.addText()")
    await pg.wait_for_timeout(500)
    await pg.keyboard.press("Escape")
    await pg.wait_for_timeout(300)


async def hash_(pg):
    await pg.wait_for_timeout(350)
    return await pg.evaluate("window.__glitch.screenHash()")


async def desktop(p):
    b = await p.chromium.launch(executable_path=CHROME, args=ARGS)
    pg = await (await b.new_context(viewport={"width": 1400, "height": 900})).new_page()
    errors, external = [], []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
    pg.on("request", lambda r: not r.url.startswith(("http://localhost", "data:", "blob:")) and external.append(r.url))
    await setup(pg)
    base = await hash_(pg)
    h0 = await pg.evaluate("window.__glitch.historySize()")
    row = await text_row(pg)
    await row.locator('[data-row-act="style"]').click()
    await pg.wait_for_timeout(300)
    check("fx button opens «Estilo de capa»", await pg.locator('.win-style').is_visible())
    labels = {"dropShadow": "Sombra paralela", "outerGlow": "Resplandor exterior", "innerShadow": "Sombra interior", "innerGlow": "Resplandor interior"}
    prev = base
    for key, lab in labels.items():
        await pg.locator(f'.st-item input[aria-label="Activar {lab}"]').check()
        # Make each effect clearly visible
        await pg.locator('.st-settings .slider-row', has_text="Tamaño").locator('.sl-num').fill("20")
        await pg.locator('.st-settings .slider-row', has_text="Tamaño").locator('.sl-num').press("Enter")
        h = await hash_(pg)
        check(f"{lab} changes pixels", h != prev, f"{prev[:6]} -> {h[:6]}")
        prev = h
    # Noise determinism: same settings -> same pixels
    await pg.locator('.st-name', has_text="Resplandor exterior").click()
    await pg.locator('.st-settings .slider-row', has_text="Ruido").locator('.sl-num').fill("60")
    await pg.locator('.st-settings .slider-row', has_text="Ruido").locator('.sl-num').press("Enter")
    n1 = await hash_(pg)
    await pg.locator('.st-settings .slider-row', has_text="Ruido").locator('.sl-num').fill("0")
    await pg.locator('.st-settings .slider-row', has_text="Ruido").locator('.sl-num').press("Enter")
    await hash_(pg)
    await pg.locator('.st-settings .slider-row', has_text="Ruido").locator('.sl-num').fill("60")
    await pg.locator('.st-settings .slider-row', has_text="Ruido").locator('.sl-num').press("Enter")
    n2 = await hash_(pg)
    check("noise is deterministic (same settings, same pixels)", n1 == n2 and n1 != prev, f"{n1[:8]} / {n2[:8]}")
    await pg.screenshot(path=str(OUT / "estilo-dialogo.png"))
    await pg.locator('.st-ok').click()
    await pg.wait_for_timeout(300)
    h1 = await pg.evaluate("window.__glitch.historySize()")
    check("Aceptar = one undo step for the whole visit", h1 - h0 == 1, f"{h0} -> {h1}")
    # Effects list under the layer
    row = await text_row(pg)
    items = await row.locator('.layer-fx-item').count()
    check("effects listed under the layer", items == 4, str(items))
    await pg.screenshot(path=str(OUT / "estilo-lista-capas.png"))
    with_fx = await hash_(pg)
    await row.locator('[data-row-act="fx-eye"][data-fx="dropShadow"]').click()
    hid = await hash_(pg)
    d = await pg.evaluate("window.__glitch.getDoc()")
    st = [l for l in d["layers"] if l.get("text")][-1]["style"]
    check("eye hides one effect (kept in the style)", hid != with_fx and st["dropShadow"]["hidden"] and st["dropShadow"]["on"])
    row = await text_row(pg)
    await row.locator('[data-row-act="fx-eye"][data-fx="dropShadow"]').click()
    back = await hash_(pg)
    check("eye shows it again (same pixels as before)", back == with_fx)
    row = await text_row(pg)
    await row.locator('[data-row-act="fx-all"]').click()
    off = await hash_(pg)
    check("«Efectos» eye hides all of them (= no style)", off == base, f"{off[:8]} vs base {base[:8]}")
    row = await text_row(pg)
    await row.locator('[data-row-act="fx-all"]').click()
    await hash_(pg)
    # Cancel restores
    hb = await pg.evaluate("window.__glitch.historySize()")
    before = await hash_(pg)
    row = await text_row(pg)
    nb = await row.locator('.layer-name').bounding_box()
    rb = await row.bounding_box()
    await pg.mouse.dblclick(nb["x"] + nb["width"] + 12, rb["y"] + 10)  # on the row, beside the name
    await pg.wait_for_timeout(300)
    opened = await pg.locator('.win-style').is_visible()
    await pg.locator('.st-item input[aria-label="Activar Sombra paralela"]').uncheck()
    await hash_(pg)
    await pg.locator('.st-cancel').click()
    after = await hash_(pg)
    ha = await pg.evaluate("window.__glitch.historySize()")
    check("double click on the row opens the dialog", opened)
    check("Cancelar puts everything back, no undo step", after == before and ha == hb, f"hist {hb}->{ha}")
    # Undo of the whole style
    await pg.keyboard.press("Control+z")
    u = await hash_(pg)
    await pg.keyboard.press("Control+Shift+z")
    r = await hash_(pg)
    check("Ctrl+Z / Ctrl+Shift+Z undo / redo the style", u != before and r == before)
    # Global light shared between layers
    await pg.evaluate("""async () => { const d = window.__glitch.getDoc();
      for (const l of d.layers) l.style = { enabled: true, dropShadow: { on: true, useGlobal: true, distance: 20, size: 4 } };
      await window.__glitch.openDoc(d); }""")
    await pg.wait_for_timeout(300)
    img_row = pg.locator('.layer-row', has=pg.locator('.layer-name', has_text="Carta")).first
    await img_row.locator('[data-row-act="style"]').click()
    await pg.wait_for_timeout(200)
    await pg.locator('.st-name', has_text="Sombra paralela").click()
    ang = pg.locator('.st-settings .slider-row', has_text="Ángulo").locator('.sl-num')
    await ang.fill("30")
    await ang.press("Enter")
    await pg.locator('.st-ok').click()
    await pg.wait_for_timeout(300)
    d = await pg.evaluate("window.__glitch.getDoc()")
    check("global light: one angle for every layer that uses it", d.get("light", {}).get("angle") == 30 and all(l["style"]["dropShadow"]["useGlobal"] for l in d["layers"]), str(d.get("light")))
    # Preview vs export at the preview size: same pixels
    view = await pg.evaluate("window.__glitch.view()")
    pw = view["preview"][0]
    prev_px = await pg.evaluate("window.__glitch.pixels()")
    pv = Image.frombytes("RGBA", tuple(view["preview"]), base64.b64decode(prev_px)).convert("RGB")
    ex = img(await pg.evaluate(f"window.__glitch.exportPng({pw / d['w']})"))
    diff = ImageChops.difference(pv, ex)
    check("preview = export (same size, same pixels)", ex.size == pv.size and diff.getbbox() is None, f"size {ex.size} vs {pv.size}, max diff {max(diff.getextrema(), key=lambda x: x[1])[1] if ex.size == pv.size else '-'}")
    # Full-resolution export scales the effects: downscaled, it looks like the preview
    full = img(await pg.evaluate("window.__glitch.exportPng(1)")).resize(pv.size, Image.LANCZOS)
    mean = sum(ImageStat.Stat(ImageChops.difference(pv, full)).mean) / 3
    check("full-resolution export looks like the preview (effects scaled)", mean < 6, f"mean abs diff {mean:.2f} / 255")
    # Copy / paste style carries the layer style
    await pg.evaluate("""async () => { const d = window.__glitch.getDoc(); for (const l of d.layers) delete l.style; d.layers[1].style = { enabled: true, outerGlow: { on: true, size: 30 } }; d.active = d.layers[1].id; await window.__glitch.openDoc(d); }""")
    await pg.wait_for_timeout(300)
    await pg.keyboard.press("Control+Alt+c")
    d = await pg.evaluate("window.__glitch.getDoc()")
    await pg.evaluate(f"""async () => {{ const d = window.__glitch.getDoc(); d.active = d.layers[0].id; await window.__glitch.openDoc(d); }}""")
    await pg.wait_for_timeout(200)
    await pg.keyboard.press("Control+Alt+v")
    await pg.wait_for_timeout(300)
    d = await pg.evaluate("window.__glitch.getDoc()")
    check("copy / paste style includes the layer style", d["layers"][0].get("style", {}).get("outerGlow", {}).get("on") is True)
    # Persistence: reload keeps the style
    await pg.evaluate("window.__glitch.session().flush()")
    await pg.wait_for_timeout(500)
    await pg.reload()
    await pg.wait_for_function("!!window.__glitch")
    await pg.wait_for_timeout(1500)
    d = await pg.evaluate("window.__glitch.getDoc()")
    check("styles survive a reload (session)", d["layers"] and d["layers"][0].get("style", {}).get("outerGlow", {}).get("on") is True)
    # Performance: 3 layers with styles while the effects animation plays
    await pg.evaluate("""async () => { const d = window.__glitch.getDoc(); await window.__glitch.openDoc(d); }""")
    await pg.evaluate("window.__glitch.addSampleLayer(500, 400)")
    await pg.evaluate("window.__glitch.addSampleLayer(400, 300)")
    await pg.wait_for_timeout(500)

    async def fps(style_on):
        await pg.evaluate(f"""async () => {{ const d = window.__glitch.getDoc(); for (const l of d.layers) {{
            l.fx = Object.assign(l.fx || {{}}, {{ motion: {{ mode: 'flicker', intensity: 50, speed: 50, targets: {{ effect: true, filter: true, cables: false, stages: false }}, seconds: 3, fps: 20 }} }});
            if ({str(style_on).lower()}) l.style = {{ enabled: true, dropShadow: {{ on: true, size: 12, distance: 10 }}, outerGlow: {{ on: true, size: 16 }}, innerShadow: {{ on: true, size: 6 }} }}; else delete l.style; }}
            await window.__glitch.openDoc(d); }}""")
        # Wait until the styles are built and on screen (first frame), then measure steady frames.
        await pg.evaluate("""async () => { const g = window.__glitch; g.anim.show(0); const p0 = g.presents();
            await new Promise((r) => { const f = () => g.presents() > p0 ? r() : requestAnimationFrame(f); f(); }); }""")
        await pg.wait_for_timeout(300)
        await pg.evaluate("window.__glitch.anim.play()")
        p0 = await pg.evaluate("window.__glitch.presents()")
        t0 = time.time()
        await pg.wait_for_timeout(3000)
        p1 = await pg.evaluate("window.__glitch.presents()")
        dt = time.time() - t0
        await pg.evaluate("window.__glitch.anim.stop()")
        await pg.wait_for_timeout(300)
        return (p1 - p0) / dt
    f0 = await fps(False)
    b0 = (await pg.evaluate("window.__glitch.anim.state()"))["fx"]["builds"]
    f1 = await fps(True)
    b1 = (await pg.evaluate("window.__glitch.anim.state()"))["fx"]["builds"]
    nl = len((await pg.evaluate("window.__glitch.getDoc()"))["layers"])
    check("animation frames reuse the effects (built once per layer, not per frame)", b1 - b0 <= nl, f"{b1 - b0} builds for {nl} layers, including the first build")
    print(f"INFO animation fps (SwiftShader / CPU, not a GPU measure): {f0:.1f} without styles, {f1:.1f} with styles")
    mem = await pg.evaluate("window.__glitch.gpuMemory()")
    print("   gpu memory (MB):", {k: round(v / 1e6, 1) for k, v in mem.items()})
    check("no console errors", not errors, "; ".join(errors)[:300])
    check("no network requests", not external, "; ".join(external)[:200])
    await b.close()


async def phone(p):
    b = await p.chromium.launch(executable_path=CHROME, args=ARGS)
    ctx = await b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await setup(pg)
    base = await hash_(pg)
    await pg.locator('.dock-icon[data-panel="layers"]').tap()
    await pg.wait_for_timeout(400)
    row = await text_row(pg)
    btn = row.locator('[data-row-act="style"]')
    bb = await btn.bounding_box()
    check("phone: fx button is a touch target", bb["width"] >= 40 and bb["height"] >= 40, f"{bb['width']}x{bb['height']}")
    await btn.tap()
    await pg.wait_for_timeout(400)
    win = await pg.locator('.win-style').bounding_box()
    check("phone: dialog is a bottom sheet", win and abs(win["y"] + win["height"] - 844) < 2 and win["width"] >= 388, str(win))
    await pg.locator('.st-item input[aria-label="Activar Resplandor exterior"]').tap()
    await pg.locator('.st-ok').tap()
    await pg.wait_for_timeout(500)
    await pg.locator('.dock-float-close').tap()
    h = await hash_(pg)
    check("phone: effect applied by touch", h != base)
    await pg.locator('.dock-icon[data-panel="layers"]').tap()
    await pg.wait_for_timeout(300)
    await pg.screenshot(path=str(OUT / "estilo-movil-lista.png"))
    row = await text_row(pg)
    await row.locator('[data-row-act="style"]').tap()
    await pg.wait_for_timeout(300)
    await pg.screenshot(path=str(OUT / "estilo-movil-dialogo.png"))
    check("phone: no errors", not errors, "; ".join(errors)[:300])
    await b.close()


async def main():
    async with async_playwright() as p:
        await desktop(p)
        await phone(p)
    print(f"\n{sum(results)}/{len(results)} OK")

asyncio.run(main())
