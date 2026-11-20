"""
Checks that the build (base: './' → relative URLs) works both at the root of a domain
(Cloudflare Pages, Netlify) and under a sub-path (GitHub Pages: /circuitek/).

    npm run build && python tools/verify_paths.py [dist]

Serves `dist` with a plain static server (no SPA fallback, like the real hosts) at
http://127.0.0.1:<port>/ and http://127.0.0.1:<port>/circuitek/, then loads the app in
Chrome at 1400 px and 390 px: no 4xx/5xx, no console errors, every request inside its path,
lazy chunks (Mediabunny), the inline workers (JPEG encoder) and the bundled fonts working.
"""
import asyncio, functools, http.server, os, shutil, sys, tempfile, threading
from pathlib import Path

DIST = Path(sys.argv[1] if len(sys.argv) > 1 else "dist").resolve()

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

def serve(root: Path) -> tuple[http.server.ThreadingHTTPServer, int]:
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(root)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]

async def check_site(browser, url, results):
    for label, vp in [("1400 px", {"width": 1400, "height": 1000}), ("390 px", {"width": 390, "height": 844})]:
        ctx = await browser.new_context(viewport=vp)
        pg = await ctx.new_page()
        errs, bad, reqs = [], [], []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("response", lambda r: bad.append(f"{r.status} {r.url}") if r.status >= 400 else None)
        pg.on("request", lambda r: reqs.append(r.url))
        await pg.goto(url)
        await pg.wait_for_load_state("networkidle")
        await pg.evaluate("window.__glitch.loadSample()")
        # JPEG encoder stage → inline worker; export menu → lazily loaded Mediabunny chunk.
        await pg.evaluate("s => window.__glitch.setState(s)", {"v": 1, "seed": 7, "effect": 50, "filter": 50,
                          "cables": [{"a": "RG", "b": "TG", "amount": 100}], "stages": {"enc": {"on": True, "p": {"jpg": 50}}}})
        h = await pg.evaluate("window.__glitch.hash()")
        fonts = await pg.evaluate("document.fonts.check('700 14px Nunito') && document.fonts.check('700 12px \"JetBrains Mono\"')")
        lazy = [u for u in reqs if "/assets/" in u and u.endswith(".js")]
        outside = [u for u in reqs if not u.startswith(url) and not u.startswith(("blob:", "data:"))]
        ok = not bad and not errs and not outside and fonts and len(lazy) >= 2
        results.append(ok)
        print(("PASS " if ok else "FAIL ") + f"{url} · {label}: {len(reqs)} peticiones, {len(lazy)} JS, hash {h}"
              + (f" · 4xx/5xx {bad[:3]}" if bad else "") + (f" · errores {errs[:3]}" if errs else "")
              + (f" · fuera de la ruta {outside[:3]}" if outside else "") + ("" if fonts else " · FUENTES NO CARGADAS"), flush=True)
        await ctx.close()

async def main():
    from playwright.async_api import async_playwright
    if not (DIST / "index.html").exists():
        sys.exit(f"No hay build en {DIST}: ejecuta npm run build")
    tmp = Path(tempfile.mkdtemp(prefix="ge-paths-"))
    shutil.copytree(DIST, tmp / "circuitek")
    root_srv, root_port = serve(DIST)
    sub_srv, sub_port = serve(tmp)
    cands = [os.environ.get("GLITCH_CHROME"), "/usr/bin/google-chrome", shutil.which("google-chrome"),
             r"C:\Program Files\Google\Chrome\Application\chrome.exe", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"]
    chrome = next(c for c in cands if c and Path(c).exists())
    results = []
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path=chrome, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
            await check_site(b, f"http://127.0.0.1:{root_port}/", results)                 # Cloudflare Pages / Netlify
            await check_site(b, f"http://127.0.0.1:{sub_port}/circuitek/", results)    # GitHub Pages
            await b.close()
    finally:
        root_srv.shutdown()
        sub_srv.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{sum(results)}/{len(results)} OK")
    sys.exit(0 if all(results) else 1)

if __name__ == "__main__":
    asyncio.run(main())
