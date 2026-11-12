/// <reference types="@webgpu/types" />
// figma shader host: runs figma shader modules (fills and effects) exactly as figma does, on a
// webgpu device, in this dedicated worker. the modules come from pasted / opened documents, so they
// are untrusted: they never run on the main thread, and before the first one runs this worker drops
// every network / storage / messaging api it has (fetch, xhr, websockets, importScripts, indexeddb,
// caches, nested workers, postMessage). the only way out is the host's own (captured) postMessage,
// which sends rendered pixels as transferables.
//
// host contract (derived from the figma shader library, see NOTES.md "Figma shaders"):
//   import { defineProperties } from 'figma:shaders'
//   export default function Effect() {}
//   export function setup(device: GPUDevice, frame)      once per instance (frame.state is fresh)
//   export function render(device: GPUDevice, frame)     every frame
//   export function cleanup?(device, frame)              optional, when the instance goes away
//   defineProperties(Effect, { param: { type, label, defaultValue, control, ... } })
// frame:
//   state           object persisted across render calls of one instance
//   params          every param, defaults filled in (modules read them without fallbacks)
//   output          GPUTexture rgba8unorm, premultiplied; width/height = device pixels
//   input           effects: GPUTexture rgba8unorm of the rendered layer (premultiplied sRGB), else null
//   renderScale     device pixels per design unit (design size = output.width / renderScale)
//   time, deltaTime milliseconds
//   mousePosition   {x, y} in output pixels (usesMouse) or null
//   inputPadding, outputPadding   pixels (0: motion renders effects at the layer bounds)

import { transform } from 'sucrase';
import type { FromWorker, ShaderJob, ShaderModuleSrc, ToWorker } from './shader-protocol';

interface WorkerScope { postMessage(m: unknown, t?: Transferable[]): void; addEventListener(t: 'message', fn: (e: MessageEvent) => void): void }
const scope = self as unknown as WorkerScope;
const postRaw = scope.postMessage.bind(scope);
const post = (m: FromWorker, t: Transferable[] = []) => postRaw(m, t);
const onMsg = (fn: (m: ToWorker) => void) => scope.addEventListener('message', e => fn(e.data as ToWorker));

// ---- sandbox: remove every way out before any module runs (own props and up the prototype chain)
const BLOCK = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebTransport', 'EventSource', 'importScripts', 'indexedDB', 'caches',
  'BroadcastChannel', 'Worker', 'SharedWorker', 'postMessage', 'close', 'Request', 'Response', 'FileReaderSync', 'cookieStore', 'serviceWorker'];
function lockDown() {
  let o: object | null = scope;
  while (o && o !== Object.prototype) {
    for (const k of BLOCK) {
      if (Object.prototype.hasOwnProperty.call(o, k)) {
        try { Object.defineProperty(o, k, { value: undefined, writable: false, configurable: false }); } catch { /* not configurable */ }
      }
    }
    o = Object.getPrototypeOf(o);
  }
  for (const k of BLOCK) { try { Object.defineProperty(scope, k, { value: undefined, writable: false, configurable: false }); } catch { /* */ } }
  try { Object.defineProperty(navigator, 'sendBeacon', { value: undefined }); } catch { /* */ }
}

// ---- modules

interface Mod {
  setup?: (d: GPUDevice, f: Frame) => void;
  render?: (d: GPUDevice, f: Frame) => void;
  cleanup?: (d: GPUDevice, f: Frame) => void;
  schema: Record<string, unknown> | null;
  error?: string;
}
const mods = new Map<string, Mod>();

function loadModule(src: ShaderModuleSrc): Mod {
  let m = mods.get(src.key);
  if (m) return m;
  m = { schema: null };
  try {
    const js = transform(src.code, { transforms: ['typescript', 'imports'], disableESTransforms: true }).code;
    const exports: Record<string, unknown> = {};
    const mod = m;
    const shim = {
      defineProperties(_e: unknown, props: Record<string, unknown>) { mod.schema = props; },
    };
    const req = (name: string) => {
      if (name === 'figma:shaders') return shim;
      throw new Error(`import of '${name}' is not available to shaders`);
    };
    // eslint-disable-next-line no-new-func
    new Function('require', 'exports', 'module', `"use strict";\n${js}\n//# sourceURL=shader-${src.key.replace(/[^\w.-]/g, '_')}.js`)(req, exports, { exports });
    m.setup = typeof exports.setup === 'function' ? exports.setup as Mod['setup'] : undefined;
    m.render = typeof exports.render === 'function' ? exports.render as Mod['render'] : undefined;
    m.cleanup = typeof exports.cleanup === 'function' ? exports.cleanup as Mod['cleanup'] : undefined;
    if (!m.render) m.error = 'module exports no render()';
  } catch (e) {
    m.error = `compile: ${(e as Error)?.message ?? e}`;
  }
  mods.set(src.key, m);
  return m;
}

// ---- device

let device: GPUDevice | null = null;
let devicePromise: Promise<GPUDevice> | null = null;
let adapterName = '';
async function getDevice(): Promise<GPUDevice> {
  if (device) return device;
  if (!devicePromise) {
    devicePromise = (async () => {
      const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
      if (!gpu) throw new Error('webgpu not available');
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('no webgpu adapter');
      const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
      adapterName = info ? `${info.vendor} ${info.architecture}`.trim() : 'webgpu';
      // the optional features figma's shaders may rely on, when the adapter has them
      const want: GPUFeatureName[] = ['float32-filterable', 'rg11b10ufloat-renderable', 'bgra8unorm-storage'] as GPUFeatureName[];
      const requiredFeatures = want.filter(f => adapter.features.has(f));
      const d = await adapter.requestDevice({ requiredFeatures });
      d.lost.then(info => { console.warn('[shader] webgpu device lost:', info.reason, info.message); device = null; devicePromise = null; for (const i of insts.values()) i.lost = true; insts.clear(); });
      d.addEventListener('uncapturederror', e => console.warn('[shader]', (e as GPUUncapturedErrorEvent).error?.message));
      device = d;
      return d;
    })();
    devicePromise.catch(() => { devicePromise = null; });
  }
  return devicePromise;
}

// ---- instances

interface Frame {
  state: Record<string, unknown>;
  params: Record<string, unknown>;
  output: GPUTexture;
  input: GPUTexture | null;
  renderScale: number;
  time: number;
  deltaTime: number;
  mousePosition: { x: number; y: number } | null;
  inputPadding: number;
  outputPadding: number;
}
interface Inst { key: string; mod: Mod; frame: Frame | null; out: GPUTexture | null; setupDone: boolean; failed: string | null; lastTime: number; lost?: boolean }
const insts = new Map<string, Inst>();

const TEX_USAGE = () => GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING;

function outTex(d: GPUDevice, inst: Inst, w: number, h: number): GPUTexture {
  if (inst.out && inst.out.width === w && inst.out.height === h) return inst.out;
  inst.out?.destroy();
  inst.out = d.createTexture({ size: [w, h, 1], format: 'rgba8unorm', usage: TEX_USAGE() });
  return inst.out;
}

let inputTex: GPUTexture | null = null;
function inputTexture(d: GPUDevice, w: number, h: number): GPUTexture {
  if (inputTex && inputTex.width === w && inputTex.height === h) return inputTex;
  inputTex?.destroy();
  inputTex = d.createTexture({ size: [w, h, 1], format: 'rgba8unorm', usage: TEX_USAGE() });
  return inputTex;
}

function dispose(id: string) {
  const inst = insts.get(id);
  if (!inst) return;
  insts.delete(id);
  if (device && inst.frame && inst.mod.cleanup && !inst.lost) { try { inst.mod.cleanup(device, inst.frame); } catch { /* */ } }
  inst.out?.destroy();
}

/** transparent output when every pass of a job failed */
let blank: GPUTexture | null = null;
function blankTexture(d: GPUDevice, w: number, h: number): GPUTexture {
  if (blank && blank.width === w && blank.height === h) return blank;
  blank?.destroy();
  blank = d.createTexture({ size: [w, h, 1], format: 'rgba8unorm', usage: TEX_USAGE() });
  return blank; // fresh textures are zero (transparent)
}

// ---- output

function toBitmap(d: GPUDevice, tex: GPUTexture, w: number, h: number): ImageBitmap {
  // a fresh canvas per frame: reusing one canvas context after transferToImageBitmap lost the
  // device on the next frame (chromium + swiftshader), and the canvas itself is cheap
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!ctx) throw new Error('no webgpu canvas context');
  ctx.configure({ device: d, format: 'rgba8unorm', alphaMode: 'premultiplied', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  const enc = d.createCommandEncoder();
  enc.copyTextureToTexture({ texture: tex }, { texture: ctx.getCurrentTexture() }, [w, h, 1]);
  d.queue.submit([enc.finish()]);
  const bm = canvas.transferToImageBitmap();
  return bm;
}

async function toPixels(d: GPUDevice, tex: GPUTexture, w: number, h: number): Promise<ArrayBuffer> {
  const bpr = Math.ceil(w * 4 / 256) * 256;
  const buf = d.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = d.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h, 1]);
  d.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buf.getMappedRange());
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(src.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
  buf.unmap();
  buf.destroy();
  return out.buffer;
}

// ---- jobs

async function runJob(job: ShaderJob) {
  const t0 = performance.now();
  const d = await getDevice();
  const w = Math.max(1, Math.min(8192, job.w | 0)), h = Math.max(1, Math.min(8192, job.h | 0));
  let input: GPUTexture | null = null;
  if (job.input) {
    const iw = job.input.w, ih = job.input.h;
    input = inputTexture(d, iw, ih);
    d.queue.writeTexture({ texture: input }, job.input.data, { bytesPerRow: iw * 4 }, [iw, ih, 1]);
  }
  const errors: { inst: string; error: string }[] = [];
  let last: GPUTexture | null = input;
  for (const pass of job.passes) {
    const mod = loadModule(pass.mod);
    let inst = insts.get(pass.inst);
    if (inst && inst.key !== pass.mod.key) { dispose(pass.inst); inst = undefined; }
    if (!inst) { inst = { key: pass.mod.key, mod, frame: null, out: null, setupDone: false, failed: null, lastTime: NaN }; insts.set(pass.inst, inst); }
    if (mod.error) { errors.push({ inst: pass.inst, error: mod.error }); continue; }
    if (inst.failed) { errors.push({ inst: pass.inst, error: inst.failed }); continue; }
    const out = outTex(d, inst, w, h);
    const f = inst.frame ?? (inst.frame = { state: {}, params: {}, output: out, input: null, renderScale: 1, time: 0, deltaTime: 0, mousePosition: null, inputPadding: 0, outputPadding: 0 });
    f.output = out;
    f.input = last;
    f.params = pass.params;
    f.renderScale = job.renderScale > 0 ? job.renderScale : 1;
    f.deltaTime = job.deltaTime ?? (Number.isFinite(inst.lastTime) ? job.time - inst.lastTime : 16);
    f.time = job.time;
    inst.lastTime = job.time;
    f.mousePosition = job.mouse;
    d.pushErrorScope('validation');
    d.pushErrorScope('out-of-memory');
    let thrown: unknown = null, inSetup = false;
    try {
      if (!inst.setupDone) { inst.setupDone = true; inSetup = true; mod.setup?.(d, f); inSetup = false; }
      mod.render!(d, f);
    } catch (e) { thrown = e; }
    // (chromium can reject popErrorScope with "Instance dropped" after a canvas transfer: no error)
    const oom = await d.popErrorScope().catch(() => null);
    const val = await d.popErrorScope().catch(() => null);
    const err = thrown ? `render: ${(thrown as Error)?.message ?? thrown}` : val ? `webgpu: ${val.message}` : oom ? `webgpu out of memory: ${oom.message}` : null;
    if (err) {
      errors.push({ inst: pass.inst, error: err });
      // a module that fails in setup stays failed (it would fail every frame); render errors retry
      if (inSetup) inst.failed = err;
      continue;
    }
    last = out;
  }
  const result = last ?? blankTexture(d, w, h);
  if (job.out === 'pixels') {
    const px = await toPixels(d, result, w, h);
    const tr: Transferable[] = [px];
    if (job.input) tr.push(job.input.data);
    post({ type: 'done', job: job.job, pixels: px, w, h, ms: performance.now() - t0, input: job.input?.data, errors }, tr);
  } else {
    const bm = toBitmap(d, result, w, h);
    const tr: Transferable[] = [bm];
    if (job.input) tr.push(job.input.data);
    post({ type: 'done', job: job.job, bitmap: bm, w, h, ms: performance.now() - t0, input: job.input?.data, errors }, tr);
  }
}

// one job at a time, in order (instances keep gpu state between them)
let chain: Promise<void> = Promise.resolve();
onMsg(m => {
  if (m.type === 'dispose') { chain = chain.then(() => dispose(m.inst)); return; }
  if (m.type === 'describe') {
    chain = chain.then(() => {
      const mod = loadModule(m.mod);
      let schema: Record<string, unknown> | null = null;
      try { schema = mod.schema ? JSON.parse(JSON.stringify(mod.schema)) : null; } catch { /* */ }
      post({ type: 'schema', job: m.job, schema, error: mod.error });
    });
    return;
  }
  if (m.type === 'render') {
    chain = chain.then(() => runJob(m)).catch(e => {
      post({ type: 'failed', job: m.job, error: String((e as Error)?.message ?? e), input: m.input?.data }, m.input ? [m.input.data] : []);
    });
  }
});

lockDown();
getDevice().then(() => post({ type: 'ready', ok: true, adapter: adapterName }), e => post({ type: 'ready', ok: false, error: String((e as Error)?.message ?? e) }));
