import { FRAG, VERT } from './shaders';
import { buildGpuPasses, type GlitchState } from '../model';

interface Target {
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
}

/**
 * WebGL2 renderer: uploads a source image once and runs the pass chain with
 * ping-pong framebuffers. The last pass is drawn to the canvas.
 */
export class GLRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly maxSize: number;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private src: WebGLTexture | null = null;
  private srcW = 0;
  private srcH = 0;
  private targets: Target[] = [];
  private tw = 0;
  private th = 0;

  constructor(canvas: HTMLCanvasElement = document.createElement('canvas')) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL2 no está disponible en este navegador.');
    this.gl = gl;
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.prog = this.link(VERT, FRAG);
    gl.useProgram(this.prog);
    for (const n of ['u_tex', 'u_pass', 'u_mode', 'u_amt', 'u_filter', 'u_p', 'u_seed', 'u_aspect']) {
      this.u[n] = gl.getUniformLocation(this.prog, n);
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  private link(vs: string, fs: string): WebGLProgram {
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
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program: ${gl.getProgramInfoLog(p)}`);
    return p;
  }

  private makeTex(w: number, h: number, data: TexImageSource | null): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (data) {
      // UNPACK_FLIP_Y is ignored for ImageBitmap in some browsers, so flip explicitly on a 2D canvas.
      const cv = new OffscreenCanvas(w, h);
      const g = cv.getContext('2d')!;
      g.translate(0, h);
      g.scale(1, -1);
      g.drawImage(data as CanvasImageSource, 0, 0, w, h);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    return t;
  }

  /** Upload the source image. Its size must already be ≤ maxSize. */
  setSource(img: TexImageSource, w: number, h: number): void {
    if (this.src) this.gl.deleteTexture(this.src);
    this.src = this.makeTex(w, h, img);
    this.srcW = w;
    this.srcH = h;
  }

  get hasSource(): boolean {
    return this.src !== null;
  }

  get sourceSize(): [number, number] {
    return [this.srcW, this.srcH];
  }

  private ensureTargets(w: number, h: number): void {
    if (this.tw === w && this.th === h && this.targets.length) return;
    const gl = this.gl;
    for (const t of this.targets) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
    }
    this.targets = [0, 1].map(() => {
      const tex = this.makeTex(w, h, null);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb };
    });
    this.tw = w;
    this.th = h;
  }

  /** Render `state` at w×h into the canvas (canvas is resized). */
  render(state: GlitchState, w: number, h: number): void {
    if (!this.src) return;
    const gl = this.gl;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.ensureTargets(w, h);
    gl.useProgram(this.prog);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.u.u_tex, 0);
    gl.uniform1f(this.u.u_aspect, w / h);

    const passes = buildGpuPasses(state);
    let input = this.src;
    let ping = 0;
    const steps = passes.length ? passes : [];
    for (let i = 0; i <= steps.length; i++) {
      const last = i === steps.length;
      const p = last ? null : steps[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, last ? null : this.targets[ping].fb);
      gl.bindTexture(gl.TEXTURE_2D, input);
      gl.uniform1i(this.u.u_pass, p ? p.pass : 9);
      gl.uniform1i(this.u.u_mode, p ? p.mode : 0);
      gl.uniform1f(this.u.u_amt, p ? p.amt : 0);
      gl.uniform1f(this.u.u_filter, p ? p.filter : 0);
      const v = p ? p.p : [0, 0, 0, 0];
      gl.uniform4f(this.u.u_p, v[0], v[1], v[2], v[3]);
      gl.uniform1ui(this.u.u_seed, p ? p.seed >>> 0 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!last) {
        input = this.targets[ping].tex;
        ping = 1 - ping;
      }
    }
  }

  /** Read the canvas back as top-down RGBA ImageData. */
  readPixels(): ImageData {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = new Uint8ClampedArray(w * h * 4);
    const row = w * 4;
    for (let y = 0; y < h; y++) out.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return new ImageData(out, w, h);
  }

  dispose(): void {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}
