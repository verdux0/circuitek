/**
 * Document model: a canvas of W×H "document pixels" holding a stack of image layers.
 * Pure and serializable (bitmaps are referenced by key), so it lives in the undo history
 * next to the glitch state. The composite of the visible layers is what enters the glitch chain.
 */
import type { TextProps } from './text';
import { sanitizeState, type GlitchState } from './model';
import { DEFAULT_TEXT } from './text';

export const BLENDS = [
  ['source-over', 'Normal'],
  ['multiply', 'Multiplicar'],
  ['screen', 'Trama'],
  ['overlay', 'Superponer'],
  ['darken', 'Oscurecer'],
  ['lighten', 'Aclarar'],
  ['color-dodge', 'Sobreexponer color'],
  ['color-burn', 'Subexponer color'],
  ['hard-light', 'Luz fuerte'],
  ['soft-light', 'Luz suave'],
  ['difference', 'Diferencia'],
  ['exclusion', 'Exclusión'],
  ['hue', 'Tono'],
  ['saturation', 'Saturación'],
  ['color', 'Color'],
  ['luminosity', 'Luminosidad'],
] as const;
export type Blend = (typeof BLENDS)[number][0];

export interface Layer {
  id: string;
  name: string;
  /** Key of the bitmap in the bitmap store. */
  src: string;
  /** Natural size of the bitmap. */
  w: number;
  h: number;
  /** Center of the layer, in document pixels. */
  x: number;
  y: number;
  /** Always positive; mirroring lives in flipX / flipY. */
  scaleX: number;
  scaleY: number;
  /** Degrees, clockwise, normalized to (-180, 180]. */
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  /** 0..1 */
  opacity: number;
  visible: boolean;
  locked: boolean;
  blend: Blend;
  /** Present on text layers: drawn as vector text; `src` then holds a small raster for the UI. */
  text?: TextProps;
  /** Text layers: the name follows the content until the user renames the layer. */
  autoName?: boolean;
  /** Effects of this layer alone (applied before it is blended), in screen space. */
  fx?: GlitchState;
  /** Animated source (video / GIF): `src` keys a poster bitmap plus the media player. */
  media?: LayerMedia;
}

/**
 * Every layer is animated: its effects follow the frame index of the effects clock (noise and
 * «Movimiento»), which starts paused on the base state. Older documents stored an `animate`
 * switch per layer; it is ignored on load.
 */
export interface LayerMedia {
  kind: 'video' | 'gif';
}

export interface DocState {
  w: number;
  h: number;
  bg: string;
  /** Transparent background: `bg` is not painted (PNG / GIF / WebM keep the alpha). */
  transparent?: boolean;
  /** Bottom → top. */
  layers: Layer[];
  active: string | null;
}

export type Mat = [number, number, number, number, number, number];

export function emptyDoc(): DocState {
  return { w: 1600, h: 1200, bg: '#000000', layers: [], active: null };
}

export function cloneDoc(d: DocState): DocState {
  return { ...d, layers: d.layers.map(cloneLayer) };
}

export function cloneLayer(l: Layer): Layer {
  const c: Layer = { ...l };
  if (l.text) c.text = { ...l.text };
  if (l.fx) c.fx = JSON.parse(JSON.stringify(l.fx)) as GlitchState;
  if (l.media) c.media = { ...l.media };
  return c;
}

export function normDeg(a: number): number {
  let r = ((a % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return Math.abs(r) < 1e-9 ? 0 : r;
}

let idCounter = 0;
export function newId(prefix = 'L'): string {
  idCounter++;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function getLayer(d: DocState, id: string | null): Layer | undefined {
  return id ? d.layers.find((l) => l.id === id) : undefined;
}

/**
 * Layer whose effects the effects editor (knobs, cables, stages) edits: the selected one or,
 * with nothing selected, the main image (the bottom-most image layer). So the knobs always
 * act on something while the document has layers.
 */
export function fxTargetId(d: DocState): string | null {
  if (d.active && d.layers.some((l) => l.id === d.active)) return d.active;
  return (d.layers.find((l) => !l.text) ?? d.layers[0])?.id ?? null;
}

/** Offset (document px) of each successive paste / duplicate, so copies do not hide each other. */
export const PASTE_OFFSET = 24;

/**
 * Inserts a copy of `src` (a layer from the clipboard, possibly of another document) above
 * the active layer, shifted by `n` paste offsets, and makes it active. Returns the new layer.
 */
export function pasteLayer(d: DocState, src: Layer, n = 1): Layer {
  const copy: Layer = { ...cloneLayer(src), id: newId(), locked: false, visible: true };
  copy.x = src.x + PASTE_OFFSET * n;
  copy.y = src.y + PASTE_OFFSET * n;
  const i = d.layers.findIndex((x) => x.id === d.active);
  d.layers.splice(i < 0 ? d.layers.length : i + 1, 0, copy);
  d.active = copy.id;
  return copy;
}

/** Layer-local (pixel of the bitmap, origin top-left) → document matrix. */
export function layerMatrix(l: Layer): Mat {
  const r = (l.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const sx = l.scaleX * (l.flipX ? -1 : 1);
  const sy = l.scaleY * (l.flipY ? -1 : 1);
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const dd = cos * sy;
  // translate(x, y) · rotate · scale · translate(-w/2, -h/2)
  return [a, b, c, dd, l.x - a * (l.w / 2) - c * (l.h / 2), l.y - b * (l.w / 2) - dd * (l.h / 2)];
}

export function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Corners of the layer in document space (TL, TR, BR, BL of the bitmap). */
export function layerCorners(l: Layer): [number, number][] {
  const m = layerMatrix(l);
  return [apply(m, 0, 0), apply(m, l.w, 0), apply(m, l.w, l.h), apply(m, 0, l.h)];
}

/** Axis-aligned bounding box of the layer in document space. */
export function layerBounds(l: Layer): { x: number; y: number; w: number; h: number } {
  const c = layerCorners(l);
  const xs = c.map((p) => p[0]);
  const ys = c.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/**
 * Reads back scale/rotation from a 2×2 linear part (a, b, c, d) produced by an interactive
 * transform, keeping the layer's current flip flags (the transformer never flips).
 */
export function fromLinear(a: number, b: number, c: number, d: number, flipX: boolean, flipY: boolean): { scaleX: number; scaleY: number; rotation: number } {
  void flipY; // only the first column is needed for the angle
  const fx = flipX ? -1 : 1;
  return {
    scaleX: Math.hypot(a, b),
    scaleY: Math.hypot(c, d),
    rotation: normDeg((Math.atan2(fx * b, fx * a) * 180) / Math.PI),
  };
}

/** Scale that makes a w×h box fit inside (contain) or cover the document. */
export function fitScale(d: DocState, w: number, h: number, mode: 'contain' | 'cover'): number {
  const kx = d.w / w;
  const ky = d.h / h;
  return mode === 'contain' ? Math.min(kx, ky) : Math.max(kx, ky);
}

/** A new layer centered in the document; shrunk to fit if it is larger than the document. */
export function makeLayer(d: DocState, src: string, w: number, h: number, name: string): Layer {
  const k = Math.min(1, fitScale(d, w, h, 'contain'));
  return {
    id: newId(),
    name,
    src,
    w,
    h,
    x: d.w / 2,
    y: d.h / 2,
    scaleX: k,
    scaleY: k,
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    visible: true,
    locked: false,
    blend: 'source-over',
  };
}

/* ------------------------------ layer operations ------------------------------ */

/** Fit / fill the document, keeping the layer's rotation (uses its rotated bounding box). */
export function fitLayer(d: DocState, l: Layer, mode: 'contain' | 'cover'): void {
  const unit = { ...l, scaleX: 1, scaleY: l.scaleY / l.scaleX };
  const b = layerBounds(unit);
  const k = fitScale(d, b.w, b.h, mode);
  l.scaleY = (l.scaleY / l.scaleX) * k;
  l.scaleX = k;
  l.x = d.w / 2;
  l.y = d.h / 2;
}

export function resetLayer(d: DocState, l: Layer): void {
  Object.assign(l, { x: d.w / 2, y: d.h / 2, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false });
}

export function rotateLayer(l: Layer, deg: number): void {
  l.rotation = normDeg(l.rotation + deg);
}

/** Mirror the layer about its own vertical (h) or horizontal (v) axis, as seen on screen. */
export function flipLayer(l: Layer, axis: 'h' | 'v'): void {
  // A mirror in document space about the layer center is F·R(θ)·S = R(-θ)·F·S.
  if (axis === 'h') l.flipX = !l.flipX;
  else l.flipY = !l.flipY;
  l.rotation = normDeg(-l.rotation);
}

export function moveLayer(d: DocState, id: string, toIndex: number): void {
  const i = d.layers.findIndex((l) => l.id === id);
  if (i < 0) return;
  const [l] = d.layers.splice(i, 1);
  d.layers.splice(Math.max(0, Math.min(d.layers.length, toIndex)), 0, l);
}

/* ------------------------------ document operations ------------------------------ */

/** Rotates the whole canvas 90° (dir 1 = clockwise), carrying every layer with it. */
export function rotateDoc(d: DocState, dir: 1 | -1): void {
  const { w, h } = d;
  for (const l of d.layers) {
    const { x, y } = l;
    if (dir === 1) [l.x, l.y] = [h - y, x];
    else [l.x, l.y] = [y, w - x];
    l.rotation = normDeg(l.rotation + 90 * dir);
  }
  d.w = h;
  d.h = w;
}

/** Name shown for a text layer: its first line. */
export function textLayerName(content: string): string {
  const first = content.split('\n').find((x) => x.trim()) ?? '';
  return `T · ${first.trim().slice(0, 28) || '(vacío)'}`;
}

/** Mirrors the whole canvas. */
export function flipDoc(d: DocState, axis: 'h' | 'v'): void {
  for (const l of d.layers) {
    if (axis === 'h') l.x = d.w - l.x;
    else l.y = d.h - l.y;
    flipLayer(l, axis);
  }
}

/** Crops / extends the canvas to the bounding box of a layer (or of all visible layers). */
export function cropDocTo(d: DocState, ls: Layer[]): void {
  if (!ls.length) return;
  const bs = ls.map(layerBounds);
  const x0 = Math.min(...bs.map((b) => b.x));
  const y0 = Math.min(...bs.map((b) => b.y));
  const x1 = Math.max(...bs.map((b) => b.x + b.w));
  const y1 = Math.max(...bs.map((b) => b.y + b.h));
  resizeDoc(d, Math.round(x1 - x0), Math.round(y1 - y0), -x0, -y0);
}

/** Changes the canvas size. Layers are shifted by (dx, dy) (default: keep them centered). */
export function resizeDoc(d: DocState, w: number, h: number, dx?: number, dy?: number): void {
  const ox = dx ?? (w - d.w) / 2;
  const oy = dy ?? (h - d.h) / 2;
  for (const l of d.layers) {
    l.x += ox;
    l.y += oy;
  }
  d.w = Math.max(1, Math.round(w));
  d.h = Math.max(1, Math.round(h));
}

/**
 * Imagen → Tamaño de la imagen: scales the canvas AND its content to w × h (each layer's
 * position and scale follow). With a different horizontal and vertical factor a rotated
 * layer keeps its rotation and is only scaled along its own axes (no shear).
 */
export function scaleDoc(d: DocState, w: number, h: number): void {
  const nw = Math.max(1, Math.round(w));
  const nh = Math.max(1, Math.round(h));
  const kx = nw / d.w;
  const ky = nh / d.h;
  for (const l of d.layers) {
    l.x *= kx;
    l.y *= ky;
    l.scaleX *= kx;
    l.scaleY *= ky;
  }
  d.w = nw;
  d.h = nh;
}

/** Largest size ≤ the limits with the same aspect ratio. */
export function clampSize(w: number, h: number, maxSide: number, maxMegapixels: number): [number, number] {
  const mp = (w * h) / 1e6;
  const k = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(maxMegapixels / mp));
  return [Math.max(1, Math.floor(w * k)), Math.max(1, Math.floor(h * k))];
}

/* ------------------------------ compositing ------------------------------ */

export interface BitmapSource {
  /** Full resolution bitmap. */
  full: CanvasImageSource;
  /** Small proxy (≤ PROXY_MAX px) for live preview. */
  proxy: CanvasImageSource;
  proxyW: number;
}

/* ------------------------------ validation (stored sessions) ------------------------------ */

const num = (v: unknown, d: number, min = -1e7, max = 1e7): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
const str = (v: unknown, d: string, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : d);
const HEX = /^#[0-9a-f]{6}$/i;
const BLEND_SET = new Set<string>(BLENDS.map((b) => b[0]));

/** Validates a document read from storage (unknown keys dropped, ranges clamped). */
export function sanitizeDoc(input: unknown): DocState {
  const base = emptyDoc();
  if (!input || typeof input !== 'object') return base;
  const o = input as Record<string, unknown>;
  const d: DocState = {
    w: Math.round(num(o.w, base.w, 1, 16384)),
    h: Math.round(num(o.h, base.h, 1, 16384)),
    bg: typeof o.bg === 'string' && HEX.test(o.bg) ? o.bg : base.bg,
    layers: [],
    active: null,
  };
  if (o.transparent === true) d.transparent = true;
  for (const raw of Array.isArray(o.layers) ? o.layers : []) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const l: Layer = {
      id: str(r.id, newId(), 64),
      name: str(r.name, 'Capa', 80),
      src: str(r.src, '', 4000),
      w: num(r.w, 1, 1, 16384),
      h: num(r.h, 1, 1, 16384),
      x: num(r.x, d.w / 2),
      y: num(r.y, d.h / 2),
      scaleX: num(r.scaleX, 1, 1e-4, 1e4),
      scaleY: num(r.scaleY, 1, 1e-4, 1e4),
      rotation: normDeg(num(r.rotation, 0)),
      flipX: r.flipX === true,
      flipY: r.flipY === true,
      opacity: num(r.opacity, 1, 0, 1),
      visible: r.visible !== false,
      locked: r.locked === true,
      blend: BLEND_SET.has(r.blend as string) ? (r.blend as Blend) : 'source-over',
      fx: sanitizeState(r.fx),
    };
    if (r.autoName !== undefined) l.autoName = r.autoName !== false;
    if (r.media && typeof r.media === 'object') {
      const m = r.media as Record<string, unknown>;
      if (m.kind === 'video' || m.kind === 'gif') l.media = { kind: m.kind };
    }
    if (r.text && typeof r.text === 'object') {
      const t = r.text as Record<string, unknown>;
      l.text = {
        content: str(t.content, '', 5000),
        font: str(t.font, DEFAULT_TEXT.font, 120),
        size: num(t.size, DEFAULT_TEXT.size, 1, 4000),
        color: typeof t.color === 'string' && HEX.test(t.color) ? t.color : DEFAULT_TEXT.color,
        bold: t.bold === true,
        italic: t.italic === true,
        align: t.align === 'left' || t.align === 'right' ? t.align : 'center',
        lineHeight: num(t.lineHeight, DEFAULT_TEXT.lineHeight, 0.5, 4),
      };
      // Text schema 2 (font library): fontId + exact weight. Older documents have neither and
      // keep working by family name.
      if (typeof t.fontId === 'string' && t.fontId && t.fontId.length <= 200 && !/[\u0000-\u001f]/.test(t.fontId)) l.text.fontId = t.fontId;
      if (typeof t.weight === 'number' && Number.isFinite(t.weight)) l.text.weight = Math.round(Math.min(1000, Math.max(1, t.weight)));
    }
    d.layers.push(l);
  }
  d.active = d.layers.some((l) => l.id === o.active) ? (o.active as string) : (d.layers[d.layers.length - 1]?.id ?? null);
  return d;
}
