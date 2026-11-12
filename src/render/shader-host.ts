// main-thread side of figma shaders: evaluates shader params (keyframes, expressions) per frame,
// sends render jobs to the sandboxed shader worker (render/shader-worker.ts), keeps the last good
// result of every shader layer as a gl texture and composites effect results.
//
// never blocks the renderer: a layer always draws its last good result (or a placeholder) while a
// newer one is being rendered; at most one job per layer is in flight (scrubbing coalesces to the
// latest frame). exports wait for the exact frame (settle()).
//
// effects: the renderer isolates the layer (and its children) into an offscreen target as for group
// opacity. at the end of that region the content is captured (blit + async pbo readback, or a sync
// readback during export) and sent to the worker; the composite draws the result texture at the
// region's comp-space rect. without webgpu (tests, node, old gpus) fills draw a placeholder and
// effects pass the content through unchanged (with one console warning).

import { Track } from '../core/evaluate';
import { compileExpr, compileProgram, runProgram, type ExprFrame, type ExprProgram } from '../core/expr';
import type { Layer, Prop } from '../core/model';
import { activeShaderEffects, activeShaderFill, hashFloats, propsOf, SHADER_MAIN, shaderPropKey, unflattenValue, type ShaderAsset, type ShaderParamDef, type ShaderRef } from '../core/shaders';
import type { Store } from '../core/store';
import type { FromWorker, ShaderJob, ShaderPass, ToWorker } from './shader-protocol';

/** device-pixel budget of one shader output (fills and effects) */
const MAX_PX = 2048 * 2048;
const MAX_SIDE = 4096;
/** a job that takes longer is considered hung: the worker is restarted, the shader marked failed */
const JOB_TIMEOUT = 15000;

interface ParamRT { def: ShaderParamDef; key: string; dim: number; off: number; track: Track; expr: { prog: ExprProgram; fr: ExprFrame } | null }

/** one shader (fill or effect) of a layer, compiled for evaluation */
export class SlotRT {
  readonly params: ParamRT[] = [];
  readonly vals: Float64Array;
  readonly modKey: string;
  /** hash of the module identity (results of another shader never match) */
  readonly modHash: number;
  readonly animated: boolean;
  readonly text: Record<string, string> | undefined;
  constructor(readonly ref: ShaderRef, readonly asset: ShaderAsset, layer: Layer, readonly inst: string, seed: number) {
    this.modKey = ref.shader;
    this.modHash = hashId(ref.shader + '|' + ref.slot) || 1;
    this.text = ref.text;
    const props = propsOf(layer);
    let off = 0;
    for (const def of asset.params) {
      const key = shaderPropKey(ref.slot, def.key);
      const p: Prop = props[key] ?? { v: [] };
      const dim = Math.max(1, p.v.length);
      const track = new Track(p, dim);
      let expr: ParamRT['expr'] = null;
      if (p.expr?.trim()) {
        const c = compileExpr(p.expr);
        if (c.node) {
          const fr: ExprFrame = { time: 0, index: 0, fps: 30, duration: 1, inPoint: 0, seed: (seed + off * 31) % 9973, keyTimes: (p.kf ?? []).map(f => f.t), value: new Float64Array(Math.max(4, dim)), valueAt: (tt, o) => track.eval(tt, o, 0), calls: 0 };
          expr = { prog: compileProgram(c.node, dim), fr };
        }
      }
      this.params.push({ def, key, dim, off, track, expr });
      off += dim;
    }
    this.vals = new Float64Array(off);
    let anim = !!asset.features.isAnimated;
    for (const q of this.params) if (q.track.animated || q.expr) anim = true;
    this.animated = anim;
  }

  /** evaluate every param at local time t into vals (no allocation) */
  eval(t: number, fps: number, duration: number, inPoint: number) {
    const V = this.vals;
    for (const q of this.params) {
      if (q.expr) {
        const fr = q.expr.fr;
        fr.time = t; fr.fps = fps; fr.duration = duration; fr.inPoint = inPoint;
        runProgram(q.expr.prog, fr, V, q.off);
      } else q.track.eval(t, V, q.off);
    }
  }

  /** frame.params for the module (built only when a job is sent) */
  toParams(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const q of this.params) out[q.def.key] = unflattenValue(q.def, this.vals, q.off, this.text?.[q.def.key]);
    return out;
  }
}

/** per renderer item: its shader fill and effects */
export interface ItemShaders {
  fill: SlotRT | null;
  fillOpacity: number;
  fx: SlotRT[];
  /** fill result */
  f: ResultState;
  /** effect chain result */
  e: ResultState;
  /** effects: this frame's plan (reused object), content generation + what it was derived from */
  frame: FxFrame | null;
  contentGen: number;
  childSig: number;
}

interface ResultState {
  tex: WebGLTexture | null;
  /** key of the result in tex */
  shown: number;
  /** key of the job in flight (-1 none) */
  req: number;
  job: number;
  /** effects: comp-space rect the result covers (x0, y0, x1, y1) */
  rect: Float64Array;
  reqRect: Float64Array;
  w: number;
  h: number;
  failed: string | null;
  /** key whose job failed: not re-sent every frame (a new key retries) */
  failedKey: number;
}

function newResult(): ResultState { return { tex: null, shown: -1, req: -1, job: 0, rect: new Float64Array(4), reqRect: new Float64Array(4), w: 0, h: 0, failed: null, failedKey: -1 }; }

/** frame-level request of an effect capture (filled by the renderer's instance pass) */
export interface FxFrame {
  item: number;
  shaders: ItemShaders;
  key: number;
  capture: boolean;
  /** screen rect in device px (top-left origin, integers, clamped to the target) */
  sx0: number; sy0: number; sx1: number; sy1: number;
  /** capture size (after the pixel budget) and render scale */
  cw: number; ch: number; rs: number;
  /** comp-space rect */
  rect: [number, number, number, number];
  time: number;
}

interface PendingCapture { pbo: WebGLBuffer; fence: WebGLSync; w: number; h: number; st: ResultState; build: (input: ArrayBuffer) => ShaderJob; frames: number }

const CVS = `#version 300 es
layout(location=0) in vec2 q;
uniform vec4 uRect;
out vec2 vUV;
void main() { vUV = vec2(q.x, 1.0 - q.y); gl_Position = vec4(mix(uRect.xy, uRect.zw, q), 0.0, 1.0); }`;
const CFS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform float uOpacity;
in vec2 vUV;
out vec4 o;
void main() { o = texture(uSrc, vUV) * uOpacity; }`;

let warned = false;

export class ShaderHost {
  private worker: Worker | null = null;
  /** null = unknown yet, false = no webgpu (placeholders) */
  available: boolean | null = null;
  adapter = '';
  error = '';
  private jobSeq = 1;
  private jobs = new Map<number, { st: ResultState; key: number; rect?: Float64Array; t0: number; insts: string[] }>();
  private waiters: (() => void)[] = [];
  /** shown result != wanted result for this many drawn layers in the last frame (exports wait for 0) */
  unsettled = 0;
  /** an edit or a result arrived: the renderer should redraw */
  onResult: (() => void) | null = null;
  private placeholder: WebGLTexture | null = null;
  private cprog: WebGLProgram | null = null;
  private uRect: WebGLUniformLocation | null = null;
  private uOpacity: WebGLUniformLocation | null = null;
  private capFb: WebGLFramebuffer | null = null;
  private capTex: WebGLTexture | null = null;
  private capW = 0;
  private capH = 0;
  private pboPool: WebGLBuffer[] = [];
  private captures: PendingCapture[] = [];
  /** recycled input buffers (returned by the worker) */
  private bufPool: ArrayBuffer[] = [];
  /** per-instance ids handed to the worker (released on dispose) */
  private live = new Set<string>();
  private lastJobT = performance.now();
  /** errors per shader asset key (inspector / agent) */
  readonly errors = new Map<string, string>();
  stats = { jobs: 0, lastMs: 0, uploads: 0, captures: 0 };

  constructor(private gl: WebGL2RenderingContext, private store: Store) {}

  /** start the worker on first use (documents without shaders never pay for it) */
  private ensureWorker(): boolean {
    if (this.available === false) return false;
    if (this.worker) return true;
    if (typeof Worker === 'undefined' || typeof navigator === 'undefined' || !('gpu' in navigator)) { this.disable('webgpu not available'); return false; }
    try {
      const w = new Worker(new URL('./shader-worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = e => this.onMessage(e.data as FromWorker);
      w.onerror = e => { this.disable(`shader worker: ${e.message}`); };
      this.worker = w;
      return true;
    } catch (e) {
      this.disable(String(e));
      return false;
    }
  }

  private disable(why: string) {
    this.available = false;
    this.error = why;
    if (!warned) { warned = true; console.warn(`[shaders] ${why}: shader fills draw a placeholder, shader effects are bypassed`); }
    this.worker?.terminate();
    this.worker = null;
    for (const j of this.jobs.values()) j.st.req = -1;
    this.jobs.clear();
    this.wake();
    this.onResult?.();
  }

  private post(m: ToWorker, tr: Transferable[] = []) { this.worker?.postMessage(m, tr); }

  private onMessage(m: FromWorker) {
    if (m.type === 'ready') {
      if (!m.ok) { this.disable(m.error ?? 'webgpu not available'); return; }
      this.available = true;
      this.adapter = m.adapter ?? '';
      // software webgpu (swiftshader): its gpu process falls over on webgpu -> webgl bitmap uploads
      if (/swiftshader|software|llvmpipe/i.test(this.adapter)) this.outMode = 'pixels';
      this.wake();
      this.onResult?.();
      return;
    }
    if (m.type === 'schema') return;
    const j = this.jobs.get(m.job);
    this.jobs.delete(m.job);
    if (m.input) this.bufPool.push(m.input);
    if (!j) { if (m.type === 'done') m.bitmap?.close(); return; }
    const st = j.st;
    if (st.job === m.job) st.req = -1;
    if (m.type === 'failed') {
      st.failed = m.error;
      st.failedKey = j.key;
      this.errors.set(j.insts[0] ?? '', m.error);
    } else {
      this.stats.jobs++;
      this.stats.lastMs = m.ms;
      if (m.errors?.length) { st.failed = m.errors.map(e => e.error).join('; '); st.failedKey = j.key; for (const e of m.errors) this.errors.set(e.inst, e.error); if (!warned) console.warn('[shaders]', st.failed); }
      else st.failed = null;
      if (m.bitmap || m.pixels) {
        if (m.bitmap) { this.upload(st, m.bitmap, m.w, m.h); m.bitmap.close(); }
        else this.upload(st, new Uint8Array(m.pixels!), m.w, m.h);
        st.shown = j.key;
        if (j.rect) st.rect.set(j.rect);
      }
    }
    this.wake();
    this.onResult?.();
  }

  private upload(st: ResultState, src: ImageBitmap | Uint8Array, w: number, h: number) {
    const gl = this.gl;
    if (!st.tex) st.tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, st.tex);
    // results are premultiplied: keep them as they are
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (src instanceof Uint8Array) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    st.w = w; st.h = h;
    this.stats.uploads++;
  }

  private wake() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }

  /** resolves on the next result (or after `ms`) */
  nextResult(ms = 2000): Promise<void> {
    return new Promise(res => { const to = setTimeout(res, ms); this.waiters.push(() => { clearTimeout(to); res(); }); });
  }

  // ------------------------------------------------------------------ items

  /** compile a layer's shaders (null when it has none) */
  attach(layer: Layer, item: number, prev: ItemShaders | null): ItemShaders | null {
    const fill = activeShaderFill(layer);
    const fx = activeShaderEffects(layer);
    if (!fill && !fx.length) { if (prev) this.detach(prev); return null; }
    const lib = this.store.project.shaders ?? {};
    const seed = hashId(layer.id);
    let fillRT: SlotRT | null = null;
    if (fill) { const a = lib[fill.ref.shader] ?? fill.ref.asset; if (a) fillRT = new SlotRT(fill.ref, a, layer, `${layer.id}:${fill.ref.slot}`, seed); }
    const fxRT: SlotRT[] = [];
    for (const r of fx) { const a = lib[r.shader] ?? r.asset; if (a && a.kind === 'effect') fxRT.push(new SlotRT(r, a, layer, `${layer.id}:${r.slot}`, seed)); }
    if (!fillRT && !fxRT.length) { if (prev) this.detach(prev); return null; }
    // keep the results (and the worker instances: frame.state) of the previous compile
    const out: ItemShaders = { fill: fillRT, fillOpacity: fill?.paint.opacity ?? 1, fx: fxRT, f: prev?.f ?? newResult(), e: prev?.e ?? newResult(), frame: prev?.frame ?? null, contentGen: (prev?.contentGen ?? 0) + 1, childSig: 0 };
    void item;
    if (this.available !== false) this.ensureWorker();
    return out;
  }

  detach(s: ItemShaders) {
    const gl = this.gl;
    if (s.f.tex) gl.deleteTexture(s.f.tex);
    if (s.e.tex) gl.deleteTexture(s.e.tex);
    s.f.tex = s.e.tex = null;
    for (const r of [s.fill, ...s.fx]) if (r && this.live.delete(r.inst)) this.post({ type: 'dispose', inst: r.inst });
  }

  private pass(r: SlotRT): ShaderPass {
    this.live.add(r.inst);
    const a = r.asset;
    return { inst: r.inst, mod: { key: r.modKey, code: a.files[SHADER_MAIN] ?? '' }, params: r.toParams() };
  }

  /** how results come back: 'bitmap' (gpu to gpu where the browser can) or 'pixels' (a readback:
   *  slower, works everywhere). switches to pixels by itself when bitmaps take the gl context down */
  outMode: 'bitmap' | 'pixels' = typeof location !== 'undefined' && /[?&]shaderpixels\b/.test(location.search) ? 'pixels' : 'bitmap';

  /** the renderer's gl context was lost: bitmap results are suspect, use readbacks from now on */
  contextLost() {
    if (this.outMode === 'bitmap' && this.stats.uploads > 0) { this.outMode = 'pixels'; console.warn('[shaders] gl context lost after shader frames: switching to pixel readback'); }
  }

  private send(job: ShaderJob, st: ResultState, key: number, rect?: Float64Array) {
    job.out = this.outMode;
    st.req = key;
    st.job = job.job;
    this.jobs.set(job.job, { st, key, rect, t0: performance.now(), insts: job.passes.map(p => p.inst) });
    this.lastJobT = performance.now();
    this.post(job, job.input ? [job.input.data] : []);
  }

  /** the size a shader output renders at: `rs` device px per unit, within the pixel budget */
  static budget(w: number, h: number, rs: number): number {
    // quantize (quarter octaves): zooming doesn't re-render every frame, and it stays sharp
    let q = Math.pow(2, Math.ceil(Math.log2(Math.max(rs, 1 / 64)) * 4) / 4);
    const area = Math.max(1e-6, w * h);
    q = Math.min(q, Math.sqrt(MAX_PX / area), MAX_SIDE / Math.max(w, h, 1e-6));
    return Math.max(q, 1e-3);
  }

  /** fill of item: request the frame (if the shown one is stale), return the texture to draw */
  fill(s: ItemShaders, w: number, h: number, rs: number, tLocal: number, comp: { fps: number; duration: number }, inPoint: number): WebGLTexture {
    const r = s.fill!;
    r.eval(tLocal, comp.fps, comp.duration, inPoint);
    const q = ShaderHost.budget(w, h, rs);
    const pw = Math.max(1, Math.round(w * q)), ph = Math.max(1, Math.round(h * q));
    const st = s.f;
    if (this.available !== false && this.ensureWorker()) {
      let key = hashFloats(r.modHash, r.vals);
      const k = this.keyScratch;
      k[0] = pw; k[1] = ph; k[2] = q; k[3] = r.asset.features.isAnimated ? tLocal : 0;
      key = hashFloats(key, k, 4);
      if (key !== st.shown) {
        // (no jobs before the worker reported its adapter: the result transport depends on it)
        if (st.req === -1 && st.failedKey !== key && this.available === true) {
          const job: ShaderJob = { type: 'render', job: this.jobSeq++, w: pw, h: ph, renderScale: q, time: tLocal * 1000, deltaTime: 1000 / comp.fps, mouse: null, passes: [this.pass(r)] };
          this.send(job, st, key);
        }
        if (st.failedKey !== key) this.unsettled++;
      }
    }
    return st.tex ?? this.placeholderTex();
  }

  private placeholderTex(): WebGLTexture {
    if (this.placeholder) return this.placeholder;
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, t);
    // a soft neutral checker (premultiplied): visibly "shader goes here", never mistaken for content
    const n = 8, d = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const o = (y * n + x) * 4, v = ((x >> 2) + (y >> 2)) & 1 ? 120 : 90; d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 160; }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.activeTexture(gl.TEXTURE0);
    this.placeholder = t;
    return t;
  }

  /** effect of item: decide whether the content must be captured this frame. returns false when
   *  effects can't run (no webgpu): the renderer then composites the content unchanged */
  fxPlan(f: FxFrame, s: ItemShaders, tLocal: number, contentGen: number, comp: { fps: number; duration: number }, inPoint: number): boolean {
    if (this.available === false || !this.ensureWorker()) return false;
    let key = 0x811c9dc5, anim = false;
    for (const r of s.fx) { key = Math.imul(key ^ r.modHash, 16777619); r.eval(tLocal, comp.fps, comp.duration, inPoint); key = hashFloats(key, r.vals); if (r.asset.features.isAnimated) anim = true; }
    const k = this.keyScratch;
    k[0] = f.cw; k[1] = f.ch; k[2] = f.rs; k[3] = f.rect[0]; k[4] = f.rect[1]; k[5] = f.rect[2]; k[6] = f.rect[3]; k[7] = anim ? tLocal : 0; k[8] = contentGen; k[9] = s.fx.length;
    key = hashFloats(key, k);
    f.key = key;
    f.time = tLocal;
    const st = s.e;
    f.capture = key !== st.shown && st.req === -1 && st.failedKey !== key && this.available === true;
    if (key !== st.shown && st.failedKey !== key) this.unsettled++;
    return true;
  }
  private keyScratch = new Float64Array(10);

  // ------------------------------------------------------------------ effects (gl side, called from runCommands)

  /** capture the region from `srcTex` (the isolated layer, target-sized) and send it to the worker */
  capture(f: FxFrame, srcTex: WebGLTexture, targetW: number, targetH: number, sync: boolean) {
    const gl = this.gl;
    const cw = f.cw, ch = f.ch;
    this.ensureCapture(cw, ch);
    // copy the region into the capture target with a quad (scaled when over budget), flipped so the
    // rows read back top-down. (a flipped blitFramebuffer took the gpu process down on swiftshader)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.capFb);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.useProgram(this.copyProgram());
    gl.uniform4f(this.uSrc, f.sx0 / targetW, 1 - f.sy0 / targetH, f.sx1 / targetW, 1 - f.sy1 / targetH);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.BLEND);
    gl.viewport(0, 0, targetW, targetH);
    const s = f.shaders, st = s.e;
    const rect = Float64Array.from(f.rect);
    const passes = s.fx.map(r => this.pass(r));
    const build = (input: ArrayBuffer): ShaderJob => ({ type: 'render', job: this.jobSeq++, w: cw, h: ch, renderScale: f.rs, time: f.time * 1000, deltaTime: 0, mouse: null, passes, input: { w: cw, h: ch, data: input } });
    const bytes = cw * ch * 4;
    st.req = f.key; // reserved: no second capture while this one is in flight
    st.job = -1;
    this.stats.captures++;
    if (sync) {
      const buf = this.takeBuf(bytes);
      gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(buf, 0, bytes));
      this.send(build(buf), st, f.key, rect);
    } else {
      const pbo = this.pboPool.pop() ?? gl.createBuffer()!;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
      const key = f.key;
      this.captures.push({ pbo, fence, w: cw, h: ch, st, build: input => { const j = build(input); st.req = key; return j; }, frames: 0 });
      (this.captures[this.captures.length - 1] as PendingCapture & { key: number; rect: Float64Array }).key = key;
      (this.captures[this.captures.length - 1] as PendingCapture & { key: number; rect: Float64Array }).rect = rect;
    }
  }

  /** async captures whose readback finished: send them (call once per frame, before drawing) */
  poll() {
    if (!this.captures.length) { this.watchdog(); return; }
    const gl = this.gl;
    for (let i = 0; i < this.captures.length; i++) {
      const c = this.captures[i] as PendingCapture & { key: number; rect: Float64Array };
      const s = gl.clientWaitSync(c.fence, 0, 0);
      if (s === gl.TIMEOUT_EXPIRED && c.frames++ < 30) continue;
      gl.deleteSync(c.fence);
      const bytes = c.w * c.h * 4;
      const buf = this.takeBuf(bytes);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, c.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, new Uint8Array(buf, 0, bytes));
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.pboPool.push(c.pbo);
      this.captures.splice(i--, 1);
      if (this.worker) this.send(c.build(buf), c.st, c.key, c.rect); else c.st.req = -1;
    }
    this.watchdog();
  }

  private watchdog() {
    if (!this.jobs.size || performance.now() - this.lastJobT < JOB_TIMEOUT) return;
    let oldest = Infinity;
    for (const j of this.jobs.values()) oldest = Math.min(oldest, j.t0);
    if (performance.now() - oldest < JOB_TIMEOUT) return;
    // hung (an endless loop in a module): restart the worker, fail the jobs in flight
    console.warn('[shaders] a shader job timed out: restarting the shader worker');
    for (const j of this.jobs.values()) { j.st.req = -1; j.st.failed = 'timed out'; j.st.failedKey = j.key; for (const i of j.insts) this.errors.set(i, 'timed out'); }
    this.jobs.clear();
    this.live.clear();
    this.worker?.terminate();
    this.worker = null;
    this.wake();
  }

  private takeBuf(bytes: number): ArrayBuffer {
    for (let i = 0; i < this.bufPool.length; i++) if (this.bufPool[i].byteLength === bytes) return this.bufPool.splice(i, 1)[0];
    if (this.bufPool.length > 8) this.bufPool.shift();
    return new ArrayBuffer(bytes);
  }

  private ensureCapture(w: number, h: number) {
    const gl = this.gl;
    if (this.capFb && this.capW >= w && this.capH >= h) return;
    if (this.capTex) gl.deleteTexture(this.capTex);
    if (this.capFb) gl.deleteFramebuffer(this.capFb);
    this.capW = Math.max(w, this.capW); this.capH = Math.max(h, this.capH);
    this.capTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.capTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.capW, this.capH);
    this.capFb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.capFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.capTex, 0);
  }

  /** draw the effect result (comp-space rect -> target) with opacity; false = no result yet */
  composite(s: ItemShaders, view: { z: number; px: number; py: number; w: number; h: number }, opacity: number): boolean {
    const st = s.e;
    if (!st.tex || st.shown === -1) return false;
    const gl = this.gl;
    const p = this.program();
    gl.useProgram(p);
    const r = st.rect;
    const x0 = ((r[0] * view.z + view.px) / view.w) * 2 - 1, x1 = ((r[2] * view.z + view.px) / view.w) * 2 - 1;
    const y0 = 1 - ((r[3] * view.z + view.py) / view.h) * 2, y1 = 1 - ((r[1] * view.z + view.py) / view.h) * 2;
    gl.uniform4f(this.uRect, x0, y0, x1, y1);
    gl.uniform1f(this.uOpacity, opacity);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, st.tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    return true;
  }

  private copy: WebGLProgram | null = null;
  private uSrc: WebGLUniformLocation | null = null;
  private copyProgram(): WebGLProgram {
    if (this.copy) return this.copy;
    const gl = this.gl;
    const sh = (type: number, src: string) => { const x = gl.createShader(type)!; gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x) ?? ''); return x; };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, `#version 300 es
layout(location=0) in vec2 q;
uniform vec4 uSrcRect;
out vec2 vUV;
void main() { vUV = mix(uSrcRect.xy, uSrcRect.zw, q); gl_Position = vec4(q * 2.0 - 1.0, 0.0, 1.0); }`));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform sampler2D uSrc;
in vec2 vUV;
out vec4 o;
void main() { o = texture(uSrc, vUV); }`));
    gl.linkProgram(p);
    this.copy = p;
    this.uSrc = gl.getUniformLocation(p, 'uSrcRect');
    gl.useProgram(p);
    gl.uniform1i(gl.getUniformLocation(p, 'uSrc'), 1);
    return p;
  }

  private program(): WebGLProgram {
    if (this.cprog) return this.cprog;
    const gl = this.gl;
    const sh = (type: number, src: string) => { const x = gl.createShader(type)!; gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x) ?? ''); return x; };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, CVS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, CFS));
    gl.linkProgram(p);
    this.cprog = p;
    this.uRect = gl.getUniformLocation(p, 'uRect');
    this.uOpacity = gl.getUniformLocation(p, 'uOpacity');
    gl.useProgram(p);
    gl.uniform1i(gl.getUniformLocation(p, 'uSrc'), 1);
    return p;
  }

  /** gl context restored: every gl object is gone (results re-render on demand) */
  contextRestored() {
    this.placeholder = null; this.cprog = null; this.copy = null; this.capFb = null; this.capTex = null; this.capW = this.capH = 0;
    this.pboPool = []; this.captures = [];
  }

  /** jobs in flight (stats / tests) */
  get inflight() { return this.jobs.size + this.captures.length; }
}

function hashId(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
