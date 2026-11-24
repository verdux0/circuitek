import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIGHT, STYLE_PRESETS, defaultStyle, effectAngle, maskRadii, sanitizeLight, sanitizeStyle, scaleStyle, shadowOffset, styleActive, usesGlobalLight,
} from '../src/layerstyle';
import { cloneDoc, sanitizeDoc } from '../src/doc';

describe('validation and migration', () => {
  it('no style / garbage → undefined (documents saved before layer styles open as they were)', () => {
    for (const x of [undefined, null, 3, 'x']) expect(sanitizeStyle(x)).toBeUndefined();
    const d = sanitizeDoc({ w: 100, h: 100, layers: [{ id: 'a', src: 'k', w: 10, h: 10 }] });
    expect(d.layers[0].style).toBeUndefined();
    expect(d.light).toBeUndefined();
  });
  it('a partial style is completed with the defaults; out-of-range values are clamped', () => {
    const s = sanitizeStyle({ dropShadow: { on: true, opacity: 500, size: -3, color: 'red', blend: 'nope', contour: 'zz', knockout: 0 } })!;
    expect(s.enabled).toBe(true);
    expect(s.dropShadow).toMatchObject({ on: true, opacity: 100, size: 0, color: '#000000', blend: 'multiply', contour: 'linear', knockout: true });
    expect(s.outerGlow.on).toBe(false);
    expect(s.innerGlow.source).toBe('edge');
  });
  it('round trip through a document: sanitize, clone, JSON', () => {
    const style = defaultStyle();
    style.outerGlow = { ...style.outerGlow, on: true, fill: 'gradient', color2: '#123456', technique: 'precise', range: 30 };
    style.innerGlow = { ...style.innerGlow, on: true, source: 'center' };
    const d = sanitizeDoc({ w: 100, h: 100, light: { angle: 45 }, layers: [{ id: 'a', src: 'k', w: 10, h: 10, style }] });
    expect(d.layers[0].style).toEqual(style);
    expect(d.light).toEqual({ angle: 45 });
    const c = cloneDoc(d);
    c.layers[0].style!.outerGlow.size = 99;
    c.light!.angle = 0;
    expect(d.layers[0].style!.outerGlow.size).toBe(5);
    expect(d.light!.angle).toBe(45);
    expect(sanitizeDoc(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });
  it('light angle validated', () => {
    expect(sanitizeLight({ angle: 400 })).toEqual({ angle: 180 });
    expect(sanitizeLight({ angle: 'x' })).toBeUndefined();
  });
  it('every factory style is a valid, active style', () => {
    expect(STYLE_PRESETS.length).toBeGreaterThanOrEqual(4);
    for (const p of STYLE_PRESETS) {
      expect(sanitizeStyle(p.style)).toEqual(p.style);
      expect(styleActive(p.style)).toBe(true);
    }
  });
});

describe('active / global light', () => {
  it('a style with everything off, or hidden, draws nothing', () => {
    const s = defaultStyle();
    expect(styleActive(s)).toBe(false);
    s.dropShadow.on = true;
    expect(styleActive(s)).toBe(true);
    expect(styleActive({ ...s, enabled: false })).toBe(false);
  });
  it('global light: one angle for every effect that uses it; own angle otherwise', () => {
    const s = defaultStyle();
    s.dropShadow = { ...s.dropShadow, on: true, useGlobal: true, angle: 10 };
    s.innerShadow = { ...s.innerShadow, on: true, useGlobal: false, angle: 33 };
    expect(effectAngle(s.dropShadow, { angle: 75 })).toBe(75);
    expect(effectAngle(s.dropShadow, undefined)).toBe(DEFAULT_LIGHT);
    expect(effectAngle(s.innerShadow, { angle: 75 })).toBe(33);
    expect(usesGlobalLight(s)).toBe(true);
    s.dropShadow.useGlobal = false;
    expect(usesGlobalLight(s)).toBe(false);
  });
});

describe('mask maths', () => {
  it('the shadow falls away from the light', () => {
    const [dx, dy] = shadowOffset(120, 10); // light from the upper left
    expect(dx).toBeCloseTo(5);
    expect(dy).toBeCloseTo(8.66, 2);
    expect(shadowOffset(0, 10)).toEqual([-10, 0]); // light from the right → shadow to the left
    expect(shadowOffset(90, 10)[1]).toBeCloseTo(10); // light from above → shadow below
    expect(shadowOffset(45, 0)).toEqual([0, 0]);
  });
  it('spread / choke split the size into growth (hard edge) and blur', () => {
    expect(maskRadii(20, 0)).toEqual({ grow: 0, blur: 20 });
    expect(maskRadii(20, 100)).toEqual({ grow: 20, blur: 0 });
    expect(maskRadii(20, 25)).toEqual({ grow: 5, blur: 15 });
    expect(maskRadii(20, 50, true)).toEqual({ grow: 20, blur: 1 }); // «Precisa»
    expect(maskRadii(-4, 300)).toEqual({ grow: 0, blur: 0 });
  });
  it('scale effects multiplies px settings only', () => {
    const s = defaultStyle();
    s.dropShadow = { ...s.dropShadow, distance: 10, size: 6, opacity: 40, spread: 30 };
    const t = scaleStyle(s, 2);
    expect(t.dropShadow).toMatchObject({ distance: 20, size: 12, opacity: 40, spread: 30 });
    expect(scaleStyle(s, 100).dropShadow.size).toBe(60);
    expect(scaleStyle(s, 1000).dropShadow.size).toBeLessThanOrEqual(250);
    expect(s.dropShadow.distance).toBe(10); // original untouched
  });
});
