import { chromium } from './pw.mjs';
const n = process.argv[2] || 1000;
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', m => console.log('page:', m.text().slice(0, 200)));
await page.goto(`http://localhost:5173/?nobridge&blank&stress=${n}&kinds=rect,ellipse,text,path&nested`);
await page.waitForFunction(() => (window.editor?.renderer?.stats?.layers ?? 0) > 0);
console.log('loaded');
await page.evaluate(() => {
  const ed = window.editor; const A = ed.renderer.atlas; for (const m of ['compact','allocate','evictAll']) { const o = A[m].bind(A); A[m] = (...a) => { const t = performance.now(); console.log('>> ' + m + ' ' + JSON.stringify(a) + ' entries=' + A.size); const r = o(...a); console.log('<< ' + m + ' ' + (performance.now() - t).toFixed(1) + 'ms -> ' + r); return r; }; } ed.play();
  let i = 0;
  const iv = setInterval(() => { const a = ed.renderer.atlas, s = ed.renderer.stats; console.log(JSON.stringify({ i: i++, gen: a.generation, comp: a.compactions, entries: a.size, pages: a.pages, raster: +s.rasterMs.toFixed(1), frame: +s.frameMs.toFixed(1) })); if (i >= 8) clearInterval(iv); }, 500);
});
await page.waitForTimeout(5000);
await browser.close();
