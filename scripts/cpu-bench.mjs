// cpu-only frame cost of the renderer, isolated from the (software) gpu.
// the rAF loop is stopped and the canvas shrunk to 64x40 so fragment work is ~0; every frame
// is followed by a 1px readPixels so command queues never pile up. what remains is the cost the
// editor pays per frame on the main thread on any machine: evaluation, instance writing,
// buffer upload, draw submission.
// usage: node scripts/cpu-bench.mjs [counts=1000,5000,10000,25000] [--kinds rect,text] [--nested] [--animated 0.1] [--profile] [--frames 240] [--draw] [--full (no incremental instance updates)]
//        [--components instances|copies] counts = number of instances of a 24-layer animated title card
//        component, each with its own title text + accent color + timing (instances), or the same as
//        linked layer copies (copies: core/components.ts) for comparison
import { chromium } from './pw.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const counts = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '1000,5000,10000,25000').split(',').map(Number);
const kinds = arg('--kinds', '');
const nested = process.argv.includes('--nested');
const profile = process.argv.includes('--profile');
const frames = +arg('--frames', 240);
const animated = arg('--animated', '');
const compMode = arg('--components', '');
const url = process.env.URL || 'http://localhost:5173/';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--js-flags=--expose-gc'] });
const rows = [];
for (const n of counts) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const t0 = Date.now();
  let build = null;
  if (compMode) {
    await page.goto(`${url}?nobridge&blank`);
    await page.waitForFunction(() => window.editor);
    await page.addScriptTag({ type: 'module', content: `window.componentScene = ${COMPONENT_SCENE()}` });
    await page.waitForFunction(() => window.componentScene);
    build = await page.evaluate(({ n, mode }) => window.componentScene(n, mode), { n, mode: compMode });
  } else await page.goto(`${url}?nobridge&blank&stress=${n}${kinds ? '&kinds=' + kinds : ''}${nested ? '&nested' : ''}${animated ? '&animated=' + animated : ''}`);
  await page.waitForFunction(() => (window.editor?.renderer?.stats?.layers ?? 0) > 0, null, { timeout: 120000 });
  const loadMs = Date.now() - t0;
  const cdp = await page.context().newCDPSession(page);
  if (process.argv.includes('--draw')) await page.evaluate(() => { window.__keepDraws = true; });
  if (process.argv.includes('--full')) await page.evaluate(() => { window.editor.renderer.incremental = false; });
  // warm up: first-time rasters, jit
  await page.evaluate(() => {
    const ed = window.editor, R = ed.renderer, gl = R.gl;
    ed.stop();
    // the software gpu competes with the main thread for the same cores: skip the actual draws
    // (buffer uploads, state changes and command encoding still run). --draw keeps them.
    if (!window.__keepDraws) { gl.drawArraysInstanced = () => {}; gl.drawArrays = () => {}; }
    R.resize(64, 40, 1);
    R.setView(64 / ed.store.comp.width, 0, 0); // whole comp in view: nothing culled, ~1px fragments
    const px = new Uint8Array(4);
    let t = 0.5;
    for (let i = 0; i < 60; i++) { R.render(t += 1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    window.__t = t;
    window.gc?.();
  });
  if (profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 50 }); await cdp.send('Profiler.start'); }
  const r = await page.evaluate((frames) => {
    const ed = window.editor, R = ed.renderer, gl = R.gl;
    const px = new Uint8Array(4);
    let t = window.__t;
    const ev = [], wr = [], gs = [], tot = [];
    const h0 = performance.memory?.usedJSHeapSize ?? 0;
    for (let i = 0; i < frames; i++) {
      R.render(t += 1 / 60);
      const s = R.stats;
      ev.push(s.evalMs); wr.push(s.writeMs); gs.push(s.gpuSubmitMs); tot.push(s.frameMs);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    const h1 = performance.memory?.usedJSHeapSize ?? 0;
    const med = a => { const b = [...a].sort((x, y) => x - y); return +b[b.length >> 1].toFixed(2); };
    const p95 = a => { const b = [...a].sort((x, y) => x - y); return +b[Math.floor(b.length * 0.95)].toFixed(2); };
    return { poolKB: Math.round(R.pool.used * 8 / 1024), items: R.items.length, frameMs: med(tot), uploadKB: Math.round(R.stats.uploadBytes / 1024), p95: p95(tot), evalMs: med(ev), writeMs: med(wr), submitMs: med(gs), heapKBperFrame: +((h1 - h0) / 1024 / frames).toFixed(1), instances: R.stats.instances };
  }, frames);
  if (profile) {
    const { profile: prof } = await cdp.send('Profiler.stop');
    const byId = new Map(prof.nodes.map(nd => [nd.id, nd])); const self = new Map();
    prof.samples.forEach((s, i) => { const nd = byId.get(s); const k = `${nd.callFrame.functionName || '(anon)'} ${nd.callFrame.url.split('/').pop().split('?')[0]}:${nd.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + (prof.timeDeltas[i] || 0)); });
    const total = [...self.entries()].filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)')).reduce((a, [, b]) => a + b, 0);
    if (process.env.LINES) {
      // hottest source lines of one function (positionTicks), e.g. LINES=render
      const lines = new Map();
      for (const nd of prof.nodes) if (nd.callFrame.functionName === process.env.LINES) for (const pt of nd.positionTicks ?? []) lines.set(pt.line, (lines.get(pt.line) || 0) + pt.ticks);
      console.log([...lines].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([l, t]) => `line ${l}: ${t}`).join('\n'));
    }
    console.log(`--- ${n} layers, self time ---`);
    console.log([...self].filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)')).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, us]) => `${(100 * us / total).toFixed(1).padStart(5)}%  ${k}`).join('\n'));
  }
  rows.push({ ...(compMode ? { mode: compMode, n } : { layers: n }), loadMs, ...(build ?? {}), ...r });
  await page.close();
}
console.table(rows);
await browser.close();

// a 24-layer title card (bg, 8 bars, 12 letters, title, subtitle, accent; most layers animated) and
// n instances / copies of it in a grid, each with its own title, accent color and start time
function COMPONENT_SCENE() { return `async (n, mode) => {
  const ed = window.editor, s = ed.store;
  const C = await import('/src/core/commands.ts');
  const M = await import('/src/core/motion-components.ts');
  const K = await import('/src/core/components.ts');
  C.setCompSettings(s, { width: 1920, height: 1080, duration: 4 });
  const ids = [];
  const key = (id, k, t, v) => { s.setTime(t); C.setProp(s, id, k, v, { forceKey: true }); };
  ids.push(C.addLayer(s, 'rect', { name: 'bg', x: 0, y: 0, w: 1920, h: 1080, color: [0.1, 0.1, 0.12, 1] }).id);
  for (let i = 0; i < 8; i++) { const b = C.addLayer(s, 'rect', { name: 'bar' + i, x: 200 + i * 190, y: 300, w: 150, h: 20 }); key(b.id, 'scale', 0, [0, 100]); key(b.id, 'scale', 0.4 + i * 0.05, [100, 100]); key(b.id, 'opacity', 3, [100]); key(b.id, 'opacity', 3.6, [0]); ids.push(b.id); }
  for (let i = 0; i < 12; i++) { const e = C.addLayer(s, 'ellipse', { name: 'dot' + i, x: 300 + i * 110, y: 800, w: 40, h: 40 }); key(e.id, 'position', 0, [320 + i * 110, 900]); key(e.id, 'position', 0.6, [320 + i * 110, 820]); key(e.id, 'rotation', 0, [0]); key(e.id, 'rotation', 4, [90]); ids.push(e.id); }
  const txt = c => ({ content: c, fontFamily: 'Inter', fontSize: 96, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'center' });
  const title = C.addLayer(s, 'text', { name: 'title', x: 260, y: 420, w: 1400, h: 140, text: txt('Title') }); key(title.id, 'opacity', 0, [0]); key(title.id, 'opacity', 0.5, [100]); ids.push(title.id);
  const sub = C.addLayer(s, 'text', { name: 'sub', x: 460, y: 590, w: 1000, h: 60, text: { ...txt('Sub'), fontSize: 40 } }); ids.push(sub.id);
  const acc = C.addLayer(s, 'rect', { name: 'accent', x: 860, y: 380, w: 200, h: 10, color: [1, 0.3, 0.2, 1] }); key(acc.id, 'scale', 0, [0, 100]); key(acc.id, 'scale', 0.5, [100, 100]); ids.push(acc.id);
  s.setTime(0);
  const cols = Math.ceil(Math.sqrt(n)), w = 1920 / cols, sc = 100 / cols;
  const t0 = performance.now();
  if (mode === 'copies') {
    const g = C.groupLayers(s, ids, { x: 0, y: 0, w: 1920, h: 1080 });
    K.createComponent(s, g.id, 'Card');
    const out = [];
    s.batch('bench', () => { for (let i = 0; i < n; i++) out.push(K.createInstance(s, g.id, { x: (i % cols + 0.5) * w, y: (Math.floor(i / cols) + 0.5) * w * 9 / 16, delay: (i % 7) * 0.1, select: false })); });
    s.batch('vals', () => { for (const l of out) { const L = s.project.layers; const kids = l.children.map(c => L[c]); const t = kids.find(k => k.name === 'title'); C.setLayerField(s, [t.id], 'text', { ...t.text, content: 'Card ' + l.id }); const a = kids.find(k => k.name === 'accent'); C.setProp(s, a.id, 'fill', [Math.random(), 0.5, 0.8, 1]); C.setProp(s, l.id, 'scale', [sc, sc]); } });
  } else {
    const { comp, layer } = M.makeComponent(s, ids, { name: 'Card' });
    M.exposeProperty(s, comp.id, { name: 'Title', targets: [{ layer: title.id, field: 'text' }] });
    M.exposeProperty(s, comp.id, { name: 'Accent', targets: [{ layer: acc.id, field: 'fill' }] });
    C.deleteLayers(s, [layer.id]);
    s.batch('bench', () => { for (let i = 0; i < n; i++) { const l = M.addMotionInstance(s, comp.id, { x: (i % cols + 0.5) * w, y: (Math.floor(i / cols) + 0.5) * w * 9 / 16, start: (i % 7) * 0.1, play: i % 3 ? { loop: 'loop' } : { speed: 1.5, hold: 'last' }, props: { Title: 'Card ' + i, Accent: [Math.random(), 0.5, 0.8, 1] }, select: false }); C.setProp(s, l.id, 'scale', [sc, sc]); } });
  }
  const buildMs = Math.round(performance.now() - t0);
  ed.renderer.render(0.5);
  // an edit of the main (every instance follows): store transaction + recompile + one frame
  const e0 = performance.now();
  C.setProp(s, ids[1], 'fill', [0.2, 0.9, 0.4, 1]);
  ed.renderer.render(0.5);
  const editMs = Math.round((performance.now() - e0) * 10) / 10;
  return { buildMs, editMs, docLayers: Object.keys(s.project.layers).length, patched: ed.renderer.patchedLayers ?? 0 };
}` }
