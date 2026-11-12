// playback performance test: loads N fully animated layers, plays, samples frame timings.
// usage: node scripts/perf.mjs [counts=1000,5000,10000,25000] [--kinds rect,ellipse,text,path] [--nested] [--headed]
import { chromium } from './pw.mjs';
const counts = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '1000,5000,10000,25000').split(',').map(Number);
const kindsIdx = process.argv.indexOf('--kinds');
const kinds = kindsIdx > 0 ? process.argv[kindsIdx + 1] : '';
const nested = process.argv.includes('--nested');
const headed = process.argv.includes('--headed');
const url = process.env.URL || 'http://localhost:5173/';
const browser = await chromium.launch({ headless: !headed, args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
const rows = [];
for (const n of counts) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  const t0 = Date.now();
  await page.goto(`${url}?nobridge&blank&stress=${n}${kinds ? '&kinds=' + kinds : ''}${nested ? '&nested' : ''}`);
  await page.waitForFunction(() => (window.editor?.renderer?.stats?.layers ?? 0) > 0, null, { timeout: 60000 });
  const loadMs = Date.now() - t0;
  const r = await page.evaluate(async () => {
    const ed = window.editor;
    ed.play();
    await new Promise(r => setTimeout(r, 800)); // warmup (rasters, jit)
    const frames = [], ev = [], wr = [], gpu = [], tot = [];
    let last = performance.now();
    await new Promise(res => {
      const end = last + 3000;
      const loop = now => {
        frames.push(now - last); last = now;
        const s = ed.renderer.stats;
        ev.push(s.evalMs); wr.push(s.writeMs); gpu.push(s.gpuSubmitMs); tot.push(s.frameMs);
        if (now < end) requestAnimationFrame(loop); else res();
      };
      requestAnimationFrame(loop);
    });
    const med = a => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
    const p95 = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length * 0.95)]; };
    const s = ed.renderer.stats;
    return { fps: +(1000 / med(frames)).toFixed(1), p95FrameMs: +p95(frames).toFixed(1), cpuFrameMs: +med(tot).toFixed(2), evalMs: +med(ev).toFixed(2), writeMs: +med(wr).toFixed(2), gpuSubmitMs: +med(gpu).toFixed(2), drawn: s.instances, drawCalls: s.drawCalls };
  });
  rows.push({ layers: n, loadMs, ...r, errors: errs.length });
  await page.close();
}
console.table(rows);
await browser.close();
