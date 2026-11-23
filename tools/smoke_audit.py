"""Browser smoke test for the audit (current UI). Usage: python smoke_audit.py URL OUTDIR"""
import asyncio, json, sys, tempfile, os
from pathlib import Path
from playwright.async_api import async_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else ".")
OUT.mkdir(parents=True, exist_ok=True)
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
results = []

def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)

XSS_FILE = {
    "format": "circuitek-project", "v": 2,
    "project": {"id": "PXSS", "name": "xss", "created": 1, "updated": 2,
                "thumb": 'data:image/png;base64,AAAA" onerror="window.__pwned=1',
                "doc": {"w": 10, "h": 10, "bg": "#000000", "layers": [], "active": None}, "fonts": []},
    "images": {}, "fonts": {},
}

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=ARGS)
        ctx = await b.new_context(viewport={"width": 1400, "height": 900})
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errors.append("console: " + m.text))
        await pg.goto(URL)
        await pg.wait_for_function("!!window.__glitch")
        await pg.evaluate("window.__glitch.clearProjects()")
        await pg.evaluate("window.__glitch.loadSample()")
        await pg.wait_for_timeout(800)
        h1 = await pg.evaluate("window.__glitch.screenHash()")
        check("render sample", len(h1) == 16, h1)
        # Presets / random change the pixels deterministically
        await pg.evaluate("window.__glitch.setState({v:2,seed:1,effect:80,filter:40,cables:[{a:'OD',b:'HCLK',amount:100}],stages:{}})")
        await pg.wait_for_timeout(500)
        h2 = await pg.evaluate("window.__glitch.screenHash()")
        check("state changes render", h2 != h1)
        # Encoder stage (worker) completes and the busy flag clears
        await pg.evaluate("window.__glitch.setState({v:2,seed:3,effect:50,filter:50,cables:[{a:'RG',b:'TG',amount:100}],stages:{enc:{on:true,p:{jpg:40,quality:30,gens:1,sort:30,sortLen:40,sortDir:0}}}})")
        busy = True
        for _ in range(100):
            await pg.wait_for_timeout(100)
            busy = await pg.evaluate("document.getElementById('busy').classList.contains('on')")
            if not busy:
                break
        check("encoder stage finishes", not busy)
        hh = await pg.evaluate("window.__glitch.hash()")
        check("full pipeline hash", len(hh) == 16, hh)
        # Text layer
        await pg.evaluate("window.__glitch.addText()")
        await pg.wait_for_timeout(600)
        await pg.keyboard.type("HOLA")
        await pg.keyboard.press("Escape")
        await pg.wait_for_timeout(400)
        d = await pg.evaluate("window.__glitch.getDoc()")
        texts = [l for l in d["layers"] if l.get("text")]
        check("text layer typed", texts and "HOLA" in texts[-1]["text"]["content"], texts and texts[-1]["text"]["content"])
        # Undo / redo
        n_before = len(d["layers"])
        await pg.keyboard.press("Control+z")
        await pg.wait_for_timeout(300)
        n_after = len((await pg.evaluate("window.__glitch.getDoc()"))["layers"])
        check("undo works", n_after <= n_before, f"{n_before}->{n_after}")
        await pg.keyboard.press("Control+Shift+z")
        await pg.wait_for_timeout(300)
        # Save project, grid shows it
        await pg.evaluate("window.__glitch.saveProject(true)")
        await pg.wait_for_timeout(600)
        projs = await pg.evaluate("window.__glitch.projects()")
        check("project saved", len(projs) >= 1, str(len(projs)))
        cards = await pg.locator("#project-grid .pcard").count()
        check("project card rendered", cards >= 1, str(cards))
        # Context menu on the viewer, with a copied style whose source name has HTML
        await pg.evaluate("""() => { const d = window.__glitch.getDoc(); const l = d.layers.find(x => x.id === d.active) || d.layers[0]; l.name = '<i id=xssname>'; window.__glitch.setDoc(d); }""")
        await pg.wait_for_timeout(300)
        await pg.keyboard.press("Control+Alt+c")
        await pg.wait_for_timeout(200)
        box = await pg.locator("#stage").bounding_box()
        await pg.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, button="right")
        await pg.wait_for_timeout(300)
        menu_items = await pg.locator(".ctx-menu .ctx-item").count()
        check("context menu opens", menu_items > 3, str(menu_items))
        injected = await pg.locator(".ctx-menu #xssname").count()
        check("context menu escapes layer names", injected == 0, f"injected elements: {injected}")
        await pg.keyboard.press("Escape")
        # Menu bar opens
        await pg.locator("#menus button").first.click()
        await pg.wait_for_timeout(200)
        check("menu bar opens", await pg.locator(".menu-item, [role=menuitem]").count() > 0)
        await pg.keyboard.press("Escape")
        # PNG export path
        r = await pg.evaluate("window.__glitch.exportSize('image/png')")
        check("export png", r["bytes"] > 1000, json.dumps(r))
        # Crafted .glitch file with an attribute-breaking thumbnail
        tmp = Path(tempfile.gettempdir()) / "xss-audit.glitch"
        tmp.write_text(json.dumps(XSS_FILE), encoding="utf-8")
        inp = pg.locator('input[accept=".glitch,application/json"]')
        await inp.set_input_files(str(tmp))
        await pg.wait_for_timeout(1200)
        pwned = await pg.evaluate("window.__pwned === 1")
        attr = await pg.locator('#project-grid img[onerror]').count()
        check("crafted .glitch thumbnail cannot inject attributes", not pwned and attr == 0, f"pwned={pwned} onerror-imgs={attr}")
        await pg.screenshot(path=str(OUT / "smoke.png"))
        await pg.evaluate("window.__glitch.clearProjects()")
        real_errors = [e for e in errors if "favicon" not in e]
        check("no page errors", not real_errors, "; ".join(real_errors)[:400])
        await b.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} OK")

asyncio.run(main())
