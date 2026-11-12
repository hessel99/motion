import { chromium } from './pw.mjs';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist','--disable-frame-rate-limit','--disable-gpu-vsync'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:5173/?nobridge&blank&stress=' + (process.argv[2]||1000));
await page.waitForFunction(() => (window.editor?.renderer?.stats?.layers ?? 0) > 0);
const res = await page.evaluate(async () => {
  const ed = window.editor;
  const measure = async () => { const f=[]; let l=performance.now(); await new Promise(res=>{const end=l+1500; const loop=n=>{f.push(n-l);l=n; n<end?requestAnimationFrame(loop):res()}; requestAnimationFrame(loop)}); f.sort((a,b)=>a-b); return +(1000/f[f.length>>1]).toFixed(1); };
  ed.play(); await new Promise(r=>setTimeout(r,500));
  const out = { all: await measure() };
  const hooks = [...ed.hooks]; ed.hooks.clear();
  out.noHooks = await measure();
  const r = ed.renderer; const orig = r.render.bind(r);
  r.render = () => {}; out.noRenderNoHooks = await measure();
  r.render = orig; ed.hooks = new Set(hooks);
  // render only into tiny viewport -> fill-rate test
  r.resize(200, 120, 1); out.tinyCanvas = await measure();
  return out;
});
console.log(res); await browser.close();
