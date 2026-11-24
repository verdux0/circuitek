"""
Navegador (Chrome sin cabeza + Playwright) contra `npx vite preview --port 4173`.
Uso: python tools/measure_styles.py http://localhost:4173/ carpeta-de-capturas
(GLITCH_CHROME=/ruta/a/chrome si no lo encuentra.)
"""
import asyncio, sys
from playwright.async_api import async_playwright
import os, shutil
CHROME = next((p for p in [os.environ.get("GLITCH_CHROME"), r"C:\Program Files\Google\Chrome\Application\chrome.exe", "/usr/bin/google-chrome", shutil.which("google-chrome") or ""] if p and os.path.exists(p)), None)
STYLE = "{ enabled: true, dropShadow: { on: true, size: 12, distance: 10 }, outerGlow: { on: true, size: 16 }, innerShadow: { on: true, size: 6 } }"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=["--use-angle=swiftshader","--enable-unsafe-swiftshader"])
        pg = await b.new_page(viewport={"width":1400,"height":900})
        await pg.goto(sys.argv[1]); await pg.wait_for_function("!!window.__glitch")
        await pg.evaluate("window.__glitch.loadSample()")
        await pg.evaluate("window.__glitch.addSampleLayer(500, 400)")
        await pg.evaluate("window.__glitch.addSampleLayer(400, 300)")
        await pg.wait_for_timeout(800)
        print("preview size:", (await pg.evaluate("window.__glitch.view()"))["preview"])
        async def frame_ms(style):
            await pg.evaluate(f"""async () => {{ const d = window.__glitch.getDoc(); for (const l of d.layers) {{ {('l.style = ' + STYLE) if style else 'delete l.style'}; }} await window.__glitch.openDoc(d); }}""")
            await pg.wait_for_timeout(1500)
            out = []
            for k in range(1, 6):
                ms = await pg.evaluate(f"""async () => {{
                  const g = window.__glitch; const p0 = g.presents(); const t0 = performance.now(); g.anim.show({k});
                  await new Promise((r) => {{ const f = () => g.presents() > p0 ? r() : requestAnimationFrame(f); f(); }});
                  await g.screenHash(); // read-back: waits until the GPU has really finished the frame
                  return performance.now() - t0; }}""")
                out.append(ms)
            st = await pg.evaluate("window.__glitch.anim.state()")
            print("   ", "styles" if style else "plain", [round(x) for x in out], "fx builds so far:", st["fx"]["builds"])
            await pg.evaluate("window.__glitch.anim.stop()")
            return sorted(out)[len(out)//2]
        a = await frame_ms(False); c = await frame_ms(True)
        print(f"median frame incl. GPU finish + read-back, 3 layers: without styles {a:.0f} ms · with 3 effects per layer {c:.0f} ms · effects cost {c-a:.0f} ms (SwiftShader, CPU)")
        await b.close()
asyncio.run(main())
