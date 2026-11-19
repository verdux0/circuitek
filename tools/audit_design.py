"""
Design / accessibility audit of the whole page against WCAG 2.2 (W3C Recommendation,
12-12-2024) plus a legibility rule, in desktop (1400 px) and phone (390 px), light and dark:

  1.4.3  text contrast >= 4.5:1 (>= 3:1 for large text: 24 px, or 18.66 px bold)
  1.4.11 contrast of control borders >= 3:1 against what is around them
  2.5.8  pointer targets >= 24 x 24 CSS px (inline links in text are exempt)
  4.1.2  every control has an accessible name
  1.4.10 no horizontal scroll at 320 CSS px
  2.4.7  keyboard focus is visible (outline or shadow changes on :focus-visible)
  extra  text below 11 px (legibility, not a WCAG rule)

Run against the built app (vite preview):  python tools/audit_design.py [url] [out.json]
Exit code 1 when a WCAG check fails.
"""
import asyncio, json, os, shutil, sys
from pathlib import Path

JS_AUDIT = r"""
() => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); if (s.visibility === 'hidden' || +s.opacity === 0) return false; return !el.closest('[hidden], [inert], details:not([open]) > :not(summary)'); };
  // Background behind an element: solid colours composited upwards; gradients give their colours (worst one is used).
  const bgs = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      const grad = s.backgroundImage.match(/rgba?\([^)]+\)/g);
      if (grad && /gradient/.test(s.backgroundImage)) { layers.push({ grad: grad.map(parse).filter(Boolean) }); }
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) { layers.push({ c }); if (c.a >= 1 && !(grad && /gradient/.test(s.backgroundImage))) break; }
      if (grad && /gradient/.test(s.backgroundImage) && grad.map(parse).every((g) => g && g.a >= 1)) break;
    }
    let base = [{ r: 255, g: 255, b: 255, a: 1 }];
    for (const L of layers.reverse()) {
      if (L.c) base = base.map((b) => over(L.c, b));
      else base = L.grad.flatMap((g) => base.map((b) => over(g, b)));
    }
    return base;
  };
  const accName = (el) => {
    const t = el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((i) => document.getElementById(i)?.innerText || '').join(' ').trim();
    if (t) return t;
    if (el.labels && el.labels.length) return [...el.labels].map((l) => l.innerText).join(' ').trim();
    if (['BUTTON', 'A', 'SUMMARY'].includes(el.tagName) || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab' || el.getAttribute('role') === 'option') return (el.innerText || el.title || '').trim();
    return (el.title || el.placeholder || '').trim();
  };
  const desc = (el) => { const id = el.id ? '#' + el.id : ''; const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''; return `${el.tagName.toLowerCase()}${id}${cls}`; };
  const out = { contrast: [], small: [], targets: [], names: [], borders: [] };
  // text
  for (const el of document.querySelectorAll('body *')) {
    if (el instanceof SVGElement || !visible(el) || ['SCRIPT', 'STYLE', 'CANVAS', 'SVG', 'svg', 'path', 'OPTION'].includes(el.tagName)) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const isField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
    if (!own && !isField) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color); if (!fg) continue;
    if (el.closest('[aria-disabled="true"]') || el.disabled || el.closest('button:disabled, fieldset:disabled')) continue;
    if (el.closest('.logo, [data-decorative]')) continue;
    const size = parseFloat(s.fontSize), bold = +s.fontWeight >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    const worst = Math.min(...bgs(el).map((b) => ratio(over(fg, b), b)));
    const text = (isField ? (el.value || el.placeholder || '') : (el.innerText ?? el.textContent ?? '')).trim().slice(0, 40);
    if (!text) continue;
    if (worst < need) out.contrast.push({ el: desc(el), text, ratio: +worst.toFixed(2), need, size });
    if (size < 11) out.small.push({ el: desc(el), text, size });
  }
  // controls: target size, names, border contrast
  const ctrls = document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=option], [tabindex]:not([tabindex="-1"])');
  for (const el of ctrls) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const inline = el.tagName === 'A' && getComputedStyle(el).display === 'inline';
    if (!inline && (r.width < 24 || r.height < 24) && el.type !== 'range') {
      // Spacing exception: a 24 px circle around its centre must not hit another target.
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const crowded = [...ctrls].some((o) => o !== el && !o.contains(el) && !el.contains(o) && visible(o) && (() => { const q = o.getBoundingClientRect(); const dx = Math.max(q.left - cx, 0, cx - q.right), dy = Math.max(q.top - cy, 0, cy - q.bottom); return Math.hypot(dx, dy) < 12; })());
      if (crowded) out.targets.push({ el: desc(el), name: accName(el).slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) });
    }
    if (!accName(el) && el.tagName !== 'DIV') out.names.push({ el: desc(el), type: el.type || el.getAttribute('role') || '' });
    const s = getComputedStyle(el);
    const bc = parse(s.borderTopColor), bw = parseFloat(s.borderTopWidth);
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && bw > 0 && bc && bc.a > 0) {
      const around = bgs(el.parentElement);
      const worst = Math.min(...around.map((b) => ratio(over(bc, b), b)));
      if (worst < 3) out.borders.push({ el: desc(el), ratio: +worst.toFixed(2) });
    }
  }
  out.scrollW = document.documentElement.scrollWidth;
  out.viewW = window.innerWidth;
  return out;
}
"""

JS_FOCUS = r"""
async () => {
  const els = [...document.querySelectorAll('button:not([tabindex="-1"]), a[href], input:not([type=hidden]), select, textarea, summary, [tabindex="0"]')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.disabled && !e.closest('[hidden]'); }).slice(0, 80);
  const bad = [];
  const sig = (e) => { const s = getComputedStyle(e); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor].join('|'); };
  for (const e of els) {
    const before = sig(e);
    e.focus({ focusVisible: true });
    if (document.activeElement !== e) continue;
    const after = sig(e);
    const s = getComputedStyle(e);
    if (before === after && s.outlineStyle === 'none') bad.push(e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.getAttribute('class') || '').split(' ')[0]);
    e.blur();
  }
  return { tested: els.length, bad };
}
"""


async def setup(pg, mobile):
    await pg.evaluate("window.__glitch.loadSample()")
    await pg.wait_for_timeout(400)
    await pg.evaluate("window.__glitch.addText()")
    await pg.wait_for_timeout(500)
    if mobile:
        await pg.click("#btn-rack"); await pg.wait_for_timeout(400)
        await pg.click("#tab-layers"); await pg.wait_for_timeout(300)


async def run(browser, url):
    report = {}
    for mobile in (False, True):
        for theme in ("light", "dark"):
            key = f"{'movil-390' if mobile else 'escritorio-1400'}-{theme}"
            vp = {"width": 390, "height": 844} if mobile else {"width": 1400, "height": 1000}
            ctx = await browser.new_context(viewport=vp, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile, color_scheme=theme)
            await ctx.add_init_script(f"try {{ localStorage.setItem('glitch-editor:theme', '{theme}') }} catch {{}}")
            pg = await ctx.new_page()
            await pg.goto(url); await pg.wait_for_load_state("networkidle")
            await setup(pg, mobile)
            res = await pg.evaluate(JS_AUDIT)
            # second pass with the font list open
            await pg.click(".fp-trigger"); await pg.wait_for_timeout(700)
            res2 = await pg.evaluate(JS_AUDIT)
            for k in ("contrast", "small", "targets", "names", "borders"):
                seen = {json.dumps(x, sort_keys=True) for x in res[k]}
                res[k] += [x for x in res2[k] if json.dumps(x, sort_keys=True) not in seen]
            res["focus"] = await pg.evaluate(JS_FOCUS)
            await ctx.close()
            report[key] = res
    # reflow at 320 px
    ctx = await browser.new_context(viewport={"width": 320, "height": 640}, is_mobile=True, has_touch=True)
    pg = await ctx.new_page()
    await pg.goto(url); await pg.wait_for_load_state("networkidle")
    await setup(pg, True)
    report["reflow-320"] = await pg.evaluate("({ scrollW: document.documentElement.scrollWidth, viewW: innerWidth })")
    await ctx.close()
    return report


def summarize(report):
    fails = 0
    for k, r in report.items():
        if k == "reflow-320":
            ok = r["scrollW"] <= r["viewW"]
            fails += not ok
            print(f"[{k}] 1.4.10 reflujo: {'OK' if ok else 'FALLA'} ({r['scrollW']} / {r['viewW']} px)")
            continue
        print(f"\n[{k}]")
        for label, items, wcag in (("1.4.3 contraste de texto", r["contrast"], True), ("1.4.11 borde de campo", r["borders"], True),
                                   ("2.5.8 tamaño de objetivo", r["targets"], True), ("4.1.2 nombre accesible", r["names"], True),
                                   ("2.4.7 foco visible", r["focus"]["bad"], True), ("texto < 11 px", r["small"], False)):
            fails += bool(items) and wcag
            print(f"  {label}: {len(items)}")
            for x in items[:12]:
                print("     ", json.dumps(x, ensure_ascii=False))
    return fails


async def _main():
    from playwright.async_api import async_playwright
    url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
    cands = [os.environ.get("GLITCH_CHROME"), shutil.which("google-chrome"), r"C:\Program Files\Google\Chrome\Application\chrome.exe"]
    chrome = next(c for c in cands if c and Path(c).exists())
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=chrome, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        report = await run(b, url)
        await b.close()
    if len(sys.argv) > 2:
        Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    fails = summarize(report)
    print(f"\n{'sin fallos WCAG' if not fails else f'{fails} grupos con fallos WCAG'}")
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    asyncio.run(_main())
