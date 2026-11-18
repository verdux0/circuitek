"""
Export checks (button ▾, formats, options dialog, PNG / JPG / GIF / MP4 files), in a real Chrome.
Run by verify.py; also standalone:

    python tools/verify_export.py [url] [outdir]

Files are validated as files: signatures and sizes (PIL), GIF blocks parsed here (NETSCAPE2.0,
frame count, delays, size, last→first seam vs normal steps), MP4 parsed in the page with
Mediabunny (codec, size, fps, duration, audio) and played in a <video>.
"""
import asyncio, base64, io, json, re, statistics, struct, sys, tempfile
from pathlib import Path
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from media_fixtures import make_fixtures

ARGS = ["--autoplay-policy=no-user-gesture-required"]
EXTERNAL = []

def parse_gif(b: bytes) -> dict:
    """Header, logical screen, NETSCAPE loop count, frames and their delays (centiseconds)."""
    out = {"sig": b[:6].decode("latin1"), "w": struct.unpack("<H", b[6:8])[0], "h": struct.unpack("<H", b[8:10])[0], "loop": None, "delays": [], "frames": 0}
    p = 13
    if b[10] & 0x80:
        p += 3 * (1 << ((b[10] & 7) + 1))
    while p < len(b):
        c = b[p]
        if c == 0x3B:
            out["trailer"] = True
            break
        if c == 0x21:
            label = b[p + 1]
            if label == 0xFF and b[p + 3:p + 14] == b"NETSCAPE2.0":
                out["loop"] = struct.unpack("<H", b[p + 16:p + 18])[0]
            if label == 0xF9:
                out["delays"].append(struct.unpack("<H", b[p + 4:p + 6])[0])
            p += 2
            while b[p]:
                p += b[p] + 1
            p += 1
        elif c == 0x2C:
            out["frames"] += 1
            lf = b[p + 9]
            p += 10
            if lf & 0x80:
                p += 3 * (1 << ((lf & 7) + 1))
            p += 1
            while b[p]:
                p += b[p] + 1
            p += 1
        else:
            out["bad"] = p
            break
    return out

def gif_frames(b: bytes):
    im = Image.open(io.BytesIO(b))
    frames = []
    for i in range(im.n_frames):
        im.seek(i)
        frames.append(im.convert("RGB").resize((96, 72)))
    return frames

def mad(a, b):
    pa, pb = a.tobytes(), b.tobytes()
    return sum(abs(x - y) for x, y in zip(pa, pb)) / len(pa)

def seam(frames):
    """(last→first step, median step between consecutive frames)."""
    steps = [mad(frames[i], frames[i + 1]) for i in range(len(frames) - 1)]
    return mad(frames[-1], frames[0]), statistics.median(steps), max(steps)

async def new_page(browser, url, vw=1400, vh=1000, mobile=False, errors=None):
    ctx = await browser.new_context(viewport={"width": vw, "height": vh}, accept_downloads=True, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile)
    pg = await ctx.new_page()
    base = url.split("?")[0]
    pg.on("request", lambda r: EXTERNAL.append(r.url) if not (r.url.startswith(base) or r.url.startswith(("blob:", "data:"))) else None)
    if errors is not None:
        pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    await pg.goto(url)
    await pg.wait_for_load_state("networkidle")
    return ctx, pg

async def open_format(pg, label):
    """▾ → menu item `label` (PNG / JPG / GIF / MP4) → options dialog."""
    await pg.click("#btn-export-menu")
    await pg.locator(".ctx-menu .ctx-item", has_text=label).first.click()
    await pg.wait_for_selector(".export-sheet")

async def export_dialog(pg, timeout=240000):
    """Clicks Exportar in the dialog and returns (filename, bytes) of the download."""
    async with pg.expect_download(timeout=timeout) as dl:
        await pg.click("#ex-go")
    d = await dl.value
    path = await d.path()
    return d.suggested_filename, Path(path).read_bytes()

async def set_field(pg, sel, value):
    await pg.locator(sel).fill(str(value))
    await pg.locator(sel).dispatch_event("change")

async def run(browser, url, out: Path, check, fixtures_dir: Path):
    errors = []
    today = await (await browser.new_page()).evaluate("(() => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; })()")

    # ======================= still image =======================
    ctx, pg = await new_page(browser, url, errors=errors)
    await pg.evaluate("window.__glitch.loadSample()")
    await pg.wait_for_timeout(500)
    label = (await pg.text_content("#btn-export")).strip()
    check("botón Exportar ▾ sustituye a PNG y JPG", await pg.locator("#btn-png, #btn-jpg").count() == 0 and "PNG" in label, label)
    await pg.click("#btn-export-menu")
    await pg.wait_for_selector(".ctx-menu")
    items = await pg.evaluate("""Array.from(document.querySelectorAll('.ctx-menu .ctx-item')).map(b => ({t: b.innerText.replace(/\\s+/g, ' ').trim(), d: b.disabled, r: b.getAttribute('role')}))""")
    expanded = await pg.get_attribute("#btn-export-menu", "aria-expanded")
    check("lista de formatos: role=menu, 4 formatos, aria-expanded", await pg.locator(".ctx-menu[role=menu]").count() == 1 and len(items) == 4 and all(i["r"] == "menuitem" for i in items) and expanded == "true", json.dumps(items, ensure_ascii=False))
    gif_i = next(i for i in items if i["t"].startswith("GIF"))
    check("imagen fija: GIF y MP4 desactivados con el motivo, no ocultos", gif_i["d"] and "Glitch animado" in gif_i["t"] and items[3]["d"], gif_i["t"])
    focused = await pg.evaluate("document.activeElement.innerText.split('\\n')[0]")
    await pg.keyboard.press("ArrowDown")
    focused2 = await pg.evaluate("document.activeElement.innerText.split('\\n')[0]")
    await pg.screenshot(path=str(out / "30-export-menu.png"))
    await pg.keyboard.press("Escape")
    check("teclado en la lista: foco en PNG, ↓ pasa a JPG, Esc cierra", focused.startswith("PNG") and focused2.startswith("JPG") and await pg.locator(".ctx-menu").count() == 0
          and await pg.get_attribute("#btn-export-menu", "aria-expanded") == "false", f"{focused} → {focused2}")

    # main button: default PNG, full size, template name
    seed = await pg.evaluate("window.__glitch.getState().seed")
    async with pg.expect_download() as dl:
        await pg.click("#btn-export")
    d = await dl.value
    data = Path(await d.path()).read_bytes()
    im = Image.open(io.BytesIO(data))
    check("botón principal → PNG predeterminado a resolución completa", data[:8] == b"\x89PNG\r\n\x1a\n" and im.size == (1600, 1200), f"{im.size}")
    check("nombre según la plantilla {nombre}-{seed}-{fecha}", d.suggested_filename == f"Carta de ajuste-{seed}-{today}.png", d.suggested_filename)

    # JPG through the dialog: quality, scale, template preview, "use as default"
    await open_format(pg, "JPG")
    await set_field(pg, "#ex-quality", 40)
    await pg.select_option("#ex-scale", "0.5")
    await set_field(pg, "#ex-tpl", "{nombre}_{ancho}x{alto}")
    preview = await pg.text_content("#ex-name")
    check("vista previa del nombre final", preview == "Carta de ajuste_800x600.jpg", preview)
    await pg.check("#ex-default")
    await pg.screenshot(path=str(out / "31-export-dialogo-jpg.png"))
    name, data = await export_dialog(pg)
    im = Image.open(io.BytesIO(data)); im.load()
    check("JPG: firma, se decodifica, escala 50 %", data[:3] == b"\xff\xd8\xff" and im.format == "JPEG" and im.size == (800, 600) and name == preview, f"{name} {im.size}")
    # default persists after reload
    await pg.reload(); await pg.wait_for_load_state("networkidle")
    dflt = await pg.evaluate("window.__glitch.exportDefaults()")
    label = (await pg.text_content("#btn-export")).strip()
    check("«Usar como predeterminado» persiste tras recargar", dflt["format"] == "jpg" and dflt["jpg"]["quality"] == 40 and dflt["template"] == "{nombre}_{ancho}x{alto}" and "JPG" in label, f"{label} · {dflt['format']} q{dflt['jpg']['quality']}")
    await pg.evaluate("window.__glitch.loadSample()"); await pg.wait_for_timeout(400)
    await open_format(pg, "PNG")
    await pg.click("#ex-reset"); await pg.wait_for_timeout(300)
    dflt = await pg.evaluate("window.__glitch.exportDefaults()")
    check("Restablecer vuelve a los ajustes de fábrica", dflt["format"] == "png" and dflt["template"] == "{nombre}-{seed}-{fecha}" and "PNG" in (await pg.text_content("#btn-export")))
    await pg.keyboard.press("Escape")

    # generated animation (still image + «Glitch animado»): GIF with perfect loop
    await pg.click("#tab-fx")  # the switch lives in the Efectos tab
    await pg.click(".fx-anim-row .switch-track"); await pg.wait_for_timeout(200)
    await pg.click("#btn-export-menu")
    gif_ok = not await pg.locator(".ctx-menu .ctx-item", has_text="GIF").first.is_disabled()
    await pg.keyboard.press("Escape")
    check("«Glitch animado» en una imagen fija habilita GIF/MP4", gif_ok)
    await open_format(pg, "GIF")
    await set_field(pg, "#ex-gw", 320); await set_field(pg, "#ex-gfps", 20); await set_field(pg, "#ex-dur", 1)  # (the old EFFECT «pulse» field is gone: «Movimiento» replaces it)
    await pg.screenshot(path=str(out / "32-export-dialogo-gif.png"))
    name, data = await export_dialog(pg)
    g = parse_gif(data)
    check("GIF generado: cabecera, NETSCAPE2.0 infinito, 20 fotogramas × 5 cs, 320×240", g["sig"] == "GIF89a" and g["loop"] == 0 and g["frames"] == 20 and set(g["delays"]) == {5} and (g["w"], g["h"]) == (320, 240) and g.get("trailer"),
          json.dumps({k: g[k] for k in ("sig", "loop", "frames", "w", "h")}) + f" delays={sorted(set(g['delays']))}")
    s_last, s_med, s_max = seam(gif_frames(data))
    check("GIF generado: bucle perfecto (último → primero como un paso normal)", s_last <= s_max * 1.05 and s_last <= s_med * 1.6, f"costura {s_last:.1f} · paso mediano {s_med:.1f} · máximo {s_max:.1f}")

    # MP4 of a generated animation
    await open_format(pg, "MP4")
    await set_field(pg, "#ex-mdur", 1)
    await pg.select_option("#ex-mfps", "30")
    await pg.select_option("#ex-mh", "480")
    name, data = await export_dialog(pg)
    v = await pg.evaluate("b => window.__glitch.inspectVideo(b)", base64.b64encode(data).decode())
    check("MP4 generado: H.264, 640×480, 30 fotogramas a 30 fps, 1 s, sin audio", v["codec"] == "avc" and (v["w"], v["h"]) == (640, 480) and v["frames"] == 30 and abs(v["fps"] - 30) < 0.5 and abs(v["duration"] - 1) < 0.05 and v["audio"] is None, json.dumps(v))
    await ctx.close()

    # ======================= video input =======================
    files = {p.name: p for p in fixtures_dir.glob("*")} if fixtures_dir.exists() else {}
    if "clip-720.webm" not in files:
        c2, p2 = await new_page(browser, url)
        files = await make_fixtures(p2, fixtures_dir)
        await c2.close()
    ctx, pg = await new_page(browser, url, errors=errors)
    await pg.set_input_files("#file", str(files["clip-720.webm"]))
    for _ in range(60):
        if await pg.evaluate("window.__glitch.media()"): break
        await pg.wait_for_timeout(100)
    await pg.wait_for_timeout(500)

    async def video_gif(loop, fps=20, dur=2):
        await open_format(pg, "GIF")
        await set_field(pg, "#ex-gw", 320); await set_field(pg, "#ex-gfps", fps); await set_field(pg, "#ex-dur", dur)
        await pg.check(f'input[name="ex-loop"][value="{loop}"]')
        note = await pg.text_content("#ex-note")
        name, data = await export_dialog(pg)
        return note, data
    note, data = await video_gif("crossfade")
    g = parse_gif(data)
    s_last, s_med, s_max = seam(gif_frames(data))
    check("GIF de vídeo, fundido cruzado: 30 fotogramas (2 s − 25 % de solape), 320×180", g["frames"] == 30 and (g["w"], g["h"]) == (320, 180) and g["loop"] == 0, json.dumps({k: g[k] for k in ("frames", "w", "h", "loop")}))
    check("fundido cruzado: costura comparable al paso normal", s_last <= s_max * 1.05 and s_last <= s_med * 2.5, f"costura {s_last:.1f} · mediana {s_med:.1f} · máx {s_max:.1f}")
    note, data = await video_gif("pingpong", dur=1)
    g = parse_gif(data)
    s_last, s_med, s_max = seam(gif_frames(data))
    check("GIF ida y vuelta: 2·20−2 = 38 fotogramas, costura normal", g["frames"] == 38 and s_last <= s_max * 1.05, f"{g['frames']} fotogramas · costura {s_last:.1f} · mediana {s_med:.1f}")
    note, data = await video_gif("trim", fps=25, dur=2)
    g = parse_gif(data)
    check("GIF recortado al bucle: ≤ 50 fotogramas, retardo 4 cs exacto", 2 <= g["frames"] <= 50 and set(g["delays"]) == {4}, f"{g['frames']} fotogramas")
    await open_format(pg, "GIF")
    await set_field(pg, "#ex-gfps", 30)
    note30 = await pg.text_content("#ex-note")
    await set_field(pg, "#ex-gw", 160); await set_field(pg, "#ex-dur", 1)
    name, data = await export_dialog(pg)
    g = parse_gif(data)
    check("30 fps en GIF: aviso de redondeo y retardos 3/4 cs con media exacta", "no cuadra" in note30 and set(g["delays"]) <= {3, 4} and abs(sum(g["delays"]) / len(g["delays"]) - 100 / 30) < 0.2,
          f"retardos {sorted(set(g['delays']))} media {sum(g['delays']) / len(g['delays']):.2f}")

    # MP4 from video with audio and a time range
    await open_format(pg, "MP4")
    await pg.select_option("#ex-mh", "360"); await pg.select_option("#ex-mfps", "15")
    await set_field(pg, "#ex-start", 0.5); await set_field(pg, "#ex-end", 2)
    for _ in range(50):
        why = await pg.text_content("#ex-audio-why")
        if "comprobando" not in why: break
        await pg.wait_for_timeout(100)
    await pg.screenshot(path=str(out / "33-export-dialogo-mp4.png"))
    name, data = await export_dialog(pg)
    v = await pg.evaluate("b => window.__glitch.inspectVideo(b)", base64.b64encode(data).decode())
    check("MP4 de vídeo: H.264 640×360, 15 fps, rango 0,5–2 s (1,5 s), audio AAC", v["codec"] == "avc" and (v["w"], v["h"]) == (640, 360) and abs(v["fps"] - 15) < 0.5 and abs(v["duration"] - 1.5) < 0.1 and v["audio"] == "aac" and data[4:8] == b"ftyp",
          json.dumps(v) + f" · {why}")
    played = await pg.evaluate("""async (b64) => {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(new Blob([bytes], {type: 'video/mp4'}));
        await v.play();
        await new Promise(r => setTimeout(r, 700));
        const ok = v.currentTime > 0.2 && v.videoWidth === 640; v.pause(); URL.revokeObjectURL(v.src); return ok; }""", base64.b64encode(data).decode())
    check("el MP4 exportado se reproduce en un <video>", played)

    # deterministic: same state + same instant = same pixels (export twice → identical GIF bytes)
    await open_format(pg, "GIF")
    await set_field(pg, "#ex-gw", 160); await set_field(pg, "#ex-gfps", 10); await set_field(pg, "#ex-dur", 1)
    _, a = await export_dialog(pg)
    await open_format(pg, "GIF")
    await set_field(pg, "#ex-gw", 160); await set_field(pg, "#ex-gfps", 10); await set_field(pg, "#ex-dur", 1)
    _, b = await export_dialog(pg)
    check("exportación determinista: dos GIF iguales byte a byte", a == b, f"{len(a)} / {len(b)} bytes")

    # folder (OPFS stands in for the native picker) + cancel leaves no file behind
    await pg.evaluate("""async () => { const d = await navigator.storage.getDirectory();
        for await (const k of d.keys()) await d.removeEntry(k); await window.__glitch.setExportFolder(d); }""")
    await open_format(pg, "MP4")
    await pg.check('input[name="ex-save"][value="folder"]')
    await pg.select_option("#ex-mh", "360"); await pg.select_option("#ex-mfps", "15")
    await set_field(pg, "#ex-start", 0); await set_field(pg, "#ex-end", 1)
    expected = await pg.text_content("#ex-name")
    await pg.click("#ex-go")
    for _ in range(600):
        if not await pg.locator(".export-sheet").count(): break
        await pg.wait_for_timeout(100)
    listing = await pg.evaluate("""async () => { const d = await navigator.storage.getDirectory(); const out = [];
        for await (const [k, h] of d.entries()) out.push([k, (await h.getFile()).size]); return out; }""")
    check("carpeta elegida: el archivo se escribe ahí con el nombre de la plantilla", len(listing) == 1 and listing[0][0] == expected and listing[0][1] > 1000, json.dumps(listing, ensure_ascii=False))
    for fmt, setup in [("MP4", [("#ex-mh", "720"), ("#ex-mfps", "30")]), ("GIF", [])]:
        await open_format(pg, fmt)
        await pg.check('input[name="ex-save"][value="folder"]')
        for sel, val in setup:
            await pg.select_option(sel, val)
        if fmt == "MP4":
            await set_field(pg, "#ex-start", 0); await set_field(pg, "#ex-end", 0)
        else:
            await set_field(pg, "#ex-gw", 640); await set_field(pg, "#ex-dur", 3)
        await pg.click("#ex-go")
        await pg.wait_for_function("document.getElementById('ex-bar') && document.getElementById('ex-bar').value > 0.02", timeout=60000)
        responsive = await pg.evaluate("new Promise(r => { const t = performance.now(); setTimeout(() => r(performance.now() - t), 0); })")
        await pg.click("#ex-cancel")
        for _ in range(100):
            if not await pg.locator(".export-backdrop.running").count(): break
            await pg.wait_for_timeout(100)
        after = await pg.evaluate("""async () => { const d = await navigator.storage.getDirectory(); const out = [];
            for await (const k of d.keys()) out.push(k); return out; }""")
        toast = await pg.text_content("#toast")
        check(f"{fmt}: cancelar a mitad no deja archivo a medias (interfaz viva durante la exportación)", after == [listing[0][0]] and "cancelada" in toast and responsive < 1000, f"{after} · {toast} · bucle de eventos {responsive:.0f} ms")
        await pg.keyboard.press("Escape")
    await ctx.close()

    # ======================= mobile =======================
    ctx, pg = await new_page(browser, url, 390, 844, mobile=True, errors=errors)
    await pg.evaluate("window.__glitch.loadSample()")
    await pg.wait_for_timeout(400)
    await pg.click("#btn-rack"); await pg.wait_for_timeout(400)
    await pg.click("#btn-export-menu"); await pg.wait_for_timeout(200)
    menu_box = await pg.locator(".ctx-menu").bounding_box()
    await pg.screenshot(path=str(out / "34-export-movil-menu.png"))
    item_h = await pg.evaluate("Math.min(...Array.from(document.querySelectorAll('.ctx-menu .ctx-item')).map(b => b.getBoundingClientRect().height))")
    check("móvil: la lista cabe en pantalla y sus filas miden ≥ 44 px", menu_box["x"] >= 0 and menu_box["x"] + menu_box["width"] <= 390 and item_h >= 44, f"x={menu_box['x']:.0f} w={menu_box['width']:.0f} fila {item_h:.0f}px")
    await pg.locator(".ctx-menu .ctx-item", has_text="JPG").first.click()
    await pg.wait_for_selector(".export-sheet")
    box = await pg.locator(".export-sheet").bounding_box()
    sw = await pg.evaluate("document.documentElement.scrollWidth")
    check("móvil: el diálogo ocupa toda la pantalla, sin scroll horizontal", abs(box["width"] - 390) < 1 and box["height"] >= 840 and sw <= 390, f"{box['width']:.0f}×{box['height']:.0f}")
    await pg.screenshot(path=str(out / "35-export-movil-dialogo.png"))
    await ctx.close()

    check("exportar: sin errores en consola", not errors, " | ".join(errors[:5]))
    check("exportar: cero peticiones de red externas", not EXTERNAL, ", ".join(EXTERNAL[:5]))

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
        b = await p.chromium.launch(executable_path=chrome, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] + ARGS)
        await run(b, url, out, check, Path(tempfile.gettempdir()) / "ge-media")
        await b.close()
    print(f"\n{sum(res)}/{len(res)} OK")

if __name__ == "__main__":
    asyncio.run(_main())
