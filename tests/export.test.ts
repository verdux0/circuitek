import { describe, expect, it } from 'vitest';
import { ditherToIndex } from '../src/export/dither';
import {
  DEFAULT_TEMPLATE, defaultSettings, estimateGifBytes, gifSize, gifTiming, loopFrameCount, loopSample, mp4Bitrate, mp4Size,
  renderFileName, safeFileName, sanitizeSettings, type LoopMode,
} from '../src/export/settings';

const ctx = { name: 'Carta de ajuste', seed: 1337, date: new Date(2026, 10, 18, 9, 5, 7), format: 'png', width: 1600, height: 1200 };

describe('file name template', () => {
  it('fills every token', () => {
    expect(renderFileName(DEFAULT_TEMPLATE, ctx, 'png')).toBe('Carta de ajuste-1337-20261118.png');
    expect(renderFileName('{nombre}_{hora}_{formato}_{ancho}x{alto}', ctx, 'gif')).toBe('Carta de ajuste_090507_png_1600x1200.gif');
  });
  it('unknown tokens stay visible, case-insensitive known ones', () => {
    expect(renderFileName('{NOMBRE}-{nope}', ctx, 'jpg')).toBe('Carta de ajuste-{nope}.jpg');
  });
  it('does not double the extension', () => {
    expect(renderFileName('foto.png', ctx, 'png')).toBe('foto.png');
    expect(renderFileName('foto.PNG', ctx, 'png')).toBe('foto.png');
  });
  it('sanitizes illegal characters, reserved names, dots and length', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(safeFileName('  ..hola.. ')).toBe('hola');
    expect(safeFileName('CON')).toBe('_CON');
    expect(safeFileName('nul.txt')).toBe('_nul.txt');
    expect(safeFileName('')).toBe('glitch');
    expect(safeFileName('x'.repeat(300)).length).toBe(120);
    expect(renderFileName('{nombre}', { ...ctx, name: 'a/b' }, 'png')).toBe('a_b.png');
  });
});

describe('sanitizeSettings', () => {
  it('garbage → defaults', () => {
    expect(sanitizeSettings(null)).toEqual(defaultSettings());
    expect(sanitizeSettings('x')).toEqual(defaultSettings());
  });
  it('clamps ranges and rejects unknown enums', () => {
    const s = sanitizeSettings({
      format: 'bmp', save: 'cloud', jpg: { quality: 500, scale: -2 },
      gif: { colors: 1, fps: 500, dither: 'x', loop: 'boing', repeat: -5, maxWidth: 1e9 }, mp4: { height: 123, fps: 7, quality: 'ultra' },
    });
    expect(s.format).toBe('png');
    expect(s.save).toBe('download');
    expect(s.jpg).toEqual({ quality: 100, scale: 0.1 });
    expect(s.gif.colors).toBe(2);
    expect(s.gif.fps).toBe(50);
    expect(s.gif.dither).toBe('bayer');
    expect(s.gif.loop).toBe('crossfade');
    expect(s.gif.repeat).toBe(0);
    expect(s.gif.maxWidth).toBe(2048);
    expect(s.mp4.height).toBe(0);
    expect(s.mp4.fps).toBe(30);
    expect(s.mp4.quality).toBe('medium');
  });
  it('keeps valid values and round-trips through JSON', () => {
    const a = { ...defaultSettings(), format: 'gif' as const, template: '{seed}' };
    a.gif.colors = 64;
    a.gif.loop = 'pingpong';
    expect(sanitizeSettings(JSON.parse(JSON.stringify(a)))).toEqual(a);
  });
  it('an end before the start means "until the end"', () => {
    expect(sanitizeSettings({ mp4: { start: 5, end: 3 } }).mp4.end).toBe(0);
  });
});

describe('GIF delays (centiseconds)', () => {
  it('whole centiseconds are uniform and exact', () => {
    for (const fps of [50, 25, 20, 10, 12.5]) {
      const t = gifTiming(fps, 40);
      expect(new Set(t.delays).size).toBe(1);
      expect(t.uneven).toBe(false);
      expect(t.fps).toBeCloseTo(fps, 6);
    }
  });
  it('30 fps → 3,3,4 pattern with an exact average', () => {
    const t = gifTiming(30, 30);
    expect(t.uneven).toBe(true);
    expect(new Set(t.delays)).toEqual(new Set([3, 4]));
    expect(t.delays.reduce((a, b) => a + b, 0)).toBe(100);
    expect(t.fps).toBeCloseTo(30, 6);
  });
  it('above 50 fps is clamped to the 2 cs minimum', () => {
    const t = gifTiming(60, 10);
    expect(t.clamped).toBe(true);
    expect(Math.min(...t.delays)).toBeGreaterThanOrEqual(2);
    expect(t.fps).toBeCloseTo(50, 6);
  });
});

describe('perfect loop time maps', () => {
  const fps = 20;
  const step = (a: { t: number; t2?: number; alpha: number }) => (a.t2 !== undefined ? a.alpha * a.t + (1 - a.alpha) * a.t2 : a.t);
  it('crossfade: frame 0 is the tail at D′, the last frame is the head at D′−dt (normal step across the seam)', () => {
    const dur = 3;
    const ov = 0.75;
    const n = loopFrameCount('crossfade', fps, dur, ov);
    expect(n).toBe(Math.round((dur - ov) * fps));
    const first = loopSample('crossfade', 0, n, fps, dur, ov);
    const last = loopSample('crossfade', n - 1, n, fps, dur, ov);
    expect(first.alpha).toBe(0);
    expect(first.t2).toBeCloseTo(dur - ov, 9);
    expect(last.t2).toBeUndefined();
    expect(first.t2! - last.t).toBeCloseTo(1 / fps, 9);
    // inside the overlap both samples stay inside the footage
    for (let i = 0; i < n; i++) {
      const s = loopSample('crossfade', i, n, fps, dur, ov);
      expect(s.t).toBeLessThanOrEqual(dur);
      if (s.t2 !== undefined) expect(s.t2).toBeLessThanOrEqual(dur + 1e-9);
    }
  });
  it('ping-pong: goes out and back without repeating the turns, closes on frame 1', () => {
    const n = loopFrameCount('pingpong', fps, 1, 0);
    const ts = Array.from({ length: n }, (_, i) => loopSample('pingpong', i, n, fps, 1).t);
    expect(n).toBe(2 * 20 - 2);
    expect(ts[0]).toBe(0);
    expect(Math.max(...ts)).toBeCloseTo(19 / 20, 9);
    // every step, the seam included, is exactly one frame
    for (let i = 0; i < n; i++) expect(Math.abs(ts[(i + 1) % n] - ts[i])).toBeCloseTo(1 / fps, 9);
    // no frame shown twice in a row at the turns
    expect(ts.filter((t) => t === Math.max(...ts)).length).toBe(1);
  });
  it('the loop is periodic: frame n would be frame 0 for every mode', () => {
    for (const mode of ['crossfade', 'pingpong', 'trim'] as LoopMode[]) {
      const n = loopFrameCount(mode, fps, 2, 0.5);
      const a = loopSample(mode, 0, n, fps, 2, 0.5);
      // the frame after the last one is the first one: same sample
      expect(step(loopSample(mode, n % n, n, fps, 2, 0.5))).toBeCloseTo(step(a), 9);
    }
  });
});

describe('sizes and estimates', () => {
  it('MP4 sizes are even and keep the aspect', () => {
    expect(mp4Size(1601, 1201, 0)).toEqual([1600, 1200]);
    expect(mp4Size(1920, 1080, 720)).toEqual([1280, 720]);
    expect(mp4Size(720, 1280, 2160)).toEqual([720, 1280]);
    const [w, h] = mp4Size(1000, 333, 0);
    expect(w % 2 + h % 2).toBe(0);
  });
  it('GIF size never upscales', () => {
    expect(gifSize(1600, 1200, 480)).toEqual([480, 360]);
    expect(gifSize(320, 240, 480)).toEqual([320, 240]);
  });
  it('bitrate grows with quality and stays bounded', () => {
    expect(mp4Bitrate(1280, 720, 30, 'high')).toBeGreaterThan(mp4Bitrate(1280, 720, 30, 'low'));
    expect(mp4Bitrate(8, 8, 1, 'low')).toBe(250e3);
    expect(mp4Bitrate(8000, 8000, 60, 'high')).toBe(80e6);
  });
  it('GIF estimate grows with frames, colors and dithering', () => {
    const base = estimateGifBytes(480, 360, 60, 128, 'none');
    expect(estimateGifBytes(480, 360, 120, 128, 'none')).toBeGreaterThan(base);
    expect(estimateGifBytes(480, 360, 60, 256, 'none')).toBeGreaterThan(base);
    expect(estimateGifBytes(480, 360, 60, 128, 'floyd')).toBeGreaterThan(base);
  });
});

describe('dithering (palette mapping)', () => {
  const gray = (w: number, h: number, v: number) => {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) a.set([v, v, v, 255], i * 4);
    return a;
  };
  const bw = [[0, 0, 0], [255, 255, 255]];
  const mean = (idx: Uint8Array) => (idx.reduce((s, i) => s + bw[i][0], 0) / idx.length);
  it('exact palette colors map to themselves in every mode', () => {
    const pal = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
    const px = new Uint8ClampedArray(pal.flatMap((c) => [...c, 255]));
    for (const m of ['none', 'floyd'] as const) expect([...ditherToIndex(px, 4, 1, pal, m)]).toEqual([0, 1, 2, 3]);
  });
  it('none: 50 % gray → all one color; Bayer and Floyd–Steinberg keep the average tone', () => {
    const px = gray(32, 32, 128);
    expect(new Set(ditherToIndex(px, 32, 32, bw, 'none')).size).toBe(1);
    expect(mean(ditherToIndex(px, 32, 32, bw, 'floyd'))).toBeGreaterThan(110);
    expect(mean(ditherToIndex(px, 32, 32, bw, 'floyd'))).toBeLessThan(146);
    const b = ditherToIndex(px, 32, 32, bw, 'bayer');
    expect(new Set(b).size).toBe(2);
  });
  it('Bayer is a fixed pattern: same input → same output, every time', () => {
    const px = gray(16, 16, 90);
    expect([...ditherToIndex(px, 16, 16, bw, 'bayer')]).toEqual([...ditherToIndex(px, 16, 16, bw, 'bayer')]);
  });
});
