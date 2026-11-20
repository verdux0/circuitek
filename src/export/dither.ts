/**
 * Palette mapping with dithering, for GIF frames. Standard public-domain algorithms
 * (Bayer ordered dithering, Floyd–Steinberg error diffusion), written here because gifenc
 * maps to the nearest color only.
 *
 * Bayer is the default for animation: its pattern is fixed in screen space, so it does not
 * "boil" from frame to frame (error diffusion does) and it compresses better.
 */
import type { Dither } from './settings';

export type Palette = number[][];

/** 4×4 Bayer matrix, values 0..15. */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Nearest palette index with a 6-bit-per-channel cache (exact search on a miss). */
function makeNearest(palette: Palette): (r: number, g: number, b: number) => number {
  const cache = new Int16Array(1 << 18).fill(-1);
  const n = palette.length;
  const pr = new Int32Array(n), pg = new Int32Array(n), pb = new Int32Array(n);
  palette.forEach((c, i) => { pr[i] = c[0]; pg[i] = c[1]; pb[i] = c[2]; });
  return (r, g, b) => {
    r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
    g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
    b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const hit = cache[key];
    if (hit >= 0) return hit;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      // Weighted RGB distance (perceptual enough, cheap).
      const dr = r - pr[i], dg = g - pg[i], db = b - pb[i];
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bd) { bd = d; best = i; }
    }
    cache[key] = best;
    return best;
  };
}

/** Typical distance between palette colors: the Bayer threshold is scaled to it. */
export function paletteSpread(colors: number): number {
  return 255 / Math.max(1, Math.cbrt(Math.max(2, colors)) - 1);
}

/**
 * Maps RGBA pixels to palette indices. `transparentIndex` ≥ 0 (the palette's last entry):
 * pixels with alpha < 128 get it (GIF transparency is 1 bit) and colours never map to it.
 * Otherwise alpha is ignored (opaque frames).
 */
export function ditherToIndex(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, palette: Palette, mode: Dither, transparentIndex = -1): Uint8Array {
  const out = new Uint8Array(w * h);
  const clear = transparentIndex >= 0;
  const nearest = makeNearest(clear ? palette.slice(0, transparentIndex) : palette);
  const hole = (p: number) => clear && rgba[p + 3] < 128;
  if (mode === 'none') {
    for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = hole(p) ? transparentIndex : nearest(rgba[p], rgba[p + 1], rgba[p + 2]);
    return out;
  }
  if (mode === 'bayer') {
    const s = paletteSpread(clear ? transparentIndex : palette.length) * 0.5;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const p = i * 4;
        if (hole(p)) {
          out[i] = transparentIndex;
          continue;
        }
        const t = ((BAYER4[((y & 3) << 2) | (x & 3)] + 0.5) / 16 - 0.5) * s;
        out[i] = nearest(rgba[p] + t, rgba[p + 1] + t, rgba[p + 2] + t);
      }
    }
    return out;
  }
  // Floyd–Steinberg, serpentine scan, errors in two float rows.
  let cur = new Float32Array((w + 2) * 3);
  let next = new Float32Array((w + 2) * 3);
  for (let y = 0; y < h; y++) {
    const ltr = (y & 1) === 0;
    for (let k = 0; k < w; k++) {
      const x = ltr ? k : w - 1 - k;
      const i = y * w + x;
      const p = i * 4;
      const e = (x + 1) * 3;
      if (hole(p)) {
        out[i] = transparentIndex; // no error is carried across a hole
        continue;
      }
      const r = rgba[p] + cur[e], g = rgba[p + 1] + cur[e + 1], b = rgba[p + 2] + cur[e + 2];
      const idx = nearest(r, g, b);
      out[i] = idx;
      const c = palette[idx];
      const er = r - c[0], eg = g - c[1], eb = b - c[2];
      const dx = ltr ? 3 : -3;
      for (let ch = 0; ch < 3; ch++) {
        const err = ch === 0 ? er : ch === 1 ? eg : eb;
        cur[e + dx + ch] += (err * 7) / 16;
        next[e - dx + ch] += (err * 3) / 16;
        next[e + ch] += (err * 5) / 16;
        next[e + dx + ch] += err / 16;
      }
    }
    [cur, next] = [next, cur];
    next.fill(0);
  }
  return out;
}
