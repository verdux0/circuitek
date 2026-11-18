/**
 * Orchestrates rendering: GPU pass chain (preview / thumbnails / full-res export)
 * followed by the optional byte-level encoder stage in a worker.
 */
import { GLRenderer } from './gl/renderer';
import { EncoderClient } from './encoder/client';
import { encParams, encSeed, type GlitchState } from './model';

export const PREVIEW_MAX = 1280;
export const THUMB_MAX = 320;
/** Hard cap for imported images (megapixels) to keep exports within memory. */
export const MAX_MEGAPIXELS = 48;

export function fitSize(w: number, h: number, max: number): [number, number] {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

async function scaled(bmp: ImageBitmap, w: number, h: number): Promise<ImageBitmap> {
  if (bmp.width === w && bmp.height === h) return bmp;
  return createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
}

export class Engine {
  readonly preview = new GLRenderer();
  private thumb = new GLRenderer();
  private enc = new EncoderClient();
  original: ImageBitmap | null = null;
  previewW = 0;
  previewH = 0;
  /** Set when the import was downscaled to fit limits. */
  downscaledFrom: [number, number] | null = null;

  private version = 0;
  private encBusy = false;
  private encQueued: (() => void) | null = null;
  onBusy: (busy: boolean) => void = () => {};

  async setImage(bmp: ImageBitmap): Promise<void> {
    let w = bmp.width;
    let h = bmp.height;
    this.downscaledFrom = null;
    const limit = Math.min(this.preview.maxSize, 16384);
    const mp = (w * h) / 1e6;
    if (Math.max(w, h) > limit || mp > MAX_MEGAPIXELS) {
      const k = Math.min(limit / Math.max(w, h), Math.sqrt(MAX_MEGAPIXELS / mp));
      this.downscaledFrom = [w, h];
      [w, h] = [Math.floor(w * k), Math.floor(h * k)];
    }
    this.original = await scaled(bmp, w, h);
    [this.previewW, this.previewH] = fitSize(w, h, PREVIEW_MAX);
    const pv = await scaled(this.original, this.previewW, this.previewH);
    this.preview.setSource(pv, this.previewW, this.previewH);
    const [tw, th] = fitSize(w, h, THUMB_MAX);
    const tb = await scaled(this.original, tw, th);
    this.thumb.setSource(tb, tw, th);
    this.version++;
  }

  get hasImage(): boolean {
    return this.original !== null;
  }

  /**
   * Draws the live preview into `ctx`. GPU result is immediate; if the encoder stage is
   * active the worker result replaces it (latest-only queue so dragging stays fluid).
   */
  renderPreview(state: GlitchState, ctx: CanvasRenderingContext2D): void {
    if (!this.original) return;
    const v = ++this.version;
    const c = ctx.canvas;
    if (c.width !== this.previewW || c.height !== this.previewH) {
      c.width = this.previewW;
      c.height = this.previewH;
    }
    this.preview.render(state, this.previewW, this.previewH);
    const p = encParams(state);
    if (!p) {
      ctx.drawImage(this.preview.canvas, 0, 0);
      return;
    }
    const img = this.preview.readPixels();
    const job = () => {
      this.encBusy = true;
      this.onBusy(true);
      this.enc.run(img, p, encSeed(state)).then((out) => {
        if (v === this.version) ctx.putImageData(out, 0, 0);
        this.encBusy = false;
        const next = this.encQueued;
        this.encQueued = null;
        if (next) next();
        else this.onBusy(false);
      });
    };
    if (this.encBusy) this.encQueued = job;
    else job();
  }

  drawOriginal(ctx: CanvasRenderingContext2D): void {
    if (!this.original) return;
    ctx.drawImage(this.original, 0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  /** Full pipeline (GPU + encoder) at thumbnail size. */
  async renderThumb(state: GlitchState): Promise<ImageData> {
    const [w, h] = this.thumb.sourceSize;
    return this.finish(this.thumb, state, w, h);
  }

  /** Full pipeline at preview size, returned as pixels (used by tests and capture). */
  async renderPreviewPixels(state: GlitchState): Promise<ImageData> {
    return this.finish(this.preview, state, this.previewW, this.previewH);
  }

  private async finish(r: GLRenderer, state: GlitchState, w: number, h: number): Promise<ImageData> {
    r.render(state, w, h);
    const img = r.readPixels();
    const p = encParams(state);
    return p ? this.enc.run(img, p, encSeed(state)) : img;
  }

  /** Renders the original at full resolution and encodes it to PNG or JPEG. */
  async exportFull(state: GlitchState, type: 'image/png' | 'image/jpeg', onStep: (msg: string) => void = () => {}): Promise<{ blob: Blob; w: number; h: number }> {
    if (!this.original) throw new Error('No hay imagen');
    const { width: w, height: h } = this.original;
    onStep(`GPU ${w}×${h}`);
    const r = new GLRenderer();
    try {
      r.setSource(this.original, w, h);
      const img = await this.finish(r, state, w, h);
      onStep('Codificando');
      const cv = new OffscreenCanvas(w, h);
      cv.getContext('2d')!.putImageData(img, 0, 0);
      const blob = await cv.convertToBlob(type === 'image/jpeg' ? { type, quality: 0.95 } : { type });
      return { blob, w, h };
    } finally {
      r.dispose();
    }
  }
}
