// stress lab: brutal, repeatable workloads against the production build + regression report.
//
//   npm run stress                        build, run every scenario, compare with the previous result
//   node scripts/stress-lab.mjs --quick   shorter windows, 30s soak
//   node scripts/stress-lab.mjs --only springs-10k,undo-storm-10k
//   node scripts/stress-lab.mjs --list | --no-soak | --soak-sec 60 | --headed | --no-profile
//
// a vite preview server is started on PORT (default 4182) unless URL is reachable already.
// writes bench/results/<date>.json and flags regressions > THRESH (default 10%) against the newest
// earlier result file (or --baseline <file>). numbers are CPU-side: the container GPU is llvmpipe,
// so fps is secondary; tick = whole editor frame on the main thread (render + ui frame hooks).
import { chromium } from './pw.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceMapConsumer } from 'source-map-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const QUICK = flag('--quick');
const PORT = +(process.env.PORT || 4182);
const URL0 = process.env.URL || `http://localhost:${PORT}/`;
const THRESH = +(opt('--threshold', process.env.THRESH || 10)) / 100;
const WARM = QUICK ? 800 : 1500;
const MEASURE = QUICK ? 2000 : 4000;
const GPU_MEASURE = QUICK ? 1500 : 3000;
const SOAK_SEC = +opt('--soak-sec', QUICK ? 30 : 180);
const PROFILE = !flag('--no-profile');

// ---------------------------------------------------------------- scenarios
const play = (name, scene, opts, extra = {}) => ({ name, kind: 'play', scene, opts, ...extra });
const SCENARIOS = [
  play('springs-10k', 'springs', { n: 10000 }, { desc: '10k rects/ellipses, 5 animated props, springs + bezier' }),
  play('springs-25k', 'springs', { n: 25000 }),
  play('nested-8deep-5k', 'nested', { n: 5000, depth: 8, fanout: 2 }, { desc: 'groups 8 levels deep (255 animated groups), 5k leaves' }),
  play('iso-fbo-stack', 'nested', { n: 2000, depth: 6, fanout: 2, iso: true }, { desc: '63 nested groups with opacity<1 => offscreen isolation stack' }),
  play('precomps-200x50', 'precomps', { comps: 200, inst: 50, inner: 4 }, { desc: '200 precomps x 50 instances (10k precomp layers, 50k items)' }),
  play('text-anim-2k', 'textAnim', { n: 2000 }, { desc: '2k text layers, per-char/word animators' }),
  play('path-morph-trim-1k', 'pathMorph', { n: 1000 }, { desc: '1k pathKf morphs + animated trim paths' }),
  play('expr-3k', 'expressions', { n: 3000 }, { desc: '3k layers x 4 expressions (wiggle, loopOut, time math)' }),
  play('rasters-500', 'rasters', { n: 500 }, { desc: '500 big gradient/image layers scaling 20%..300%' }),
  play('masks-blend-300', 'masksBlend', { groups: 300, kids: 8 }, { desc: '300 masked groups, 8 kids each with blend modes' }),
  play('overdraw-1500', 'overdraw', { n: 1500 }, { desc: '1500 near-fullscreen 3-11% opacity layers (fill rate)' }),
  play('mixed-10k', 'mixed', { n: 10000 }, { desc: 'production-like mix of every feature' }),
  { name: 'camera-mixed-10k', kind: 'camera', scene: 'mixed', opts: { n: 10000 }, desc: 'zoom 0.2x..5x + pan every frame while playing' },
  { name: 'scrub-springs-10k', kind: 'scrub', scene: 'springs', opts: { n: 10000 }, desc: 'playhead jumps every frame, 1 layer selected' },
  { name: 'drag-play-10k', kind: 'drag', scene: 'springs', opts: { n: 10000 }, desc: 'mouse-drag a layer while 10k play' },
  ...[1, 4, 8, 16].map(K => ({ name: `mblur-x${K}-mixed-4k`, kind: 'mblur', K, scene: 'mixed', opts: { n: 4000 }, desc: `${K} sub-frame renders per frame (temporal supersampling)` })),
  { name: 'undo-storm-10k', kind: 'undo', scene: 'springs', opts: { n: 10000 }, edits: QUICK ? 20 : 60, desc: 'N edits, N undos, N redos' },
  { name: 'ops-5k', kind: 'ops', scene: 'springs', opts: { n: 5000 }, desc: 'bulk commands: preset, expr, duplicate, group, precompose, delete' },
  { name: 'import-lottie-3k', kind: 'lottie', n: 3000, desc: 'synthetic bodymovin json, 3k shape layers + 100 precomp layers' },
  { name: 'import-figma-5k', kind: 'figma', frames: 50, per: 100, desc: 'synthetic figma paste, 5k nodes' },
  { name: 'soak-mixed-4k', kind: 'soak', scene: 'mixed', opts: { n: 4000 }, desc: `${SOAK_SEC}s playback: heap, atlas, dom growth` },
];

if (flag('--list')) { for (const s of SCENARIOS) console.log(s.name.padEnd(22), s.desc ?? ''); process.exit(0); }
const only = opt('--only', '')?.split(',').filter(Boolean) ?? [];
const todo = SCENARIOS.filter(s => (only.length ? only.some(o => s.name.includes(o)) : true) && !(flag('--no-soak') && s.kind === 'soak'));

// ---------------------------------------------------------------- stats helpers
const sorted = a => Float64Array.from(a).sort();
const q = (a, p) => { if (!a.length) return NaN; const b = sorted(a); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };
const med = a => q(a, 0.5);
const r2 = x => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);

function summarize(s) {
  return {
    fps: r2(1000 / med(s.interval)),
    frameP50: r2(med(s.interval)), frameP95: r2(q(s.interval, 0.95)), frameP99: r2(q(s.interval, 0.99)),
    tickP50: r2(med(s.tick)), tickP95: r2(q(s.tick, 0.95)), tickP99: r2(q(s.tick, 0.99)), tickMax: r2(Math.max(...s.tick)),
    cpuP50: r2(med(s.frame ?? [])), cpuP95: r2(q(s.frame ?? [], 0.95)),
    evalP50: r2(med(s.eval ?? [])), writeP50: r2(med(s.write ?? [])), rasterP50: r2(med(s.raster ?? [])), rasterP95: r2(q(s.raster ?? [], 0.95)), gpuP50: r2(med(s.gpu ?? [])),
    longTasks: s.longTasks?.length ?? 0, longMax: s.longTasks?.length ? Math.max(...s.longTasks) : 0,
    heapDeltaMB: r2(s.heapDeltaMB), frames: s.interval.length,
  };
}

const RESULTS_DIR = path.join(root, 'bench/results');
if (opt('--report', null)) {
  const f = opt('--report');
  const fp = path.isAbsolute(f) ? f : fs.existsSync(f) ? path.resolve(f) : path.join(RESULTS_DIR, f);
  report(JSON.parse(fs.readFileSync(fp, 'utf8')), fp);
  process.exit(0);
}

// ---------------------------------------------------------------- server
async function reachable(u) { try { const r = await fetch(u); return r.ok; } catch { return false; } }
let server = null;
if (!(await reachable(URL0))) {
  if (!fs.existsSync(path.join(root, 'dist/index.html')) || flag('--build')) {
    console.log('building…');
    await new Promise((res, rej) => spawn('npx', ['vite', 'build'], { cwd: root, stdio: 'inherit' }).on('exit', c => (c ? rej(new Error('build failed')) : res())));
  }
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore', detached: true });
  for (let i = 0; i < 100 && !(await reachable(URL0)); i++) await new Promise(r => setTimeout(r, 200));
  if (!(await reachable(URL0))) throw new Error('preview server did not start on ' + URL0);
}
const stopServer = () => { if (server) try { process.kill(-server.pid); } catch { /* gone */ } };
process.on('exit', stopServer);
process.on('SIGINT', () => { stopServer(); process.exit(130); });

// ---------------------------------------------------------------- profiles -> source positions
const maps = new Map();
function consumer(url) {
  const file = url.split('/').pop();
  if (!file?.endsWith('.js')) return null;
  if (!maps.has(file)) {
    const p = path.join(root, 'dist/assets', file + '.map');
    maps.set(file, fs.existsSync(p) ? new SourceMapConsumer(JSON.parse(fs.readFileSync(p, 'utf8'))) : null);
  }
  return maps.get(file);
}
function frameName(cf) {
  const special = cf.functionName && cf.functionName.startsWith('(');
  if (special) return cf.functionName;
  const c = cf.url ? consumer(cf.url) : null;
  if (c && cf.lineNumber >= 0) {
    const o = c.originalPositionFor({ line: cf.lineNumber + 1, column: cf.columnNumber });
    if (o.source) return `${o.name || cf.functionName || '(anon)'} ${o.source.replace(/^(\.\.\/)+/, '')}:${o.line}`;
  }
  return `${cf.functionName || '(anon)'} ${cf.url ? cf.url.split('/').pop() : '(native)'}:${cf.lineNumber + 1}`;
}
function digestProfile(profile) {
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const self = new Map();
  let total = 0;
  profile.samples.forEach((s, i) => {
    const dt = profile.timeDeltas[i] || 0;
    const n = byId.get(s);
    const k = frameName(n.callFrame);
    total += dt;
    self.set(k, (self.get(k) || 0) + dt);
  });
  const busy = total - (self.get('(idle)') || 0) - (self.get('(program)') || 0);
  const gc = self.get('(garbage collector)') || 0;
  const top = [...self].filter(([k]) => !['(idle)', '(program)'].includes(k)).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, us]) => ({ fn: k, ms: r2(us / 1000), pct: r2(100 * us / Math.max(1, busy)) }));
  return { gcPct: r2(100 * gc / Math.max(1, total)), jsBusyPct: r2(100 * busy / Math.max(1, total)), top };
}

// ---------------------------------------------------------------- runner
const browser = await chromium.launch({
  headless: !flag('--headed'),
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit', '--disable-gpu-vsync', '--enable-precise-memory-info'],
});
const gl = await (async () => {
  const p = await browser.newPage();
  const r = await p.evaluate(() => { const g = document.createElement('canvas').getContext('webgl2'); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); });
  await p.close(); return r;
})();

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${URL0}?nobridge&blank&lab`);
  await page.waitForFunction(() => window.motionLab && window.editor?.renderer, null, { timeout: 30000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  return { page, cdp, errors };
}
async function metrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map(m => [m.name, m.value]));
}
async function profiled(cdp, fn) {
  if (PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
  const m0 = await metrics(cdp);
  const res = await fn();
  const m1 = await metrics(cdp);
  let prof = null;
  if (PROFILE) { const { profile } = await cdp.send('Profiler.stop'); prof = digestProfile(profile); }
  const wall = (m1.Timestamp - m0.Timestamp) || 1;
  return { res, prof, busyPct: r2(100 * (m1.TaskDuration - m0.TaskDuration) / wall), scriptPct: r2(100 * (m1.ScriptDuration - m0.ScriptDuration) / wall), domNodes: m1.Nodes, listeners: m1.JSEventListeners };
}
async function gcHeap(cdp) {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return usedSize / 1e6;
}

const results = {};
for (const sc of todo) {
  const t0 = Date.now();
  process.stdout.write(`▶ ${sc.name.padEnd(22)} `);
  const { page, cdp, errors } = await openPage();
  const row = { kind: sc.kind };
  try {
    const ev = (fn, arg) => page.evaluate(fn, arg);
    await ev(() => motionLab.setGpu(false)); // cpu mode by default (see src/lab/index.ts)
    if (sc.scene) Object.assign(row, { setup: await ev(([n, o]) => motionLab.load(n, o), [sc.scene, sc.opts]) });
    if (sc.kind === 'play' || sc.kind === 'camera' || sc.kind === 'scrub') {
      if (sc.kind === 'scrub') await ev(() => motionLab.select(1)); else await ev(() => motionLab.play());
      const run = ms => ev(([k, ms]) => (k === 'camera' ? motionLab.camera(ms) : k === 'scrub' ? motionLab.scrub(ms) : motionLab.sample(ms)), [sc.kind, ms]);
      // 1) cpu mode (draw calls skipped): the numbers that matter, many frames
      await ev(() => motionLab.setGpu(false));
      await page.waitForTimeout(WARM);
      const p = await profiled(cdp, () => run(MEASURE));
      Object.assign(row, summarize(p.res), { busyPct: p.busyPct, scriptPct: p.scriptPct, gcPct: p.prof?.gcPct, profile: p.prof?.top, after: await ev(() => motionLab.info()) });
      // 2) real (software) gpu: secondary fps / frame pacing
      await ev(() => motionLab.setGpu(true));
      await page.waitForTimeout(300);
      const g = summarize(await run(GPU_MEASURE));
      Object.assign(row, { swFps: g.fps, swFrameP95: g.frameP95, swTickP50: g.tickP50, swLongTasks: g.longTasks });
    } else if (sc.kind === 'drag') {
      await ev(() => { motionLab.setGpu(false); motionLab.play(); });
      await page.waitForTimeout(WARM);
      const pt = await ev(() => motionLab.dragTarget());
      const p = await profiled(cdp, async () => {
        await ev(() => motionLab.startRecord());
        await page.mouse.move(pt.x, pt.y); await page.mouse.down();
        for (let i = 1; i <= 60; i++) { await page.mouse.move(pt.x + i * 4, pt.y + Math.sin(i / 5) * 40); await page.waitForTimeout(16); }
        await page.mouse.up();
        return ev(() => motionLab.stopRecord());
      });
      Object.assign(row, summarize(p.res), { busyPct: p.busyPct, scriptPct: p.scriptPct, gcPct: p.prof?.gcPct, profile: p.prof?.top });
    } else if (sc.kind === 'mblur') {
      await ev(() => motionLab.setGpu(false));
      await page.waitForTimeout(WARM);
      const p = await profiled(cdp, () => ev(([ms, K]) => motionLab.motionBlur(ms, K), [MEASURE, sc.K]));
      const s = summarize(p.res);
      Object.assign(row, { fps: s.fps, frameP95: s.frameP95, tickP50: s.tickP50, tickP95: s.tickP95, tickP99: s.tickP99, perSubframeMs: r2(s.tickP50 / sc.K), longTasks: s.longTasks, longMax: s.longMax, gcPct: p.prof?.gcPct, profile: p.prof?.top });
    } else if (sc.kind === 'undo') {
      await page.waitForTimeout(500);
      const p = await profiled(cdp, () => ev(n => motionLab.undoStorm(n), sc.edits));
      for (const [k, v] of Object.entries(p.res)) { row[k + 'P50'] = r2(med(v)); row[k + 'P95'] = r2(q(v, 0.95)); }
      Object.assign(row, { gcPct: p.prof?.gcPct, profile: p.prof?.top });
    } else if (sc.kind === 'ops') {
      await page.waitForTimeout(500);
      const p = await profiled(cdp, () => ev(() => motionLab.ops()));
      row.ops = p.res;
      for (const [k, v] of Object.entries(p.res)) row['op:' + k] = r2(v.frameMs);
      Object.assign(row, { gcPct: p.prof?.gcPct, profile: p.prof?.top });
    } else if (sc.kind === 'lottie' || sc.kind === 'figma') {
      const p = await profiled(cdp, () => (sc.kind === 'lottie' ? ev(n => motionLab.importLottie(n), sc.n) : ev(([f, n]) => motionLab.importFigma(f, n), [sc.frames, sc.per])));
      Object.assign(row, Object.fromEntries(Object.entries(p.res).map(([k, v]) => [k, r2(v)])), { gcPct: p.prof?.gcPct, profile: p.prof?.top });
      // then play the imported result
      await ev(() => { motionLab.setGpu(false); motionLab.play(); });
      await page.waitForTimeout(WARM);
      const s = summarize(await ev(ms => motionLab.sample(ms), MEASURE / 2));
      Object.assign(row, { fps: s.fps, tickP50: s.tickP50, tickP95: s.tickP95, cpuP50: s.cpuP50, longTasks: s.longTasks });
    } else if (sc.kind === 'soak') {
      await ev(() => { motionLab.setGpu(false); motionLab.play(); });
      await page.waitForTimeout(WARM);
      const heap0 = await gcHeap(cdp);
      const m0 = await metrics(cdp);
      const info0 = await ev(() => motionLab.info());
      const series = [];
      const allTicks = [];
      const step = Math.min(10, SOAK_SEC);
      for (let t = 0; t < SOAK_SEC; t += step) {
        const s = await ev(ms => motionLab.sample(ms), step * 1000);
        const info = await ev(() => motionLab.info());
        const m = await metrics(cdp);
        series.push({ t: t + step, heapMB: r2(info.heapMB), tickP50: r2(med(s.tick)), tickP95: r2(q(s.tick, 0.95)), fps: r2(1000 / med(s.interval)), atlasEntries: info.atlasEntries, atlasPages: info.atlasPages, rasterMeta: info.rasterMeta, shadowMB: r2(info.shadowMB), compactions: info.compactions, domNodes: m.Nodes, listeners: m.JSEventListeners, longTasks: s.longTasks.length });
        allTicks.push(...s.tick);
        process.stdout.write('.');
      }
      const heap1 = await gcHeap(cdp);
      const m1 = await metrics(cdp);
      const info1 = await ev(() => motionLab.info());
      const mins = SOAK_SEC / 60;
      const first = series[0], last = series[series.length - 1];
      Object.assign(row, {
        seconds: SOAK_SEC, heapGcStartMB: r2(heap0), heapGcEndMB: r2(heap1), heapGrowthMBperMin: r2((heap1 - heap0) / mins),
        tickP50: r2(med(allTicks)), tickP95: r2(q(allTicks, 0.95)), tickP99: r2(q(allTicks, 0.99)),
        tickDriftPct: r2(100 * (last.tickP50 - first.tickP50) / Math.max(0.01, first.tickP50)),
        atlasEntries: [info0.atlasEntries, info1.atlasEntries], atlasPages: [info0.atlasPages, info1.atlasPages], rasterMeta: [info0.rasterMeta, info1.rasterMeta],
        rasterMetaGrowthPerMin: r2((info1.rasterMeta - info0.rasterMeta) / mins), compactions: info1.compactions - info0.compactions,
        domNodes: [m0.Nodes, m1.Nodes], listeners: [m0.JSEventListeners, m1.JSEventListeners], series,
      });
    }
  } catch (e) {
    row.error = String(e.message ?? e).split('\n')[0];
  }
  row.errors = errors.slice(0, 5);
  row.seconds = row.seconds ?? Math.round((Date.now() - t0) / 1000);
  results[sc.name] = row;
  console.log(row.error ? `ERROR ${row.error}` : `${row.tickP50 ?? row.totalMs ?? ''}ms tick p50  (${Math.round((Date.now() - t0) / 1000)}s)`);
  await page.close();
}
await browser.close();
stopServer();

// ---------------------------------------------------------------- report
const commit = await new Promise(res => { let o = ''; const p = spawn('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }); p.stdout.on('data', d => (o += d)); p.on('exit', () => res(o.trim())); });
const out = { date: new Date().toISOString(), commit, gl, quick: QUICK, measureMs: MEASURE, soakSec: SOAK_SEC, results };
fs.mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = out.date.replace(/[:]/g, '-').replace(/\..*/, '');
const file = path.join(RESULTS_DIR, `${stamp}${only.length ? '-partial' : ''}${QUICK ? '-quick' : ''}.json`);
const cmp = report(out, file);
Object.assign(out, cmp);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`\nwrote ${path.relative(root, file)}`);
process.exitCode = cmp.regressions.length && flag('--strict') ? 1 : 0;

/** baseline per scenario: the newest earlier result file (same quick/full mode) that has it */
function baselines(out, self) {
  const base = {};
  if (!fs.existsSync(RESULTS_DIR)) return base;
  const forced = opt('--baseline', null);
  const files = forced ? [forced] : fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
  for (const f of files) {
    const fp = path.isAbsolute(f) ? f : path.join(RESULTS_DIR, f);
    if (path.resolve(fp) === path.resolve(self)) continue;
    let d; try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    if (!forced && (d.date >= out.date || !!d.quick !== !!out.quick)) continue;
    for (const [k, r] of Object.entries(d.results ?? {})) if (!base[k] && out.results[k] && !r.error) base[k] = { file: f, commit: d.commit, r };
  }
  return base;
}

function report(out, file) {
  const { results } = out;
  const playRows = Object.entries(results).filter(([, r]) => ['play', 'camera', 'scrub', 'drag'].includes(r.kind));
  console.log(`\nGPU: ${out.gl}   commit ${out.commit}   ${out.quick ? '(quick)' : ''}`);
  console.log('\nplayback / interaction, cpu mode (ms; tick = whole editor frame on the main thread incl. ui hooks, cpu = renderer.render; swFps = real swiftshader drawing)');
  console.table(Object.fromEntries(playRows.map(([k, r]) => [k, {
    items: r.setup?.items ?? '', drawn: r.after?.drawn ?? '', 'load+1st': r2((r.setup?.buildMs ?? 0) + (r.setup?.loadMs ?? 0) + (r.setup?.firstFrameMs ?? 0)),
    tick50: r.tickP50, tick95: r.tickP95, tick99: r.tickP99, cpu50: r.cpuP50, eval: r.evalP50, write: r.writeP50, raster: r.rasterP50, gpu: r.gpuP50,
    fps: r.fps, fr95: r.frameP95, swFps: r.swFps, long: r.longTasks, longMax: r.longMax, 'gc%': r.gcPct, 'heapΔMB': r.heapDeltaMB, err: r.error ? 'ERR' : r.errors?.length || '',
  }])));
  const mb = Object.entries(results).filter(([, r]) => r.kind === 'mblur');
  if (mb.length) { console.log('motion blur (temporal supersampling, cpu mode)'); console.table(Object.fromEntries(mb.map(([k, r]) => [k, { frameMs50: r.tickP50, frameMs95: r.tickP95, perSubframe: r.perSubframeMs, fps: r.fps, long: r.longTasks, 'gc%': r.gcPct }]))); }
  for (const [k, un] of Object.entries(results).filter(([, r]) => r.kind === 'undo' && !r.error)) {
    console.log(`${k} (ms per op: sync p50/p95, until the next frame finished p50/p95)`);
    console.table({ edit: [un.editP50, un.editP95, un.editFrameP50, un.editFrameP95], undo: [un.undoP50, un.undoP95, un.undoFrameP50, un.undoFrameP95], redo: [un.redoP50, un.redoP95, un.redoFrameP50, un.redoFrameP95] });
  }
  for (const [k, ops] of Object.entries(results).filter(([, r]) => r.ops)) { console.log(`${k}: bulk commands (ms sync / until next frame)`); console.table(Object.fromEntries(Object.entries(ops.ops).map(([n, v]) => [n, { n: v.n, ms: r2(v.ms), frameMs: r2(v.frameMs) }]))); }
  const imp = Object.entries(results).filter(([, r]) => r.kind === 'lottie' || r.kind === 'figma');
  if (imp.length) { console.log('imports (ms)'); console.table(Object.fromEntries(imp.map(([k, r]) => [k, { layers: r.layers, parse: r.parseMs, convert: r.convertMs, insert: r.insertMs, load1st: r.loadFirstFrameMs ?? r.firstFrameMs, total: r.totalMs, tick50: r.tickP50, tick95: r.tickP95, err: r.error ? 'ERR' : '' }]))); }
  for (const [k, r] of Object.entries(results).filter(([, r]) => r.kind === 'soak' && !r.error)) {
    console.log(`${k} ${r.seconds}s: heap after GC ${r.heapGcStartMB} -> ${r.heapGcEndMB} MB (${r.heapGrowthMBperMin} MB/min), tick p50 ${r.tickP50} p95 ${r.tickP95} (drift ${r.tickDriftPct}%), rasterMeta ${r.rasterMeta.join('->')}, atlas entries ${r.atlasEntries.join('->')} pages ${r.atlasPages.join('->')}, compactions ${r.compactions}, dom ${r.domNodes.join('->')}, listeners ${r.listeners.join('->')}`);
  }
  if (flag('--top')) for (const [k, r] of Object.entries(results)) if (r.profile) { console.log(`\n${k} top self time (% of busy js):`); for (const t of r.profile.slice(0, 6)) console.log(`  ${String(t.pct).padStart(5)}%  ${t.fn}`); }
  const errs = Object.entries(results).filter(([, r]) => r.error);
  if (errs.length) console.log('scenario errors:', errs.map(([k, r]) => `${k}: ${r.error}`).join('; '));

  // regression check (lower is better except HIGHER); per scenario against its own newest baseline
  const KEYS = ['tickP50', 'tickP95', 'tickP99', 'cpuP50', 'cpuP95', 'evalP50', 'writeP50', 'rasterP50', 'frameP95', 'fps', 'editFrameP50', 'undoFrameP50', 'redoFrameP50', 'totalMs', 'heapGrowthMBperMin', 'perSubframeMs', 'longTasks'];
  const HIGHER = new Set(['fps']);
  const ABS_FLOOR = { heapGrowthMBperMin: 1, longTasks: 2, fps: 2 }; // ignore tiny absolute changes (noise)
  const regressions = [], improvements = [];
  const base = baselines(out, file);
  for (const [name, r] of Object.entries(results)) {
    const b = base[name];
    if (!b || r.error) continue;
    const p = b.r;
    for (const k of [...KEYS, ...Object.keys(r).filter(x => x.startsWith('op:'))]) {
      const a = p[k], v = r[k];
      if (typeof a !== 'number' || typeof v !== 'number') continue;
      if (Math.abs(v - a) < (ABS_FLOOR[k] ?? 0.3)) continue;
      const worse = HIGHER.has(k) ? (a - v) / Math.max(1e-9, a) : (v - a) / Math.max(1e-9, Math.abs(a));
      const e = { scenario: name, metric: k, before: a, after: v, change: `${Math.abs(worse * 100).toFixed(0)}% ${worse > 0 ? 'worse' : 'better'}`, baseline: b.commit };
      if (worse > THRESH) regressions.push(e); else if (worse < -THRESH) improvements.push(e);
    }
  }
  const nb = Object.keys(base).length;
  if (!nb) console.log('\nno earlier result to compare with (first run in this mode)');
  else {
    console.log(`\ncompared ${nb} scenarios with their newest earlier results (threshold ${THRESH * 100}%)`);
    if (improvements.length) { console.log(`improvements (${improvements.length}):`); console.table(improvements); }
    if (regressions.length) { console.log(`REGRESSIONS (${regressions.length}):`); console.table(regressions); } else console.log('no regressions');
  }
  return { regressions, improvements, baselines: Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.file])) };
}
