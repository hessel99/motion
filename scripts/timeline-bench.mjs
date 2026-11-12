// timeline interaction benchmark: drives the canvas timeline with synthetic events in huge scenes
// and reports per-step main-thread cost (event handler + the timeline frame hook).
// usage: URL=http://localhost:4173/ node scripts/timeline-bench.mjs [10000,25000] [flat,nested]
import { chromium } from './pw.mjs';
const counts = (process.argv[2] || '10000,25000').split(',').map(Number);
const modes = (process.argv[3] || 'flat,nested').split(',');
const base = process.env.URL || 'http://localhost:4173/';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const all = {};
for (const n of counts) for (const mode of modes) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', e => console.error('pageerror', e.message));
  await page.goto(`${base}?nobridge&blank&stress=${n}${mode === 'nested' ? '&nested' : ''}`);
  await page.waitForFunction(() => (window.editor?.renderer?.stats?.layers ?? 0) > 0 && window.timeline);
  if (process.env.TALL) { await page.addStyleTag({ content: `.app { grid-template-rows: 44px 1fr ${process.env.TALL}px !important; }` }); await page.waitForTimeout(300); }
  await page.waitForTimeout(500);
  const res = await page.evaluate(async () => {
    const tl = window.timeline, ed = window.editor, st = ed.store;
    // keep the measurement about the timeline: the renderer still runs in the rAF loop, but we time only our steps
    tl.canvas.setPointerCapture = () => {}; tl.canvas.releasePointerCapture = () => {};
    const rect = tl.canvas.getBoundingClientRect();
    const raf = () => new Promise(r => requestAnimationFrame(() => r()));
    let baseDraws = 0;
    const origBase = tl.drawBase.bind(tl);
    tl.drawBase = (...a) => { baseDraws++; return origBase(...a); };
    const stats = a => { const s = a.slice().sort((x, y) => x - y); const sum = s.reduce((x, y) => x + y, 0); return { mean: +(sum / s.length).toFixed(3), p95: +s[Math.floor(s.length * 0.95)].toFixed(3), max: +s[s.length - 1].toFixed(3), n: s.length }; };
    const pe = (type, x, y, o = {}) => tl.canvas.dispatchEvent(new PointerEvent(type, { clientX: rect.left + x, clientY: rect.top + y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, bubbles: true, cancelable: true, ...o }));
    const we = (x, y, o) => tl.canvas.dispatchEvent(new WheelEvent('wheel', { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, cancelable: true, ...o }));
    // one step = event handler(s) + the frame hook, all synchronous; returns ms
    const step = fn => { const t0 = performance.now(); fn(); tl.frame(); return performance.now() - t0; };
    const run = async (name, nsteps, fn, setup) => {
      if (setup) setup();
      tl.frame();
      await raf();
      baseDraws = 0;
      const a = [];
      for (let i = 0; i < nsteps; i++) { a.push(step(() => fn(i))); if (i % 10 === 9) await raf(); }
      out[name] = { ...stats(a), baseDraws };
    };
    const out = {};
    const W = tl.w, H = tl.h;
    const trackX = tl.leftW + (W - tl.leftW) * 0.5, rowsY = 28 + 5 * 24 + 12;
    out.size = `${W}x${H}, rows ${tl.rows.length}`;

    // ---- playback with the timeline visible: per-frame cost of the frame hook
    {
      st.select([]); tl.frame(); await raf();
      const a = []; const orig = tl.frame; baseDraws = 0;
      tl.frame = function () { const t0 = performance.now(); orig.call(tl); a.push(performance.now() - t0); };
      ed.play();
      const t0 = performance.now(); while (performance.now() - t0 < 1500) await raf();
      ed.pause(); tl.frame = orig;
      out.play = { ...stats(a), baseDraws };
    }
    {
      // playback with an expanded layer and its prop rows visible
      tl.expand(st.comp.root[st.comp.root.length - 1]); tl.frame(); await raf();
      const a = []; const orig = tl.frame; baseDraws = 0;
      tl.frame = function () { const t0 = performance.now(); orig.call(tl); a.push(performance.now() - t0); };
      ed.play();
      const t0 = performance.now(); while (performance.now() - t0 < 1500) await raf();
      ed.pause(); tl.frame = orig;
      out.playExpanded = { ...stats(a), baseDraws };
      tl.expanded.clear(); tl.expand(st.comp.root[0], false);
    }
    // ---- scrolling / zoom
    await run('wheelScroll', 200, i => we(100, rowsY, { deltaY: i < 100 ? 120 : -120 }));
    await run('ctrlZoom', 100, i => we(trackX, rowsY, { deltaY: i % 2 ? 40 : -40, ctrlKey: true }));
    await run('shiftHScroll', 100, i => we(trackX, rowsY, { deltaY: i < 50 ? 60 : -60, shiftKey: true }));
    // ---- expand / collapse all
    const layerIds = Object.keys(st.project.layers);
    await run('expandCollapse', 4, i => { for (const id of layerIds) tl.expand(id, i % 2 === 0); });
    for (const id of layerIds) tl.expand(id, true); tl.frame();
    out.rowsExpanded = tl.rows.length;
    await run('wheelScrollExpanded', 200, i => we(100, rowsY, { deltaY: i < 100 ? 240 : -240 }));
    await run('ctrlZoomExpanded', 100, i => we(trackX, rowsY, { deltaY: i % 2 ? 40 : -40, ctrlKey: true }));
    for (const id of layerIds) tl.expand(id, false); tl.frame();
    // ---- search typing
    const search = document.querySelector('.tl-search');
    const word = 'rect 12';
    await run('searchType', word.length * 2, i => { search.value = i < word.length ? word.slice(0, i + 1) : word.slice(0, word.length * 2 - i - 1); search.dispatchEvent(new Event('input')); });
    search.value = ''; search.dispatchEvent(new Event('input')); tl.frame();
    // ---- click a row (selection change -> reveal)
    await run('clickRow', 40, i => { const y = 28 + (i % 10) * 24 + 12; pe('pointerdown', 120, y); pe('pointerup', 120, y); });
    // ---- edit: toggle visibility via the eye (doc -> rows rebuild)
    await run('toggleVisible', 20, () => { pe('pointerdown', tl.leftW - 40, rowsY); pe('pointerup', tl.leftW - 40, rowsY); });
    // ---- hover across rows (row hover redraws the base)
    await run('hoverRows', 100, i => pe('pointermove', 150, 28 + (i % 20) * 24 + 5, { buttons: 0 }));
    // ---- marquee over expanded rows (alt-drag on track)
    { tl.frame(); const top = tl.rows.filter(r => r.kind === 'layer').slice(0, 2000).map(r => r.id); for (const id of top) tl.expand(id, true); }
    tl.scrollY = 0; tl.frame();
    {
      const steps = 60; let i = 0;
      await run('marquee', steps, k => {
        if (k === 0) pe('pointerdown', tl.leftW + 5, 30, { altKey: true });
        const f = (k + 1) / steps;
        pe('pointermove', tl.leftW + 5 + (W - tl.leftW - 10) * f, 30 + (H - 40) * f, { altKey: true });
      });
      out.marqueeSelected = st.keySelection.size;
      pe('pointerup', W - 10, H - 10);
    }
    // ---- select many keys (all keys of the first 300 layers, expanded) and drag one of them
    {
      const sel = new Set();
      tl.scrollY = 0; tl.frame();
      const ids = []; for (const r of tl.rows) { if (r.kind === 'layer' && Object.values(r.layer.props).some(p => p?.kf?.length)) ids.push(r.id); if (ids.length >= 300) break; }
      for (const id of ids) { const l = st.project.layers[id]; for (const k in l.props) (l.props[k].kf || []).forEach((_, j) => sel.add(`${id}|${k}|${j}`)); }
      st.keySelection = sel; st.emit('keys');
      // find the first visible prop row with a key in the selection
      tl.frame();
      let hit = null;
      for (let r = 0; r < 30 && !hit; r++) {
        const row = tl.rows[r]; if (!row || row.kind !== 'prop') continue;
        const kf = row.layer.props[row.prop].kf; if (!kf?.length) continue;
        if (!sel.has(`${row.id}|${row.prop}|1`)) continue;
        hit = { x: tl.tToX(kf[1].t), y: tl.rowY(r) + 12 };
      }
      out.dragSelected = sel.size;
      if (hit) {
        await run('dragKeys', 40, k => {
          if (k === 0) pe('pointerdown', hit.x, hit.y);
          pe('pointermove', hit.x + 4 + k * 3, hit.y);
        });
        pe('pointerup', hit.x + 200, hit.y); tl.frame();
        // undo the drag
        st.undo?.();
      } else out.dragKeys = 'no hit';
    }
    // ---- graph editor with many selected keys
    {
      const sel = new Set();
      for (const id of layerIds.slice(0, 2000)) { const l = st.project.layers[id]; for (const k in l.props) (l.props[k].kf || []).forEach((_, j) => sel.add(`${id}|${k}|${j}`)); }
      st.keySelection = sel; st.emit('keys');
      tl.graphMode = true; tl.frame();
      out.graphSelected = sel.size;
      await run('graphRedraw', 30, i => we(trackX, rowsY, { deltaY: i % 2 ? 40 : -40, ctrlKey: true }));
      tl.graphMode = false;
      st.keySelection = new Set(); st.emit('keys');
    }
    return out;
  });
  // long tasks during a real-input wheel burst
  all[`${n}-${mode}`] = res;
  console.log(`\n== ${n} ${mode}`, JSON.stringify(res, null, 0).replace(/},"/g, '},\n "'));
  await page.close();
}
await browser.close();
if (process.env.OUT) (await import('node:fs')).writeFileSync(process.env.OUT, JSON.stringify(all, null, 1));
