import { describe, expect, it } from 'vitest';
import { clampParam, driftCycles, jumpHold, paramAt, stateAtFrame } from '../src/motion';
import { STAGES, defaultMotion, defaultState, parsePresetFile, sanitizeState, toPresetFile } from '../src/model';
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

describe('Movimiento: Deriva suave y Saltos', () => {
  const withMotion = (mode: 'flicker' | 'drift' | 'jumps', extra: Partial<ReturnType<typeof defaultMotion>> = {}) => {
    const s = defaultState();
    s.motion = { ...defaultMotion(), mode, ...extra, targets: { effect: true, filter: true, cables: true, stages: true, ...(extra.targets ?? {}) } };
    s.stages.bus.on = true;
    return s;
  };
  it('deterministic: same seed + same frame → same values; another seed → other values', () => {
    for (const mode of ['drift', 'jumps'] as const) {
      const s = withMotion(mode, { intensity: 80 });
      expect(JSON.stringify(stateAtFrame(s, 17, 60, true))).toBe(JSON.stringify(stateAtFrame(s, 17, 60, true)));
      const other = { ...s, seed: s.seed + 1 };
      const series = (x: typeof s) => Array.from({ length: 60 }, (_, i) => stateAtFrame(x, i, 60, true).effect).join();
      expect(series(other)).not.toBe(series(s));
    }
  });
  it('Deriva suave is periodic: frame i + N = frame i, for every parameter', () => {
    const s = withMotion('drift', { intensity: 90, speed: 100 });
    for (const n of [20, 37, 60]) {
      for (let i = 0; i < n; i++) expect(JSON.stringify(stateAtFrame(s, i + n, n, true))).toBe(JSON.stringify(stateAtFrame(s, i, n, true)));
    }
  });
  it('Deriva suave closes the loop smoothly: the step last → first is like any other step', () => {
    const s = withMotion('drift', { intensity: 60, speed: 50 });
    const n = 60;
    const v = Array.from({ length: n }, (_, i) => paramAt('drift', s.seed, 0x1e, i, n, 50, 0, 100, 0, 60, 50));
    const steps = v.map((x, i) => Math.abs(v[(i + 1) % n] - x));
    expect(steps[n - 1]).toBeLessThanOrEqual(Math.max(...steps.slice(0, -1)) + 1e-9);
    expect(driftCycles(s.seed, 0x1e, 50)).toBeGreaterThanOrEqual(1);
  });
  it('values are always inside each knob range and on its step', () => {
    for (const mode of ['drift', 'jumps'] as const) {
      const s = withMotion(mode, { intensity: 100, speed: 100 });
      s.effect = 98;
      s.filter = 1;
      for (let i = 0; i < 120; i++) {
        const f = stateAtFrame(s, i, 120, true);
        for (const x of [f.effect, f.filter, ...f.cables.map((c) => c.amount)]) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(100);
          expect(Number.isInteger(x)).toBe(true);
        }
        for (const st of STAGES) for (const d of st.params) {
          const v = f.stages[st.id].p[d.id];
          expect(v).toBeGreaterThanOrEqual(d.min);
          expect(v).toBeLessThanOrEqual(d.max);
          expect(Math.abs((v - d.min) / d.step - Math.round((v - d.min) / d.step))).toBeLessThan(1e-6);
        }
      }
    }
    expect(clampParam(150, 0, 100, 1)).toBe(100);
    expect(clampParam(-3, 0, 100, 1)).toBe(0);
    expect(clampParam(7.6, 2, 8, 1)).toBe(8);
  });
  it('Saltos hold their value for H frames, then may jump', () => {
    const s = withMotion('jumps', { intensity: 80, speed: 0 });
    const H = jumpHold(0);
    expect(H).toBe(12);
    const v = Array.from({ length: 60 }, (_, i) => stateAtFrame(s, i, 60, true).effect);
    for (let i = 0; i < 60; i++) expect(v[i]).toBe(v[Math.floor(i / H) * H]);
    expect(new Set(v).size).toBeGreaterThan(1);
    expect(jumpHold(100)).toBe(2);
  });
  it('only the selected parameters move; the base is never mutated', () => {
    const s = withMotion('drift', { intensity: 90, targets: { effect: true, filter: false, cables: false, stages: false } });
    const before = JSON.stringify(s);
    const values = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const f = stateAtFrame(s, i, 60, true);
      values.add(f.effect);
      expect(f.filter).toBe(s.filter);
      expect(f.cables[0].amount).toBe(s.cables[0].amount);
      expect(f.stages.bus.p.xor).toBe(s.stages.bus.p.xor);
    }
    expect(values.size).toBeGreaterThan(5);
    expect(JSON.stringify(s)).toBe(before);
  });
  it('Parpadeo keeps every knob at its base and only changes the noise', () => {
    const s = withMotion('flicker', { intensity: 100 });
    const f = stateAtFrame(s, 9, 60, true);
    expect(f.effect).toBe(s.effect);
    expect(f.seed).not.toBe(s.seed);
  });
});

describe('schema v2: motion in the state and in presets', () => {
  it('v1 states (no motion) load with the default motion', () => {
    const v1 = { v: 1, seed: 5, effect: 40, filter: 60, cables: [{ a: 'RG', b: 'TG', amount: 70 }], stages: {} };
    const s = sanitizeState(v1);
    expect(s.v).toBe(2);
    expect(s.motion).toEqual(defaultMotion());
    expect(s.effect).toBe(40);
  });
  it('bad motion values are clamped or replaced', () => {
    const s = sanitizeState({ motion: { mode: 'tornado', intensity: 500, speed: -4, seconds: 7, fps: 60, targets: { effect: 'yes', cables: true } } });
    expect(s.motion).toEqual({ mode: 'flicker', intensity: 100, speed: 0, seconds: 3, fps: 20, targets: { effect: true, filter: true, cables: true, stages: false } });
  });
  it('presets keep the motion settings (round trip), and old version-1 files still load', () => {
    const s = defaultState();
    s.motion = { ...defaultMotion(), mode: 'jumps', intensity: 33, speed: 77, seconds: 5, fps: 25 };
    const file = toPresetFile('x', s);
    expect(file.version).toBe(2);
    expect(parsePresetFile(JSON.stringify(file)).state.motion).toEqual(s.motion);
    const old = JSON.stringify({ app: 'glitch-editor', version: 1, name: 'viejo', state: { v: 1, seed: 3, effect: 20, filter: 20, cables: [], stages: {} } });
    expect(parsePresetFile(old).state.motion).toEqual(defaultMotion());
  });
});
