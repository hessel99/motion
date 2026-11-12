// BENCHMARK-ONLY prototype of effects on top of the renderer. nothing in the app imports this;
// scripts/fx-bench.mjs loads it from the dev server. it exists to measure what effects cost and
// what the renderer needs for them (see NOTES.md, "Effect pipeline").
//
//  a) motion blur by temporal supersampling: N sub-frame renders accumulated in a float target
//  b) motion blur per instance ("velocity"): every instance gets its matrix at shutter open and
//     close; the fragment shader integrates coverage along the motion with an adaptive sample
//     count (1 for layers that don't move). one draw call, one eval extra.
//  c) separable gaussian blur of an offscreen layer (group / adjustment style), at a reduced
//     resolution if asked (downsample -> h -> v -> composite with bilinear upsample).

import type { Renderer } from './renderer';

const F = 40;

export interface Target { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }

const QUAD_VS = `#version 300 es
layout(location=0) in vec2 q;
out vec2 vUV;
void main() { vUV = q; gl_Position = vec4(q * 2.0 - 1.0, 0.0, 1.0); }`;

const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform float uScale;
in vec2 vUV;
out vec4 o;
void main() { o = texture(uSrc, vUV) * uScale; }`;

// gaussian, linear-sampling trick: pairs of taps share one bilinear fetch
const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uDir;      // texel step along the blur direction
uniform float uSigma;   // in texels of this pass
uniform int uTaps;      // fetches per side
in vec2 vUV;
out vec4 o;
void main() {
  float w0 = 1.0;
  vec4 acc = texture(uSrc, vUV);
  float norm = w0;
  float k = -0.5 / (uSigma * uSigma);
  for (int i = 0; i < 64; i++) {
    if (i >= uTaps) break;
    float a = float(2 * i + 1), b = a + 1.0;
    float wa = exp(a * a * k), wb = exp(b * b * k);
    float w = wa + wb;
    float off = (a * wa + b * wb) / w;
    acc += (texture(uSrc, vUV + uDir * off) + texture(uSrc, vUV - uDir * off)) * w;
    norm += 2.0 * w;
  }
  o = acc / norm;
}`;

// per-instance motion blur: same instance layout as the main shader + prev matrix (loc 11, 12)
const MB_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 q;
layout(location=1) in vec4 iA;
layout(location=2) in vec4 iB;
layout(location=3) in vec4 iC;
layout(location=4) in vec4 iFill;
layout(location=5) in vec4 iStroke;
layout(location=6) in vec4 iF;
layout(location=7) in vec4 iUV;
layout(location=8) in vec4 iH;
layout(location=9) in vec4 iI;
layout(location=10) in vec4 iJ;
layout(location=11) in vec4 pA;
layout(location=12) in vec2 pB;
uniform vec3 uView;
uniform vec2 uRes;
uniform float uMaxN;
out vec2 vWorld;
flat out vec4 vA; flat out vec2 vB; flat out vec4 vPA; flat out vec2 vPB;
flat out vec2 vSize; flat out vec4 vRadii; flat out vec4 vFill; flat out vec4 vStroke; flat out vec4 vF;
flat out vec4 vUVr; flat out vec4 vH; flat out vec4 vI; flat out vec2 vJ; flat out float vN; flat out vec2 vPad;
void main() {
  vec2 size = iB.zw;
  float kind = iF.w;
  vec2 pad = vec2(0.0);
  if (kind < 1.5) {
    float sw = iF.x;
    float ext = iF.y > 0.5 ? sw : (iF.y < -0.5 ? 0.0 : sw * 0.5);
    float s = min(length(iA.xy), length(iA.zw)) * uView.x;
    pad = vec2(1.5 / max(s, 1e-6) + ext);
  }
  // world aabb of the padded box at shutter open and close
  vec2 lo = vec2(1e30), hi = vec2(-1e30);
  float disp = 0.0;
  for (int c = 0; c < 4; c++) {
    vec2 l = -pad + vec2(c & 1, c >> 1) * (size + 2.0 * pad);
    vec2 w1 = mat2(iA.xy, iA.zw) * l + iB.xy;
    vec2 w0 = mat2(pA.xy, pA.zw) * l + pB;
    lo = min(lo, min(w0, w1)); hi = max(hi, max(w0, w1));
    disp = max(disp, length(w1 - w0) * uView.x);
  }
  vN = clamp(ceil(disp / 1.5), 1.0, uMaxN); // ~one sample per 1.5 device px of motion
  vec2 w = mix(lo, hi, q);
  vec2 s = w * uView.x + uView.yz;
  vec2 ndc = s / uRes * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vWorld = w;
  vA = iA; vB = iB.xy; vPA = pA; vPB = pB;
  vSize = size; vRadii = iC; vFill = iFill; vStroke = iStroke; vF = iF; vUVr = iUV; vH = iH; vI = iI; vJ = iJ.xy; vPad = pad;
}`;

const MB_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
in vec2 vWorld;
flat in vec4 vA; flat in vec2 vB; flat in vec4 vPA; flat in vec2 vPB;
flat in vec2 vSize; flat in vec4 vRadii; flat in vec4 vFill; flat in vec4 vStroke; flat in vec4 vF;
flat in vec4 vUVr; flat in vec4 vH; flat in vec4 vI; flat in vec2 vJ; flat in float vN; flat in vec2 vPad;
out vec4 o;
float sdRoundBox(vec2 p, vec2 b, vec4 r) {
  float rr = p.x > 0.0 ? (p.y > 0.0 ? r.z : r.y) : (p.y > 0.0 ? r.w : r.x);
  rr = min(rr, min(b.x, b.y));
  vec2 q = abs(p) - b + rr;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - rr;
}
float sdEllipse(vec2 p, vec2 r) {
  r = max(r, vec2(1e-4));
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}
vec4 shade(vec2 lp, float aaw) {
  float kind = vF.w;
  vec4 fill = vec4(vFill.rgb * vFill.a, vFill.a);
  vec4 stroke = vec4(vStroke.rgb * vStroke.a, vStroke.a);
  if (kind < 1.5) {
    vec2 h = vSize * 0.5;
    vec2 p = lp - h;
    float d = kind < 0.5 ? sdRoundBox(p, h, vRadii) : sdEllipse(p, h);
    float fc = clamp(0.5 - d / aaw, 0.0, 1.0);
    float sw = vF.x, sc = 0.0;
    if (sw > 0.0) {
      float inner = vF.y < -0.5 ? -sw : (vF.y > 0.5 ? 0.0 : -sw * 0.5);
      float outer = inner + sw;
      sc = clamp(0.5 - (d - outer) / aaw, 0.0, 1.0) - clamp(0.5 - (d - inner) / aaw, 0.0, 1.0);
    }
    return stroke * sc + fill * fc * (1.0 - stroke.a * sc);
  }
  vec2 uvq = lp / vSize;
  if (any(lessThan(uvq, vec2(0.0))) || any(greaterThan(uvq, vec2(1.0)))) return vec4(0.0);
  vec4 t = texture(uTex, vec3(mix(vUVr.xy, vUVr.zw, uvq), vH.x));
  if (kind < 2.5) return stroke * t.g + fill * t.r * (1.0 - stroke.a * t.g);
  return t * vFill.a;
}
void main() {
  // anti-aliasing width in local units, from the current matrix (derivatives outside the loop)
  mat2 M1 = mat2(vA.xy, vA.zw);
  vec2 l1 = inverse(M1) * (vWorld - vB);
  float aaw = max(length(vec2(dFdx(l1.x), dFdy(l1.x))), 1e-4);
  vec4 col = vec4(0.0);
  int n = int(vN);
  for (int s = 0; s < 64; s++) {
    if (s >= n) break;
    float f = n == 1 ? 1.0 : (float(s) + 0.5) / float(n);
    vec4 a = mix(vPA, vA, f);
    vec2 b = mix(vPB, vB, f);
    vec2 lp = inverse(mat2(a.xy, a.zw)) * (vWorld - b);
    col += shade(lp, aaw);
  }
  col *= vF.z / float(n);
  if (vH.z >= 0.0) {
    vec2 cp = mat2(vI.xy, vI.zw) * vWorld + vJ;
    vec2 ch = vH.zw * 0.5;
    float d = sdRoundBox(cp - ch, ch, vec4(vH.y));
    col *= clamp(0.5 - d / max(fwidth(d), 1e-4), 0.0, 1.0);
  }
  o = col;
}`;

function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
  return p;
}

export class FxProto {
  gl: WebGL2RenderingContext;
  floatOk: boolean;
  private quadVao: WebGLVertexArrayObject;
  private copyProg: WebGLProgram;
  private blurProg: WebGLProgram;
  private mbProg: WebGLProgram;
  private prevBuf: WebGLBuffer;
  private prev = new Float32Array(0);
  private prevWorld = new Float64Array(0);

  constructor(private R: Renderer) {
    const gl = (this.gl = R.gl);
    this.floatOk = !!gl.getExtension('EXT_color_buffer_float');
    this.copyProg = program(gl, QUAD_VS, COPY_FS);
    this.blurProg = program(gl, QUAD_VS, BLUR_FS);
    this.mbProg = program(gl, MB_VS, MB_FS);
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.prevBuf = gl.createBuffer()!;
  }

  target(w: number, h: number, float = false): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, float && this.floatOk ? gl.RGBA16F : gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w, h };
  }

  dispose(t: Target) { this.gl.deleteFramebuffer(t.fb); this.gl.deleteTexture(t.tex); }

  /** fullscreen pass: src texture -> dst (null = canvas) */
  private pass(prog: WebGLProgram, src: WebGLTexture, dst: Target | null, setup?: (p: WebGLProgram) => void) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
    gl.viewport(0, 0, dst ? dst.w : gl.drawingBufferWidth, dst ? dst.h : gl.drawingBufferHeight);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(gl.getUniformLocation(prog, 'uSrc'), 1);
    setup?.(prog);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  copy(src: WebGLTexture, dst: Target | null, scale = 1, blend = false) {
    const gl = this.gl;
    if (blend) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); } else gl.disable(gl.BLEND);
    this.pass(this.copyProg, src, dst, p => gl.uniform1f(gl.getUniformLocation(p, 'uScale'), scale));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** a) temporal supersampling: N renders across the shutter, averaged in a float target */
  accumulate(t: number, n: number, shutter: number, scene: Target, accum: Target) {
    const gl = this.gl, R = this.R;
    gl.bindFramebuffer(gl.FRAMEBUFFER, accum.fb);
    gl.clearColor(0, 0, 0, 0);
    gl.disable(gl.SCISSOR_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
    R.setTarget(scene);
    for (let s = 0; s < n; s++) {
      R.render(t - shutter * (1 - (s + 0.5) / n));
      this.copy(scene.tex, accum, 1 / n, true);
    }
  }

  /** b) per-instance velocity blur: evaluate at shutter open, then render at close with the
   *  motion blur program. the normal render pass is pointed at a 1x1 target (instance data only). */
  velocity(t: number, shutter: number, maxN: number, out: Target, dummy: Target) {
    const gl = this.gl, R = this.R as any;
    // matrices at shutter open
    R.evaluate(t - shutter);
    const n = R.items.length;
    if (this.prevWorld.length < n * 6) this.prevWorld = new Float64Array(n * 6);
    this.prevWorld.set(R.world.subarray(0, n * 6));
    // instance data at shutter close (normal pass drawn into a 1x1 target, culling off)
    const cull = R.cullOffscreen;
    R.cullOffscreen = false;
    R.setTarget(dummy);
    R.render(t);
    R.cullOffscreen = cull;
    const k = R.stats.instances, I: Float32Array = R.inst, IIT: Int32Array = R.instItem, W: Float64Array = R.world, PW = this.prevWorld;
    if (this.prev.length < k * 8) this.prev = new Float32Array(Math.max(k * 8, this.prev.length * 2));
    const P = this.prev;
    // prev instance matrix = (Wprev * W^-1) * instance matrix (keeps raster offsets / unit transforms)
    for (let j = 0; j < k; j++) {
      const i = IIT[j], o = i * 6, io = j * F, po = j * 8;
      const a = W[o], b = W[o + 1], c = W[o + 2], d = W[o + 3], e = W[o + 4], f = W[o + 5];
      const pa = PW[o], pb = PW[o + 1], pc = PW[o + 2], pd = PW[o + 3], pe = PW[o + 4], pf = PW[o + 5];
      const ia = I[io], ib = I[io + 1], ic = I[io + 2], id = I[io + 3], ie = I[io + 4], iff = I[io + 5];
      if (a === pa && b === pb && c === pc && d === pd && e === pe && f === pf) {
        P[po] = ia; P[po + 1] = ib; P[po + 2] = ic; P[po + 3] = id; P[po + 4] = ie; P[po + 5] = iff;
        continue;
      }
      const det = a * d - b * c || 1e-12;
      // W^-1
      const xa = d / det, xb = -b / det, xc = -c / det, xd = a / det, xe = (c * f - d * e) / det, xf = (b * e - a * f) / det;
      // D = Wprev * W^-1
      const da = pa * xa + pc * xb, db = pb * xa + pd * xb, dc = pa * xc + pc * xd, dd = pb * xc + pd * xd;
      const de = pa * xe + pc * xf + pe, df = pb * xe + pd * xf + pf;
      P[po] = da * ia + dc * ib; P[po + 1] = db * ia + dd * ib;
      P[po + 2] = da * ic + dc * id; P[po + 3] = db * ic + dd * id;
      P[po + 4] = da * ie + dc * iff + de; P[po + 5] = db * ie + dd * iff + df;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.prevBuf);
    gl.bufferData(gl.ARRAY_BUFFER, P.subarray(0, k * 8), gl.STREAM_DRAW);
    gl.bindVertexArray(R.vao);
    gl.enableVertexAttribArray(11);
    gl.vertexAttribPointer(11, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(11, 1);
    gl.enableVertexAttribArray(12);
    gl.vertexAttribPointer(12, 2, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(12, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
    gl.viewport(0, 0, out.w, out.h);
    gl.disable(gl.SCISSOR_TEST);
    const bg = R.store.comp.background;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.mbProg);
    const z = R.zoom * R.dpr;
    gl.uniform3f(gl.getUniformLocation(this.mbProg, 'uView'), z, R.panX * R.dpr, R.panY * R.dpr);
    gl.uniform2f(gl.getUniformLocation(this.mbProg, 'uRes'), out.w, out.h);
    gl.uniform1f(gl.getUniformLocation(this.mbProg, 'uMaxN'), maxN);
    gl.uniform1i(gl.getUniformLocation(this.mbProg, 'uTex'), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, R.atlas.tex);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, k);
    gl.disableVertexAttribArray(11);
    gl.disableVertexAttribArray(12);
    gl.bindVertexArray(null);
    gl.useProgram(R.prog);
  }

  /** c) separable gaussian blur of src (radius in px of src) at `scale` resolution, result in out */
  blur(src: Target, radius: number, scale: number, tmpA: Target, tmpB: Target, out: Target) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    let from = src.tex;
    if (scale < 1) { this.copy(src.tex, tmpA); from = tmpA.tex; } // bilinear downsample
    const sigma = Math.max(0.5, radius * scale / 2);
    const taps = Math.min(64, Math.ceil(sigma * 3 / 2)); // each fetch covers two texels
    const w = tmpA.w, h = tmpA.h;
    gl.disable(gl.BLEND);
    this.pass(this.blurProg, from, tmpB, p => {
      gl.uniform2f(gl.getUniformLocation(p, 'uDir'), 1 / w, 0);
      gl.uniform1f(gl.getUniformLocation(p, 'uSigma'), sigma);
      gl.uniform1i(gl.getUniformLocation(p, 'uTaps'), taps);
    });
    gl.disable(gl.BLEND);
    this.pass(this.blurProg, tmpB.tex, scale < 1 ? tmpA : out, p => {
      gl.uniform2f(gl.getUniformLocation(p, 'uDir'), 0, 1 / h);
      gl.uniform1f(gl.getUniformLocation(p, 'uSigma'), sigma);
      gl.uniform1i(gl.getUniformLocation(p, 'uTaps'), taps);
    });
    if (scale < 1) this.copy(tmpA.tex, out); // bilinear upsample
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    return taps;
  }
}
