// side by side: official lottie-web render vs ours, for a lottie file at a few times.
// usage: node scripts/lottie-compare.mjs <lottie.min.js> <anim.json> <out-prefix> [times...]
// times are fractions of the animation duration (0..1).
// writes <out>-<i>-ref.png, <out>-<i>-ours.png and <out>-<i>-side.png (normalized, ref | ours),
// and prints a pixel metric per time: mean absolute difference per channel (0..255) and the
// share of pixels whose largest channel difference is > 32. the reference container is
// 600x600 (lottie-web letterboxes), ours renders the comp at 600px on its longest side, so the
// reference is cropped to the animation's aspect ratio and both are compared at the same size.
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
// REF_RENDERER=svg uses lottie-web's svg renderer (implements mask modes and inverted mattes the
// after effects way; the canvas renderer unions all masks regardless of mode)
await ref.evaluate(([a, r]) => { window.anim = lottie.loadAnimation({ container: document.getElementById('c'), renderer: r, loop: false, autoplay: false, animationData: a }); }, [anim, process.env.REF_RENDERER || 'canvas']);
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
  const t0 = performance.now();
  const proj = lottieToProject(a, 'x');
  const importMs = performance.now() - t0;
  editor.load(proj);
  const d = editor.store.comp.duration;
  const r = editor.renderer;
  const res = [];
  for (const f of times) {
    // render until async rasters settle
    for (let k = 0; k < 30; k++) { r.render(f * d); if (!r.dirty) break; await new Promise(z => setTimeout(z, 30)); }
    res.push(r.snapshot(f * d, 600));
  }
  return { shots: res, importMs, layers: Object.keys(proj.layers).length };
}, { a: anim, times });

// metric: normalize both images in the page (canvas 2d), compute the difference
const metrics = await page.evaluate(async ({ refs, ours, w, h }) => {
  const load = src => new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = bad; im.src = src; });
  const s = 600 / Math.max(w, h);
  const cw = Math.round(w * s), ch = Math.round(h * s);
  const ox = (600 - w * s) / 2, oy = (600 - h * s) / 2;
  const res = [];
  for (let i = 0; i < refs.length; i++) {
    const [ri, oi] = await Promise.all([load(refs[i]), load(ours[i])]);
    const draw = (im, sx, sy, sw, sh) => {
      const c = document.createElement('canvas'); c.width = cw; c.height = ch;
      const g = c.getContext('2d'); g.fillStyle = '#121214'; g.fillRect(0, 0, cw, ch);
      g.drawImage(im, sx, sy, sw, sh, 0, 0, cw, ch);
      return { c, d: g.getImageData(0, 0, cw, ch).data };
    };
    const A = draw(ri, ox, oy, w * s, h * s), B = draw(oi, 0, 0, oi.width, oi.height);
    let sum = 0, bad = 0;
    for (let p = 0; p < A.d.length; p += 4) {
      const dr = Math.abs(A.d[p] - B.d[p]), dg = Math.abs(A.d[p + 1] - B.d[p + 1]), db = Math.abs(A.d[p + 2] - B.d[p + 2]);
      sum += dr + dg + db;
      if (Math.max(dr, dg, db) > 32) bad++;
    }
    const n = cw * ch;
    const side = document.createElement('canvas'); side.width = cw * 2 + 8; side.height = ch;
    const g = side.getContext('2d'); g.fillStyle = '#f0f'; g.fillRect(0, 0, side.width, ch);
    g.drawImage(A.c, 0, 0); g.drawImage(B.c, cw + 8, 0);
    res.push({ mad: sum / (n * 3), bad: (100 * bad) / n, side: side.toDataURL('image/png') });
  }
  return res;
}, {
  refs: refShots.map(b => 'data:image/png;base64,' + b.toString('base64')),
  ours: ours.shots, w: anim.w, h: anim.h,
});

const name = animPath.split('/').pop();
times.forEach((f, i) => {
  writeFileSync(`${out}-${i}-ref.png`, refShots[i]);
  writeFileSync(`${out}-${i}-ours.png`, Buffer.from(ours.shots[i].split(',')[1], 'base64'));
  writeFileSync(`${out}-${i}-side.png`, Buffer.from(metrics[i].side.split(',')[1], 'base64'));
  console.log(`${name} t=${f}: mad ${metrics[i].mad.toFixed(2)}  >32: ${metrics[i].bad.toFixed(2)}%`);
});
const mad = metrics.reduce((s, m) => s + m.mad, 0) / metrics.length, bad = metrics.reduce((s, m) => s + m.bad, 0) / metrics.length;
console.log(`${name} mean: mad ${mad.toFixed(2)}  >32: ${bad.toFixed(2)}%  (import ${ours.importMs.toFixed(1)}ms, ${ours.layers} layers)`);
console.log('METRIC ' + JSON.stringify({ file: name, mad: +mad.toFixed(3), bad: +bad.toFixed(3), importMs: +ours.importMs.toFixed(1), layers: ours.layers }));
await browser.close();
