/**
 * Pure helpers for animated sources (video / GIF): frame indices, per-frame seeds, time labels
 * and playback speed. No DOM here, so it is unit-tested.
 */
import { mixSeed } from '../prng';

/** Playback speeds offered in the UI. */
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 2;

/** Clamps a playback rate to the supported range (NaN / garbage → 1×). */
export function clampSpeed(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, v));
}

/** Default frame rate until the real one has been measured. */
export const DEFAULT_FPS = 30;

/**
 * Index of the frame shown at time `t` (seconds). The epsilon makes a frame's own presentation
 * time (n / fps, as `mediaTime` reports it) land on n despite floating point error.
 */
export function frameAt(t: number, fps: number): number {
  if (!Number.isFinite(t) || t <= 0) return 0;
  const f = Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
  return Math.max(0, Math.floor(t * f + 1e-3));
}

/**
 * Estimates the frame rate from the gaps between presented frames (seconds). Uses the median of
 * positive gaps (robust to dropped frames and seeks) and snaps to common rates within 3 %.
 */
export function estimateFps(gaps: number[]): number {
  const g = gaps.filter((x) => Number.isFinite(x) && x > 0.004 && x < 0.5).sort((a, b) => a - b);
  if (g.length < 3) return DEFAULT_FPS;
  const fps = 1 / g[Math.floor(g.length / 2)];
  // Closest common rate within 3 % (30 must not snap to 29.97 just because it is listed first).
  let best = 0;
  for (const c of [12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120]) {
    if (Math.abs(fps - c) / c < 0.03 && (!best || Math.abs(fps - c) < Math.abs(fps - best))) best = c;
  }
  return best || Math.round(fps * 100) / 100;
}

/**
 * Seed used for frame `frame`. "Glitch animado" on: the noise changes every frame, still
 * deterministic (same seed + same frame → same seed). Off: the pattern stays fixed.
 */
export function frameSeed(seed: number, frame: number, animate: boolean): number {
  if (!animate) return seed >>> 0;
  return mixSeed(seed >>> 0, 0x10000 + Math.max(0, Math.floor(frame)));
}

/** "m:ss.d" (or "h:mm:ss.d"), tenths truncated so the label never runs ahead of the video. */
export function formatTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const tenths = Math.floor(t * 10 + 1e-6);
  const d = tenths % 10;
  const s = Math.floor(tenths / 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}.${d}` : `${m}:${ss}.${d}`;
}

/** Spoken form for aria-valuetext: "1 min 05 s de 2 min 10 s". */
export function spokenTime(t: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(t) ? t : 0));
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s % 60} s`;
}
