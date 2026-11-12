// stress lab runtime (loaded only with ?lab, see main.tsx): builds scenes and runs measurement
// loops inside the page so scripts/stress-lab.mjs can drive them with plain page.evaluate calls.
// everything here measures the real editor (store + renderer + ui frame hooks), nothing is mocked.

import { editor } from '../app/editor';
import { insertLayers } from '../app/actions';
import { SCENES, syntheticFigma, syntheticLottie, rnd, type SceneName } from './scenes';
import { applyPreset, setTextAnim } from '../core/presets';
import { cloneLayers, deleteLayers, groupLayers, precompose, setExpr, setProp } from '../core/commands';

type Samples = { interval: number[]; tick: number[]; frame: number[]; eval: number[]; write: number[]; raster: number[]; gpu: number[] };

const nextFrame = () => new Promise<number>(r => requestAnimationFrame(r));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let recording: Samples | null = null;
const longTasks: { start: number; dur: number }[] = [];

function install() {
  // time the whole editor frame (render + timeline/overlay/hud hooks), not just the renderer
  const ed = editor as any;
  const orig = ed.tick.bind(ed);
  ed.tick = (now: number) => {
    const t0 = performance.now();
    orig(now);
    if (recording) {
      const s = editor.renderer.stats;
      recording.tick.push(performance.now() - t0);
      recording.frame.push(s.frameMs); recording.eval.push(s.evalMs); recording.write.push(s.writeMs);
      recording.raster.push(s.rasterMs); recording.gpu.push(s.gpuSubmitMs);
    }
  };
  try {
    new PerformanceObserver(l => { for (const e of l.getEntries()) longTasks.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: false });
  } catch { /* no long task api */ }
  (window as any).motionLab = lab;
}
let gpuOff = false;
let patched: WebGL2RenderingContext | null = null;
/** the container gpu is software (swiftshader): it caps playback at a few fps and hides cpu costs.
 *  "cpu mode" turns draw calls into no-ops so frames run as fast as the main thread allows;
 *  everything else (evaluation, instance writes, buffer uploads, atlas uploads, ui hooks) still runs. */
function patchGl() {
  const gl = editor.renderer?.gl as any;
  if (!gl || patched === gl) return;
  patched = gl;
  for (const f of ['drawArraysInstanced', 'drawArrays']) {
    const o = gl[f].bind(gl);
    gl[f] = (...a: any[]) => { if (!gpuOff) o(...a); };
  }
}

function newSamples(): Samples { return { interval: [], tick: [], frame: [], eval: [], write: [], raster: [], gpu: [] }; }

/** record frames for `ms` while `perFrame` (optional) runs before each frame's work */
async function record(ms: number, perFrame?: (i: number, now: number) => void, minFrames = 40) {
  const s = newSamples();
  const lt0 = longTasks.length;
  const heap0 = (performance as any).memory?.usedJSHeapSize ?? 0;
  let last = await nextFrame();
  recording = s;
  const end = last + ms;
  let i = 0;
  // our rAF callback runs before the editor's next tick (registered earlier in the same frame queue)
  for (;;) {
    perFrame?.(i++, last);
    const now = await nextFrame();
    s.interval.push(now - last);
    last = now;
    // at least minFrames (percentiles need samples) unless that takes more than 5x the window
    if (now >= end && (s.interval.length >= minFrames || now >= end + ms * 4)) break;
  }
  recording = null;
  const heap1 = (performance as any).memory?.usedJSHeapSize ?? 0;
  const lts = longTasks.slice(lt0);
  return { ...s, longTasks: lts.map(x => Math.round(x.dur)), heapDeltaMB: (heap1 - heap0) / 1e6, wallMs: ms };
}

function renderInfo() {
  const r = editor.renderer as any;
  const s = r.stats;
  return {
    items: r.items.length, drawn: s.instances, culled: s.culled, atlasEntries: s.atlasEntries, atlasPages: s.atlasPages,
    rasterMeta: r.rasterMeta?.size ?? 0, shadowMB: (r.atlas.shadowBytes ?? 0) / 1e6, isolated: r.isolatedLastFrame,
    asyncRasters: r.asyncRasters, compactions: r.atlas.compactions, generation: r.atlas.generation, poolUsed: r.pool?.used ?? 0,
    heapMB: ((performance as any).memory?.usedJSHeapSize ?? 0) / 1e6,
  };
}

const lab = {
  scenes: Object.keys(SCENES),
  info: renderInfo,
  /** false = skip gpu draw calls (cpu-bound measurement), true = real drawing */
  setGpu(on: boolean) { patchGl(); gpuOff = !on; editor.renderer.dirty = true; },
  /** build + load a scene; times build, store load and the first (compile) frame */
  async load(name: SceneName, opts: any = {}) {
    editor.pause();
    const t0 = performance.now();
    const p = (SCENES[name] as (o: any) => any)(opts);
    const t1 = performance.now();
    editor.load(p);
    const t2 = performance.now();
    editor.renderer.render(editor.store.time);
    const t3 = performance.now();
    await nextFrame(); await nextFrame();
    return { buildMs: t1 - t0, loadMs: t2 - t1, firstFrameMs: t3 - t2, layers: Object.keys(p.layers).length, ...renderInfo() };
  },
  play() { editor.store.setTime(0); editor.play(); },
  pause() { editor.pause(); },
  select(n = 1) { const root = editor.store.comp.root; editor.store.select(root.slice(-n)); },
  async warm(ms: number) { await sleep(ms); },

  /** plain playback */
  sample(ms: number) { return record(ms); },

  /** fast camera moves while playing: zoom oscillates 0.15x..4x around a moving point, pan sweeps */
  camera(ms: number) {
    const vp = (window as any).viewport;
    const host = document.querySelector('.viewport') as HTMLElement;
    const rect = host.getBoundingClientRect();
    const z0 = vp.zoom;
    return record(ms, i => {
      const ph = i / 40;
      const z = z0 * Math.exp(Math.sin(ph) * 1.6);
      const cx = rect.width / 2 + Math.sin(ph * 1.7) * rect.width * 0.3, cy = rect.height / 2 + Math.cos(ph * 1.3) * rect.height * 0.3;
      vp.setZoom(z, cx, cy);
    }).finally(() => vp.fit());
  },

  /** scrub the playhead fast (paused): big jumps like a user flinging the time ruler */
  scrub(ms: number) {
    editor.pause();
    const st = editor.store, d = st.comp.duration;
    const r = rnd(3);
    return record(ms, i => { st.setTime(i % 8 === 0 ? r() * d : (st.time + d * 0.037) % d); });
  },

  /** temporal supersampling (motion blur estimate): K renders per displayed frame at t + k*shutter/K */
  async motionBlur(ms: number, K: number, shutter = 0.5) {
    const ed = editor as any;
    editor.pause();
    ed.stop();
    const st = editor.store, fps = st.comp.fps, d = st.comp.duration;
    const per: number[] = [], interval: number[] = [];
    const lt0 = longTasks.length;
    let last = await nextFrame();
    const end = last + ms;
    let t = 0;
    while (last < end || (interval.length < 30 && last < end + ms * 4)) {
      const f0 = performance.now();
      for (let k = 0; k < K; k++) editor.renderer.render((t + (k / K) * shutter / fps) % d);
      per.push(performance.now() - f0);
      t = (t + 1 / fps) % d;
      const now = await nextFrame();
      interval.push(now - last); last = now;
    }
    ed.resume();
    return { tick: per, interval, longTasks: longTasks.slice(lt0).map(x => Math.round(x.dur)), K };
  },

  /** many small edits, then undo them all, then redo them all. per op: sync ms + time until the next frame is done */
  async undoStorm(nEdits: number) {
    editor.pause();
    const st = editor.store;
    const ids = Object.keys(st.project.layers).filter(id => st.project.layers[id].props.position);
    const r = rnd(4);
    const res: Record<string, number[]> = { edit: [], editFrame: [], undo: [], undoFrame: [], redo: [], redoFrame: [] };
    const step = async (kind: string, fn: () => void) => {
      const t0 = performance.now();
      fn();
      res[kind].push(performance.now() - t0);
      await nextFrame(); await nextFrame(); // second rAF: the frame that rendered the change has finished
      res[kind + 'Frame'].push(performance.now() - t0);
    };
    for (let i = 0; i < nEdits; i++) {
      const id = ids[Math.floor(r() * ids.length)];
      st.select([id]);
      await step('edit', () => setProp(st, id, 'opacity', [Math.round(r() * 100)]));
    }
    for (let i = 0; i < nEdits; i++) await step('undo', () => st.undo());
    for (let i = 0; i < nEdits; i++) await step('redo', () => st.redo());
    return res;
  },

  /** bulk editing commands on the loaded scene (each one undoable step), sync time + next finished frame */
  async ops() {
    editor.pause();
    const st = editor.store;
    const out: Record<string, { ms: number; frameMs: number; n: number }> = {};
    const time = async (name: string, n: number, fn: () => void) => {
      const t0 = performance.now();
      fn();
      const ms = performance.now() - t0;
      await nextFrame(); await nextFrame();
      out[name] = { ms, frameMs: performance.now() - t0, n };
    };
    const root = () => st.comp.root.slice();
    const all = root();
    await time('selectAll', all.length, () => st.select(all));
    await time('applyPreset Pop (stagger)', all.length, () => applyPreset(st, all, 'Pop', { stagger: 0.001 }));
    await time('setExpr wiggle', 3000, () => setExpr(st, all.slice(0, 3000), 'rotation', 'wiggle(3, 20)'));
    await time('setTextAnim (non-text, no-op path)', 1000, () => setTextAnim(st, all.slice(0, 1000), undefined));
    await time('duplicate 1000', 1000, () => { cloneLayers(st, all.slice(0, 1000)); });
    await time('group 2000', 2000, () => { groupLayers(st, root().slice(0, 2000), { x: 0, y: 0, w: 1920, h: 1080 }); });
    await time('precompose 2000', 2000, () => { precompose(st, root().slice(-2000)); });
    await time('delete 1000', 1000, () => deleteLayers(st, root().slice(0, 1000)));
    await time('undo x4', 4, () => { for (let i = 0; i < 4; i++) st.undo(); });
    await time('serialize', 1, () => { JSON.stringify(st.project); });
    return out;
  },

  /** synthetic lottie: build json text, parse, convert, load, first frame */
  async importLottie(n: number) {
    editor.pause();
    const m = await import('../import/lottie');
    const json = syntheticLottie({ n });
    const text = JSON.stringify(json);
    const t0 = performance.now();
    const parsed = JSON.parse(text);
    const t1 = performance.now();
    const p = m.lottieToProject(parsed, 'synthetic');
    const t2 = performance.now();
    editor.load(p);
    editor.renderer.render(0);
    const t3 = performance.now();
    await nextFrame(); await nextFrame();
    return { bytes: text.length, parseMs: t1 - t0, convertMs: t2 - t1, loadFirstFrameMs: t3 - t2, totalMs: performance.now() - t0, layers: Object.keys(p.layers).length };
  },

  /** synthetic figma paste (decoded kiwi message): convert + insert + first frame */
  async importFigma(frames: number, per: number) {
    editor.pause();
    const m = await import('../import/figma');
    const msg = syntheticFigma({ frames, perFrame: per });
    const t0 = performance.now();
    const res = m.figmaMessageToLayers(msg);
    const t1 = performance.now();
    insertLayers(res, { label: 'Paste from Figma', fitCompIfEmpty: false });
    const t2 = performance.now();
    editor.renderer.render(editor.store.time);
    const t3 = performance.now();
    await nextFrame(); await nextFrame();
    return { nodes: msg.nodeChanges.length, convertMs: t1 - t0, insertMs: t2 - t1, firstFrameMs: t3 - t2, totalMs: performance.now() - t0, layers: res.layers.length };
  },

  /** drag the top-most layer with synthetic pointer events while playing; per-move handler time is the tick of that frame */
  dragTarget() {
    const st = editor.store;
    const id = st.comp.root[st.comp.root.length - 1];
    st.select([id]);
    const c = editor.renderer.corners(id)!;
    const vp = (window as any).viewport;
    const r = (document.querySelector('.viewport') as HTMLElement).getBoundingClientRect();
    return { x: r.left + vp.panX + ((c[0] + c[4]) / 2) * vp.zoom, y: r.top + vp.panY + ((c[1] + c[5]) / 2) * vp.zoom };
  },
  startRecord() { recording = newSamples(); (lab as any)._lt0 = longTasks.length; (lab as any)._h0 = (performance as any).memory?.usedJSHeapSize ?? 0; (lab as any)._t0 = performance.now(); (lab as any)._last = 0; const loop = (now: number) => { if (!recording) return; if ((lab as any)._last) recording.interval.push(now - (lab as any)._last); (lab as any)._last = now; requestAnimationFrame(loop); }; requestAnimationFrame(loop); },
  stopRecord() {
    const s = recording!; recording = null;
    return { ...s, longTasks: longTasks.slice((lab as any)._lt0).map(x => Math.round(x.dur)), heapDeltaMB: (((performance as any).memory?.usedJSHeapSize ?? 0) - (lab as any)._h0) / 1e6, wallMs: performance.now() - (lab as any)._t0 };
  },
};

install();
export {};
