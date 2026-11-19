"""
Font library checks in Chrome (built app served by `vite preview`):
  - start-up downloads no library font and no catalog; no request ever leaves the origin
  - 390 px phone: open the picker from the text panel, search, filter by category, keyboard,
    favourite, apply; the font is really loaded (document.fonts.check) and drawn
  - variable font: variant selector, exact weight drawn
  - 5 fonts of different kinds: editor frame == exported frame (PNG/GIF share FrameSource),
    and each draws differently from the fallback
  - save + reopen keeps fontId / weight; an old document (no fontId) opens; a missing font
    keeps its fontId and shows a note
  - user font: imported, used, stored only in IndexedDB (not in presets)
  - measures: picker open time with the full catalog, JS heap, bytes for 10 fonts
Run by verify.py or standalone:

    python tools/verify_fonts.py [url] [outdir]
"""
import asyncio, json, os, shutil, sys
from pathlib import Path

ROOT = Path(__file__).parent.parent


async def settle(pg, ms=500):
    await pg.wait_for_timeout(ms)


async def run(browser, url, out: Path, check):
    errors, requests, external = [], [], []
    base = url.split("?")[0]
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    pg = await ctx.new_page()
    pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

    def on_req(r):
        requests.append(r.url)
        if not (r.url.startswith(base) or r.url.startswith(("blob:", "data:"))):
            external.append(r.url)
    pg.on("request", on_req)
    sizes = {}

    async def on_resp(r):
        if "/fonts/files/" in r.url:
            try:
                sizes[r.url] = len(await r.body())
            except Exception:
                pass
    pg.on("response", lambda r: asyncio.ensure_future(on_resp(r)))

    await pg.goto(url)
    await pg.wait_for_load_state("networkidle")
    lib_at_start = [u for u in requests if "/fonts/" in u]
    base_fonts = [u for u in requests if u.endswith(".woff2")]
    check("al iniciar no se descarga ninguna fuente de la biblioteca ni el catálogo", not lib_at_start, f"{len(base_fonts)} WOFF2 base de la interfaz/incluidas · biblioteca: {lib_at_start[:3]}")

    await pg.evaluate("window.__glitch.loadSample()")
    await settle(pg)
    await pg.evaluate("window.__glitch.addText()")
    await settle(pg)
    await pg.evaluate("(() => { const d = window.__glitch.getDoc(); const l = d.layers.find(x => x.text); return window.__glitch.editText(l.id, { content: 'GLITCH ñ' }); })()")
    await settle(pg)
    check("nueva capa de texto con la fuente base sin pedir el catálogo", not [u for u in requests if "/fonts/" in u])

    # ---- picker on the phone, from the real button ----
    await pg.tap("#btn-rack"); await settle(pg, 400)
    await pg.locator("#tab-layers").tap(); await settle(pg, 300)
    lst = pg.locator(".fp-list")
    await lst.wait_for(state="visible")
    await pg.wait_for_selector(".fp-row")
    await settle(pg, 700)
    open_ms = await pg.evaluate("window.__glitch.fontPickerMs()")
    rows = await pg.locator(".fp-row").count()
    status = await pg.text_content(".fp-status")
    check("lista de fuentes integrada en el panel (sin ventana), con el catálogo completo y virtualizada",
          await pg.locator(".fp-backdrop, [role=dialog] .fp").count() == 0 and rows < 60 and "fuentes" in status, f"{status} · {rows} filas en el DOM · montar: {open_ms:.0f} ms")
    cur = await pg.eval_on_selector(".fp-row.fp-cur", "e => e.dataset.family")
    check("la fuente actual (Anton) aparece marcada en la lista", cur == "Anton", cur)
    check("roles accesibles: listbox con opciones", await pg.locator("[role=listbox][aria-label]").count() == 1 and await pg.locator(".fp-row[role=option]").count() == rows)
    check("carga diferida: solo las filas visibles piden archivos", 0 < len([u for u in requests if "/fonts/files/" in u]) <= 40, f"{len([u for u in requests if '/fonts/files/' in u])} archivos")
    await pg.locator(".fp-list").scroll_into_view_if_needed()
    await settle(pg, 400)
    await pg.screenshot(path=str(out / "60-fuentes-lista-movil.png"))

    # search (debounced, accent-insensitive)
    await pg.fill(".fp-q", "UNIFRAKTUR")
    await settle(pg, 400)
    names = await pg.eval_on_selector_all(".fp-row", "els => els.map(e => e.dataset.family)")
    check("buscar «UNIFRAKTUR» (mayúsculas) encuentra las góticas", names and all("Unifraktur" in n for n in names), ", ".join(names))
    await pg.fill(".fp-q", "")
    await settle(pg, 300)
    await pg.select_option(".fp-cat", "pixel")
    await settle(pg, 500)
    st = await pg.text_content(".fp-status")
    pix = await pg.eval_on_selector_all(".fp-row", "els => els.map(e => e.dataset.family)")
    check("filtro por categoría Pixel", 3 <= len(pix) <= 30 and any("Press Start" in n or "Silkscreen" in n or "VT323" in n for n in pix), f"{st}: {', '.join(pix[:8])}")

    # live: a tap applies at once, the canvas changes, the list stays
    h0 = await pg.evaluate("window.__glitch.screenHash()")
    hist0 = await pg.evaluate("window.__glitch.historySize()")
    second = pix[1]
    await pg.locator(f'.fp-row[data-family="{second}"] .fp-prev').tap()
    await settle(pg, 900)
    t = await pg.evaluate("window.__glitch.getDoc().layers.find(x => x.text).text")
    h1 = await pg.evaluate("window.__glitch.screenHash()")
    loaded = await pg.evaluate(f"document.fonts.check('32px \"{second}\"', 'GLITCH')")
    check("tocar una fuente la aplica al instante: el lienzo cambia y la lista sigue abierta",
          t["font"] == second and t.get("fontId") and loaded and h1 != h0 and await lst.is_visible(), json.dumps(t, ensure_ascii=False))
    check("la fuente aplicada queda marcada en la lista", await pg.eval_on_selector(".fp-row.fp-cur", "e => e.dataset.family") == second)
    await pg.screenshot(path=str(out / "61-fuentes-directo-movil.png"))

    # keyboard: ↓ ↓ ↓ applies each font live, one undo step when browsing stops
    await pg.locator(".fp-list").focus()
    seen = []
    for _ in range(3):
        await pg.keyboard.press("ArrowDown")
        await settle(pg, 250)
        seen.append(await pg.evaluate("window.__glitch.getDoc().layers.find(x => x.text).text.font"))
    await settle(pg, 1200)
    hist1 = await pg.evaluate("window.__glitch.historySize()")
    check("↓ aplica cada fuente en directo y al parar deja un solo paso de deshacer", len(set(seen)) == 3 and hist1 - hist0 == 2, f"{' → '.join(seen)} · historial +{hist1 - hist0} (clic + recorrido)")
    target = seen[-1]
    await pg.keyboard.press("Shift+Enter")
    favs = await pg.evaluate("localStorage.getItem('glitch-editor.fonts.favs')")
    rec = await pg.evaluate("localStorage.getItem('glitch-editor.fonts.recent')")
    fid = (await pg.evaluate("window.__glitch.getDoc().layers.find(x => x.text).text")).get("fontId")
    check("Mayús+Intro marca favorita; favoritas y recientes en localStorage", fid in (favs or "") and fid in (rec or ""), f"{target}: {favs} · {rec}")
    await pg.select_option(".fp-cat", "all")
    await settle(pg, 300)

    # ---- variable font + variant selector ----
    await pg.evaluate("""(async () => { const d = window.__glitch.getDoc(); const l = d.layers.find(x => x.text);
        await window.__glitch.editText(l.id, { font: 'Oswald', fontId: 'oswald', weight: undefined, bold: false, italic: false }); })()""")
    await settle(pg, 900)
    opts = await pg.eval_on_selector_all('[data-text="variant"] option', "els => els.map(e => e.value)")
    check("fuente variable (Oswald): el selector de variante ofrece su rango de pesos", len(opts) >= 5 and "200" in opts and "700" in opts, ",".join(opts))
    h400 = await pg.evaluate("window.__glitch.screenHash()")
    await pg.select_option('[data-text="variant"]', "300")
    await settle(pg, 900)
    t = await pg.evaluate("window.__glitch.getDoc().layers.find(x => x.text).text")
    h300 = await pg.evaluate("window.__glitch.screenHash()")
    ok300 = await pg.evaluate("document.fonts.check('300 32px \"Oswald\"', 'GLITCH')")
    check("cambiar de variante a 300 se aplica y se dibuja distinto", t.get("weight") == 300 and ok300 and h300 != h400, json.dumps(t, ensure_ascii=False))
    await pg.screenshot(path=str(out / "62-fuentes-variante-movil.png"))

    # ---- 5 fonts of different kinds: editor == export, each != fallback ----
    await pg.evaluate("(() => { const d = window.__glitch.getDoc(); d.layers.forEach(l => l.animate = !!l.text); window.__glitch.setDoc(d); })()")
    await settle(pg, 500)
    fallback = None
    await pg.evaluate("""(async () => { const d = window.__glitch.getDoc(); const l = d.layers.find(x => x.text);
        await window.__glitch.editText(l.id, { font: 'sans-serif', fontId: 'system:sans-serif', weight: undefined }); })()""")
    await pg.evaluate("window.__glitch.anim.show(0)"); await settle(pg, 600)
    fallback = await pg.evaluate("window.__glitch.exportFrameHash(0)")
    for fid, fam in [("unifrakturmaguntia", "UnifrakturMaguntia"), ("press-start-2p", "Press Start 2P"), ("pacifico", "Pacifico"), ("space-mono", "Space Mono"), ("black-ops-one", "Black Ops One")]:
        await pg.evaluate(f"""(async () => {{ const d = window.__glitch.getDoc(); const l = d.layers.find(x => x.text);
            await window.__glitch.editText(l.id, {{ font: '{fam}', fontId: '{fid}', weight: undefined, bold: false }}); }})()""")
        await pg.evaluate("window.__glitch.anim.show(0)"); await settle(pg, 700)
        scr = await pg.evaluate("window.__glitch.screenHash()")
        exp = await pg.evaluate("window.__glitch.exportFrameHash(0)")
        check(f"{fam}: el fotograma exportado (PNG/GIF) coincide con la vista previa y no es la alternativa", scr == exp and exp != fallback, f"{scr} / {exp}")
    await pg.evaluate("window.__glitch.anim.stop()")

    # ---- glyph check ----
    await pg.evaluate("""(async () => { const d = window.__glitch.getDoc(); const l = d.layers.find(x => x.text);
        await window.__glitch.editText(l.id, { content: 'Hola ★ 漢' }); })()""")
    await settle(pg, 800)
    note = await pg.evaluate("window.__glitch.fontNote()")
    check("glifos que faltan: aviso visible bajo la fuente", "★" in note and "漢" in note, note)

    # ---- persistence: save + reopen, old doc, missing font ----
    await pg.evaluate("""(async () => { const d = window.__glitch.getDoc(); const l = d.layers.find(x => x.text);
        await window.__glitch.editText(l.id, { content: 'GUARDADO', font: 'Oswald', fontId: 'oswald', weight: 600, bold: true }); })()""")
    await settle(pg, 700)
    await pg.evaluate("window.__glitch.saveProject(true)")
    await settle(pg, 900)
    await pg.reload(); await pg.wait_for_load_state("networkidle"); await settle(pg, 1500)
    t = await pg.evaluate("(window.__glitch.getDoc().layers.find(x => x.text) || {}).text")
    ok = await pg.evaluate("document.fonts.check('600 32px \"Oswald\"', 'GUARDADO')")
    check("recargar restaura fontId, peso y la fuente cargada", t and t.get("fontId") == "oswald" and t.get("weight") == 600 and ok, json.dumps(t, ensure_ascii=False))
    old = {"w": 800, "h": 400, "bg": "#000000", "layers": [{"id": "L9", "name": "viejo", "src": "", "w": 10, "h": 10, "x": 400, "y": 200,
           "text": {"content": "VIEJO", "font": "Bebas Neue", "size": 80, "color": "#ffffff", "bold": False, "italic": False, "align": "center", "lineHeight": 1.15}}]}
    await pg.evaluate(f"window.__glitch.openDoc({json.dumps(old)})")
    await settle(pg, 600)
    t = await pg.evaluate("window.__glitch.getDoc().layers[0].text")
    check("documento antiguo (sin fontId) se abre sin errores", t["font"] == "Bebas Neue" and "fontId" not in t, json.dumps(t))
    gone = dict(old); gone["layers"] = [dict(old["layers"][0], text=dict(old["layers"][0]["text"], font="Fuente Borrada", fontId="fuente-borrada"))]
    n_err = len(errors)
    await pg.evaluate(f"window.__glitch.openDoc({json.dumps(gone)})")
    await settle(pg, 900)
    t = await pg.evaluate("window.__glitch.getDoc().layers[0].text")
    note = await pg.evaluate("window.__glitch.fontNote()")
    await pg.screenshot(path=str(out / "63-fuentes-ausente-movil.png"))
    check("fuente ausente: se conserva su fontId y se avisa", t.get("fontId") == "fuente-borrada" and "no está disponible" in note and len(errors) == n_err, note)

    # ---- user font: imported, used, IndexedDB only, not in presets ----
    ttf = ROOT / "node_modules" / "@fontsource" / "anton" / "files" / "anton-latin-400-normal.woff2"
    tmp = Path(os.environ.get("TEMP", "/tmp")) / "Mi Fuente Propia.woff2"
    shutil.copy(ttf, tmp)
    async with pg.expect_file_chooser() as fc:
        await pg.evaluate("document.querySelector('[data-font=\"file\"]').click()")
    await (await fc.value).set_files(str(tmp))
    await settle(pg, 1200)
    t = await pg.evaluate("window.__glitch.getDoc().layers[0].text")
    preset = await pg.evaluate("JSON.stringify(window.__glitch.presetRoundTrip())")
    check("fuente del usuario importada y aplicada (marcada como propia)", t["font"] == "Mi Fuente Propia" and t.get("fontId") == "user:Mi Fuente Propia", json.dumps(t, ensure_ascii=False))
    check("la fuente del usuario no entra en los presets", "Mi Fuente" not in preset)
    repo = [p for p in (ROOT / "public").rglob("*") if "Mi Fuente" in p.name]
    check("la fuente del usuario no entra en el repositorio", not repo)

    # ---- measures: 10 fonts ----
    await pg.evaluate("""(async () => { const ids = ['lobster','bangers','monoton','orbitron','righteous','caveat','abril-fatface','bungee','audiowide','silkscreen'];
        const d = window.__glitch.getDoc(); const l = d.layers[0];
        for (const id of ids) { const c = await (await fetch('fonts/catalog/fonts.json')).json(); const e = c.families.find(f => f.id === id);
          if (e) await window.__glitch.editText(l.id, { font: e.family, fontId: e.id, content: 'Medida ñ', weight: undefined }); } })()""")
    await settle(pg, 1500)
    heap = await pg.evaluate("performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null")
    total = sum(sizes.values())
    check("medición: peso transferido de fuentes de la biblioteca en la sesión", total > 0, f"{len(sizes)} archivos · {total / 1024:.0f} KB en total (incluye vistas previas del selector) · heap JS {heap} MB")

    check("ninguna petición a dominios externos", not external, ", ".join(external[:5]))
    check("consola sin errores", not errors, " | ".join(errors[:5]))
    await ctx.close()


async def _main():
    from playwright.async_api import async_playwright
    url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/screenshots"); out.mkdir(parents=True, exist_ok=True)
    cands = [os.environ.get("GLITCH_CHROME"), shutil.which("google-chrome"), r"C:\Program Files\Google\Chrome\Application\chrome.exe"]
    chrome = next(c for c in cands if c and Path(c).exists())
    res = []

    def check(n, ok, d=""):
        res.append(bool(ok)); print(("PASS " if ok else "FAIL ") + n + (f"  ({d})" if d else ""), flush=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=chrome, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-precise-memory-info"])
        await run(b, url, out, check)
        await b.close()
    print(f"\n{sum(res)}/{len(res)} OK")

if __name__ == "__main__":
    asyncio.run(_main())
