/**
 * One "uber" fragment shader. Each render pass reads the previous pass's texture.
 *  pass 0: CCD short circuit (u_mode = one of the 15 pin pairs)
 *  pass 1: data bus / ADC      pass 2: frame buffer      pass 3: image processor
 *  pass 9: plain copy
 * All randomness comes from integer hashes of (u_seed, virtual line/block index), so the
 * output is deterministic and resolution-independent (lines are counted on a virtual
 * 1080-line raster, not on real pixels).
 */
export const VERT = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_tex;
uniform int u_pass;
uniform int u_mode;
uniform float u_amt;
uniform float u_filter;
uniform vec4 u_p;
uniform uint u_seed;
uniform float u_aspect;

in vec2 v_uv;
out vec4 o;

const float TAU = 6.28318530718;
const float VLINES = 1080.0;

uint hu(uint x) {
  x ^= x >> 16; x *= 0x7feb352du;
  x ^= x >> 15; x *= 0x846ca68bu;
  x ^= x >> 16; return x;
}
uint ui(float a) { return uint(int(floor(a)) + 65536); }
float h1(float a) { return float(hu(ui(a) ^ u_seed)) / 4294967295.0; }
float h2(float a, float b) { return float(hu(hu(ui(a) ^ u_seed) ^ (ui(b) * 0x27d4eb2du))) / 4294967295.0; }

// Alpha travels with the samples: every texel that feeds the output contributes its alpha,
// so displaced content keeps its coverage on transparent layers (opaque input -> alpha 1).
float g_a = 0.0;
vec3 src(vec2 uv) {
  vec4 t = texture(u_tex, fract(uv));
  g_a = max(g_a, t.a);
  return t.rgb;
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float tri(float x) { return 1.0 - abs(1.0 - mod(x, 2.0)); }

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 rgb2yiq(vec3 c) {
  return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312)));
}
vec3 yiq2rgb(vec3 c) {
  return vec3(c.x + 0.956 * c.y + 0.621 * c.z, c.x - 0.272 * c.y - 0.647 * c.z, c.x - 1.106 * c.y + 1.703 * c.z);
}
vec2 vpx() { return vec2(1.0 / (VLINES * u_aspect), 1.0 / VLINES); }

/* ------------------------------ CCD: 15 pin pairs ------------------------------ */
vec3 ccd(int m, vec2 uv, float a, float f) {
  vec3 c = src(uv);
  float yt = 1.0 - uv.y; // 0 = top line

  if (m == 0) { // SUB+RG  gain overflow + color banding
    vec3 e = c * (1.0 + a * 6.0);
    vec3 hsv = rgb2hsv(clamp(e, 0.0, 1.0));
    float bands = mix(3.0, 14.0, f);
    hsv.x = fract(floor((hsv.x + luma(e) * a) * bands) / bands);
    hsv.y = min(1.0, hsv.y * (1.0 + a * 2.0) + a * 0.2);
    vec3 banded = hsv2rgb(hsv);
    float over = smoothstep(0.9, 1.1, max(e.r, max(e.g, e.b)));
    return mix(banded, fract(e), over * min(1.0, a * 1.5));
  }
  if (m == 1) { // SUB+OD  exposure-driven RGB split
    float l = luma(c);
    float ang = f * TAU;
    vec2 dir = vec2(cos(ang) / u_aspect, sin(ang));
    float d = a * 0.07 * (0.15 + l * 1.6);
    return vec3(src(uv + dir * d).r, c.g, src(uv - dir * d).b) * (1.0 + a * 0.9);
  }
  if (m == 2) { // SUB+TG  solar phase
    float l = luma(c);
    return hsv2rgb(vec3(fract(l * (1.0 + a * 6.0) + f), 0.55 + 0.4 * min(a, 1.0), 0.2 + 0.9 * l));
  }
  if (m == 3) { // SUB+AB  mono burn / fold
    float l = luma(c) * (1.0 + a * 4.0) + (f - 0.5) * 0.8;
    float g = tri(max(l, 0.0));
    float row = floor(yt * 270.0);
    if (h2(row, 3.0) < a * 0.12) g = 1.0 - g;
    return vec3(g);
  }
  if (m == 4) { // SUB+HCLK  bright pixels drag along the line
    float stepx = a * 0.01 * (0.3 + f * 2.0);
    vec3 acc = c;
    for (int i = 1; i <= 18; i++) {
      vec3 s = src(uv - vec2(float(i) * stepx, 0.0));
      acc = max(acc, s * pow(0.9, float(i)) * (0.5 + luma(s)));
    }
    float row = floor(yt * 360.0);
    return acc * (1.0 + (h2(row, 4.0) - 0.5) * a * 1.4);
  }
  if (m == 5) { // RG+OD  split posterize
    float off = a * 0.035;
    vec3 s = vec3(src(uv + vec2(0.0, off)).r, c.g, src(uv - vec2(0.0, off)).b);
    vec3 lev = floor(mix(vec3(2.0, 3.0, 2.0), vec3(7.0, 9.0, 6.0), f));
    vec3 q = floor(s * lev + 0.5) / lev;
    float l = luma(q);
    return l + (q - l) * (1.0 + a);
  }
  if (m == 6) { // RG+TG  hue-rotated horizontal stripes
    float band = floor(yt * mix(6.0, 80.0, f));
    vec3 hsv = rgb2hsv(c);
    hsv.x = fract(hsv.x + (h2(band, 6.0) - 0.5) * 2.0 * a + a * 0.25);
    hsv.y = min(1.0, hsv.y + a * 0.6);
    vec3 r = hsv2rgb(hsv);
    if (h2(band, 66.0) < a * 0.2) r = 1.0 - r;
    return r;
  }
  if (m == 7) { // RG+AB  quantized duotone with ghost
    float l = luma(c);
    float gl = luma(src(uv + vec2(a * 0.06, 0.0)));
    float v = clamp(l * 0.8 + gl * 0.5 * a - 0.15 * a, 0.0, 1.0);
    float lev = floor(mix(5.0, 2.0, min(a, 1.0)));
    v = floor(v * lev + 0.5) / lev;
    vec3 dark = hsv2rgb(vec3(f, 0.85, 0.16));
    vec3 light = hsv2rgb(vec3(fract(f + 0.45), 0.5, 1.0));
    return mix(dark, light, v);
  }
  if (m == 8) { // RG+HCLK  block tearing
    float blk = floor(yt * mix(8.0, 72.0, f));
    if (h2(blk, 8.0) < a * 0.8) {
      float sh = (h2(blk, 81.0) - 0.5) * a * 0.6;
      vec3 s = src(uv + vec2(sh, 0.0));
      s = floor(s * 4.0) / 3.0;
      if (h2(blk, 82.0) < 0.35) s = s.brg;
      if (h2(blk, 83.0) < 0.15) s = vec3(luma(s));
      return s;
    }
    return c;
  }
  if (m == 9) { // OD+TG  NTSC-like chroma phase error
    vec3 y0 = rgb2yiq(c);
    vec3 y1 = rgb2yiq(src(uv + vec2(a * 0.02, 0.0)));
    float freq = mix(2.0, 60.0, f);
    float ang = a * TAU * sin(uv.x * freq * TAU + yt * 7.0) + a * 2.0;
    mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
    vec2 iq = R * y1.yz * (1.0 + a * 2.5);
    return yiq2rgb(vec3(y0.x, iq));
  }
  if (m == 10) { // OD+AB  channel dropout bands
    float band = floor(yt * mix(12.0, 140.0, f));
    vec3 r = c;
    if (h2(band, 10.0) < a * 0.8) {
      float k = floor(h2(band, 101.0) * 5.0);
      if (k < 1.0) r = vec3(0.0, c.g, c.b);
      else if (k < 2.0) r = vec3(c.r, 0.0, c.b);
      else if (k < 3.0) r = vec3(c.r, c.g, 0.0);
      else if (k < 4.0) r = vec3(c.r * 1.3, c.r * 0.25, c.r * 0.1);
      else r = c.gbr;
    }
    return mix(r, vec3(luma(r)), min(1.0, a * 0.35));
  }
  if (m == 11) { // OD+HCLK  per-channel line jitter
    float row = floor(yt * mix(60.0, 480.0, f));
    vec3 sh = vec3(h2(row, 111.0), h2(row, 112.0), h2(row, 113.0)) - 0.5;
    float spike = step(1.0 - a * 0.25, h2(row, 114.0)) * 4.0 + 1.0;
    sh *= a * 0.07 * spike;
    return vec3(src(uv + vec2(sh.r, 0.0)).r, src(uv + vec2(sh.g, 0.0)).g, src(uv + vec2(sh.b, 0.0)).b);
  }
  if (m == 12) { // TG+AB  only edges keep (orientation-coded) chroma
    vec2 px = vpx() * mix(1.0, 7.0, f);
    float tl = luma(src(uv + px * vec2(-1.0, 1.0)));
    float t  = luma(src(uv + px * vec2(0.0, 1.0)));
    float tr = luma(src(uv + px * vec2(1.0, 1.0)));
    float l  = luma(src(uv + px * vec2(-1.0, 0.0)));
    float r  = luma(src(uv + px * vec2(1.0, 0.0)));
    float bl = luma(src(uv + px * vec2(-1.0, -1.0)));
    float b  = luma(src(uv + px * vec2(0.0, -1.0)));
    float br = luma(src(uv + px * vec2(1.0, -1.0)));
    float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
    float gy = -bl - 2.0 * b - br + tl + 2.0 * t + tr;
    float mag = length(vec2(gx, gy));
    float hue = atan(gy, gx) / TAU + 0.5;
    vec3 fringe = hsv2rgb(vec3(fract(hue + a), 1.0, 1.0)) * mag * (1.0 + a * 5.0);
    return vec3(luma(c)) * (1.0 - min(a, 1.0) * 0.6) + fringe;
  }
  if (m == 13) { // TG+HCLK  sinusoidal line wobble
    float ph = h1(13.0) * TAU;
    float d = sin(yt * mix(1.5, 22.0, f) * TAU + ph) * a * 0.07 + sin(yt * 37.0 * TAU + ph * 2.0) * a * 0.006;
    vec3 r = vec3(src(uv + vec2(d * 1.2, 0.0)).r, src(uv + vec2(d, 0.0)).g, src(uv + vec2(d * 0.8, 0.0)).b);
    vec3 hsv = rgb2hsv(r);
    hsv.x = fract(hsv.x + d * 5.0);
    return hsv2rgb(hsv);
  }
  // m == 14  AB+HCLK  lost horizontal sync: skew, roll, mono, visible sync bar
  float dirn = h1(14.0) > 0.5 ? 1.0 : -1.0;
  float yy = fract(yt + f * 0.5 * min(a, 1.0));
  float xx = fract(uv.x + yy * a * 1.1 * dirn);
  float g = luma(src(vec2(xx, 1.0 - yy)));
  g *= smoothstep(0.0, 0.035, xx) * smoothstep(1.0, 0.985, xx);
  g += (1.0 - smoothstep(0.0, 0.005, abs(xx - 0.045))) * 0.7;
  return vec3(g * 0.88, g, g * 0.86);
}

/* ------------------------------ Data bus / ADC ------------------------------ */
vec3 busPass(vec2 uv) {
  vec3 c = src(uv);
  uvec3 v = uvec3(clamp(c, 0.0, 1.0) * 255.0 + 0.5);
  int bits = int(u_p.x + 0.5);
  uint mask = (0xFFu << uint(8 - bits)) & 0xFFu;
  v &= uvec3(mask);
  float yt = 1.0 - uv.y;
  float row = floor(yt * 180.0);
  if (u_p.y > 0.0 && h2(row, 21.0) < u_p.y * 0.7) {
    uint pat = uint(h2(row, 22.0) * 255.0);
    float seg = floor(uv.x * 24.0);
    if (h2(row * 31.0 + seg, 23.0) < 0.5 + u_p.y * 0.5) v ^= uvec3(pat, pat >> 1u, pat << 1u) & 0xFFu;
  }
  uint s = uint(u_p.z + 0.5);
  if (s > 0u) v = ((v << s) | (v >> (8u - s))) & 0xFFu;
  vec3 r = vec3(v) / 255.0;
  int sw = int(u_p.w + 0.5);
  if (sw == 1) r = r.rbg;
  else if (sw == 2) r = r.grb;
  else if (sw == 3) r = r.gbr;
  else if (sw == 4) r = r.brg;
  else if (sw == 5) r = r.bgr;
  return r;
}

/* ------------------------------ Frame buffer ------------------------------ */
vec3 bufferPass(vec2 uv) {
  float V = VLINES;
  float W = floor(VLINES * u_aspect + 0.5);
  vec2 t = vec2(uv.x, 1.0 - uv.y); // top-based
  if (u_p.y > 0.0) { // stuck lines (overflow)
    float bands = 120.0;
    float b = floor(t.y * bands);
    if (h2(b, 31.0) < u_p.y * 0.8) {
      float span = 1.0 + floor(h2(b, 32.0) * 4.0);
      t.y = (b - mod(b, span)) / bands;
    }
  }
  if (abs(u_p.x) > 0.0) { // wrong stride
    float px = floor(t.x * W);
    float py = floor(t.y * V);
    float idx = py * W + px;
    float W2 = W + u_p.x * 0.25; // quarter-pixel steps: gentle slant to multi-wrap
    float sy = floor(idx / W2);
    float sx = idx - sy * W2;
    t = vec2((sx + 0.5) / W, (sy + 0.5) / V);
  }
  vec2 s = vec2(t.x, 1.0 - t.y);
  vec3 c = src(s);
  if (u_p.z > 0.0) { // ghost reads
    vec3 e1 = src(s + vec2(u_p.z * 0.06, -u_p.z * 0.012));
    vec3 e2 = src(s + vec2(u_p.z * 0.13, -u_p.z * 0.025));
    c = 1.0 - (1.0 - c) * (1.0 - e1 * 0.55 * u_p.z) * (1.0 - e2 * 0.3 * u_p.z);
  }
  return c;
}

/* ------------------------------ Image processor ------------------------------ */
vec3 procPass(vec2 uv) {
  vec2 px = vpx();
  vec3 c = src(uv);
  if (u_p.x > 0.0) { // misaligned Bayer / demosaic
    float k = u_p.x;
    vec2 par = mod(floor(uv / px), 2.0);
    vec3 d = vec3(src(uv + vec2(px.x * 40.0 * k, 0.0)).r, c.g, src(uv - vec2(0.0, px.y * 40.0 * k)).b);
    vec3 zip = vec3(par.x * (1.0 - par.y), abs(par.x - par.y), (1.0 - par.x) * par.y);
    d *= 1.0 + (zip - 0.33) * k * 1.4;
    c = mix(c, d, min(1.0, k * 2.0));
  }
  if (u_p.y > 0.0) { // chroma bleed
    vec3 yiq = rgb2yiq(c);
    vec2 acc = vec2(0.0);
    float ws = 0.0;
    for (int i = 0; i < 12; i++) {
      float w = 1.0 - float(i) / 12.0;
      acc += rgb2yiq(src(uv - vec2(float(i) * px.x * (2.0 + 40.0 * u_p.y), 0.0))).yz * w;
      ws += w;
    }
    c = yiq2rgb(vec3(yiq.x, (acc / ws) * (1.0 + u_p.y * 0.8)));
  }
  if (u_p.z > 0.0) { // posterize
    float lev = floor(mix(24.0, 2.0, u_p.z));
    c = floor(clamp(c, 0.0, 1.0) * lev + 0.5) / lev;
  }
  if (u_p.w > 0.0) { // saturation register overflow
    float l = luma(c);
    c = l + (c - l) * (1.0 + u_p.w * 4.0);
    c = mix(clamp(c, 0.0, 1.0), fract(c), step(0.6, u_p.w) * 0.6);
  }
  return c;
}

void main() {
  vec2 uv = v_uv;
  g_a = 0.0;
  vec3 r;
  if (u_pass == 0) {
    vec3 c = src(uv);
    r = mix(c, ccd(u_mode, uv, u_amt, u_filter), clamp(u_amt * 3.0, 0.0, 1.0));
  } else if (u_pass == 1) {
    r = busPass(uv);
  } else if (u_pass == 2) {
    r = bufferPass(uv);
  } else if (u_pass == 3) {
    r = procPass(uv);
  } else {
    r = src(uv);
  }
  o = vec4(clamp(r, 0.0, 1.0), g_a);
}`;

/* ------------------------------ layer compositing ------------------------------ */

/**
 * Draws one layer as a transformed quad. u_m maps the unit square (v down, document
 * convention) to document pixels; the output is GL-oriented like every other target.
 */
export const LAYER_VERT = /* glsl */ `#version 300 es
in vec2 a_pos;
uniform mat3 u_m;
uniform vec2 u_doc;
out vec2 v_uv;
void main() {
  vec2 q = a_pos * 0.5 + 0.5;
  vec2 d = (u_m * vec3(q.x, 1.0 - q.y, 1.0)).xy;
  v_uv = q;
  gl_Position = vec4(d.x / u_doc.x * 2.0 - 1.0, 1.0 - d.y / u_doc.y * 2.0, 0.0, 1.0);
}`;

export const LAYER_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_opacity;
in vec2 v_uv;
out vec4 o;
void main() {
  vec4 c = texture(u_tex, v_uv);
  o = vec4(c.rgb, c.a * u_opacity);
}`;

/**
 * Blend modes (W3C Compositing and Blending Level 1), shared by the layer compositor (COMP_FRAG)
 * and the layer styles (FX_FRAG). blend(mode, backdrop, source) with the index of doc.ts BLENDS.
 */
const BLEND_GLSL = /* glsl */ `
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float softLight(float b, float s) {
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (d - b);
}
float dodge(float b, float s) { return b == 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s))); }
float burn(float b, float s) { return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s)); }
vec3 hardLight(vec3 b, vec3 s) {
  return mix(b * 2.0 * s, 1.0 - (1.0 - b) * (1.0 - (2.0 * s - 1.0)), step(0.5, s));
}

vec3 blend(int m, vec3 b, vec3 s) {
  if (m == 1) return b * s;                                   // multiply
  if (m == 2) return b + s - b * s;                           // screen
  if (m == 3) return hardLight(s, b);                         // overlay
  if (m == 4) return min(b, s);                               // darken
  if (m == 5) return max(b, s);                               // lighten
  if (m == 6) return vec3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
  if (m == 7) return vec3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
  if (m == 8) return hardLight(b, s);                         // hard-light
  if (m == 9) return vec3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
  if (m == 10) return abs(b - s);                             // difference
  if (m == 11) return b + s - 2.0 * b * s;                    // exclusion
  if (m == 12) return setLum(setSat(s, sat(b)), lum(b));      // hue
  if (m == 13) return setLum(setSat(b, sat(s)), lum(b));      // saturation
  if (m == 14) return setLum(s, lum(b));                      // color
  if (m == 15) return setLum(b, lum(s));                      // luminosity
  return s;
}
`;

/**
 * Non-normal blend modes (W3C Compositing and Blending Level 1) of a layer already placed
 * in document space (u_src) over the premultiplied backdrop (u_dst), which may be transparent.
 */
export const COMP_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform sampler2D u_dst;
uniform float u_opacity;
uniform int u_mode;
in vec2 v_uv;
out vec4 o;

${BLEND_GLSL}
void main() {
  vec4 s = texture(u_src, v_uv);          // layer: straight alpha
  vec4 d = texture(u_dst, v_uv);          // accumulator: premultiplied, maybe transparent
  float sa = s.a * u_opacity;
  vec3 b = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
  // W3C compositing: where the backdrop is transparent the layer shows unblended.
  vec3 cs = mix(s.rgb, clamp(blend(u_mode, b, s.rgb), 0.0, 1.0), d.a);
  o = vec4(sa * cs + (1.0 - sa) * d.rgb, sa + d.a * (1.0 - sa));
}`;


/**
 * Layer styles (layerstyle.ts). One program, one operation per pass, on the targets the renderer
 * already has (document space, GL orientation, straight alpha):
 *  op 0  mask: alpha of the layer (u_src) moved by u_offset (uv), optionally inverted → .r
 *  op 1  grow: max filter of the mask along u_dir over u_radius px (separable: spread / choke)
 *  op 2  blur: gaussian of the mask along u_dir, radius u_radius px (separable)
 *  op 3  colour: contour, range, noise, opacity and colour / gradient of the effect; clipped to
 *        the layer (inner effects) or knocked out under it (drop shadow) → straight RGBA
 *  op 4  merge: an inner effect (u_fx) over the layer (u_src) with its blend mode; keeps the
 *        layer's alpha (inner effects never paint outside the shape)
 * Noise comes from an integer hash of (pixel, seed): deterministic, never Math.random().
 */
export const FX_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_src;
uniform sampler2D u_mask;
uniform sampler2D u_fx;
uniform int u_op;
uniform vec2 u_offset;
uniform bool u_invert;
uniform vec2 u_dir;
uniform float u_radius;
uniform vec3 u_color;
uniform vec3 u_color2;
uniform bool u_gradient;
uniform float u_opacity;
uniform float u_noise;
uniform uint u_seed;
uniform int u_contour;
uniform float u_range;
uniform int u_clip;
uniform bool u_center;
uniform int u_mode;
in vec2 v_uv;
out vec4 o;
${BLEND_GLSL}
const int TAPS = 24;
const float PI = 3.14159265359;

uint hashu(uint x) {
  x ^= x >> 16; x *= 0x7feb352du;
  x ^= x >> 15; x *= 0x846ca68bu;
  x ^= x >> 16; return x;
}
float maskAt(vec2 uv) {
  // Outside the canvas the layer is empty (0), the inverted mask full (1).
  bool out_ = uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
  float a = out_ ? 0.0 : texture(u_src, uv).a;
  return u_invert ? 1.0 - a : a;
}
float contour(float t) {
  if (u_contour == 1) return smoothstep(0.0, 1.0, t);
  if (u_contour == 2) { float s = sin(PI * t); return s * s; }
  if (u_contour == 3) return 1.0 - abs(2.0 * t - 1.0);
  return t;
}

void main() {
  vec2 px = 1.0 / vec2(textureSize(u_mask, 0));
  if (u_op == 0) {
    o = vec4(maskAt(v_uv - u_offset), 0.0, 0.0, 1.0);
  } else if (u_op == 1) {
    float stepPx = max(1.0, u_radius / float(TAPS));
    float m = 0.0;
    for (int i = -TAPS; i <= TAPS; i++) {
      float t = float(i) * stepPx;
      if (abs(t) > u_radius + 0.5) continue;
      m = max(m, texture(u_mask, v_uv + u_dir * px * t).r);
    }
    o = vec4(m, 0.0, 0.0, 1.0);
  } else if (u_op == 2) {
    float sigma = max(u_radius / 2.5, 0.35);
    float stepPx = max(1.0, (u_radius * 1.2) / float(TAPS));
    float sum = 0.0;
    float wsum = 0.0;
    for (int i = -TAPS; i <= TAPS; i++) {
      float t = float(i) * stepPx;
      if (abs(t) > u_radius * 1.2 + 0.5) continue;
      float w = exp(-0.5 * t * t / (sigma * sigma));
      sum += texture(u_mask, v_uv + u_dir * px * t).r * w;
      wsum += w;
    }
    o = vec4(sum / max(wsum, 1e-6), 0.0, 0.0, 1.0);
  } else if (u_op == 3) {
    float m = clamp(texture(u_mask, v_uv).r, 0.0, 1.0);
    if (u_center) m = 1.0 - m;
    // Range: < 50 % concentrates the effect near its edge, > 50 % widens it.
    float t = pow(m, 50.0 / max(u_range, 1.0));
    float a = contour(t) * u_opacity;
    if (u_noise > 0.0) {
      uvec2 q = uvec2(gl_FragCoord.xy);
      float r = float(hashu(q.x * 0x9e3779b1u ^ hashu(q.y ^ u_seed)) >> 8) / 16777216.0;
      a *= 1.0 - u_noise * r;
    }
    float ca = texture(u_src, v_uv).a;
    if (u_clip == 1) a *= ca;
    else if (u_clip == 2) a *= 1.0 - ca;
    vec3 c = u_gradient ? mix(u_color2, u_color, t) : u_color;
    o = vec4(c, clamp(a, 0.0, 1.0));
  } else {
    vec4 c = texture(u_src, v_uv);
    vec4 f = texture(u_fx, v_uv);
    vec3 rgb = mix(c.rgb, clamp(blend(u_mode, c.rgb, f.rgb), 0.0, 1.0), f.a);
    o = vec4(rgb, c.a);
  }
}`;
