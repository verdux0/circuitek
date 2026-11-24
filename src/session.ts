/**
 * Session persistence in IndexedDB (idb-keyval): the document (layers, transforms, effects,
 * text), the gallery, the source images (original files as Blobs, stored once per bitmap)
 * and fonts loaded from files. Everything stays in this browser; nothing is uploaded.
 *
 * localStorage would not do: ~5 MB and strings only (base64 grows images by a third);
 * IndexedDB stores Blobs directly and allows hundreds of MB.
 */
import { createStore, del, get, keys, set, type UseStore } from 'idb-keyval';
import type { DocState } from './doc';
import { migrateIdb } from './legacy';

export interface SavedShot {
  doc: DocState;
  thumb: string;
}
/**
 * Session schema: 2 = text layers may carry fontId / weight (font library); 3 = layers may carry
 * a style, the document a crop and a global light. Older versions are still read (sanitizeDoc).
 */
export const SESSION_VERSION = 3;
export interface SessionData {
  v: 1 | 2 | 3;
  doc: DocState;
  shots: SavedShot[];
  /** Families loaded from font files (their bytes are stored under font:<family>). */
  fonts: string[];
  /** Saved project the document belongs to (Ctrl+S updates it). */
  project?: { id: string; name: string } | null;
}
export interface Restored {
  data: SessionData;
  blobs: Map<string, Blob>;
  fonts: Map<string, Blob>;
}

type BlobSource = Blob | (() => Promise<Blob>);

export class Session {
  private store: UseStore | null = null;
  private timer = 0;
  private saving: Promise<void> | null = null;
  private again = false;
  /** Bitmap keys whose bytes are already in the database. */
  private savedBlobs = new Set<string>();
  private savedFonts = new Set<string>();
  private pendingFonts = new Map<string, Blob>();
  /** Saving starts only after the previous session has been restored (or there was none). */
  ready = false;
  onError: (msg: string) => void = () => {};

  constructor(
    private snapshot: () => SessionData,
    /** Bytes of a bitmap the database does not have yet (original file, or encoded on demand). */
    private blobFor: (key: string) => BlobSource | undefined,
  ) {
    try {
      this.store = createStore('circuitek', 'session');
    } catch {
      this.store = null;
    }
  }

  get available(): boolean {
    return this.store !== null;
  }

  addFont(family: string, blob: Blob): void {
    if (!this.savedFonts.has(family)) this.pendingFonts.set(family, blob);
  }

  /** Debounced save after any change. */
  schedule(): void {
    if (!this.ready || !this.store) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 600);
  }

  /** Saves now (also used when the page is being hidden). */
  async flush(): Promise<void> {
    if (!this.ready || !this.store) return;
    clearTimeout(this.timer);
    if (this.saving) {
      this.again = true;
      return this.saving;
    }
    this.saving = this.write().catch((e: unknown) => this.onError(e instanceof Error ? e.message : String(e)));
    await this.saving;
    this.saving = null;
    if (this.again) {
      this.again = false;
      await this.flush();
    }
  }

  private async write(): Promise<void> {
    const st = this.store!;
    const data = this.snapshot();
    const refs = new Set<string>();
    for (const d of [data.doc, ...data.shots.map((s) => s.doc)]) for (const l of d.layers) if (!l.text) refs.add(l.src);
    // Images referenced but not stored yet (new imports, or brought back by undo).
    for (const k of refs) {
      if (this.savedBlobs.has(k)) continue;
      const b = this.blobFor(k);
      if (!b) continue;
      await set(`blob:${k}`, typeof b === 'function' ? await b() : b, st);
      this.savedBlobs.add(k);
    }
    for (const [f, b] of [...this.pendingFonts]) {
      await set(`font:${f}`, b, st);
      this.savedFonts.add(f);
      this.pendingFonts.delete(f);
    }
    await set('session', data, st);
    // Images no longer referenced by the document or the gallery are deleted.
    for (const k of [...this.savedBlobs]) {
      if (!refs.has(k)) {
        await del(`blob:${k}`, st);
        this.savedBlobs.delete(k);
      }
    }
  }

  /** Reads the previous session, if any. */
  async load(): Promise<Restored | null> {
    if (!this.store) return null;
    const st = this.store;
    await migrateIdb('circuitek', 'session', st);
    const data = (await get('session', st)) as SessionData | undefined;
    const all = (await keys(st)).map(String);
    const blobs = new Map<string, Blob>();
    const fonts = new Map<string, Blob>();
    for (const k of all) {
      if (k.startsWith('blob:')) {
        const b = (await get(k, st)) as Blob | undefined;
        if (b) {
          blobs.set(k.slice(5), b);
          this.savedBlobs.add(k.slice(5));
        }
      } else if (k.startsWith('font:')) {
        const b = (await get(k, st)) as Blob | undefined;
        if (b) {
          fonts.set(k.slice(5), b);
          this.savedFonts.add(k.slice(5));
        }
      }
    }
    if (!data || ![1, 2, 3].includes(data.v) || !data.doc) return null;
    return { data, blobs, fonts };
  }

  /** Forgets everything (new empty session). */
  async clear(): Promise<void> {
    if (!this.store) return;
    for (const k of await keys(this.store)) await del(k, this.store);
    this.savedBlobs.clear();
    this.savedFonts.clear();
  }
}
