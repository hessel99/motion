// paste a real figma capture N times, measure paste + first frame times
import { chromium } from './pw.mjs';
import { readFileSync } from 'node:fs';
const [,, file, nStr] = process.argv;
const N = +(nStr || 40);
const html = readFileSync(file, 'utf8');
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto((process.env.URL || 'http://localhost:5173/') + '?blank&nobridge');
await page.waitForFunction(() => window.editor?.renderer);
await page.waitForTimeout(2500); // let idle preloading happen, like a real user would
const r = await page.evaluate(async ({ html, N }) => {
  const times = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const dt = new DataTransfer(); dt.setData('text/html', html);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    times.push(performance.now() - t0);
  }
  await new Promise(r => setTimeout(r, 200));
  const r0 = performance.now();
  editor.renderer.render(editor.store.time);
  const firstFrame = performance.now() - r0;
  // frames until all rasters are resolved (budgeted cold start)
  let frames = 0; const c0 = performance.now();
  while (editor.renderer.dirty && frames < 500) { editor.renderer.render(editor.store.time); frames++; }
  const coldMs = performance.now() - c0;
  const s0 = performance.now(); editor.renderer.render(editor.store.time + 0.001); const steady = performance.now() - s0;
  times.sort((a, b) => a - b);
  return { layers: Object.keys(editor.store.project.layers).length, pasteMedianMs: +times[times.length >> 1].toFixed(1), pasteMaxMs: +times[times.length - 1].toFixed(1), firstFrameMs: +firstFrame.toFixed(1), coldStartFrames: frames, coldStartMs: +coldMs.toFixed(0), steadyFrameMs: +steady.toFixed(2), atlas: editor.renderer.atlas.size };
}, { html, N });
console.log(JSON.stringify(r));
console.log(errs.length ? errs.slice(0, 3) : 'no errors');
await browser.close();
