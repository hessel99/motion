import { chromium } from './pw.mjs';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const cdp = await page.context().newCDPSession(page);
await page.goto('http://localhost:5173/?nobridge&blank&stress=5000&kinds=rect,ellipse,text,path&nested');
await page.waitForFunction(() => (window.editor?.renderer?.stats?.layers ?? 0) > 0);
await page.evaluate(() => { window.__f = []; const ed = window.editor; ed.onFrame(n => window.__f.push([Math.round(n), ed.renderer.stats.rasterMs.toFixed(1), ed.renderer.atlas.pages, ed.renderer.atlas.size])); ed.play(); });
for (let k = 0; k < 6; k++) {
  await new Promise(r => setTimeout(r, 3000));
  const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__f.slice(-4)) + " frames=" + window.__f.length', returnByValue: true });
  console.log(k * 3 + 3 + 's', r.result.value);
}
process.exit(0);
