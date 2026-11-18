/**
 * The state of frame N of an animated layer. ONE function, used by the renderer for both the
 * live preview and the exports (they reach it through SourceRef.noise / SourceRef.loop), and
 * by the UI to show the frame's values on the knobs. Pure and deterministic: everything comes
 * from (seed, frame index) — no Math.random(), no clock.
 *
 * Modes ("Movimiento"):
 * - Parpadeo (flicker): the noise seed changes every frame AND the selected parameters jitter a
 *   little, independently on every frame (intensity 0 = seed only). The jitter matters: 8 of the
 *   15 cable modes do not use the seed at all, so a seed-only flicker left them frozen.
 * - Deriva suave (drift): each selected parameter oscillates around its base value,
 *   base + A·sin(2π·k·i/N + φ), with k whole cycles per loop and φ from the seed → the loop
 *   of N frames closes perfectly.
 * - Saltos (jumps): every H frames some selected parameters jump to a nearby value and hold it.
 * Values are always clamped to each knob's range and snapped to its step.
 */
import { STAGES, STAGE_IDS, defaultMotion, motionFrames, type Cable, type GlitchState, type StageId } from './model';
import { frameSeed } from './media/timing';
import { mixSeed } from './prng';

const TAU = Math.PI * 2;
const rand01 = (h: number): number => (h >>> 0) / 4294967296;

/** Per-parameter salts, computed once (no strings / objects per frame). */
const SALT_EFFECT = 0x1e;
const SALT_FILTER = 0x2f;
const SALT_CABLE = 0x300;
const STAGE_SALTS: Record<StageId, number[]> = Object.fromEntries(
  STAGE_IDS.map((id, si) => [id, STAGES.find((s) => s.id === id)!.params.map((_, pi) => 0x1000 + si * 64 + pi)]),
) as Record<StageId, number[]>;
const STAGE_PARAMS = Object.fromEntries(STAGES.map((s) => [s.id, s.params])) as Record<StageId, (typeof STAGES)[number]['params']>;

/** Clamp to [min, max] and snap to the knob's step. */
export function clampParam(v: number, min: number, max: number, step: number): number {
  const c = Math.min(max, Math.max(min, v));
  if (!(step > 0)) return c;
  const s = Math.round((c - min) / step) * step + min;
  return Math.min(max, Math.max(min, Number(s.toFixed(4))));
}

/** Whole cycles per loop for a drifting parameter: 1 … 1+3·speed (from the seed). */
export function driftCycles(seed: number, salt: number, speed: number): number {
  const max = 1 + Math.round((speed / 100) * 3);
  return 1 + Math.floor(rand01(mixSeed(seed, salt)) * max);
}

/** Frames each jump holds: 12 (slow) … 2 (fast). */
export function jumpHold(speed: number): number {
  return Math.max(2, Math.round(12 - (speed / 100) * 10));
}

/**
 * Value of one parameter on frame i of a loop of n frames. `base` is the user's value; the
 * result is clamped / snapped to [min, max] / step.
 */
/** Parpadeo moves parameters less than the other modes: it is noise, not a gesture. */
export const FLICKER_SCALE = 0.4;

export function paramAt(mode: 'flicker' | 'drift' | 'jumps', seed: number, salt: number, i: number, n: number, base: number,
  min: number, max: number, step: number, intensity: number, speed: number): number {
  const amp = (intensity / 100) * (max - min) * 0.5;
  if (!amp) return clampParam(base, min, max, step);
  if (mode === 'flicker') {
    // A new random offset every frame (same seed + frame → same offset).
    const h = mixSeed(mixSeed(seed, salt), 0x9000 + i);
    return clampParam(base + amp * FLICKER_SCALE * (2 * rand01(h) - 1), min, max, step);
  }
  if (mode === 'drift') {
    const k = driftCycles(seed, salt, speed);
    const phi = TAU * rand01(mixSeed(seed, salt + 0x7777));
    return clampParam(base + amp * Math.sin((TAU * k * i) / n + phi), min, max, step);
  }
  const block = Math.floor(i / jumpHold(speed));
  const h = mixSeed(mixSeed(seed, salt), 0x5000 + block);
  // About half of the selected parameters jump in each block; the rest stay at their base.
  if (rand01(h) >= 0.55) return clampParam(base, min, max, step);
  return clampParam(base + amp * (2 * rand01(mixSeed(h, 7)) - 1), min, max, step);
}

/**
 * Effects of frame `frame` (0-based) of a loop of `loopFrames` frames (0 = the motion's own
 * loop: seconds × fps). `frame` undefined or `animate` false → the base state itself.
 * `out` (optional) is reused as the result object: a running preview allocates nothing
 * after its first frame.
 */
export function stateAtFrame(base: GlitchState, frame: number | undefined, loopFrames: number, animate: boolean, out?: GlitchState): GlitchState {
  if (frame === undefined || !animate) return base;
  const m = base.motion ?? defaultMotion();
  const n = loopFrames > 0 ? loopFrames : motionFrames(m);
  const i = ((Math.floor(frame) % n) + n) % n;
  const o = out ?? ({} as GlitchState);
  o.v = base.v;
  o.motion = m;
  const mode = m.mode;
  const t = m.targets;
  const seed = base.seed >>> 0;
  // Parpadeo also changes the noise seed every frame; Deriva / Saltos keep the user's seed.
  o.seed = mode === 'flicker' ? frameSeed(base.seed, i, true) : base.seed;
  o.effect = t.effect ? paramAt(mode, seed, SALT_EFFECT, i, n, base.effect, 0, 100, 1, m.intensity, m.speed) : base.effect;
  o.filter = t.filter ? paramAt(mode, seed, SALT_FILTER, i, n, base.filter, 0, 100, 1, m.intensity, m.speed) : base.filter;
  // Cables: own array / objects in `out`, reused from frame to frame.
  if (!o.cables || o.cables === base.cables) o.cables = [];
  o.cables.length = base.cables.length;
  for (let k = 0; k < base.cables.length; k++) {
    const c = base.cables[k];
    const oc: Cable = o.cables[k] ?? (o.cables[k] = { a: c.a, b: c.b, amount: c.amount });
    oc.a = c.a;
    oc.b = c.b;
    oc.amount = t.cables ? paramAt(mode, seed, SALT_CABLE + k, i, n, c.amount, 0, 100, 1, m.intensity, m.speed) : c.amount;
  }
  // Stages: same, every knob of every stage (only matters where the stage is on).
  if (!o.stages || o.stages === base.stages) o.stages = {} as GlitchState['stages'];
  for (const id of STAGE_IDS) {
    const bs = base.stages[id];
    const os = o.stages[id] ?? (o.stages[id] = { on: bs.on, p: {} });
    os.on = bs.on;
    const defs = STAGE_PARAMS[id];
    const salts = STAGE_SALTS[id];
    for (let q = 0; q < defs.length; q++) {
      const d = defs[q];
      const b = bs.p[d.id];
      os.p[d.id] = t.stages ? paramAt(mode, seed, salts[q], i, n, b, d.min, d.max, d.step, m.intensity, m.speed) : b;
    }
  }
  return o;
}
