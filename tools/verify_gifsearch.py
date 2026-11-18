"""
GIF search panel checks with the network intercepted (no request reaches the Internet Archive):
mobile 390 px + touch, zero requests before searching, debounce + abort, results / empty /
error / offline states, "Cargar más", download + import of a GIF, cancel, no innerHTML injection,
no referrer, clean console. Run by verify.py; standalone:

    python tools/verify_gifsearch.py [url] [outdir]
"""
import asyncio, io, json, sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from PIL import Image

FIXTURE = json.loads((Path(__file__).parent.parent / "tests" / "fixtures" / "gifcities-computer.json").read_text(encoding="utf-8"))
B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

def fake_results(n, start=0):
    """Real fixture first, then synthetic but well-formed results (valid base32 checksums)."""
    out = list(FIXTURE)
    for i in range(start, start + n):
        cs = "".join(B32[(i * 7 + k * 13) % 32] for k in range(28)) + "".join(B32[(i >> s) & 31] for s in (0, 5, 10, 15))
        out.append({"url_text": f"fake result {i}", "weight": 1, "gif": "x", "checksum": cs, "width": 64, "height": 48,
                    "page": f"https://web.archive.org/web/2009/http://geocities.com/fake/{i}.html"})
    return out

def gif_bytes():
    frames = []
    for i in range(4):
        im = Image.new("RGB", (64, 48), (40 * i, 120, 255 - 40 * i))
        frames.append(im.convert("P", palette=Image.ADAPTIVE))
    b = io.BytesIO()
    frames[0].save(b, "GIF", save_all=True, append_images=frames[1:], duration=80, loop=0)
    return b.getvalue()

GIF = gif_bytes()

async def run(browser, url, out: Path, check):
    errors, external, api_calls = [], [], []
    state = {"mode": "ok", "slow_blob": False}
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    pg = await ctx.new_page()
    base = url.split("?")[0]
    pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

    def on_request(r):
        if not (r.url.startswith(base) or r.url.startswith(("blob:", "data:"))):
            external.append((r.url, r.headers.get("referer"), r.resource_type))
    pg.on("request", on_request)

    async def api(route, req):
        api_calls.append(req.url)
        q = parse_qs(urlparse(req.url).query)
        term = q.get("q", [""])[0]
        cors = {"access-control-allow-origin": req.headers.get("origin", "*"), "content-type": "application/json"}
        if state["mode"] == "error":
            return await route.fulfill(status=503, body="busy", headers=cors)
        if term == "zzzz":
            return await route.fulfill(status=200, body="[]", headers=cors)
        if term == "xss":
            evil = [{"url_text": '<img src=x onerror="window.__pwned=1">', "checksum": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "width": 10, "height": 10,
                     "page": "javascript:window.__pwned=2"}]
            return await route.fulfill(status=200, body=json.dumps(evil), headers=cors)
        limit = int(q.get("limit", ["300"])[0])
        return await route.fulfill(status=200, body=json.dumps(fake_results(140)[:limit]), headers=cors)

    async def blob(route, req):
        if state["slow_blob"] and req.resource_type == "fetch":
            await asyncio.sleep(4)
        try:
            await route.fulfill(status=200, body=GIF, headers={"access-control-allow-origin": "*", "content-type": "image/gif"})
        except Exception:
            pass  # cancelled download

    await pg.route("https://gifcities.archive.org/**", api)
    await pg.route("https://blob.gifcities.org/**", blob)
    await pg.route("https://web.archive.org/**", lambda r: r.abort())

    await pg.goto(url)
    await pg.wait_for_load_state("networkidle")
    await pg.wait_for_timeout(500)
    check("buscador: cero peticiones externas al cargar la app", not external, json.dumps(external[:3]))
    box = await pg.locator("#btn-gifsearch").bounding_box()
    sw = await pg.evaluate("document.documentElement.scrollWidth")
    check("botón «Buscar GIF» junto a Importar, cabe a 390 px", box and box["x"] + box["width"] <= 390 and sw <= 390, f"x={box and box['x']:.0f} scrollWidth={sw}")
    await pg.tap("#btn-gifsearch")
    await pg.wait_for_timeout(600)
    check("abrir el panel no hace ninguna petición", not external)
    await pg.screenshot(path=str(out / "40-gifs-movil-panel.png"))

    # debounce + abort: fast typing → one request
    await pg.locator("#gs-q").press_sequentially("comp", delay=60)
    await pg.wait_for_timeout(150)
    check("debounce: ninguna petición mientras se escribe", not api_calls)
    await pg.locator("#gs-q").press_sequentially("uter", delay=60)
    await pg.wait_for_selector(".gs-tile", timeout=10000)
    await pg.wait_for_timeout(300)
    check("debounce ~400 ms: una sola petición para «computer»", len(api_calls) == 1 and "q=computer" in api_calls[0], json.dumps(api_calls))
    tiles = await pg.locator(".gs-tile").count()
    status = await pg.text_content("#gs-status")
    check("resultados: 48 miniaturas y estado con el total", tiles == 48 and "48 de" in status, f"{tiles} · {status}")
    first = await pg.evaluate("""(() => { const t = document.querySelector('.gs-tile'); const a = t.querySelector('a');
        return { label: t.querySelector('.gs-pick').getAttribute('aria-label'), href: a && a.href, rel: a && a.rel, target: a && a.target, credit: t.querySelector('.gs-meta span').title }; })()""")
    check("cada resultado: enlace a la Wayback Machine (noopener) y crédito GifCities · Internet Archive",
          first["href"].startswith("https://web.archive.org/web/") and "noopener" in first["rel"] and first["target"] == "_blank" and first["credit"] == "Fuente: GifCities · Internet Archive", json.dumps(first, ensure_ascii=False))
    await pg.screenshot(path=str(out / "41-gifs-movil-resultados.png"))
    await pg.tap("#gs-more"); await pg.wait_for_timeout(300)
    check("«Cargar más» añade 48", await pg.locator(".gs-tile").count() == 96)
    await pg.tap("#gs-more"); await pg.wait_for_timeout(300)
    n3 = await pg.locator(".gs-tile").count()
    check("«Cargar más» otra vez: 144 de 150", n3 == 144, str(n3))
    imgs = [e for e in external if e[2] == "image"]
    check("miniaturas sin Referer (privacidad)", imgs and all(not r for _, r, _ in imgs), f"{len(imgs)} miniaturas")
    check("solo dominios esperados", all(urlparse(u).hostname in ("gifcities.archive.org", "blob.gifcities.org") for u, _, _ in external), str({urlparse(u).hostname for u, _, _ in external}))

    # states
    await pg.locator("#gs-q").fill("zzzz"); await pg.locator("#gs-q").press("Enter"); await pg.wait_for_timeout(800)
    st = await pg.text_content("#gs-status")
    check("estado «sin resultados»", "Sin resultados" in st and await pg.locator(".gs-tile").count() == 0, st)
    state["mode"] = "error"
    await pg.locator("#gs-q").fill("computer"); await pg.locator("#gs-q").press("Enter"); await pg.wait_for_timeout(800)
    st = await pg.text_content("#gs-status")
    check("estado «error de red» con Reintentar y respaldo manual", "503" in st and await pg.locator(".gs-retry").count() == 1 and "gifcities.org" in st, st)
    await pg.screenshot(path=str(out / "42-gifs-movil-error.png"))
    state["mode"] = "ok"
    await ctx.set_offline(True)
    await pg.locator("#gs-q").fill("dancing"); await pg.locator("#gs-q").press("Enter"); await pg.wait_for_timeout(800)
    st = await pg.text_content("#gs-status")
    check("estado «sin conexión»", "Sin conexión" in st, st)
    await ctx.set_offline(False)
    await pg.locator("#gs-q").fill("xss"); await pg.locator("#gs-q").press("Enter"); await pg.wait_for_timeout(800)
    pwned = await pg.evaluate("window.__pwned")
    lab = await pg.locator(".gs-pick").first.get_attribute("aria-label")
    links = await pg.locator(".gs-tile a").count()
    check("datos remotos nunca como HTML (sin ejecutar, texto literal, enlaces javascript: descartados)", pwned is None and "<img src=x" in lab and links == 0, f"pwned={pwned} links={links}")

    # cancel a download
    await pg.locator("#gs-q").fill("computer"); await pg.locator("#gs-q").press("Enter")
    await pg.wait_for_selector(".gs-tile")
    state["slow_blob"] = True
    layers0 = await pg.evaluate("window.__glitch.getDoc().layers.length")
    await pg.locator(".gs-pick").nth(1).tap()
    await pg.wait_for_selector("#gs-dl:not([hidden])", timeout=5000)
    await pg.tap("#gs-dl-cancel"); await pg.wait_for_timeout(500)
    toast = await pg.text_content("#toast")
    check("descarga con indicador y Cancelar: no se añade nada", "cancelada" in toast and await pg.evaluate("window.__glitch.getDoc().layers.length") == layers0, toast)
    state["slow_blob"] = False

    # pick → downloaded and loaded as an animated GIF layer
    await pg.locator(".gs-pick").nth(2).tap()
    for _ in range(60):
        if await pg.evaluate("window.__glitch.media()"): break
        await pg.wait_for_timeout(100)
    m = await pg.evaluate("window.__glitch.media()")
    check("tocar un GIF lo descarga y lo carga como capa animada", bool(m) and m["kind"] == "gif" and await pg.locator(".gs-backdrop").is_hidden(), json.dumps(m and {"kind": m["kind"], "w": m["w"], "h": m["h"]}))
    await pg.screenshot(path=str(out / "43-gifs-movil-cargado.png"))
    await ctx.close()
    # Chrome logs every HTTP error response; the 503 is the one this test simulates on purpose.
    real = [e for e in errors if "status of 503" not in e]
    check("buscador: sin errores en consola (aparte del 503 simulado a propósito)", not real, " | ".join(real[:5]))

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
        await run(b, url, out, check)
        await b.close()
    print(f"\n{sum(res)}/{len(res)} OK")

if __name__ == "__main__":
    asyncio.run(_main())
