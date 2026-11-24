/**
 * Saved projects (IndexedDB, idb-keyval, own database so the autosaved session is untouched).
 *
 *   p:<id>      ProjectRecord: the whole document (layers with transforms, order, visibility,
 *               blend, text and per-layer effects incl. cables), name, dates and thumbnail
 *   blob:<key>  bytes of each source image, stored once and shared between projects
 *   font:<fam>  font files used by text layers
 *
 * Save order is images → fonts → record, and the record is read back before reporting
 * success, so an interrupted save never leaves a project pointing at missing images.
 * A project can also travel as a single `.glitch` file (JSON with the images inlined).
 */
import { createStore, del, get, keys, set, type UseStore } from 'idb-keyval';
import { cloneDoc, sanitizeDoc, type DocState } from './doc';
import { migrateIdb } from './legacy';

export interface ProjectMeta {
  id: string;
  name: string;
  created: number;
  updated: number;
  /** Small JPEG data URL. */
  thumb: string;
  layers: number;
}
/** Project schema: 2 = fontId / weight on text layers; 3 = layer styles, crop, global light. Older ones open as is. */
export const PROJECT_VERSION = 3;
export interface ProjectRecord extends ProjectMeta {
  v: 1 | 2 | 3;
  doc: DocState;
  /** Families of font files the text layers use (bytes under font:<family>). */
  fonts: string[];
}
export interface LoadedProject {
  rec: ProjectRecord;
  blob(key: string): Promise<Blob | undefined>;
  font(family: string): Promise<Blob | undefined>;
}
type BlobSource = Blob | (() => Promise<Blob>);

export const PROJECT_FILE_FORMAT = 'circuitek-project';
/** Files saved before the rename to circuitek. */
const LEGACY_FILE_FORMAT = 'glitch-editor-project';

/** Image keys (bitmaps) a document needs. */
export function docImageKeys(d: DocState): string[] {
  return [...new Set(d.layers.filter((l) => !l.text && l.src).map((l) => l.src))];
}

/** Validates a stored / imported record; null if it is not a project. */
export function sanitizeRecord(x: unknown): ProjectRecord | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || !o.doc) return null;
  const doc = sanitizeDoc(o.doc);
  const now = Date.now();
  return {
    v: PROJECT_VERSION,
    id: o.id.slice(0, 64),
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : 'Proyecto',
    created: typeof o.created === 'number' ? o.created : now,
    updated: typeof o.updated === 'number' ? o.updated : now,
    thumb: typeof o.thumb === 'string' && o.thumb.startsWith('data:image/') ? o.thumb : '',
    layers: doc.layers.length,
    doc,
    fonts: Array.isArray(o.fonts) ? o.fonts.filter((f): f is string => typeof f === 'string').slice(0, 50) : [],
  };
}

export class ProjectStore {
  private store: UseStore | null = null;
  /** Blob / font keys known to be stored (avoids re-writing shared images). */
  private have = new Set<string>();
  private ready: Promise<void>;

  constructor(dbName = 'circuitek-projects') {
    try {
      this.store = createStore(dbName, 'projects');
    } catch {
      this.store = null;
    }
    this.ready = this.store
      ? migrateIdb(dbName, 'projects', this.store)
          .then(() => keys(this.store!))
          .then((ks) => ks.forEach((k) => String(k).startsWith('p:') || this.have.add(String(k)))).catch(() => {})
      : Promise.resolve();
  }

  get available(): boolean {
    return this.store !== null;
  }

  private st(): UseStore {
    if (!this.store) throw new Error('Este navegador no permite guardar proyectos (IndexedDB no disponible)');
    return this.store;
  }

  /** All projects, most recently saved first (without their documents). */
  async list(): Promise<ProjectMeta[]> {
    if (!this.store) return [];
    await this.ready;
    const st = this.store;
    const out: ProjectMeta[] = [];
    for (const k of await keys(st)) {
      if (!String(k).startsWith('p:')) continue;
      const r = sanitizeRecord(await get(k, st));
      if (r) out.push({ id: r.id, name: r.name, created: r.created, updated: r.updated, thumb: r.thumb, layers: r.layers });
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  async get(id: string): Promise<ProjectRecord | null> {
    await this.ready;
    return sanitizeRecord(await get(`p:${id}`, this.st()));
  }

  /**
   * Saves (creates or replaces) a project. `blobFor` supplies the bytes of images this
   * database does not have yet; a missing image aborts the save (nothing half-written).
   */
  async save(rec: ProjectRecord, blobFor: (key: string) => BlobSource | undefined, fontFor: (family: string) => Blob | undefined): Promise<void> {
    const st = this.st();
    await this.ready;
    const doc = cloneDoc(rec.doc);
    for (const k of docImageKeys(doc)) {
      const key = `blob:${k}`;
      if (this.have.has(key)) continue;
      const src = blobFor(k);
      if (!src) throw new Error(`falta la imagen de la capa «${doc.layers.find((l) => l.src === k)?.name ?? k}»`);
      await set(key, typeof src === 'function' ? await src() : src, st);
      this.have.add(key);
    }
    for (const f of rec.fonts) {
      const key = `font:${f}`;
      if (this.have.has(key)) continue;
      const b = fontFor(f);
      if (!b) continue; // the text falls back to another font; the project is still whole
      await set(key, b, st);
      this.have.add(key);
    }
    const out: ProjectRecord = { ...rec, v: PROJECT_VERSION, doc, layers: doc.layers.length };
    await set(`p:${rec.id}`, out, st);
    // Read back: the save only counts if the record is really there.
    const back = (await get(`p:${rec.id}`, st)) as ProjectRecord | undefined;
    if (!back || JSON.stringify(back.doc) !== JSON.stringify(doc)) throw new Error('la base de datos no confirmó el guardado');
  }

  async load(id: string): Promise<LoadedProject | null> {
    const st = this.st();
    const rec = await this.get(id);
    if (!rec) return null;
    return {
      rec,
      blob: async (k) => (await get(`blob:${k}`, st)) as Blob | undefined,
      font: async (f) => (await get(`font:${f}`, st)) as Blob | undefined,
    };
  }

  async rename(id: string, name: string): Promise<void> {
    const st = this.st();
    const rec = await this.get(id);
    if (!rec) return;
    rec.name = name.trim().slice(0, 80) || rec.name;
    await set(`p:${id}`, rec, st);
  }

  /** Deletes a project and the images / fonts no other project uses. */
  async remove(id: string): Promise<void> {
    const st = this.st();
    await del(`p:${id}`, st);
    const used = new Set<string>();
    for (const k of await keys(st)) {
      if (!String(k).startsWith('p:')) continue;
      const r = sanitizeRecord(await get(k, st));
      if (!r) continue;
      docImageKeys(r.doc).forEach((s) => used.add(`blob:${s}`));
      r.fonts.forEach((f) => used.add(`font:${f}`));
    }
    for (const k of await keys(st)) {
      const key = String(k);
      if ((key.startsWith('blob:') || key.startsWith('font:')) && !used.has(key)) {
        await del(key, st);
        this.have.delete(key);
      }
    }
  }

  /* ------------------------------ .glitch files ------------------------------ */

  /** One self-contained file: record + images and fonts as data URLs. */
  async exportFile(id: string): Promise<Blob> {
    const p = await this.load(id);
    if (!p) throw new Error('el proyecto ya no existe');
    const images: Record<string, string> = {};
    for (const k of docImageKeys(p.rec.doc)) {
      const b = await p.blob(k);
      if (!b) throw new Error(`falta la imagen «${k}»`);
      images[k] = await blobToDataUrl(b);
    }
    const fonts: Record<string, string> = {};
    for (const f of p.rec.fonts) {
      const b = await p.font(f);
      if (b) fonts[f] = await blobToDataUrl(b);
    }
    const file = { format: PROJECT_FILE_FORMAT, v: PROJECT_VERSION, project: p.rec, images, fonts };
    return new Blob([JSON.stringify(file)], { type: 'application/json' });
  }
}

/** Parses a `.glitch` file. Throws with a readable message when it is not one. */
export async function parseProjectFile(text: string): Promise<{ rec: ProjectRecord; images: Map<string, Blob>; fonts: Map<string, Blob> }> {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('no es un archivo de proyecto');
  }
  if (o?.format !== PROJECT_FILE_FORMAT && o?.format !== LEGACY_FILE_FORMAT) throw new Error('no es un archivo de proyecto');
  const rec = sanitizeRecord(o.project);
  if (!rec) throw new Error('el proyecto está dañado');
  const images = new Map<string, Blob>();
  const imgs = (o.images ?? {}) as Record<string, unknown>;
  for (const k of docImageKeys(rec.doc)) {
    const u = imgs[k];
    if (typeof u !== 'string' || !u.startsWith('data:image/')) throw new Error('faltan imágenes dentro del archivo');
    images.set(k, dataUrlToBlob(u));
  }
  const fonts = new Map<string, Blob>();
  const fs = (o.fonts ?? {}) as Record<string, unknown>;
  for (const f of rec.fonts) {
    const u = fs[f];
    if (typeof u === 'string' && u.startsWith('data:')) fonts.set(f, dataUrlToBlob(u));
  }
  return { rec, images, fonts };
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error ?? new Error('no se pudo leer la imagen'));
    r.readAsDataURL(b);
  });
}

export function dataUrlToBlob(u: string): Blob {
  const comma = u.indexOf(',');
  const head = u.slice(5, comma);
  const type = head.split(';')[0] || 'application/octet-stream';
  const body = u.slice(comma + 1);
  if (!head.includes(';base64')) return new Blob([decodeURIComponent(body)], { type });
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
