"""
Animated still image ("Glitch animado" + ▶/■) checks, mobile 390 px with touch. Run by
verify.py; standalone:

    python tools/verify_anim.py [url] [outdir]
"""
import asyncio, base64, io, json, sys
from pathlib import Path
from PIL import Image

async def grab(pg):
    url = await pg.evaluate("document.getElementById('screen').toDataURL('image/png')")
    return Image.open(io.BytesIO(base64.b64decode(url.split(",")[1]))).convert("RGB")

def mad(a, b):
    a = a.resize((160, 120)); b = b.resize((160, 120))
    pa, pb = a.tobytes(), b.tobytes()
    return sum(abs(x - y) for x, y in zip(pa, pb)) / len(pa)

async def settle(pg, ms=300):
    await pg.wait_for_timeout(ms)
    for _ in range(80):
        if not await pg.evaluate("document.getElementById('busy').classList.contains('on')"):
            break
        await pg.wait_for_timeout(50)

async def st(pg):
    return await pg.evaluate("window.__glitch.anim.state()")

async def run(browser, url, out: Path, check, mobile=True):
    errors = []
    vp = {"width": 390, "height": 844} if mobile else {"width": 1400, "height": 1000}
    ctx = await browser.new_context(viewport=vp, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile)
    pg = await ctx.new_page()
    pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    await pg.goto(url)
    await pg.wait_for_load_state("networkidle")
    await pg.evaluate("window.__glitch.loadSample()")
    await settle(pg, 600)
    check("imagen fija sin «Glitch animado»: sin barra de reproducción", await pg.locator("#media-bar").is_hidden())
    base_hash = await pg.evaluate("window.__glitch.screenHash()")

    # turn on «Glitch animado» from the Efectos tab (touch)
    if mobile:
        await pg.tap("#btn-rack"); await pg.wait_for_timeout(400)
    await pg.locator("#tab-fx").tap() if mobile else await pg.click("#tab-fx")
    await pg.locator(".fx-anim-row .switch-track").tap() if mobile else await pg.click(".fx-anim-row .switch-track")
    if mobile:
        await pg.tap("#btn-rack"); await pg.wait_for_timeout(400)
    await settle(pg)
    s0 = await st(pg)
    hist0 = await pg.evaluate("window.__glitch.historySize()")
    visible = await pg.locator("#media-bar").is_visible()
    label = await pg.get_attribute("#mb-play", "aria-label")
    check("con «Glitch animado»: aparece ▶ junto a la vista previa, parado (■ por defecto, no arranca solo)",
          visible and label == "Reproducir" and s0["current"] is None and not s0["playing"], json.dumps({"label": label, **{k: s0[k] for k in ("current", "playing")}}))
    check("parado = estado base: la imagen no cambia al activar el interruptor", await pg.evaluate("window.__glitch.screenHash()") == base_hash)

    # ▶ : plays, the image changes between frames
    await pg.locator("#mb-play").tap() if mobile else await pg.click("#mb-play")
    await pg.wait_for_timeout(700)
    a = await grab(pg)
    await pg.wait_for_timeout(500)
    b = await grab(pg)
    s1 = await st(pg)
    await pg.screenshot(path=str(out / ("50-anim-movil.png" if mobile else "51-anim-escritorio.png")))
    check("▶ anima: el estado cambia y la imagen cambia entre fotogramas", s1["playing"] and s1["current"] is not None and mad(a, b) > 1,
          f"fotograma {s1['current']} · diferencia {mad(a, b):.1f} · pintados {s1['painted']} · descartados {s1['dropped']}")
    check("▶ pasa a ■ (Parar)", await pg.get_attribute("#mb-play", "aria-label") == "Parar (vuelve al estado base)")
    # real preview fps over 2 s
    p0 = await pg.evaluate("[window.__glitch.presents(), window.__glitch.anim.state().painted, performance.now()]")
    await pg.wait_for_timeout(2000)
    p1 = await pg.evaluate("[window.__glitch.presents(), window.__glitch.anim.state().painted, performance.now()]")
    dt = (p1[2] - p0[2]) / 1000
    fps = (p1[0] - p0[0]) / dt
    check("vista previa animada: fps reales medidos", fps > 0, f"{fps:.1f} renders/s (objetivo {s1['fps']} fps)")
    hist1 = await pg.evaluate("window.__glitch.historySize()")
    check("nada de la animación entra en el historial de deshacer", hist1 == hist0, f"{hist0} → {hist1}")

    # ■ : back to the base state
    await pg.locator("#mb-play").tap() if mobile else await pg.click("#mb-play")
    await settle(pg)
    s2 = await st(pg)
    check("■ para y vuelve al estado base (píxeles idénticos al original)", not s2["playing"] and s2["current"] is None and await pg.evaluate("window.__glitch.screenHash()") == base_hash)
    check("el historial no crece tras ▶/■", await pg.evaluate("window.__glitch.historySize()") == hist0)

    # editor frame N == exported frame N, pixel for pixel
    for n in (0, 7, 33):
        await pg.evaluate(f"window.__glitch.anim.show({n})")
        await settle(pg, 400)
        screen = await pg.evaluate("window.__glitch.screenHash()")
        export = await pg.evaluate(f"window.__glitch.exportFrameHash({n})")
        check(f"fotograma {n}: el lienzo del editor coincide píxel a píxel con el fotograma {n} exportado", screen == export, f"{screen} / {export}")
    await pg.evaluate("window.__glitch.anim.stop()")

    # Space toggles (focus not in a text field)
    await pg.locator(".rw-mini .rw-side-title").click()
    await pg.keyboard.press(" "); await pg.wait_for_timeout(300)
    on = (await st(pg))["playing"]
    await pg.keyboard.press(" "); await pg.wait_for_timeout(300)
    off = await st(pg)
    check("Espacio = ▶/■ con la animación", on and not off["playing"] and off["current"] is None)

    # encoder stage on during the animation: it runs at its own pace, the animation never blocks
    st0 = await pg.evaluate("window.__glitch.getState()")
    await pg.evaluate("s => window.__glitch.setState(s)", {**st0, "stages": {"enc": {"on": True, "p": {"jpg": 60, "sort": 30}}}})
    await settle(pg, 800)
    e0 = (await st(pg))["enc"]
    await pg.evaluate("window.__glitch.anim.play()")
    await pg.wait_for_timeout(1500)
    a = await grab(pg)
    s_a = await st(pg)
    await pg.wait_for_timeout(1500)
    b = await grab(pg)
    s_b = await st(pg)
    note = await pg.evaluate("document.getElementById('mb-note').hidden ? '' : document.getElementById('mb-note').textContent")
    enc_n = s_b["enc"]["n"] - e0["n"]
    enc_ms = (s_b["enc"]["ms"] - e0["ms"]) / max(1, enc_n)
    check("con JPEG/sort: la animación sigue (no se bloquea), el codificador va a su ritmo y la imagen cambia",
          s_b["painted"] > s_a["painted"] and enc_n >= 2 and mad(a, b) > 1 and "A SU RITMO" in note,
          f"codificados {enc_n} en 3 s · {enc_ms:.0f} ms por fotograma codificado · aviso «{note}»")
    await pg.evaluate("window.__glitch.anim.stop()")
    await ctx.close()

    # prefers-reduced-motion: warns and does not start
    ctx = await browser.new_context(viewport=vp, reduced_motion="reduce", is_mobile=mobile, has_touch=mobile)
    pg = await ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    await pg.goto(url); await pg.wait_for_load_state("networkidle")
    await pg.evaluate("window.__glitch.loadSample()"); await settle(pg)
    await pg.evaluate("""(() => { const d = window.__glitch.getDoc(); d.layers[0].animate = true; window.__glitch.setDoc(d); })()""")
    await settle(pg)
    await pg.evaluate("document.getElementById('mb-play').click()"); await pg.wait_for_timeout(300)
    s = await st(pg)
    toast = await pg.text_content("#toast")
    check("prefers-reduced-motion: ▶ avisa y no arranca", not s["playing"] and "reducir el movimiento" in toast, toast)
    await ctx.close()
    check("animación: sin errores en consola", not errors, " | ".join(errors[:5]))

async def run_motion(browser, url, out: Path, check):
    """Modo Movimiento: knobs that move, base untouched, preview == export, GIF loop."""
    sys.path.insert(0, str(Path(__file__).parent))
    from verify_export import parse_gif, gif_frames, seam
    errors = []
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
    pg = await ctx.new_page()
    pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    await pg.goto(url); await pg.wait_for_load_state("networkidle")
    await pg.evaluate("window.__glitch.loadSample()"); await settle(pg, 600)
    await pg.tap("#btn-rack"); await pg.wait_for_timeout(400)
    await pg.locator("#tab-fx").tap()
    await pg.locator(".fx-anim-row .switch-track").tap(); await pg.wait_for_timeout(300)
    check("«Glitch animado» muestra el panel Movimiento (Parpadeo por defecto)", await pg.locator("#motion-box").is_visible() and await pg.eval_on_selector("#mo-mode", "e => e.value") == "flicker")
    await pg.select_option("#mo-mode", "drift"); await pg.wait_for_timeout(200)
    await pg.screenshot(path=str(out / "52-movimiento-panel-movil.png"))
    await pg.tap("#btn-rack"); await pg.wait_for_timeout(400)
    base = await pg.evaluate("window.__glitch.getState()")
    hist0 = await pg.evaluate("window.__glitch.historySize()")

    for mode in ("drift", "jumps"):
        await pg.evaluate(f"(() => {{ const s = window.__glitch.getState(); s.motion.mode = '{mode}'; s.motion.targets.cables = true; window.__glitch.setState(s); }})()")
        await settle(pg)
        for n in (5, 41):
            await pg.evaluate(f"window.__glitch.anim.show({n})"); await settle(pg, 400)
            screen = await pg.evaluate("window.__glitch.screenHash()")
            export = await pg.evaluate(f"window.__glitch.exportFrameHash({n})")
            check(f"{mode}: fotograma {n} del editor = fotograma {n} exportado (píxel a píxel)", screen == export, f"{screen} / {export}")
        await pg.evaluate("window.__glitch.anim.stop()")
    await pg.evaluate("(() => { const s = window.__glitch.getState(); s.motion.mode = 'drift'; window.__glitch.setState(s); })()")
    await settle(pg)
    hist_a = await pg.evaluate("window.__glitch.historySize()")

    await pg.locator("#mb-play").tap()
    vals = []
    for _ in range(6):
        await pg.wait_for_timeout(350)
        vals.append(await pg.evaluate("[document.querySelector('#knob-effect .knob-value').textContent, document.querySelector('#knob-filter .knob-value').textContent]"))
    state_now = await pg.evaluate("window.__glitch.getState()")
    check("Deriva suave: los knobs EFFECT y FILTER giran solos mientras suena", len({v[0] for v in vals}) > 2 and len({v[1] for v in vals}) > 2, json.dumps(vals))
    check("la animación no toca el estado base ni el historial", state_now["effect"] == 50 and state_now["filter"] == 50 and await pg.evaluate("window.__glitch.historySize()") == hist_a)

    # the user turns EFFECT while it plays → new base, animation keeps going around it
    kb = await pg.locator("#knob-effect .knob-dial").bounding_box()
    await pg.mouse.move(kb["x"] + kb["width"] / 2, kb["y"] + kb["height"] / 2)
    await pg.mouse.down(); await pg.mouse.move(kb["x"] + kb["width"] / 2, kb["y"] - 70, steps=8); await pg.mouse.up()
    await pg.wait_for_timeout(300)
    new_base = (await pg.evaluate("window.__glitch.getState()"))["effect"]
    after = []
    for _ in range(5):
        await pg.wait_for_timeout(300)
        after.append(int(await pg.evaluate("document.querySelector('#knob-effect .knob-value').textContent")))
    playing = (await st(pg))["playing"]
    check("mover un knob durante ▶ cambia la base y la animación sigue alrededor de ella",
          new_base > 60 and playing and len(set(after)) > 1 and abs(sum(after) / len(after) - new_base) < 30,
          f"base {new_base} · valores mostrados {after}")
    check("solo el gesto del usuario entra en el historial (una entrada)", await pg.evaluate("window.__glitch.historySize()") == hist_a + 1)
    await pg.locator("#mb-play").tap(); await settle(pg)
    shown = await pg.evaluate("document.querySelector('#knob-effect .knob-value').textContent")
    check("■ vuelve al estado base: el knob muestra su valor base", int(shown) == new_base, f"{shown} / {new_base}")
    await pg.screenshot(path=str(out / "53-movimiento-movil.png"))
    await ctx.close()

    # GIF export with the motion loop (desktop: downloads)
    ctx = await browser.new_context(viewport={"width": 1400, "height": 1000}, accept_downloads=True)
    pg = await ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    await pg.goto(url); await pg.wait_for_load_state("networkidle")
    await pg.evaluate("window.__glitch.loadSample()"); await settle(pg)
    await pg.evaluate("""(() => { const d = window.__glitch.getDoc(); d.layers[0].animate = true; window.__glitch.setDoc(d);
        const s = window.__glitch.getState(); s.motion = { ...s.motion, mode: 'drift', intensity: 70, speed: 60, seconds: 2, fps: 20 }; window.__glitch.setState(s); })()""")
    await settle(pg)
    await pg.click("#btn-export-menu"); await pg.locator(".ctx-menu .ctx-item", has_text="GIF").first.click()
    await pg.wait_for_selector(".export-sheet")
    await pg.locator("#ex-gw").fill("320"); await pg.locator("#ex-gw").dispatch_event("change")
    note = await pg.text_content("#ex-note")
    dur = await pg.eval_on_selector("#ex-dur", "e => e.value")
    fps = await pg.eval_on_selector("#ex-gfps", "e => e.value")
    check("exportar GIF: duración y fps del Movimiento, estimación de peso y fotogramas", dur == "2" and fps == "20" and "40 fotogramas" in note and ("KB" in note or "MB" in note) and "Deriva suave" in note, note)
    async with pg.expect_download(timeout=240000) as dl:
        await pg.click("#ex-go")
    data = Path(await (await dl.value).path()).read_bytes()
    g = parse_gif(data)
    s_last, s_med, s_max = seam(gif_frames(data))
    check("GIF con Deriva suave: 40 fotogramas × 5 cs, bucle infinito y costura como un paso normal",
          g["frames"] == 40 and set(g["delays"]) == {5} and g["loop"] == 0 and s_last <= s_max * 1.05,
          f"{g['frames']} fotogramas · costura {s_last:.1f} · mediana {s_med:.1f} · máx {s_max:.1f} · {len(data) // 1024} KB")
    await ctx.close()
    check("movimiento: sin errores en consola", not errors, " | ".join(errors[:5]))

async def _main():
    import os, shutil
    from playwright.async_api import async_playwright
    url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/screenshots"); out.mkdir(parents=True, exist_ok=True)
    cands = [os.environ.get("GLITCH_CHROME"), "/usr/bin/google-chrome", shutil.which("google-chrome"),
             r"C:\Program Files\Google\Chrome\Application\chrome.exe", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"]
    chrome = next(c for c in cands if c and Path(c).exists())
    res = []
    def check(n, ok, d=""):
        res.append(bool(ok)); print(("PASS " if ok else "FAIL ") + n + (f"  ({d})" if d else ""), flush=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=chrome, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        await run(b, url, out, check, mobile=True)
        await run_motion(b, url, out, check)
        await b.close()
    print(f"\n{sum(res)}/{len(res)} OK")

if __name__ == "__main__":
    asyncio.run(_main())
