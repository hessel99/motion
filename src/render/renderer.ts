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
import { compileExpr, compileProgram, runProgram, type ExprFrame, type ExprProgram } from '../core/expr';
import { PROP_DEFS, type Layer, type Paint, type PropKey } from '../core/model';
import type { Store, Change } from '../core/store';
import { Atlas, type AtlasEntry } from './atlas';
import type { PathGeometry, PathKey } from '../core/model';
import { loadBundledFonts } from './fonts';
import { cubicBezier, EASE_PRESETS, springAt } from '../core/easing';
import { layoutText, textUnits, type TextUnit, rasterImage, rasterPath, rasterShapePaint, rasterText, setImageLoadedHandler, drawPathMask, pathPlacement, type RasterResult } from './raster';

const F = 40; // floats per instance
const KIND_RECT = 0, KIND_ELLIPSE = 1, KIND_MASK = 2, KIND_RGBA = 3, KIND_NONE = 4;
// rect / ellipse with one linear or radial gradient paint: sdf shape, gradient evaluated in the
// shader from a ramp texture (no raster, no atlas space; size / radius animate for free)
const KIND_GRECT = 5, KIND_GELL = 6;
const RAMP_W = 256;
/** max raster area (px) the anticipatory max-scale boost may produce: 1/8 of an atlas page */
const BOOST_AREA = 2048 * 2048 / 8;

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
flat out vec4 vJ;
void main() {
  vec2 size = iB.zw;
  float kind = iF.w;
  vec2 lp;
  if (kind >= 1.5 && kind < 4.5) {
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
    // gradient kinds: gradient-space coordinate (affine, so interpolation is exact)
    vUV = kind > 4.5 ? mat2(iFill.xy, iFill.zw) * lp + iUV.xy : vec2(0.0);
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
  vJ = iJ;
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform sampler2D uRamp;
uniform float uRampH;
uniform sampler2D uDyn;
uniform float uDynH;
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
flat in vec4 vJ;
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
  if (kind < 1.5 || kind > 4.5) {
    if (kind > 4.5) {
      float gt = vJ.z > 0.5 ? length(vUV - 0.5) * 2.0 : vUV.x;
      fill = textureLod(uRamp, vec2(clamp(gt, 0.0, 1.0), (vH.x + 0.5) / uRampH), 0.0);
    }
    vec2 h = vSize * 0.5;
    vec2 p = vLocal - h;
    float d = (kind < 0.5 || (kind > 4.5 && kind < 5.5)) ? sdRoundBox(p, h, vRadii) : sdEllipse(p, h);
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
    // page -1: per-frame shapes (their own canvas texture, 2048 wide, uDynH tall)
    vec4 t = vH.x < -0.5 ? textureLod(uDyn, vec2(vUV.x, vUV.y * 2048.0 / uDynH), 0.0) : textureLod(uTex, vec3(vUV, vH.x), 0.0);
    if (kind < 2.5) {
      col = stroke * t.g + fill * t.r * (1.0 - stroke.a * t.g);
    } else {
      col = t * vFill.a;
    }
  }
  col *= opacity;
  if (vH.z >= 0.0) {
    vec2 cp = mat2(vI.xy, vI.zw) * vWorld + vJ.xy;
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
const CMD_DRAW = 0, CMD_PUSH = 1, CMD_POP = 2, CMD_MASK = 3, CMD_BLEND = 4;
const BLEND_IDS: Record<string, number> = { normal: 0, multiply: 1, screen: 2, add: 3, darken: 4, lighten: 5 };

interface UnitState { unit: TextUnit; delay: number; ease: (p: number) => number; entry: AtlasEntry | null; raster: RasterResult | null; scale: number }

interface Item {
  id: string;
  layer: Layer;
  parent: number;
  clip: number; // index of nearest clipping ancestor
  kind: number;
  animated: boolean;
  /** bitmask of animated tracks (bit = TR_* index); pool handles live in Renderer.sH */
  animMask: number;
  /** has children: opacity < 1 needs group isolation */
  isoGroup: boolean;
  /** time offset (precomp start times): local time = comp time - tOff */
  tOff: number;
  /** comp time after which this item is hidden (end of the precomp it lives in) */
  tEnd: number;
  /** index of the item in the active comp that owns this one (itself, or the precomp layer it is inside) */
  owner: number;
  /** per-unit text animation state */
  units: UnitState[] | null;
  /** per-frame raster (animated path shape / trim paths) */
  dyn: { base: string; need: boolean; trim: Track[] | null; pkf: PathKey[] | null; eases: ((p: number) => number)[]; frame: number; t: number } | null;
  /** properties driven by expressions (bit = TR_* index) + their compiled programs */
  exprMask: number;
  exprs: ({ prog: ExprProgram; track: Track; fr: ExprFrame } | null)[] | null;
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

const ZERO4 = [0, 0, 0, 0];
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
  culled: number;
  /** instance bytes uploaded this frame */
  uploadBytes: number;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  private prog!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private ibuf!: WebGLBuffer;
  private icap = 0;
  private inst = new Float32Array(0);
  private uView!: WebGLUniformLocation;
  private uRes!: WebGLUniformLocation;
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
  /** exports/snapshots: rasterize everything synchronously (no workers, no frame budget) */
  syncRaster = false;
  /** skip layers fully outside the viewport (disabled for snapshots/exports which render the whole comp) */
  cullOffscreen = true;

  private cprog: WebGLProgram | null = null;
  private cuOpacity: WebGLUniformLocation | null = null;
  private cuUseMask: WebGLUniformLocation | null = null;
  private fbos: { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }[] = [];
  private cmds: number[] = []; // [type, a, b] triples (b = count or opacity)
  isolatedLastFrame = 0;

  private needsCompile = true;
  private dirtyLayers = new Set<string>();
  dirty = true;
  stats: RenderStats = { instances: 0, layers: 0, evalMs: 0, writeMs: 0, rasterMs: 0, gpuSubmitMs: 0, frameMs: 0, atlasEntries: 0, atlasPages: 0, drawCalls: 0, culled: 0, uploadBytes: 0 };
  private rasterBudgetMs = 6;
  private ranges: number[] = [];
  private boxes: number[] = [];
  /** screen aabb (device px, top-left origin) of each instance slot, NaN = unknown */
  private instBox = new Float32Array(0);
  /** the comp clip scissor of this frame (gl coords) or null */
  private baseScissor: number[] | null = null;
  /** item index of each instance written last frame (effects: per-layer velocity, lookups) */
  instItem = new Int32Array(0);
  /** skip unchanged instances during playback (off = rewrite + upload everything, for a/b tests) */
  incremental = true;
  private lastCull = true;
  private pendingUpgrade = false;
  lastTime = -1;

  constructor(private store: Store, canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('webgl2 not available');
    this.gl = gl;
    this.atlas = new Atlas(gl);
    this.atlas.onEvict = key => { this.rasterMeta.delete(key); };
    this.initGL();

    store.onChange(c => this.onChange(c));
    // bundled fonts arrive async: re-raster text once they are loaded (no-op if already cached)
    loadBundledFonts().then(() => { this.invalidateText(); });
    setImageLoadedHandler(() => { for (const it of this.items) if (it.layer.type === 'image') { it.rasterKey = null; it.entry = null; } this.dirty = true; });
    // gpu resets (macos gpu switch, sleep, driver crash): rebuild everything; atlas pages come back
    // from their cpu shadow copies, so nothing has to be re-rasterized
    this.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.contextLost = true; });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.initGL();
      this.atlas.restore();
      this.fbos = [];
      this.cprog = null;
      this.icap = 0;
      this.dirty = true;
      this.contextRestores++;
    });
  }
  contextLost = false;
  contextRestores = 0;

  private initGL() {
    const gl = this.gl;
    this.prog = this.buildProgram();
    this.uView = gl.getUniformLocation(this.prog, 'uView')!;
    this.uRes = gl.getUniformLocation(this.prog, 'uRes')!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const qb = gl.createBuffer();
    this.qbuf = qb!;
    this.rangeVaos.clear();
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
    gl.useProgram(this.prog);
    gl.uniform1i(gl.getUniformLocation(this.prog, 'uTex'), 0);
    gl.uniform1i(gl.getUniformLocation(this.prog, 'uRamp'), 3);
    this.uRampH = gl.getUniformLocation(this.prog, 'uRampH')!;
    gl.uniform1i(gl.getUniformLocation(this.prog, 'uDyn'), 4);
    this.uDynH = gl.getUniformLocation(this.prog, 'uDynH')!;
    this.dynTex = null; this.dynTexStale = true;
    this.rampTex = null; // (re)created from the cpu copy on the next frame
  }

  // ---------------- gradient ramps ----------------
  // one row of RAMP_W premultiplied texels per distinct gradient (stops + paint opacity), drawn by
  // the 2d canvas once so the colors match what a raster of the gradient would show.
  private uRampH!: WebGLUniformLocation;
  private rampTex: WebGLTexture | null = null;
  private rampRows = new Map<string, number>();
  private rampData = new Uint8Array(RAMP_W * 4 * 64);
  private rampH = 64;
  private rampDirty = true;
  private rampCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  private rampRow(p: Paint): number {
    const stops = p.stops!;
    let key = `${p.type === 'radial' ? 'r' : 'l'}${p.opacity ?? 1}`;
    for (const st of stops) key += `|${st.pos},${st.color.join(',')}`;
    let row = this.rampRows.get(key);
    if (row !== undefined) return row;
    row = this.rampRows.size;
    if (row >= this.rampH) {
      if (this.rampH >= 4096) { this.rampRows.clear(); row = 0; } // pathological: start over (rows get rebuilt as items recompile)
      else {
        const d = new Uint8Array(RAMP_W * 4 * this.rampH * 2);
        d.set(this.rampData);
        this.rampData = d;
        this.rampH *= 2;
      }
    }
    if (!this.rampCtx) {
      const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(RAMP_W, 1) : Object.assign(document.createElement('canvas'), { width: RAMP_W, height: 1 });
      this.rampCtx = cv.getContext('2d', { willReadFrequently: true }) as any;
    }
    const c = this.rampCtx!;
    c.globalAlpha = 1;
    c.clearRect(0, 0, RAMP_W, 1);
    const g = c.createLinearGradient(0, 0, RAMP_W, 0);
    for (const st of stops) g.addColorStop(Math.min(1, Math.max(0, st.pos)), `rgba(${(st.color[0] * 255) | 0},${(st.color[1] * 255) | 0},${(st.color[2] * 255) | 0},${st.color[3] ?? 1})`);
    c.globalAlpha = p.opacity ?? 1;
    c.fillStyle = g;
    c.fillRect(0, 0, RAMP_W, 1);
    const img = c.getImageData(0, 0, RAMP_W, 1).data;
    const out = this.rampData, o = row * RAMP_W * 4;
    for (let i = 0; i < img.length; i += 4) {
      const a = img[i + 3];
      out[o + i] = (img[i] * a + 127) / 255;
      out[o + i + 1] = (img[i + 1] * a + 127) / 255;
      out[o + i + 2] = (img[i + 2] * a + 127) / 255;
      out[o + i + 3] = a;
    }
    this.rampRows.set(key, row);
    this.rampDirty = true;
    return row;
  }

  private bindRamps() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE3);
    if (!this.rampTex || this.rampDirty) {
      if (!this.rampTex) this.rampTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.rampTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, RAMP_W, this.rampH, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.rampData);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.rampDirty = false;
    } else gl.bindTexture(gl.TEXTURE_2D, this.rampTex);
    gl.uniform1f(this.uRampH, this.rampH);
    gl.activeTexture(gl.TEXTURE0);
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

  /** drop cached text rasters (fonts changed) */
  invalidateText() {
    for (const it of this.items) if (it.layer.type === 'text') { it.rasterBase = (it.rasterBase ?? '') + '~f'; it.entry = null; it.rasterKey = null; it.units = it.units?.map(u => ({ ...u, entry: null, raster: null })) ?? null; }
    this.fontGen++;
    this.needsCompile = true; // auto-sized text boxes were measured with fallback metrics
    this.dirty = true;
  }
  private fontGen = 0;

  // ---------------- compile ----------------

  private compile() {
    const store = this.store;
    const L = store.project.layers;
    // flatten the layer tree depth-first; precomp layers expand the referenced comp inline
    // (each expanded item gets its own time offset). items outside the active comp are not indexed.
    const entries: { layer: Layer; parent: number; tOff: number; local: boolean; owner: number; tEnd: number }[] = [];
    let tEndCur = Infinity;
    const walk = (ids: string[], parent: number, tOff: number, local: boolean, owner: number, depth: number, stack: string[]) => {
      for (const id of ids) {
        const layer = L[id];
        if (!layer) continue;
        const idx = entries.length;
        entries.push({ layer, parent, tOff, local, owner: local ? idx : owner, tEnd: tEndCur });
        if (layer.children.length) walk(layer.children, idx, tOff, local, local ? idx : owner, depth, stack);
        if (layer.type === 'precomp' && layer.compRef && depth < 16 && !stack.includes(layer.compRef)) {
          const comp = store.project.comps[layer.compRef];
          if (comp) {
            const prevEnd = tEndCur;
            tEndCur = Math.min(prevEnd, tOff + (layer.startTime ?? 0) + comp.duration);
            walk(comp.root, idx, tOff + (layer.startTime ?? 0), false, local ? idx : owner, depth + 1, [...stack, layer.compRef]);
            tEndCur = prevEnd;
          }
        }
      }
    };
    walk(store.comp.root, -1, 0, true, -1, 0, [store.comp.id]);
    const n = entries.length;
    // solo: keep soloed layers, their ancestors (for transforms) and descendants
    let soloKeep: Set<string> | null = null;
    for (const id of [...store.solo]) if (!L[id]) store.solo.delete(id); // deleted / other project
    if (store.solo.size) {
      soloKeep = new Set();
      for (const id of store.solo) {
        if (!L[id]) continue;
        let cur: string | null = id;
        while (cur) { soloKeep.add(cur); cur = L[cur]?.parent ?? null; }
        for (const d of store.descendants(id)) soloKeep.add(d);
      }
    }
    this.pool.reset();
    this.unitCount = 0;
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
      this.sPar = new Int32Array(cap);
      this.sTOff = new Float64Array(cap);
      this.sIn = new Float64Array(cap);
      this.sOut = new Float64Array(cap);
      this.sEnd = new Float64Array(cap);
      this.sFlags = new Uint8Array(cap);
      this.sMask = new Int32Array(cap);
      this.sExpr = new Int32Array(cap);
      this.sH = new Int32Array(cap * 10);
      this.chg = new Uint8Array(cap);
      this.vis = new Uint8Array(cap);
      this.lastK = new Int32Array(cap);
      this.sKind = new Uint8Array(cap);
      this.sBits = new Uint8Array(cap);
      this.sBlend = new Uint8Array(cap);
      this.sAlign = new Int8Array(cap);
      this.sClip = new Int32Array(cap);
      this.sGrad = new Float64Array(cap * 8);
    }
    for (let i = 0; i < n; i++) {
      const { layer, parent, tOff, owner, tEnd } = entries[i];
      const it: Item = {
        id: layer.id, layer, parent, clip: -1, kind: KIND_NONE, animated: false, animMask: 0, isoGroup: layer.children.length > 0 || layer.type === 'precomp',
        hidden: !layer.visible || (parent >= 0 && this.items[parent].hidden) || (!!soloKeep && entries[i].local && !soloKeep.has(layer.id)),
        rasterBase: null, rasterKey: null, raster: null, rasterScale: 0, rasterGen: -1, entry: null, maxScale: 1,
        tOff, owner, units: null, exprMask: 0, exprs: null, tEnd, dyn: null,
      };
      if (parent >= 0) {
        const p = this.items[parent];
        // precomps clip to their composition bounds (after effects)
        it.clip = p.layer.clip || p.layer.type === 'precomp' ? parent : p.clip;
      }
      this.items[i] = it;
      this.sPar[i] = parent; this.sTOff[i] = tOff; this.sEnd[i] = tEnd; this.sClip[i] = it.clip;
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
  private unitCount = 0;
  private dynRev = 0;

  private compileItem(i: number) {
    const it = this.items[i];
    const l = it.layer;
    let mask = 0;
    // animated props go into the track pool; static ones are written once below (no Track
    // objects: at 10k layers building 100k of them dominated load time and garbage)
    for (let k = 0; k < TR_KEYS.length; k++) {
      const key = TR_KEYS[k];
      const p = this.store.renderProp(l, key); // preview overrides (hover swatch, Perform) win
      if (p?.kf && p.kf.length > 1) { mask |= 1 << k; this.sH[i * 10 + k] = this.pool.add(p, PROP_DEFS[key].dim, key === 'position'); }
    }
    // expressions: evaluated every frame on top of the keyframed/static value
    let emask = 0;
    it.exprs = null;
    for (let k = 0; k < TR_KEYS.length; k++) {
      const p = this.store.renderProp(l, TR_KEYS[k]);
      if (!p?.expr?.trim()) continue;
      const c = compileExpr(p.expr);
      if (!c.node) continue;
      if (!it.exprs) it.exprs = new Array(TR_KEYS.length).fill(null);
      const dim = PROP_DEFS[TR_KEYS[k]].dim, track = new Track(p, dim, k === TR_POS);
      // the frame object, seed and valueAt are made once here, not per frame
      const fr: ExprFrame = { time: 0, index: i, fps: 30, duration: 1, inPoint: 0, seed: (hashStr(it.id) + k * 31) % 9973, keyTimes: (p.kf ?? []).map(f => f.t), value: new Float64Array(4), valueAt: (tt, o) => track.eval(tt, o, 0), calls: 0 };
      it.exprs[k] = { prog: compileProgram(c.node, dim), track, fr };
      emask |= 1 << k;
    }
    it.exprMask = emask;
    mask |= emask;
    it.animMask = mask;
    const sp = this.store.renderProp(l, 'scale');
    it.maxScale = sp?.kf?.length ? Math.max(...sp.kf.map(k => Math.max(Math.abs(k.v[0]), Math.abs(k.v[1])))) / 100 : 1;
    it.animated = mask !== 0;
    let complex = !!l.paints?.some(p => p.type !== 'solid');
    const gp = l.paints?.length === 1 ? l.paints[0] : null;
    const shaderGrad = complex && !!gp && (gp.type === 'linear' || gp.type === 'radial') && !!gp.stops?.length && (l.type === 'rect' || l.type === 'group' || l.type === 'ellipse');
    if (shaderGrad) {
      const m = gp!.transform ?? [1, 0, 0, 1, 0, 0];
      const [a, b, c, d, e, f] = m;
      const det = a * d - b * c || 1e-9;
      const G = this.sGrad, og = i * 8;
      G[og] = d / det; G[og + 1] = -b / det; G[og + 2] = -c / det; G[og + 3] = a / det;
      G[og + 4] = (c * f - d * e) / det; G[og + 5] = (b * e - a * f) / det;
      G[og + 6] = this.rampRow(gp!);
      G[og + 7] = gp!.type === 'radial' ? 1 : 0;
      complex = false; // no raster
    }
    switch (l.type) {
      case 'rect': case 'group': it.kind = shaderGrad ? KIND_GRECT : complex ? KIND_RGBA : KIND_RECT; break;
      case 'ellipse': it.kind = shaderGrad ? KIND_GELL : complex ? KIND_RGBA : KIND_ELLIPSE; break;
      case 'path': it.kind = complex ? KIND_RGBA : KIND_MASK; break;
      case 'text': it.kind = KIND_MASK; break;
      case 'image': it.kind = KIND_RGBA; break;
      case 'audio': it.kind = KIND_NONE; break;
      case 'precomp': it.kind = KIND_NONE; break;
    }
    it.rasterBase = this.rasterBase(l, complex);
    it.rasterKey = null;
    it.entry = null;
    it.dyn = null;
    if (l.type === 'path' && ((l.pathKf?.length ?? 0) >= 2 || l.trimOn)) {
      const pkf = l.pathKf && l.pathKf.length >= 2 ? l.pathKf : null;
      it.dyn = {
        base: `${it.rasterBase}|r${this.dynRev++}`, // revision: trim/pathKf edits must never reuse old frames
        trim: l.trimOn ? [new Track(this.store.renderProp(l, 'trimStart') ?? { v: [0] }, 1), new Track(this.store.renderProp(l, 'trimEnd') ?? { v: [100] }, 1), new Track(this.store.renderProp(l, 'trimOffset') ?? { v: [0] }, 1)] : null,
        pkf,
        eases: pkf ? pkf.map((k, j) => (j < pkf.length - 1 && k.interp === 'bezier' ? cubicBezier(k.out[0], k.out[1], pkf[j + 1].in[0], pkf[j + 1].in[1]) : (x: number) => x)) : [],
        frame: NaN, t: 0, need: true,
      };
      it.animated = true; // re-render every frame while it changes
    }
    // struct-of-arrays mirror of what the per-frame loops read (no object pointer chasing)
    this.sIn[i] = l.inPoint; this.sOut[i] = l.outPoint;
    this.sMask[i] = mask & ~emask; this.sExpr[i] = emask;
    this.sFlags[i] = (it.animated ? 1 : 0) | (it.hidden ? 2 : 0);
    this.evalItem(i, 0, true);
    this.unitCount -= it.units?.length ?? 0;
    it.units = null;
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
    if (l.type === 'text' && l.text && l.textAnim) {
      const ta = l.textAnim;
      const units = textUnits(l, (l.props.size?.v[0] ?? 0) > 0 ? this.style[i * ST] : 0, ta.by);
      const n = units.length;
      const order = units.map((_, j) => {
        switch (ta.order) {
          case 'backward': return n - 1 - j;
          case 'center': return Math.abs(j - (n - 1) / 2);
          case 'random': return ((j * 2654435761) >>> 0) % Math.max(1, n);
          default: return j;
        }
      });
      const ease = easeFn(ta.ease);
      it.units = units.map((u, j) => ({ unit: u, delay: order[j] * ta.stagger, ease, entry: null, raster: null, scale: 0 }));
      this.unitCount += n;
    }
    this.sKind[i] = it.kind;
    this.sBits[i] = (l.mask ? 1 : 0) | (it.isoGroup ? 2 : 0) | (it.units ? 4 : 0) | (it.dyn ? 8 : 0);
    this.sBlend[i] = l.blend ? BLEND_IDS[l.blend] ?? 0 : 0;
    this.sAlign[i] = l.strokeAlign === 'inside' ? -1 : l.strokeAlign === 'outside' ? 1 : 0;
  }

  private rasterBase(l: Layer, complex: boolean): string | null {
    switch (l.type) {
      case 'path': return `p${oid(l.geometry)}:${oid(l.strokeGeometry)}:${oid(l.paints)}:${l.strokeAlign}:${l.props.strokeWidth?.v[0] ?? 0}:${complex ? (l.props.stroke?.v ?? []).join(',') : ''}`;
      case 'text': {
        const t = l.text!;
        const s = l.props.size?.v ?? [0, 0];
        return `t${this.fontGen}|${t.content}|${t.fontFamily}|${t.fontWeight}|${t.fontStyle}|${t.fontSize}|${t.lineHeight}|${t.letterSpacing}|${t.align}|${Math.round(s[0])}x${Math.round(s[1])}`;
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
    const X = this.xf, o8 = i * 8, os = i * ST, S = this.style;
    if (force) {
      // compile time: every prop once (animated ones from the pool, static ones from the model)
      const l = this.items[i].layer;
      const val = (k: number, out: Float64Array, off: number) => {
        const key = TR_KEYS[k], dim = PROP_DEFS[key].dim, p = this.store.renderProp(l, key);
        if (p?.kf && p.kf.length > 1) { this.pool.eval(this.sH[i * 10 + k], t, out, off); return; }
        // same values a static Track would produce: a single key wins over v, missing -> default
        const v = p ? (p.kf && p.kf.length === 1 ? p.kf[0].v : p.v) : key === 'fill' ? ZERO4 : (PROP_DEFS[key].default as unknown as number[]);
        for (let d = 0; d < dim; d++) out[off + d] = v[d] ?? 0;
      };
      const tmp = this.scratch;
      val(TR_ANCHOR, X, o8);
      val(TR_POS, X, o8 + 2);
      val(TR_SCALE, X, o8 + 4);
      val(TR_ROT, tmp, 0); X[o8 + 6] = tmp[0] * (Math.PI / 180);
      val(TR_OPA, tmp, 0); this.lopa[i] = Math.min(1, Math.max(0, tmp[0] / 100));
      val(TR_SIZE, S, os);
      val(TR_RAD, S, os + 2);
      val(TR_FILL, S, os + 6);
      val(TR_STROKE, S, os + 10);
      val(TR_SW, S, os + 14);
      this.composeLocal(i);
      return;
    }
    const m = this.sMask[i], em = this.sExpr[i];
    if (em) this.evalExprs(i, t);
    if (!m) { if (em & 0x0f) this.composeLocal(i); return; }
    const H = this.sH, h = i * 10, P = this.pool;
    if (m & 0x0f) {
      if (m & (1 << TR_ANCHOR)) P.eval(H[h + TR_ANCHOR], t, X, o8);
      if (m & (1 << TR_POS)) P.eval(H[h + TR_POS], t, X, o8 + 2);
      if (m & (1 << TR_SCALE)) P.eval(H[h + TR_SCALE], t, X, o8 + 4);
      if (m & (1 << TR_ROT)) { P.eval(H[h + TR_ROT], t, X, o8 + 6); X[o8 + 6] *= Math.PI / 180; }
    }
    // transform changed by keyframes and/or expressions
    if ((m | em) & 0x0f) this.composeLocal(i);
    if (m & (1 << TR_OPA)) { P.eval(H[h + TR_OPA], t, X, o8 + 7); const v = X[o8 + 7] / 100; this.lopa[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
    if (m & 0x3e0) {
      if (m & (1 << TR_SIZE)) P.eval(H[h + TR_SIZE], t, S, os);
      if (m & (1 << TR_RAD)) P.eval(H[h + TR_RAD], t, S, os + 2);
      if (m & (1 << TR_FILL)) P.eval(H[h + TR_FILL], t, S, os + 6);
      if (m & (1 << TR_STROKE)) P.eval(H[h + TR_STROKE], t, S, os + 10);
      if (m & (1 << TR_SW)) P.eval(H[h + TR_SW], t, S, os + 14);
    }
  }

  private exprTmp = new Float64Array(4);

  /** run the expressions of item i at time t and write results where the tracks would */
  private evalExprs(i: number, t: number) {
    const it = this.items[i], ex = it.exprs!, X = this.xf, S = this.style, o8 = i * 8, os = i * ST;
    const comp = this.store.comp;
    for (let k = 0; k < TR_KEYS.length; k++) {
      const e = ex[k];
      if (!e) continue;
      const tmp = this.exprTmp, c = e.fr, P = e.prog;
      c.time = t; // runProgram reads the keyframed value through c.valueAt when it needs it
      c.index = i;
      c.fps = comp.fps;
      c.duration = comp.duration;
      c.inPoint = it.layer.inPoint;
      switch (k) {
        case TR_ANCHOR: runProgram(P, c, X, o8); break;
        case TR_POS: runProgram(P, c, X, o8 + 2); break;
        case TR_SCALE: runProgram(P, c, X, o8 + 4); break;
        case TR_ROT: runProgram(P, c, X, o8 + 6); X[o8 + 6] *= Math.PI / 180; break;
        case TR_OPA: runProgram(P, c, tmp, 0); this.lopa[i] = Math.min(1, Math.max(0, tmp[0] / 100)); break;
        case TR_SIZE: runProgram(P, c, S, os); break;
        case TR_RAD: runProgram(P, c, S, os + 2); break;
        case TR_FILL: runProgram(P, c, S, os + 6); break;
        case TR_STROKE: runProgram(P, c, S, os + 10); break;
        case TR_SW: runProgram(P, c, S, os + 14); break;
      }
    }
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
  evaluate(t: number, all = true) { this.evaluateRange(t, 0, this.items.length, all); }

  // struct-of-arrays copies of the item fields the per-frame loops need
  private sPar = new Int32Array(0);
  private sTOff = new Float64Array(0);
  private sIn = new Float64Array(0);
  private sOut = new Float64Array(0);
  private sEnd = new Float64Array(0);
  /** bit 0 animated, bit 1 hidden */
  private sFlags = new Uint8Array(0);
  private sMask = new Int32Array(0);
  private sExpr = new Int32Array(0);
  private sH = new Int32Array(0);
  /** world matrix / opacity / visibility of item i changed in the last evaluation */
  private chg = new Uint8Array(0);
  private vis = new Uint8Array(0);
  /** instance slot item i was written to last frame (-1 = not drawn) */
  private lastK = new Int32Array(0);
  // what the instance writer needs per item without touching the item / layer objects
  // (at 25k layers those pointer chases were most of the write time: cache misses)
  private sKind = new Uint8Array(0);
  /** bit 0 layer is a mask, 1 isolation group, 2 per-unit text, 3 per-frame path raster */
  private sBits = new Uint8Array(0);
  private sBlend = new Uint8Array(0);
  private sAlign = new Int8Array(0);
  private sClip = new Int32Array(0);
  /** gradient kinds: inverse paint transform (6), ramp row, radial flag */
  private sGrad = new Float64Array(0);

  /** evaluates [from, to). items that are static, keep their visibility and whose parent did not
   *  change keep last frame's world matrix (all = recompute everything, e.g. after edits). */
  private evaluateRange(t: number, from: number, to: number, all: boolean) {
    const W = this.world, L = this.local, O = this.opa, LO = this.lopa;
    const PAR = this.sPar, TOFF = this.sTOff, IN = this.sIn, OUT = this.sOut, END = this.sEnd, FL = this.sFlags, CHG = this.chg, VIS = this.vis;
    for (let i = from; i < to; i++) {
      const tl = t - TOFF[i];
      const fl = FL[i];
      let c = all;
      if (fl & 1) { this.evalItem(i, tl); c = true; }
      const vis = (fl & 2) || tl < IN[i] || tl >= OUT[i] || t >= END[i] ? 0 : 1;
      if (vis !== VIS[i]) { VIS[i] = vis; c = true; }
      const p = PAR[i];
      if (p >= 0 && CHG[p]) c = true;
      if (!c) { CHG[i] = 0; continue; }
      CHG[i] = 1;
      const o = i * 6;
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

  private bucketOf(scale: number) { return Math.min(16, Math.max(1 / 16, Math.pow(2, Math.ceil(Math.log2(Math.max(scale, 1e-3)) * 2) / 2))); }

  private resolveRaster(i: number, scale: number, budgetEnd: number): boolean {
    const it = this.items[i];
    const l = it.layer;
    if (it.dyn) return this.resolveDyn(i, scale, budgetEnd);
    // fast path (no allocation): current raster is sharp enough and not wastefully large.
    // the 1x..2.83x window is hysteresis so animated scale doesn't thrash re-rasters.
    if (it.entry && !it.entry.dead && it.rasterScale >= scale * 0.999 && it.rasterScale <= scale * 2.83) {
      it.entry.lastUsed = this.atlas.frame;
      return true;
    }
    const bucket = this.bucketOf(scale);
    const key = `${it.rasterBase}@${bucket}`;
    const hit = this.atlas.get(key);
    if (hit && this.rasterMeta.has(key)) {
      it.rasterKey = key;
      it.raster = this.rasterMeta.get(key)!;
      it.entry = hit; it.rasterScale = bucket; it.rasterGen = this.atlas.generation;
      return true;
    }
    // shrinking but the current raster is still sharp: keep it (a smaller one is only nicer, not needed)
    if (it.entry && !it.entry.dead && it.rasterScale >= scale && performance.now() > budgetEnd) { this.pendingUpgrade = true; it.entry.lastUsed = this.atlas.frame; return true; }
    // have an older resolution? keep it and upgrade when time allows
    let hasOld = !!it.entry && !it.entry.dead;
    if (!hasOld) hasOld = this.lowerResFallback(it, bucket);
    else it.entry!.lastUsed = this.atlas.frame;
    const S = this.style, os = i * ST;
    // off the main thread: resolution upgrades, and anything beyond this frame's raster budget.
    // first-time rasters within budget stay synchronous so edits (typing, drawing) never flicker.
    if (l.type !== 'image' && this.workersOk && !this.syncRaster && (hasOld || performance.now() > budgetEnd)) {
      this.requestAsync(key, l, bucket, [S[os], S[os + 1]], [S[os + 2], S[os + 3], S[os + 4], S[os + 5]], S[os + 14]);
      return hasOld;
    }
    if (!hasOld && performance.now() > budgetEnd + 24) { this.pendingUpgrade = true; return false; }
    if (hasOld && performance.now() > budgetEnd) { this.pendingUpgrade = true; return true; }
    if (this.failed.get(key)! > this.atlas.frame - 30) return hasOld;
    const size = [S[os], S[os + 1]];
    // no room at this resolution (the atlas never evicts what this frame draws): go lower
    for (let bk = bucket; bk >= 1 / 16; bk /= 2) {
      const k2 = bk === bucket ? key : `${it.rasterBase}@${bk}`;
      let r: RasterResult | null = null;
      if (l.type === 'path') r = rasterPath(l, bk, S[os + 14]);
      else if (l.type === 'text') r = rasterText(l, bk, size);
      else if (l.type === 'image') {
        const asset = l.imageRef ? this.store.project.assets[l.imageRef] : undefined;
        r = asset ? rasterImage(asset, bk, size) : null;
      } else r = rasterShapePaint(l, bk, size, [S[os + 2], S[os + 3], S[os + 4], S[os + 5]], S[os + 14]);
      if (!r) return hasOld;
      const e = this.atlas.alloc(k2, r.pw, r.ph);
      if (!e) { if (bk === bucket) this.failed.set(key, this.atlas.frame); continue; }
      this.atlas.upload(e, r.data);
      r.data = undefined as any; // free memory, keep placement
      this.rasterMeta.set(k2, r);
      it.rasterKey = k2;
      it.raster = r;
      it.entry = e; it.rasterScale = bk; it.rasterGen = this.atlas.generation;
      if (bk !== bucket) this.pendingUpgrade = true;
      return true;
    }
    return hasOld;
  }
  /** keys whose raster did not fit the atlas recently (frame): don't retry every frame */
  private failed = new Map<string, number>();

  /** no usable raster: show a lower resolution of the same content if the atlas has one */
  private lowerResFallback(it: Item, bucket: number): boolean {
    for (let bk = bucket / Math.SQRT2; bk >= 1 / 16; bk /= Math.SQRT2) {
      const k2 = `${it.rasterBase}@${this.bucketOf(bk)}`;
      const e = this.atlas.get(k2), r = e && this.rasterMeta.get(k2);
      if (e && r) { it.rasterKey = k2; it.raster = r; it.entry = e; it.rasterScale = this.bucketOf(bk); it.rasterGen = this.atlas.generation; return true; }
    }
    return false;
  }
  private rasterMeta = new Map<string, RasterResult>();

  // ---------------- per-frame shapes (path morphs, trim paths) ----------------
  // drawn straight into a dedicated canvas that doubles as their texture (nothing to read back with
  // getImageData, no atlas key per frame, nothing to prune). slots come from a ring allocator: what
  // is drawn in one frame lands in one contiguous band of rows, so the upload is one or two
  // texSubImage2D calls of just those rows. a slot is reused while the shape still fits in it.
  private dynCanvas: OffscreenCanvas | null = null;
  private dynCtx: OffscreenCanvasRenderingContext2D | null = null;
  private dynTex: WebGLTexture | null = null;
  private dynH = 0;
  /** ring cursor: current row (y, height) and x within it; lap counts wrap-arounds */
  private dynX = 0; private dynY = 0; private dynRowH = 0; private dynLap = 0;
  /** live slots in allocation order (oldest first) */
  private dynQueue: (AtlasEntry & { lap: number })[] = [];
  private dynQHead = 0;
  private dynBands: number[] = []; // dirty row bands [y0, y1, ...]
  private dynGrow = false;
  private dynTexStale = true;
  dynResets = 0;
  /** shapes drawn this frame, and the measured cost (ms) per shape of drawing + uploading them */
  private dynDrawn = 0;
  private dynCost = 0.03;
  private dynOk = typeof OffscreenCanvas !== 'undefined';

  private dynSlot(w: number, h: number): AtlasEntry | null {
    const W = 2048;
    if (!this.dynCanvas) {
      this.dynH = 1024;
      this.dynCanvas = new OffscreenCanvas(W, this.dynH);
      // cpu-backed: the same rasterizer as the worker / atlas path, so the pixels match
      this.dynCtx = this.dynCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      this.dynTexStale = true;
    }
    if (w > W || h > this.dynH) return null;
    if (this.dynX + w > W) { this.dynY += this.dynRowH; this.dynX = 0; this.dynRowH = 0; }
    if (this.dynY + h > this.dynH) { this.dynY = 0; this.dynX = 0; this.dynRowH = 0; this.dynLap++; }
    const x = this.dynX, y = this.dynY;
    const rowEnd = y + Math.max(this.dynRowH, h);
    // slots of the previous lap under the new one are taken over (their layers redraw when reached).
    // a slot drawn this frame can't be: then the canvas is too small (grow before the next frame).
    const Q = this.dynQueue;
    while (this.dynQHead < Q.length) {
      const e = Q[this.dynQHead];
      if (e.dead) { this.dynQHead++; continue; }
      if (e.lap >= this.dynLap || e.y - 1 >= rowEnd) break;
      if (e.lastUsed === this.atlas.frame) { this.dynGrow = true; return null; }
      e.dead = true;
      this.dynQHead++;
    }
    if (this.dynQHead > 4096 && this.dynQHead * 2 > Q.length) { Q.splice(0, this.dynQHead); this.dynQHead = 0; }
    this.dynX += w;
    this.dynRowH = Math.max(this.dynRowH, h);
    const e = { key: '', page: -1, x: x + 1, y: y + 1, w: w - 2, h: h - 2, lastUsed: this.atlas.frame, lap: this.dynLap };
    Q.push(e);
    return e;
  }

  /** between frames: grow the canvas when one frame's shapes did not fit (every shape redraws) */
  private dynMaintain() {
    if (this.failed.size > 4096) this.failed.clear();
    if (!this.dynGrow) return;
    this.dynGrow = false;
    if (!this.dynCanvas || this.dynH >= 4096) return;
    for (let q = this.dynQHead; q < this.dynQueue.length; q++) this.dynQueue[q].dead = true;
    this.dynQueue = []; this.dynQHead = 0;
    this.dynX = this.dynY = this.dynRowH = 0;
    this.dynH *= 2;
    this.dynCanvas.height = this.dynH; // clears it
    this.dynTexStale = true;
    this.dynResets++;
  }

  private resolveDyn(i: number, scale: number, budgetEnd: number): boolean {
    const it = this.items[i], d = it.dyn!, l = it.layer;
    const alive = !!it.entry && !it.entry.dead;
    if (!d.need && alive && it.rasterScale >= scale * 0.999 && it.rasterScale <= scale * 2.83) { it.entry!.lastUsed = this.atlas.frame; return true; }
    // over budget: keep showing the last drawn frame, draw for real on the next render
    // (a shape with nothing to show is always drawn: layers never disappear)
    // (canvas drawing is deferred until the upload, so count what this frame drew at last frame's cost)
    if (alive && performance.now() + this.dynDrawn * this.dynCost > budgetEnd + 8) { it.entry!.lastUsed = this.atlas.frame; this.pendingUpgrade = true; return true; }
    const bucket = this.bucketOf(scale);
    const S = this.style, os = i * ST, sw = S[os + 14];
    const geo = d.pkf ? interpPathKeys(d.pkf, d.eases, d.t) : l.geometry;
    const tv = d.trim ? { start: d.trim[0].eval1(d.t) / 100, end: d.trim[1].eval1(d.t) / 100, offset: d.trim[2].eval1(d.t) / 360 } : undefined;
    const gl2 = geo === l.geometry ? l : { ...l, geometry: geo };
    if (it.kind === KIND_MASK && this.dynOk) {
      const pl = pathPlacement(gl2, bucket, sw, tv);
      let e = it.entry && it.entry.page === -1 && !it.entry.dead ? it.entry : null;
      // a slot drawn in an earlier frame is rewritten in place only if it is inside the band being
      // uploaded anyway; otherwise take a fresh slot from the ring (keeps the upload contiguous)
      if (!e || e.w < pl.pw || e.h < pl.ph || e.lastUsed !== this.atlas.frame) e = this.dynSlot(pl.pw + 2, pl.ph + 2);
      if (e) {
        drawPathMask(this.dynCtx!, pl, e.x, e.y, gl2, sw, tv);
        this.dynDrawn++;
        const B = this.dynBands, y0 = e.y - 1, y1 = e.y + pl.ph + 1;
        const n = B.length;
        if (n && y0 <= B[n - 1] && y1 >= B[n - 2]) { B[n - 2] = Math.min(B[n - 2], y0); B[n - 1] = Math.max(B[n - 1], y1); }
        else B.push(y0, y1);
        it.raster = { kind: 'mask', pw: pl.pw, ph: pl.ph, x: pl.x, y: pl.y, w: pl.pw / pl.s, h: pl.ph / pl.s, data: undefined as any };
        it.entry = e; it.rasterScale = bucket; it.rasterKey = null;
        e.lastUsed = this.atlas.frame;
        d.need = false;
        return true;
      }
      this.pendingUpgrade = true; // canvas too small: grows before the next frame; atlas meanwhile
    }
    // rgba paints (or no room): the atlas, under one key per layer (its slot is replaced each frame)
    const key = `${d.base}@dyn`;
    const r = rasterPath(gl2, bucket, sw, tv);
    if (!r) return alive;
    const e = this.atlas.alloc(key, r.pw, r.ph);
    if (!e) return alive;
    this.atlas.upload(e, r.data);
    r.data = undefined as any;
    it.rasterKey = key; it.raster = r; it.entry = e; it.rasterScale = bucket; it.rasterGen = this.atlas.generation;
    d.need = false;
    return true;
  }

  /** upload the rows per-frame shapes drew this frame and bind their texture */
  private flushDyn() {
    const gl = this.gl;
    if (!this.dynCanvas) return;
    gl.activeTexture(gl.TEXTURE4);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (!this.dynTex || this.dynTexStale) {
      if (!this.dynTex) this.dynTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.dynTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.dynCanvas as any);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.dynTexStale = false;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.dynTex);
      const B = this.dynBands, t0 = performance.now();
      for (let b = 0; b < B.length; b += 2) {
        const y0 = Math.max(0, B[b]), y1 = Math.min(this.dynH, B[b + 1]);
        if (y1 <= y0) continue;
        // whole rows: a dom source is uploaded from its top-left, rows below are selected with skip rows
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, 2048, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, this.dynCanvas as any);
      }
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      if (this.dynDrawn >= 8) this.dynCost = this.dynCost * 0.7 + 0.3 * ((performance.now() - t0) / this.dynDrawn);
    }
    this.dynDrawn = 0;
    this.dynBands.length = 0;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.uniform1f(this.uDynH, this.dynH);
    gl.activeTexture(gl.TEXTURE0);
  }
  private uDynH!: WebGLUniformLocation;

  // ---------------- async raster workers ----------------
  private workers: Worker[] = [];
  private workersOk = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
  private pending = new Map<number, string>(); // job id -> atlas key
  private pendingKeys = new Set<string>();
  private nextJob = 1;
  asyncRasters = 0;
  workerErrors: string[] = [];

  private requestAsync(key: string, l: Layer, bucket: number, size: number[], radius: number[], strokeWidth: number) {
    if (this.pendingKeys.has(key)) return;
    if (this.failed.get(key)! > this.atlas.frame - 30) return; // did not fit recently
    if (!this.workers.length) {
      try {
        for (let w = 0; w < 2; w++) {
          const worker = new Worker(new URL('./raster-worker.ts', import.meta.url), { type: 'module' });
          worker.onmessage = ev => this.onRasterDone(ev.data);
          worker.onerror = (ev) => {
            // fall back to main-thread rasters: drop pending jobs so their layers get rasterized again
            this.workersOk = false;
            this.workerErrors.push(String((ev as ErrorEvent).message ?? 'worker error'));
            for (const w of this.workers) w.terminate();
            this.workers = [];
            this.pending.clear();
            this.pendingKeys.clear();
            this.dirty = true;
          };
          this.workers.push(worker);
        }
      } catch { this.workersOk = false; return; }
    }
    const id = this.nextJob++;
    this.pending.set(id, key);
    this.pendingKeys.add(key);
    // plain data only (structured clone): strip nothing, layers are json
    this.workers[id % this.workers.length].postMessage({ id, layer: l, bucket, size, radius, strokeWidth });
  }

  private onRasterDone(msg: { id: number; result?: RasterResult | null; error?: string }) {
    const key = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (!key) return;
    this.pendingKeys.delete(key);
    if (msg.error) this.workerErrors.push(msg.error);
    const r = msg.result;
    if (!r) return;
    if (this.atlas.has(key)) return;
    const e = this.atlas.alloc(key, r.pw, r.ph);
    if (!e) { this.failed.set(key, this.atlas.frame); this.dirty = true; return; }
    this.atlas.upload(e, r.data);
    r.data = undefined as any;
    this.rasterMeta.set(key, r);
    this.asyncRasters++;
    this.dirty = true; // items pick the new key up on the next frame
  }

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

  /** render into this framebuffer instead of the canvas (effects, offscreen comps). the caller
   *  sets the view so the comp maps into it. null = canvas */
  target: { fb: WebGLFramebuffer; w: number; h: number } | null = null;
  setTarget(t: { fb: WebGLFramebuffer; w: number; h: number } | null) {
    if (t === this.target || (t && this.target && t.fb === this.target.fb && t.w === this.target.w && t.h === this.target.h)) return;
    this.target = t;
    this.dirty = true;
  }
  private targetW() { return this.target ? this.target.w : this.canvas.width; }
  private targetH() { return this.target ? this.target.h : this.canvas.height; }

  get hasAnimation() { return this.items.some(i => i.animated); }

  render(t: number, retry = false) {
    if (this.contextLost) return;
    const f0 = performance.now();
    // anything but the time moving (edits, view, rasters arriving, context restore) sets dirty:
    // then every instance is rewritten. during plain playback only changed items are.
    let full = !this.incremental || this.dirty || retry || this.syncRaster || this.cullOffscreen !== this.lastCull || this.needsCompile || this.dirtyLayers.size > 0;
    this.lastCull = this.cullOffscreen;
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
    this.dynMaintain();
    const e0 = performance.now();
    // same time + only a few layers edited (dragging while paused): re-evaluate just their subtrees
    if (t === this.evalTime && !this.evalAll && this.dirtyIdx.length && this.dirtyIdx.length < 64) {
      for (const i of this.dirtyIdx) this.evaluateRange(t, i, this.subEnd[i], true);
    } else if (t !== this.evalTime || this.evalAll || this.dirtyIdx.length) {
      this.evaluate(t, this.evalAll || this.dirtyIdx.length > 0);
    }
    this.evalTime = t;
    this.evalAll = false;
    this.dirtyIdx.length = 0;
    const e1 = performance.now();

    const items = this.items, n = items.length;
    const need = (n + 1 + this.unitCount) * F;
    if (this.inst.length < need) { this.inst = new Float32Array(Math.max(need, this.inst.length * 2)); full = true; }
    if (this.icap < this.inst.byteLength) full = true; // gpu buffer gets reallocated below
    const CHG = this.chg, lastK = this.lastK;
    if (this.instItem.length < this.inst.length / F) this.instItem = new Int32Array(this.inst.length / F);
    const IIT = this.instItem;
    const KIND = this.sKind, BITS = this.sBits, BLEND = this.sBlend, ALIGN = this.sAlign, CLIP = this.sClip;
    const frame = this.atlas.frame;
    // instance ranges written this frame (uploaded with bufferSubData per range)
    const ranges = this.ranges;
    ranges.length = 0;
    let rs = 0, re = 0;
    const I = this.inst, W = this.world, S = this.style, O = this.opa;
    const comp = store.comp;
    const z = this.zoom * this.dpr;
    let rasterMs = 0;
    const budgetEnd = this.syncRaster ? Infinity : performance.now() + this.rasterBudgetMs;
    this.pendingUpgrade = false;

    // composition background is a scissored clear (no fragment shader work)
    let k = 0;
    let culled = 0;
    const cullOn = this.cullOffscreen;
    const px0 = this.panX * this.dpr, py0 = this.panY * this.dpr, cw0 = this.targetW(), ch0 = this.targetH();
    const mask = this.drawnMask;
    const cmds = this.cmds;
    cmds.length = 0;
    let pending = 0; // first instance not yet covered by a DRAW command
    // open isolation regions: end index, composite opacity, divisor to restore, optional mask range
    const stack: { end: number; opacity: number; div: number; maskStart: number; maskCount: number; maskEnd: number; box: number }[] = [];
    // screen bounds (device px) of what each isolated region draws: its offscreen clear and its
    // composite are scissored to them (they used to clear + composite the whole canvas)
    const boxes = this.boxes;
    boxes.length = 0;
    const IB = this.instBox.length >= this.inst.length / F * 4 ? this.instBox : (this.instBox = new Float32Array(this.inst.length / F * 4).fill(NaN));
    const addBox = (kk: number) => {
      const bi = stack[stack.length - 1].box, o4 = kk * 4;
      const x0 = IB[o4];
      if (x0 !== x0) { boxes[bi] = -1e9; boxes[bi + 1] = -1e9; boxes[bi + 2] = 1e9; boxes[bi + 3] = 1e9; return; } // unknown: whole target
      if (x0 < boxes[bi]) boxes[bi] = x0;
      if (IB[o4 + 1] < boxes[bi + 1]) boxes[bi + 1] = IB[o4 + 1];
      if (IB[o4 + 2] > boxes[bi + 2]) boxes[bi + 2] = IB[o4 + 2];
      if (IB[o4 + 3] > boxes[bi + 3]) boxes[bi + 3] = IB[o4 + 3];
    };
    const newBox = () => { const bi = boxes.length; boxes.push(1e9, 1e9, -1e9, -1e9); return bi; };
    let div = 1; // opacity already applied by the enclosing isolated group (instances inside divide it out)
    let curBlend = 0;
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
        if (curBlend !== 0) { cmds.push(CMD_BLEND, 0, 0); curBlend = 0; }
        cmds.push(CMD_POP, r.box, r.opacity);
        if (stack.length) {
          // the composite lands inside the parent region
          const pb = stack[stack.length - 1].box, cb = r.box;
          boxes[pb] = Math.min(boxes[pb], boxes[cb]); boxes[pb + 1] = Math.min(boxes[pb + 1], boxes[cb + 1]);
          boxes[pb + 2] = Math.max(boxes[pb + 2], boxes[cb + 2]); boxes[pb + 3] = Math.max(boxes[pb + 3], boxes[cb + 3]);
        }
        div = r.div;
      }
      const top = stack[stack.length - 1];
      if (i === n) break;
      mask[i] = 0;
      if (O[i] <= 0.0005) { lastK[i] = -1; continue; }
      const bits = BITS[i], kind = KIND[i];
      if ((bits & 1) && !(top && top.maskEnd > i)) {
        // masks the following siblings: region = rest of the parent's subtree
        flush();
        const box = newBox();
        cmds.push(CMD_PUSH, box, 0);
        const par = this.sPar[i];
        const end = par >= 0 ? this.subEnd[par] : n;
        stack.push({ end, opacity: 1, div, maskStart: k, maskCount: 0, maskEnd: this.subEnd[i], box });
        isolated++;
      } else if ((bits & 2) && this.lopa[i] < 0.999 && this.subEnd[i] > i + 1 && !stack.some(r => r.maskEnd > i)) {
        // group opacity: render the group into its own layer, then composite once with its opacity
        flush();
        const box = newBox();
        cmds.push(CMD_PUSH, box, 0);
        stack.push({ end: this.subEnd[i], opacity: O[i] / div, div, maskStart: 0, maskCount: 0, maskEnd: -1, box });
        div = O[i];
        isolated++;
      }
      if (kind === KIND_NONE) continue;
      // blend mode changes split the draw (only when used)
      const bm = BLEND[i];
      if (bm !== curBlend) { flush(); cmds.push(CMD_BLEND, bm, 0); curBlend = bm; }
      if (bits & 4) {
        const r0 = performance.now();
        const k0 = k;
        k = this.writeUnits(i, k, t, div !== 1 ? O[i] / div : O[i], budgetEnd);
        rasterMs += performance.now() - r0;
        mask[i] = 1;
        lastK[i] = -1;
        for (let u = k0; u < k; u++) { IIT[u] = i; IB[u * 4] = NaN; if (stack.length) addBox(u); }
        if (k > k0) { if (k0 !== re) { if (re > rs) ranges.push(rs, re); rs = k0; } re = k; }
        continue;
      }
      // unchanged since last frame and still in the same slot: the instance data in the cpu
      // array and in the gpu buffer is still valid. skip the write and the upload.
      if (!full && !CHG[i] && !(bits & 8)) {
        const lk = lastK[i];
        if (lk < 0) continue;
        // (a raster evicted from the atlas meanwhile must be resolved again: fall through)
        let alive = true;
        if (kind >= KIND_MASK && kind <= KIND_RGBA) { const en = items[i].entry; if (en) { if (en.dead) alive = false; else en.lastUsed = frame; } } // keep its raster alive in the atlas lru
        if (lk === k && alive) {
          mask[i] = 1;
          IIT[k] = i;
          if (stack.length) addBox(k);
          k++;
          continue;
        }
      }
      lastK[i] = -1;
      const os = i * ST, o6 = i * 6;
      if (kind === KIND_RECT || kind === KIND_ELLIPSE) {
        if (S[os + 9] <= 0 && (S[os + 14] <= 0 || S[os + 13] <= 0)) continue;
      }
      let a = W[o6], b = W[o6 + 1], c = W[o6 + 2], d = W[o6 + 3], e = W[o6 + 4], f = W[o6 + 5];
      let w = S[os], h = S[os + 1];
      let u0 = 0, v0 = 0, u1 = 0, v1 = 0, page = 0;
      // viewport culling: skip layers whose (padded) box is completely off-screen.
      // saves rasterization + atlas space for raster layers and fill work for everything.
      if (cullOn && !(bits & 1)) {
        const pad = Math.max(w, h) * 0.25 + (S[os + 14] || 0) + 4 / z;
        // screen aabb of the padded box: center +- the absolute extents (same as its 4 corners)
        const hx = w / 2 + pad, hy = h / 2 + pad, mx = w / 2, my = h / 2;
        const cx = (a * mx + c * my + e) * z + px0, cy = (b * mx + d * my + f) * z + py0;
        const ex = (Math.abs(a) * hx + Math.abs(c) * hy) * z, ey = (Math.abs(b) * hx + Math.abs(d) * hy) * z;
        if (cx + ex < 0 || cy + ey < 0 || cx - ex > cw0 || cy - ey > ch0) { culled++; continue; }
      }
      if (bits & 8 && items[i].dyn) {
        const it = items[i] as Item & { dyn: NonNullable<Item['dyn']> };
        const fr = Math.round((t - it.tOff) * this.store.comp.fps);
        if (fr !== it.dyn.frame) {
          // same slot every frame (no per-frame atlas keys): just mark it for a redraw
          it.dyn.frame = fr;
          it.dyn.t = t - it.tOff;
          it.dyn.need = true;
        }
      }
      if (kind >= KIND_MASK && kind <= KIND_RGBA) {
        const it = items[i], l = it.layer;
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
          if (cur > 1e-3) {
            let boost = Math.min(8, Math.max(1, it.maxScale / cur));
            // ...but never beyond a share of an atlas page: big layers raster near their on-screen
            // size and upgrade (off-thread, old raster shown meanwhile) when they actually grow
            if (boost > 1) boost = Math.max(1, Math.min(boost, Math.sqrt(BOOST_AREA / Math.max(1, Math.abs(a * d - b * c) * w * h * z * z))));
            scale *= boost;
          }
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
      if (kind === KIND_RGBA) { I[o + 12] = 1; I[o + 13] = 1; I[o + 14] = 1; I[o + 15] = 1; }
      else if (kind >= KIND_GRECT) {
        // local box -> gradient space: inv(paint transform) * diag(1/w, 1/h)
        const G = this.sGrad, og = i * 8, iw = w ? 1 / w : 0, ih = h ? 1 / h : 0;
        I[o + 12] = G[og] * iw; I[o + 13] = G[og + 1] * iw; I[o + 14] = G[og + 2] * ih; I[o + 15] = G[og + 3] * ih;
        u0 = G[og + 4]; v0 = G[og + 5]; page = G[og + 6];
      } else { I[o + 12] = S[os + 6]; I[o + 13] = S[os + 7]; I[o + 14] = S[os + 8]; I[o + 15] = S[os + 9]; }
      I[o + 16] = S[os + 10]; I[o + 17] = S[os + 11]; I[o + 18] = S[os + 12]; I[o + 19] = S[os + 13];
      I[o + 20] = kind === KIND_MASK ? 0 : S[os + 14];
      I[o + 38] = this.sGrad[i * 8 + 7];
      I[o + 21] = ALIGN[i];
      I[o + 22] = div !== 1 ? O[i] / div : O[i];
      I[o + 23] = kind;
      I[o + 24] = u0; I[o + 25] = v0; I[o + 26] = u1; I[o + 27] = v1;
      I[o + 28] = page;
      this.writeClip(I, o, CLIP[i]);
      {
        // screen aabb of the quad (+ sdf aa / stroke padding), for scissoring isolated regions
        let pad = 2 / Math.max(1e-6, z * Math.sqrt(Math.abs(a * d - b * c)));
        if (kind < KIND_MASK || kind >= KIND_GRECT) pad += S[os + 14] > 0 ? S[os + 14] : 0;
        const hx = w / 2 + pad, hy = h / 2 + pad;
        const cx = (a * w / 2 + c * h / 2 + e) * z + px0, cy = (b * w / 2 + d * h / 2 + f) * z + py0;
        const ex = (Math.abs(a) * hx + Math.abs(c) * hy) * z + 2, ey = (Math.abs(b) * hx + Math.abs(d) * hy) * z + 2;
        const o4 = k * 4;
        IB[o4] = cx - ex; IB[o4 + 1] = cy - ey; IB[o4 + 2] = cx + ex; IB[o4 + 3] = cy + ey;
        if (stack.length) addBox(k);
      }
      mask[i] = 1;
      lastK[i] = k;
      IIT[k] = i;
      if (k !== re) { if (re > rs) ranges.push(rs, re); rs = k; }
      re = k + 1;
      k++;
    }
    if (re > rs) ranges.push(rs, re);
    flush();
    this.isolatedLastFrame = isolated;
    const w1 = performance.now();
    // atlas was repacked while writing instances: earlier uvs are stale, redo the frame once
    if (!retry && this.atlas.compactions + this.atlas.generation !== compactions0) { this.render(t, true); return; }

    // ---- gpu ----
    const gl = this.gl;
    this.atlas.flush(); // all raster uploads of this frame: at most one call per atlas page
    const cw = this.targetW(), ch = this.targetH();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target?.fb ?? null);
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(this.editorBg[0], this.editorBg[1], this.editorBg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    {
      const x0 = this.panX * this.dpr, y0 = this.panY * this.dpr;
      const x1 = x0 + comp.width * z, y1 = y0 + comp.height * z;
      const sx = Math.max(0, Math.round(x0)), sy = Math.max(0, Math.round(ch - y1));
      gl.enable(gl.SCISSOR_TEST);
      const sw0 = Math.max(0, Math.round(Math.min(cw, x1)) - sx), sh0 = Math.max(0, Math.round(Math.min(ch, ch - y0)) - sy);
      gl.scissor(sx, sy, sw0, sh0);
      this.baseScissor = this.clipToComp ? [sx, sy, sw0, sh0] : null;
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
    this.bindRamps();
    this.flushDyn();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    if (this.icap < this.inst.byteLength) {
      gl.bufferData(gl.ARRAY_BUFFER, this.inst.byteLength, gl.DYNAMIC_DRAW);
      this.icap = this.inst.byteLength;
    }
    let bytes = 0;
    if (full) { if (k) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, k * F); bytes = k * F * 4; }
    else {
      // merge ranges separated by small gaps (fewer calls), fall back to one union range when fragmented
      const GAP = 32;
      let a = -1, b = -1, calls = 0;
      const many = ranges.length > 128;
      for (let r = 0; r < ranges.length; r += 2) {
        const x = ranges[r], y = ranges[r + 1];
        if (a >= 0 && (many || x - b <= GAP)) { b = y; continue; }
        if (a >= 0) { gl.bufferSubData(gl.ARRAY_BUFFER, a * F * 4, this.inst, a * F, (b - a) * F); bytes += (b - a) * F * 4; calls++; }
        a = x; b = y;
      }
      if (a >= 0) { gl.bufferSubData(gl.ARRAY_BUFFER, a * F * 4, this.inst, a * F, (b - a) * F); bytes += (b - a) * F * 4; calls++; }
      void calls;
    }
    if (cmds.length === 3 && cmds[0] === CMD_DRAW && cmds[1] === 0) {
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, k); // common case: the whole scene in one call
    } else {
      this.boundVao = this.vao;
      this.runCommands(cmds);
    }
    gl.bindVertexArray(null);
    const g1 = performance.now();

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
    st.culled = culled;
    st.uploadBytes = bytes;
    this.lastTime = t;
    this.dirty = this.pendingUpgrade;
  }

  private writeClip(I: Float32Array, o: number, clip: number) {
    if (clip >= 0) {
      const W = this.world, S = this.style;
      const q = clip * 6, cs = clip * ST;
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
  }

  /** per-unit text animation: one instance per char/word/line, each with its own timing + transform */
  private writeUnits(i: number, k: number, t: number, opacity: number, budgetEnd: number): number {
    const it = this.items[i];
    const l = it.layer, ta = l.textAnim!, units = it.units!;
    const I = this.inst, W = this.world, S = this.style, os = i * ST, o6 = i * 6;
    const a0 = W[o6], b0 = W[o6 + 1], c0 = W[o6 + 2], d0 = W[o6 + 3], e0 = W[o6 + 4], f0 = W[o6 + 5];
    const z = this.zoom * this.dpr;
    const scale = Math.sqrt(Math.abs(a0 * d0 - b0 * c0)) * z * Math.max(1, ta.from.scale / 100);
    const bucket = this.bucketOf(scale);
    const lt = t - it.tOff;
    for (const u of units) {
      // raster per unit (cached in the atlas like any other raster)
      if (!u.entry || u.entry.dead || u.scale < scale * 0.999 || u.scale > scale * 2.83) {
        const key = `${it.rasterBase}#${ta.by}:${u.unit.index}:${u.unit.text}@${bucket}`;
        let e = this.atlas.get(key);
        let r = this.rasterMeta.get(key);
        if (!e || !r) {
          if (u.entry && !u.entry.dead && performance.now() > budgetEnd) { this.pendingUpgrade = true; }
          else {
            const fake = { ...l, text: { ...l.text!, content: u.unit.text, align: 'left' as const } };
            r = rasterText(fake, bucket, [0, 0]);
            e = this.atlas.alloc(key, r.pw, r.ph) ?? undefined;
            if (e) { this.atlas.upload(e, r.data); r.data = undefined as any; this.rasterMeta.set(key, r); }
          }
        }
        if (e && r) { u.entry = e; u.raster = r; u.scale = bucket; }
      }
      if (!u.entry || u.entry.dead || !u.raster) continue;
      u.entry.lastUsed = this.atlas.frame;
      // progress of this unit
      let p = (lt - l.inPoint - ta.start - u.delay) / Math.max(1e-3, ta.duration); // start is relative to the layer in point
      p = p <= 0 ? 0 : p >= 1 ? 1 : p;
      const e = u.ease(p);
      const f = ta.mode === 'in' ? 1 - e : e; // amount of the "from" state
      const op = opacity * (1 + (ta.from.opacity / 100 - 1) * f);
      if (op <= 0.0005) continue;
      const sc = 1 + (ta.from.scale / 100 - 1) * f;
      const rot = ta.from.rotation * f * Math.PI / 180;
      const cs = Math.cos(rot) * sc, sn = Math.sin(rot) * sc;
      const ux = u.unit.x, uy = u.unit.y, cx = ux + u.unit.w / 2, cy = uy + u.unit.h / 2;
      // U = T(c + offset) R S T(-c), then place raster at unit origin + raster offset
      const r = u.raster;
      const px = ux + r.x - cx, py = uy + r.y - cy;
      const ue = cx + ta.from.dx * f + cs * px - sn * py, uf = cy + ta.from.dy * f + sn * px + cs * py;
      const a = a0 * cs + c0 * sn, b = b0 * cs + d0 * sn, c = -a0 * sn + c0 * cs, d = -b0 * sn + d0 * cs;
      const o = k * F;
      I[o] = a; I[o + 1] = b; I[o + 2] = c; I[o + 3] = d;
      I[o + 4] = a0 * ue + c0 * uf + e0; I[o + 5] = b0 * ue + d0 * uf + f0;
      I[o + 6] = r.w; I[o + 7] = r.h;
      I[o + 8] = 0; I[o + 9] = 0; I[o + 10] = 0; I[o + 11] = 0;
      I[o + 12] = S[os + 6]; I[o + 13] = S[os + 7]; I[o + 14] = S[os + 8]; I[o + 15] = S[os + 9];
      I[o + 16] = 0; I[o + 17] = 0; I[o + 18] = 0; I[o + 19] = 0;
      I[o + 20] = 0; I[o + 21] = 0; I[o + 22] = op; I[o + 23] = KIND_MASK;
      const ent = u.entry;
      I[o + 24] = ent.x / 2048; I[o + 25] = ent.y / 2048; I[o + 26] = (ent.x + r.pw) / 2048; I[o + 27] = (ent.y + r.ph) / 2048;
      I[o + 28] = ent.page;
      this.writeClip(I, o, it.clip);
      k++;
    }
    return k;
  }

  /** premultiplied-alpha blend functions for the supported modes */
  private setBlend(mode: number) {
    const gl = this.gl;
    gl.blendEquation(gl.FUNC_ADD);
    switch (mode) {
      case 1: gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA); break; // multiply
      case 2: gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR); break; // screen
      case 3: gl.blendFunc(gl.ONE, gl.ONE); break; // add (linear dodge)
      case 4: gl.blendEquation(gl.MIN); gl.blendFunc(gl.ONE, gl.ONE); break; // darken (exact for opaque layers)
      case 5: gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE); break; // lighten
      default: gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  /** draw instances [start, start+count). webgl2 has no baseInstance, so the attributes have to
   *  point at the range: one cached vertex array per range start (one bind instead of re-pointing
   *  10 attributes per range; ranges are stable from frame to frame during playback) */
  private drawRange(start: number, count: number) {
    const gl = this.gl;
    let v = start === 0 ? this.vao : this.rangeVaos.get(start);
    if (!v) {
      if (this.rangeVaos.size >= 4096) { for (const x of this.rangeVaos.values()) gl.deleteVertexArray(x); this.rangeVaos.clear(); }
      v = gl.createVertexArray()!;
      gl.bindVertexArray(v);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.qbuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
      for (let a = 0; a < 10; a++) {
        gl.enableVertexAttribArray(1 + a);
        gl.vertexAttribPointer(1 + a, 4, gl.FLOAT, false, F * 4, start * F * 4 + a * 16);
        gl.vertexAttribDivisor(1 + a, 1);
      }
      this.rangeVaos.set(start, v);
    }
    if (v !== this.boundVao) { gl.bindVertexArray(v); this.boundVao = v; }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
  }
  private qbuf!: WebGLBuffer;
  private rangeVaos = new Map<number, WebGLVertexArrayObject>();
  private boundVao: WebGLVertexArrayObject | null = null;

  private fbo(depth: number) {
    const gl = this.gl;
    const w = this.targetW(), h = this.targetH();
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
    const base = this.target?.fb ?? null;
    const targets: (WebGLFramebuffer | null)[] = [base];
    const masks: (WebGLTexture | null)[] = [];
    // scissor per depth: the comp clip intersected with each open region's screen bounds
    const ch = this.targetH(), cw = this.targetW(), B = this.boxes;
    const bs = this.baseScissor ?? [0, 0, cw, ch];
    const sc: number[][] = [bs];
    const setSc = (r: number[]) => { gl.enable(gl.SCISSOR_TEST); gl.scissor(r[0], r[1], r[2], r[3]); };
    const regionSc = (bi: number, parent: number[]) => {
      // device px top-left box -> gl scissor (bottom-left), intersected with the parent scissor
      const x0 = Math.max(parent[0], Math.floor(B[bi])), x1 = Math.min(parent[0] + parent[2], Math.ceil(B[bi + 2]));
      const y0 = Math.max(parent[1], Math.floor(ch - B[bi + 3])), y1 = Math.min(parent[1] + parent[3], Math.ceil(ch - B[bi + 1]));
      return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
    };
    for (let c = 0; c < cmds.length; c += 3) {
      const type = cmds[c], a = cmds[c + 1], b = cmds[c + 2];
      if (type === CMD_DRAW) this.drawRange(a, b);
      else if (type === CMD_BLEND) this.setBlend(a);
      else if (type === CMD_PUSH) {
        const f = this.fbo(depth);
        depth++;
        targets.push(f.fb);
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
        const r = regionSc(a, sc[sc.length - 1]);
        sc.push(r);
        setSc(r);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else if (type === CMD_MASK) {
        // render the mask shape into its own layer; the composite multiplies by its alpha
        this.setBlend(0);
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
        // composite only the region's bounds, then back to the parent's scissor for its draws
        setSc(sc.pop()!);
        // composite the layer with a fullscreen quad
        gl.useProgram(this.compositeProgram());
        gl.uniform1f(this.cuOpacity, b);
        gl.uniform1f(this.cuUseMask, maskTex ? 1 : 0);
        if (maskTex) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, maskTex); }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        // unbind the layer textures: a later pass may render into these fbos (feedback loop otherwise)
        gl.bindTexture(gl.TEXTURE_2D, null);
        if (maskTex) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null); }
        gl.activeTexture(gl.TEXTURE0);
        gl.useProgram(this.prog);
        setSc(sc[sc.length - 1]);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, base);
    if (this.baseScissor) setSc(this.baseScissor); else gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.vao);
    this.boundVao = this.vao;
    this.setBlend(0);
  }

  // ---------------- queries (hit testing, bounds) ----------------

  /** comp-space corners of item's box [x0,y0,x1,y1,x2,y2,x3,y3] */
  corners(id: string): number[] | null {
    const i = this.index.get(id);
    if (i === undefined || this.items[i].layer.type === 'audio') return null; // audio has no box
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
    const prevSync = this.syncRaster;
    this.syncRaster = true;
    try { this.render(t); } finally { this.syncRaster = prevSync; }
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

/** ease name ("Expo Out", "spring:0.4") -> function */
export function easeFn(name: string): (p: number) => number {
  const m = /^spring(?::|\s+)?([\d.]+)?/i.exec(name.trim());
  if (m) { const b = m[1] ? +m[1] : 0.3; return p => springAt(b, p); }
  const pr = EASE_PRESETS.find(p => p.name.toLowerCase() === name.toLowerCase()) ?? EASE_PRESETS[1];
  return cubicBezier(pr.v[0], pr.v[1], pr.v[2], pr.v[3]);
}

function hashStr(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

/** interpolate keyframed path shapes (pairwise when command structures match, else hold) */
export function interpPathKeys(kf: PathKey[], eases: ((p: number) => number)[], t: number): PathGeometry[] {
  if (t <= kf[0].t) return kf[0].geometry;
  const last = kf[kf.length - 1];
  if (t >= last.t) return last.geometry;
  let i = 0;
  while (i < kf.length - 2 && kf[i + 1].t <= t) i++;
  const a = kf[i], b = kf[i + 1];
  if (a.interp === 'hold') return a.geometry;
  const p = eases[i]((t - a.t) / (b.t - a.t || 1));
  if (a.geometry.length !== b.geometry.length) return p < 0.5 ? a.geometry : b.geometry;
  return a.geometry.map((ga, gi) => {
    const gb = b.geometry[gi];
    if (ga.cmds.length !== gb.cmds.length) return p < 0.5 ? ga : gb;
    return {
      fillRule: ga.fillRule,
      cmds: ga.cmds.map((ca, ci) => {
        const cb = gb.cmds[ci];
        if (ca[0] !== cb[0]) return p < 0.5 ? ca : cb;
        return ca.map((v, k) => (k === 0 ? v : (v as number) + (((cb as any)[k] as number) - (v as number)) * p)) as any;
      }),
    };
  });
}
