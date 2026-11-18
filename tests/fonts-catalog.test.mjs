import { describe, expect, it } from 'vitest';
import { decompress, families, readFnts } from '../tools/fonts/extract-photopea-names.mjs';
import { categoriesFor } from '../tools/fonts/categories.mjs';
import { MAX_FILE_BYTES, validateCatalog } from '../tools/fonts/validate-fonts.mjs';

// Fixture in Photopea's documented DBS format (synthetic names; no Photopea data in the repo).
const DBS = `var X=1;FNTS = {
  "subsetNames": ["Latin-1", "Latin Ext. A", "Greek"],
  "cats": ["Blackletter", "Display", "Sans Serif"],
  "list": [
    "Alpha Sans,Regular,a,3,2,a",
    ",Bold,,,,a",
    "Beta Gothic,Regular,,1,0,",
    "Gamma Pixel,,gamma,,1,ex/gamma.ttf"
  ]
};var Y=2;`;

describe('Photopea catalog parsing (names only)', () => {
  const fnts = readFnts(DBS);
  const recs = decompress(fnts.list);
  it('reads the FNTS object out of the JS source', () => {
    expect(fnts.cats).toEqual(['Blackletter', 'Display', 'Sans Serif']);
    expect(fnts.list.length).toBe(4);
  });
  it('expands the documented compression (inherit, PSN and URL shorthands)', () => {
    expect(recs[0]).toEqual({ ff: 'Alpha Sans', fsf: 'Regular', psn: 'AlphaSans', flg: 3, cat: 2, url: 'gf/AlphaSans.otf' });
    expect(recs[1]).toEqual({ ff: 'Alpha Sans', fsf: 'Bold', psn: 'AlphaSans-Bold', flg: 3, cat: 2, url: 'gf/AlphaSans-Bold.otf' });
    expect(recs[2]).toMatchObject({ ff: 'Beta Gothic', psn: 'BetaGothic-Regular', cat: 0, url: 'fs/BetaGothic-Regular.otf' });
    expect(recs[3]).toMatchObject({ ff: 'Gamma Pixel', fsf: 'Regular', psn: 'gamma', flg: 1, cat: 1, url: 'ex/gamma.ttf' });
  });
  it('groups by family with categories, subsets and origin folder', () => {
    const f = families(recs, fnts.cats, fnts.subsetNames);
    expect(f.map((x) => x.family)).toEqual(['Alpha Sans', 'Beta Gothic', 'Gamma Pixel']);
    expect(f[0]).toEqual({ family: 'Alpha Sans', styles: ['Regular', 'Bold'], categories: ['Sans Serif'], subsets: ['Latin-1', 'Latin Ext. A'], origin: ['gf'] });
    expect(f[1].origin).toEqual(['fs']);
  });
  it('a file without FNTS fails loudly', () => {
    expect(() => readFnts('var nothing = 1;')).toThrow();
  });
});

describe('categories', () => {
  it('maps Photopea and Fontsource categories and adds glitch styles by name', () => {
    expect(categoriesFor({ family: 'Silkscreen', category: 'display' }, [])).toEqual(['display', 'retro', 'pixel']);
    expect(categoriesFor({ family: 'UnifrakturMaguntia', category: 'display' }, ['Blackletter'])).toEqual(['display', 'gotica']);
    expect(categoriesFor({ family: 'Rubik Glitch', category: 'display' }, ['Display'])).toEqual(['display', 'experimental']);
    expect(categoriesFor({ family: 'Inter', category: 'sans-serif' }, ['Sans Serif'])).toEqual(['sans']);
    expect(categoriesFor({ family: 'Big Shoulders Stencil', category: 'display' }, [])).toContain('stencil');
  });
});

describe('validateCatalog', () => {
  const ok = () => ({
    version: 1,
    families: [{
      id: 'alpha', family: 'Alpha', categories: ['display'], source: 'fontsource', package: { name: '@fontsource/alpha', version: '5.0.0' },
      license: { id: 'OFL-1.1', url: 'https://openfontlicense.org', author: 'X', file: 'licenses/alpha/LICENSE.txt' },
      redistributable: true, variable: false, subsets: ['latin'],
      variants: [{ style: 'normal', weight: 400, format: 'woff2', files: [{ subset: 'latin', file: 'files/alpha/normal-400-latin.woff2', bytes: 1000 }] }],
      photopea: { matched: true, name: 'Alpha' }, substituteFor: null,
    }],
  });
  const files = { 'licenses/alpha/LICENSE.txt': 'SIL Open Font License '.repeat(20), 'files/alpha/normal-400-latin.woff2': 'wOF2' + 'x'.repeat(996) };
  const io = (fs = files) => ({ exists: (r) => r in fs, size: (r) => fs[r].length, head: (r) => fs[r].slice(0, 4), text: (r) => fs[r] });
  it('a good catalog passes', () => {
    expect(validateCatalog(ok(), io(), '| Alpha | OFL-1.1 |')).toEqual([]);
  });
  it('catches missing licence text, disallowed licences and missing THIRD-PARTY rows', () => {
    const c = ok();
    c.families[0].license.id = 'Proprietary';
    expect(validateCatalog(c, io(), '| Alpha |').join()).toMatch(/licencia no permitida/);
    const noLic = { ...files };
    delete noLic['licenses/alpha/LICENSE.txt'];
    expect(validateCatalog(ok(), io(noLic), '| Alpha |').join()).toMatch(/falta el texto de la licencia/);
    expect(validateCatalog(ok(), io(), '').join()).toMatch(/falta en THIRD-PARTY/);
  });
  it('catches duplicates, missing / wrong-size / non-WOFF2 / oversized files and bad paths', () => {
    const dup = ok();
    dup.families.push({ ...dup.families[0] });
    expect(validateCatalog(dup, io(), null).join()).toMatch(/duplicado/);
    const c = ok();
    c.families[0].variants[0].files[0].bytes = 5;
    expect(validateCatalog(c, io(), null).join()).toMatch(/mide 1000 B/);
    expect(validateCatalog(ok(), io({ ...files, 'files/alpha/normal-400-latin.woff2': 'OTTO' + 'x'.repeat(996) }), null).join()).toMatch(/no es WOFF2/);
    const big = ok();
    const huge = 'wOF2' + 'x'.repeat(MAX_FILE_BYTES);
    big.families[0].variants[0].files[0].bytes = huge.length;
    expect(validateCatalog(big, io({ ...files, 'files/alpha/normal-400-latin.woff2': huge }), null).join()).toMatch(/supera 300 KB/);
    const bad = ok();
    bad.families[0].variants[0].files[0].file = 'files/other/../../x.woff2';
    expect(validateCatalog(bad, io(), null).join()).toMatch(/ruta no válida/);
  });
  it('variable fonts need a weight range, static ones a single weight', () => {
    const c = ok();
    c.families[0].variable = true;
    expect(validateCatalog(c, io(), null).join()).toMatch(/no concuerda con variable/);
    c.families[0].variants[0].weight = [100, 900];
    expect(validateCatalog(c, io(), null)).toEqual([]);
  });
});
