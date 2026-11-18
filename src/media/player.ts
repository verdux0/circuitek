/**
 * Animated sources for media layers: a <video> element or an animated GIF, behind one interface.
 * The renderer reads `source()` (the current frame, uploaded straight to a texture) only when
 * `stamp` changes; players call `onFrame` when there are new pixels and `onState` when the
 * transport state (play / time / volume…) changes. Nothing runs while paused.
 */
import { DEFAULT_FPS, clampSpeed, estimateFps, frameAt, timeOfFrame } from './timing';

export interface MediaPlayer {
  readonly kind: 'video' | 'gif';
  readonly w: number;
  readonly h: number;
  /** Seconds (0 while unknown). */
  readonly duration: number;
  readonly time: number;
  readonly frame: number;
  readonly fps: number;
  /** Bumped every time new pixels are presented (seeks included). */
  readonly stamp: number;
  readonly playing: boolean;
  /** null = not known yet (video audio is only detectable once decoding started). */
  readonly hasAudio: boolean | null;
  loop: boolean;
  speed: number;
  volume: number;
  muted: boolean;
  /** First frame, for thumbnails and the layer ghost. */
  readonly poster: ImageBitmap;
  onFrame: () => void;
  onState: () => void;
  source(): TexImageSource;
  play(): Promise<void>;
  pause(): void;
  seek(t: number): void;
  step(n: number): void;
  /** The current frame at full resolution, as a new bitmap (caller owns it). */
  snapshot(): Promise<ImageBitmap>;
  dispose(): void;
}

export class MediaError2 extends Error {}

/* ------------------------------------ video ------------------------------------ */

/** Hidden home for the <video> elements: some browsers (iOS) only decode videos in the DOM. */
function pool(): HTMLElement {
  let el = document.getElementById('media-pool');
  if (!el) {
    el = document.createElement('div');
    el.id = 'media-pool';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1';
    document.body.append(el);
  }
  return el;
}

const MEDIA_ERR: Record<number, string> = {
  1: 'carga cancelada',
  2: 'error de lectura',
  3: 'el navegador no puede decodificarlo (¿códec HEVC/H.265 o perfil no soportado?)',
  4: 'formato o códec no soportado por este navegador (¿HEVC/H.265, ProRes…?)',
};

function once<T>(fn: (ok: (v: T) => void, ko: (e: Error) => void) => () => void, ms: number, timeoutMsg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let cleanup = () => {};
    const timer = setTimeout(() => {
      cleanup();
      reject(new MediaError2(timeoutMsg));
    }, ms);
    cleanup = fn(
      (v) => { clearTimeout(timer); cleanup(); resolve(v); },
      (e) => { clearTimeout(timer); cleanup(); reject(e); },
    );
  });
}

export class VideoPlayer implements MediaPlayer {
  readonly kind = 'video' as const;
  readonly el: HTMLVideoElement;
  private url: string;
  w = 0;
  h = 0;
  poster!: ImageBitmap;
  stamp = 0;
  frame = 0;
  fps = DEFAULT_FPS;
  private gaps: number[] = [];
  private lastMedia = -1;
  private lastPresented = -1;
  private rvfc = 0;
  private raf = 0;
  private dur = 0;
  private disposed = false;
  onFrame = () => {};
  onState = () => {};

  private constructor(url: string) {
    this.url = url;
    const v = document.createElement('video');
    // Autoplay rules: start muted; iOS also requires inline playback.
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.preload = 'auto';
    v.loop = true;
    v.disablePictureInPicture = true;
    this.el = v;
  }

  /** Opens a video Blob/File through an object URL (the file is streamed, never read whole). */
  static async open(blob: Blob, maxSize: number): Promise<VideoPlayer> {
    const url = URL.createObjectURL(blob);
    const p = new VideoPlayer(url);
    const v = p.el;
    pool().append(v);
    try {
      v.src = url;
      await once<void>((ok, ko) => {
        const onData = () => ok();
        const onErr = () => ko(new MediaError2(MEDIA_ERR[v.error?.code ?? 4] ?? 'no se pudo leer el vídeo'));
        v.addEventListener('loadeddata', onData);
        v.addEventListener('error', onErr);
        return () => { v.removeEventListener('loadeddata', onData); v.removeEventListener('error', onErr); };
      }, 20000, 'el navegador no termina de leerlo (¿archivo dañado o códec no soportado?)');
      // Some browsers "play" HEVC as audio only: no picture means it cannot be decoded here.
      if (!v.videoWidth || !v.videoHeight) throw new MediaError2(MEDIA_ERR[4]);
      if (v.videoWidth > maxSize || v.videoHeight > maxSize) {
        throw new MediaError2(`demasiado grande para la GPU (${v.videoWidth}×${v.videoHeight}, máximo ${maxSize} px por lado)`);
      }
      p.w = v.videoWidth;
      p.h = v.videoHeight;
      await p.resolveDuration();
      p.poster = await createImageBitmap(v);
      p.bind();
      return p;
    } catch (err) {
      p.dispose();
      throw err instanceof MediaError2 ? err : new MediaError2((err as Error)?.message || 'no se pudo leer el vídeo');
    }
  }

  /** MediaRecorder WebM files report Infinity until the end has been seen once. */
  private async resolveDuration(): Promise<void> {
    const v = this.el;
    if (Number.isFinite(v.duration) && v.duration > 0) {
      this.dur = v.duration;
      return;
    }
    try {
      await once<void>((ok) => {
        const on = () => { if (Number.isFinite(v.duration)) ok(); };
        v.addEventListener('durationchange', on);
        v.currentTime = 1e7;
        return () => v.removeEventListener('durationchange', on);
      }, 5000, 'duración desconocida');
      this.dur = v.duration;
    } catch {
      this.dur = 0;
    }
    v.currentTime = 0;
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
  }

  private bind(): void {
    const v = this.el;
    const present = () => {
      if (this.disposed) return;
      this.stamp++;
      this.onFrame();
    };
    if ('requestVideoFrameCallback' in v) {
      const tick = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (this.disposed) return;
        // Consecutive presented frames while playing → frame-rate sample.
        if (!v.paused && this.lastPresented >= 0 && meta.presentedFrames === this.lastPresented + 1 && meta.mediaTime > this.lastMedia) {
          this.gaps.push(meta.mediaTime - this.lastMedia);
          if (this.gaps.length > 60) this.gaps.shift();
          if (this.gaps.length >= 5) this.fps = estimateFps(this.gaps);
        }
        this.lastPresented = meta.presentedFrames;
        this.lastMedia = meta.mediaTime;
        this.frame = frameAt(meta.mediaTime, this.fps);
        present();
        this.rvfc = v.requestVideoFrameCallback(tick);
      };
      this.rvfc = v.requestVideoFrameCallback(tick);
    }
    // Paused seeks may not composite a frame (hidden element): repaint on 'seeked' as well.
    v.addEventListener('seeked', () => {
      this.frame = frameAt(v.currentTime, this.fps);
      present();
      this.onState();
    });
    v.addEventListener('play', () => { this.startRafFallback(); this.onState(); });
    v.addEventListener('pause', () => { this.stopRaf(); this.frame = frameAt(v.currentTime, this.fps); present(); this.onState(); });
    v.addEventListener('ended', () => this.onState());
    v.addEventListener('volumechange', () => this.onState());
    v.addEventListener('ratechange', () => this.onState());
    v.addEventListener('timeupdate', () => this.onState());
  }

  /** Without requestVideoFrameCallback: one repaint per animation frame, only while playing. */
  private startRafFallback(): void {
    if ('requestVideoFrameCallback' in this.el || this.raf) return;
    let last = -1;
    const loop = () => {
      this.raf = 0;
      if (this.disposed || this.el.paused) return;
      const t = this.el.currentTime;
      if (t !== last) {
        last = t;
        this.frame = frameAt(t, this.fps);
        this.stamp++;
        this.onFrame();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stopRaf(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  get duration(): number {
    return this.dur || (Number.isFinite(this.el.duration) ? this.el.duration : 0);
  }
  get time(): number {
    return this.el.currentTime;
  }
  get playing(): boolean {
    return !this.el.paused && !this.el.ended;
  }
  get hasAudio(): boolean | null {
    const v = this.el as HTMLVideoElement & { mozHasAudio?: boolean; webkitAudioDecodedByteCount?: number; audioTracks?: { length: number } };
    if (typeof v.mozHasAudio === 'boolean') return v.mozHasAudio;
    if (v.audioTracks) return v.audioTracks.length > 0;
    if (typeof v.webkitAudioDecodedByteCount === 'number') return v.webkitAudioDecodedByteCount > 0 ? true : v.currentTime > 0.5 ? false : null;
    return null;
  }
  get loop(): boolean {
    return this.el.loop;
  }
  set loop(on: boolean) {
    this.el.loop = on;
    this.onState();
  }
  get speed(): number {
    return this.el.playbackRate;
  }
  set speed(v: number) {
    this.el.playbackRate = clampSpeed(v);
  }
  get volume(): number {
    return this.el.volume;
  }
  set volume(v: number) {
    this.el.volume = Math.min(1, Math.max(0, v));
    if (v > 0 && this.el.muted) this.el.muted = false;
  }
  get muted(): boolean {
    return this.el.muted;
  }
  set muted(m: boolean) {
    this.el.muted = m;
  }

  source(): TexImageSource {
    return this.el;
  }

  async play(): Promise<void> {
    if (this.el.ended || (this.duration && this.el.currentTime >= this.duration - 1e-3)) this.el.currentTime = 0;
    try {
      await this.el.play();
    } catch {
      // Autoplay with sound refused: retry muted (the user can unmute).
      this.el.muted = true;
      await this.el.play().catch(() => {});
    }
  }
  pause(): void {
    this.el.pause();
  }
  seek(t: number): void {
    const d = this.duration;
    this.el.currentTime = Math.max(0, d ? Math.min(d, t) : t);
  }
  step(n: number): void {
    this.pause();
    const last = this.duration ? frameAt(this.duration, this.fps) - 1 : Infinity;
    const target = Math.max(0, Math.min(last, frameAt(this.el.currentTime, this.fps) + n));
    this.seek(timeOfFrame(target, this.fps));
  }
  snapshot(): Promise<ImageBitmap> {
    return createImageBitmap(this.el);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRaf();
    const v = this.el;
    if (this.rvfc && 'cancelVideoFrameCallback' in v) v.cancelVideoFrameCallback(this.rvfc);
    v.pause();
    // Release the decoder and the file: empty src + load() is what actually frees them.
    v.removeAttribute('src');
    v.load();
    v.remove();
    URL.revokeObjectURL(this.url);
    this.poster?.close();
  }
}

/* ------------------------------------- GIF ------------------------------------- */

/** Decoded frames kept in memory at most (bytes, RGBA). Above it: decoded on demand (ImageDecoder) or downscaled (fallback). */
export const GIF_FRAME_BUDGET = 192 * 1024 * 1024;
/** Browsers treat delays ≤ 10 ms as 100 ms; so do we. */
export const gifDelay = (ms: number): number => (ms > 10 ? ms : 100);

interface FrameSrc {
  count: number;
  /** ms */
  delays: number[];
  get(i: number): Promise<ImageBitmap>;
  /** True when get() returns cached bitmaps the caller must not close. */
  cached: boolean;
  close(): void;
}

/** Native WebCodecs path: frames composited by the browser, decoded on demand. */
async function imageDecoderFrames(blob: Blob, maxSize: number): Promise<FrameSrc & { w: number; h: number }> {
  const dec = new ImageDecoder({ data: blob.stream(), type: 'image/gif' });
  try {
    await dec.completed;
    const track = dec.tracks.selectedTrack;
    const count = track?.frameCount ?? 0;
    if (!count) throw new MediaError2('el GIF no tiene fotogramas');
    const delays: number[] = [];
    let w = 0;
    let h = 0;
    const cache: ImageBitmap[] = [];
    let bytes = 0;
    // One pass: durations (needed for the seek bar) and, while within budget, the frames themselves.
    for (let i = 0; i < count; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      w = image.displayWidth;
      h = image.displayHeight;
      if (w > maxSize || h > maxSize) {
        image.close();
        throw new MediaError2(`demasiado grande para la GPU (${w}×${h})`);
      }
      delays.push(gifDelay((image.duration ?? 0) / 1000));
      bytes += w * h * 4;
      if (bytes <= GIF_FRAME_BUDGET) cache.push(await createImageBitmap(image));
      image.close();
    }
    const all = cache.length === count;
    if (!all) cache.forEach((b) => b.close());
    return {
      w, h, count, delays, cached: all,
      async get(i) {
        if (all) return cache[i];
        const { image } = await dec.decode({ frameIndex: i });
        const b = await createImageBitmap(image);
        image.close();
        return b;
      },
      close() {
        cache.forEach((b) => b.close());
        dec.close();
      },
    };
  } catch (err) {
    dec.close();
    throw err;
  }
}

/** Fallback (no ImageDecoder: Safari on iOS): omggif, frames composited here with GIF disposal rules. */
async function omggifFrames(blob: Blob, maxSize: number): Promise<FrameSrc & { w: number; h: number }> {
  const { GifReader } = await import('omggif');
  const r = new GifReader(new Uint8Array(await blob.arrayBuffer()));
  const W = r.width;
  const H = r.height;
  const count = r.numFrames();
  if (!count) throw new MediaError2('el GIF no tiene fotogramas');
  if (W > maxSize || H > maxSize) throw new MediaError2(`demasiado grande para la GPU (${W}×${H})`);
  // Over budget: store frames downscaled so the whole animation still fits.
  const k = Math.min(1, Math.sqrt(GIF_FRAME_BUDGET / (W * H * 4 * count)));
  const sw = Math.max(1, Math.round(W * k));
  const sh = Math.max(1, Math.round(H * k));
  const canvas = new Uint8ClampedArray(W * H * 4);
  let saved: Uint8ClampedArray | null = null;
  const frames: ImageBitmap[] = [];
  const delays: number[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const info = r.frameInfo(i);
      if (info.disposal === 3) saved = canvas.slice();
      r.decodeAndBlitFrameRGBA(i, canvas as unknown as number[]);
      const img = new ImageData(canvas.slice(), W, H);
      frames.push(k < 1 ? await createImageBitmap(img, { resizeWidth: sw, resizeHeight: sh, resizeQuality: 'high' }) : await createImageBitmap(img));
      delays.push(gifDelay(info.delay * 10));
      // Disposal for the NEXT frame: 2 = clear the rect, 3 = restore what was there before.
      if (info.disposal === 2) {
        for (let y = info.y; y < Math.min(H, info.y + info.height); y++) canvas.fill(0, (y * W + info.x) * 4, (y * W + Math.min(W, info.x + info.width)) * 4);
      } else if (info.disposal === 3 && saved) canvas.set(saved);
    }
  } catch (err) {
    frames.forEach((b) => b.close());
    throw err instanceof MediaError2 ? err : new MediaError2('GIF dañado o incompleto');
  }
  return { w: W, h: H, count, delays, cached: true, get: async (i) => frames[i], close: () => frames.forEach((b) => b.close()) };
}

/** Forces the fallback decoder (tests: `?gif=omggif`). */
const forceFallback = (): boolean => typeof location !== 'undefined' && new URLSearchParams(location.search).get('gif') === 'omggif';

export class GifPlayer implements MediaPlayer {
  readonly kind = 'gif' as const;
  readonly hasAudio = false;
  w = 0;
  h = 0;
  poster!: ImageBitmap;
  stamp = 0;
  frame = 0;
  loop = true;
  volume = 0;
  muted = true;
  /** Which decoder is in use (shown in tests / debugging). */
  decoder: 'ImageDecoder' | 'omggif' = 'ImageDecoder';
  private src!: FrameSrc;
  private starts: number[] = [];
  private total = 0;
  private cur: ImageBitmap | null = null;
  private timer = 0;
  private isPlaying = false;
  private rate = 1;
  private disposed = false;
  private req = 0;
  onFrame = () => {};
  onState = () => {};

  static async open(blob: Blob, maxSize: number): Promise<GifPlayer> {
    const p = new GifPlayer();
    const native = typeof ImageDecoder !== 'undefined' && !forceFallback() && (await ImageDecoder.isTypeSupported('image/gif').catch(() => false));
    try {
      const src = native ? await imageDecoderFrames(blob, maxSize) : await omggifFrames(blob, maxSize);
      p.decoder = native ? 'ImageDecoder' : 'omggif';
      p.src = src;
      p.w = src.w;
      p.h = src.h;
      let t = 0;
      p.starts = src.delays.map((d) => { const s = t; t += d; return s; });
      p.total = t;
      const first = await src.get(0);
      p.poster = await createImageBitmap(first);
      if (!src.cached) first.close();
      await p.show(0);
      return p;
    } catch (err) {
      p.dispose();
      throw err instanceof MediaError2 ? err : new MediaError2(native ? 'GIF dañado o no soportado' : 'GIF dañado o incompleto');
    }
  }

  get count(): number {
    return this.src.count;
  }
  get fps(): number {
    return this.total ? (this.src.count * 1000) / this.total : DEFAULT_FPS;
  }
  get duration(): number {
    return this.total / 1000;
  }
  get time(): number {
    return (this.starts[this.frame] ?? 0) / 1000;
  }
  get playing(): boolean {
    return this.isPlaying;
  }
  get speed(): number {
    return this.rate;
  }
  set speed(v: number) {
    this.rate = clampSpeed(v);
    if (this.isPlaying) this.schedule();
    this.onState();
  }

  source(): TexImageSource {
    return this.cur ?? this.poster;
  }

  /** Decodes frame i and presents it (latest request wins). */
  private async show(i: number): Promise<void> {
    const n = this.src.count;
    i = ((i % n) + n) % n;
    const req = ++this.req;
    const bmp = await this.src.get(i);
    if (this.disposed || req !== this.req) {
      if (!this.src.cached) bmp.close();
      return;
    }
    if (this.cur && !this.src.cached && this.cur !== bmp) this.cur.close();
    this.cur = bmp;
    this.frame = i;
    this.stamp++;
    this.onFrame();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.isPlaying || this.disposed) return;
    this.timer = window.setTimeout(() => {
      const next = this.frame + 1;
      if (next >= this.src.count && !this.loop) {
        this.isPlaying = false;
        this.onState();
        return;
      }
      void this.show(next).then(() => {
        this.onState();
        this.schedule();
      });
    }, this.src.delays[this.frame] / this.rate);
  }

  async play(): Promise<void> {
    if (this.isPlaying) return;
    if (!this.loop && this.frame >= this.src.count - 1) await this.show(0);
    this.isPlaying = true;
    this.schedule();
    this.onState();
  }
  pause(): void {
    this.isPlaying = false;
    clearTimeout(this.timer);
    this.onState();
  }
  seek(t: number): void {
    const ms = Math.max(0, Math.min(this.total - 1e-6, t * 1000));
    let i = 0;
    while (i + 1 < this.starts.length && this.starts[i + 1] <= ms) i++;
    void this.show(i).then(() => {
      this.onState();
      if (this.isPlaying) this.schedule();
    });
  }
  step(n: number): void {
    this.pause();
    void this.show(Math.max(0, Math.min(this.src.count - 1, this.frame + n))).then(() => this.onState());
  }
  snapshot(): Promise<ImageBitmap> {
    return createImageBitmap(this.cur ?? this.poster);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    if (this.cur && this.src && !this.src.cached) this.cur.close();
    this.src?.close();
    this.poster?.close();
  }
}

/* ----------------------------------- sniffing ----------------------------------- */

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv|avi|3gp)$/i;

/** What a dropped / picked / pasted file is. GIFs count as animated only with more than one frame. */
export async function mediaKind(f: Blob & { name?: string }): Promise<'video' | 'gif' | 'image' | null> {
  const name = f.name ?? '';
  if (f.type.startsWith('video/') || (!f.type && VIDEO_EXT.test(name))) return 'video';
  if (f.type === 'image/gif' || /\.gif$/i.test(name)) return (await gifIsAnimated(f)) ? 'gif' : 'image';
  if (f.type.startsWith('image/')) return 'image';
  return null;
}

/** Counts image descriptors (0x2C after a block boundary) cheaply: stops at the second frame. */
export function gifFrameCountAtLeast2(bytes: Uint8Array): boolean {
  if (bytes.length < 13 || String.fromCharCode(...bytes.subarray(0, 3)) !== 'GIF') return false;
  let p = 13;
  const flags = bytes[10];
  if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
  let frames = 0;
  while (p < bytes.length) {
    const b = bytes[p];
    if (b === 0x3b) break;
    if (b === 0x21) {
      p += 2;
      while (p < bytes.length && bytes[p] !== 0) p += bytes[p] + 1;
      p++;
    } else if (b === 0x2c) {
      if (++frames >= 2) return true;
      const lf = bytes[p + 9];
      p += 10;
      if (lf & 0x80) p += 3 * (1 << ((lf & 7) + 1));
      p++; // LZW min code size
      while (p < bytes.length && bytes[p] !== 0) p += bytes[p] + 1;
      p++;
    } else return false;
  }
  return false;
}

async function gifIsAnimated(f: Blob): Promise<boolean> {
  // A frame header is small; most animated GIFs show their 2nd frame within the first MBs.
  const head = new Uint8Array(await f.slice(0, Math.min(f.size, 8 * 1024 * 1024)).arrayBuffer());
  return gifFrameCountAtLeast2(head);
}
