/**
 * Where exports go. Two sinks, same interface:
 * - FolderSink: a folder chosen once with showDirectoryPicker (Chromium), remembered in
 *   IndexedDB. Writes stream into a FileSystemWritableFileStream, which commits nothing until
 *   close(): cancel = abort() + remove the entry we created → no half-written files.
 * - DownloadSink: everywhere else. Bytes are collected and handed to <a download> at the end;
 *   the browser decides the folder (said in the UI).
 */
import { createStore, del, get, set, type UseStore } from 'idb-keyval';

export interface SaveSink {
  readonly name: string;
  /** Random-access writable for muxers (folder sink only). */
  readonly writable: WritableStream<{ type: 'write'; data: Uint8Array; position: number }> | null;
  write(bytes: Uint8Array): Promise<void>;
  /** Commits the file; returns where it went (for the toast). */
  finish(type: string): Promise<string>;
  /** Discards everything written (idempotent). */
  abort(): Promise<void>;
}

export const canPickFolder = (): boolean => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

let store: UseStore | null = null;
const handles = (): UseStore => (store ??= createStore('glitch-editor-export', 'handles'));

/** The remembered export folder (null if none or not supported). */
export async function savedFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!canPickFolder()) return null;
  try {
    return ((await get('folder', handles())) as FileSystemDirectoryHandle | undefined) ?? null;
  } catch {
    return null;
  }
}
export async function rememberFolder(h: FileSystemDirectoryHandle | null): Promise<void> {
  try {
    if (h) await set('folder', h, handles());
    else await del('folder', handles());
  } catch {
    /* IndexedDB unavailable: the folder just is not remembered */
  }
}
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await window.showDirectoryPicker!({ id: 'glitch-export', mode: 'readwrite' })) ?? null;
  } catch {
    return null; // cancelled by the user
  }
}

/** Write permission for a remembered folder; asks again if the browser dropped it (needs a click). */
export async function ensurePermission(h: FileSystemDirectoryHandle): Promise<boolean> {
  const d = { mode: 'readwrite' as const };
  if (!h.queryPermission) return true;
  if ((await h.queryPermission(d)) === 'granted') return true;
  try {
    return (await h.requestPermission?.(d)) === 'granted';
  } catch {
    return false;
  }
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** "name.ext", or "name (2).ext"… so an export never overwrites an existing file. */
export async function freeName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  if (!(await exists(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 1000; i++) {
    const n = `${base} (${i})${ext}`;
    if (!(await exists(dir, n))) return n;
  }
  return `${base}-${Date.now().toString(36)}${ext}`;
}

export class FolderSink implements SaveSink {
  private fs!: FileSystemWritableFileStream;
  private done = false;
  private cancelled = false;
  /** Sequential write offset (append mode for write()). */
  private pos = 0;
  writable: SaveSink['writable'] = null;

  private constructor(private dir: FileSystemDirectoryHandle, readonly name: string) {}

  static async open(dir: FileSystemDirectoryHandle, name: string): Promise<FolderSink> {
    const s = new FolderSink(dir, await freeName(dir, name));
    const fh = await dir.getFileHandle(s.name, { create: true });
    s.fs = await fh.createWritable({ keepExistingData: false });
    // Muxers close their stream when they finish *or* cancel; a cancelled export must not
    // commit, so closing is routed through the cancel flag.
    s.writable = new WritableStream({
      write: (c) => s.fs.write({ type: 'write', position: c.position, data: c.data as Uint8Array<ArrayBuffer> }),
      close: async () => {
        if (s.cancelled) await s.discard();
      },
      abort: async () => s.discard(),
    });
    return s;
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.fs.write({ type: 'write', position: this.pos, data: bytes as Uint8Array<ArrayBuffer> });
    this.pos += bytes.byteLength;
  }

  async finish(): Promise<string> {
    this.done = true;
    await this.fs.close();
    return `carpeta «${this.dir.name}»`;
  }

  private async discard(): Promise<void> {
    if (this.done) return;
    this.done = true;
    try {
      await this.fs.abort();
    } catch {
      /* already closed */
    }
    // createWritable never touched the real file, but getFileHandle(create) made an empty one.
    await this.dir.removeEntry(this.name).catch(() => {});
  }

  async abort(): Promise<void> {
    this.cancelled = true;
    await this.discard();
  }
}

export class DownloadSink implements SaveSink {
  private parts: Uint8Array[] = [];
  private aborted = false;
  readonly writable = null;
  constructor(readonly name: string) {}
  async write(bytes: Uint8Array): Promise<void> {
    if (!this.aborted) this.parts.push(bytes);
  }
  /** For muxers that build the whole file in memory (BufferTarget). */
  setWhole(buf: ArrayBuffer): void {
    this.parts = [new Uint8Array(buf)];
  }
  async finish(type: string): Promise<string> {
    if (this.aborted) throw new Error('cancelado');
    download(new Blob(this.parts as BlobPart[], { type }), this.name);
    this.parts = [];
    return 'descargas del navegador';
  }
  async abort(): Promise<void> {
    this.aborted = true;
    this.parts = [];
  }
}

export function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
