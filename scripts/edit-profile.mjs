// edit-path profiler: per-edit main-thread cost in huge scenes (the edit + the two frames it causes),
// with a CDP CPU profile breakdown (self and inclusive ms per edit).
// usage: URL=http://localhost:4173/ node scripts/edit-profile.mjs [10000,25000] [key1,keysMany,layerMove,scrub,visible,rename] [--top=12] [--quiet]
import { chromium } from './pw.mjs';
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const counts = (args[0] || '10000,25000').split(',').map(Number);
const only = args[1] ? args[1].split(',') : null;
const TOP = +(process.argv.find(a => a.startsWith('--top='))?.slice(6) ?? 12);
const base = process.env.URL || 'http://localhost:4173/';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const SCEN = ['key1', 'keysMany', 'layerMove', 'scrub', 'visible', 'rename'];
for (const n of counts) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', e => console.error('pageerror', e.message));
  await page.goto(`${base}?nobridge&blank&stress=${n}`);
  await page.waitForFunction(() => (window.editor?.renderer?.stats?.layers ?? 0) > 0 && window.timeline && window.__cmds);
  if (process.env.NOAGENT) await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('Agent') && b.classList.contains('on') || b.getAttribute('aria-pressed') === 'true' && b.textContent.includes('Agent'))?.click());
  await page.waitForTimeout(800);
  console.log('agent panel open:', await page.evaluate(() => !!document.querySelector('.ag-panel')));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  for (const sc of SCEN) {
    if (only && !only.includes(sc)) continue;
    const info = await page.evaluate(async sc => {
      const ed = window.editor, st = ed.store, C = window.__cmds;
      const raf = () => new Promise(r => requestAnimationFrame(() => r()));
      const root = st.comp.root;
      const top = root[root.length - 1];
      if (sc === 'key1' || sc === 'keysMany') {
        const sel = new Set();
        const ids = sc === 'key1' ? [root.find(id => Object.values(st.project.layers[id].props).some(p => p?.kf?.length > 1))] : root.slice(0, 1500);
        for (const id of ids) { const l = st.project.layers[id]; for (const k in l.props) (l.props[k].kf || []).forEach((_, j) => { if (sc === 'keysMany' || (sel.size === 0 && j === 1)) sel.add(`${id}|${k}|${j}`); }); }
        st.select([ids[0]]);
        st.keySelection = sel; st.emit('keys'); await raf(); await raf();
        let snap, i = 0;
        window.__steps = { begin() { st.beginGesture('keys'); snap = C.snapshotKeys(st, st.keySelection); }, step() { i++; C.moveKeysFrom(st, snap, i / 30); }, end() { st.endGesture(); st.undo(); } };
        return { selected: sel.size };
      }
      st.select([top]); await raf(); await raf();
      if (sc === 'layerMove') {
        const c = ed.renderer.corners(top), vp = window.viewport, host = document.querySelector('.viewport'), rect = host.getBoundingClientRect();
        const sx = rect.left + vp.panX + ((c[0] + c[4]) / 2) * vp.zoom, sy = rect.top + vp.panY + ((c[1] + c[5]) / 2) * vp.zoom;
        const fire = (type, x, y) => host.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, bubbles: true }));
        let i = 0;
        window.__steps = { begin() { fire('pointerdown', sx, sy); }, step() { i++; fire('pointermove', sx + i * 3, sy + i * 2); }, end() { fire('pointerup', sx + i * 3, sy + i * 2); st.undo(); } };
        return {};
      }
      if (sc === 'scrub') {
        let i = 0;
        window.__steps = { begin() {}, step() { i++; C.setProp(st, top, 'rotation', [i], { mergeKey: 'scrub-rot' }); }, end() { st.undo(); } };
        return {};
      }
      if (sc === 'visible') {
        const l = st.project.layers[top];
        window.__steps = { begin() {}, step() { C.setLayerField(st, [top], 'visible', !l.visible, 'Toggle visibility'); }, end() {} };
        return {};
      }
      if (sc === 'rename') {
        let i = 0;
        window.__steps = { begin() {}, step() { i++; C.renameLayer(st, top, 'renamed ' + i); }, end() {} };
        return {};
      }
    }, sc);
    await page.evaluate(() => window.__steps.begin());
    const N = 30;
    await cdp.send('Profiler.start');
    const sync = await page.evaluate(async N => {
      const raf = () => new Promise(r => requestAnimationFrame(() => r()));
      const a = [];
      for (let i = 0; i < N; i++) { const s = performance.now(); window.__steps.step(); a.push(performance.now() - s); await raf(); await raf(); }
      a.sort((x, y) => x - y);
      return { med: +a[a.length >> 1].toFixed(2), p95: +a[Math.floor(a.length * 0.95)].toFixed(2) };
    }, N);
    const { profile } = await cdp.send('Profiler.stop');
    await page.evaluate(() => window.__steps.end());
    const byId = new Map(profile.nodes.map(nd => [nd.id, nd]));
    const parent = new Map(); for (const nd of profile.nodes) for (const c of nd.children || []) parent.set(c, nd.id);
    const dt = profile.timeDeltas, self = new Map(), incl = new Map();
    const IDLE = new Set(['(idle)', '(program)', '(garbage collector)']);
    const name = cf => `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`;
    let busy = 0, gc = 0;
    for (let i = 0; i < profile.samples.length; i++) {
      const id = profile.samples[i], d = (dt[i + 1] ?? 0) / 1000, nd = byId.get(id), fn = nd.callFrame.functionName;
      if (fn === '(garbage collector)') gc += d;
      if (IDLE.has(fn)) continue;
      busy += d;
      const k = name(nd.callFrame);
      self.set(k, (self.get(k) || 0) + d);
      const seen = new Set();
      for (let p = id; p != null; p = parent.get(p)) { const q = name(byId.get(p).callFrame); if (seen.has(q)) continue; seen.add(q); incl.set(q, (incl.get(q) || 0) + d); }
    }
    const fmt = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([k, v]) => `    ${(v / N).toFixed(3).padStart(7)}  ${k}`).join('\n');
    console.log(`\n== ${n} ${sc} ${JSON.stringify(info)} sync med ${sync.med} p95 ${sync.p95} | busy/edit ${(busy / N).toFixed(2)} ms  gc/edit ${(gc / N).toFixed(2)}`);
    if (!process.argv.includes('--quiet')) { console.log('  self:'); console.log(fmt(self)); console.log('  inclusive:'); console.log(fmt(incl)); }
  }
  await page.close();
}
await browser.close();
