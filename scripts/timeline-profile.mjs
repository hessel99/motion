// cpu profile of one timeline interaction in a big scene: node scripts/timeline-profile.mjs <scenario> [query]
// scenarios: wheel, graph, drag, search, click, expand
import { chromium } from './pw.mjs';
const scen = process.argv[2] || 'wheel';
const q = process.argv[3] || 'stress=25000';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${process.env.URL || 'http://localhost:4173/'}?nobridge&blank&${q}`);
await page.waitForFunction(() => (window.editor?.renderer?.stats?.layers ?? 0) > 0 && window.timeline);
await page.addStyleTag({ content: `.app { grid-template-rows: 44px 1fr 700px !important; }` });
await page.waitForTimeout(500);
await page.evaluate(scen => {
  const tl = window.timeline, st = editor.store;
  editor.stop();
  tl.canvas.setPointerCapture = () => {}; tl.canvas.releasePointerCapture = () => {};
  const rect = tl.canvas.getBoundingClientRect();
  window.pe = (type, x, y, o = {}) => tl.canvas.dispatchEvent(new PointerEvent(type, { clientX: rect.left + x, clientY: rect.top + y, button: 0, buttons: 1, pointerId: 1, bubbles: true, cancelable: true, ...o }));
  window.we = (x, y, o) => tl.canvas.dispatchEvent(new WheelEvent('wheel', { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, cancelable: true, ...o }));
  tl.frame();
  if (scen === 'graph') {
    const sel = new Set();
    for (const id of Object.keys(st.project.layers).slice(0, 2000)) { const l = st.project.layers[id]; for (const k in l.props) (l.props[k].kf || []).forEach((_, j) => sel.add(`${id}|${k}|${j}`)); }
    st.keySelection = sel; tl.graphMode = true;
  }
  if (scen === 'drag') {
    const top = tl.rows.filter(r => r.kind === 'layer').slice(0, 300).map(r => r.id); for (const id of top) tl.expand(id, true); tl.frame();
    const sel = new Set(); for (const id of top) { const l = st.project.layers[id]; for (const k in l.props) (l.props[k].kf || []).forEach((_, j) => sel.add(`${id}|${k}|${j}`)); }
    st.keySelection = sel; st.emit('keys'); tl.frame();
    const r = 1, row = tl.rows[r]; const kf = row.layer.props[row.prop].kf;
    window.hit = { x: tl.tToX(kf[1].t), y: tl.rowY(r) + 12 };
    pe('pointerdown', hit.x, hit.y);
  }
}, scen);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 50 }); await cdp.send('Profiler.start');
const ms = await page.evaluate(scen => {
  const tl = window.timeline, st = editor.store;
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) {
    if (scen === 'wheel') we(100, 200, { deltaY: i < 50 ? 120 : -120 });
    if (scen === 'graph') we(1000, 200, { deltaY: i % 2 ? 40 : -40, ctrlKey: true });
    if (scen === 'drag') pe('pointermove', hit.x + 4 + i * 3, hit.y);
    if (scen === 'search') { const s = document.querySelector('.tl-search'); s.value = ['r', 're', 'rec', 'rect', 'rect ', 'rect 1', 'rect 12'][i % 7]; s.dispatchEvent(new Event('input')); }
    if (scen === 'click') { const y = 28 + (i % 10) * 24 + 12; pe('pointerdown', 120, y); pe('pointerup', 120, y); }
    if (scen === 'expand') { const ids = Object.keys(st.project.layers); for (const id of ids) tl.expand(id, i % 2 === 0); }
    tl.frame();
  }
  return (performance.now() - t0) / 100;
}, scen);
const { profile } = await cdp.send('Profiler.stop');
const byId = new Map(profile.nodes.map(nd => [nd.id, nd])); const self = new Map();
profile.samples.forEach((s, i) => { const nd = byId.get(s); const k = `${nd.callFrame.functionName || '(anon)'} ${nd.callFrame.url.split('/').pop()}:${nd.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + (profile.timeDeltas[i] || 0)); });
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log(`${scen}: ${ms.toFixed(2)} ms/step`);
console.log([...self].filter(([k]) => !k.startsWith('(idle)')).sort((a, b) => b[1] - a[1]).slice(0, +(process.env.TOP || 18)).map(([k, us]) => `${(us / 1000).toFixed(1).padStart(7)}ms ${(100 * us / total).toFixed(1).padStart(5)}%  ${k}`).join('\n'));
await browser.close();
