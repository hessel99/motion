// renders the same scene frame by frame on two servers (e.g. a baseline build and the current
// one) and compares the pixels. guards renderer optimizations: visuals must stay identical.
// SELF=1: compare incremental frames against full rewrites of the same frame on B (exact).
// A_FULL=1 turns the renderer's incremental instance updates off on A (same build a/b).
// usage: A=http://localhost:4182/ B=http://localhost:4181/ node scripts/pixel-compare.mjs ["stress=2000&kinds=rect,ellipse,text,path&nested&animated=0.3" ...]
import { chromium } from './pw.mjs';
const A = process.env.A || 'http://localhost:4173/', B = process.env.B || 'http://localhost:5173/';
const scenes = process.argv.slice(2).length ? process.argv.slice(2) : ['stress=2000&kinds=rect,ellipse,text,path&nested&animated=0.3', 'demo', 'stress=3000&animated=0.1'];
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
async function frames(base, q, fullOnly) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${base}?nobridge&blank&${q}`);
  await page.waitForFunction(() => (window.editor?.renderer?.stats?.layers ?? 0) > 0, null, { timeout: 60000 });
  await page.waitForTimeout(1500); // fonts, async rasters
  if (fullOnly) await page.evaluate(() => { window.__full = true; });
  if (process.env.SELF) await page.evaluate(() => { window.__self = true; });
  const out = await page.evaluate(async () => {
    const ed = window.editor, R = ed.renderer;
    ed.stop();
    if (window.__full) R.incremental = false;
    // deterministic rasters: no workers, no frame budget (otherwise a faster frame can do a
    // resolution upgrade earlier, which is a legit but timing dependent difference)
    R.workersOk = false; R.rasterBudgetMs = 1e9;
    R.syncRaster = true; R.render(0); R.syncRaster = false; // all rasters resident
    const shots = [];
    // play 90 frames forward (exercises the incremental paths), grab a few of them
    for (let f = 0; f <= 90; f++) {
      R.render(f / 30);
      if (f % 30 === 0) {
        shots.push(R.canvas.toDataURL('image/png'));
        // SELF mode: the same frame fully rewritten + uploaded (same atlas state) must match
        if (window.__self) { R.dirty = true; R.render(f / 30); shots.push(R.canvas.toDataURL('image/png')); }
      }
    }
    // a pan in between (view change) and a jump back
    R.setView(R.zoom * 1.3, R.panX - 40, R.panY - 20); R.render(1.234); shots.push(R.canvas.toDataURL('image/png'));
    return shots;
  });
  await page.close();
  return out;
}
async function diff(a, b) {
  const page = await browser.newPage();
  const r = await page.evaluate(async ([a, b]) => {
    const load = src => new Promise(res => { const im = new Image(); im.onload = () => res(im); im.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const c = new OffscreenCanvas(ia.width, ia.height), g = c.getContext('2d');
    g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, c.width, c.height).data;
    g.clearRect(0, 0, c.width, c.height); g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, c.width, c.height).data;
    let max = 0, n = 0;
    for (let i = 0; i < da.length; i++) { const d = Math.abs(da[i] - db[i]); if (d) n++; if (d > max) max = d; }
    return { max, changed: n };
  }, [a, b]);
  await page.close();
  return r;
}
let bad = 0;
if (process.env.SELF) {
  // incremental frame vs the same frame fully rewritten, in one page (exact, no history effects)
  for (const q of scenes) {
    const fr = await frames(B, q, false);
    const res = [];
    for (let i = 0; i + 1 < fr.length - 1; i += 2) { const d = await diff(fr[i], fr[i + 1]); res.push(`${d.max}/${d.changed}`); if (d.max > 0) bad++; }
    console.log(`${q}: incremental vs full rewrite: ${res.join('  ')}`);
  }
  console.log(bad ? `FAIL ${bad} shots differ` : 'PASS identical');
  await browser.close();
  process.exit(bad ? 1 : 0);
}
for (const q of scenes) {
  const [fa, fb] = [await frames(A, q, !!process.env.A_FULL), await frames(B, q, !!process.env.B_FULL)];
  const res = [];
  for (let i = 0; i < fa.length; i++) { const d = await diff(fa[i], fb[i]); res.push(`${d.max}/${d.changed}`); if (d.max > 2) bad++; }
  console.log(`${q}: max diff / changed bytes per shot: ${res.join('  ')}`);
}
console.log(bad ? `FAIL ${bad} shots differ` : 'PASS identical');
await browser.close();
