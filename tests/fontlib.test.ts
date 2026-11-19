import { describe, expect, it } from 'vitest';
import { LoadQueue, missingChars, normalizeQuery, parseUnicodeRange, pickVariant, pushRecent, readList, searchFonts, variantChoices, variantWeights, writeList, type FontVariant } from '../src/fontlib';
import { sanitizeDoc } from '../src/doc';
import { cssFont, textWeight } from '../src/text';

const fam = (family: string, categories: string[]) => ({ family, categories });
const LIST = [fam('Anton', ['display', 'sans']), fam('Ánfora Script', ['script']), fam('Bebas Neue', ['display']), fam('Space Mono', ['mono']), fam('UnifrakturMaguntia', ['gotica', 'display'])];

describe('search and filter', () => {
  it('normalizes case, accents and spaces', () => {
    expect(normalizeQuery('  ÁNFORA   script ')).toBe('anfora script');
  });
  it('is case/accent-insensitive, prefix matches first, ignores spaces', () => {
    expect(searchFonts(LIST, 'anf').map((f) => f.family)).toEqual(['Ánfora Script']);
    expect(searchFonts(LIST, 'NEUE').map((f) => f.family)).toEqual(['Bebas Neue']);
    expect(searchFonts(LIST, 'spacemono').map((f) => f.family)).toEqual(['Space Mono']);
    expect(searchFonts(LIST, 'an').map((f) => f.family)).toEqual(['Anton', 'Ánfora Script']);
    expect(searchFonts(LIST, 'frak').map((f) => f.family)).toEqual(['UnifrakturMaguntia']);
  });
  it('filters by any of the selected categories (families can have several)', () => {
    expect(searchFonts(LIST, '', ['gotica']).map((f) => f.family)).toEqual(['UnifrakturMaguntia']);
    expect(searchFonts(LIST, '', ['display']).length).toBe(3);
    expect(searchFonts(LIST, 'bebas', ['mono'])).toEqual([]);
  });
  it('handles thousands of families quickly', () => {
    const big = Array.from({ length: 5000 }, (_, i) => fam(`Familia ${i}`, [i % 2 ? 'sans' : 'display']));
    const t = performance.now();
    expect(searchFonts(big, 'familia 49', ['display']).length).toBeGreaterThan(0);
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe('variants', () => {
  const stat: FontVariant[] = [
    { style: 'normal', weight: 400, format: 'woff2', files: [] },
    { style: 'normal', weight: 700, format: 'woff2', files: [] },
    { style: 'italic', weight: 400, format: 'woff2', files: [] },
  ];
  const vari: FontVariant[] = [{ style: 'normal', weight: [250, 900], format: 'woff2', files: [] }];
  it('a variable range is offered in steps of 100 inside the range', () => {
    expect(variantWeights(vari[0])).toEqual([300, 400, 500, 600, 700, 800, 900]);
    expect(variantChoices({ variants: stat })).toEqual([{ weight: 400, italic: false }, { weight: 700, italic: false }, { weight: 400, italic: true }]);
  });
  it('picks the same style first, then the nearest weight; variable clamps into its range', () => {
    expect(pickVariant({ variants: stat }, 800, false)).toMatchObject({ weight: 700, italic: false });
    expect(pickVariant({ variants: stat }, 700, true)).toMatchObject({ weight: 400, italic: true });
    expect(pickVariant({ variants: vari }, 100, false)).toMatchObject({ weight: 250, italic: false });
    expect(pickVariant({ variants: vari }, 650, true)).toMatchObject({ weight: 650, italic: false });
    expect(pickVariant({ variants: [] }, 400, false)).toBeNull();
  });
  it('cssFont uses the exact weight when set, else bold → 700 / 400', () => {
    expect(textWeight({ bold: true })).toBe(700);
    expect(textWeight({ bold: true, weight: 300 })).toBe(300);
    expect(cssFont({ font: 'Oswald', size: 10, bold: false, italic: true, weight: 600 })).toBe('italic 600 10px "Oswald", sans-serif');
  });
});

describe('glyph coverage', () => {
  const ranges = { latin: 'U+0000-00FF, U+0131, U+20AC', 'latin-ext': 'U+0100-024F, U+1E??' };
  it('parses unicode-range lists including wildcards', () => {
    expect(parseUnicodeRange('U+0000-00FF, U+0131, U+1E??')).toEqual([[0, 0xff], [0x131, 0x131], [0x1e00, 0x1eff]]);
  });
  it('reports characters no subset covers, once, ignoring spaces', () => {
    expect(missingChars('Ñandú €', ['latin'], ranges)).toEqual([]);
    expect(missingChars('Łódź ★ ★', ['latin'], ranges)).toEqual(['Ł', 'ź', '★']);
    expect(missingChars('Łódź ★', ['latin', 'latin-ext'], ranges)).toEqual(['★']);
    expect(missingChars('Привет', ['latin'], null)).toEqual([]);
  });
});

describe('favourites / recents storage', () => {
  it('survives missing, broken and throwing storage', () => {
    expect(readList(null, 'k')).toEqual([]);
    expect(readList({ getItem: () => '{not json' }, 'k')).toEqual([]);
    expect(readList({ getItem: () => { throw new Error('SecurityError'); } }, 'k')).toEqual([]);
    expect(readList({ getItem: () => '["a",3,"b"]' }, 'k')).toEqual(['a', 'b']);
    expect(() => writeList({ setItem: () => { throw new Error('QuotaExceeded'); } }, 'k', ['a'])).not.toThrow();
  });
  it('recents: newest first, no duplicates, capped', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pushRecent(['a', 'b'], 'z', 2)).toEqual(['z', 'a']);
  });
});

describe('load queue', () => {
  it('never runs more jobs at once than its limit', async () => {
    const q = new LoadQueue(3);
    let live = 0;
    let peak = 0;
    const done: number[] = [];
    await new Promise<void>((resolve) => {
      for (let i = 0; i < 10; i++) {
        q.push(async () => {
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 2));
          live--;
          done.push(i);
          if (done.length === 10) resolve();
        });
      }
    });
    expect(peak).toBe(3);
  });
});

describe('text schema migration (fontId / weight)', () => {
  const layer = (text: Record<string, unknown>) => ({ w: 100, h: 100, layers: [{ id: 'L1', src: 'T|x', w: 10, h: 10, text }] });
  it('old documents (no fontId) open unchanged and keep the family', () => {
    const d = sanitizeDoc(layer({ content: 'Hola', font: 'Anton', size: 40, bold: true }));
    expect(d.layers[0].text).toMatchObject({ content: 'Hola', font: 'Anton', bold: true });
    expect(d.layers[0].text && 'fontId' in d.layers[0].text).toBe(false);
    expect(d.layers[0].text && 'weight' in d.layers[0].text).toBe(false);
  });
  it('new documents keep fontId and weight, also for a font that no longer exists', () => {
    const d = sanitizeDoc(layer({ content: 'x', font: 'Fuente Borrada', fontId: 'fuente-borrada', weight: 350.4 }));
    expect(d.layers[0].text).toMatchObject({ font: 'Fuente Borrada', fontId: 'fuente-borrada', weight: 350 });
  });
  it('drops malformed values', () => {
    const d = sanitizeDoc(layer({ content: 'x', font: 'A', fontId: 'a\u0000b', weight: 'bold' }));
    expect(d.layers[0].text?.fontId).toBeUndefined();
    expect(d.layers[0].text?.weight).toBeUndefined();
    expect(sanitizeDoc(layer({ content: 'x', font: 'A', weight: 5000 })).layers[0].text?.weight).toBe(1000);
  });
});
