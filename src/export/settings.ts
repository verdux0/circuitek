/**
 * Export settings and the pure maths behind them: file-name templates, settings sanitizing,
 * GIF delays (centiseconds), perfect-loop time maps and size estimates. No DOM: unit-tested.
 */

export type ExportFormat = 'png' | 'jpg' | 'gif' | 'mp4';
export const FORMATS: ExportFormat[] = ['png', 'jpg', 'gif', 'mp4'];

export type Dither = 'none' | 'bayer' | 'floyd';
/** How a GIF made from video closes its loop. */
export type LoopMode = 'crossfade' | 'pingpong' | 'trim';
export type Mp4Quality = 'low' | 'medium' | 'high';
export type SaveMode = 'download' | 'folder';

export interface ExportSettings {
  format: ExportFormat;
  /** e.g. "{nombre}-{seed}-{fecha}" (extension added automatically). */
  template: string;
  save: SaveMode;
  png: { scale: number };
  jpg: { quality: number; scale: number };
  gif: {
    maxWidth: number;
    fps: number;
    colors: number;
    dither: Dither;
    /** Seconds; for video, capped to the timeline. */
    duration: number;
    loop: LoopMode;
    /** Crossfade overlap, fraction of the duration (0.05–0.5). */
    overlap: number;
    /** 0 = forever (NETSCAPE2.0 loop count 0). */
    repeat: number;
    /** Generated animations: EFFECT pulse amplitude (0–50 points) and whole cycles per loop. */
    pulse: number;
    pulseCycles: number;
  };
  mp4: {
    /** Output height in px (0 = original). */
    height: number;
    fps: number;
    quality: Mp4Quality;
    /** Seconds on the document timeline; end 0 = until the end. */
    start: number;
    end: number;
    /** Generated animations (no video): length in seconds. */
    duration: number;
    audio: boolean;
    pulse: number;
    pulseCycles: number;
  };
}

export const DEFAULT_TEMPLATE = '{nombre}-{seed}-{fecha}';

export function defaultSettings(): ExportSettings {
  return {
    format: 'png',
    template: DEFAULT_TEMPLATE,
    save: 'download',
    png: { scale: 1 },
    jpg: { quality: 92, scale: 1 },
    gif: { maxWidth: 480, fps: 20, colors: 128, dither: 'bayer', duration: 3, loop: 'crossfade', overlap: 0.25, repeat: 0, pulse: 0, pulseCycles: 1 },
    mp4: { height: 0, fps: 30, quality: 'medium', start: 0, end: 0, duration: 4, audio: true, pulse: 0, pulseCycles: 1 },
  };
}

/* ------------------------------------ sanitizing ------------------------------------ */

const clamp = (v: unknown, min: number, max: number, def: number, step = 0): number => {
  let n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  n = Math.min(max, Math.max(min, n));
  return step ? Math.round(n / step) * step : n;
};
const pick = <T extends string>(v: unknown, opts: readonly T[], def: T): T => (opts.includes(v as T) ? (v as T) : def);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Validates settings read from storage (unknown keys dropped, ranges clamped, bad values → defaults). */
export function sanitizeSettings(input: unknown): ExportSettings {
  const d = defaultSettings();
  const o = obj(input);
  const png = obj(o.png);
  const jpg = obj(o.jpg);
  const gif = obj(o.gif);
  const mp4 = obj(o.mp4);
  const tpl = typeof o.template === 'string' && o.template.trim() ? o.template.slice(0, 200) : d.template;
  const start = clamp(mp4.start, 0, 36000, 0);
  let end = clamp(mp4.end, 0, 36000, 0);
  if (end && end <= start) end = 0;
  return {
    format: pick(o.format, FORMATS, d.format),
    template: tpl,
    save: pick(o.save, ['download', 'folder'] as const, d.save),
    png: { scale: clamp(png.scale, 0.1, 4, d.png.scale) },
    jpg: { quality: clamp(jpg.quality, 1, 100, d.jpg.quality, 1), scale: clamp(jpg.scale, 0.1, 4, d.jpg.scale) },
    gif: {
      maxWidth: clamp(gif.maxWidth, 16, 2048, d.gif.maxWidth, 1),
      fps: clamp(gif.fps, 1, 50, d.gif.fps),
      colors: clamp(gif.colors, 2, 256, d.gif.colors, 1),
      dither: pick(gif.dither, ['none', 'bayer', 'floyd'] as const, d.gif.dither),
      duration: clamp(gif.duration, 0.2, 60, d.gif.duration),
      loop: pick(gif.loop, ['crossfade', 'pingpong', 'trim'] as const, d.gif.loop),
      overlap: clamp(gif.overlap, 0.05, 0.5, d.gif.overlap),
      repeat: clamp(gif.repeat, 0, 65535, d.gif.repeat, 1),
      pulse: clamp(gif.pulse, 0, 50, d.gif.pulse, 1),
      pulseCycles: clamp(gif.pulseCycles, 1, 8, d.gif.pulseCycles, 1),
    },
    mp4: {
      height: [0, 360, 480, 720, 1080, 1440, 2160].includes(mp4.height as number) ? (mp4.height as number) : d.mp4.height,
      fps: [12, 15, 24, 25, 30, 50, 60].includes(mp4.fps as number) ? (mp4.fps as number) : d.mp4.fps,
      quality: pick(mp4.quality, ['low', 'medium', 'high'] as const, d.mp4.quality),
      start,
      end,
      duration: clamp(mp4.duration, 0.5, 120, d.mp4.duration),
      audio: mp4.audio !== false,
      pulse: clamp(mp4.pulse, 0, 50, d.mp4.pulse, 1),
      pulseCycles: clamp(mp4.pulseCycles, 1, 8, d.mp4.pulseCycles, 1),
    },
  };
}

/* ------------------------------------ file names ------------------------------------ */

export const EXT: Record<ExportFormat, string> = { png: 'png', jpg: 'jpg', gif: 'gif', mp4: 'mp4' };

export interface NameContext {
  name: string;
  seed: number;
  date: Date;
  format: string;
  width: number;
  height: number;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Makes a string safe as a file name on Windows, macOS and Linux (no extension handling). */
export function safeFileName(s: string, fallback = 'glitch'): string {
  let out = s
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (out.length > 120) out = out.slice(0, 120).replace(/[. ]+$/, '');
  if (!out || RESERVED.test(out.split('.')[0])) out = out ? `_${out}` : fallback;
  return out;
}

/**
 * Fills a template: {nombre} {seed} {fecha} (YYYYMMDD) {hora} (HHMMSS) {formato} {ancho} {alto}.
 * Unknown tokens stay as typed (so the preview shows the mistake). Returns name + extension.
 */
export function renderFileName(template: string, ctx: NameContext, ext: string): string {
  const d = ctx.date;
  const vals: Record<string, string> = {
    nombre: ctx.name || 'glitch',
    seed: String(ctx.seed >>> 0),
    fecha: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
    hora: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    formato: ctx.format,
    ancho: String(ctx.width),
    alto: String(ctx.height),
  };
  const filled = template.replace(/\{(\w+)\}/g, (m, k: string) => vals[k.toLowerCase()] ?? m);
  let base = safeFileName(filled);
  // The user may have typed the extension: do not double it.
  if (base.toLowerCase().endsWith(`.${ext}`)) base = base.slice(0, -ext.length - 1) || 'glitch';
  return `${base}.${ext}`;
}

/* ------------------------------------ GIF timing ------------------------------------ */

export interface GifTiming {
  /** Per-frame delays in centiseconds. */
  delays: number[];
  /** Real average frame rate of the GIF. */
  fps: number;
  /** True when 100/fps is not a whole number of centiseconds. */
  uneven: boolean;
  /** True when the requested fps had to change (minimum delay). */
  clamped: boolean;
}

/** Browsers turn delays ≤ 1 cs into 10 cs: 2 cs (50 fps) is the fastest reliable GIF. */
export const GIF_MIN_DELAY = 2;

/**
 * Delays for n frames at `fps`. Whole centiseconds when 100/fps is an integer; otherwise
 * distributed by accumulated error (30 fps → 3,3,4,3,3,4…) so the average is exact.
 */
export function gifTiming(fps: number, n: number): GifTiming {
  let f = Number.isFinite(fps) && fps > 0 ? fps : 20;
  const clamped = f > 100 / GIF_MIN_DELAY;
  if (clamped) f = 100 / GIF_MIN_DELAY;
  const cs = 100 / f;
  const uneven = Math.abs(cs - Math.round(cs)) > 1e-9;
  const delays: number[] = [];
  for (let i = 0; i < n; i++) delays.push(Math.max(GIF_MIN_DELAY, Math.round((i + 1) * cs) - Math.round(i * cs)));
  const total = delays.reduce((a, b) => a + b, 0);
  return { delays, fps: n ? (n * 100) / total : f, uneven, clamped };
}

/** fps values that give whole-centisecond delays (shown as suggestions). */
export const GIF_EXACT_FPS = [50, 100 / 3, 25, 20, 100 / 6, 12.5, 10];

/* ------------------------------------ perfect loops ------------------------------------ */

/** One source instant (or two, blended) for output frame i. */
export interface LoopSample {
  /** Timeline time (s) of the main sample. */
  t: number;
  /** Crossfade: second time and the weight of the FIRST sample (1 = only t). */
  t2?: number;
  alpha: number;
}

/**
 * Output frame i of n → timeline time(s). `dur` = usable timeline length (s), `fps` output rate.
 * - crossfade: the loop lasts D' = dur − overlap; in its first `overlap` seconds the tail
 *   (t + D') fades into the head (t), so the step from the last frame to the first is just
 *   another step D'−dt → D'.
 * - pingpong: 0 → dur → 0 without repeating the turning frames.
 * - trim: plain 0 → dur (dur already cut where the footage loops best).
 */
export function loopSample(mode: LoopMode, i: number, n: number, fps: number, dur: number, overlap = 0): LoopSample {
  const t = i / fps;
  if (mode === 'pingpong') {
    // n = 2m − 2 frames for a forward pass of m frames.
    const m = Math.floor(n / 2) + 1;
    const k = i < m ? i : 2 * (m - 1) - i;
    return { t: Math.min(dur, k / fps), alpha: 1 };
  }
  if (mode === 'crossfade' && overlap > 0) {
    const loopLen = dur - overlap;
    if (t < overlap) {
      // alpha = weight of the head sample t; the tail sample is t + loopLen.
      return { t, t2: t + loopLen, alpha: t / overlap };
    }
    return { t, alpha: 1 };
  }
  return { t, alpha: 1 };
}

/** Number of output frames for a loop mode (crossfade shortens, ping-pong doubles minus turns). */
export function loopFrameCount(mode: LoopMode, fps: number, dur: number, overlap = 0): number {
  if (mode === 'pingpong') {
    const m = Math.max(2, Math.round(dur * fps));
    return 2 * m - 2;
  }
  const len = mode === 'crossfade' ? dur - overlap : dur;
  return Math.max(2, Math.round(len * fps));
}

/** Generated animations: EFFECT value for frame i of n (periodic with n, whole cycles). */
export function pulseEffect(base: number, amp: number, cycles: number, i: number, n: number): number {
  if (!amp || n <= 0) return base;
  const v = base + amp * Math.sin((2 * Math.PI * cycles * (((i % n) + n) % n)) / n);
  return Math.round(Math.min(100, Math.max(0, v)));
}

/* ------------------------------------ estimates ------------------------------------ */

/**
 * Rough GIF size (bytes): LZW on dithered content packs ~0.55–0.9 of the palette bits per pixel.
 * Good enough to warn about huge files before rendering them.
 */
export function estimateGifBytes(w: number, h: number, frames: number, colors: number, dither: Dither): number {
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, colors))));
  const k = dither === 'floyd' ? 0.9 : dither === 'bayer' ? 0.75 : 0.55;
  return Math.round(w * h * frames * (bits / 8) * k + frames * 30 + 800);
}

export const MP4_BPP: Record<Mp4Quality, number> = { low: 0.05, medium: 0.1, high: 0.2 };

/** H.264 bitrate (bits/s) for a size, rate and quality (bits per pixel per frame). */
export function mp4Bitrate(w: number, h: number, fps: number, q: Mp4Quality): number {
  return Math.round(Math.min(80e6, Math.max(250e3, w * h * fps * MP4_BPP[q])));
}

/** Even output size (H.264 needs even dimensions) for a document scaled to `height` (0 = original). */
export function mp4Size(docW: number, docH: number, height: number, maxSide = 4096): [number, number] {
  let h = height > 0 ? Math.min(height, docH) : docH;
  let w = (docW * h) / docH;
  const k = Math.min(1, maxSide / Math.max(w, h));
  w *= k;
  h *= k;
  // Down to even, never up: the output must not exceed the document.
  const even = (v: number) => Math.max(2, Math.floor(v / 2 + 1e-9) * 2);
  return [even(w), even(h)];
}

/** GIF output size: the document fitted to maxWidth (never upscaled). */
export function gifSize(docW: number, docH: number, maxWidth: number): [number, number] {
  const k = Math.min(1, maxWidth / docW);
  return [Math.max(1, Math.round(docW * k)), Math.max(1, Math.round(docH * k))];
}

export const fmtBytes = (b: number): string => (b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`);
