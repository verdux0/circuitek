/**
 * Frame-by-frame, offline exports through the app's own pipeline (never a screen recording).
 *
 * Output frame i has timeline time t = start + i / fps and noise index i. Video layers are read
 * with Mediabunny (exact frame for a time, decoded off the <video> element); GIF layers by time
 * from their player; still layers are the usual bitmaps. Every frame runs every stage (the
 * JPEG / pixel-sort encoder included), so the same state and instant give the same pixels.
 */
import type { Engine } from '../engine';
import type { GLRenderer, SourceProvider, SourceRef } from '../gl/renderer';
import { cloneDoc, layerAnimates, type DocState, type Layer } from '../doc';
import { GifPlayer, type MediaPlayer } from '../media/player';
import {
  gifSize, gifTiming, loopFrameCount, loopSample, mp4Bitrate, mp4Size, pulseEffect,
  type ExportSettings, type LoopMode,
} from './settings';
import type { SaveSink } from './save';
import GifWorker from './gif.worker?worker&inline';
import type { GifRequest, GifResponse } from './gif.worker';

export interface ExportHost {
  engine: Engine;
  /** The live provider (images, text); media layers are handled here. */
  provider: SourceProvider;
  players: Map<string, MediaPlayer>;
  /** Original bytes of a layer's source (videos are re-read from them). */
  blobFor(key: string): Blob | undefined;
}

export interface Progress {
  (fraction: number, msg: string): void;
}

export class Cancelled extends Error {
  constructor() {
    super('Exportación cancelada');
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const check = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Cancelled();
};

/* ------------------------------------ what the document can export ------------------------------------ */

export interface DocInfo {
  /** Has video / GIF layers. */
  media: boolean;
  /** Some still layer has "Glitch animado" on (a generated animation). */
  generated: boolean;
  /** Longest media duration (s), 0 without media. */
  duration: number;
}

export function docInfo(doc: DocState, players: Map<string, MediaPlayer>): DocInfo {
  const vis = doc.layers.filter((l) => l.visible && l.opacity > 0);
  const media = vis.filter((l) => l.media && players.has(l.src));
  return {
    media: media.length > 0,
    generated: vis.some((l) => !l.media && l.animate && !!l.fx),
    duration: Math.max(0, ...media.map((l) => players.get(l.src)!.duration || 0)),
  };
}

/* ------------------------------------ frame source ------------------------------------ */

interface VideoReader {
  sink: import('mediabunny').CanvasSink;
  input: import('mediabunny').Input;
  first: number;
  duration: number;
}

export class FrameSource {
  private renderer: GLRenderer;
  private videos = new Map<string, VideoReader>();
  /** Current pixels of each media layer for the frame being rendered. */
  private current = new Map<string, TexImageSource>();
  private stamp = 0;
  private noise = 0;
  /** Loop length of the export (frames): animated layers' noise / motion are periodic with it. */
  loop = 0;
  private fallback = new Set<string>();

  constructor(private host: ExportHost, private doc: DocState, readonly w: number, readonly h: number) {
    const live = host.provider;
    const provider: SourceProvider = {
      source: (l, px): SourceRef | null => {
        const img = l.media ? this.current.get(l.src) : undefined;
        const p = l.media ? host.players.get(l.src) : undefined;
        if (img && p) {
          return { key: `${l.src}#x`, w: p.w, h: p.h, frame: this.noise, stamp: this.stamp, noise: this.noise, loop: this.loop, liveOnly: false, load: () => img };
        }
        const r = live.source(l, px);
        return r ? { ...r, noise: this.noise, loop: this.loop, liveOnly: false } : null;
      },
    };
    this.renderer = host.engine.exportRenderer(provider);
  }

  /** Opens a Mediabunny reader per video layer (exact frames); falls back to seeking the <video>. */
  async init(): Promise<void> {
    const vids = this.doc.layers.filter((l) => l.media?.kind === 'video' && this.host.players.has(l.src));
    if (!vids.length) return;
    const mb = await import('mediabunny');
    for (const l of vids) {
      if (this.videos.has(l.src) || this.fallback.has(l.src)) continue;
      const blob = this.host.blobFor(l.src);
      const p = this.host.players.get(l.src)!;
      try {
        if (!blob) throw new Error('sin archivo');
        const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        if (!track || !(await track.canDecode())) throw new Error('no decodificable');
        const sink = new mb.CanvasSink(track, { width: p.w, height: p.h, fit: 'fill', poolSize: 2 });
        const first = await track.getFirstTimestamp();
        const duration = await track.computeDuration();
        this.videos.set(l.src, { sink, input, first, duration });
      } catch {
        this.fallback.add(l.src);
      }
    }
  }

  /** Pixels of media layer `l` at timeline time t (each layer loops over its own length). */
  private async load(l: Layer, t: number): Promise<() => void> {
    const p = this.host.players.get(l.src)!;
    if (p instanceof GifPlayer) {
      const { img, release } = await p.imageAt(t);
      this.current.set(l.src, img);
      return release;
    }
    const v = this.videos.get(l.src);
    const dur = v?.duration || p.duration || 1;
    const tm = ((t % dur) + dur) % dur;
    if (v) {
      const c = (await v.sink.getCanvas(Math.max(v.first, v.first + tm))) ?? (await v.sink.getCanvas(v.first));
      if (c) this.current.set(l.src, c.canvas as TexImageSource);
      return () => {};
    }
    // Fallback: seek the player's own <video> and wait for the frame.
    p.pause();
    p.seek(tm);
    await new Promise<void>((r) => {
      const el = p.source() as HTMLVideoElement;
      const done = () => setTimeout(r, 30);
      el.addEventListener('seeked', done, { once: true });
      setTimeout(r, 1500);
    });
    this.current.set(l.src, p.source());
    return () => {};
  }

  /**
   * Renders the document at timeline time t with noise index `noise`. `effect` maps a layer's
   * EFFECT for generated animations (pulse); identity otherwise.
   */
  async renderAt(t: number, noise: number, effect?: (l: Layer, base: number) => number): Promise<ImageData> {
    this.noise = noise;
    this.stamp++;
    const releases: (() => void)[] = [];
    for (const l of this.doc.layers) if (l.media && l.visible && this.host.players.has(l.src)) releases.push(await this.load(l, t));
    let doc = this.doc;
    if (effect) {
      doc = cloneDoc(this.doc);
      for (const l of doc.layers) if (l.fx && layerAnimates(l)) l.fx.effect = effect(l, l.fx.effect);
    }
    try {
      return await this.host.engine.renderWith(this.renderer, doc, this.w, this.h);
    } finally {
      releases.forEach((f) => f());
    }
  }

  /** First video layer's file, for its audio track. */
  videoBlob(): { blob: Blob; key: string } | null {
    for (const l of this.doc.layers) {
      if (l.media?.kind !== 'video' || !l.visible) continue;
      const blob = this.host.blobFor(l.src);
      if (blob) return { blob, key: l.src };
    }
    return null;
  }

  dispose(): void {
    for (const v of this.videos.values()) v.input.dispose();
    this.videos.clear();
    this.current.clear();
    this.renderer.dispose();
  }
}

/** Mixes two frames: a·A + (1−a)·B (crossfade loops). */
export function mixFrames(a: ImageData, b: ImageData, alpha: number): ImageData {
  const out = new Uint8ClampedArray(a.data.length);
  const k = Math.min(1, Math.max(0, alpha));
  for (let i = 0; i < out.length; i++) out[i] = a.data[i] * k + b.data[i] * (1 - k);
  return new ImageData(out, a.width, a.height);
}

/** Mean absolute difference between frames (0..255) on a sparse grid. */
export function frameDiff(a: ImageData, b: ImageData): number {
  let s = 0;
  let n = 0;
  const step = Math.max(4, Math.floor(a.data.length / 4 / 20000)) * 4;
  for (let i = 0; i < a.data.length; i += step) {
    s += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    n += 3;
  }
  return n ? s / n : 0;
}

/* ------------------------------------ PNG / JPG ------------------------------------ */

export async function exportStill(host: ExportHost, doc: DocState, s: ExportSettings, sink: SaveSink, progress: Progress, signal: AbortSignal): Promise<{ w: number; h: number; where: string }> {
  const jpg = s.format === 'jpg';
  // Stills of a video document: the frame on screen (the live provider reads the players).
  const { blob, w, h } = await host.engine.exportFull(doc, null, jpg ? 'image/jpeg' : 'image/png', (m) => progress(0.5, `Renderizando · ${m}`), {
    scale: jpg ? s.jpg.scale : s.png.scale,
    quality: s.jpg.quality / 100,
  });
  check(signal);
  await sink.write(new Uint8Array(await blob.arrayBuffer()));
  check(signal);
  return { w, h, where: await sink.finish(jpg ? 'image/jpeg' : 'image/png') };
}

/* ------------------------------------ GIF ------------------------------------ */

export interface GifPlan {
  w: number;
  h: number;
  frames: number;
  fps: number;
  delays: number[];
  uneven: boolean;
  clamped: boolean;
  /** Seconds of timeline used (video) or animation length (generated). */
  duration: number;
  mode: LoopMode | 'generated';
}

/** What a GIF export will produce (shown in the dialog before rendering). */
export function planGif(doc: DocState, info: DocInfo, s: ExportSettings): GifPlan {
  const [w, h] = gifSize(doc.w, doc.h, s.gif.maxWidth);
  const fps = s.gif.fps;
  if (!info.media) {
    const frames = Math.max(2, Math.round(s.gif.duration * fps));
    const t = gifTiming(fps, frames);
    return { w, h, frames, fps: t.fps, delays: t.delays, uneven: t.uneven, clamped: t.clamped, duration: s.gif.duration, mode: 'generated' };
  }
  const dur = Math.min(s.gif.duration, info.duration || s.gif.duration);
  const overlap = s.gif.loop === 'crossfade' ? dur * s.gif.overlap : 0;
  const frames = loopFrameCount(s.gif.loop, fps, dur, overlap);
  const t = gifTiming(fps, frames);
  return { w, h, frames, fps: t.fps, delays: t.delays, uneven: t.uneven, clamped: t.clamped, duration: dur, mode: s.gif.loop };
}

/** Picks the cut (s) in [½·dur, dur] whose frame best matches frame 0 ("recortar al bucle"). */
async function bestLoopCut(src: FrameSource, dur: number, fps: number, signal: AbortSignal, progress: Progress): Promise<number> {
  const first = await src.renderAt(0, 0);
  let best = dur;
  let bestD = Infinity;
  const from = Math.max(2, Math.round((dur * fps) / 2));
  const to = Math.round(dur * fps);
  for (let k = from; k <= to; k++) {
    check(signal);
    // Same noise index as frame 0: compare footage, not noise.
    const d = frameDiff(first, await src.renderAt(k / fps, 0));
    if (d < bestD) {
      bestD = d;
      best = k / fps;
    }
    progress(0.1 * ((k - from + 1) / (to - from + 1)), 'Buscando el mejor punto de bucle');
    await tick();
  }
  return best;
}

export async function exportGif(host: ExportHost, doc: DocState, s: ExportSettings, sink: SaveSink, progress: Progress, signal: AbortSignal): Promise<{ w: number; h: number; frames: number; where: string; fps: number }> {
  const info = docInfo(doc, host.players);
  if (!info.media && !info.generated) throw new Error('No hay nada animado: activa «Glitch animado» o importa un vídeo / GIF');
  let plan = planGif(doc, info, s);
  const src = new FrameSource(host, doc, plan.w, plan.h);
  const worker = new GifWorker() as Worker;
  const fail = (m: string) => new Error(`GIF: ${m}`);
  let workerError: Error | null = null;
  // Worker replies, in order: palette, then one chunk per frame, then done.
  const queue: GifResponse[] = [];
  let wake: (() => void) | null = null;
  worker.onmessage = (e: MessageEvent<GifResponse>) => {
    if (e.data.type === 'error') workerError = fail(e.data.message);
    queue.push(e.data);
    wake?.();
  };
  worker.onerror = (e) => {
    workerError = fail(e.message || 'el worker falló');
    wake?.();
  };
  const next = async <T extends GifResponse['type']>(type: T): Promise<Extract<GifResponse, { type: T }>> => {
    for (;;) {
      if (workerError) throw workerError;
      check(signal);
      const i = queue.findIndex((m) => m.type === type);
      if (i >= 0) return queue.splice(i, 1)[0] as Extract<GifResponse, { type: T }>;
      await new Promise<void>((r) => {
        wake = r;
        signal.addEventListener('abort', () => r(), { once: true });
      });
      wake = null;
    }
  };
  const post = (m: GifRequest, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
  try {
    progress(0, 'Preparando');
    await src.init();
    check(signal);
    let dur = plan.duration;
    if (plan.mode === 'trim') {
      dur = await bestLoopCut(src, plan.duration, s.gif.fps, signal, progress);
      plan = planGif(doc, info, { ...s, gif: { ...s.gif, duration: dur } });
    }
    const n = plan.frames;
    src.loop = n;
    const overlap = plan.mode === 'crossfade' ? dur * s.gif.overlap : 0;
    const pulse = plan.mode === 'generated' && s.gif.pulse ? (_l: Layer, base: number, i = 0) => pulseEffect(base, s.gif.pulse, s.gif.pulseCycles, i, n) : null;
    const frameAt = async (i: number): Promise<ImageData> => {
      const fx = pulse ? (l: Layer, b: number) => pulse(l, b, i) : undefined;
      if (plan.mode === 'generated') return src.renderAt(0, i % n, fx);
      const smp = loopSample(plan.mode as LoopMode, i, n, s.gif.fps, dur, overlap);
      const a = await src.renderAt(smp.t, i, fx);
      if (smp.t2 === undefined || smp.alpha >= 1) return a;
      // Both samples of a crossfade share the output frame's noise index.
      return mixFrames(a, await src.renderAt(smp.t2, i, fx), smp.alpha);
    };

    // Global palette from frames spread over the whole loop (kept for reuse below).
    const sampleIdx = [...new Set(Array.from({ length: Math.min(8, n) }, (_, k) => Math.floor((k * n) / Math.min(8, n))))];
    const cache = new Map<number, ImageData>();
    const px: number[] = [];
    const per = Math.max(1, Math.floor((plan.w * plan.h * sampleIdx.length) / 250000));
    for (const [k, i] of sampleIdx.entries()) {
      check(signal);
      const img = await frameAt(i);
      cache.set(i, img);
      for (let p = 0; p < img.data.length; p += 4 * per) px.push(img.data[p], img.data[p + 1], img.data[p + 2], 255);
      progress(0.1 + 0.1 * ((k + 1) / sampleIdx.length), 'Calculando la paleta');
      await tick();
    }
    const samples = new Uint8Array(px).buffer;
    post({ type: 'palette', samples, colors: s.gif.colors }, [samples]);
    const { palette } = await next('palette');
    post({ type: 'start', w: plan.w, h: plan.h, palette, repeat: s.gif.repeat, dither: s.gif.dither });

    for (let i = 0; i < n; i++) {
      check(signal);
      const img = cache.get(i) ?? (await frameAt(i));
      cache.delete(i);
      const buf = img.data.buffer as ArrayBuffer;
      post({ type: 'frame', buf, delayCs: plan.delays[i] }, [buf]);
      // One frame in flight: render the next one while the worker encodes this one.
      const chunk = await next('chunk');
      await sink.write(new Uint8Array(chunk.bytes));
      progress(0.2 + 0.8 * ((i + 1) / n), `Fotograma ${i + 1} / ${n}`);
      await tick();
    }
    post({ type: 'finish' });
    await sink.write(new Uint8Array((await next('chunk')).bytes));
    await next('done');
    check(signal);
    return { w: plan.w, h: plan.h, frames: n, fps: plan.fps, where: await sink.finish('image/gif') };
  } finally {
    worker.terminate();
    src.dispose();
  }
}

/* ------------------------------------ MP4 (or WebM) ------------------------------------ */

export interface VideoCaps {
  /** 'mp4' (H.264), 'webm' (VP9 fallback) or null (no encoder). */
  container: 'mp4' | 'webm' | null;
  reason: string;
}

/** What this browser can encode (checked once, async). */
export async function videoCaps(): Promise<VideoCaps> {
  if (typeof VideoEncoder === 'undefined') return { container: null, reason: 'Este navegador no puede codificar vídeo (no tiene WebCodecs VideoEncoder).' };
  const mb = await import('mediabunny');
  if (await mb.canEncodeVideo('avc', { width: 1280, height: 720 })) return { container: 'mp4', reason: '' };
  if (await mb.canEncodeVideo('vp9', { width: 1280, height: 720 })) return { container: 'webm', reason: 'Sin H.264 en este navegador: se exporta WebM (VP9).' };
  return { container: null, reason: 'Este navegador no tiene codificador H.264 ni VP9.' };
}

/** Whether the first video layer's audio can go into the output, and why not. */
export async function audioStatus(doc: DocState, host: ExportHost, container: 'mp4' | 'webm'): Promise<{ ok: boolean; reason: string; codec?: 'aac' | 'opus' }> {
  const v = doc.layers.find((l) => l.media?.kind === 'video' && l.visible);
  if (!v) return { ok: false, reason: 'Sin vídeo de origen: el archivo no lleva audio.' };
  const blob = host.blobFor(v.src);
  if (!blob) return { ok: false, reason: 'No está el archivo original del vídeo: sin audio.' };
  try {
    const mb = await import('mediabunny');
    const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) return { ok: false, reason: 'El vídeo original no tiene pista de audio.' };
      if (!(await track.canDecode())) return { ok: false, reason: 'El audio del vídeo original no se puede decodificar en este navegador.' };
      const codecs: ('aac' | 'opus')[] = container === 'mp4' ? ['aac', 'opus'] : ['opus'];
      for (const c of codecs) if (await mb.canEncodeAudio(c)) return { ok: true, reason: '', codec: c };
      return { ok: false, reason: 'Este navegador no puede codificar audio AAC/Opus.' };
    } finally {
      input.dispose();
    }
  } catch {
    return { ok: false, reason: 'No se pudo leer el audio del vídeo original.' };
  }
}

export interface VideoPlan {
  w: number;
  h: number;
  fps: number;
  start: number;
  end: number;
  frames: number;
}

export function planVideo(doc: DocState, info: DocInfo, s: ExportSettings): VideoPlan {
  const [w, h] = mp4Size(doc.w, doc.h, s.mp4.height);
  const fps = s.mp4.fps;
  let start = 0;
  let end = s.mp4.duration;
  if (info.media) {
    const D = info.duration || s.mp4.duration;
    start = Math.min(s.mp4.start, Math.max(0, D - 1 / fps));
    end = s.mp4.end > start ? Math.min(s.mp4.end, D) : D;
  }
  return { w, h, fps, start, end, frames: Math.max(1, Math.round((end - start) * fps)) };
}

export async function exportVideo(
  host: ExportHost, doc: DocState, s: ExportSettings, sink: SaveSink & { setWhole?(b: ArrayBuffer): void }, caps: VideoCaps, progress: Progress, signal: AbortSignal,
): Promise<{ w: number; h: number; frames: number; where: string; audio: string; container: string }> {
  if (!caps.container) throw new Error(caps.reason);
  const info = docInfo(doc, host.players);
  if (!info.media && !info.generated) throw new Error('No hay nada animado: activa «Glitch animado» o importa un vídeo / GIF');
  const mb = await import('mediabunny');
  const plan = planVideo(doc, info, s);
  const webm = caps.container === 'webm';
  const src = new FrameSource(host, doc, plan.w, plan.h);
  const target = sink.writable ? new mb.StreamTarget(sink.writable as WritableStream<import('mediabunny').StreamTargetChunk>, { chunked: true }) : new mb.BufferTarget();
  const output = new mb.Output({
    format: webm ? new mb.WebMOutputFormat() : new mb.Mp4OutputFormat({ fastStart: sink.writable ? false : 'in-memory' }),
    target,
  });
  const video = new mb.VideoSampleSource({ codec: webm ? 'vp9' : 'avc', bitrate: mp4Bitrate(plan.w, plan.h, plan.fps, s.mp4.quality), keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: plan.fps });

  // Audio from the first video layer, trimmed to the range and re-timed to start at 0.
  let audioNote = 'sin audio';
  let audioIter: AsyncGenerator<import('mediabunny').AudioSample, void, unknown> | null = null;
  let audioSrc: import('mediabunny').AudioSampleSource | null = null;
  let audioInput: import('mediabunny').Input | null = null;
  let pendingAudio: import('mediabunny').AudioSample | null = null;
  if (s.mp4.audio && info.media) {
    const st = await audioStatus(doc, host, caps.container);
    const vb = src.videoBlob();
    if (st.ok && st.codec && vb) {
      audioInput = new mb.Input({ source: new mb.BlobSource(vb.blob), formats: mb.ALL_FORMATS });
      const track = await audioInput.getPrimaryAudioTrack();
      if (track) {
        audioSrc = new mb.AudioSampleSource({ codec: st.codec, bitrate: 128e3 });
        output.addAudioTrack(audioSrc);
        audioIter = new mb.AudioSampleSink(track).samples(plan.start, plan.end);
        audioNote = st.codec.toUpperCase();
      }
    } else audioNote = st.reason;
  }
  const pumpAudio = async (until: number): Promise<void> => {
    if (!audioIter || !audioSrc) return;
    for (;;) {
      const a = pendingAudio ?? (await audioIter.next()).value;
      pendingAudio = null;
      if (!a) {
        audioIter = null;
        return;
      }
      const t = a.timestamp - plan.start;
      if (t > until) {
        pendingAudio = a;
        return;
      }
      if (t >= 0) {
        a.setTimestamp(t);
        await audioSrc.add(a);
      }
      a.close();
    }
  };

  let started = false;
  try {
    progress(0, 'Preparando');
    await src.init();
    check(signal);
    await output.start();
    started = true;
    src.loop = plan.frames;
    const pulse = !info.media && s.mp4.pulse ? (i: number) => (_l: Layer, b: number) => pulseEffect(b, s.mp4.pulse, s.mp4.pulseCycles, i, plan.frames) : null;
    for (let i = 0; i < plan.frames; i++) {
      check(signal);
      const t = plan.start + i / plan.fps;
      const img = await src.renderAt(info.media ? t : 0, i, pulse ? pulse(i) : undefined);
      const sample = new mb.VideoSample(img.data, { format: 'RGBA', codedWidth: plan.w, codedHeight: plan.h, timestamp: i / plan.fps, duration: 1 / plan.fps });
      await video.add(sample);
      sample.close();
      await pumpAudio((i + 1) / plan.fps);
      progress((i + 1) / plan.frames, `Fotograma ${i + 1} / ${plan.frames}`);
      await tick();
    }
    await pumpAudio(Infinity);
    check(signal);
    await output.finalize();
    if (target instanceof mb.BufferTarget && sink.setWhole) sink.setWhole(target.buffer!);
    const where = await sink.finish(webm ? 'video/webm' : 'video/mp4');
    return { w: plan.w, h: plan.h, frames: plan.frames, where, audio: audioNote, container: caps.container };
  } catch (err) {
    if (started) await output.cancel().catch(() => {});
    throw err;
  } finally {
    (pendingAudio as import('mediabunny').AudioSample | null)?.close();
    // A cancelled export leaves samples inside the reader: closing the iterator releases them.
    await (audioIter as AsyncGenerator<unknown> | null)?.return(undefined).catch(() => {});
    audioInput?.dispose();
    src.dispose();
  }
}
