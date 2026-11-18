"""
End-to-end verification in a real (headless) Chrome.

    npm run build && npx vite preview --port 4173 &
    python3 tools/verify.py [url] [outdir]

Produces contact sheets + UI screenshots in docs/screenshots and prints a pass/fail report.
"""
import asyncio, base64, io, json, os, shutil, sys, tempfile
from pathlib import Path
from playwright.async_api import async_playwright
from PIL import Image, ImageDraw, ImageFont

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/screenshots")
OUT.mkdir(parents=True, exist_ok=True)

def _first(paths):
    return next((p for p in paths if p and Path(p).exists()), None)

# Linux and Windows; override with GLITCH_CHROME=/path/to/chrome.
CHROME = _first([os.environ.get("GLITCH_CHROME"), "/usr/bin/google-chrome", shutil.which("google-chrome"),
                 r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                 r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"])
_font = _first(["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", r"C:\Windows\Fonts\consola.ttf"])
FONT = ImageFont.truetype(_font, 15) if _font else ImageFont.load_default()
CHROME_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

PINS = ["SUB", "RG", "OD", "TG", "AB", "HCLK"]
PAIRS = [(PINS[i], PINS[j]) for i in range(6) for j in range(i + 1, 6)]

results = []
def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))

def base_state(**kw):
    s = {"v": 1, "seed": 1337, "effect": 50, "filter": 50, "cables": [], "stages": {}}
    s.update(kw)
    return s

async def render(pg, state):
    """Render state through the real UI and return the screen canvas as a PIL image."""
    await pg.evaluate("s => window.__glitch.setState(s)", state)
    await pg.wait_for_timeout(120)
    # wait for encoder worker if active
    for _ in range(100):
        busy = await pg.evaluate("document.getElementById('busy').classList.contains('on')")
        if not busy:
            break
        await pg.wait_for_timeout(50)
    await pg.wait_for_timeout(60)
    url = await stable_frame(pg)
    return Image.open(io.BytesIO(base64.b64decode(url.split(",")[1]))).convert("RGB")

async def stable_frame(pg, tries=20):
    """The screen canvas once two grabs 150 ms apart match (the encoder worker can land late)."""
    prev = await pg.evaluate("document.getElementById('screen').toDataURL('image/png')")
    for _ in range(tries):
        await pg.wait_for_timeout(150)
        cur = await pg.evaluate("document.getElementById('screen').toDataURL('image/png')")
        if cur == prev:
            return cur
        prev = cur
    return prev

def sheet(items, cols, cell_w, path, title):
    tiles = []
    for label, img in items:
        k = cell_w / img.width
        t = img.resize((cell_w, int(img.height * k)), Image.LANCZOS)
        tiles.append((label, t))
    ch = max(t.height for _, t in tiles) + 26
    rows = (len(tiles) + cols - 1) // cols
    W, H = cols * (cell_w + 10) + 10, rows * (ch + 10) + 46
    out = Image.new("RGB", (W, H), (232, 230, 225))
    d = ImageDraw.Draw(out)
    d.text((12, 12), title, fill=(20, 20, 20), font=FONT)
    for i, (label, t) in enumerate(tiles):
        x = 10 + (i % cols) * (cell_w + 10)
        y = 40 + (i // cols) * (ch + 10)
        out.paste(t, (x, y))
        d.text((x + 2, y + t.height + 5), label, fill=(30, 30, 30), font=FONT)
    out.save(path)
    print("wrote", path)

def diff(a, b):
    """Mean absolute difference (0..255) between two same-size images."""
    a = a.resize((160, 120)); b = b.resize((160, 120))
    pa, pb = a.tobytes(), b.tobytes()
    return sum(abs(x - y) for x, y in zip(pa, pb)) / len(pa)

async def canvas(pg):
    """The screen canvas as it is now (after the UI changed the state), as a PIL image."""
    await pg.wait_for_timeout(150)
    for _ in range(100):
        if not await pg.evaluate("document.getElementById('busy').classList.contains('on')"):
            break
        await pg.wait_for_timeout(50)
    await pg.wait_for_timeout(60)
    url = await stable_frame(pg)
    return Image.open(io.BytesIO(base64.b64decode(url.split(",")[1]))).convert("RGB")

async def drag_pins(pg, scope, a, b):
    """Drag a cable from pin a to pin b inside `scope` (.rw-mini = mini chip, .sheet = full view)."""
    pa = await pg.locator(f'{scope} [data-pin="{a}"] .pin-pad').bounding_box()
    pb = await pg.locator(f'{scope} [data-pin="{b}"] .pin-pad').bounding_box()
    await pg.mouse.move(pa["x"] + pa["width"] / 2, pa["y"] + pa["height"] / 2)
    await pg.mouse.down()
    await pg.mouse.move((pa["x"] + pb["x"]) / 2, (pa["y"] + pb["y"]) / 2 + 20, steps=6)
    await pg.mouse.move(pb["x"] + pb["width"] / 2, pb["y"] + pb["height"] / 2, steps=4)
    await pg.mouse.up()
    await pg.wait_for_timeout(150)

async def cables(pg):
    return await pg.evaluate("window.__glitch.getState().cables")

async def mini_checks(pg):
    """Mini chip in the controls bar: same state as the full sheet, edited in place."""
    await pg.evaluate("window.__glitch.loadSample()")
    await pg.evaluate("s => window.__glitch.setState(s)", base_state())
    clean = await canvas(pg)
    check("mini chip visible bajo el visor", await pg.locator(".controls .rw-mini .pcb-svg").is_visible())
    await drag_pins(pg, ".rw-mini", "RG", "TG")
    c = await cables(pg)
    check("mini chip: arrastrar de pin a pin crea un cable", [(x["a"], x["b"]) for x in c] == [("RG", "TG")], json.dumps(c))
    wired = await canvas(pg)
    check("mini chip: el cable cambia la imagen al momento", diff(clean, wired) > 8, f"{diff(clean, wired):.1f}")
    await pg.screenshot(path=str(OUT / "13-mini-chip-cable.png"))
    # resistance slider (live) + one undo step
    await pg.locator('.rw-mini input[data-amount="0"]').fill("35")
    amt = (await cables(pg))[0]["amount"]
    low = await canvas(pg)
    check("mini chip: el slider de resistencia cambia amount", amt == 35, str(amt))
    check("mini chip: el slider cambia la imagen", diff(low, wired) > 1, f"{diff(low, wired):.1f}")
    await pg.locator(".rw-mini .rw-side-title").click()
    await pg.keyboard.press("Control+z"); await pg.wait_for_timeout(100)
    check("Ctrl+Z deshace el slider del mini chip", (await cables(pg))[0]["amount"] == 100, json.dumps(await cables(pg)))
    await pg.keyboard.press("Control+Shift+z"); await pg.wait_for_timeout(100)
    # the full view shows the same cable and the same resistance
    await pg.keyboard.press("w"); await pg.wait_for_timeout(250)
    check("W abre la vista ampliada", await pg.locator(".sheet .pcb-svg").is_visible())
    n_sheet = await pg.locator(".sheet .cables .cable").count()
    knob = await pg.locator(".sheet .rw-knob .knob-dial").first.get_attribute("aria-valuenow")
    check("vista ampliada: mismo cable que el mini chip", n_sheet == 1, f"{n_sheet} cable(s)")
    check("vista ampliada: misma resistencia que el slider", knob == "35", f"knob = {knob}")
    await pg.screenshot(path=str(OUT / "14-vista-ampliada-mismo-cable.png"))
    # a cable added in the full view appears in the mini chip at once (visible under the sheet)
    await drag_pins(pg, ".sheet", "SUB", "OD")
    n_mini = await pg.locator(".rw-mini .cables .cable").count()
    check("cable hecho en la vista ampliada aparece en el mini chip", n_mini == 2, f"{n_mini}")
    await pg.keyboard.press("Escape"); await pg.wait_for_timeout(150)
    # keyboard on the mini chip: Space on two pins bridges them and does NOT trigger Space = capture
    projs = await pg.evaluate("document.querySelectorAll('#project-grid > *').length")
    await pg.locator('.rw-mini [data-pin="AB"]').focus(); await pg.keyboard.press(" ")
    await pg.locator('.rw-mini [data-pin="HCLK"]').focus(); await pg.keyboard.press(" ")
    await pg.wait_for_timeout(300)
    c = await cables(pg)
    projs2 = await pg.evaluate("document.querySelectorAll('#project-grid > *').length")
    check("mini chip con teclado: Espacio en dos pines crea el cable", len(c) == 3 and (c[2]["a"], c[2]["b"]) == ("AB", "HCLK"), json.dumps(c))
    check("Espacio en un pin no dispara Capturar", projs == projs2, f"{projs} -> {projs2} proyectos")
    labels = await pg.evaluate("Array.from(document.querySelectorAll('.rw-mini [data-pin]')).every(g => g.getAttribute('aria-label') && g.tabIndex === 0)")
    check("pines del mini chip con aria-label y foco de teclado", labels)
    # max 3 cables still enforced from the mini chip
    await drag_pins(pg, ".rw-mini", "SUB", "RG")
    check("mini chip respeta el máximo de 3 cables", len(await cables(pg)) == 3)
    # remove from the mini chip: x button and tap on the cable
    await pg.locator('.rw-mini [data-remove="2"]').click(); await pg.wait_for_timeout(100)
    check("mini chip: el botón x quita el cable", len(await cables(pg)) == 2)
    # the RG+TG wire crosses the chip: click the middle of its bounding box (away from the pins)
    box = await pg.locator('.rw-mini .cable[data-cable="0"] .cable-wire').bounding_box()
    await pg.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2); await pg.wait_for_timeout(100)
    c = await cables(pg)
    check("mini chip: tocar un cable lo quita", len(c) == 1 and (c[0]["a"], c[0]["b"]) == ("SUB", "OD"), json.dumps(c))

async def layout_checks(pg, label):
    vw = await pg.evaluate("innerWidth")
    sw = await pg.evaluate("document.documentElement.scrollWidth")
    check(f"{label}: sin scroll horizontal", sw <= vw, f"scrollWidth {sw} / {vw}")
    over = await pg.evaluate("""() => Array.from(document.querySelectorAll('.controls, .controls *')).filter(e => {
        const r = e.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); }).map(e => String(e.className.baseVal ?? e.className)).slice(0, 5)""")
    check(f"{label}: controles dentro del ancho", not over, ", ".join(over))
    spill = await pg.evaluate("""() => { const card = document.querySelector('.rw-mini').getBoundingClientRect();
        return Array.from(document.querySelectorAll('.rw-mini .rw-side *')).filter(e => { const r = e.getBoundingClientRect();
          return r.width && (r.right > card.right + 1 || r.left < card.left - 1); }).map(e => String(e.className.baseVal ?? e.className)).slice(0, 5); }""")
    check(f"{label}: nada se sale de la tarjeta del mini chip", not spill, ", ".join(spill))

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME, args=CHROME_ARGS)
        ctx = await browser.new_context(viewport={"width": 1400, "height": 1000}, accept_downloads=True)
        pg = await ctx.new_page()
        console_errors, requests = [], []
        pg.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))
        await pg.goto(URL)
        await pg.wait_for_load_state("networkidle")
        await pg.evaluate("localStorage.clear()")
        await pg.reload()
        await pg.wait_for_load_state("networkidle")
        pg.on("request", lambda r: requests.append(r.url))
        await pg.screenshot(path=str(OUT / "01-inicio-vacio.png"))

        await pg.evaluate("window.__glitch.loadSample()")
        await pg.wait_for_timeout(400)
        await pg.click("#tab-fx")  # seed / presets live in the Efectos tab
        original = await render(pg, base_state())

        # ---- 15 pairs contact sheet ----
        imgs = {}
        for a, b in PAIRS:
            imgs[(a, b)] = await render(pg, base_state(cables=[{"a": a, "b": b, "amount": 100}]))
        sheet([("ORIGINAL", original)] + [(f"{a}+{b}", imgs[(a, b)]) for a, b in PAIRS], 4, 330,
              OUT / "02-hoja-15-pares.png", "Los 15 pares de pines · EFFECT 50 · FILTER 50 · seed 1337")
        # distinctness: every pair differs from original and from every other pair
        min_orig = min(diff(original, im) for im in imgs.values())
        check("los 15 pares alteran la imagen", min_orig > 8, f"diferencia mínima con el original = {min_orig:.1f}")
        keys = list(imgs)
        pair_d = [(diff(imgs[x], imgs[y]), x, y) for i, x in enumerate(keys) for y in keys[i + 1:]]
        md = min(pair_d)
        check("los 15 pares son distintos entre sí", md[0] > 8, f"par más parecido {md[1]} vs {md[2]} = {md[0]:.1f}")

        # ---- filter knob changes each pair ----
        fl = []
        for a, b in PAIRS:
            lo = await render(pg, base_state(filter=5, cables=[{"a": a, "b": b, "amount": 100}]))
            hi = await render(pg, base_state(filter=95, cables=[{"a": a, "b": b, "amount": 100}]))
            fl.append((diff(lo, hi), f"{a}+{b}"))
        mf = min(fl)
        check("FILTER cambia la imagen en los 15 pares", mf[0] > 3, f"menor cambio {mf[1]} = {mf[0]:.1f}")
        # ---- effect knob ----
        e0 = await render(pg, base_state(effect=0, cables=[{"a": "OD", "b": "HCLK", "amount": 100}]))
        e1 = await render(pg, base_state(effect=100, cables=[{"a": "OD", "b": "HCLK", "amount": 100}]))
        check("EFFECT a 0 = imagen limpia", diff(e0, original) < 1.0, f"{diff(e0, original):.2f}")
        check("EFFECT a 100 altera", diff(e1, original) > 8, f"{diff(e1, original):.1f}")

        # ---- every stage knob ----
        stage_params = await pg.evaluate("""() => { const s = window.__glitch.getState(); return Object.fromEntries(Object.entries(s.stages).map(([k,v]) => [k, Object.keys(v.p)])) }""")
        extremes = {"bits": 2, "xor": 80, "rot": 3, "swap": 4, "stride": 17, "repeat": 70, "echo": 80,
                    "bayer": 80, "bleed": 90, "poster": 80, "sat": 80, "jpg": 60, "quality": 20, "gens": 3,
                    "sort": 60, "sortLen": 80, "sortDir": 2}
        enc_needs = {"quality": {"jpg": 40}, "gens": {"jpg": 40}, "sortLen": {"sort": 50}, "sortDir": {"sort": 50}}
        stage_imgs = []
        for st, params in stage_params.items():
            for prm in params:
                base_p = enc_needs.get(prm, {})
                ref = await render(pg, base_state(stages={st: {"on": True, "p": dict(base_p)}}))
                im = await render(pg, base_state(stages={st: {"on": True, "p": {**base_p, prm: extremes[prm]}}}))
                d = diff(ref, im)
                check(f"knob {st}.{prm} altera la imagen", d > 1.0, f"{d:.1f}")
                stage_imgs.append((f"{st}.{prm}={extremes[prm]}", im))
        sheet(stage_imgs, 6, 220, OUT / "03-hoja-etapas.png", "Etapas extra: cada knob por separado (sin cables)")

        # ---- multi-cable chain ----
        multi = base_state(seed=77, effect=60, cables=[{"a": "OD", "b": "TG", "amount": 90}, {"a": "SUB", "b": "HCLK", "amount": 70}, {"a": "RG", "b": "AB", "amount": 40}])
        m_img = await render(pg, multi)
        one = await render(pg, base_state(seed=77, effect=60, cables=[{"a": "OD", "b": "TG", "amount": 90}]))
        check("3 cables encadenados difieren de 1 cable", diff(m_img, one) > 5, f"{diff(m_img, one):.1f}")

        # ---- presets sheet ----
        presets = await pg.evaluate("Array.from(document.querySelectorAll('#preset-select option')).slice(1).map(o => o.value)")
        pimgs = []
        for v in presets:
            await pg.select_option("#preset-select", v)
            await pg.wait_for_timeout(150)
            st = await pg.evaluate("window.__glitch.getState()")
            name = await pg.evaluate(f"document.querySelector('#preset-select option[value=\"{v}\"]').textContent")
            pimgs.append((name, await render(pg, st)))
        sheet(pimgs, 3, 420, OUT / "04-presets.png", "Presets de fábrica")

        # ---- determinism ----
        full = base_state(seed=4242, effect=70, filter=30, cables=[{"a": "RG", "b": "HCLK", "amount": 80}, {"a": "OD", "b": "AB", "amount": 60}],
                          stages={"bus": {"on": True, "p": {"xor": 40}}, "buffer": {"on": True, "p": {"repeat": 30, "stride": 5}},
                                  "proc": {"on": True, "p": {"bleed": 50}}, "enc": {"on": True, "p": {"jpg": 40, "sort": 40}}})
        await pg.evaluate("s => window.__glitch.setState(s)", full)
        h1 = await pg.evaluate("window.__glitch.hash()")
        h2 = await pg.evaluate("window.__glitch.hash()")
        check("misma seed + mismo estado = píxeles idénticos", h1 == h2, h1)
        rt = await pg.evaluate("window.__glitch.presetRoundTrip()")
        h3 = await pg.evaluate("s => window.__glitch.hash(s)", rt)
        check("preset exportado/reimportado = imagen idéntica", h1 == h3, h3)
        await pg.evaluate("s => window.__glitch.setState(s)", {**full, "seed": 4243})
        h4 = await pg.evaluate("window.__glitch.hash()")
        check("otra seed = otra imagen", h4 != h1)
        # across reload
        await pg.reload()
        await pg.wait_for_load_state("networkidle")
        await pg.evaluate("window.__glitch.loadSample()")
        h5 = await pg.evaluate("s => window.__glitch.hash(s)", full)
        check("determinista tras recargar la página", h5 == h1, h5)

        # ---- export full res ----
        await pg.evaluate("s => window.__glitch.setState(s)", full)
        ex = await pg.evaluate("window.__glitch.exportSize('image/png')")
        check("export a resolución original", ex["w"] == ex["original"][0] and ex["h"] == ex["original"][1], json.dumps(ex))
        async with pg.expect_download() as dl:
            await pg.click("#btn-png")
        d = await dl.value
        path = OUT / "export-ejemplo.png"
        await d.save_as(str(path))
        exp = Image.open(path)
        check("botón PNG descarga a resolución completa", exp.size == (1600, 1200), str(exp.size))
        exp.convert("RGB").resize((800, 600)).save(OUT / "05-export-reducido.jpg", quality=88)
        path.unlink()

        # ---- import a real file via the file input (jpg / png / webp) ----
        tmp = Path(tempfile.gettempdir()) / "ge-import"; tmp.mkdir(exist_ok=True)
        src = Image.open(OUT / "02-hoja-15-pares.png").convert("RGB").crop((0, 0, 900, 600))
        for fmt in ["JPEG", "PNG", "WEBP"]:
            f = tmp / f"in.{fmt.lower()}"
            src.save(f, fmt)
            await pg.set_input_files("#file", str(f))
            await pg.wait_for_timeout(500)
            # Each import becomes a new layer at the file's own resolution (the canvas keeps its size).
            dims = await pg.evaluate("(() => { const l = window.__glitch.getDoc().layers.at(-1); return [l.w, l.h, l.name]; })()")
            check(f"importa {fmt}", dims[:2] == [900, 600] and dims[2] == "in", str(dims))

        # ---- UI screenshots ----
        await pg.evaluate("window.__glitch.loadSample()")
        await pg.evaluate("s => window.__glitch.setState(s)", multi)
        await pg.wait_for_timeout(300)
        await pg.click("#btn-capture"); await pg.wait_for_timeout(400)
        await pg.select_option("#preset-select", "1"); await pg.wait_for_timeout(200)
        await pg.click("#btn-capture"); await pg.wait_for_timeout(400)
        await pg.select_option("#preset-select", "3"); await pg.wait_for_timeout(600)
        await pg.click("#btn-capture"); await pg.wait_for_timeout(600)
        await pg.screenshot(path=str(OUT / "06-escritorio.png"))
        await layout_checks(pg, "escritorio 1400px")
        bottom = await pg.evaluate("document.querySelector('.controls').getBoundingClientRect().bottom")
        check("escritorio 1400x1000: visor + mini chip + knobs caben sin scroll", bottom <= 1000, f"bottom {bottom:.0f}")
        lap = await ctx.new_page()
        await lap.set_viewport_size({"width": 1280, "height": 800})
        await lap.goto(URL); await lap.wait_for_load_state("networkidle")
        await lap.evaluate("window.__glitch.loadSample()")
        await lap.evaluate("s => window.__glitch.setState(s)", multi); await lap.wait_for_timeout(300)
        bottom = await lap.evaluate("document.querySelector('.controls').getBoundingClientRect().bottom")
        check("portátil 1280x800: visor + mini chip + knobs caben sin scroll", bottom <= 800, f"bottom {bottom:.0f}")
        await layout_checks(lap, "portátil 1280px")
        await lap.screenshot(path=str(OUT / "06b-portatil.png"))
        await lap.close()
        await pg.click("#btn-rewire"); await pg.wait_for_timeout(300)
        await pg.screenshot(path=str(OUT / "07-rewire.png"))
        # drag a new cable SUB -> HCLK... first free a slot by closing and checking cable count
        n_before = await pg.evaluate("window.__glitch.getState().cables.length")
        sub = await pg.locator('.sheet [data-pin="SUB"] .pin-pad').bounding_box()
        ab = await pg.locator('.sheet [data-pin="AB"] .pin-pad').bounding_box()
        await pg.mouse.move(sub["x"] + sub["width"] / 2, sub["y"] + sub["height"] / 2)
        await pg.mouse.down()
        await pg.mouse.move(ab["x"] + 5, ab["y"] + 30, steps=8)
        await pg.mouse.move(ab["x"] + ab["width"] / 2, ab["y"] + ab["height"] / 2, steps=4)
        await pg.mouse.up()
        await pg.wait_for_timeout(200)
        n_after = await pg.evaluate("window.__glitch.getState().cables.length")
        check("arrastrar de pin a pin crea un cable", n_after == min(3, n_before + 1) or n_before == 3, f"{n_before} -> {n_after}")
        await pg.screenshot(path=str(OUT / "08-rewire-cable-nuevo.png"))
        await pg.keyboard.press("Escape")
        # knob drag + undo
        before = await pg.evaluate("window.__glitch.getState().effect")
        kb = await pg.locator("#knob-effect .knob-dial").bounding_box()
        await pg.mouse.move(kb["x"] + kb["width"] / 2, kb["y"] + kb["height"] / 2)
        await pg.mouse.down(); await pg.mouse.move(kb["x"] + kb["width"] / 2, kb["y"] - 40, steps=6); await pg.mouse.up()
        after = await pg.evaluate("window.__glitch.getState().effect")
        check("arrastrar el knob EFFECT cambia el valor", after > before, f"{before} -> {after}")
        await pg.keyboard.press("Control+z"); await pg.wait_for_timeout(100)
        undone = await pg.evaluate("window.__glitch.getState().effect")
        check("Ctrl+Z deshace el giro del knob", undone == before, f"{undone}")
        await pg.keyboard.press("Control+Shift+z"); await pg.wait_for_timeout(100)
        redone = await pg.evaluate("window.__glitch.getState().effect")
        check("Ctrl+Shift+Z rehace", redone == after, f"{redone}")
        await mini_checks(pg)
        await pg.click("#btn-variants"); await pg.wait_for_timeout(2500)
        await pg.screenshot(path=str(OUT / "09-variantes.png"))
        await pg.keyboard.press("Escape")

        # ---- mobile ----
        mob = await browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        mob.on("pageerror", lambda e: console_errors.append(f"pageerror(mobile): {e}"))
        await mob.goto(URL); await mob.wait_for_load_state("networkidle")
        await mob.evaluate("window.__glitch.loadSample()")
        await mob.evaluate("s => window.__glitch.setState(s)", multi)
        await mob.wait_for_timeout(400)
        await mob.screenshot(path=str(OUT / "10-movil.png"))
        await layout_checks(mob, "móvil 390px")
        await mob.evaluate("s => window.__glitch.setState(s)", base_state())
        before = await canvas(mob)
        await drag_pins(mob, ".rw-mini", "OD", "HCLK")
        c = await cables(mob)
        check("móvil: arrastrar en el mini chip crea un cable", len(c) == 1, json.dumps(c))
        check("móvil: la imagen cambia con el cable", diff(before, await canvas(mob)) > 8)
        await mob.evaluate("window.scrollTo(0, 0)"); await mob.wait_for_timeout(200)
        await mob.screenshot(path=str(OUT / "15-movil-mini-chip.png"))
        vis = await mob.evaluate("""() => { const v = document.getElementById('viewer').getBoundingClientRect(), c = document.querySelector('.rw-mini').getBoundingClientRect();
            return v.top >= 0 && c.bottom <= innerHeight + 1; }""")
        check("móvil: imagen y mini chip a la vez en pantalla (sin scroll)", vis)
        await mob.evaluate("s => window.__glitch.setState(s)", multi)
        await mob.wait_for_timeout(200)
        await mob.click("#btn-rack"); await mob.wait_for_timeout(400)
        await mob.screenshot(path=str(OUT / "11-movil-etapas.png"))
        await mob.click("#btn-rack"); await mob.wait_for_timeout(300)
        await mob.click("#btn-rewire"); await mob.wait_for_timeout(300)
        await mob.screenshot(path=str(OUT / "12-movil-rewire.png"))

        external = [u for u in requests if not u.startswith(URL) and not u.startswith("blob:") and not u.startswith("data:")]
        check("ninguna petición de red externa tras la carga", not external, ", ".join(external[:5]))
        app_reqs = [u for u in requests if u.startswith(URL)]
        check("ninguna petición de red tras la carga (salvo recargas de prueba)", all(("assets/" in u or u.rstrip('/') == URL.rstrip('/')) for u in app_reqs), f"{len(app_reqs)} peticiones locales (recargas del test)")
        real_errors = [e for e in console_errors if "GPU stall" not in e]
        check("sin errores en consola", not real_errors, " | ".join(real_errors[:5]))
        await browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} comprobaciones OK")
    (OUT / "verificacion.txt").write_text("\n".join(("PASS " if ok else "FAIL ") + n + (f"  ({d})" if d else "") for n, ok, d in results) + f"\n\n{len(results) - len(failed)}/{len(results)} OK\n")
    sys.exit(1 if failed else 0)

asyncio.run(main())
