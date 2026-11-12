// exports a project to lottie, renders it with the official lottie-web player and with ours, side by side
import { chromium } from './pw.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const [,, playerPath, out, which = 'demo'] = process.argv;
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto((process.env.URL || 'http://localhost:5173/') + '?blank&nobridge');
await page.waitForFunction(() => window.editor?.renderer);
const times = [0.3, 0.6, 1.0, 2.0];
const { lottie, ours } = await page.evaluate(async ({ which, times }) => {
  const { demoProject } = await import('/src/app/demo.ts');
  const { projectToLottie } = await import('/src/export/lottie.ts');
  editor.load(demoProject());
  await new Promise(r => setTimeout(r, 400));
  const lot = projectToLottie(editor.store.project);
  const res = [];
  for (const t of times) { for (let k = 0; k < 20; k++) { editor.renderer.render(t); if (!editor.renderer.dirty) break; await new Promise(z => setTimeout(z, 30)); } res.push(editor.renderer.snapshot(t, 640)); }
  return { lottie: lot, ours: res };
}, { which, times });
const ref = await browser.newPage({ viewport: { width: 700, height: 420 } });
ref.on('pageerror', e => console.log('lottie-web error:', e.message));
ref.on('console', m => m.type() === 'error' && console.log('lottie-web console:', m.text()));
writeFileSync(out + '.json', JSON.stringify(lottie));
await ref.setContent('<div id="c" style="width:640px;height:360px;background:#0f0f14"></div>');
await ref.addScriptTag({ content: readFileSync(playerPath, 'utf8') });
await ref.evaluate(([a, r]) => { window.anim = lottie.loadAnimation({ container: document.getElementById('c'), renderer: r, loop: false, autoplay: false, animationData: a }); }, [lottie, process.env.LOTTIE_RENDERER || 'svg']);
await ref.waitForTimeout(500);
console.log('anim info', JSON.stringify(await ref.evaluate(() => ({ frames: window.anim.totalFrames, w: window.anim.animationData.w, layers: window.anim.animationData.layers.length, loaded: window.anim.isLoaded }))));
for (let i = 0; i < times.length; i++) {
  await ref.evaluate(t => window.anim.goToAndStop(t * 1000, false), times[i]);
  await ref.waitForTimeout(100);
  writeFileSync(`${out}-${i}-ref.png`, await ref.locator('#c').screenshot());
  writeFileSync(`${out}-${i}-ours.png`, Buffer.from(ours[i].split(',')[1], 'base64'));
}
await browser.close();
