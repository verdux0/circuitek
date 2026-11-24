/**
 * Layer styles (Photoshop / Photopea model): effects ATTACHED to a layer. They never modify its
 * pixels; the renderer draws them again from the layer's alpha whenever the layer or the style
 * changes (gl/renderer.ts, gl/shaders.ts FX_FRAG). Pure data + validation here.
 *
 * Settings follow Photoshop's names. The exact semantics of a few of them could not be checked
 * against Adobe's documentation (its help pages answered 403 when this was written): see
 * PLAN-EFECTOS-RECORTE-PANELES.md, «no comprobado».
 */
import type { Blend } from './doc';

export type Contour = 'linear' | 'gauss' | 'ring' | 'cone';
export const CONTOURS: [Contour, string][] = [
  ['linear', 'Lineal'],
  ['gauss', 'Gaussiana'],
  ['ring', 'Anillo'],
  ['cone', 'Cono'],
];

interface FxBase {
  /** Added to the style (the checkbox in «Estilo de capa»). */
  on: boolean;
  /** Hidden with its eye in the layers list (kept in the style, not drawn). */
  hidden: boolean;
  blend: Blend;
  /** 0..100 */
  opacity: number;
  /** 0..100: grain in the effect only (never in the layer). */
  noise: number;
  contour: Contour;
}

/** Sombra paralela / Sombra interior. */
export interface ShadowFx extends FxBase {
  color: string;
  /** Degrees, light direction (Photoshop convention: 120 = from the upper left). */
  angle: number;
  useGlobal: boolean;
  /** Document px. */
  distance: number;
  /** 0..100 %: Spread (drop shadow) or Choke (inner shadow): hardens the edge before the blur. */
  spread: number;
  /** Document px: radius of the blur. */
  size: number;
}

export interface DropShadowFx extends ShadowFx {
  /** «La capa recorta la sombra»: the shadow is hidden under the layer itself. */
  knockout: boolean;
}

/** Resplandor exterior / interior. */
export interface GlowFx extends FxBase {
  fill: 'color' | 'gradient';
  color: string;
  /** Gradient: from `color` (at the edge) to `color2`. */
  color2: string;
  technique: 'softer' | 'precise';
  /** 0..100 %: Spread (outer) or Choke (inner). */
  spread: number;
  /** Document px. */
  size: number;
  /** 1..100 %: which part of the glow the contour shapes. */
  range: number;
}

export interface InnerGlowFx extends GlowFx {
  source: 'edge' | 'center';
}

export interface LayerStyle {
  /** All effects shown / hidden at once (the eye of «Efectos» under the layer). */
  enabled: boolean;
  dropShadow: DropShadowFx;
  outerGlow: GlowFx;
  innerShadow: ShadowFx;
  innerGlow: InnerGlowFx;
}

export type EffectKey = 'dropShadow' | 'outerGlow' | 'innerShadow' | 'innerGlow';
/** Dialog / list order (Photoshop's). */
export const EFFECTS: { key: EffectKey; label: string; outer: boolean }[] = [
  { key: 'innerShadow', label: 'Sombra interior', outer: false },
  { key: 'innerGlow', label: 'Resplandor interior', outer: false },
  { key: 'outerGlow', label: 'Resplandor exterior', outer: true },
  { key: 'dropShadow', label: 'Sombra paralela', outer: true },
];

/** Document-wide light (Photoshop's «Luz global»): one angle shared by every effect that uses it. */
export interface GlobalLight {
  angle: number;
}
export const DEFAULT_LIGHT = 120;

export function defaultStyle(): LayerStyle {
  return {
    enabled: true,
    dropShadow: { on: false, hidden: false, blend: 'multiply', color: '#000000', opacity: 75, angle: DEFAULT_LIGHT, useGlobal: true, distance: 5, spread: 0, size: 5, noise: 0, contour: 'linear', knockout: true },
    outerGlow: { on: false, hidden: false, blend: 'screen', opacity: 75, noise: 0, contour: 'linear', fill: 'color', color: '#ffffbe', color2: '#ff2d78', technique: 'softer', spread: 0, size: 5, range: 50 },
    innerShadow: { on: false, hidden: false, blend: 'multiply', color: '#000000', opacity: 75, angle: DEFAULT_LIGHT, useGlobal: true, distance: 5, spread: 0, size: 5, noise: 0, contour: 'linear' },
    innerGlow: { on: false, hidden: false, blend: 'screen', opacity: 75, noise: 0, contour: 'linear', fill: 'color', color: '#ffffbe', color2: '#ff2d78', technique: 'softer', spread: 0, size: 5, range: 50, source: 'edge' },
  };
}

/** Is this effect drawn? (added and not hidden by its eye) */
export const fxOn = (f: { on: boolean; hidden: boolean }): boolean => f.on && !f.hidden;

/** Effects added to the style (shown under the layer, drawn or hidden). */
export function addedEffects(s: LayerStyle | undefined): EffectKey[] {
  return s ? EFFECTS.map((e) => e.key).filter((k) => s[k].on) : [];
}

/** Does the style draw anything? (no style, all off or hidden → the layer renders as before) */
export function styleActive(s: LayerStyle | undefined): s is LayerStyle {
  return !!s && s.enabled && (fxOn(s.dropShadow) || fxOn(s.outerGlow) || fxOn(s.innerShadow) || fxOn(s.innerGlow));
}

/** Does any drawn effect follow the global light? (then the light angle is part of the layer's cache key) */
export function usesGlobalLight(s: LayerStyle | undefined): boolean {
  return styleActive(s) && ((fxOn(s.dropShadow) && s.dropShadow.useGlobal) || (fxOn(s.innerShadow) && s.innerShadow.useGlobal));
}

/** The angle an effect really uses. */
export function effectAngle(fx: ShadowFx, light: GlobalLight | undefined): number {
  return fx.useGlobal ? (light?.angle ?? DEFAULT_LIGHT) : fx.angle;
}

/**
 * Offset (document px, y down) of a shadow for a light at `angle`: the shadow falls away from
 * the light. 120° (upper-left light) → down and to the right.
 */
export function shadowOffset(angle: number, distance: number): [number, number] {
  const r = (angle * Math.PI) / 180;
  const dx = -Math.cos(r) * distance;
  const dy = Math.sin(r) * distance;
  return [Math.abs(dx) < 1e-9 ? 0 : dx, Math.abs(dy) < 1e-9 ? 0 : dy];
}

/**
 * Spread / choke split the effect's size into a hard part (the mask grows or shrinks first) and a
 * soft part (the blur): spread 0 % = all blur, 100 % = a hard edge. «Precisa» (glows) follows the
 * shape: all growth and a 1 px soft edge.
 */
export function maskRadii(size: number, spread: number, precise = false): { grow: number; blur: number } {
  const s = Math.max(0, size);
  if (precise) return { grow: s, blur: Math.min(1, s) };
  const k = Math.min(100, Math.max(0, spread)) / 100;
  return { grow: s * k, blur: s * (1 - k) };
}

/** Escalar efectos: px settings (distance, size) × k (e.g. 2 = 200 %). */
export function scaleStyle(s: LayerStyle, k: number): LayerStyle {
  const f = Math.max(0.01, Math.min(10, k));
  const px = (v: number, max: number) => Math.min(max, Math.round(v * f * 10) / 10);
  const out = cloneStyle(s);
  out.dropShadow.distance = px(out.dropShadow.distance, 1000);
  out.dropShadow.size = px(out.dropShadow.size, 250);
  out.innerShadow.distance = px(out.innerShadow.distance, 1000);
  out.innerShadow.size = px(out.innerShadow.size, 250);
  out.outerGlow.size = px(out.outerGlow.size, 250);
  out.innerGlow.size = px(out.innerGlow.size, 250);
  return out;
}

export function cloneStyle(s: LayerStyle): LayerStyle {
  return JSON.parse(JSON.stringify(s)) as LayerStyle;
}

/* ------------------------------ validation ------------------------------ */

const BLEND_IDS = new Set(['source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);
const HEX = /^#[0-9a-f]{6}$/i;
const n = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const pick = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const col = (v: unknown, d: string): string => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d);
const CONTOUR_IDS = CONTOURS.map((c) => c[0]);

function base<T extends FxBase>(o: Record<string, unknown>, d: T): FxBase {
  return {
    on: o.on === true,
    hidden: o.hidden === true,
    blend: (BLEND_IDS.has(o.blend as string) ? o.blend : d.blend) as Blend,
    opacity: n(o.opacity, 0, 100, d.opacity),
    noise: n(o.noise, 0, 100, d.noise),
    contour: pick(o.contour, CONTOUR_IDS, d.contour),
  };
}
function shadow(o: Record<string, unknown>, d: ShadowFx): ShadowFx {
  return {
    ...base(o, d),
    color: col(o.color, d.color),
    angle: n(o.angle, -180, 180, d.angle),
    useGlobal: o.useGlobal !== false,
    distance: n(o.distance, 0, 1000, d.distance),
    spread: n(o.spread, 0, 100, d.spread),
    size: n(o.size, 0, 250, d.size),
  };
}
function glow(o: Record<string, unknown>, d: GlowFx): GlowFx {
  return {
    ...base(o, d),
    fill: pick(o.fill, ['color', 'gradient'] as const, d.fill),
    color: col(o.color, d.color),
    color2: col(o.color2, d.color2),
    technique: pick(o.technique, ['softer', 'precise'] as const, d.technique),
    spread: n(o.spread, 0, 100, d.spread),
    size: n(o.size, 0, 250, d.size),
    range: n(o.range, 1, 100, d.range),
  };
}

/** Validates a stored style; undefined when there is none (old documents, garbage). */
export function sanitizeStyle(raw: unknown): LayerStyle | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const d = defaultStyle();
  return {
    enabled: o.enabled !== false,
    dropShadow: { ...shadow(obj(o.dropShadow), d.dropShadow), knockout: obj(o.dropShadow).knockout !== false },
    outerGlow: glow(obj(o.outerGlow), d.outerGlow),
    innerShadow: shadow(obj(o.innerShadow), d.innerShadow),
    innerGlow: { ...glow(obj(o.innerGlow), d.innerGlow), source: pick(obj(o.innerGlow).source, ['edge', 'center'] as const, d.innerGlow.source) },
  };
}

export function sanitizeLight(raw: unknown): GlobalLight | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const a = (raw as Record<string, unknown>).angle;
  return typeof a === 'number' && Number.isFinite(a) ? { angle: Math.min(180, Math.max(-180, a)) } : undefined;
}

/* ------------------------------ factory styles ------------------------------ */

function make(fn: (s: LayerStyle) => void): LayerStyle {
  const s = defaultStyle();
  fn(s);
  return s;
}

/** Presets thought for the glitch look (they replace the layer's style). */
export const STYLE_PRESETS: { name: string; style: LayerStyle }[] = [
  { name: 'Sombra suave', style: make((s) => Object.assign(s.dropShadow, { on: true, opacity: 55, distance: 12, size: 24, spread: 0 })) },
  { name: 'Sombra dura retro', style: make((s) => Object.assign(s.dropShadow, { on: true, opacity: 100, distance: 14, size: 0, spread: 100, color: '#ff2d78', blend: 'source-over', useGlobal: false, angle: 135 })) },
  { name: 'Neón', style: make((s) => {
    Object.assign(s.outerGlow, { on: true, opacity: 90, size: 28, spread: 10, color: '#2fe0ff', blend: 'screen' });
    Object.assign(s.innerGlow, { on: true, opacity: 70, size: 6, color: '#ffffff', blend: 'screen' });
  }) },
  { name: 'Brillo CRT', style: make((s) => {
    Object.assign(s.outerGlow, { on: true, opacity: 70, size: 18, noise: 35, fill: 'gradient', color: '#7dff6a', color2: '#0b3d1a', blend: 'screen' });
    Object.assign(s.innerShadow, { on: true, opacity: 45, distance: 0, size: 10, spread: 0 });
  }) },
  { name: 'Aberración', style: make((s) => {
    Object.assign(s.dropShadow, { on: true, opacity: 85, distance: 6, size: 0, spread: 100, color: '#ff004c', blend: 'screen', useGlobal: false, angle: 180, knockout: false });
    Object.assign(s.outerGlow, { on: true, opacity: 60, size: 3, spread: 60, technique: 'precise', color: '#00e5ff', blend: 'screen' });
  }) },
  { name: 'Grabado', style: make((s) => {
    Object.assign(s.innerShadow, { on: true, opacity: 80, distance: 3, size: 4 });
    Object.assign(s.dropShadow, { on: true, opacity: 40, distance: 2, size: 2, color: '#ffffff', blend: 'screen' });
  }) },
];
