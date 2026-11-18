#!/usr/bin/env node
/**
 * Builds the bundled font library from LICENSED sources (Fontsource packages on npm, served
 * by jsDelivr's npm mirror). Photopea's catalog (tools/fonts/.cache/photopea-names.json) is
 * used only for names and categories; nothing is downloaded from Photopea.
 *
 *   node tools/fonts/build-catalog.mjs            # select + download + write catalog
 *   node tools/fonts/build-catalog.mjs --dry-run  # selection and sizes only
 *
 * Inputs (tools/fonts/.cache/, git-ignored): photopea-names.json and match.json (from
 * extract-photopea-names.mjs + the matching step), fontsource.json (api.fontsource.org/v1/fonts),
 * gf-metadata.json (fonts.google.com/metadata/fonts: popularity only).
 * Outputs: public/fonts/{catalog/fonts.json, catalog/categories.json, files/<id>/…, licenses/<id>/LICENSE.txt}
 * and the generated font section of THIRD-PARTY.md.
 *
 * Budget (decision gate 1, option C): 400 families = 300 stylised + 75 basic + 25 mono,
 * subsets latin + latin-ext, WOFF2, no file above 300 KB.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_LABELS, categoriesFor } from './categories.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const cache = join(here, '.cache');
const out = join(root, 'public', 'fonts');
const DRY = process.argv.includes('--dry-run');

export const BUDGET = { stylised: 300, basic: 75, mono: 25 };
export const MAX_FILE = 300 * 1024;
const SUBSETS = ['latin', 'latin-ext'];
const LICENSES = new Set(['OFL-1.1', 'Apache-2.0', 'UFL-1.0', 'CC0-1.0', 'MIT', 'mit', 'Unlicense']);

/** The fonts the app bundled before the library: always kept (old projects use them). */
const KEEP = ['Anton', 'Bebas Neue', 'VT323', 'Press Start 2P', 'Space Mono', 'Permanent Marker', 'Playfair Display'];
/** Photopea names that differ in Google Fonts / Fontsource (phase 1: 11 families). */
const RENAMES = {
  'Asap Condensed Condensed': 'Asap Condensed', Baloo: 'Baloo 2', 'IM FELL DW': 'IM Fell DW Pica', 'IM FELL Double': 'IM Fell Double Pica',
  'Libre Barcode': 'Libre Barcode 39', Londrina: 'Londrina Solid', Love: 'Love Ya Like A Sister', 'Mochiy Pop': 'Mochiy Pop One',
  'Nanum Pen': 'Nanum Pen Script', 'Rounded Mplus 1c': 'M PLUS Rounded 1c', 'Shadows Into': 'Shadows Into Light',
};
/**
 * Open fonts that are NOT in Photopea's catalog, added to fill the categories Photopea only
 * covers with unlicensed fonts (pixel, blackletter, stencil, retro, graffiti, experimental).
 */
const COMPLEMENT = [
  'Silkscreen', 'Pixelify Sans', 'DotGothic16', 'Jersey 10', 'Micro 5', 'Tiny5', 'Sixtyfour', 'Workbench', 'Bytesized', 'Jacquarda Bastarda 9',
  'UnifrakturMaguntia', 'UnifrakturCook', 'Pirata One', 'Grenze Gotisch', 'New Rocker', 'Jacquard 24', 'Texturina', 'Metal Mania', 'Germania One', 'Fruktur',
  'Big Shoulders Stencil', 'Saira Stencil One', 'Stardos Stencil', 'Allerta Stencil', 'Emblema One', 'Black Ops One', 'Sirin Stencil',
  'Monoton', 'Bungee', 'Bungee Shade', 'Righteous', 'Faster One', 'Audiowide', 'Orbitron', 'Major Mono Display', 'Tilt Neon', 'Tilt Prism', 'Nabla', 'Shrikhand', 'Rampart One',
  'Rubik Glitch', 'Rubik Wet Paint', 'Rubik Burned', 'Rubik Puddles', 'Rubik Microbe', 'Rubik Maze', 'Rubik Vinyl', 'Rubik Distressed', 'Rubik Spray Paint',
  'Rubik Doodle Shadow', 'Rubik Iso', 'Rubik Moonrocks', 'Rubik Beastly', 'Rubik 80s Fade', 'Bungee Spice', 'Kablammo', 'Honk', 'Moirai One', 'Foldit', 'Danfo', 'Bungee Tint',
  'Sedgwick Ave', 'Sedgwick Ave Display', 'Rock Salt', 'Finger Paint', 'Special Elite', 'Courier Prime', 'Cutive Mono', 'Bangers', 'Luckiest Guy',
];

const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\)\]\}'/, ''));

async function getJson(url, tries = 4) {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    if (i >= tries || (r.status !== 429 && r.status < 500)) throw new Error(`${r.status} ${url}`);
    await new Promise((res) => setTimeout(res, 800 * (i + 1)));
  }
}
async function getBytes(url, tries = 4) {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
    if (i >= tries || (r.status !== 429 && r.status < 500)) throw new Error(`${r.status} ${url}`);
    await new Promise((res) => setTimeout(res, 800 * (i + 1)));
  }
}
/** Small promise pool. */
async function pool(items, n, fn) {
  const res = new Array(items.length);
  let k = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (k < items.length) {
      const i = k++;
      res[i] = await fn(items[i], i);
    }
  }));
  return res;
}

/** Files of an npm package (jsDelivr listing): name → size. */
async function listing(pkg) {
  const { version } = await getJson(`https://data.jsdelivr.com/v1/packages/npm/${pkg}/resolved`);
  const { files } = await getJson(`https://data.jsdelivr.com/v1/packages/npm/${pkg}@${version}?structure=flat`);
  return { version, files: new Map(files.map((f) => [f.name, f.size])) };
}

/** Chooses the variant files of one family within the size limit. */
async function planFamily(f) {
  const want = (has, name) => has.get(`/files/${name}`);
  // Variable first: one file per subset (and per style) covers every weight.
  if (f.variable) {
    try {
      const pkg = `@fontsource-variable/${f.id}`;
      const L = await listing(pkg);
      const axis = [...L.files.keys()].some((n) => n.includes(`-latin-wght-normal.woff2`)) ? 'wght' : [...L.files.keys()].some((n) => n.includes('-latin-standard-normal.woff2')) ? 'standard' : null;
      if (axis) {
        const variants = [];
        for (const style of f.styles.filter((s) => s === 'normal' || s === 'italic')) {
          const files = SUBSETS.filter((s) => f.subsets.includes(s)).map((s) => ({ subset: s, src: `${f.id}-${s}-${axis}-${style}.woff2` })).filter((x) => want(L.files, x.src));
          if (!files.length || files.some((x) => want(L.files, x.src) > MAX_FILE)) continue;
          variants.push({ style, weight: [Math.min(...f.weights), Math.max(...f.weights)], files: files.map((x) => ({ ...x, bytes: want(L.files, x.src) })) });
        }
        if (variants.length) return { pkg, version: L.version, variable: true, variants };
      }
    } catch {
      /* no variable package: fall back to static files */
    }
  }
  const pkg = `@fontsource/${f.id}`;
  const L = await listing(pkg);
  const w400 = f.weights.includes(400) ? 400 : f.weights.reduce((a, b) => (Math.abs(b - 400) < Math.abs(a - 400) ? b : a));
  const weights = [w400, ...(f.weights.includes(700) && w400 !== 700 ? [700] : [])];
  const variants = [];
  const dropped = [];
  for (const style of f.styles.filter((s) => s === 'normal' || s === 'italic')) {
    for (const w of weights) {
      const files = SUBSETS.filter((s) => f.subsets.includes(s)).map((s) => ({ subset: s, src: `${f.id}-${s}-${w}-${style}.woff2` })).filter((x) => want(L.files, x.src));
      if (!files.length) continue;
      if (files.some((x) => want(L.files, x.src) > MAX_FILE)) {
        dropped.push(`${style} ${w}`);
        continue;
      }
      variants.push({ style, weight: w, files: files.map((x) => ({ ...x, bytes: want(L.files, x.src) })) });
    }
  }
  return { pkg, version: L.version, variable: false, variants, dropped };
}

async function main() {
  const fsrc = readJson(join(cache, 'fontsource.json'));
  const match = readJson(join(cache, 'match.json'));
  const gf = new Map(readJson(join(cache, 'gf-metadata.json')).familyMetadataList.map((g) => [norm(g.family), g]));
  const byName = new Map(fsrc.map((f) => [norm(f.family), f]));
  const pop = (f) => gf.get(norm(f.family))?.popularity ?? 99999;

  // Candidates: Photopea families with an open source (+ renamed ones), plus the complement.
  const cand = new Map();
  for (const m of match) {
    const name = m.status === 'fontsource' ? m.family : RENAMES[m.family];
    const f = name && byName.get(norm(name));
    if (!f) continue;
    if (!cand.has(f.id)) cand.set(f.id, { f, photopea: { matched: true, name: m.family }, ppCats: m.categories, complement: false });
  }
  for (const n of COMPLEMENT) {
    const f = byName.get(norm(n));
    if (f && !cand.has(f.id)) cand.set(f.id, { f, photopea: { matched: false, name: null }, ppCats: [], complement: true });
  }
  const usable = [...cand.values()].filter((c) => c.f.subsets.includes('latin') && LICENSES.has(c.f.license));
  for (const c of usable) c.categories = categoriesFor(c.f, c.ppCats);
  const isMono = (c) => c.categories.includes('mono');
  const isBasic = (c) => !isMono(c) && c.categories.every((x) => ['sans', 'serif', 'slab'].includes(x));
  const keep = usable.filter((c) => KEEP.some((k) => norm(k) === norm(c.f.family)));
  const keepIds = new Set(keep.map((c) => c.f.id));
  const comp = usable.filter((c) => c.complement || COMPLEMENT.some((n) => norm(n) === norm(c.f.family)));
  const rank = (arr) => arr.filter((c) => !keepIds.has(c.f.id)).sort((a, b) => pop(a.f) - pop(b.f));
  const chosen = new Map();
  const add = (c) => chosen.set(c.f.id, c);
  keep.forEach(add);
  comp.forEach(add);
  const quota = (pred, n) => {
    for (const c of rank(usable.filter(pred))) {
      if ([...chosen.values()].filter(pred).length >= n) break;
      add(c);
    }
  };
  quota((c) => !isMono(c) && !isBasic(c), BUDGET.stylised);
  quota(isBasic, BUDGET.basic);
  quota(isMono, BUDGET.mono);
  const selected = [...chosen.values()];
  console.log(`candidatas ${usable.length} · elegidas ${selected.length} (estilizadas ${selected.filter((c) => !isMono(c) && !isBasic(c)).length}, básicas ${selected.filter(isBasic).length}, mono ${selected.filter(isMono).length}; complemento fuera de Photopea ${selected.filter((c) => c.complement).length})`);

  // Variant plan (listings only).
  const excluded = [];
  const plans = await pool(selected, 6, async (c) => {
    try {
      const p = await planFamily(c.f);
      if (!p.variants.length) excluded.push({ family: c.f.family, reason: `ninguna variante cabe en ${MAX_FILE / 1024} KB` });
      return p.variants.length ? { c, p } : null;
    } catch (e) {
      excluded.push({ family: c.f.family, reason: `listado no disponible (${e.message})` });
      return null;
    }
  });
  const ok = plans.filter(Boolean);
  const bytes = ok.reduce((s, { p }) => s + p.variants.reduce((t, v) => t + v.files.reduce((u, x) => u + x.bytes, 0), 0), 0);
  const nfiles = ok.reduce((s, { p }) => s + p.variants.reduce((t, v) => t + v.files.length, 0), 0);
  console.log(`familias con variantes: ${ok.length} · ${nfiles} archivos WOFF2 · ${(bytes / 1048576).toFixed(1)} MB · excluidas al planificar: ${excluded.length}`);
  if (DRY) return;

  // Download fonts + licence + metadata (attribution).
  mkdirSync(join(out, 'catalog'), { recursive: true });
  const records = await pool(ok, 6, async ({ c, p }) => {
    const id = c.f.id;
    const base = `https://cdn.jsdelivr.net/npm/${p.pkg}@${p.version}`;
    const meta = await getJson(`${base}/metadata.json`);
    const licDir = join(out, 'licenses', id);
    mkdirSync(licDir, { recursive: true });
    const licPath = join(licDir, 'LICENSE.txt');
    if (!existsSync(licPath)) writeFileSync(licPath, await getBytes(`${base}/LICENSE`));
    const variants = [];
    for (const v of p.variants) {
      const files = [];
      for (const x of v.files) {
        const w = Array.isArray(v.weight) ? 'wght' : v.weight;
        const rel = `files/${id}/${v.style}-${w}-${x.subset}.woff2`;
        const dst = join(out, rel);
        mkdirSync(dirname(dst), { recursive: true });
        if (!existsSync(dst) || statSync(dst).size !== x.bytes) writeFileSync(dst, await getBytes(`${base}/files/${x.src}`));
        files.push({ subset: x.subset, file: rel, bytes: statSync(dst).size });
      }
      variants.push({ style: v.style, weight: v.weight, format: 'woff2', files });
    }
    const lic = meta.license ?? {};
    return {
      id,
      family: c.f.family,
      categories: c.categories,
      source: 'fontsource',
      package: { name: p.pkg, version: p.version },
      license: { id: typeof lic.type === 'string' ? lic.type : c.f.license, url: lic.url ?? null, author: lic.attribution ?? null, file: `licenses/${id}/LICENSE.txt` },
      upstream: meta.source ?? null,
      redistributable: true,
      variable: p.variable,
      subsets: SUBSETS.filter((s) => c.f.subsets.includes(s)),
      variants,
      photopea: c.photopea,
      substituteFor: null,
    };
  });
  // Unicode ranges of the two subsets (identical across Fontsource packages).
  const ur = await getJson(`https://cdn.jsdelivr.net/npm/@fontsource/anton@5.3.0/unicode.json`).catch(() => null);
  records.sort((a, b) => a.family.localeCompare(b.family));
  const catalog = { version: 1, generated: new Date().toISOString().slice(0, 10), budget: { ...BUDGET, maxFileBytes: MAX_FILE }, unicodeRanges: ur ? { latin: ur.latin, 'latin-ext': ur['latin-ext'] } : null, families: records };
  writeFileSync(join(out, 'catalog', 'fonts.json'), JSON.stringify(catalog));
  const counts = {};
  for (const r of records) for (const k of r.categories) counts[k] = (counts[k] ?? 0) + 1;
  writeFileSync(join(out, 'catalog', 'categories.json'), JSON.stringify(Object.keys(CATEGORY_LABELS).filter((k) => counts[k]).map((k) => ({ id: k, label: CATEGORY_LABELS[k], count: counts[k] })), null, 1));
  writeFileSync(join(cache, 'excluded-build.json'), JSON.stringify(excluded, null, 1));
  writeThirdParty(records);
  const total = records.reduce((s, r) => s + r.variants.reduce((t, v) => t + v.files.reduce((u, x) => u + x.bytes, 0), 0), 0);
  console.log(`escrito: ${records.length} familias · ${(total / 1048576).toFixed(1)} MB de WOFF2 → public/fonts/`);
}

/** Regenerates the font section of THIRD-PARTY.md between its markers. */
function writeThirdParty(records) {
  const p = join(root, 'THIRD-PARTY.md');
  const src = readFileSync(p, 'utf8');
  const start = '<!-- fonts:start -->';
  const end = '<!-- fonts:end -->';
  const rows = records.map((r) => `| ${r.family} | ${r.license.id} | ${(r.license.author ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 160)} | ${r.package.name}@${r.package.version} | \`public/fonts/${r.license.file}\` |`);
  const block = `${start}
## Biblioteca de tipografías (generado por \`tools/fonts/build-catalog.mjs\`; no editar a mano)

${records.length} familias, todas con licencia abierta que permite redistribuirlas. El texto de cada licencia va junto a sus archivos en \`public/fonts/licenses/<id>/LICENSE.txt\` (la OFL exige distribuirlo con la fuente). Origen de los archivos: paquetes de Fontsource en npm (vía el espejo de jsDelivr), sin modificar. Del catálogo de Photopea solo se tomaron nombres y categorías.

| Familia | Licencia | Autor / copyright | Paquete | Licencia completa |
|---|---|---|---|---|
${rows.join('\n')}
${end}`;
  const next = src.includes(start) ? src.replace(new RegExp(`${start}[\\s\\S]*?${end}`), block) : `${src.trimEnd()}\n\n${block}\n`;
  writeFileSync(p, next);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
