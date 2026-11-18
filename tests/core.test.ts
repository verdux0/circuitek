import { describe, expect, it } from 'vitest';
import { mixSeed, mulberry32 } from '../src/prng';
import { PAIRS, PINS, buildGpuPasses, defaultState, encParams, findPair, parsePresetFile, sanitizeState, stageActive, toPresetFile } from '../src/model';
import { FACTORY_PRESETS, randomState, variantOf } from '../src/presets';
import { corruptJpegBytes, corruptionCount, findScanStart, pixelSort } from '../src/encoder/bytes';
import { History } from '../src/history';

describe('PRNG', () => {
  it('same seed -> same sequence', () => {
    const a = mulberry32(42), b = mulberry32(42);
    for (let i = 0; i < 1000; i++) expect(a()).toBe(b());
  });
  it('different seeds diverge and values stay in [0,1)', () => {
    const a = mulberry32(1), b = mulberry32(2);
    let same = 0;
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      if (x === b()) same++;
    }
    expect(same).toBe(0);
  });
  it('known first value (regression across platforms)', () => {
    expect(mulberry32(1337)()).toBe(0.1844118325971067);
    expect(mixSeed(1, 2)).toBe(mixSeed(1, 2));
    expect(mixSeed(1, 2)).not.toBe(mixSeed(2, 1));
  });
});

describe('CCD model', () => {
  it('has exactly 15 unique pairs covering all pin combinations', () => {
    expect(PAIRS).toHaveLength(15);
    expect(new Set(PAIRS.map((p) => p.mode)).size).toBe(15);
    for (let i = 0; i < PINS.length; i++)
      for (let j = 0; j < PINS.length; j++) {
        const p = findPair(PINS[i], PINS[j]);
        if (i === j) expect(p).toBeUndefined();
        else expect(p).toBeDefined();
        expect(findPair(PINS[i], PINS[j])).toBe(findPair(PINS[j], PINS[i]));
      }
  });
  it('default state: one cable pass, no neutral stages', () => {
    const s = defaultState();
    const passes = buildGpuPasses(s);
    expect(passes).toHaveLength(1);
    expect(passes[0].pass).toBe(0);
    expect(encParams(s)).toBeNull();
    for (const id of ['bus', 'buffer', 'proc', 'enc'] as const) expect(stageActive(s, id)).toBe(false);
  });
  it('bypass removes the pass, params enable it', () => {
    const s = defaultState();
    s.stages.bus.p.bits = 4;
    expect(buildGpuPasses(s).map((p) => p.pass)).toEqual([0, 1]);
    s.stages.bus.on = false;
    expect(buildGpuPasses(s).map((p) => p.pass)).toEqual([0]);
  });
  it('effect 0 -> cables produce no pass', () => {
    const s = defaultState();
    s.effect = 0;
    expect(buildGpuPasses(s)).toHaveLength(0);
  });
});

describe('serialization', () => {
  it('preset round trip is lossless', () => {
    for (const p of FACTORY_PRESETS) {
      const back = parsePresetFile(JSON.stringify(toPresetFile(p.name, p.state)));
      expect(back.state).toEqual(p.state);
      expect(back.name).toBe(p.name);
    }
  });
  it('sanitize clamps, drops invalid cables and duplicates, caps at 3', () => {
    const s = sanitizeState({
      seed: -5, effect: 400, filter: 'x',
      cables: [
        { a: 'RG', b: 'TG', amount: 50 }, { a: 'TG', b: 'RG', amount: 10 }, { a: 'RG', b: 'RG' },
        { a: 'FOO', b: 'TG' }, { a: 'SUB', b: 'OD' }, { a: 'AB', b: 'HCLK', amount: 999 }, { a: 'OD', b: 'TG' },
      ],
      stages: { bus: { on: false, p: { bits: 0, rot: 3.7 } } },
    });
    expect(s.seed).toBe(0);
    expect(s.effect).toBe(100);
    expect(s.filter).toBe(50);
    expect(s.cables.map((c) => `${c.a}+${c.b}`)).toEqual(['RG+TG', 'SUB+OD', 'AB+HCLK']);
    expect(s.cables[2].amount).toBe(100);
    expect(s.stages.bus.on).toBe(false);
    expect(s.stages.bus.p.bits).toBe(1);
    expect(s.stages.bus.p.rot).toBe(4);
  });
  it('accepts a bare state as preset file', () => {
    const s = defaultState();
    expect(parsePresetFile(JSON.stringify(s)).state).toEqual(s);
  });
  it('garbage -> default state', () => {
    expect(sanitizeState(null)).toEqual(defaultState());
    expect(() => parsePresetFile('not json')).toThrow();
  });
});

describe('randomize / variants', () => {
  it('are deterministic for a seed and always valid', () => {
    for (let seed = 1; seed < 60; seed++) {
      const a = randomState(seed);
      expect(randomState(seed)).toEqual(a);
      expect(sanitizeState(a)).toEqual(a);
      expect(a.cables.length).toBeGreaterThanOrEqual(1);
      const v = variantOf(a, seed * 31);
      expect(variantOf(a, seed * 31)).toEqual(v);
      expect(sanitizeState(v)).toEqual(v);
    }
  });
});

describe('history', () => {
  it('undo / redo', () => {
    const h = new History();
    const a = defaultState();
    const b = { ...defaultState(), effect: 80 };
    h.push(a);
    const back = h.undo(b)!;
    expect(back.effect).toBe(50);
    expect(h.redo(back)!.effect).toBe(80);
    expect(h.redo(b)).toBeNull();
  });
});

/** Minimal JPEG-like stream: SOI, a fake DQT, SOS header, scan bytes, EOI. */
function fakeJpeg(scanLen: number): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x01, 0x02, 0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6];
  const scan = Array.from({ length: scanLen }, (_, i) => (i * 37) % 0xfe);
  scan[10] = 0xff; scan[11] = 0x00; // byte stuffing
  return new Uint8Array([...head, ...scan, 0xff, 0xd9]);
}

describe('JPEG databending', () => {
  it('finds the scan start after the SOS header', () => {
    expect(findScanStart(fakeJpeg(50))).toBe(18);
    expect(findScanStart(new Uint8Array([0xff, 0xd8, 0, 0]))).toBe(-1);
  });
  it('never touches headers, markers, stuffing or EOI; deterministic', () => {
    const src = fakeJpeg(400);
    const a = corruptJpegBytes(src, 200, mulberry32(9));
    const b = corruptJpegBytes(src, 200, mulberry32(9));
    expect(a).toEqual(b);
    expect([...a.slice(0, 18)]).toEqual([...src.slice(0, 18)]);
    expect([...a.slice(-2)]).toEqual([0xff, 0xd9]);
    expect(a[18 + 10]).toBe(0xff);
    expect(a[18 + 11]).toBe(0x00);
    let changed = 0;
    for (let i = 18; i < a.length - 2; i++) {
      if (a[i] !== src[i]) changed++;
      if (src[i] !== 0xff) expect(a[i]).not.toBe(0xff);
    }
    expect(changed).toBeGreaterThan(50);
    expect(src).toEqual(fakeJpeg(400)); // input untouched
  });
  it('corruption count grows with the knob', () => {
    expect(corruptionCount(0, mulberry32(1))).toBe(0);
    const avg = (amt: number) => { const r = mulberry32(5); let t = 0; for (let i = 0; i < 500; i++) t += corruptionCount(amt, r); return t / 500; };
    expect(avg(100)).toBeGreaterThan(avg(10));
  });
});

describe('pixel sort', () => {
  const make = (w: number, h: number) => {
    const r = mulberry32(3);
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < d.length; i++) d[i] = (i & 3) === 3 ? 255 : Math.floor(r() * 256);
    return d;
  };
  const multiset = (d: Uint8ClampedArray) => {
    const px: string[] = [];
    for (let i = 0; i < d.length; i += 4) px.push(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return px.sort().join('|');
  };
  it('only reorders pixels (no new colors) and is deterministic, in all 4 directions', () => {
    for (let dir = 0; dir < 4; dir++) {
      const a = make(40, 30), b = make(40, 30), orig = make(40, 30);
      pixelSort(a, 40, 30, 0.3, 0.9, dir);
      pixelSort(b, 40, 30, 0.3, 0.9, dir);
      expect(a).toEqual(b);
      expect(a).not.toEqual(orig);
      expect(multiset(a)).toBe(multiset(orig));
    }
  });
  it('threshold 1 leaves the image untouched', () => {
    const a = make(20, 20), orig = make(20, 20);
    pixelSort(a, 20, 20, 1.01, 1, 0);
    expect(a).toEqual(orig);
  });
});
