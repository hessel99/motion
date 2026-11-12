// webgl2 renderer. the whole composition is drawn with ONE instanced draw call:
//  - rects / ellipses are signed distance fields evaluated per pixel (perfect anti-aliasing,
//    animatable size / radius / stroke with zero cpu work)
//  - paths / text / images / gradients are cached rasters in a texture array atlas
//    (coverage masks get tinted in the shader, so color animation never re-rasters)
//
// per frame cpu work: evaluate animated tracks, multiply 2x3 matrices, write a Float32Array,
// one bufferSubData, one draw. static layers skip evaluation entirely.

import { Track } from '../core/evaluate';
import { TrackPool } from '../core/trackpool';
import { PROP_DEFS, type Layer, type PropKey } from '../core/model';
import type { Store, Change } from '../core/store';
import { Atlas } from './atlas';
import { rasterImage, rasterPath, rasterShapePaint, rasterText, setImageLoadedHandler, type RasterResult } from './raster';

const F = 40; // floats per instance
const KIND_RECT = 0, KIND_ELLIPSE = 1, KIND_MASK = 2, KIND_RGBA = 3, KIND_NONE = 4;

const VS = `#version 300 es
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
uniform vec3 uView;
uniform vec2 uRes;
out vec2 vLocal;
out vec2 vWorld;
out vec2 vUV;
flat out vec2 vSize;
flat out vec4 vRadii;
flat out vec4 vFill;
flat out vec4 vStroke;
flat out vec4 vF;
flat out vec4 vH;
flat out vec4 vI;
flat out vec2 vJ;
void main() {
  vec2 size = iB.zw;
  float kind = iF.w;
  vec2 lp;
  if (kind >= 1.5) {
    lp = q * size;
    vUV = mix(iUV.xy, iUV.zw, q);
  } else {
    float sx = length(iA.xy) * uView.x;
    float sy = length(iA.zw) * uView.x;
    vec2 aa = vec2(1.5) / max(vec2(sx, sy), vec2(1e-6));
    float sw = iF.x;
    float ext = iF.y > 0.5 ? sw : (iF.y < -0.5 ? 0.0 : sw * 0.5);
    vec2 pad = aa + vec2(ext);
    lp = -pad + q * (size + 2.0 * pad);
    vUV = vec2(0.0);
  }
  vec2 w = mat2(iA.xy, iA.zw) * lp + iB.xy;
  vec2 s = w * uView.x + uView.yz;
  vec2 ndc = s / uRes * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vLocal = lp;
  vWorld = w;
  vSize = size;
  vRadii = iC;
  vFill = iFill;
  vStroke = iStroke;
  vF = iF;
  vH = iH;
  vI = iI;
  vJ = iJ.xy;
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
in vec2 vLocal;
in vec2 vWorld;
in vec2 vUV;
flat in vec2 vSize;
flat in vec4 vRadii;
flat in vec4 vFill;
flat in vec4 vStroke;
flat in vec4 vF;
flat in vec4 vH;
flat in vec4 vI;
flat in vec2 vJ;
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
float cov(float d) {
  float w = max(fwidth(d), 1e-4);
  return clamp(0.5 - d / w, 0.0, 1.0);
}
void main() {
  float kind = vF.w;
  float opacity = vF.z;
  vec4 fill = vec4(vFill.rgb * vFill.a, vFill.a);
  vec4 stroke = vec4(vStroke.rgb * vStroke.a, vStroke.a);
  vec4 col;
  if (kind < 1.5) {
    vec2 h = vSize * 0.5;
    vec2 p = vLocal - h;
    float d = kind < 0.5 ? sdRoundBox(p, h, vRadii) : sdEllipse(p, h);
    float w = max(fwidth(d), 1e-4);
    float fc = clamp(0.5 - d / w, 0.0, 1.0);
    float sw = vF.x;
    float sc = 0.0;
    if (sw > 0.0) {
      float inner = vF.y < -0.5 ? -sw : (vF.y > 0.5 ? 0.0 : -sw * 0.5);
      float outer = inner + sw;
      sc = clamp(0.5 - (d - outer) / w, 0.0, 1.0) - clamp(0.5 - (d - inner) / w, 0.0, 1.0);
    }
    col = stroke * sc + fill * fc * (1.0 - stroke.a * sc);
  } else {
    vec4 t = texture(uTex, vec3(vUV, vH.x));
    if (kind < 2.5) {
      col = stroke * t.g + fill * t.r * (1.0 - stroke.a * t.g);
    } else {
      col = t * vFill.a;
    }
  }
  col *= opacity;
  if (vH.z >= 0.0) {
    vec2 cp = mat2(vI.xy, vI.zw) * vWorld + vJ;
    vec2 ch = vH.zw * 0.5;
    col *= cov(sdRoundBox(cp - ch, ch, vec4(vH.y)));
  }
  o = col;
}`;

interface Item {
  id: string;
  layer: Layer;
  parent: number;
  clip: number; // index of nearest clipping ancestor
  kind: number;
  tracks: Track[]; // indexed by TR_* constants
  animated: boolean;
  /** bitmask of animated tracks (bit = TR_* index) */
  animMask: number;
  /** track pool handles for animated tracks (indexed by TR_*) */
  h: Int32Array;
  hidden: boolean; // visible=false (self or ancestor)
  rasterBase: string | null;
  rasterKey: string | null; // last resolved atlas key
  raster: RasterResult | null; // placement of last raster
  rasterScale: number; // bucket scale of the current raster
  rasterGen: number; // atlas generation the raster belongs to
  entry: import('./atlas').AtlasEntry | null;
}

const TR_KEYS: PropKey[] = ['anchor', 'position', 'scale', 'rotation', 'opacity', 'size', 'radius', 'fill', 'stroke', 'strokeWidth'];
const TR_ANCHOR = 0, TR_POS = 1, TR_SCALE = 2, TR_ROT = 3, TR_OPA = 4, TR_SIZE = 5, TR_RAD = 6, TR_FILL = 7, TR_STROKE = 8, TR_SW = 9;
const ST = 15; // style floats per item: size2 radius4 fill4 stroke4 sw1

const defaultTracks = new Map<PropKey, Track>();
function defaultTrack(k: PropKey) {
  let t = defaultTracks.get(k);
  if (!t) {
    const def = PROP_DEFS[k];
    t = new Track({ v: (def.default as unknown as number[]).slice() }, def.dim);
    if (k === 'fill') t = new Track({ v: [0, 0, 0, 0] }, 4);
    defaultTracks.set(k, t);
  }
  return t;
}

const objIds = new WeakMap<object, number>();
let nextObjId = 1;
function oid(o: object | undefined) {
  if (!o) return 0;
  let id = objIds.get(o);
  if (!id) objIds.set(o, (id = nextObjId++));
  return id;
}

export interface RenderStats {
  instances: number;
  layers: number;
  evalMs: number;
  writeMs: number;
  rasterMs: number;
  gpuSubmitMs: number;
  frameMs: number;
  atlasEntries: number;
  atlasPages: number;
  drawCalls: number;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private ibuf: WebGLBuffer;
  private icap = 0;
  private inst = new Float32Array(0);
  private uView: WebGLUniformLocation;
  private uRes: WebGLUniformLocation;
  atlas: Atlas;

  items: Item[] = [];
  index = new Map<string, number>();
  /** per item world matrix (2x3), comp space */
  world = new Float64Array(0);
  local = new Float64Array(0);
  opa = new Float64Array(0);
  /** local (own) opacity 0..1 */
  lopa = new Float64Array(0);
  /** per item cached transform components: anchor2 pos2 scale2 rot(rad) pad */
  private xf = new Float64Array(0);
  private pool = new TrackPool();
  style = new Float64Array(0);
  /** items that were drawn last frame (for hit testing) */
  drawnMask = new Uint8Array(0);

  // view: device px per comp px, pan in device px
  zoom = 1;
  panX = 0;
  panY = 0;
  dpr = 1;
  cssW = 1;
  cssH = 1;
  editorBg: [number, number, number] = [0.1, 0.1, 0.11];
  clipToComp = true;

  private needsCompile = true;
  private dirtyLayers = new Set<string>();
  dirty = true;
  stats: RenderStats = { instances: 0, layers: 0, evalMs: 0, writeMs: 0, rasterMs: 0, gpuSubmitMs: 0, frameMs: 0, atlasEntries: 0, atlasPages: 0, drawCalls: 0 };
  private rasterBudgetMs = 6;
  private pendingUpgrade = false;
  lastTime = -1;

  constructor(private store: Store, canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('webgl2 not available');
    this.gl = gl;
    this.prog = this.buildProgram();
    this.uView = gl.getUniformLocation(this.prog, 'uView')!;
    this.uRes = gl.getUniformLocation(this.prog, 'uRes')!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.ibuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    for (let k = 0; k < 10; k++) {
      gl.enableVertexAttribArray(1 + k);
      gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, F * 4, k * 16);
      gl.vertexAttribDivisor(1 + k, 1);
    }
    gl.bindVertexArray(null);
    this.atlas = new Atlas(gl);
    gl.useProgram(this.prog);
    gl.uniform1i(gl.getUniformLocation(this.prog, 'uTex'), 0);

    store.onChange(c => this.onChange(c));
    setImageLoadedHandler(() => { for (const it of this.items) if (it.layer.type === 'image') { it.rasterKey = null; it.entry = null; } this.dirty = true; });
    this.canvas.addEventListener('webglcontextlost', e => e.preventDefault());
  }

  private buildProgram() {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    return p;
  }

  private onChange(c: Change) {
    if (c.structure || c.comp) this.needsCompile = true;
    else for (const id of c.layers) this.dirtyLayers.add(id);
    this.dirty = true;
  }

  invalidate() { this.dirty = true; }

  // ---------------- compile ----------------

  private compile() {
    const store = this.store;
    const order = store.drawOrder();
    const L = store.project.layers;
    const n = order.length;
    this.pool.reset();
    this.items = new Array(n);
    this.index.clear();
    for (let i = 0; i < n; i++) this.index.set(order[i], i);
    if (this.world.length < n * 6) {
      const cap = Math.max(64, n * 2);
      this.world = new Float64Array(cap * 6);
      this.local = new Float64Array(cap * 6);
      this.opa = new Float64Array(cap);
      this.lopa = new Float64Array(cap);
      this.style = new Float64Array(cap * ST);
      this.xf = new Float64Array(cap * 8);
      this.drawnMask = new Uint8Array(cap);
    }
    for (let i = 0; i < n; i++) {
      const layer = L[order[i]];
      const parent = layer.parent ? this.index.get(layer.parent) ?? -1 : -1;
      const it: Item = {
        id: layer.id, layer, parent, clip: -1, kind: KIND_NONE, tracks: [], animated: false, animMask: 0, h: new Int32Array(10),
        hidden: !layer.visible || (parent >= 0 && this.items[parent].hidden),
        rasterBase: null, rasterKey: null, raster: null, rasterScale: 0, rasterGen: -1, entry: null,
      };
      if (parent >= 0) {
        const p = this.items[parent];
        it.clip = p.layer.clip ? parent : p.clip;
      }
      this.items[i] = it;
      this.compileItem(i);
    }
    this.needsCompile = false;
    this.dirtyLayers.clear();
    this.poolLive = this.pool.used;
  }
  private poolLive = 0;

  private compileItem(i: number) {
    const it = this.items[i];
    const l = it.layer;
    let mask = 0;
    for (let k = 0; k < TR_KEYS.length; k++) {
      const key = TR_KEYS[k];
      const p = l.props[key];
      const tr = p ? new Track(p, PROP_DEFS[key].dim, key === 'position') : defaultTrack(key);
      it.tracks[k] = tr;
      if (tr.animated) { mask |= 1 << k; it.h[k] = this.pool.add(p!, PROP_DEFS[key].dim, key === 'position'); }
    }
    it.animMask = mask;
    it.animated = mask !== 0;
    const complex = !!l.paints?.some(p => p.type !== 'solid');
    switch (l.type) {
      case 'rect': case 'group': it.kind = complex ? KIND_RGBA : KIND_RECT; break;
      case 'ellipse': it.kind = complex ? KIND_RGBA : KIND_ELLIPSE; break;
      case 'path': it.kind = complex ? KIND_RGBA : KIND_MASK; break;
      case 'text': it.kind = KIND_MASK; break;
      case 'image': it.kind = KIND_RGBA; break;
    }
    it.rasterBase = this.rasterBase(l, complex);
    it.rasterKey = null;
    it.entry = null;
    this.evalItem(i, 0, true);
  }

  private rasterBase(l: Layer, complex: boolean): string | null {
    switch (l.type) {
      case 'path': return `p${oid(l.geometry)}:${oid(l.strokeGeometry)}:${oid(l.paints)}:${l.strokeAlign}:${l.props.strokeWidth?.v[0] ?? 0}:${complex ? oid(l.props.stroke) : ''}`;
      case 'text': {
        const t = l.text!;
        const s = l.props.size?.v ?? [0, 0];
        return `t${t.content}|${t.fontFamily}|${t.fontWeight}|${t.fontStyle}|${t.fontSize}|${t.lineHeight}|${t.letterSpacing}|${t.align}|${Math.round(s[0])}x${Math.round(s[1])}`;
      }
      case 'image': return `i${l.imageRef}`;
      default:
        if (!complex) return null;
        return `g${oid(l.paints)}:${oid(l.props.size)}:${oid(l.props.radius)}:${oid(l.props.stroke)}:${l.props.strokeWidth?.v[0] ?? 0}`;
    }
  }

  // ---------------- evaluation ----------------

  private scratch = new Float64Array(8);

  /** evaluate local transform + style of item i at time t (static items only once).
   *  cached transform components let us skip static tracks entirely. */
  private evalItem(i: number, t: number, force = false) {
    const it = this.items[i];
    const X = this.xf, o8 = i * 8, os = i * ST, S = this.style;
    if (force) {
      // compile time: evaluate everything once with the track objects (static values)
      const tr = it.tracks;
      tr[TR_ANCHOR].eval(t, X, o8);
      tr[TR_POS].eval(t, X, o8 + 2);
      tr[TR_SCALE].eval(t, X, o8 + 4);
      X[o8 + 6] = tr[TR_ROT].eval1(t) * (Math.PI / 180);
      this.lopa[i] = Math.min(1, Math.max(0, tr[TR_OPA].eval1(t) / 100));
      tr[TR_SIZE].eval(t, S, os);
      tr[TR_RAD].eval(t, S, os + 2);
      tr[TR_FILL].eval(t, S, os + 6);
      tr[TR_STROKE].eval(t, S, os + 10);
      tr[TR_SW].eval(t, S, os + 14);
      this.composeLocal(i);
      return;
    }
    const m = it.animMask;
    if (!m) return;
    const h = it.h, P = this.pool;
    if (m & 0x0f) {
      if (m & (1 << TR_ANCHOR)) P.eval(h[TR_ANCHOR], t, X, o8);
      if (m & (1 << TR_POS)) P.eval(h[TR_POS], t, X, o8 + 2);
      if (m & (1 << TR_SCALE)) P.eval(h[TR_SCALE], t, X, o8 + 4);
      if (m & (1 << TR_ROT)) { P.eval(h[TR_ROT], t, X, o8 + 6); X[o8 + 6] *= Math.PI / 180; }
      this.composeLocal(i);
    }
    if (m & (1 << TR_OPA)) { P.eval(h[TR_OPA], t, X, o8 + 7); this.lopa[i] = Math.min(1, Math.max(0, X[o8 + 7] / 100)); }
    if (m & (1 << TR_SIZE)) P.eval(h[TR_SIZE], t, S, os);
    if (m & (1 << TR_RAD)) P.eval(h[TR_RAD], t, S, os + 2);
    if (m & (1 << TR_FILL)) P.eval(h[TR_FILL], t, S, os + 6);
    if (m & (1 << TR_STROKE)) P.eval(h[TR_STROKE], t, S, os + 10);
    if (m & (1 << TR_SW)) P.eval(h[TR_SW], t, S, os + 14);
  }

  /** local matrix = T(pos) R S T(-anchor) from cached components */
  private composeLocal(i: number) {
    const X = this.xf, o8 = i * 8;
    const ax = X[o8], ay = X[o8 + 1], px = X[o8 + 2], py = X[o8 + 3];
    const sx = X[o8 + 4] / 100, sy = X[o8 + 5] / 100, rot = X[o8 + 6];
    const cs = rot === 0 ? 1 : Math.cos(rot), sn = rot === 0 ? 0 : Math.sin(rot);
    const a = cs * sx, b = sn * sx, c = -sn * sy, d = cs * sy;
    const L = this.local, o6 = i * 6;
    L[o6] = a; L[o6 + 1] = b; L[o6 + 2] = c; L[o6 + 3] = d;
    L[o6 + 4] = px - (a * ax + c * ay);
    L[o6 + 5] = py - (b * ax + d * ay);
  }

  /** compute world matrices and opacities for all items at time t */
  evaluate(t: number) {
    const items = this.items, n = items.length, W = this.world, L = this.local, O = this.opa, LO = this.lopa;
    for (let i = 0; i < n; i++) {
      const it = items[i];
      if (it.animated) this.evalItem(i, t);
      const o = i * 6;
      const p = it.parent;
      const l = it.layer;
      const vis = it.hidden || t < l.inPoint || t >= l.outPoint ? 0 : 1;
      if (p < 0) {
        W[o] = L[o]; W[o + 1] = L[o + 1]; W[o + 2] = L[o + 2]; W[o + 3] = L[o + 3]; W[o + 4] = L[o + 4]; W[o + 5] = L[o + 5];
        O[i] = LO[i] * vis;
      } else {
        const q = p * 6;
        const pa = W[q], pb = W[q + 1], pc = W[q + 2], pd = W[q + 3], pe = W[q + 4], pf = W[q + 5];
        const a = L[o], b = L[o + 1], c = L[o + 2], d = L[o + 3], e = L[o + 4], f = L[o + 5];
        W[o] = pa * a + pc * b;
        W[o + 1] = pb * a + pd * b;
        W[o + 2] = pa * c + pc * d;
        W[o + 3] = pb * c + pd * d;
        W[o + 4] = pa * e + pc * f + pe;
        W[o + 5] = pb * e + pd * f + pf;
        O[i] = LO[i] * O[p] * vis;
      }
    }
  }

  // ---------------- raster resolution ----------------

  private resolveRaster(i: number, scale: number, budgetEnd: number): boolean {
    const it = this.items[i];
    const l = it.layer;
    // fast path (no allocation): current raster is sharp enough and not wastefully large.
    // the 1x..2.83x window is hysteresis so animated scale doesn't thrash re-rasters.
    if (it.entry && !it.entry.dead && it.rasterScale >= scale * 0.999 && it.rasterScale <= scale * 2.83) {
      it.entry.lastUsed = this.atlas.frame;
      return true;
    }
    const bucket = Math.min(16, Math.max(1 / 16, Math.pow(2, Math.ceil(Math.log2(Math.max(scale, 1e-3)) * 2) / 2)));
    const key = `${it.rasterBase}@${bucket}`;
    const hit = this.atlas.get(key);
    if (hit && this.rasterMeta.has(key)) {
      it.rasterKey = key;
      it.raster = this.rasterMeta.get(key)!;
      it.entry = hit; it.rasterScale = bucket; it.rasterGen = this.atlas.generation;
      return true;
    }
    // shrinking but the current raster is still sharp: keep it (a smaller one is only nicer, not needed)
    if (it.entry && !it.entry.dead && it.rasterScale >= scale && performance.now() > budgetEnd) { this.pendingUpgrade = true; return true; }
    // have an older resolution? keep it and upgrade when time allows
    const hasOld = !!it.entry && !it.entry.dead;
    // never block a frame for long on first-time rasters (cold start / after eviction): pop in next frame
    if (!hasOld && performance.now() > budgetEnd + 24) { this.pendingUpgrade = true; return false; }
    if (hasOld && performance.now() > budgetEnd) { this.pendingUpgrade = true; return true; }
    const S = this.style, os = i * ST;
    let r: RasterResult | null = null;
    const size = [S[os], S[os + 1]];
    if (l.type === 'path') r = rasterPath(l, bucket, S[os + 14]);
    else if (l.type === 'text') r = rasterText(l, bucket, size);
    else if (l.type === 'image') {
      const asset = l.imageRef ? this.store.project.assets[l.imageRef] : undefined;
      r = asset ? rasterImage(asset, bucket, size) : null;
    } else r = rasterShapePaint(l, bucket, size, [S[os + 2], S[os + 3], S[os + 4], S[os + 5]], S[os + 14]);
    if (!r) return !!hasOld;
    const e = this.atlas.alloc(key, r.pw, r.ph);
    if (!e) return !!hasOld;
    if (this.atlasGen !== this.atlas.generation) {
      this.rasterMeta.clear();
      this.atlasGen = this.atlas.generation;
      for (const x of this.items) { x.rasterKey = null; x.entry = null; }
    }
    this.atlas.upload(e, r.data);
    r.data = undefined as any; // free memory, keep placement
    this.rasterMeta.set(key, r);
    it.rasterKey = key;
    it.raster = r;
    it.entry = e; it.rasterScale = bucket; it.rasterGen = this.atlas.generation;
    return true;
  }
  private rasterMeta = new Map<string, RasterResult>();
  private atlasGen = 0;

  // ---------------- frame ----------------

  resize(cssW: number, cssH: number, dpr: number) {
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dirty = true;
  }

  /** css px view transform setters */
  setView(zoom: number, panX: number, panY: number) {
    if (zoom === this.zoom && panX === this.panX && panY === this.panY) return;
    this.zoom = zoom; this.panX = panX; this.panY = panY;
    this.dirty = true;
  }

  get hasAnimation() { return this.items.some(i => i.animated); }

  render(t: number, retry = false) {
    const f0 = performance.now();
    const compactions0 = this.atlas.compactions + this.atlas.generation;
    const store = this.store;
    if (this.needsCompile) this.compile();
    if (this.dirtyLayers.size) {
      // incremental recompiles append to the pool; repack when it has grown a lot
      if (this.pool.used > 1_000_000 && this.pool.used > this.poolLive * 3) this.needsCompile = true;
      if (this.needsCompile) { this.compile(); }
      for (const id of this.dirtyLayers) {
        const i = this.index.get(id);
        if (i !== undefined) { this.items[i].layer = store.project.layers[id]; this.compileItem(i); }
      }
      this.dirtyLayers.clear();
    }
    this.atlas.frame++;
    const e0 = performance.now();
    this.evaluate(t);
    const e1 = performance.now();

    const items = this.items, n = items.length;
    const need = (n + 1) * F;
    if (this.inst.length < need) this.inst = new Float32Array(Math.max(need, this.inst.length * 2));
    const I = this.inst, W = this.world, S = this.style, O = this.opa;
    const comp = store.comp;
    const z = this.zoom * this.dpr;
    let rasterMs = 0;
    const budgetEnd = performance.now() + this.rasterBudgetMs;
    this.pendingUpgrade = false;

    // composition background is a scissored clear (no fragment shader work)
    let k = 0;
    const mask = this.drawnMask;
    for (let i = 0; i < n; i++) {
      const it = items[i];
      mask[i] = 0;
      const l = it.layer;
      if (it.kind === KIND_NONE || O[i] <= 0.0005) continue;
      const os = i * ST, o6 = i * 6;
      if (it.kind === KIND_RECT || it.kind === KIND_ELLIPSE) {
        if (S[os + 9] <= 0 && (S[os + 14] <= 0 || S[os + 13] <= 0)) continue;
      }
      let a = W[o6], b = W[o6 + 1], c = W[o6 + 2], d = W[o6 + 3], e = W[o6 + 4], f = W[o6 + 5];
      let w = S[os], h = S[os + 1];
      let u0 = 0, v0 = 0, u1 = 0, v1 = 0, page = 0;
      if (it.kind >= KIND_MASK) {
        // raster space -> local box: paths scale geometry space by size/geomSize
        let gx = 1, gy = 1;
        if (l.type === 'path' && l.geomSize) {
          gx = l.geomSize[0] ? w / l.geomSize[0] : 1;
          gy = l.geomSize[1] ? h / l.geomSize[1] : 1;
        }
        const scale = Math.sqrt(Math.abs(a * d - b * c) * Math.abs(gx * gy)) * z;
        const r0 = performance.now();
        const ok = this.resolveRaster(i, scale, budgetEnd);
        rasterMs += performance.now() - r0;
        if (!ok || !it.raster || !it.entry || it.entry.dead) continue;
        const ent = it.entry;
        const r = it.raster;
        // matrix = W * S(gx,gy) * T(r.x, r.y)
        a *= gx; b *= gx; c *= gy; d *= gy;
        e += a * r.x + c * r.y;
        f += b * r.x + d * r.y;
        w = r.w; h = r.h;
        u0 = ent.x / 2048; v0 = ent.y / 2048; u1 = (ent.x + r.pw) / 2048; v1 = (ent.y + r.ph) / 2048;
        page = ent.page;
      }
      const o = k * F;
      I[o] = a; I[o + 1] = b; I[o + 2] = c; I[o + 3] = d;
      I[o + 4] = e; I[o + 5] = f; I[o + 6] = w; I[o + 7] = h;
      I[o + 8] = S[os + 2]; I[o + 9] = S[os + 3]; I[o + 10] = S[os + 4]; I[o + 11] = S[os + 5];
      if (it.kind === KIND_RGBA) { I[o + 12] = 1; I[o + 13] = 1; I[o + 14] = 1; I[o + 15] = 1; }
      else { I[o + 12] = S[os + 6]; I[o + 13] = S[os + 7]; I[o + 14] = S[os + 8]; I[o + 15] = S[os + 9]; }
      I[o + 16] = S[os + 10]; I[o + 17] = S[os + 11]; I[o + 18] = S[os + 12]; I[o + 19] = S[os + 13];
      I[o + 20] = it.kind === KIND_MASK ? 0 : S[os + 14];
      I[o + 21] = l.strokeAlign === 'inside' ? -1 : l.strokeAlign === 'outside' ? 1 : 0;
      I[o + 22] = O[i];
      I[o + 23] = it.kind;
      I[o + 24] = u0; I[o + 25] = v0; I[o + 26] = u1; I[o + 27] = v1;
      I[o + 28] = page;
      if (it.clip >= 0) {
        const ci = it.clip, q = ci * 6, cs = ci * ST;
        const ca = W[q], cb = W[q + 1], cc = W[q + 2], cd = W[q + 3], ce = W[q + 4], cf = W[q + 5];
        const det = ca * cd - cb * cc || 1e-12;
        const ia = cd / det, ib = -cb / det, ic = -cc / det, id = ca / det;
        I[o + 29] = S[cs + 2];
        I[o + 30] = S[cs];
        I[o + 31] = S[cs + 1];
        I[o + 32] = ia; I[o + 33] = ib; I[o + 34] = ic; I[o + 35] = id;
        I[o + 36] = -(ia * ce + ic * cf);
        I[o + 37] = -(ib * ce + id * cf);
      } else {
        I[o + 29] = 0; I[o + 30] = -1; I[o + 31] = -1;
      }
      mask[i] = 1;
      k++;
    }
    const w1 = performance.now();
    // atlas was repacked while writing instances: earlier uvs are stale, redo the frame once
    if (!retry && this.atlas.compactions + this.atlas.generation !== compactions0) { this.render(t, true); return; }

    // ---- gpu ----
    const gl = this.gl;
    this.atlas.flush(); // all raster uploads of this frame: at most one call per atlas page
    const cw = this.canvas.width, ch = this.canvas.height;
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(this.editorBg[0], this.editorBg[1], this.editorBg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    {
      const x0 = this.panX * this.dpr, y0 = this.panY * this.dpr;
      const x1 = x0 + comp.width * z, y1 = y0 + comp.height * z;
      const sx = Math.max(0, Math.round(x0)), sy = Math.max(0, Math.round(ch - y1));
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(sx, sy, Math.max(0, Math.round(Math.min(cw, x1)) - sx), Math.max(0, Math.round(Math.min(ch, ch - y0)) - sy));
      const bg = comp.background;
      gl.clearColor(bg[0] * bg[3] + this.editorBg[0] * (1 - bg[3]), bg[1] * bg[3] + this.editorBg[1] * (1 - bg[3]), bg[2] * bg[3] + this.editorBg[2] * (1 - bg[3]), 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!this.clipToComp) gl.disable(gl.SCISSOR_TEST);
    }
    gl.useProgram(this.prog);
    gl.uniform3f(this.uView, z, this.panX * this.dpr, this.panY * this.dpr);
    gl.uniform2f(this.uRes, cw, ch);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas.tex);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    const bytes = k * F * 4;
    if (this.icap < this.inst.byteLength) {
      gl.bufferData(gl.ARRAY_BUFFER, this.inst.byteLength, gl.DYNAMIC_DRAW);
      this.icap = this.inst.byteLength;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, k * F);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, k);
    gl.bindVertexArray(null);
    const g1 = performance.now();
    void bytes;

    const st = this.stats;
    st.instances = k;
    st.layers = n;
    st.evalMs = e1 - e0;
    st.writeMs = w1 - e1 - rasterMs;
    st.rasterMs = rasterMs;
    st.gpuSubmitMs = g1 - w1;
    st.frameMs = g1 - f0;
    st.atlasEntries = this.atlas.size;
    st.atlasPages = this.atlas.pages;
    st.drawCalls = 1;
    this.lastTime = t;
    this.dirty = this.pendingUpgrade;
  }

  // ---------------- queries (hit testing, bounds) ----------------

  /** comp-space corners of item's box [x0,y0,x1,y1,x2,y2,x3,y3] */
  corners(id: string): number[] | null {
    const i = this.index.get(id);
    if (i === undefined) return null;
    const o = i * 6, W = this.world, S = this.style, os = i * ST;
    const w = S[os], h = S[os + 1];
    const a = W[o], b = W[o + 1], c = W[o + 2], d = W[o + 3], e = W[o + 4], f = W[o + 5];
    return [e, f, a * w + e, b * w + f, a * w + c * h + e, b * w + d * h + f, c * h + e, d * h + f];
  }

  worldMatrix(id: string): number[] | null {
    const i = this.index.get(id);
    if (i === undefined) return null;
    return Array.from(this.world.subarray(i * 6, i * 6 + 6));
  }

  sizeOf(id: string): [number, number] {
    const i = this.index.get(id);
    if (i === undefined) return [0, 0];
    return [this.style[i * ST], this.style[i * ST + 1]];
  }

  /** topmost item under comp-space point (deepest layer) */
  hitTest(x: number, y: number): string | null {
    const items = this.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.hidden || it.layer.locked) continue;
      if (!this.drawnMask[i] && !(it.layer.type === 'group')) continue;
      if (this.opa[i] <= 0) continue;
      if (this.hitItem(i, x, y)) {
        // respect clipping ancestors
        if (it.clip >= 0 && !this.hitItem(it.clip, x, y)) continue;
        if (it.layer.type === 'group' && !this.drawnMask[i]) continue;
        return it.id;
      }
    }
    return null;
  }

  private hitItem(i: number, x: number, y: number) {
    const o = i * 6, W = this.world, S = this.style, os = i * ST;
    const a = W[o], b = W[o + 1], c = W[o + 2], d = W[o + 3], e = W[o + 4], f = W[o + 5];
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) return false;
    const dx = x - e, dy = y - f;
    const lx = (d * dx - c * dy) / det, ly = (-b * dx + a * dy) / det;
    const w = S[os], h = S[os + 1];
    if (this.items[i].layer.type === 'ellipse') {
      const nx = (lx - w / 2) / (w / 2), ny = (ly - h / 2) / (h / 2);
      return nx * nx + ny * ny <= 1;
    }
    return lx >= 0 && ly >= 0 && lx <= w && ly <= h;
  }

  /** ids of items whose box intersects a comp-space rect (marquee) */
  hitRect(x0: number, y0: number, x1: number, y1: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.hidden || it.layer.locked) continue;
      const c = this.corners(it.id)!;
      const bx0 = Math.min(c[0], c[2], c[4], c[6]), bx1 = Math.max(c[0], c[2], c[4], c[6]);
      const by0 = Math.min(c[1], c[3], c[5], c[7]), by1 = Math.max(c[1], c[3], c[5], c[7]);
      if (bx1 >= x0 && bx0 <= x1 && by1 >= y0 && by0 <= y1) out.push(it.id);
    }
    return out;
  }

  /** read back current frame as png data url (for agent screenshots / thumbnails) */
  snapshot(t: number, maxSize = 1024): string {
    const comp = this.store.comp;
    const prev = { zoom: this.zoom, panX: this.panX, panY: this.panY, w: this.cssW, h: this.cssH, dpr: this.dpr };
    const s = Math.min(1, maxSize / Math.max(comp.width, comp.height));
    this.resize(Math.round(comp.width * s), Math.round(comp.height * s), 1);
    this.setView(s, 0, 0);
    this.render(t);
    const url = this.canvas.toDataURL('image/png');
    this.resize(prev.w, prev.h, prev.dpr);
    this.setView(prev.zoom, prev.panX, prev.panY);
    this.dirty = true;
    return url;
  }
}

function writeRect(I: Float32Array, k: number, m: number[], w: number, h: number, color: number[]) {
  const o = k * F;
  I.fill(0, o, o + F);
  I[o] = m[0]; I[o + 1] = m[1]; I[o + 2] = m[2]; I[o + 3] = m[3]; I[o + 4] = m[4]; I[o + 5] = m[5];
  I[o + 6] = w; I[o + 7] = h;
  I[o + 12] = color[0]; I[o + 13] = color[1]; I[o + 14] = color[2]; I[o + 15] = color[3];
  I[o + 22] = 1;
  I[o + 23] = KIND_RECT;
  I[o + 30] = -1; I[o + 31] = -1;
}
