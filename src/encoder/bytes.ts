/**
 * Byte-level glitches (pure functions, no DOM): real JPEG stream corruption and pixel sorting.
 * Written from scratch for this project; the idea of corrupting only the entropy-coded
 * scan data follows snorpey/jpg-glitch.
 */
import type { Rng } from '../prng';

/** Index of the first byte of entropy-coded data (just after the SOS header), or -1. */
export function findScanStart(b: Uint8Array): number {
  for (let i = 2; i < b.length - 3; i++) {
    if (b[i] === 0xff && b[i + 1] === 0xda) {
      const len = (b[i + 2] << 8) | b[i + 3];
      return i + 2 + len;
    }
  }
  return -1;
}

/**
 * Overwrites `count` random bytes of the scan data. Never touches the headers, never
 * writes 0xFF and never edits a byte that follows 0xFF, so markers stay intact and the
 * file still decodes (with glitches).
 */
export function corruptJpegBytes(src: Uint8Array, count: number, rng: Rng): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(src);
  const start = findScanStart(out);
  const end = out.length - 2; // keep EOI
  if (start < 0 || end <= start + 1) return out;
  for (let i = 0; i < count; i++) {
    const pos = start + Math.floor(rng() * (end - start));
    let v = Math.floor(rng() * 256);
    if (v === 0xff) v = 0xfe;
    if (out[pos] === 0xff || out[pos - 1] === 0xff) continue;
    out[pos] = v;
  }
  return out;
}

/** Horizontal strips encoded independently (simulated restart intervals). */
export const STRIPS = 10;

/** Corrupted bytes in one strip for a 0..100 knob value (1..~8, randomised). */
export function corruptionCount(amount: number, rng: Rng): number {
  if (amount <= 0) return 0;
  return 1 + Math.floor(rng() * (1 + (amount / 100) * 7));
}

const lumaAt = (d: Uint8ClampedArray, i: number) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 255000;

/**
 * Pixel sort ("interval" mode). A span starts at a pixel brighter than `threshold` (0..1)
 * and runs while pixels stay above half the threshold, up to `maxLenFrac`² of the line.
 * The span is sorted by luminance. dir: 0 →, 1 ←, 2 ↓, 3 ↑.
 */
export function pixelSort(data: Uint8ClampedArray, w: number, h: number, threshold: number, maxLenFrac: number, dir: number): void {
  const vertical = dir >= 2;
  const desc = dir === 1 || dir === 3;
  const lines = vertical ? w : h;
  const len = vertical ? h : w;
  const f = Math.min(1, Math.max(0.01, maxLenFrac));
  const maxLen = Math.max(2, Math.round(len * f * f));
  const lo = threshold * 0.5;
  const idx = new Int32Array(len);
  const lum = new Float32Array(len);
  const tmp = new Uint8ClampedArray(maxLen * 4);
  const order: number[] = [];
  for (let line = 0; line < lines; line++) {
    for (let k = 0; k < len; k++) {
      const p = vertical ? (k * w + line) * 4 : (line * w + k) * 4;
      idx[k] = p;
      lum[k] = lumaAt(data, p);
    }
    let k = 0;
    while (k < len) {
      if (lum[k] < threshold) {
        k++;
        continue;
      }
      let e = k;
      while (e < len && lum[e] >= lo && e - k < maxLen) e++;
      const n = e - k;
      if (n > 1) {
        order.length = 0;
        for (let j = 0; j < n; j++) order.push(k + j);
        order.sort((a, b) => (desc ? lum[b] - lum[a] : lum[a] - lum[b]) || a - b);
        for (let j = 0; j < n; j++) tmp.set(data.subarray(idx[order[j]], idx[order[j]] + 4), j * 4);
        for (let j = 0; j < n; j++) data.set(tmp.subarray(j * 4, j * 4 + 4), idx[k + j]);
      }
      k = e;
    }
  }
}
