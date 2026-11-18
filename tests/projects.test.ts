import { describe, expect, it } from 'vitest';
import { cloneDoc, emptyDoc, fxTargetId, makeLayer, pasteLayer, PASTE_OFFSET, sanitizeDoc, type DocState, type Layer } from '../src/doc';
import { defaultState } from '../src/model';
import { dataUrlToBlob, docImageKeys, parseProjectFile, PROJECT_FILE_FORMAT, sanitizeRecord } from '../src/projects';
import { DEFAULT_TEXT } from '../src/text';

function sampleDoc(): DocState {
  const d: DocState = { ...emptyDoc(), w: 800, h: 600, bg: '#123456' };
  const a: Layer = { ...makeLayer(d, 'B1', 400, 300, 'fondo'), fx: defaultState() };
  const b: Layer = { ...makeLayer(d, 'B2', 200, 100, 'logo'), rotation: 37, flipX: true, opacity: 0.4, blend: 'screen', visible: false, scaleX: 0.5, scaleY: 0.75, fx: defaultState() };
  b.fx!.cables = [{ a: 'SUB', b: 'HCLK', amount: 60 }];
  b.fx!.stages.enc.on = true;
  b.fx!.stages.enc.p.jpg = 42;
  const t: Layer = { ...makeLayer(d, 'T|x', 120, 60, 'T · hola'), text: { ...DEFAULT_TEXT, content: 'hola' }, autoName: true, fx: defaultState() };
  d.layers.push(a, b, t);
  d.active = b.id;
  return d;
}

describe('effects target', () => {
  it('is the selected layer', () => {
    const d = sampleDoc();
    expect(fxTargetId(d)).toBe(d.layers[1].id);
  });
  it('falls back to the main image (bottom image layer) with nothing selected', () => {
    const d = sampleDoc();
    d.active = null;
    expect(fxTargetId(d)).toBe(d.layers[0].id);
    d.layers.reverse(); // text layer at the bottom: still the first image layer
    expect(fxTargetId(d)).toBe(d.layers.find((l) => !l.text)!.id);
  });
  it('is null for an empty document and ignores a stale active id', () => {
    expect(fxTargetId(emptyDoc())).toBeNull();
    const d = sampleDoc();
    d.active = 'gone';
    expect(fxTargetId(d)).toBe(d.layers[0].id);
  });
});

describe('paste layer', () => {
  it('inserts an independent copy above the active layer, offset and selected', () => {
    const d = sampleDoc();
    const src = d.layers[1];
    const p = pasteLayer(d, src, 1);
    expect(d.layers.indexOf(p)).toBe(2);
    expect(d.active).toBe(p.id);
    expect(p.id).not.toBe(src.id);
    expect([p.x, p.y]).toEqual([src.x + PASTE_OFFSET, src.y + PASTE_OFFSET]);
    expect(p.fx).toEqual(src.fx);
    expect(p.visible).toBe(true);
    p.fx!.cables.push({ a: 'RG', b: 'OD', amount: 10 });
    expect(src.fx!.cables).toHaveLength(1); // deep copy
  });
  it('successive pastes do not stack exactly', () => {
    const d = sampleDoc();
    const src = d.layers[0];
    const a = pasteLayer(d, src, 1);
    const b = pasteLayer(d, src, 2);
    expect(b.x).toBeGreaterThan(a.x);
  });
  it('pastes into another (empty) document', () => {
    const d = emptyDoc();
    const p = pasteLayer(d, sampleDoc().layers[0]);
    expect(d.layers).toEqual([p]);
    expect(d.active).toBe(p.id);
  });
});

describe('projects', () => {
  it('a saved document survives storage exactly (all layer properties, order, effects, cables)', () => {
    const d = sampleDoc();
    const stored = JSON.parse(JSON.stringify({ id: 'P1', name: ' Mi proyecto ', created: 1, updated: 2, thumb: 'data:image/jpeg;base64,AA', doc: d, fonts: [] }));
    const r = sanitizeRecord(stored)!;
    expect(r.name).toBe('Mi proyecto');
    expect(r.layers).toBe(3);
    expect(r.doc).toEqual(sanitizeDoc(d));
    // sanitizing is stable: a second save/load round does not drift
    expect(sanitizeDoc(JSON.parse(JSON.stringify(r.doc)))).toEqual(r.doc);
    for (const k of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'flipX', 'opacity', 'blend', 'visible', 'name', 'fx'] as const) {
      expect(r.doc.layers[1][k]).toEqual(d.layers[1][k]);
    }
    expect(r.doc.layers.map((l) => l.id)).toEqual(d.layers.map((l) => l.id));
    expect(r.doc.active).toBe(d.active);
    expect(r.doc.layers[2].text).toEqual(d.layers[2].text);
  });
  it('rejects things that are not projects', () => {
    expect(sanitizeRecord(null)).toBeNull();
    expect(sanitizeRecord({ name: 'x' })).toBeNull();
    expect(sanitizeRecord({ id: 'a', doc: {}, thumb: 'javascript:alert(1)' })!.thumb).toBe('');
  });
  it('lists the image keys a document needs (no text, no duplicates)', () => {
    const d = sampleDoc();
    d.layers.push({ ...cloneDoc(d).layers[0], id: 'dup' });
    expect(docImageKeys(d).sort()).toEqual(['B1', 'B2']);
  });
  it('reads a .glitch file with its images', async () => {
    const d = sampleDoc();
    const png = 'data:image/png;base64,' + btoa(String.fromCharCode(137, 80, 78, 71));
    const file = { format: PROJECT_FILE_FORMAT, v: 1, project: { id: 'P9', name: 'f', doc: d, fonts: [] }, images: { B1: png, B2: png }, fonts: {} };
    const { rec, images } = await parseProjectFile(JSON.stringify(file));
    expect(rec.doc).toEqual(sanitizeDoc(d));
    expect([...images.keys()].sort()).toEqual(['B1', 'B2']);
    expect(new Uint8Array(await images.get('B1')!.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(images.get('B1')!.type).toBe('image/png');
  });
  it('refuses a .glitch file with missing images or the wrong format', async () => {
    const d = sampleDoc();
    await expect(parseProjectFile('nope')).rejects.toThrow();
    await expect(parseProjectFile(JSON.stringify({ format: 'otro' }))).rejects.toThrow();
    const file = { format: PROJECT_FILE_FORMAT, v: 1, project: { id: 'P9', name: 'f', doc: d, fonts: [] }, images: { B1: 'data:image/png;base64,AA' } };
    await expect(parseProjectFile(JSON.stringify(file))).rejects.toThrow(/imágenes/);
  });
  it('decodes data URLs', async () => {
    const b = dataUrlToBlob('data:text/plain,hola%20mundo');
    expect(await b.text()).toBe('hola mundo');
  });
});
