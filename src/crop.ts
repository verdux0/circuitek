/**
 * Crop (non-destructive): a rectangle stored in the document in NORMALISED coordinates (0..1 of the
 * canvas), so it does not depend on the resolution. It is a view window over the processed image:
 * the document is always rendered whole (the glitch pattern never changes when cropping) and only
 * this rectangle is shown and exported. Pure maths here; the tool UI is ui/croptool.ts.
 */

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A rectangle in document pixels. */
export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Aspect presets of the tool; null ratio = free; 'original' = the canvas' own ratio. */
export const ASPECTS: { id: string; label: string; ratio: number | 'original' | 'custom' | null }[] = [
  { id: 'free', label: 'Libre', ratio: null },
  { id: 'original', label: 'Original', ratio: 'original' },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: 'custom', label: 'Personalizada', ratio: 'custom' },
];

/** Smallest crop side, in document pixels. */
export const CROP_MIN = 8;

/** Handles: corners and sides, by the edges they move. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Validates a stored crop. Undefined = no crop (also for the whole canvas or anything invalid). */
export function sanitizeCrop(raw: unknown): CropRect | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  let x = n(o.x);
  let y = n(o.y);
  let w = n(o.w);
  let h = n(o.h);
  if ([x, y, w, h].some(Number.isNaN)) return undefined;
  x = clamp(x, 0, 1);
  y = clamp(y, 0, 1);
  w = clamp(w, 0, 1 - x);
  h = clamp(h, 0, 1 - y);
  if (w <= 0 || h <= 0) return undefined;
  return isFull({ x, y, w, h }) ? undefined : { x, y, w, h };
}

/** True when the rectangle covers the whole canvas (then there is no crop to store). */
export function isFull(c: CropRect): boolean {
  return c.x <= 1e-6 && c.y <= 1e-6 && c.w >= 1 - 1e-6 && c.h >= 1 - 1e-6;
}

/** Crop in document pixels, snapped to whole pixels inside the canvas (whole canvas without a crop). */
export function cropPx(docW: number, docH: number, c: CropRect | undefined): PxRect {
  if (!c) return { x: 0, y: 0, w: docW, h: docH };
  const x0 = clamp(Math.round(c.x * docW), 0, docW - 1);
  const y0 = clamp(Math.round(c.y * docH), 0, docH - 1);
  const x1 = clamp(Math.round((c.x + c.w) * docW), x0 + 1, docW);
  const y1 = clamp(Math.round((c.y + c.h) * docH), y0 + 1, docH);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Pixels → normalised (undefined when it is the whole canvas). */
export function toCrop(docW: number, docH: number, r: PxRect): CropRect | undefined {
  return sanitizeCrop({ x: r.x / docW, y: r.y / docH, w: r.w / docW, h: r.h / docH });
}

/** Size (document px) of what is shown / exported. */
export function viewSize(docW: number, docH: number, c: CropRect | undefined): [number, number] {
  const r = cropPx(docW, docH, c);
  return [r.w, r.h];
}

/** Keeps a pixel rectangle inside the canvas and at least CROP_MIN per side (moving, not resizing, when possible). */
export function clampRect(r: PxRect, docW: number, docH: number): PxRect {
  const w = clamp(r.w, Math.min(CROP_MIN, docW), docW);
  const h = clamp(r.h, Math.min(CROP_MIN, docH), docH);
  return { x: clamp(r.x, 0, docW - w), y: clamp(r.y, 0, docH - h), w, h };
}

/** Moves the rectangle by (dx, dy), stopping at the canvas edges. */
export function moveRect(r: PxRect, dx: number, dy: number, docW: number, docH: number): PxRect {
  return { ...r, x: clamp(r.x + dx, 0, docW - r.w), y: clamp(r.y + dy, 0, docH - r.h) };
}

/**
 * Drags handle `hd` of `start` by (dx, dy) document px. `ratio` (w / h) keeps the proportion:
 * corners keep the opposite corner fixed, sides grow the other dimension around the centre.
 * The result stays inside the canvas and above the minimum size.
 */
export function dragHandle(start: PxRect, hd: Handle, dx: number, dy: number, docW: number, docH: number, ratio: number | null): PxRect {
  const west = hd.includes('w');
  const east = hd.includes('e');
  const north = hd.startsWith('n');
  const south = hd.startsWith('s');
  let x0 = start.x;
  let y0 = start.y;
  let x1 = start.x + start.w;
  let y1 = start.y + start.h;
  const minW = Math.min(CROP_MIN, docW);
  const minH = Math.min(CROP_MIN, docH);
  if (west) x0 = clamp(x0 + dx, 0, x1 - minW);
  if (east) x1 = clamp(x1 + dx, x0 + minW, docW);
  if (north) y0 = clamp(y0 + dy, 0, y1 - minH);
  if (south) y1 = clamp(y1 + dy, y0 + minH, docH);
  if (!ratio) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  let w = x1 - x0;
  let h = y1 - y0;
  const corner = (west || east) && (north || south);
  if (corner) {
    // The dimension that moved more leads; the other follows the ratio.
    if (Math.abs(dx) / Math.max(1, start.w) >= Math.abs(dy) / Math.max(1, start.h)) h = w / ratio;
    else w = h * ratio;
  } else if (west || east) h = w / ratio;
  else w = h * ratio;
  // Room the fixed edges / centre leave inside the canvas.
  const ax = west ? start.x + start.w : east ? start.x : start.x + start.w / 2;
  const ay = north ? start.y + start.h : south ? start.y : start.y + start.h / 2;
  const maxW = west ? ax : east ? docW - ax : 2 * Math.min(ax, docW - ax);
  const maxH = north ? ay : south ? docH - ay : 2 * Math.min(ay, docH - ay);
  const k = Math.min(1, maxW / w, maxH / h);
  w = Math.max(minW, w * k);
  h = Math.max(minH, h * k);
  const x = west ? ax - w : east ? ax : ax - w / 2;
  const y = north ? ay - h : south ? ay : ay - h / 2;
  return clampRect({ x, y, w, h }, docW, docH);
}

/** A new rectangle drawn from point a to point b (document px), with an optional ratio. */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number, docW: number, docH: number, ratio: number | null): PxRect {
  const x0 = clamp(ax, 0, docW);
  const y0 = clamp(ay, 0, docH);
  const sx = bx >= x0 ? 1 : -1;
  const sy = by >= y0 ? 1 : -1;
  let w = Math.abs(clamp(bx, 0, docW) - x0);
  let h = Math.abs(clamp(by, 0, docH) - y0);
  if (ratio) {
    if (w / Math.max(1e-9, h) > ratio) h = w / ratio;
    else w = h * ratio;
    const maxW = sx > 0 ? docW - x0 : x0;
    const maxH = sy > 0 ? docH - y0 : y0;
    const k = Math.min(1, maxW / Math.max(1e-9, w), maxH / Math.max(1e-9, h));
    w *= k;
    h *= k;
  }
  w = Math.max(Math.min(CROP_MIN, docW), w);
  h = Math.max(Math.min(CROP_MIN, docH), h);
  return clampRect({ x: sx > 0 ? x0 : x0 - w, y: sy > 0 ? y0 : y0 - h, w, h }, docW, docH);
}

/** The largest rectangle with `ratio`, centred on `r`'s centre, inside the canvas (switching to a preset). */
export function fitRatio(r: PxRect, ratio: number, docW: number, docH: number): PxRect {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  let w = r.w;
  let h = w / ratio;
  if (h > r.h) {
    h = r.h;
    w = h * ratio;
  }
  const k = Math.min(1, docW / w, docH / h);
  w *= k;
  h *= k;
  return clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }, docW, docH);
}

/* -------------------- crop under document operations (rotate, flip, resize) -------------------- */

/** Canvas rotated 90° (dir 1 = clockwise): the crop rotates with it. */
export function rotateCrop(c: CropRect | undefined, dir: 1 | -1): CropRect | undefined {
  if (!c) return c;
  return dir === 1 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
}

/** Canvas mirrored: the crop is mirrored too. */
export function flipCrop(c: CropRect | undefined, axis: 'h' | 'v'): CropRect | undefined {
  if (!c) return c;
  return axis === 'h' ? { ...c, x: 1 - c.x - c.w } : { ...c, y: 1 - c.y - c.h };
}

/** Canvas resized from oldW × oldH to w × h with the content shifted by (dx, dy): the crop stays on the same pixels. */
export function resizeCrop(c: CropRect | undefined, oldW: number, oldH: number, w: number, h: number, dx: number, dy: number): CropRect | undefined {
  if (!c) return c;
  const x0 = Math.max(0, c.x * oldW + dx);
  const y0 = Math.max(0, c.y * oldH + dy);
  const x1 = Math.min(w, (c.x + c.w) * oldW + dx);
  const y1 = Math.min(h, (c.y + c.h) * oldH + dy);
  if (x1 - x0 < 1 || y1 - y0 < 1) return undefined;
  return sanitizeCrop({ x: x0 / w, y: y0 / h, w: (x1 - x0) / w, h: (y1 - y0) / h });
}

/**
 * Cuts the rectangle (in the pixels of `img`, which shows the whole canvas) out of an RGBA buffer.
 * Exports render the canvas whole and then keep only the crop.
 */
export function extractRect(data: Uint8ClampedArray, width: number, r: PxRect): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  const row = r.w * 4;
  for (let y = 0; y < r.h; y++) {
    const from = ((r.y + y) * width + r.x) * 4;
    out.set(data.subarray(from, from + row), y * row);
  }
  return out;
}
