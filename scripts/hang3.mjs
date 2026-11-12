import { chromium } from './pw.mjs';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const cdp = await page.context().newCDPSession(page);
page.goto(`http://localhost:5173/?nobridge&blank&stress=${process.argv[2] || 5000}&kinds=${process.env.KINDS || "rect,ellipse,text,path"}&nested`).catch(() => {});
await new Promise(r => setTimeout(r, 4000));
await cdp.send('Runtime.evaluate', { expression: `window.__f=[]; editor.onFrame(n=>{const r=editor.renderer;window.__f.push([Math.round(n), +r.stats.frameMs.toFixed(1), +r.stats.rasterMs.toFixed(1), r.atlas.uploadsLastFlush, r.atlas.size, r.atlas.pages, r.atlas.compactions])}); editor.play(); 1` });
for (let k = 0; k < 5; k++) {
  await new Promise(r => setTimeout(r, 2000));
  const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__f.slice(-3)) + " n=" + window.__f.length', returnByValue: true });
  console.log(r.result.value);
}
process.exit(0);
