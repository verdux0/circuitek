/**
 * Orchestrates rendering of the layered document: GPU compositor (layers, per-layer effects,
 * blend modes). The app passes `global = null` (every layer owns its effects); the global
 * stage is kept in the pipeline for completeness (adjustment-style effects over the result).
 * One WebGL context serves the live preview and the thumbnails (layer textures are shared);
 * exports use a fresh context that streams layer by layer and is destroyed afterwards.
 */
import { GLRenderer, type RenderJob, type SourceProvider } from './gl/renderer';
import { EncoderClient } from './encoder/client';
import { encParams, encSeed, type GlitchState } from './model';
import type { DocState } from './doc';

export const PREVIEW_MAX = 1280;
/** Upper bound for the adaptive preview resolution when zoomed in. */
export const PREVIEW_MAX_ZOOMED = 4096;
export const THUMB_MAX = 320;
/** Hard cap for the document (megapixels) to keep exports within memory. */
export const MAX_MEGAPIXELS = 48;

export function fitSize(w: number, h: number, max: number): [number, number] {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

export class Engine {
  private enc = new EncoderClient();
  readonly gl: GLRenderer;
  previewW = 0;
  previewH = 0;
  private previewMax = PREVIEW_MAX;
  private version = 0;
  private encBusy = false;
  private encQueued: (() => void) | null = null;
  onBusy: (busy: boolean) => void = () => {};
  /** Called whenever new pixels land in the preview canvas (sync or from a worker). */
  onPresent: () => void = () => {};
  /** A per-layer encoder finished in the background: render again. */
  onLayerReady: () => void = () => {};

  constructor(private provider: SourceProvider) {
    this.gl = new GLRenderer(provider, (img, p, seed) => this.enc.run(img, p, seed));
    this.gl.onAsync = () => this.onLayerReady();
  }

  get maxSize(): number {
    return Math.min(this.gl.maxSize, 16384);
  }

  /** Recomputes the preview size for a document; returns true if it changed. */
  setDocSize(w: number, h: number, previewMax = this.previewMax): boolean {
    this.previewMax = previewMax;
    const [pw, ph] = fitSize(w, h, Math.min(previewMax, this.maxSize));
    const changed = pw !== this.previewW || ph !== this.previewH;
    this.previewW = pw;
    this.previewH = ph;
    return changed;
  }

  /**
   * Draws the live preview into `ctx`. GPU result is immediate; if the global encoder stage
   * is active the worker result replaces it (latest-only queue so dragging stays fluid).
   * `original` = no effects at all (A/B).
   */
  renderPreview(doc: DocState, global: GlitchState | null, ctx: CanvasRenderingContext2D, original = false): void {
    if (!doc.layers.length) return;
    this.setDocSize(doc.w, doc.h);
    const v = ++this.version;
    const c = ctx.canvas;
    const [w, h] = [this.previewW, this.previewH];
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    this.gl.render({ doc, global: original ? null : global, layerFx: !original, w, h });
    const p = original || !global ? null : encParams(global);
    if (!p) {
      // Transparent pixels must not keep the previous frame.
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this.gl.canvas, 0, 0);
      this.onPresent();
      return;
    }
    const img = this.gl.readPixels();
    const job = () => {
      this.encBusy = true;
      this.onBusy(true);
      this.enc.run(img, p, encSeed(global!)).then((out) => {
        // Latest-only: drop results that a newer render (or a resize) made stale.
        if (v === this.version && c.width === w && c.height === h) {
          ctx.putImageData(out, 0, 0);
          this.onPresent();
        }
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

  /** Full pipeline (all encoders awaited) at an arbitrary size. */
  private async finish(r: GLRenderer, job: RenderJob, stream = false): Promise<ImageData> {
    const img = await r.renderFinal(job, stream);
    const p = job.global ? encParams(job.global) : null;
    return p ? this.enc.run(img, p, encSeed(job.global!)) : img;
  }

  /** A renderer with its own WebGL context and pixel provider (exports render frame by frame). */
  exportRenderer(provider: SourceProvider): GLRenderer {
    return new GLRenderer(provider, (img, p, seed) => this.enc.run(img, p, seed));
  }

  /** Every stage (encoders awaited) at w × h with renderer `r`: one exported frame. */
  renderWith(r: GLRenderer, doc: DocState, w: number, h: number): Promise<ImageData> {
    return this.finish(r, { doc, global: null, layerFx: true, w, h });
  }

  async renderThumb(doc: DocState, global: GlitchState | null): Promise<ImageData> {
    const [w, h] = fitSize(doc.w, doc.h, THUMB_MAX);
    return this.finish(this.gl, { doc, global, layerFx: true, w, h });
  }

  /** Full pipeline at preview size, returned as pixels (used by tests). */
  async renderPreviewPixels(doc: DocState, global: GlitchState | null): Promise<ImageData> {
    this.setDocSize(doc.w, doc.h);
    return this.finish(this.gl, { doc, global, layerFx: true, w: this.previewW, h: this.previewH });
  }

  /** Renders the document at full resolution and encodes it to PNG or JPEG. */
  async exportFull(
    doc: DocState, global: GlitchState | null, type: 'image/png' | 'image/jpeg', onStep: (msg: string) => void = () => {},
    opts: { scale?: number; quality?: number; provider?: SourceProvider } = {},
  ): Promise<{ blob: Blob; w: number; h: number }> {
    const k = opts.scale ?? 1;
    const [w, h] = fitSize(Math.max(1, Math.round(doc.w * k)), Math.max(1, Math.round(doc.h * k)), this.maxSize);
    onStep(`GPU ${w}×${h} · ${doc.layers.length} capa${doc.layers.length === 1 ? '' : 's'}`);
    const r = new GLRenderer(opts.provider ?? this.provider, (img, p, seed) => this.enc.run(img, p, seed));
    try {
      const img = await this.finish(r, { doc, global, layerFx: true, w, h }, true);
      onStep('Codificando');
      const cv = new OffscreenCanvas(w, h);
      cv.getContext('2d')!.putImageData(img, 0, 0);
      const blob = await cv.convertToBlob(type === 'image/jpeg' ? { type, quality: opts.quality ?? 0.95 } : { type });
      return { blob, w, h };
    } finally {
      r.dispose();
    }
  }

  get memory(): { caches: number; sources: number; work: number } {
    return this.gl.memory;
  }
}
