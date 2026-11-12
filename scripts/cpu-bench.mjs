// cpu-only frame cost of the renderer, isolated from the (software) gpu.
// the rAF loop is stopped and the canvas shrunk to 64x40 so fragment work is ~0; every frame
// is followed by a 1px readPixels so command queues never pile up. what remains is the cost the
// editor pays per frame on the main thread on any machine: evaluation, instance writing,
// buffer upload, draw submission.
// usage: node scripts/cpu-bench.mjs [counts=1000,5000,10000,25000] [--kinds rect,text] [--nested] [--animated 0.1] [--profile] [--frames 240] [--draw] [--full (no incremental instance updates)]
import { chromium } from './pw.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const counts = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '1000,5000,10000,25000').split(',').map(Number);
const kinds = arg('--kinds', '');
const nested = process.argv.includes('--nested');
const profile = process.argv.includes('--profile');
const frames = +arg('--frames', 240);
const animated = arg('--animated', '');
const url = process.env.URL || 'http://localhost:5173/';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--js-flags=--expose-gc'] });
const rows = [];
for (const n of counts) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const t0 = Date.now();
  await page.goto(`${url}?nobridge&blank&stress=${n}${kinds ? '&kinds=' + kinds : ''}${nested ? '&nested' : ''}${animated ? '&animated=' + animated : ''}`);
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
    return { frameMs: med(tot), uploadKB: Math.round(R.stats.uploadBytes / 1024), p95: p95(tot), evalMs: med(ev), writeMs: med(wr), submitMs: med(gs), heapKBperFrame: +((h1 - h0) / 1024 / frames).toFixed(1), instances: R.stats.instances };
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
  rows.push({ layers: n, loadMs, ...r });
  await page.close();
}
console.table(rows);
await browser.close();
