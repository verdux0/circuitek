import { COMP_FRAG, FRAG, FX_FRAG, LAYER_FRAG, LAYER_VERT, VERT } from './shaders';
import { buildGpuPasses, encParams, encSeed, type EncParams, type GlitchState, type GpuPass } from '../model';
import { BLENDS, layerMatrix, type DocState, type Layer } from '../doc';
import { stateAtFrame } from '../motion';
import { mixSeed } from '../prng';
import {
  CONTOURS, effectAngle, fxOn, maskRadii, shadowOffset, styleActive, usesGlobalLight, type GlowFx, type InnerGlowFx, type LayerStyle, type ShadowFx,
} from '../layerstyle';

/**
 * WebGL2 layer compositor + glitch chain.
 *
 *   for each visible layer (bottom → top):
 *     no own effects, normal blend → drawn straight onto the accumulator (hardware blending)
 *     own effects                  → placed in document space (tmp) → glitch passes on the
 *                                    shared ping-pong pair → per-layer cache texture
 *     custom blend mode            → blend shader reads accumulator + layer, writes the other one
 *   global effects → passes over the accumulator → canvas
 *
 * Layer styles (layerstyle.ts) are part of the layer and come BEFORE its glitch passes, so the
 * glitch also bends shadows and glows: inner effects are merged into the layer (FX_FRAG op 4);
 * outer effects (drop shadow, outer glow) go through the same passes into their own cache
 * textures and are blended onto the backdrop with their own blend mode, under the layer.
 *
 * Memory: the work textures (2 accumulators, tmp, 2 ping-pong) are shared by every layer;
 * only layers with their own effects keep a cache texture, at the render size, bounded by
 * an LRU budget. Final renders (thumbnails, export) can stream: one layer at a time,
 * freeing its textures right after compositing it.
 */

interface Target {
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
}
interface TargetSet {
  w: number;
  h: number;
  accA: Target;
  accB: Target;
  tmp: Target;
  p0: Target;
  p1: Target;
  used: number;
  /** Layer-style work targets (mask ping-pong, effect, content ping-pong), created on first use. */
  fx?: { m1: Target; m2: Target; e: Target; c1: Target; c2: Target };
}
interface SourceTex {
  tex: WebGLTexture;
  bytes: number;
  used: number;
  /** Dynamic sources: frame currently in the texture, and its size. */
  frame?: number;
  w?: number;
  h?: number;
}
interface CacheEntry extends Target {
  key: string;
  w: number;
  h: number;
  used: number;
  /** Encoder stage result has been written into the texture. */
  encDone: boolean;
  encBusy: boolean;
  /** An encoded result has been shown at least once (animated preview can hold it). */
  hasEnc?: boolean;
  /** Animated preview + encoder: GPU frames go here; the encoder reads them; `tex` keeps the last encoded frame. */
  side?: Target;
  /** Outer effects of the layer style (bottom → top), after the layer's glitch passes, with their blend mode. */
  outer?: { t: Target; blend: number; borrowed?: boolean }[];
  /**
   * The style's own result BEFORE the glitch: the layer with its inner effects (null = no inner
   * effect, the plain layer is used) and each outer effect. It depends on the layer's pixels,
   * transform and style only — not on the animation frame — so an animated layer only re-runs its
   * glitch passes on it every frame instead of rebuilding shadows and glows.
   */
  styled?: { key: string; content: Target | null; outer: { src: Target; blend: number }[] };
}

/** What the renderer needs from the app to draw a layer. */
export interface SourceRef {
  /** Identifies the pixels (image + resolution variant, or text raster + resolution). */
  key: string;
  load(): TexImageSource;
  w: number;
  h: number;
  /**
   * Dynamic sources (video / GIF): index of the frame `load()` returns now. The texture under
   * `key` is kept and re-uploaded only when this changes; the layer cache is keyed on it too.
   */
  frame?: number;
  /** Bumped every time the player presents new pixels (a seek can repaint the same index). */
  stamp?: number;
  /** Skip the encoder stage (JPEG / pixel sort) in this render: the media is playing. */
  liveOnly?: boolean;
  /**
   * Frame of the effects animation (noise and «Movimiento»), the same for every layer:
   * the effects clock in the preview, output frame i in exports. Undefined = base state.
   * Independent of `frame` (a GIF's own frame only picks its pixels).
   */
  noise?: number;
  /** Loop length (frames) the noise / motion of this render is periodic with. */
  loop?: number;
}
export interface SourceProvider {
  /** `pxScale` = output pixels per layer pixel. */
  source(l: Layer, pxScale: number): SourceRef | null;
}
export type LayerEncoder = (img: ImageData, p: EncParams, seed: number) => Promise<ImageData>;

export interface RenderJob {
  doc: DocState;
  /** Effects over the whole composite (null = none). */
  global: GlitchState | null;
  /** false = ignore per-layer effects (A/B view of the original). */
  layerFx: boolean;
  w: number;
  h: number;
}

const BLEND_INDEX = new Map(BLENDS.map(([v], i) => [v as string, i]));
/** Default budget for per-layer caches (bytes, RGBA8). */
export const CACHE_BUDGET = 256 * 1024 * 1024;

export function layerHasFx(l: Layer): boolean {
  return (!!l.fx && (buildGpuPasses(l.fx).length > 0 || encParams(l.fx) !== null)) || styleActive(l.style);
}

export class GLRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly maxSize: number;
  private pG: WebGLProgram;
  private pL: WebGLProgram;
  private pC: WebGLProgram;
  private pF: WebGLProgram;
  private u = new Map<WebGLProgram, Record<string, WebGLUniformLocation | null>>();
  private sets = new Map<string, TargetSet>();
  private sources = new Map<string, SourceTex>();
  private caches = new Map<string, CacheEntry>();
  private clock = 0;
  /** Final renders in flight: their caches must survive a live render's sweep. */
  private finals = 0;
  cacheBudget = CACHE_BUDGET;
  /** A live per-layer encoder finished: the caller should render again. */
  onAsync: () => void = () => {};

  constructor(
    private provider: SourceProvider,
    private encode: LayerEncoder,
    canvas: HTMLCanvasElement = document.createElement('canvas'),
  ) {
    this.canvas = canvas;
    // The accumulator holds premultiplied colour (see beginAccum), so the canvas does too:
    // with a transparent background it is drawn / read with its alpha (readFb un-premultiplies).
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: true, antialias: false, alpha: true });
    if (!gl) throw new Error('WebGL2 no está disponible en este navegador.');
    this.gl = gl;
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.pG = this.link(VERT, FRAG, ['u_tex', 'u_pass', 'u_mode', 'u_amt', 'u_filter', 'u_p', 'u_seed', 'u_aspect']);
    this.pL = this.link(LAYER_VERT, LAYER_FRAG, ['u_tex', 'u_m', 'u_doc', 'u_opacity']);
    this.pC = this.link(VERT, COMP_FRAG, ['u_src', 'u_dst', 'u_opacity', 'u_mode']);
    this.pF = this.link(VERT, FX_FRAG, [
      'u_src', 'u_mask', 'u_fx', 'u_op', 'u_offset', 'u_invert', 'u_dir', 'u_radius', 'u_color', 'u_color2', 'u_gradient', 'u_opacity', 'u_noise',
      'u_seed', 'u_contour', 'u_range', 'u_clip', 'u_center', 'u_mode',
    ]);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  private link(vs: string, fs: string, uniforms: string[]): WebGLProgram {
    const gl = this.gl;
    const mk = (type: number, code: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, code);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program: ${gl.getProgramInfoLog(p)}`);
    const u: Record<string, WebGLUniformLocation | null> = {};
    for (const n of uniforms) u[n] = gl.getUniformLocation(p, n);
    this.u.set(p, u);
    return p;
  }

  /* ------------------------------ textures ------------------------------ */

  private emptyTarget(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb };
  }

  private freeTarget(t: Target): void {
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fb);
  }

  private targets(w: number, h: number, tag: string): TargetSet {
    const key = `${tag}:${w}x${h}`;
    let s = this.sets.get(key);
    if (!s) {
      s = { w, h, accA: this.emptyTarget(w, h), accB: this.emptyTarget(w, h), tmp: this.emptyTarget(w, h), p0: this.emptyTarget(w, h), p1: this.emptyTarget(w, h), used: 0 };
      this.sets.set(key, s);
      // Keep at most 3 sizes alive (preview, thumbnails, one-off).
      const old = [...this.sets.entries()].filter(([k]) => k !== key && !(this.finals > 0 && k.startsWith('final:'))).sort((a, b) => a[1].used - b[1].used);
      while (this.sets.size > 3 && old.length) this.dropSet(old.shift()![0]);
    }
    s.used = ++this.clock;
    return s;
  }

  private dropSet(key: string): void {
    const s = this.sets.get(key);
    if (!s) return;
    for (const t of [s.accA, s.accB, s.tmp, s.p0, s.p1]) this.freeTarget(t);
    if (s.fx) for (const t of Object.values(s.fx)) this.freeTarget(t);
    this.sets.delete(key);
  }

  /** Layer pixels as a mipmapped texture, uploaded once per key (images are flipped to GL orientation). */
  private sourceTex(ref: SourceRef): WebGLTexture {
    if (ref.frame !== undefined) return this.dynamicTex(ref);
    const hit = this.sources.get(ref.key);
    if (hit) {
      hit.used = ++this.clock;
      return hit.tex;
    }
    const gl = this.gl;
    const img = ref.load();
    const cv = new OffscreenCanvas(ref.w, ref.h);
    const g = cv.getContext('2d')!;
    g.translate(0, ref.h);
    g.scale(1, -1);
    g.drawImage(img as CanvasImageSource, 0, 0, ref.w, ref.h);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.sources.set(ref.key, { tex, bytes: ref.w * ref.h * 4 * 1.34, used: ++this.clock });
    return tex;
  }

  /**
   * Video / GIF frame: one texture per source, re-uploaded straight from the element (or
   * bitmap) when the frame changes. No mipmaps (rebuilding them every frame costs more than
   * it gives at preview scales) and no 2D canvas in between: the GPU flips it on upload.
   */
  private dynamicTex(ref: SourceRef): WebGLTexture {
    const gl = this.gl;
    let s = this.sources.get(ref.key);
    if (s && (s.w !== ref.w || s.h !== ref.h)) {
      this.dropSource(ref.key);
      s = undefined;
    }
    if (!s) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      s = { tex, bytes: ref.w * ref.h * 4, used: 0, frame: undefined, w: ref.w, h: ref.h };
      this.sources.set(ref.key, s);
    }
    s.used = ++this.clock;
    const token = ref.stamp ?? ref.frame;
    if (s.frame !== token) {
      gl.bindTexture(gl.TEXTURE_2D, s.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, ref.load());
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      s.frame = token;
    }
    return s.tex;
  }

  /** One reusable result object per layer: an animated preview allocates no new state per frame. */
  private scratch = new Map<string, GlitchState>();

  /** Effects of this render's frame: the shared stateAtFrame (same as the exports). */
  private frameFx(l: Layer, ref: SourceRef): GlitchState {
    let out = this.scratch.get(l.id);
    if (!out) this.scratch.set(l.id, (out = {} as GlitchState));
    return stateAtFrame(l.fx!, ref.noise, ref.loop ?? 0, true, out);
  }

  private dropSource(key: string): void {
    const s = this.sources.get(key);
    if (!s) return;
    this.gl.deleteTexture(s.tex);
    this.sources.delete(key);
  }

  /* ------------------------------ drawing primitives ------------------------------ */

  /** Glitch passes from `input` to `out` (null = canvas). Uses the set's ping-pong pair. */
  private runPasses(passes: GpuPass[], input: WebGLTexture, out: WebGLFramebuffer | null, set: TargetSet): void {
    const gl = this.gl;
    const u = this.u.get(this.pG)!;
    gl.useProgram(this.pG);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, set.w, set.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.u_tex, 0);
    gl.uniform1f(u.u_aspect, set.w / set.h);
    const steps: (GpuPass | null)[] = passes.length ? passes : [null];
    let src = input;
    steps.forEach((p, i) => {
      const last = i === steps.length - 1;
      const dst = last ? out : (i % 2 === 0 ? set.p0 : set.p1).fb;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(u.u_pass, p ? p.pass : 9);
      gl.uniform1i(u.u_mode, p ? p.mode : 0);
      gl.uniform1f(u.u_amt, p ? p.amt : 0);
      gl.uniform1f(u.u_filter, p ? p.filter : 0);
      const v = p ? p.p : [0, 0, 0, 0];
      gl.uniform4f(u.u_p, v[0], v[1], v[2], v[3]);
      gl.uniform1ui(u.u_seed, p ? p.seed >>> 0 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!last) src = (i % 2 === 0 ? set.p0 : set.p1).tex;
    });
  }

  /** Draws a texture as a quad mapped by `m` (unit square → document px) into fb. */
  private drawQuad(tex: WebGLTexture, m: number[], doc: DocState, fb: WebGLFramebuffer, set: TargetSet, opacity: number, blend: boolean): void {
    const gl = this.gl;
    const u = this.u.get(this.pL)!;
    gl.useProgram(this.pL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, set.w, set.h);
    if (blend) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.u_tex, 0);
    gl.uniformMatrix3fv(u.u_m, false, m);
    gl.uniform2f(u.u_doc, doc.w, doc.h);
    gl.uniform1f(u.u_opacity, opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
  }

  /** Layer placed in document space (unit square → layer box → document). */
  private static layerQuad(l: Layer): number[] {
    const m = layerMatrix(l);
    // column-major mat3 of M · diag(w, h)
    return [m[0] * l.w, m[1] * l.w, 0, m[2] * l.h, m[3] * l.h, 0, m[4], m[5], 1];
  }
  private static docQuad(d: DocState): number[] {
    return [d.w, 0, 0, 0, d.h, 0, 0, 0, 1];
  }

  /** Composites a document-space layer texture onto the accumulator with its blend mode. */
  private composite(tex: WebGLTexture, l: Layer, doc: DocState, set: TargetSet, acc: { cur: Target; other: Target }, mode = BLEND_INDEX.get(l.blend) ?? 0): void {
    if (mode === 0) {
      this.drawQuad(tex, GLRenderer.docQuad(doc), doc, acc.cur.fb, set, l.opacity, true);
      return;
    }
    const gl = this.gl;
    const u = this.u.get(this.pC)!;
    gl.useProgram(this.pC);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, acc.other.fb);
    gl.viewport(0, 0, set.w, set.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, acc.cur.tex);
    gl.uniform1i(u.u_src, 0);
    gl.uniform1i(u.u_dst, 1);
    gl.uniform1f(u.u_opacity, l.opacity);
    gl.uniform1i(u.u_mode, mode);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.activeTexture(gl.TEXTURE0);
    [acc.cur, acc.other] = [acc.other, acc.cur];
  }

  /** Reads a framebuffer as top-down RGBA. */
  private readFb(fb: WebGLFramebuffer | null, w: number, h: number): ImageData {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = new Uint8ClampedArray(w * h * 4);
    const row = w * 4;
    for (let y = 0; y < h; y++) out.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    // The canvas (final image) is premultiplied; ImageData is straight alpha.
    if (fb === null) {
      for (let i = 0; i < out.length; i += 4) {
        const a = out[i + 3];
        if (a === 255) continue;
        if (a === 0) {
          out[i] = out[i + 1] = out[i + 2] = 0;
          continue;
        }
        const k = 255 / a;
        out[i] *= k;
        out[i + 1] *= k;
        out[i + 2] *= k;
      }
    }
    return new ImageData(out, w, h);
  }

  /* ------------------------------ per-layer cache ------------------------------ */

  private cacheKey(l: Layer, ref: SourceRef, job: RenderJob): string {
    const style = styleActive(l.style) ? l.style : null;
    const light = usesGlobalLight(l.style) ? (job.doc.light?.angle ?? null) : null;
    return JSON.stringify([ref.key, ref.frame ?? null, ref.stamp ?? null, ref.noise ?? null, l.w, l.h, l.x, l.y, l.scaleX, l.scaleY, l.rotation, l.flipX, l.flipY, l.fx, style, light, job.w, job.h, job.doc.w, job.doc.h]);
  }

  /**
   * Makes sure the layer's glitched document-space texture is up to date.
   * Returns a promise when the encoder stage is running for it.
   */
  private layerCache(l: Layer, ref: SourceRef, job: RenderJob, set: TargetSet, final: boolean): { entry: CacheEntry; pending: Promise<void> | null } {
    const id = `${l.id}@${job.w}x${job.h}${final ? 'F' : ''}`;
    const key = this.cacheKey(l, ref, job);
    let e = this.caches.get(id);
    if (e && (e.w !== job.w || e.h !== job.h)) {
      if (e.side) this.freeTarget(e.side);
      for (const o of e.outer ?? []) if (!o.borrowed) this.freeTarget(o.t);
      if (e.styled) {
        if (e.styled.content) this.freeTarget(e.styled.content);
        for (const o of e.styled.outer) this.freeTarget(o.src);
      }
      this.freeTarget(e);
      this.caches.delete(id);
      e = undefined;
    }
    if (!e) {
      e = { ...this.emptyTarget(job.w, job.h), key: '', w: job.w, h: job.h, used: 0, encDone: false, encBusy: false };
      this.caches.set(id, e);
    }
    e.used = ++this.clock;
    const fx = this.frameFx(l, ref);
    // While media plays the encoder stage is skipped (it would land frames late); on pause it runs.
    const enc = ref.liveOnly ? null : encParams(fx);
    if (e.key === key && (e.encDone || !enc)) return { entry: e, pending: null };
    // Animated still preview with the encoder on: it cannot keep up with every frame, so the
    // screen holds the last encoded frame while the encoder works on the newest one (the GPU
    // result goes to a side texture). The animation never blocks or flickers to GPU-only.
    if (!final && enc && ref.noise !== undefined && e.hasEnc) {
      if (e.key === key || e.encBusy) return { entry: e, pending: null };
      e.side ??= this.emptyTarget(job.w, job.h);
      this.placeAndRun(l, ref, job, set, fx, e.side.fb, e);
      e.key = key;
      e.encDone = false;
      return { entry: e, pending: this.runLayerEncoder(id, e, enc, encSeed(fx), e.side.fb) };
    }
    if (e.key !== key) {
      this.placeAndRun(l, ref, job, set, fx, e.fb, e);
      e.key = key;
      e.encDone = false;
    }
    if (!enc) {
      if (!ref.liveOnly) e.encDone = true;
      return { entry: e, pending: null };
    }
    if (e.encBusy) return { entry: e, pending: null };
    return { entry: e, pending: this.runLayerEncoder(id, e, enc, encSeed(fx)) };
  }

  /**
   * Places the layer in document space (tmp), adds its style's inner effects, then runs its own
   * passes into `out`. Outer effects run through the same passes into the entry's outer textures.
   */
  private placeAndRun(l: Layer, ref: SourceRef, job: RenderJob, set: TargetSet, fx: GlitchState, out: WebGLFramebuffer, e: CacheEntry): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, set.tmp.fb);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawQuad(this.sourceTex(ref), GLRenderer.layerQuad(l), job.doc, set.tmp.fb, set, 1, false);
    const passes = buildGpuPasses(fx);
    const st = styleActive(l.style) ? l.style : null;
    if (!st) {
      for (const o of e.outer ?? []) if (!o.borrowed) this.freeTarget(o.t);
      e.outer = undefined;
      this.dropStyled(e);
      this.runPasses(passes, set.tmp.tex, out, set);
      return;
    }
    const sc = this.styled(l, ref, job, set, st, e);
    this.runPasses(passes, sc.content?.tex ?? set.tmp.tex, out, set);
    // Outer effects get the same glitch passes as the layer, into their own textures. Without
    // passes (a layer with no glitch, e.g. a text with a shadow) that would be a plain copy: the
    // compositor reads the style's own textures instead (borrowed, never freed from here).
    const old = (e.outer ?? []).filter((o) => !o.borrowed);
    if (!passes.length) {
      for (const o of old) this.freeTarget(o.t);
      e.outer = sc.outer.map((o) => ({ t: o.src, blend: o.blend, borrowed: true }));
      return;
    }
    for (const o of old.slice(sc.outer.length)) this.freeTarget(o.t);
    e.outer = sc.outer.map((o, i) => {
      const t = old[i]?.t ?? this.emptyTarget(e.w, e.h);
      this.runPasses(passes, o.src.tex, t.fb, set);
      return { t, blend: o.blend };
    });
  }

  private dropStyled(e: CacheEntry): void {
    if (!e.styled) return;
    if (e.styled.content) this.freeTarget(e.styled.content);
    for (const o of e.styled.outer) this.freeTarget(o.src);
    e.styled = undefined;
  }

  /** The style's result before the glitch (see CacheEntry.styled), rebuilt only when its inputs change. */
  private styled(l: Layer, ref: SourceRef, job: RenderJob, set: TargetSet, st: LayerStyle, e: CacheEntry): NonNullable<CacheEntry['styled']> {
    const light = usesGlobalLight(st) ? (job.doc.light?.angle ?? null) : null;
    const seed = l.fx?.seed ?? 0;
    const key = JSON.stringify([ref.key, ref.frame ?? null, ref.stamp ?? null, l.w, l.h, l.x, l.y, l.scaleX, l.scaleY, l.rotation, l.flipX, l.flipY, st, light, seed, job.w, job.h, job.doc.w, job.doc.h]);
    if (e.styled?.key === key) return e.styled;
    this.fxStats.builds++;
    const w = this.fxTargets(set);
    const prev = e.styled;
    // Inner effects, front to back as in the dialog's list: inner glow first, inner shadow on top.
    let content = set.tmp.tex;
    let next = w.c1;
    let inner = false;
    if (fxOn(st.innerGlow)) {
      this.buildEffect('innerGlow', st.innerGlow, job, set, w, mixSeed(seed, 0x51));
      this.mergeInner(content, w.e.tex, next, BLEND_INDEX.get(st.innerGlow.blend) ?? 0, set);
      content = next.tex;
      next = next === w.c1 ? w.c2 : w.c1;
      inner = true;
    }
    if (fxOn(st.innerShadow)) {
      this.buildEffect('innerShadow', st.innerShadow, job, set, w, mixSeed(seed, 0x52));
      this.mergeInner(content, w.e.tex, next, BLEND_INDEX.get(st.innerShadow.blend) ?? 0, set);
      content = next.tex;
      inner = true;
    }
    let keep: Target | null = null;
    if (inner) {
      keep = prev?.content ?? this.emptyTarget(e.w, e.h);
      this.runPasses([], content, keep.fb, set);
    } else if (prev?.content) this.freeTarget(prev.content);
    // Outer effects, bottom → top: drop shadow, then outer glow.
    const kinds: ('dropShadow' | 'outerGlow')[] = [];
    if (fxOn(st.dropShadow)) kinds.push('dropShadow');
    if (fxOn(st.outerGlow)) kinds.push('outerGlow');
    const olds = prev?.outer ?? [];
    for (const o of olds.slice(kinds.length)) this.freeTarget(o.src);
    const outer = kinds.map((k, i) => {
      const src = olds[i]?.src ?? this.emptyTarget(e.w, e.h);
      this.buildEffect(k, st[k], job, set, w, mixSeed(seed, k === 'dropShadow' ? 0x53 : 0x54));
      this.runPasses([], w.e.tex, src.fb, set);
      return { src, blend: BLEND_INDEX.get(st[k].blend) ?? 0 };
    });
    e.styled = { key, content: keep, outer };
    return e.styled;
  }

  private fxTargets(set: TargetSet): NonNullable<TargetSet['fx']> {
    return (set.fx ??= {
      m1: this.emptyTarget(set.w, set.h), m2: this.emptyTarget(set.w, set.h), e: this.emptyTarget(set.w, set.h),
      c1: this.emptyTarget(set.w, set.h), c2: this.emptyTarget(set.w, set.h),
    });
  }

  /** One FX_FRAG pass from `src` / `mask` into `out`. */
  private fxPass(out: WebGLFramebuffer, set: TargetSet, src: WebGLTexture, mask: WebGLTexture | null, u: (u: Record<string, WebGLUniformLocation | null>) => void): void {
    const gl = this.gl;
    const loc = this.u.get(this.pF)!;
    gl.useProgram(this.pF);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out);
    gl.viewport(0, 0, set.w, set.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mask ?? src);
    // Every sampler of the program counts for WebGL's feedback-loop check, used or not: unit 2
    // (u_fx) must never keep the effect texture this pass may be writing. mergeInner rebinds it.
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(loc.u_src, 0);
    gl.uniform1i(loc.u_mask, 1);
    gl.uniform1i(loc.u_fx, 2);
    u(loc);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Builds one effect of the style from the layer's alpha (set.tmp) into w.e (straight RGBA):
   * mask (moved / inverted) → grow (spread / choke) → blur (size) → contour, colour, noise, clip.
   * Px settings are document px × the render scale: the export at full size looks like the preview.
   */
  private buildEffect(kind: 'dropShadow' | 'innerShadow' | 'outerGlow' | 'innerGlow', f: ShadowFx | GlowFx, job: RenderJob, set: TargetSet, w: NonNullable<TargetSet['fx']>, seed: number): void {
    const gl = this.gl;
    const k = job.w / job.doc.w;
    const inner = kind === 'innerShadow' || kind === 'innerGlow';
    const shadow = kind === 'dropShadow' || kind === 'innerShadow';
    let dx = 0;
    let dy = 0;
    if (shadow) [dx, dy] = shadowOffset(effectAngle(f as ShadowFx, job.doc.light), (f as ShadowFx).distance);
    const glow = f as GlowFx;
    const { grow, blur } = maskRadii(f.size, f.spread, !shadow && glow.technique === 'precise');
    // 1. Mask: the layer's alpha (inverted for inner effects), moved away from the light.
    this.fxPass(w.m1.fb, set, this.tmpTex(set), null, (u) => {
      gl.uniform1i(u.u_op, 0);
      gl.uniform2f(u.u_offset, dx / job.doc.w, -dy / job.doc.h);
      gl.uniform1i(u.u_invert, inner ? 1 : 0);
    });
    // 2. Grow (separable max), 3. blur (separable gaussian), both ping-pong m1 ↔ m2.
    const sep = (op: number, r: number) => {
      if (r * k < 0.5) return;
      this.fxPass(w.m2.fb, set, this.tmpTex(set), w.m1.tex, (u) => {
        gl.uniform1i(u.u_op, op);
        gl.uniform2f(u.u_dir, 1, 0);
        gl.uniform1f(u.u_radius, r * k);
      });
      this.fxPass(w.m1.fb, set, this.tmpTex(set), w.m2.tex, (u) => {
        gl.uniform1i(u.u_op, op);
        gl.uniform2f(u.u_dir, 0, 1);
        gl.uniform1f(u.u_radius, r * k);
      });
    };
    sep(1, grow);
    sep(2, blur);
    // 4. Colour: contour, range, noise, opacity; clipped inside the layer or knocked out under it.
    const [r1, g1, b1] = rgb(f.color);
    const [r2, g2, b2] = rgb(shadow ? f.color : glow.color2);
    const clip = inner ? 1 : kind === 'dropShadow' && (f as { knockout?: boolean }).knockout ? 2 : 0;
    this.fxPass(w.e.fb, set, this.tmpTex(set), w.m1.tex, (u) => {
      gl.uniform1i(u.u_op, 3);
      gl.uniform3f(u.u_color, r1, g1, b1);
      gl.uniform3f(u.u_color2, r2, g2, b2);
      gl.uniform1i(u.u_gradient, !shadow && glow.fill === 'gradient' ? 1 : 0);
      gl.uniform1f(u.u_opacity, f.opacity / 100);
      gl.uniform1f(u.u_noise, f.noise / 100);
      gl.uniform1ui(u.u_seed, seed >>> 0);
      gl.uniform1i(u.u_contour, Math.max(0, CONTOURS.findIndex((c) => c[0] === f.contour)));
      gl.uniform1f(u.u_range, shadow ? 50 : glow.range);
      gl.uniform1i(u.u_clip, clip);
      gl.uniform1i(u.u_center, kind === 'innerGlow' && (f as InnerGlowFx).source === 'center' ? 1 : 0);
    });
  }

  private tmpTex(set: TargetSet): WebGLTexture {
    return set.tmp.tex;
  }

  /** An inner effect (fx) over the layer (content) with its blend mode, into `out`; keeps the layer's alpha. */
  private mergeInner(content: WebGLTexture, fx: WebGLTexture, out: Target, mode: number, set: TargetSet): void {
    const gl = this.gl;
    this.fxPass(out.fb, set, content, null, (u) => {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, fx);
      gl.uniform1i(u.u_op, 4);
      gl.uniform1i(u.u_mode, mode);
    });
  }

  /** Outer effects of a cached layer, blended onto the backdrop before the layer itself. */
  private compositeOuter(e: CacheEntry, l: Layer, doc: DocState, set: TargetSet, acc: { cur: Target; other: Target }): void {
    for (const o of e.outer ?? []) this.composite(o.t.tex, l, doc, set, acc, o.blend);
  }

  private async runLayerEncoder(id: string, e: CacheEntry, p: EncParams, seed: number, src: WebGLFramebuffer = e.fb): Promise<void> {
    const runKey = e.key;
    e.encBusy = true;
    const t0 = performance.now();
    const input = this.readFb(src, e.w, e.h);
    const out = await this.encode(input, p, seed);
    e.encBusy = false;
    if (this.caches.get(id) !== e) return;
    if (e.key !== runKey) {
      // The layer changed meanwhile: the texture already holds the newer GPU result.
      this.onAsync();
      return;
    }
    // JPEG has no alpha: keep the coverage of the GPU result.
    for (let i = 3; i < out.data.length; i += 4) out.data[i] = input.data[i];
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, e.w, e.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    e.encDone = true;
    e.hasEnc = true;
    this.encStats.n++;
    this.encStats.ms += performance.now() - t0;
    this.onAsync();
  }

  /** Layer styles rebuilt (shadows and glows recomputed), for the tests: animation frames must not rebuild them. */
  readonly fxStats = { builds: 0 };

  /** Encoder stage cost (read-back + worker + upload) over the live renders: count and total ms. */
  readonly encStats = { n: 0, ms: 0 };

  private dropCache(id: string): void {
    const e = this.caches.get(id);
    if (!e) return;
    if (e.side) this.freeTarget(e.side);
    for (const o of e.outer ?? []) if (!o.borrowed) this.freeTarget(o.t);
    if (e.styled) {
      if (e.styled.content) this.freeTarget(e.styled.content);
      for (const o of e.styled.outer) this.freeTarget(o.src);
    }
    this.freeTarget(e);
    this.caches.delete(id);
  }

  /** Frees caches of layers that are gone, then enforces the LRU budget. */
  private sweep(doc: DocState, usedNow: number): void {
    const ids = new Set(doc.layers.filter((l) => l.fx).map((l) => l.id));
    for (const id of [...this.caches.keys()]) if (!ids.has(id.split('@')[0])) this.dropCache(id);
    for (const id of this.scratch.keys()) if (!ids.has(id)) this.scratch.delete(id);
    const bytes = (e: CacheEntry) => e.w * e.h * 4 * targetsOf(e);
    let total = [...this.caches.values()].reduce((a, e) => a + bytes(e), 0);
    const lru = [...this.caches.entries()].filter(([id, e]) => e.used < usedNow && !e.encBusy && !(this.finals > 0 && id.endsWith('F'))).sort((a, b) => a[1].used - b[1].used);
    while (total > this.cacheBudget && lru.length) {
      const [id, e] = lru.shift()!;
      total -= bytes(e);
      this.dropCache(id);
    }
    // Source textures not used for a while (e.g. full-res after zooming out, old text rasters).
    for (const [k, s] of this.sources) if (this.clock - s.used > 400) this.dropSource(k);
  }

  /* ------------------------------ public API ------------------------------ */

  /**
   * Renders the document into the canvas (resized to job.w × job.h). Live mode: per-layer
   * encoders run in the background and call onAsync when done; returns at once.
   */
  render(job: RenderJob): void {
    const start = this.clock + 1;
    const set = this.targets(job.w, job.h, 'live');
    const acc = this.beginAccum(job, set);
    for (const l of job.doc.layers) {
      if (!l.visible || l.opacity <= 0) continue;
      const ref = this.provider.source(l, (job.w / job.doc.w) * Math.max(l.scaleX, l.scaleY));
      if (!ref) continue;
      if (job.layerFx && layerHasFx(l)) {
        const { entry } = this.layerCache(l, ref, job, set, false);
        this.compositeOuter(entry, l, job.doc, set, acc);
        this.composite(entry.tex, l, job.doc, set, acc);
      } else this.drawLayer(l, ref, job, set, acc);
    }
    this.finishGlobal(job, set, acc.cur);
    this.sweep(job.doc, start);
  }

  /**
   * Final quality (thumbnails, export): waits for every per-layer encoder. With `stream`,
   * each layer's textures are freed as soon as it has been composited, so peak memory does
   * not grow with the number of layers.
   */
  async renderFinal(job: RenderJob, stream = false): Promise<ImageData> {
    this.finals++;
    try {
      return await this.renderFinalInner(job, stream);
    } finally {
      this.finals--;
    }
  }

  private async renderFinalInner(job: RenderJob, stream: boolean): Promise<ImageData> {
    const start = this.clock + 1;
    const set = this.targets(job.w, job.h, 'final');
    const acc = this.beginAccum(job, set);
    for (const l of job.doc.layers) {
      if (!l.visible || l.opacity <= 0) continue;
      const live = this.provider.source(l, (job.w / job.doc.w) * Math.max(l.scaleX, l.scaleY));
      if (!live) continue;
      // Final quality (thumbnails, export, capture) always runs every stage, playing or not.
      const ref: SourceRef = { ...live, liveOnly: false };
      if (job.layerFx && layerHasFx(l)) {
        const { entry, pending } = this.layerCache(l, ref, job, set, true);
        if (pending) await pending;
        this.compositeOuter(entry, l, job.doc, set, acc);
        this.composite(entry.tex, l, job.doc, set, acc);
        if (stream) this.dropCache(`${l.id}@${job.w}x${job.h}F`);
      } else this.drawLayer(l, ref, job, set, acc);
      if (stream) this.dropSource(ref.key);
    }
    this.finishGlobal(job, set, acc.cur);
    const img = this.readFb(null, job.w, job.h);
    this.sweep(job.doc, start);
    return img;
  }

  private beginAccum(job: RenderJob, set: TargetSet): { cur: Target; other: Target } {
    const gl = this.gl;
    if (this.canvas.width !== job.w) this.canvas.width = job.w;
    if (this.canvas.height !== job.h) this.canvas.height = job.h;
    // Premultiplied accumulator: normal layers blend with SRC_ALPHA / ONE_MINUS_SRC_ALPHA,
    // which is "over" for a premultiplied backdrop (opaque backgrounds: no difference).
    const [r, g, b] = hexRgb(job.doc.bg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, set.accA.fb);
    gl.viewport(0, 0, set.w, set.h);
    if (job.doc.transparent) gl.clearColor(0, 0, 0, 0);
    else gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { cur: set.accA, other: set.accB };
  }

  private drawLayer(l: Layer, ref: SourceRef, job: RenderJob, set: TargetSet, acc: { cur: Target; other: Target }): void {
    const tex = this.sourceTex(ref);
    if ((BLEND_INDEX.get(l.blend) ?? 0) === 0) {
      this.drawQuad(tex, GLRenderer.layerQuad(l), job.doc, acc.cur.fb, set, l.opacity, true);
      return;
    }
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, set.tmp.fb);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawQuad(tex, GLRenderer.layerQuad(l), job.doc, set.tmp.fb, set, 1, false);
    this.composite(set.tmp.tex, l, job.doc, set, acc);
  }

  private finishGlobal(job: RenderJob, set: TargetSet, acc: Target): void {
    // A live render may have resized the canvas while a final render was awaiting an encoder.
    if (this.canvas.width !== job.w) this.canvas.width = job.w;
    if (this.canvas.height !== job.h) this.canvas.height = job.h;
    this.runPasses(job.global ? buildGpuPasses(job.global) : [], acc.tex, null, set);
  }

  /** Read the canvas back as top-down RGBA ImageData. */
  readPixels(): ImageData {
    return this.readFb(null, this.canvas.width, this.canvas.height);
  }

  /** GPU memory held by caches and sources (approximate, bytes). */
  get memory(): { caches: number; sources: number; work: number } {
    const caches = [...this.caches.values()].reduce((a, e) => a + e.w * e.h * 4 * targetsOf(e), 0);
    const sources = [...this.sources.values()].reduce((a, s) => a + s.bytes, 0);
    const work = [...this.sets.values()].reduce((a, s) => a + s.w * s.h * 4 * (s.fx ? 10 : 5), 0);
    return { caches, sources, work };
  }

  dispose(): void {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}

const rgb = (hex: string): [number, number, number] => hexRgb(hex);

/** Textures a cache entry holds (for the memory budget). */
function targetsOf(e: CacheEntry): number {
  return 1 + (e.side ? 1 : 0) + (e.outer?.filter((o) => !o.borrowed).length ?? 0) + (e.styled ? (e.styled.content ? 1 : 0) + e.styled.outer.length : 0);
}

function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
