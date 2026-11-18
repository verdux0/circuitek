"""
Video / GIF checks, in a real Chrome. Used by verify.py (and runnable alone):

    python tools/verify_media.py [url] [outdir]

`check(name, ok, detail)` and the screenshot dir come from the caller.
"""
import asyncio, base64, io, json, sys
from pathlib import Path
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from media_fixtures import make_fixtures

MEDIA_ARGS = ["--autoplay-policy=no-user-gesture-required"]
# Requests that left the page's own origin (must stay empty: 100 % local).
EXTERNAL = []

async def grab(pg):
    url = await pg.evaluate("document.getElementById('screen').toDataURL('image/png')")
    return Image.open(io.BytesIO(base64.b64decode(url.split(",")[1]))).convert("RGB")

def mad(a, b):
    a = a.resize((160, 90)); b = b.resize((160, 90))
    pa, pb = a.tobytes(), b.tobytes()
    return sum(abs(x - y) for x, y in zip(pa, pb)) / len(pa)

async def info(pg):
    return await pg.evaluate("window.__glitch.media()")

async def settle(pg, ms=250):
    await pg.wait_for_timeout(ms)
    for _ in range(80):
        if not await pg.evaluate("document.getElementById('busy').classList.contains('on')"):
            break
        await pg.wait_for_timeout(50)
    await pg.wait_for_timeout(120)

async def open_with(browser, url, files_path, vw=1400, vh=1000, mobile=False, errors=None):
    ctx = await browser.new_context(viewport={"width": vw, "height": vh}, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile)
    pg = await ctx.new_page()
    base = url.split("?")[0]
    pg.on("request", lambda r: EXTERNAL.append(r.url) if not (r.url.startswith(base) or r.url.startswith(("blob:", "data:"))) else None)
    if errors is not None:
        pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    await pg.goto(url)
    await pg.wait_for_load_state("networkidle")
    if files_path:
        await pg.set_input_files("#file", str(files_path))
        for _ in range(60):
            if await info(pg):
                break
            await pg.wait_for_timeout(100)
        await pg.wait_for_timeout(400)
    return ctx, pg

async def frame_after(pg, until, timeout=5000):
    """Polls the media frame until `until(frame)` holds (a step can chain several seeks on VFR files)."""
    f = (await info(pg))["frame"]
    for _ in range(timeout // 100):
        if until(f):
            break
        await pg.wait_for_timeout(100)
        f = (await info(pg))["frame"]
    await settle(pg, 200)
    return f

async def measure_fps(pg, secs=3.0):
    """Real preview fps while playing (renders per second, one per new video frame)."""
    a = await pg.evaluate("[window.__glitch.presents(), window.__glitch.media().stamp, performance.now()]")
    await pg.wait_for_timeout(int(secs * 1000))
    b = await pg.evaluate("[window.__glitch.presents(), window.__glitch.media().stamp, performance.now()]")
    dt = (b[2] - a[2]) / 1000
    return (b[0] - a[0]) / dt, (b[1] - a[1]) / dt

async def run(browser, url, out: Path, check, fixtures_dir: Path):
    errors = []
    results = {}
    # ---- fixtures (recorded in this Chrome) ----
    ctx, pg = await open_with(browser, url, None)
    files = await make_fixtures(pg, fixtures_dir)
    await ctx.close()
    check("vídeos de prueba generados (WebM, GIF; MP4 si Chrome lo graba)", "clip-720.webm" in files and "anim.gif" in files, ", ".join(sorted(files)))

    # ---- WebM 720p: import, motion, transport ----
    ctx, pg = await open_with(browser, url, files["clip-720.webm"], errors=errors)
    m = await info(pg)
    check("importar WebM → capa de vídeo reproduciéndose (silenciada)", bool(m) and m["kind"] == "video" and m["playing"] and m["muted"], json.dumps(m))
    check("vídeo con audio: controles de volumen activos", await pg.evaluate("!document.getElementById('mb-mute').disabled"))
    a = await grab(pg); await pg.wait_for_timeout(500); b = await grab(pg)
    check("reproduciendo: el efecto se ve en movimiento", mad(a, b) > 3, f"diferencia entre fotogramas {mad(a, b):.1f}")
    await pg.screenshot(path=str(out / "20-video-escritorio.png"))
    fps720 = await measure_fps(pg)
    results["fps720"] = fps720
    check("fps reales con vídeo 720p (render por fotograma nuevo)", fps720[0] > 5, f"{fps720[0]:.1f} renders/s · {fps720[1]:.1f} fotogramas nuevos/s")

    # pause: still frame, knob changes the image, no busy loop
    await pg.click("#mb-play"); await settle(pg)
    m = await info(pg)
    p0 = await pg.evaluate("window.__glitch.presents()")
    a = await grab(pg); await pg.wait_for_timeout(600); b = await grab(pg)
    p1 = await pg.evaluate("window.__glitch.presents()")
    check("pausa → el fotograma queda quieto", not m["playing"] and mad(a, b) < 0.01, f"diff {mad(a, b):.3f}")
    check("en pausa no se renderiza en bucle", p1 - p0 <= 1, f"{p1 - p0} renders en 0,6 s")
    kb = await pg.locator("#knob-effect .knob-dial").bounding_box()
    await pg.mouse.move(kb["x"] + kb["width"] / 2, kb["y"] + kb["height"] / 2)
    await pg.mouse.down(); await pg.mouse.move(kb["x"] + kb["width"] / 2, kb["y"] - 60, steps=6); await pg.mouse.up()
    await settle(pg)
    c = await grab(pg)
    check("en pausa, mover un knob cambia la imagen", mad(b, c) > 2, f"diff {mad(b, c):.1f}")

    # seek, frame step
    await pg.locator("#mb-seek").fill("1.5"); await settle(pg, 400)
    m = await info(pg)
    check("barra de búsqueda → tiempo 1,5 s", abs(m["time"] - 1.5) < 0.1, f"t={m['time']:.3f}")
    label = await pg.evaluate("document.getElementById('mb-time').textContent")
    check("tiempo actual / total en la barra", label.startswith("0:01.") and "/ 0:02." in label, label)
    f0 = m["frame"]
    await pg.click("#mb-next")
    f1 = await frame_after(pg, lambda f: f > f0)
    await pg.click("#mb-prev")
    f2 = await frame_after(pg, lambda f: f < f1)
    # +1 = the next frame actually presented (index can jump on variable-frame-rate files); −1 = back to the same one.
    a1 = await pg.evaluate("window.__glitch.hash()")
    check("avanzar 1 fotograma y retroceder 1 vuelve al mismo", f1 > f0 and f2 == f0, f"{f0} → {f1} → {f2}")
    await pg.keyboard.press(".")
    f3 = await frame_after(pg, lambda f: f > f2)
    check("atajo . avanza un fotograma (imagen distinta)", f3 == f1 and await pg.evaluate("window.__glitch.hash()") != a1, f"{f0} → {f3}")
    await pg.keyboard.press(",")
    f4 = await frame_after(pg, lambda f: f < f3)
    check("atajo , retrocede un fotograma", f4 == f2, f"{f3} → {f4}")

    # determinism: same frame + same seed + same state = identical pixels (also after seeking away and back)
    h1 = await pg.evaluate("window.__glitch.hash()")
    h2 = await pg.evaluate("window.__glitch.hash()")
    t = (await info(pg))["time"]
    await pg.locator("#mb-seek").fill("0.3"); await settle(pg, 400)
    await pg.locator("#mb-seek").fill(str(t)); await settle(pg, 500)
    h3 = await pg.evaluate("window.__glitch.hash()")
    check("mismo fotograma + misma seed + mismo estado = píxeles idénticos", h1 == h2 == h3, f"{h1} {h2} {h3}")
    # glitch animado: different frames get different noise only when on
    st = await pg.evaluate("window.__glitch.getState()")
    await pg.evaluate("s => window.__glitch.setState(s)", {**st, "cables": [{"a": "RG", "b": "HCLK", "amount": 100}]})
    await settle(pg)
    ha = await pg.evaluate("window.__glitch.hash()")
    await pg.click(".mb-anim .switch-track"); await settle(pg)
    hb = await pg.evaluate("window.__glitch.hash()")
    m = await info(pg)
    check("interruptor «Glitch animado» cambia el ruido del fotograma", ha != hb and m["animate"] is False, f"animate={m['animate']}")
    await pg.click(".mb-anim .switch-track"); await settle(pg)
    check("Glitch animado de nuevo → mismo resultado que antes (determinista)", await pg.evaluate("window.__glitch.hash()") == ha)

    # speed, loop, volume, mute
    await pg.select_option("#mb-speed", "0.25")
    s1 = (await info(pg))["speed"]
    await pg.select_option("#mb-speed", "2")
    s2 = (await info(pg))["speed"]
    check("velocidad 0,25× y 2×", s1 == 0.25 and s2 == 2, f"{s1} / {s2}")
    await pg.select_option("#mb-speed", "1")
    await pg.click("#mb-loop")
    l1 = (await info(pg))["loop"]
    await pg.click("#mb-loop")
    l2 = (await info(pg))["loop"]
    check("bucle on/off", l1 is False and l2 is True)
    await pg.locator("#mb-vol").fill("50")
    m = await info(pg)
    check("volumen 50 % activa el sonido", abs(m["volume"] - 0.5) < 0.01 and not m["muted"], json.dumps({"v": m["volume"], "muted": m["muted"]}))
    await pg.click("#mb-mute")
    check("botón silencio", (await info(pg))["muted"] is True)
    await pg.keyboard.press("m")
    check("atajo M quita el silencio", (await info(pg))["muted"] is False)
    await pg.keyboard.press("m")
    # keyboard: space = play / pause, accessible labels
    await pg.locator(".rw-mini .rw-side-title").click()
    await pg.keyboard.press(" "); await pg.wait_for_timeout(300)
    on = (await info(pg))["playing"]
    await pg.keyboard.press(" "); await pg.wait_for_timeout(300)
    off = (await info(pg))["playing"]
    check("Espacio = play/pausa con vídeo", on is True and off is False)
    labels = await pg.evaluate("""Array.from(document.querySelectorAll('#media-bar button, #media-bar input, #media-bar select'))
        .filter(e => !(e.getAttribute('aria-label') || e.closest('label'))).map(e => e.id)""")
    check("controles de vídeo con aria-label", not labels, ", ".join(labels))

    # encoder stage: skipped while playing (with notice), applied on pause
    st = await pg.evaluate("window.__glitch.getState()")
    await pg.evaluate("s => window.__glitch.setState(s)", {**st, "stages": {"enc": {"on": True, "p": {"jpg": 60, "sort": 40}}}})
    await settle(pg)
    paused_enc = await grab(pg)
    await pg.click("#mb-play"); await pg.wait_for_timeout(400)
    note = await pg.evaluate("!document.getElementById('mb-note').hidden")
    fps_enc = await measure_fps(pg, 2.0)
    check("JPEG/pixel sort: aviso «solo en pausa» mientras se reproduce", note, f"{fps_enc[0]:.1f} fps con la etapa activa")
    await pg.click("#mb-play"); await settle(pg, 800)
    note2 = await pg.evaluate("!document.getElementById('mb-note').hidden")
    h_enc1 = await pg.evaluate("window.__glitch.hash()")
    h_enc2 = await pg.evaluate("window.__glitch.hash()")
    check("en pausa el aviso desaparece y el codificador es determinista", not note2 and h_enc1 == h_enc2)
    await pg.evaluate("s => window.__glitch.setState(s)", {**st, "stages": {}})
    await settle(pg)

    # capture: current frame, full resolution, as a still
    await pg.click("#btn-capture"); await pg.wait_for_timeout(1500)
    still = await pg.evaluate("window.__glitch.newestProjectStill()")
    check("Capturar guarda el fotograma actual a resolución completa", bool(still) and still["w"] == 1280 and still["h"] == 720 and not still["media"], json.dumps(still))
    ex = await pg.evaluate("window.__glitch.exportSize('image/png')")
    check("exportar PNG con vídeo = resolución completa", ex["w"] == 1280 and ex["h"] == 720, json.dumps(ex))

    # video → image → video: players are released
    await pg.evaluate("window.__glitch.loadSample()"); await settle(pg)
    check("cambiar de vídeo a imagen libera el reproductor", await pg.evaluate("window.__glitch.players()") == 0 and await info(pg) is None
          and await pg.evaluate("document.querySelectorAll('#media-pool video').length") == 0)
    await pg.keyboard.press("Control+z"); await pg.wait_for_timeout(1500)
    m = await info(pg)
    check("deshacer devuelve la capa de vídeo (reproductor reabierto)", bool(m) and m["kind"] == "video", json.dumps(m))
    await pg.set_input_files("#file", str(files["anim.gif"])); await pg.wait_for_timeout(1500)
    check("vídeo + GIF en el mismo documento", await pg.evaluate("window.__glitch.players()") == 2)
    await ctx.close()

    # ---- 1080p fps ----
    big = files.get("clip-1080.mp4") or files.get("clip-1080.webm")
    ctx, pg = await open_with(browser, url, big, errors=errors)
    fps1080 = await measure_fps(pg)
    results["fps1080"] = fps1080
    check("fps reales con vídeo 1080p", fps1080[0] > 5, f"{fps1080[0]:.1f} renders/s · {fps1080[1]:.1f} fotogramas nuevos/s ({big.name})")
    await ctx.close()

    # ---- MP4 + rotation metadata ----
    if "clip-720.mp4" in files:
        ctx, pg = await open_with(browser, url, files["clip-720.mp4"], errors=errors)
        m = await info(pg)
        check("importar MP4 (H.264)", bool(m) and m["w"] == 1280, json.dumps(m))
        await ctx.close()
    if "rotado-90.mp4" in files:
        ctx, pg = await open_with(browser, url, files["rotado-90.mp4"], errors=errors)
        m = await info(pg)
        check("MP4 con rotación 90° en metadatos → se ve en vertical (720×1280)", bool(m) and (m["w"], m["h"]) == (720, 1280), json.dumps(m and {"w": m["w"], "h": m["h"]}))
        dims = await pg.evaluate("(() => { const d = window.__glitch.getDoc(); const l = d.layers[0]; return [d.w, d.h, l.w, l.h]; })()")
        check("vídeo rotado: lienzo y capa también en vertical (sin aplastar)", dims == [720, 1280, 720, 1280], str(dims))
        await pg.click("#mb-play"); await settle(pg)
        await pg.click("#btn-capture"); await pg.wait_for_timeout(1500)
        still = await pg.evaluate("window.__glitch.newestProjectStill()")
        check("vídeo rotado: Capturar da 720×1280", bool(still) and (still["w"], still["h"]) == (720, 1280), json.dumps(still))
        await pg.screenshot(path=str(out / "21-video-rotado.png"))
        await ctx.close()

    # ---- GIF: ImageDecoder and the omggif fallback ----
    for q, dec in [("", "ImageDecoder"), ("?gif=omggif", "omggif")]:
        ctx, pg = await open_with(browser, url + q, files["anim.gif"], errors=errors)
        m = await info(pg)
        a = await grab(pg); await pg.wait_for_timeout(400); b = await grab(pg)
        check(f"GIF animado con {dec}: 48 fotogramas a 25 fps, en movimiento", bool(m) and m["decoder"] == dec and abs(m["duration"] - 1.92) < 0.01 and mad(a, b) > 3,
              json.dumps(m and {"decoder": m["decoder"], "dur": m["duration"], "fps": m["fps"]}) + f" diff {mad(a, b):.1f}")
        await pg.click("#mb-play"); await pg.click("#mb-next"); await pg.wait_for_timeout(200)
        f = (await info(pg))["frame"]
        await pg.click("#mb-next"); await pg.wait_for_timeout(200)
        check(f"GIF ({dec}): avanzar fotograma", (await info(pg))["frame"] == f + 1)
        if not q:
            check("GIF sin audio: volumen desactivado", await pg.evaluate("document.getElementById('mb-mute').disabled"))
        await ctx.close()

    # ---- corrupt file: clear message, nothing added ----
    ctx, pg = await open_with(browser, url, None, errors=errors)
    await pg.set_input_files("#file", str(files["roto.mp4"])); await pg.wait_for_timeout(2500)
    toast = await pg.evaluate("document.getElementById('toast').textContent")
    check("archivo corrupto → mensaje claro, sin capa", "No se pudo abrir «roto»" in toast and await pg.evaluate("window.__glitch.getDoc().layers.length") == 0, toast)
    await ctx.close()

    # ---- reload keeps the video (session) and leaves nothing behind ----
    ctx, pg = await open_with(browser, url, files["clip-720.webm"], errors=errors)
    await pg.wait_for_timeout(500)
    await pg.evaluate("window.__glitch.session().flush()")  # session save (debounced) with the video Blob
    await pg.reload(); await pg.wait_for_load_state("networkidle")
    for _ in range(200):
        if await info(pg): break
        await pg.wait_for_timeout(100)
    m = await info(pg)
    check("recargar la página reabre el vídeo de la sesión", bool(m) and m["kind"] == "video", json.dumps(m and m["kind"]))
    check("tras recargar: un solo <video> vivo", await pg.evaluate("document.querySelectorAll('video').length") == 1)
    await ctx.close()

    # ---- mobile ----
    ctx, pg = await open_with(browser, url, files["clip-720.webm"], 390, 844, mobile=True, errors=errors)
    sw = await pg.evaluate("document.documentElement.scrollWidth")
    over = await pg.evaluate("""() => Array.from(document.querySelectorAll('.topbar *, #media-bar *, .controls *')).filter(e => {
        const r = e.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); }).map(e => e.id || String(e.className.baseVal ?? e.className)).slice(0, 5)""")
    check("móvil 390 px con vídeo: sin desbordes", sw <= 390 and not over, f"scrollWidth {sw} · {', '.join(over)}")
    await pg.screenshot(path=str(out / "22-video-movil.png"))
    await pg.evaluate("document.getElementById('media-bar').scrollIntoView({block: 'start'})"); await pg.wait_for_timeout(200)
    await pg.screenshot(path=str(out / "23-video-movil-controles.png"))
    await ctx.close()

    check("vídeo/GIF: sin errores en consola", not errors, " | ".join(errors[:5]))
    check("vídeo/GIF: cero peticiones de red externas", not EXTERNAL, ", ".join(EXTERNAL[:5]))
    return results

async def _main():
    from playwright.async_api import async_playwright
    url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/screenshots"); out.mkdir(parents=True, exist_ok=True)
    import os, shutil, tempfile
    cands = [os.environ.get("GLITCH_CHROME"), "/usr/bin/google-chrome", shutil.which("google-chrome"),
             r"C:\Program Files\Google\Chrome\Application\chrome.exe", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"]
    CHROME = next(c for c in cands if c and Path(c).exists())
    CHROME_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    res = []
    def check(n, ok, d=""):
        res.append(ok); print(("PASS " if ok else "FAIL ") + n + (f"  ({d})" if d else ""))
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=CHROME_ARGS + MEDIA_ARGS)
        r = await run(b, url, out, check, Path(tempfile.gettempdir()) / "ge-media")
        await b.close()
    print(f"\n{sum(res)}/{len(res)} OK", r)

if __name__ == "__main__":
    asyncio.run(_main())
