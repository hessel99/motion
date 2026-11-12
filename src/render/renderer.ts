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
import { layoutText, rasterImage, rasterPath, rasterShapePaint, rasterText, setImageLoadedHandler, type RasterResult } from './raster';

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

const CVS = `#version 300 es
layout(location=0) in vec2 q;
out vec2 vUV;
void main() { vUV = q; gl_Position = vec4(q * 2.0 - 1.0, 0.0, 1.0); }`;
const CFS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform float uOpacity;
uniform float uUseMask;
in vec2 vUV;
out vec4 o;
void main() {
  float m = uUseMask > 0.5 ? texture(uMask, vUV).a : 1.0;
  o = texture(uSrc, vUV) * (uOpacity * m);
}`;

// command list for one frame (offscreen isolation for group opacity + masks)
const CMD_DRAW = 0, CMD_PUSH = 1, CMD_POP = 2, CMD_MASK = 3;

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
  /** has children: opacity < 1 needs group isolation */
  isoGroup: boolean;
  /** time offset (precomp start times): local time = comp time - tOff */
  tOff: number;
  /** index of the item in the active comp that owns this one (itself, or the precomp layer it is inside) */
  owner: number;
  hidden: boolean; // visible=false (self or ancestor)
  rasterBase: string | null;
  rasterKey: string | null; // last resolved atlas key
  raster: RasterResult | null; // placement of last raster
  rasterScale: number; // bucket scale of the current raster
  maxScale: number; // largest |scale| (factor) reached by this layer's scale keyframes
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

  private cprog: WebGLProgram | null = null;
  private cuOpacity: WebGLUniformLocation | null = null;
  private cuUseMask: WebGLUniformLocation | null = null;
  private fbos: { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }[] = [];
  private cmds: number[] = []; // [type, a, b] triples (b = count or opacity)
  isolatedLastFrame = 0;

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
    const L = store.project.layers;
    // flatten the layer tree depth-first; precomp layers expand the referenced comp inline
    // (each expanded item gets its own time offset). items outside the active comp are not indexed.
    const entries: { layer: Layer; parent: number; tOff: number; local: boolean; owner: number }[] = [];
    const walk = (ids: string[], parent: number, tOff: number, local: boolean, owner: number, depth: number, stack: string[]) => {
      for (const id of ids) {
        const layer = L[id];
        if (!layer) continue;
        const idx = entries.length;
        entries.push({ layer, parent, tOff, local, owner: local ? idx : owner });
        if (layer.children.length) walk(layer.children, idx, tOff, local, local ? idx : owner, depth, stack);
        if (layer.type === 'precomp' && layer.compRef && depth < 16 && !stack.includes(layer.compRef)) {
          const comp = store.project.comps[layer.compRef];
          if (comp) walk(comp.root, idx, tOff + (layer.startTime ?? 0), false, local ? idx : owner, depth + 1, [...stack, layer.compRef]);
        }
      }
    };
    walk(store.comp.root, -1, 0, true, -1, 0, [store.comp.id]);
    const n = entries.length;
    this.pool.reset();
    this.items = new Array(n);
    this.index.clear();
    for (let i = 0; i < n; i++) if (entries[i].local) this.index.set(entries[i].layer.id, i);
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
      const { layer, parent, tOff, owner } = entries[i];
      const it: Item = {
        id: layer.id, layer, parent, clip: -1, kind: KIND_NONE, tracks: [], animated: false, animMask: 0, h: new Int32Array(10), isoGroup: layer.children.length > 0 || layer.type === 'precomp',
        hidden: !layer.visible || (parent >= 0 && this.items[parent].hidden),
        rasterBase: null, rasterKey: null, raster: null, rasterScale: 0, rasterGen: -1, entry: null, maxScale: 1,
        tOff, owner,
      };
      if (parent >= 0) {
        const p = this.items[parent];
        // precomps clip to their composition bounds (after effects)
        it.clip = p.layer.clip || p.layer.type === 'precomp' ? parent : p.clip;
      }
      this.items[i] = it;
      this.compileItem(i);
    }
    this.needsCompile = false;
    this.dirtyLayers.clear();
    this.poolLive = this.pool.used;
    this.subEnd = new Int32Array(n);
    for (let i = n - 1; i >= 0; i--) {
      // end of subtree: first following item whose parent chain doesn't include i
      let e = i + 1;
      while (e < n && this.isInside(e, i)) e = this.subEnd[e];
      this.subEnd[i] = e;
    }
    this.evalAll = true;
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
    const sp = l.props.scale;
    it.maxScale = sp?.kf?.length ? Math.max(...sp.kf.map(k => Math.max(Math.abs(k.v[0]), Math.abs(k.v[1])))) / 100 : 1;
    it.animated = mask !== 0;
    const complex = !!l.paints?.some(p => p.type !== 'solid');
    switch (l.type) {
      case 'rect': case 'group': it.kind = complex ? KIND_RGBA : KIND_RECT; break;
      case 'ellipse': it.kind = complex ? KIND_RGBA : KIND_ELLIPSE; break;
      case 'path': it.kind = complex ? KIND_RGBA : KIND_MASK; break;
      case 'text': it.kind = KIND_MASK; break;
      case 'image': it.kind = KIND_RGBA; break;
      case 'precomp': it.kind = KIND_NONE; break;
    }
    it.rasterBase = this.rasterBase(l, complex);
    it.rasterKey = null;
    it.entry = null;
    this.evalItem(i, 0, true);
    // auto-size text (size 0): measure so hit testing, handles and snapping see the real box
    if (l.type === 'text' && l.text && !(l.props.size?.kf?.length)) {
      const sz = l.props.size?.v ?? [0, 0];
      if (sz[0] <= 0 || sz[1] <= 0) {
        const lines = layoutText(l, sz[0] > 0 ? sz[0] : null);
        const os = i * ST;
        if (sz[0] <= 0) this.style[os] = Math.ceil(Math.max(1, ...lines.map(x => x.width)));
        if (sz[1] <= 0) this.style[os + 1] = Math.ceil(lines.length * l.text.fontSize * l.text.lineHeight);
      }
    }
  }

  private rasterBase(l: Layer, complex: boolean): string | null {
    switch (l.type) {
      case 'path': return `p${oid(l.geometry)}:${oid(l.strokeGeometry)}:${oid(l.paints)}:${l.strokeAlign}:${l.props.strokeWidth?.v[0] ?? 0}:${complex ? oid(l.props.stroke) : ''}`;
      case 'text': {
        const t = l.text!;
        const s = l.props.size?.v ?? [0, 0];
        return `t${t.content}|${t.fontFamily}|${t.fontWeight}|${t.fontStyle}|${t.fontSize}|${t.lineHeight}|${t.letterSpacing}|${t.align}|${Math.round(s[0])}x${Math.round(s[1])}`;
      }
      case 'image': return `i${l.imageRef}`; // images stretch to the size box (see raster placement below)
      default: {
        if (!complex) return null;
        const r2 = (v?: number[]) => (v ? v.map(x => Math.round(x * 10) / 10).join(',') : '');
        return `g${oid(l.paints)}:${r2(l.props.size?.v)}:${r2(l.props.radius?.v)}:${r2(l.props.stroke?.v)}:${l.props.strokeWidth?.v[0] ?? 0}`;
      }
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

  private isInside(e: number, i: number) {
    let p = this.items[e].parent;
    while (p > i) p = this.items[p].parent;
    return p === i;
  }
  private evalTime = NaN;
  private evalAll = true;
  private dirtyIdx: number[] = [];
  /** subEnd[i] = index after the last descendant of i (depth-first order => subtrees are contiguous) */
  private subEnd = new Int32Array(0);

  /** compute world matrices and opacities for all items at time t */
  evaluate(t: number) { this.evaluateRange(t, 0, this.items.length); }

  private evaluateRange(t: number, from: number, to: number) {
    const items = this.items, W = this.world, L = this.local, O = this.opa, LO = this.lopa;
    for (let i = from; i < to; i++) {
      const it = items[i];
      const tl = t - it.tOff;
      if (it.animated) this.evalItem(i, tl);
      const o = i * 6;
      const p = it.parent;
      const l = it.layer;
      const vis = it.hidden || tl < l.inPoint || tl >= l.outPoint ? 0 : 1;
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
      for (const id of this.dirtyLayers) if (!this.index.has(id)) { this.needsCompile = true; break; }
      if (this.needsCompile) this.compile();
      for (const id of this.dirtyLayers) {
        const i = this.index.get(id);
        if (i !== undefined) { this.items[i].layer = store.project.layers[id]; this.compileItem(i); this.dirtyIdx.push(i); }
      }
      this.dirtyLayers.clear();
    }
    this.atlas.frame++;
    const e0 = performance.now();
    // same time + only a few layers edited (dragging while paused): re-evaluate just their subtrees
    if (t === this.evalTime && !this.evalAll && this.dirtyIdx.length && this.dirtyIdx.length < 64) {
      for (const i of this.dirtyIdx) this.evaluateRange(t, i, this.subEnd[i]);
    } else if (t !== this.evalTime || this.evalAll || this.dirtyIdx.length) {
      this.evaluate(t);
    }
    this.evalTime = t;
    this.evalAll = false;
    this.dirtyIdx.length = 0;
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
    const cmds = this.cmds;
    cmds.length = 0;
    let pending = 0; // first instance not yet covered by a DRAW command
    // open isolation regions: end index, composite opacity, divisor to restore, optional mask range
    const stack: { end: number; opacity: number; div: number; maskStart: number; maskCount: number; maskEnd: number }[] = [];
    let div = 1; // opacity already applied by the enclosing isolated group (instances inside divide it out)
    let isolated = 0;
    const flush = () => { if (k > pending) { cmds.push(CMD_DRAW, pending, k - pending); pending = k; } };
    for (let i = 0; i <= n; i++) {
      // the mask shape's own subtree has been written: mark its range (it is not drawn in place)
      for (const r of stack) if (r.maskEnd === i) { r.maskCount = k - r.maskStart; pending = k; r.maskEnd = -1; }
      // close finished regions
      while (stack.length && stack[stack.length - 1].end <= i) {
        const r = stack.pop()!;
        flush();
        if (r.maskCount > 0) cmds.push(CMD_MASK, r.maskStart, r.maskCount);
        cmds.push(CMD_POP, 0, r.opacity);
        div = r.div;
      }
      const top = stack[stack.length - 1];
      if (i === n) break;
      const it = items[i];
      mask[i] = 0;
      const l = it.layer;
      if (O[i] <= 0.0005) continue;
      if (l.mask && !(top && top.maskEnd > i)) {
        // masks the following siblings: region = rest of the parent's subtree
        flush();
        cmds.push(CMD_PUSH, 0, 0);
        const end = it.parent >= 0 ? this.subEnd[it.parent] : n;
        stack.push({ end, opacity: 1, div, maskStart: k, maskCount: 0, maskEnd: this.subEnd[i] });
        isolated++;
      } else if (it.isoGroup && this.lopa[i] < 0.999 && this.subEnd[i] > i + 1) {
        // group opacity: render the group into its own layer, then composite once with its opacity
        flush();
        cmds.push(CMD_PUSH, 0, 0);
        stack.push({ end: this.subEnd[i], opacity: O[i] / div, div, maskStart: 0, maskCount: 0, maskEnd: -1 });
        div = O[i];
        isolated++;
      }
      if (it.kind === KIND_NONE) continue;
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
        let scale = Math.sqrt(Math.abs(a * d - b * c) * Math.abs(gx * gy)) * z;
        // raster once at the largest scale the animation reaches: no re-rasters during playback
        if (it.maxScale > 0) {
          const o8 = i * 8, cur = Math.max(Math.abs(this.xf[o8 + 4]), Math.abs(this.xf[o8 + 5])) / 100;
          if (cur > 1e-3) scale *= Math.min(8, Math.max(1, it.maxScale / cur));
        }
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
        if (l.type === 'image') { w = S[os]; h = S[os + 1]; }
        else { w = r.w; h = r.h; }
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
      I[o + 22] = div !== 1 ? O[i] / div : O[i];
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
    flush();
    this.isolatedLastFrame = isolated;
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
    if (cmds.length === 3 && cmds[0] === CMD_DRAW && cmds[1] === 0) {
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, k); // common case: the whole scene in one call
    } else {
      this.runCommands(cmds);
    }
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

  /** draw instances [start, start+count) by pointing the attributes at that range (no baseInstance in webgl2) */
  private drawRange(start: number, count: number) {
    const gl = this.gl;
    for (let a = 0; a < 10; a++) gl.vertexAttribPointer(1 + a, 4, gl.FLOAT, false, F * 4, start * F * 4 + a * 16);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
  }

  private fbo(depth: number) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    let f = this.fbos[depth];
    if (!f || f.w !== w || f.h !== h) {
      if (f) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.fbos[depth] = f = { fb, tex, w, h };
    }
    return f;
  }

  private compositeProgram() {
    if (this.cprog) return this.cprog;
    const gl = this.gl;
    const sh = (type: number, src: string) => { const x = gl.createShader(type)!; gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x) ?? ''); return x; };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, CVS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, CFS));
    gl.linkProgram(p);
    this.cprog = p;
    this.cuOpacity = gl.getUniformLocation(p, 'uOpacity');
    this.cuUseMask = gl.getUniformLocation(p, 'uUseMask');
    gl.useProgram(p);
    gl.uniform1i(gl.getUniformLocation(p, 'uSrc'), 1);
    gl.uniform1i(gl.getUniformLocation(p, 'uMask'), 2);
    return p;
  }

  /** execute DRAW / PUSH / MASK / POP commands with an fbo stack */
  private runCommands(cmds: number[]) {
    const gl = this.gl;
    let depth = 0; // 0 = canvas
    const targets: (WebGLFramebuffer | null)[] = [null];
    const masks: (WebGLTexture | null)[] = [];
    for (let c = 0; c < cmds.length; c += 3) {
      const type = cmds[c], a = cmds[c + 1], b = cmds[c + 2];
      if (type === CMD_DRAW) this.drawRange(a, b);
      else if (type === CMD_PUSH) {
        const f = this.fbo(depth);
        depth++;
        targets.push(f.fb);
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else if (type === CMD_MASK) {
        // render the mask shape into its own layer; the composite multiplies by its alpha
        const mf = this.fbo(depth);
        gl.bindFramebuffer(gl.FRAMEBUFFER, mf.fb);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.drawRange(a, b);
        gl.bindFramebuffer(gl.FRAMEBUFFER, targets[targets.length - 1]);
        masks[depth] = mf.tex;
      } else if (type === CMD_POP) {
        const src = this.fbos[depth - 1];
        const maskTex = masks[depth];
        masks[depth] = null;
        depth--;
        targets.pop();
        gl.bindFramebuffer(gl.FRAMEBUFFER, targets[targets.length - 1]);
        // composite the layer with a fullscreen quad
        gl.useProgram(this.compositeProgram());
        gl.uniform1f(this.cuOpacity, b);
        gl.uniform1f(this.cuUseMask, maskTex ? 1 : 0);
        if (maskTex) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, maskTex); }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.activeTexture(gl.TEXTURE0);
        gl.useProgram(this.prog);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let a = 0; a < 10; a++) gl.vertexAttribPointer(1 + a, 4, gl.FLOAT, false, F * 4, a * 16); // back to the fast path layout
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
        if (it.layer.mask) continue;
        return this.items[it.owner]?.id ?? it.id;
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
      if (it.hidden || it.layer.locked || it.owner !== i) continue;
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
