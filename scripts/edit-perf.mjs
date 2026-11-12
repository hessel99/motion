// editing responsiveness in a huge scene: drag a layer and measure time per pointer move (main thread)
import { chromium } from './pw.mjs';
const n = +(process.argv[2] || 10000);
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${process.env.URL || 'http://localhost:5173/'}?nobridge&blank&stress=${n}`);
await page.waitForFunction(() => (window.editor?.renderer?.stats?.layers ?? 0) > 0);
await page.waitForTimeout(1500);
const res = await page.evaluate(async () => {
  const ed = window.editor, st = ed.store;
  const id = st.comp.root[st.comp.root.length - 1]; // top-most layer
  st.select([id]);
  await new Promise(r => setTimeout(r, 300));
  const c = ed.renderer.corners(id);
  const vp = window.viewport;
  const host = document.querySelector('.viewport');
  const rect = host.getBoundingClientRect();
  const sx = rect.left + vp.panX + ((c[0] + c[4]) / 2) * vp.zoom, sy = rect.top + vp.panY + ((c[1] + c[5]) / 2) * vp.zoom;
  const fire = (type, x, y) => host.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, bubbles: true }));
  // instrument: long tasks + per-event handler time
  const times = [];
  fire('pointerdown', sx, sy);
  for (let i = 1; i <= 40; i++) {
    const t0 = performance.now();
    fire('pointermove', sx + i * 3, sy + i * 2);
    // force the frame work that the move causes (render + hooks), like a real frame would
    ed.renderer.render(st.time);
    times.push(performance.now() - t0);
    await new Promise(r => requestAnimationFrame(r));
  }
  fire('pointerup', sx + 120, sy + 80);
  times.sort((a, b) => a - b);
  return { median: +times[times.length >> 1].toFixed(2), p95: +times[Math.floor(times.length * 0.95)].toFixed(2), max: +times[times.length - 1].toFixed(2) };
});
console.log(`${n} layers, drag one layer: ms per move (handler + render)`, res);
// frame-level: measure rAF intervals during a drag (includes timeline/inspector/overlay work)
await browser.close();
{
  const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`${process.env.URL || 'http://localhost:5173/'}?nobridge&blank&stress=${n}`);
  await page.waitForFunction(() => (window.editor?.renderer?.stats?.layers ?? 0) > 0);
  await page.waitForTimeout(1500);
  const p = await page.evaluate(() => { const st = editor.store; const id = st.comp.root[st.comp.root.length - 1]; st.select([id]); const c = editor.renderer.corners(id); const r = document.querySelector('.viewport').getBoundingClientRect(); return { x: r.left + viewport.panX + ((c[0] + c[4]) / 2) * viewport.zoom, y: r.top + viewport.panY + ((c[1] + c[5]) / 2) * viewport.zoom }; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__long = []; new PerformanceObserver(l => l.getEntries().forEach(e => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: false }); window.__fr = []; let last = performance.now(); const loop = n => { window.__fr.push(n - last); last = n; if (window.__fr.length < 400) requestAnimationFrame(loop); }; requestAnimationFrame(loop); });
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  for (let i = 1; i <= 40; i++) { await page.mouse.move(p.x + i * 4, p.y + i * 2); }
  await page.mouse.up();
  const r = await page.evaluate(() => { const f = window.__fr.slice(2).sort((a, b) => a - b); return { frames: f.length, medianFrameMs: +f[f.length >> 1].toFixed(1), p95: +f[Math.floor(f.length * 0.95)].toFixed(1), longTasks: window.__long }; });
  console.log('real mouse drag, full frames:', r);
  await browser.close();
}
