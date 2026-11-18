import { describe, expect, it } from 'vitest';
import { stateAtFrame } from '../src/motion';
import { defaultState } from '../src/model';
import { frameSeed } from '../src/media/timing';

describe('stateAtFrame (one function for preview and export)', () => {
  const base = defaultState();
  it('stopped (frame undefined) or not animated → the base state itself, untouched', () => {
    expect(stateAtFrame(base, undefined, 60, true)).toBe(base);
    expect(stateAtFrame(base, 7, 60, false)).toBe(base);
  });
  it('Parpadeo: frame N uses frameSeed(seed, N) — the same noise the export always used', () => {
    for (const n of [0, 1, 37, 59]) expect(stateAtFrame(base, n, 60, true).seed).toBe(frameSeed(base.seed, n, true));
  });
  it('deterministic: same seed + same frame → same state', () => {
    expect(stateAtFrame(base, 12, 60, true)).toEqual(stateAtFrame(base, 12, 60, true));
  });
  it('periodic with the loop: frame N + loop = frame N', () => {
    for (const n of [0, 5, 59]) expect(stateAtFrame(base, n + 60, 60, true).seed).toBe(stateAtFrame(base, n, 60, true).seed);
  });
  it('never mutates the base; reuses `out` (no allocation per frame)', () => {
    const before = JSON.stringify(base);
    const out = {} as ReturnType<typeof defaultState>;
    const a = stateAtFrame(base, 3, 60, true, out);
    const b = stateAtFrame(base, 4, 60, true, out);
    expect(a).toBe(out);
    expect(b).toBe(out);
    expect(JSON.stringify(base)).toBe(before);
  });
});
