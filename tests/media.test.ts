import { describe, expect, it } from 'vitest';
import { GifWriter } from 'omggif';
import { gifFrameCountAtLeast2 } from '../src/media/player';
import { DEFAULT_FPS, MAX_SPEED, MIN_SPEED, SPEEDS, clampSpeed, estimateFps, formatTime, frameAt, frameSeed, spokenTime } from '../src/media/timing';

describe('frameSeed (glitch animado)', () => {
  it('off: the seed is the layer seed for every frame', () => {
    for (const f of [0, 1, 99, 12345]) expect(frameSeed(1337, f, false)).toBe(1337);
  });
  it('on: deterministic, and differs between frames', () => {
    expect(frameSeed(1337, 42, true)).toBe(frameSeed(1337, 42, true));
    const seen = new Set(Array.from({ length: 500 }, (_, f) => frameSeed(1337, f, true)));
    expect(seen.size).toBe(500);
  });
  it('on: depends on the seed too, and stays a uint32', () => {
    expect(frameSeed(1, 5, true)).not.toBe(frameSeed(2, 5, true));
    for (const s of [0, 1, 4294967295]) {
      const v = frameSeed(s, 7, true);
      expect(Number.isInteger(v) && v >= 0 && v <= 4294967295).toBe(true);
    }
  });
  it('negative / fractional frames are clamped and floored', () => {
    expect(frameSeed(9, -3, true)).toBe(frameSeed(9, 0, true));
    expect(frameSeed(9, 4.7, true)).toBe(frameSeed(9, 4, true));
  });
});

describe('frame index ↔ time', () => {
  it("a frame's own presentation time maps to that frame (no float drift)", () => {
    for (const fps of [24, 25, 29.97, 30, 60]) for (let n = 0; n < 2000; n += 37) expect(frameAt(n / fps, fps)).toBe(n);
  });
  it('garbage input is safe', () => {
    expect(frameAt(NaN, 30)).toBe(0);
    expect(frameAt(-1, 30)).toBe(0);
    expect(frameAt(1, 0)).toBe(DEFAULT_FPS);
  });
  it('estimateFps: median gap, snapped to common rates, robust to drops', () => {
    expect(estimateFps([1 / 30, 1 / 30, 2 / 30, 1 / 30, 1 / 30])).toBe(30);
    expect(estimateFps(Array(10).fill(1 / 24.02))).toBe(24);
    expect(estimateFps(Array(10).fill(1 / 29.97))).toBe(29.97);
    expect(estimateFps([0.04, 0.04, 3, 0.04])).toBe(25);
    expect(estimateFps([0.033])).toBe(DEFAULT_FPS);
  });
});

describe('formatTime', () => {
  it('m:ss.d and h:mm:ss.d', () => {
    expect(formatTime(0)).toBe('0:00.0');
    expect(formatTime(5.25)).toBe('0:05.2');
    expect(formatTime(65.99)).toBe('1:05.9');
    expect(formatTime(3600 + 62.5)).toBe('1:01:02.5');
  });
  it('never rounds up past the real time (0.99 → 0.9)', () => {
    expect(formatTime(0.99)).toBe('0:00.9');
    expect(formatTime(59.999)).toBe('0:59.9');
  });
  it('NaN / Infinity / negative → 0', () => {
    for (const v of [NaN, -3, Infinity]) expect(formatTime(v)).toBe('0:00.0');
  });
  it('spokenTime', () => {
    expect(spokenTime(5.9)).toBe('5 s');
    expect(spokenTime(125)).toBe('2 min 05 s');
  });
});

describe('playback speed', () => {
  it('clamps to 0.25×–2×', () => {
    expect(clampSpeed(0.1)).toBe(MIN_SPEED);
    expect(clampSpeed(8)).toBe(MAX_SPEED);
    expect(clampSpeed(1.5)).toBe(1.5);
  });
  it('garbage → 1×', () => {
    for (const v of [NaN, 0, -1, Infinity]) expect(clampSpeed(v)).toBe(1);
  });
  it('every offered speed is within range and kept as is', () => {
    for (const s of SPEEDS) expect(clampSpeed(s)).toBe(s);
    expect(SPEEDS[0]).toBe(MIN_SPEED);
    expect(SPEEDS[SPEEDS.length - 1]).toBe(MAX_SPEED);
  });
});

describe('animated GIF detection (gifFrameCountAtLeast2)', () => {
  const makeGif = (frames: number, w = 8, h = 6): Uint8Array => {
    const buf = new Uint8Array(4096);
    const g = new GifWriter(buf as unknown as number[], w, h, { palette: [0x000000, 0xff0000, 0x00ff00, 0x0000ff], loop: 0 });
    for (let i = 0; i < frames; i++) g.addFrame(0, 0, w, h, Array.from({ length: w * h }, (_, k) => (k + i) % 4), { delay: 5 });
    return buf.subarray(0, g.end());
  };
  it('1 frame = still image, 2+ frames = animated', () => {
    expect(gifFrameCountAtLeast2(makeGif(1))).toBe(false);
    expect(gifFrameCountAtLeast2(makeGif(2))).toBe(true);
    expect(gifFrameCountAtLeast2(makeGif(7))).toBe(true);
  });
  it('not a GIF / truncated → false, never throws', () => {
    expect(gifFrameCountAtLeast2(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(gifFrameCountAtLeast2(makeGif(3).subarray(0, 40))).toBe(false);
    expect(gifFrameCountAtLeast2(new Uint8Array(0))).toBe(false);
  });
});
