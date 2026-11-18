/// <reference lib="webworker" />
/**
 * GIF encoder worker: palette quantization (gifenc, PnnQuant), dithering (dither.ts) and LZW
 * (gifenc). Frames arrive one by one and their bytes go back as chunks right away, so neither
 * the frames nor the whole file pile up here.
 */
import { GIFEncoder, quantize, type Palette } from 'gifenc';
import { ditherToIndex } from './dither';
import type { Dither } from './settings';

export type GifRequest =
  | { type: 'palette'; samples: ArrayBuffer; colors: number }
  | { type: 'start'; w: number; h: number; palette: Palette; repeat: number; dither: Dither }
  | { type: 'frame'; buf: ArrayBuffer; delayCs: number }
  | { type: 'finish' };
export type GifResponse =
  | { type: 'palette'; palette: Palette }
  | { type: 'chunk'; bytes: ArrayBuffer; frames: number }
  | { type: 'done'; frames: number }
  | { type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let enc: ReturnType<typeof GIFEncoder> | null = null;
let cfg: Extract<GifRequest, { type: 'start' }> | null = null;
let frames = 0;

function flush(): void {
  if (!enc) return;
  const b = enc.bytes();
  enc.reset();
  const copy = b.slice().buffer;
  const msg: GifResponse = { type: 'chunk', bytes: copy, frames };
  ctx.postMessage(msg, [copy]);
}

ctx.onmessage = (e: MessageEvent<GifRequest>) => {
  const m = e.data;
  try {
    if (m.type === 'palette') {
      const palette = quantize(new Uint8Array(m.samples), m.colors, { format: 'rgb565' });
      ctx.postMessage({ type: 'palette', palette } satisfies GifResponse);
    } else if (m.type === 'start') {
      cfg = m;
      frames = 0;
      enc = GIFEncoder({ auto: false, initialCapacity: 1 << 20 });
      enc.writeHeader();
    } else if (m.type === 'frame') {
      if (!enc || !cfg) throw new Error('GIF: frame before start');
      const index = ditherToIndex(new Uint8Array(m.buf), cfg.w, cfg.h, cfg.palette, cfg.dither);
      const first = frames === 0;
      // gifenc takes ms and stores centiseconds: pass cs × 10 so nothing is rounded twice.
      // Global palette only (written with the first frame): colors never jump between frames.
      enc.writeFrame(index, cfg.w, cfg.h, first ? { first: true, palette: cfg.palette, repeat: cfg.repeat, delay: m.delayCs * 10 } : { delay: m.delayCs * 10 });
      frames++;
      flush();
    } else if (m.type === 'finish') {
      if (!enc) throw new Error('GIF: finish before start');
      enc.finish();
      flush();
      ctx.postMessage({ type: 'done', frames } satisfies GifResponse);
      enc = null;
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', message: (err as Error).message } satisfies GifResponse);
  }
};
