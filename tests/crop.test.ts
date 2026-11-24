import { describe, expect, it } from 'vitest';
import {
  CROP_MIN, clampRect, cropPx, dragHandle, extractRect, fitRatio, flipCrop, isFull, moveRect, rectFromPoints, resizeCrop, rotateCrop, sanitizeCrop, toCrop, viewSize,
} from '../src/crop';
import { cloneDoc, emptyDoc, flipDoc, resizeDoc, rotateDoc, sanitizeDoc, scaleDoc } from '../src/doc';

const W = 1600;
const H = 1200;

describe('stored crop', () => {
  it('validates, clamps and drops the whole canvas', () => {
    expect(sanitizeCrop({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 })).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
    expect(sanitizeCrop({ x: 0, y: 0, w: 1, h: 1 })).toBeUndefined();
    expect(sanitizeCrop({ x: 0.8, y: 0, w: 0.9, h: 0.5 })).toEqual({ x: 0.8, y: 0, w: expect.closeTo(0.2), h: 0.5 });
    for (const bad of [null, 'x', { x: 'a', y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 0, h: 0.5 }, { x: NaN, y: 0, w: 0.5, h: 0.5 }]) expect(sanitizeCrop(bad)).toBeUndefined();
    expect(isFull({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
  });
  it('documents keep their crop through sanitize and clone (old documents have none)', () => {
    const d = sanitizeDoc({ w: W, h: H, layers: [], crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
    expect(d.crop).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    const c = cloneDoc(d);
    c.crop!.x = 0;
    expect(d.crop!.x).toBe(0.25);
    expect(sanitizeDoc({ w: W, h: H, layers: [] }).crop).toBeUndefined();
  });
});

describe('pixels ↔ normalised', () => {
  it('round-trips and sizes', () => {
    const r = { x: 100, y: 50, w: 800, h: 600 };
    const c = toCrop(W, H, r)!;
    expect(cropPx(W, H, c)).toEqual(r);
    expect(viewSize(W, H, c)).toEqual([800, 600]);
    expect(viewSize(W, H, undefined)).toEqual([W, H]);
    // Resolution independent: the same crop on a canvas twice as big.
    expect(cropPx(W * 2, H * 2, c)).toEqual({ x: 200, y: 100, w: 1600, h: 1200 });
  });
});

describe('rectangle limits', () => {
  it('stays inside the canvas and above the minimum', () => {
    expect(clampRect({ x: -50, y: -50, w: 100, h: 100 }, W, H)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(clampRect({ x: 1590, y: 0, w: 2, h: 2 }, W, H)).toEqual({ x: 1590, y: 0, w: CROP_MIN, h: CROP_MIN });
    expect(clampRect({ x: 1599, y: 0, w: 2, h: 2 }, W, H).x).toBe(W - CROP_MIN);
    expect(moveRect({ x: 10, y: 10, w: 100, h: 100 }, 5000, -5000, W, H)).toEqual({ x: W - 100, y: 0, w: 100, h: 100 });
  });
  it('free handles move only their edges, never past the opposite one', () => {
    const s = { x: 100, y: 100, w: 400, h: 300 };
    expect(dragHandle(s, 'e', 50, 999, W, H, null)).toEqual({ x: 100, y: 100, w: 450, h: 300 });
    expect(dragHandle(s, 'nw', -50, -20, W, H, null)).toEqual({ x: 50, y: 80, w: 450, h: 320 });
    expect(dragHandle(s, 'w', 10000, 0, W, H, null).w).toBe(CROP_MIN);
    expect(dragHandle(s, 'se', 99999, 99999, W, H, null)).toEqual({ x: 100, y: 100, w: W - 100, h: H - 100 });
  });
  it('corners keep the ratio around the opposite corner', () => {
    const s = { x: 100, y: 100, w: 400, h: 400 };
    const r = dragHandle(s, 'se', 200, 10, W, H, 1);
    expect(r.w).toBeCloseTo(r.h);
    expect(r.x).toBe(100);
    expect(r.y).toBe(100);
    const r2 = dragHandle(s, 'se', 5000, 5000, W, H, 16 / 9);
    expect(r2.w / r2.h).toBeCloseTo(16 / 9, 3);
    expect(r2.x + r2.w).toBeLessThanOrEqual(W + 1e-9);
    expect(r2.y + r2.h).toBeLessThanOrEqual(H + 1e-9);
  });
  it('side handles with a ratio grow around the centre', () => {
    const r = dragHandle({ x: 400, y: 400, w: 400, h: 400 }, 'e', 200, 0, W, H, 1);
    expect(r.w).toBeCloseTo(600);
    expect(r.h).toBeCloseTo(600);
    expect(r.y + r.h / 2).toBeCloseTo(600);
  });
  it('drawing a new rectangle in any direction, with or without a ratio', () => {
    expect(rectFromPoints(300, 300, 100, 200, W, H, null)).toEqual({ x: 100, y: 200, w: 200, h: 100 });
    const r = rectFromPoints(0, 0, 900, 100, W, H, 9 / 16);
    expect(r.w / r.h).toBeCloseTo(9 / 16);
    expect(r.h).toBeLessThanOrEqual(H);
  });
  it('switching to a preset keeps the centre and fits inside', () => {
    const r = fitRatio({ x: 0, y: 0, w: W, h: H }, 1, W, H);
    expect(r).toEqual({ x: 200, y: 0, w: 1200, h: 1200 });
    expect(fitRatio({ x: 0, y: 0, w: W, h: H }, 16 / 9, W, H).w / fitRatio({ x: 0, y: 0, w: W, h: H }, 16 / 9, W, H).h).toBeCloseTo(16 / 9);
  });
});

describe('crop follows document operations', () => {
  const crop = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  it('rotate 90° and back', () => {
    const r = rotateCrop(crop, 1)!;
    expect(r).toEqual({ x: expect.closeTo(0.4), y: 0.1, w: 0.4, h: 0.3 });
    const back = rotateCrop(r, -1)!;
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(back[k]).toBeCloseTo(crop[k]);
  });
  it('flip', () => {
    expect(flipCrop(crop, 'h')!.x).toBeCloseTo(0.6);
    expect(flipCrop(crop, 'v')!.y).toBeCloseTo(0.4);
  });
  it('canvas resize keeps the crop on the same pixels; cropped away = no crop', () => {
    const r = resizeCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1000, 1000, 2000, 2000, 500, 500)!;
    expect(cropPx(2000, 2000, r)).toEqual({ x: 750, y: 750, w: 500, h: 500 });
    expect(resizeCrop({ x: 0, y: 0, w: 0.1, h: 0.1 }, 1000, 1000, 500, 500, -600, -600)).toBeUndefined();
  });
  it('through rotateDoc / flipDoc / resizeDoc / scaleDoc', () => {
    const d = { ...emptyDoc(), crop: { ...crop } };
    rotateDoc(d, 1);
    expect(d.crop!.w).toBeCloseTo(0.4);
    rotateDoc(d, -1);
    flipDoc(d, 'h');
    expect(d.crop!.x).toBeCloseTo(0.6);
    scaleDoc(d, 800, 600);
    expect(d.crop!.x).toBeCloseTo(0.6);
    const px = cropPx(d.w, d.h, d.crop);
    resizeDoc(d, d.w + 200, d.h, 0, 0);
    expect(cropPx(d.w, d.h, d.crop).x).toBe(px.x);
  });
});

describe('cutting the crop out of a full render', () => {
  it('copies exactly the rectangle', () => {
    const w = 4;
    const h = 3;
    const data = new Uint8ClampedArray(w * h * 4).map((_, i) => i);
    const out = extractRect(data, w, { x: 1, y: 1, w: 2, h: 2 });
    expect([...out.slice(0, 4)]).toEqual([20, 21, 22, 23]); // pixel (1, 1)
    expect([...out.slice(12, 16)]).toEqual([40, 41, 42, 43]); // pixel (2, 2)
    expect(out.length).toBe(16);
  });
});
