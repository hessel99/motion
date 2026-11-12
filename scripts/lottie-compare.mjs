// side by side: official lottie-web render vs ours, for a lottie file at a few times.
// usage: node scripts/lottie-compare.mjs <lottie.min.js> <anim.json> <out-prefix> [times...]
import { chromium } from './pw.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const [,, playerPath, animPath, out, ...ts] = process.argv;
const times = ts.length ? ts.map(Number) : [0.25, 0.5, 0.75];
const anim = JSON.parse(readFileSync(animPath, 'utf8'));
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
// reference
const ref = await browser.newPage({ viewport: { width: 640, height: 640 } });
await ref.setContent('<div id="c" style="width:600px;height:600px;background:#121214"></div>');
await ref.addScriptTag({ content: readFileSync(playerPath, 'utf8') });
const refShots = [];
await ref.evaluate(a => { window.anim = lottie.loadAnimation({ container: document.getElementById('c'), renderer: 'canvas', loop: false, autoplay: false, animationData: a }); }, anim);
await ref.waitForTimeout(500);
for (const f of times) {
  await ref.evaluate(f => window.anim.goToAndStop(f * window.anim.totalFrames, true), f);
  await ref.waitForTimeout(100);
  refShots.push(await ref.locator('#c').screenshot());
}
// ours
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto((process.env.URL || 'http://localhost:5173/') + '?blank&nobridge');
await page.waitForFunction(() => window.editor?.renderer);
const ours = await page.evaluate(async ({ a, times }) => {
  const { lottieToProject } = await import('/src/import/lottie.ts');
  editor.load(lottieToProject(a, 'x'));
  const d = editor.store.comp.duration;
  const r = editor.renderer;
  const res = [];
  for (const f of times) {
    // render until async rasters settle
    for (let k = 0; k < 30; k++) { r.render(f * d); if (!r.dirty) break; await new Promise(z => setTimeout(z, 30)); }
    res.push(r.snapshot(f * d, 600));
  }
  return res;
}, { a: anim, times });
times.forEach((f, i) => {
  writeFileSync(`${out}-${i}-ref.png`, refShots[i]);
  writeFileSync(`${out}-${i}-ours.png`, Buffer.from(ours[i].split(',')[1], 'base64'));
});
await browser.close();
