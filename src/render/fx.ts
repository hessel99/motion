// gpu effect passes for layers with effects (drop / inner shadows, layer blur incl. progressive,
// background blur, noise, texture, glass) and for blend modes that need the backdrop.
//
// the renderer isolates such a layer (its subtree) into an offscreen target (PUSH ... FXPOP in its
// command list, like group opacity), then calls FxPipeline.run, which composites the layer with its
// effects into the parent target. layers without effects never get here: their draws stay one
// instanced call. all textures are pooled, canvas sized (or reduced by a blur's radius: ½, ¼, …)
// and every pass is scissored to the region's screen box, so cost follows the layer's screen size.
//
// conventions: textures cover the whole target, uv (0,0) = bottom-left; device px are top-left
// (renderer boxes). sigma etc. are device px. colors are premultiplied.

export interface FxShadow { color: number[]; dx: number; dy: number; sigma: number; spread: number; behind: boolean }
export interface FxBlur { sigma: number; /** progressive: from s0 at p0 to s1 at p1 (device px) */ prog?: { x0: number; y0: number; x1: number; y1: number; s0: number; s1: number } }
export interface FxNoise { mode: number; size: number; density: number; c1: number[]; c2: number[]; opacity: number; seed: number }
export interface FxRegion {
  /** device px, top-left origin: x0, y0, x1, y1 */
  box: number[];
  src: WebGLTexture;
  parentFb: WebGLFramebuffer | null;
  w: number; h: number;
  opacity: number;
  /** 0 = normal, else BLEND_SHADER index (see blend() in the shader) */
  blend: number;
  /** draws the region's shapes as coverage into the bound target (main program, coverage mode) */
  drawCoverage: (() => void) | null;
  shadows: FxShadow[];
  inner: FxShadow[];
  blur: FxBlur | null;
  bg: FxBlur | null;
  noise: FxNoise[];
  /** device px -> layer local (a, b, c, d, e, f) */
  inv: number[];
  texture: { size: number; amp: number; seed: number } | null;
  glass: { refraction: number; depth: number; light: number; angle: number; dispersion: number } | null;
}

/** shader ids of the blend modes (model BlendMode -> int) */
export const BLEND_SHADER: Record<string, number> = {
  normal: 0, multiply: 1, screen: 2, add: 3, darken: 4, lighten: 5, overlay: 6, softLight: 7, hardLight: 8, colorDodge: 9,
  colorBurn: 10, linearBurn: 11, difference: 12, exclusion: 13, hue: 14, saturation: 15, color: 16, luminosity: 17,
};

const VS = `#version 300 es
layout(location=0) in vec2 q;
out vec2 vUV;
void main() { vUV = q; gl_Position = vec4(q * 2.0 - 1.0, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 o;
uniform vec4 uBox; // uv rect of the region (x0, y0, x1, y1)
bool inBox(vec2 uv) { return uv.x >= uBox.x && uv.y >= uBox.y && uv.x <= uBox.z && uv.y <= uBox.w; }
`;

// alpha of the source, shifted (shadow offset), optionally inverted (inner shadows)
const ALPHA_FS = HEAD + `
uniform sampler2D uSrc;
uniform vec2 uOff;
uniform float uInvert;
void main() {
  vec2 p = vUV - uOff;
  float a = inBox(p) ? texture(uSrc, p).a : 0.0;
  o = vec4(uInvert > 0.5 ? 1.0 - a : a);
}`;

// separable dilate (max) / erode (min): shadow spread
const MORPH_FS = HEAD + `
uniform sampler2D uSrc;
uniform vec2 uDir;
uniform int uR;
uniform float uMin;
uniform float uOut;
float at(vec2 p) { return inBox(p) ? texture(uSrc, p).a : uOut; }
void main() {
  float m = at(vUV);
  for (int i = 1; i <= 64; i++) {
    if (i > uR) break;
    float a = at(vUV + uDir * float(i)), b = at(vUV - uDir * float(i));
    m = uMin > 0.5 ? min(m, min(a, b)) : max(m, max(a, b));
  }
  o = vec4(m);
}`;

// gaussian, linear-sampling trick (pairs of taps share one bilinear fetch)
const BLUR_FS = HEAD + `
uniform sampler2D uSrc;
uniform vec2 uDir;
uniform float uSigma;
uniform int uTaps;
uniform vec4 uOut;
vec4 at(vec2 p) { return inBox(p) ? texture(uSrc, p) : uOut; }
void main() {
  vec4 acc = at(vUV);
  float norm = 1.0;
  float k = -0.5 / max(uSigma * uSigma, 1e-4);
  for (int i = 0; i < 64; i++) {
    if (i >= uTaps) break;
    float a = float(2 * i + 1), b = a + 1.0;
    float wa = exp(a * a * k), wb = exp(b * b * k);
    float w = wa + wb;
    float off = (a * wa + b * wb) / w;
    acc += (at(vUV + uDir * off) + at(vUV - uDir * off)) * w;
    norm += 2.0 * w;
  }
  o = acc / norm;
}`;

// shadow accumulation: color * blurred alpha, knocked out under the shape unless "show behind"
const ACC_FS = HEAD + `
uniform sampler2D uA;
uniform sampler2D uCov;
uniform vec4 uColor;
uniform float uKnock;
void main() {
  float a = texture(uA, vUV).a;
  if (uKnock > 0.5) a *= 1.0 - texture(uCov, vUV).a;
  o = vec4(uColor.rgb * uColor.a, uColor.a) * a;
}`;

const COPY_FS = HEAD + `
uniform sampler2D uSrc;
void main() { o = texture(uSrc, vUV); }`;

const COMP_FS = HEAD + `
uniform sampler2D uSrc, uSh, uIn, uCov, uL0, uL1, uL2, uB0, uB1, uB2, uBack, uCovB;
uniform vec2 uRes;
uniform float uOpacity;
uniform int uBlend;
uniform int uHasSh, uHasIn, uBlurMode, uBgMode, uNoiseN, uTexOn, uGlass;
uniform vec4 uBlurP; // progressive: p0, p1 (device px)
uniform vec4 uBgP;
uniform vec4 uInvA; uniform vec2 uInvB;
uniform vec4 uN0[4]; // per noise: (mode, size, density, seed), c1, c2, (opacity, 0, 0, 0)
uniform vec4 uN1[4];
uniform vec4 uTex; // size, amp (device px), seed, 0
uniform vec4 uGl;  // refraction, depth, light, angle
uniform float uGlD;

uint hash(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x ^ v.y ^ v.z;
}
float rnd(vec2 cell, float seed, float k) {
  ivec2 c = ivec2(floor(cell));
  return float(hash(uvec3(uint(c.x + 32768), uint(c.y + 32768), uint(seed) * 7u + uint(k))) & 0xffffffu) / 16777216.0;
}
vec2 devOf(vec2 uv) { return vec2(uv.x * uRes.x, (1.0 - uv.y) * uRes.y); }
vec2 localOf(vec2 dev) { return mat2(uInvA.xy, uInvA.zw) * dev + uInvB; }
float progT(vec2 dev, vec4 p) { vec2 d = p.zw - p.xy; return clamp(dot(dev - p.xy, d) / max(dot(d, d), 1e-6), 0.0, 1.0); }
vec4 lvl3(sampler2D a, sampler2D b, sampler2D c, vec2 uv, float t) {
  return t < 0.5 ? mix(texture(a, uv), texture(b, uv), t * 2.0) : mix(texture(b, uv), texture(c, uv), t * 2.0 - 1.0);
}
vec4 noiseAt(int i, vec2 local) {
  vec4 p = i == 0 ? uN0[0] : uN1[0];
  vec4 c1 = i == 0 ? uN0[1] : uN1[1];
  vec4 c2 = i == 0 ? uN0[2] : uN1[2];
  float op = i == 0 ? uN0[3].x : uN1[3].x;
  // fitted to figma's renders: grain cells of noiseSize / 2 px, a cell gets grain with probability
  // density^2 and a random strength (1 - r / D)^2; duo picks color 1 or 2 per grain (the rest of the
  // surface stays as it was), multi uses a random color at opacity
  vec2 cell = local / max(p.y * 0.5, 0.05);
  float r = rnd(cell, p.w, 0.0);
  float D = p.z * p.z;
  if (p.x > 1.5) { // multi
    if (r >= D) return vec4(0.0);
    float t = (1.0 - r / D); t *= t;
    vec3 c = vec3(rnd(cell, p.w, 1.0), rnd(cell, p.w, 2.0), rnd(cell, p.w, 3.0));
    return vec4(c, 1.0) * op * t;
  }
  if (p.x > 0.5) { // duo
    D = min(D, 0.5);
    if (r < D) { float t = 1.0 - r / D; t *= t; return vec4(c1.rgb * c1.a, c1.a) * t; }
    if (r > 1.0 - D) { float t = 1.0 - (1.0 - r) / D; t *= t; return vec4(c2.rgb * c2.a, c2.a) * t; }
    return vec4(0.0);
  }
  if (r < D) { float t = 1.0 - r / D; t *= t; return vec4(c1.rgb * c1.a, c1.a) * t; }
  return vec4(0.0);
}

// blend modes (w3c compositing): separable B(cb, cs) and non-separable ones
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) { float l = lum(c), n = min(c.r, min(c.g, c.b)), x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c; }
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) {
  float mn = min(c.r, min(c.g, c.b)), mx = max(c.r, max(c.g, c.b));
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
// soft light: figma's renders match the "pegtop" curve far better than the w3c one (measured)
float softL(float b, float s) { return (1.0 - 2.0 * s) * b * b + 2.0 * s * b; }
float hardL(float b, float s) { return s <= 0.5 ? b * 2.0 * s : b + (2.0 * s - 1.0) - b * (2.0 * s - 1.0); }
float dodge(float b, float s) { return b <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s)); }
float burn(float b, float s) { return b >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s); }
vec3 blendFn(vec3 b, vec3 s, int m) {
  if (m == 1) return b * s;
  if (m == 2) return b + s - b * s;
  if (m == 3) return min(vec3(1.0), b + s);
  if (m == 4) return min(b, s);
  if (m == 5) return max(b, s);
  if (m == 6) return vec3(hardL(s.r, b.r), hardL(s.g, b.g), hardL(s.b, b.b));
  if (m == 7) return vec3(softL(b.r, s.r), softL(b.g, s.g), softL(b.b, s.b));
  if (m == 8) return vec3(hardL(b.r, s.r), hardL(b.g, s.g), hardL(b.b, s.b));
  if (m == 9) return vec3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
  if (m == 10) return vec3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
  if (m == 11) return max(vec3(0.0), b + s - 1.0);
  if (m == 12) return abs(b - s);
  if (m == 13) return b + s - 2.0 * b * s;
  if (m == 14) return setLum(setSat(s, sat(b)), lum(b));
  if (m == 15) return setLum(setSat(b, sat(s)), lum(b));
  if (m == 16) return setLum(s, lum(b));
  if (m == 17) return setLum(b, lum(s));
  return s;
}

void main() {
  vec2 uv = vUV;
  vec2 dev = devOf(uv);
  vec2 local = localOf(dev);
  vec2 suv = uv;
  if (uTexOn == 1) {
    // texture effect: rough edges, the layer sampled through a grain-cell displacement
    vec2 cell = local / max(uTex.x, 0.05);
    vec2 d = vec2(rnd(cell, uTex.z, 5.0), rnd(cell, uTex.z, 6.0)) - 0.5;
    suv = uv + d * 2.0 * uTex.y / uRes * vec2(1.0, -1.0);
  }
  vec4 s;
  if (uBlurMode == 0) s = texture(uSrc, suv);
  else if (uBlurMode == 1) s = texture(uL2, suv);
  else s = lvl3(uL0, uL1, uL2, suv, progT(dev, uBlurP));
  if (uHasIn == 1) { vec4 ins = texture(uIn, uv); s = ins * s.a + s * (1.0 - ins.a); }
  for (int i = 0; i < 2; i++) {
    if (i >= uNoiseN) break;
    vec4 n = noiseAt(i, local);
    s = n * s.a + s * (1.0 - n.a);
  }
  vec4 under = uHasSh == 1 ? texture(uSh, uv) : vec4(0.0);
  if (uBgMode > 0 || uGlass == 1) {
    float cov = texture(uCov, uv).a;
    vec2 buv = uv;
    vec4 hl = vec4(0.0);
    if (uGlass == 1) {
      // glass: refraction toward the inside near the edges + a light rim (best effort)
      float e = 1.0 / uRes.x;
      float cx = texture(uCovB, uv + vec2(e, 0.0)).a - texture(uCovB, uv - vec2(e, 0.0)).a;
      float cy = texture(uCovB, uv + vec2(0.0, 1.0 / uRes.y)).a - texture(uCovB, uv - vec2(0.0, 1.0 / uRes.y)).a;
      vec2 nrm = vec2(cx, cy);
      float edge = 1.0 - texture(uCovB, uv).a;
      buv = uv - nrm * uGl.x * uGl.y / uRes * 4.0;
      vec2 ld = vec2(cos(uGl.w), -sin(uGl.w));
      float rim = clamp(dot(normalize(nrm + 1e-6), ld), 0.0, 1.0) * edge * uGl.z;
      hl = vec4(vec3(rim), rim) * cov;
    }
    vec4 b = uBgMode == 2 ? lvl3(uB0, uB1, uB2, buv, progT(dev, uBgP)) : texture(uB2, buv);
    if (uGlass == 1 && uGlD > 0.0) {
      vec2 sh = (buv - uv) * uGlD;
      b.r = (uBgMode == 2 ? lvl3(uB0, uB1, uB2, buv + sh, progT(dev, uBgP)) : texture(uB2, buv + sh)).r;
    }
    under = b * cov + under * (1.0 - cov * b.a);
    under = hl + under * (1.0 - hl.a);
  }
  vec4 x = (s + under * (1.0 - s.a)) * uOpacity;
  if (uBlend > 0) {
    vec4 B = texture(uBack, uv);
    vec3 cb = B.a > 0.0 ? B.rgb / B.a : vec3(0.0), cs = x.a > 0.0 ? x.rgb / x.a : vec3(0.0);
    vec3 co = (1.0 - B.a) * x.rgb + (1.0 - x.a) * B.rgb + x.a * B.a * clamp(blendFn(cb, cs, uBlend), 0.0, 1.0);
    o = vec4(co, x.a + B.a - x.a * B.a);
  } else o = x;
}`;

interface Tgt { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }

export class FxPipeline {
  private progs = new Map<string, { p: WebGLProgram; u: Map<string, WebGLUniformLocation | null> }>();
  pool = new Map<string, Tgt>();
  private poolW = 0;
  private poolH = 0;
  private vao: WebGLVertexArrayObject;
  /** passes run in the last frame (stats) */
  passes = 0;

  constructor(private gl: WebGL2RenderingContext, qbuf: WebGLBuffer) {
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, qbuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    for (const t of this.pool.values()) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    this.pool.clear();
    for (const p of this.progs.values()) gl.deleteProgram(p.p);
    this.progs.clear();
    gl.deleteVertexArray(this.vao);
  }

  private prog(name: string, fs: string) {
    let e = this.progs.get(name);
    if (e) return e;
    const gl = this.gl;
    const sh = (type: number, src: string) => { const x = gl.createShader(type)!; gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(`fx ${name}: ${gl.getShaderInfoLog(x)}`); return x; };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'q');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`fx ${name}: ${gl.getProgramInfoLog(p)}`);
    e = { p, u: new Map() };
    this.progs.set(name, e);
    return e;
  }

  private use(name: string, fs: string) {
    const e = this.prog(name, fs);
    this.gl.useProgram(e.p);
    const gl = this.gl;
    const loc = (n: string) => { if (!e.u.has(n)) e.u.set(n, gl.getUniformLocation(e.p, n)); return e.u.get(n)!; };
    return {
      f1: (n: string, v: number) => gl.uniform1f(loc(n), v),
      i1: (n: string, v: number) => gl.uniform1i(loc(n), v),
      f2: (n: string, a: number, b: number) => gl.uniform2f(loc(n), a, b),
      f4: (n: string, a: number, b: number, c: number, d: number) => gl.uniform4f(loc(n), a, b, c, d),
      f4v: (n: string, v: Float32Array) => gl.uniform4fv(loc(n), v),
      tex: (n: string, unit: number, t: WebGLTexture | null) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(loc(n), unit); },
    };
  }

  /** pooled target (canvas size times `s`) */
  private tgt(name: string, W: number, H: number, s = 1): Tgt {
    const w = Math.max(1, Math.ceil(W * s)), h = Math.max(1, Math.ceil(H * s));
    const key = `${name}:${w}x${h}`;
    let t = this.pool.get(key);
    if (t) return t;
    const gl = this.gl;
    // the canvas was resized: every pooled target is the wrong size now
    if (this.poolW !== W || this.poolH !== H) {
      for (const v of this.pool.values()) { gl.deleteTexture(v.tex); gl.deleteFramebuffer(v.fb); }
      this.pool.clear();
      this.poolW = W; this.poolH = H;
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    t = { tex, fb, w, h };
    this.pool.set(key, t);
    return t;
  }

  private unbind(units: number) {
    const gl = this.gl;
    for (let u = 5; u < 5 + units; u++) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, null); }
    gl.activeTexture(gl.TEXTURE0);
  }

  /** bind a target, viewport + scissor to the region box at that target's scale; optionally clear */
  private bindTgt(t: Tgt, R: FxRegion, clear: boolean) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, t.w, t.h);
    const sx = t.w / R.w, sy = t.h / R.h;
    const [x0, y0, x1, y1] = R.box;
    const gx0 = Math.max(0, Math.floor(x0 * sx) - 1), gx1 = Math.min(t.w, Math.ceil(x1 * sx) + 1);
    const gy0 = Math.max(0, Math.floor((R.h - y1) * sy) - 1), gy1 = Math.min(t.h, Math.ceil((R.h - y0) * sy) + 1);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(gx0, gy0, Math.max(0, gx1 - gx0), Math.max(0, gy1 - gy0));
    if (clear) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  }

  private draw() { this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4); this.passes++; }

  private boxUV(R: FxRegion): [number, number, number, number] {
    const [x0, y0, x1, y1] = R.box;
    return [x0 / R.w, 1 - y1 / R.h, x1 / R.w, 1 - y0 / R.h];
  }

  /** scale for a blur of sigma (device px): blurs >= 4px run at ½, >= 12px at ¼, and long ones lower */
  private scaleFor(sigma: number) {
    let s = sigma < 4 ? 1 : sigma < 12 ? 0.5 : 0.25;
    while (sigma * s > 40 && s > 1 / 16) s /= 2;
    return s;
  }

  /** separable gaussian of `src` (sampled through uv) into a target named `out` at scale s */
  private blur(src: WebGLTexture, srcScale: number, R: FxRegion, sigma: number, s: number, out: string, outside: number[]): Tgt {
    const gl = this.gl;
    const a = this.tgt(out + '.h', R.w, R.h, s), b = this.tgt(out, R.w, R.h, s);
    const box = this.boxUV(R);
    const sg = sigma * s;
    const taps = Math.min(64, Math.ceil((sg * 3) / 2));
    gl.disable(gl.BLEND);
    let u = this.use('blur', BLUR_FS);
    this.bindTgt(a, R, false);
    u.tex('uSrc', 5, src); u.f4('uBox', box[0], box[1], box[2], box[3]); u.f4('uOut', outside[0], outside[1], outside[2], outside[3]);
    u.f2('uDir', 1 / a.w, 0); u.f1('uSigma', sg); u.i1('uTaps', taps);
    this.draw();
    void srcScale;
    u = this.use('blur', BLUR_FS);
    this.bindTgt(b, R, false);
    u.tex('uSrc', 5, a.tex);
    u.f2('uDir', 0, 1 / b.h);
    this.draw();
    this.unbind(1);
    return b;
  }

  /** shadow alpha: coverage shifted by the offset, spread (dilate / erode), blurred */
  private shadowAlpha(cov: WebGLTexture, R: FxRegion, sh: FxShadow, inner: boolean): WebGLTexture {
    const gl = this.gl;
    const box = this.boxUV(R);
    const s = sh.sigma > 0.5 ? this.scaleFor(sh.sigma) : 1;
    const t0 = this.tgt('sa', R.w, R.h, s);
    gl.disable(gl.BLEND);
    let u = this.use('alpha', ALPHA_FS);
    this.bindTgt(t0, R, false);
    u.tex('uSrc', 5, cov); u.f4('uBox', box[0], box[1], box[2], box[3]);
    u.f2('uOff', sh.dx / R.w, -sh.dy / R.h); u.f1('uInvert', inner ? 1 : 0);
    this.draw();
    let cur = t0;
    // spread grows the shadow (inner shadows: grows inward, i.e. dilates the inverted alpha)
    const r = Math.round(Math.abs(sh.spread) * s);
    if (r >= 1) {
      const erode = sh.spread < 0;
      const t1 = this.tgt('sm', R.w, R.h, s), t2 = this.tgt('sa', R.w, R.h, s);
      u = this.use('morph', MORPH_FS);
      this.bindTgt(t1, R, false);
      u.tex('uSrc', 5, cur.tex); u.f4('uBox', box[0], box[1], box[2], box[3]); u.f2('uDir', 1 / t1.w, 0); u.i1('uR', Math.min(64, r)); u.f1('uMin', erode ? 1 : 0); u.f1('uOut', inner ? 1 : 0);
      this.draw();
      u = this.use('morph', MORPH_FS);
      this.bindTgt(t2, R, false);
      u.tex('uSrc', 5, t1.tex); u.f2('uDir', 0, 1 / t2.h);
      this.draw();
      cur = t2;
    }
    if (sh.sigma > 0.5) cur = this.blur(cur.tex, s, R, sh.sigma, s, 'sb', inner ? [1, 1, 1, 1] : [0, 0, 0, 0]);
    this.unbind(1);
    return cur.tex;
  }

  /** layer / backdrop blur levels (plain: L2 only; progressive: three levels) */
  private blurLevels(src: WebGLTexture, R: FxRegion, b: FxBlur, name: string): WebGLTexture[] {
    if (!b.prog) {
      const t = b.sigma > 0.25 ? this.blur(src, 1, R, b.sigma, this.scaleFor(b.sigma), name + '2', [0, 0, 0, 0]).tex : src;
      return [t, t, t];
    }
    const sig = [b.prog.s0, (b.prog.s0 + b.prog.s1) / 2, b.prog.s1];
    return sig.map((sg, k) => (sg > 0.25 ? this.blur(src, 1, R, sg, this.scaleFor(sg), name + k, [0, 0, 0, 0]).tex : src));
  }

  /** composite region R (its content in R.src) with its effects into R.parentFb */
  run(R: FxRegion) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.vao);
    const box = this.boxUV(R);
    const needCov = R.shadows.length > 0 || R.inner.length > 0 || !!R.bg || !!R.glass;
    // coverage of the region's shapes (fill opacity ignored): shadow source, knock-out, backdrop clip
    let cov: WebGLTexture = R.src;
    if (needCov && R.drawCoverage) {
      const c = this.tgt('cov', R.w, R.h);
      this.bindTgt(c, R, true);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      R.drawCoverage();
      gl.bindVertexArray(this.vao);
      cov = c.tex;
    }
    // drop shadows -> one premultiplied layer under the content
    let shTex: WebGLTexture | null = null;
    if (R.shadows.length) {
      const acc = this.tgt('sh', R.w, R.h);
      for (let i = 0; i < R.shadows.length; i++) {
        const sh = R.shadows[i];
        const a = this.shadowAlpha(cov, R, sh, false);
        this.bindTgt(acc, R, i === 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        const u = this.use('acc', ACC_FS);
        u.tex('uA', 5, a); u.tex('uCov', 6, cov); u.f4('uBox', box[0], box[1], box[2], box[3]);
        u.f4('uColor', sh.color[0], sh.color[1], sh.color[2], sh.color[3] ?? 1); u.f1('uKnock', sh.behind ? 0 : 1);
        this.draw();
        this.unbind(2);
      }
      shTex = acc.tex;
    }
    // inner shadows -> one layer drawn atop the content (inside it)
    let inTex: WebGLTexture | null = null;
    if (R.inner.length) {
      const acc = this.tgt('in', R.w, R.h);
      for (let i = 0; i < R.inner.length; i++) {
        const sh = R.inner[i];
        const a = this.shadowAlpha(cov, R, sh, true);
        this.bindTgt(acc, R, i === 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        const u = this.use('acc', ACC_FS);
        u.tex('uA', 5, a); u.tex('uCov', 6, cov); u.f4('uBox', box[0], box[1], box[2], box[3]);
        u.f4('uColor', sh.color[0], sh.color[1], sh.color[2], sh.color[3] ?? 1); u.f1('uKnock', 0);
        this.draw();
        this.unbind(2);
      }
      inTex = acc.tex;
    }
    // layer blur
    const L = R.blur ? this.blurLevels(R.src, R, R.blur, 'lb') : [R.src, R.src, R.src];
    // backdrop: what is under the region in the parent target (background blur, glass, blend modes)
    let back: WebGLTexture | null = null;
    let B: WebGLTexture[] = [];
    if (R.bg || R.glass || R.blend > 0) {
      const bk = this.tgt('back', R.w, R.h);
      // blit, not copyTexSubImage2D: the canvas framebuffer has no alpha channel (alpha: false), and
      // copying RGB into an RGBA texture is an error (the backdrop came out black)
      const [x0, y0, x1, y1] = R.box;
      const gx0 = Math.max(0, Math.floor(x0)), gx1 = Math.min(R.w, Math.ceil(x1));
      const gy0 = Math.max(0, Math.floor(R.h - y1)), gy1 = Math.min(R.h, Math.ceil(R.h - y0));
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, R.parentFb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, bk.fb);
      gl.disable(gl.SCISSOR_TEST);
      if (gx1 > gx0 && gy1 > gy0) gl.blitFramebuffer(gx0, gy0, gx1, gy1, gx0, gy0, gx1, gy1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      back = bk.tex;
      if (R.bg || R.glass) B = this.blurLevels(back, R, R.bg ?? { sigma: 0 }, 'bb');
    }
    let covB: WebGLTexture | null = null;
    if (R.glass) covB = this.blur(cov, 1, R, Math.max(1, R.glass.depth / 2), this.scaleFor(R.glass.depth / 2), 'gc', [0, 0, 0, 0]).tex;

    // composite into the parent
    gl.bindFramebuffer(gl.FRAMEBUFFER, R.parentFb);
    gl.viewport(0, 0, R.w, R.h);
    const [x0, y0, x1, y1] = R.box;
    gl.enable(gl.SCISSOR_TEST);
    const gx0 = Math.max(0, Math.floor(x0)), gy0 = Math.max(0, Math.floor(R.h - y1));
    gl.scissor(gx0, gy0, Math.max(0, Math.min(R.w, Math.ceil(x1)) - gx0), Math.max(0, Math.min(R.h, Math.ceil(R.h - y0)) - gy0));
    if (R.blend > 0) gl.disable(gl.BLEND);
    else { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
    const u = this.use('comp', COMP_FS);
    u.f4('uBox', box[0], box[1], box[2], box[3]);
    u.f2('uRes', R.w, R.h);
    u.f1('uOpacity', R.opacity);
    u.i1('uBlend', R.blend);
    u.tex('uSrc', 5, R.src);
    u.tex('uSh', 6, shTex); u.i1('uHasSh', shTex ? 1 : 0);
    u.tex('uIn', 7, inTex); u.i1('uHasIn', inTex ? 1 : 0);
    u.tex('uCov', 8, cov);
    u.tex('uL0', 9, L[0]); u.tex('uL1', 10, L[1]); u.tex('uL2', 11, L[2]);
    u.i1('uBlurMode', !R.blur ? 0 : R.blur.prog ? 2 : 1);
    if (R.blur?.prog) u.f4('uBlurP', R.blur.prog.x0, R.blur.prog.y0, R.blur.prog.x1, R.blur.prog.y1);
    const bb = B.length ? B : [back, back, back];
    u.tex('uB0', 12, bb[0]); u.tex('uB1', 13, bb[1]); u.tex('uB2', 14, bb[2]);
    u.i1('uBgMode', !R.bg ? 0 : R.bg.prog ? 2 : 1);
    if (R.bg?.prog) u.f4('uBgP', R.bg.prog.x0, R.bg.prog.y0, R.bg.prog.x1, R.bg.prog.y1);
    u.tex('uBack', 15, back);
    u.tex('uCovB', 2, covB);
    u.f4('uInvA', R.inv[0], R.inv[1], R.inv[2], R.inv[3]); u.f2('uInvB', R.inv[4], R.inv[5]);
    const N = Math.min(2, R.noise.length);
    u.i1('uNoiseN', N);
    for (let i = 0; i < N; i++) {
      const n = R.noise[i];
      const v = new Float32Array([n.mode, n.size, n.density, n.seed, n.c1[0], n.c1[1], n.c1[2], n.c1[3] ?? 1, n.c2[0], n.c2[1], n.c2[2], n.c2[3] ?? 1, n.opacity, 0, 0, 0]);
      u.f4v(i === 0 ? 'uN0' : 'uN1', v);
    }
    u.i1('uTexOn', R.texture ? 1 : 0);
    if (R.texture) u.f4('uTex', R.texture.size, R.texture.amp, R.texture.seed, 0);
    u.i1('uGlass', R.glass ? 1 : 0);
    if (R.glass) { u.f4('uGl', R.glass.refraction, R.glass.depth, R.glass.light, R.glass.angle); u.f1('uGlD', R.glass.dispersion); }
    this.draw();
    // unbind everything this pass sampled (later passes may render into these textures)
    for (let unit = 2; unit <= 15; unit++) { if (unit === 3 || unit === 4) continue; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, null); }
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
}
