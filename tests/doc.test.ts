import { describe, expect, it } from 'vitest';
import {
  apply,
  clampSize,
  cropDocTo,
  emptyDoc,
  fitLayer,
  flipDoc,
  flipLayer,
  fromLinear,
  layerBounds,
  layerCorners,
  layerMatrix,
  makeLayer,
  moveLayer,
  normDeg,
  resizeDoc,
  rotateDoc,
  scaleDoc,
  type DocState,
  type Layer,
} from '../src/doc';

const close = (a: number[][], b: number[][]) => a.forEach((p, i) => p.forEach((v, j) => expect(v).toBeCloseTo(b[i][j], 6)));

function docWith(...ls: Partial<Layer>[]): DocState {
  const d: DocState = { ...emptyDoc(), w: 800, h: 600 };
  for (const p of ls) d.layers.push({ ...makeLayer(d, 's', 400, 200, 'x'), ...p });
  return d;
}

describe('layer geometry', () => {
  it('identity layer at the center maps its corners around the center', () => {
    const d = docWith({ scaleX: 1, scaleY: 1 });
    close(layerCorners(d.layers[0]), [[200, 200], [600, 200], [600, 400], [200, 400]]);
  });
  it('rotation +90 is clockwise on screen', () => {
    const [l] = docWith({ rotation: 90, scaleX: 1, scaleY: 1 }).layers;
    // bitmap top-left goes to the top-right of the rotated box
    close([apply(layerMatrix(l), 0, 0)], [[500, 100]]);
  });
  it('fromLinear recovers scale and rotation, keeping flips', () => {
    for (const flipX of [false, true])
      for (const flipY of [false, true]) {
        const [l] = docWith({ rotation: 33, scaleX: 1.5, scaleY: 0.5, flipX, flipY }).layers;
        const m = layerMatrix(l);
        const r = fromLinear(m[0], m[1], m[2], m[3], flipX, flipY);
        expect(r.rotation).toBeCloseTo(33, 6);
        expect(r.scaleX).toBeCloseTo(1.5, 6);
        expect(r.scaleY).toBeCloseTo(0.5, 6);
      }
  });
  it('flipLayer mirrors in place (same bounding box, mirrored corners)', () => {
    const [l] = docWith({ rotation: 30, scaleX: 1, scaleY: 1 }).layers;
    const before = layerCorners(l);
    flipLayer(l, 'h');
    const after = layerCorners(l);
    // corner i after the flip is the mirror (about x = l.x) of corner i before it
    close(after, before.map(([x, y]) => [2 * l.x - x, y]));
    flipLayer(l, 'h');
    close(layerCorners(l), before);
  });
  it('fitLayer contain / cover', () => {
    const d = docWith({});
    fitLayer(d, d.layers[0], 'contain');
    expect(layerBounds(d.layers[0]).w).toBeCloseTo(800, 6);
    fitLayer(d, d.layers[0], 'cover');
    expect(layerBounds(d.layers[0]).h).toBeCloseTo(600, 6);
    d.layers[0].rotation = 90;
    fitLayer(d, d.layers[0], 'contain');
    const b = layerBounds(d.layers[0]);
    expect(b.h).toBeCloseTo(600, 6);
    expect(b.w).toBeLessThanOrEqual(800 + 1e-6);
  });
  it('new layers larger than the canvas are shrunk to fit', () => {
    const d: DocState = { ...emptyDoc(), w: 100, h: 100 };
    const l = makeLayer(d, 's', 400, 200, 'big');
    expect(l.scaleX).toBeCloseTo(0.25);
    expect(l.x).toBe(50);
  });
  it('normDeg', () => {
    expect(normDeg(270)).toBe(-90);
    expect(normDeg(-180)).toBe(180);
    expect(normDeg(720)).toBe(0);
  });
});

describe('document operations', () => {
  it('rotateDoc carries every layer: corners are rotated with the canvas', () => {
    const d = docWith({ x: 100, y: 120, rotation: 15, scaleX: 0.5, scaleY: 0.7, flipX: true });
    const before = layerCorners(d.layers[0]);
    rotateDoc(d, 1);
    expect([d.w, d.h]).toEqual([600, 800]);
    close(layerCorners(d.layers[0]), before.map(([x, y]) => [600 - y, x]));
    rotateDoc(d, -1);
    expect([d.w, d.h]).toEqual([800, 600]);
    close(layerCorners(d.layers[0]), before);
  });
  it('flipDoc mirrors the canvas', () => {
    const d = docWith({ x: 100, y: 120, rotation: 15 });
    const before = layerCorners(d.layers[0]);
    flipDoc(d, 'v');
    close(layerCorners(d.layers[0]), before.map(([x, y]) => [x, 600 - y]));
  });
  it('cropDocTo fits the canvas to a layer', () => {
    const d = docWith({ x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 });
    cropDocTo(d, [d.layers[0]]);
    expect([d.w, d.h]).toEqual([400, 200]);
    const b = layerBounds(d.layers[0]);
    expect(b.x).toBeCloseTo(0);
    expect(b.y).toBeCloseTo(0);
  });
  it('moveLayer reorders', () => {
    const d = docWith({ name: 'a' }, { name: 'b' }, { name: 'c' });
    moveLayer(d, d.layers[0].id, 2);
    expect(d.layers.map((l) => l.name)).toEqual(['b', 'c', 'a']);
  });
  it('clampSize keeps the aspect ratio under the limits', () => {
    expect(clampSize(20000, 10000, 16384, 48)).toEqual([9797, 4898]);
    expect(clampSize(100, 50, 16384, 48)).toEqual([100, 50]);
  });
});

describe('text layers', () => {
  it('cloneDoc deep-copies text props (gallery shots stay intact)', async () => {
    const { cloneDoc, textLayerName } = await import('../src/doc');
    const { DEFAULT_TEXT } = await import('../src/text');
    const d = docWith({ text: { ...DEFAULT_TEXT } });
    const c = cloneDoc(d);
    c.layers[0].text!.content = 'otro';
    expect(d.layers[0].text!.content).toBe(DEFAULT_TEXT.content);
    expect(textLayerName('\n  hola mundo\nsegunda')).toBe('T · hola mundo');
    expect(textLayerName('   ')).toBe('T · (vacío)');
  });
  it('cssFont quotes families but not generic keywords', async () => {
    const { cssFont } = await import('../src/text');
    expect(cssFont({ font: 'Press Start 2P', size: 20, bold: true, italic: true })).toBe('italic 700 20px "Press Start 2P", sans-serif');
    expect(cssFont({ font: 'monospace', size: 10, bold: false, italic: false })).toBe('400 10px monospace, sans-serif');
  });
});

describe('Imagen menu: canvas size vs image size', () => {
  it('Tamaño de la imagen scales the content with the canvas: layer bounds keep their place in %', () => {
    const d = docWith({ x: 200, y: 150, w: 100, h: 50 });
    const before = layerBounds(d.layers[0]);
    scaleDoc(d, 1600, 1200);
    expect([d.w, d.h]).toEqual([1600, 1200]);
    const after = layerBounds(d.layers[0]);
    close([[after.x, after.y, after.w, after.h]], [[before.x * 2, before.y * 2, before.w * 2, before.h * 2]]);
  });
  it('Tamaño de lienzo with an anchor shifts layers by (Δw·ax, Δh·ay) without scaling them', () => {
    const d = docWith({ x: 100, y: 100, w: 50, h: 50 });
    // Anchor top-left: content stays where it was.
    resizeDoc(d, 1000, 900, 0, 0);
    expect([d.layers[0].x, d.layers[0].y, d.layers[0].scaleX]).toEqual([100, 100, 1]);
    // Anchor bottom-right: content moves by the whole difference.
    resizeDoc(d, 1200, 1000, 200, 100);
    expect([d.layers[0].x, d.layers[0].y]).toEqual([300, 200]);
  });
});
