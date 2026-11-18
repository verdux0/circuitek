#!/usr/bin/env node
/**
 * ONE-TIME extraction of family NAMES, variants and categories from Photopea's font database.
 *
 *   node tools/fonts/extract-photopea-names.mjs [path-to-DBS.js]
 *
 * - Reads Photopea's DBS file (downloaded once, by hand or by this script) only to learn which
 *   families exist and how Photopea categorises them. It never downloads font files and the
 *   output (tools/fonts/.cache/photopea-names.json) is git-ignored: the catalog is not copied
 *   into the repository, it only informs our own catalog built from licensed sources.
 * - Format (documented at https://www.photopea.com/api/fonts, checked 18-11-2026): FNTS.list is
 *   an array of "FF,FSF,PSN,FLG,CAT,URL" strings with "compression": an empty FF/FSF/FLG/CAT
 *   repeats the previous record; PSN "" = FF-FSF without spaces, "a" = FF without spaces;
 *   URL "" = "fs/"+PSN+".otf", "a" = "gf/"+PSN+".otf".
 * - Since the documentation was written the file moved from code/DBS.js (now 404) to a
 *   versioned name referenced by the editor's index page (code/dbs/DBS<number>.js).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, '.cache');

/** Extracts the FNTS object literal from the DBS source (JSON with tabs). */
export function readFnts(src) {
  const i = src.indexOf('FNTS');
  if (i < 0) throw new Error('FNTS not found');
  const start = src.indexOf('{', i);
  let depth = 0;
  let inStr = false;
  for (let k = start; k < src.length; k++) {
    const c = src[k];
    if (inStr) {
      if (c === '\\') k++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(src.slice(start, k + 1));
  }
  throw new Error('FNTS object not closed');
}

/** Expands the compressed records (see header). */
export function decompress(list) {
  const out = [];
  let prev = { ff: '', fsf: '', flg: 0, cat: 0 };
  for (const line of list) {
    const [ff0, fsf0, psn0, flg0, cat0, url0] = line.split(',');
    const ff = ff0 || prev.ff;
    const fsf = fsf0 || prev.fsf;
    const flg = flg0 === '' || flg0 === undefined ? prev.flg : Number(flg0);
    const cat = cat0 === '' || cat0 === undefined ? prev.cat : Number(cat0);
    const psn = psn0 === 'a' ? ff.replace(/ /g, '') : psn0 || `${ff}-${fsf}`.replace(/ /g, '');
    const url = url0 === 'a' ? `gf/${psn}.otf` : url0 || `fs/${psn}.otf`;
    out.push({ ff, fsf, psn, flg, cat, url });
    prev = { ff, fsf, flg, cat };
  }
  return out;
}

/** Groups variants by family: names, subfamilies, categories and the origin folder only. */
export function families(records, cats, subsetNames) {
  const map = new Map();
  for (const r of records) {
    let f = map.get(r.ff);
    if (!f) map.set(r.ff, (f = { family: r.ff, styles: [], categories: new Set(), subsetsFlag: 0, origin: new Set() }));
    f.styles.push(r.fsf);
    f.categories.add(cats[r.cat] ?? `cat${r.cat}`);
    f.subsetsFlag |= r.flg;
    f.origin.add(r.url.split('/')[0]);
  }
  return [...map.values()].map((f) => ({
    family: f.family,
    styles: f.styles,
    categories: [...f.categories],
    subsets: subsetNames.filter((_, b) => f.subsetsFlag & (1 << b)),
    origin: [...f.origin],
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.argv[2] ?? join(cache, 'DBS.js');
  if (!existsSync(path)) {
    console.error(`No DBS file at ${path}. Download it once (see header) and pass its path.`);
    process.exit(1);
  }
  const fnts = readFnts(readFileSync(path, 'utf8'));
  const recs = decompress(fnts.list);
  const fams = families(recs, fnts.cats, fnts.subsetNames);
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'photopea-names.json'), JSON.stringify({ extracted: new Date().toISOString().slice(0, 10), cats: fnts.cats, files: recs.length, families: fams }, null, 1));
  console.log(`${recs.length} font files · ${fams.length} families → tools/fonts/.cache/photopea-names.json`);
}
