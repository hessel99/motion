// incremental compile + shared precomp evaluation must be exact: after each bulk edit (and undo /
// redo / solo), the frame from the incrementally compiled items is compared with a full recompile
// with shared evaluation off (world matrices, opacities, styles and the instance buffer, bit for bit).
// see motionLab.compileCheck (src/lab/index.ts). runs against a build (preview) or dev server:
//   URL=http://localhost:4201/ node scripts/compile-check.mjs
import { chromium } from './pw.mjs';

const URL0 = process.env.URL || 'http://localhost:4182/';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const scenes = [['precomps', { comps: 20, inst: 10, inner: 4, offsets: 3 }], ['precomps', { comps: 20, inst: 10, inner: 4 }], ['mixed', { n: 2000 }]];
let bad = 0;
for (const [name, opts] of scenes) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${URL0}?nobridge&blank&lab`);
  await page.waitForFunction(() => window.motionLab && window.editor?.renderer, null, { timeout: 60000 });
  await page.evaluate(([n, o]) => motionLab.load(n, o), [name, opts]);
  const res = await page.evaluate(() => motionLab.compileCheck());
  console.log(`${name} ${JSON.stringify(opts)}`);
  for (const [k, v] of Object.entries(res)) { console.log(`  ${k}: ${v}`); if (!v.startsWith('ok')) bad++; }
  if (errors.length) { console.log('  page errors:', errors.slice(0, 3).join(' | ')); bad++; }
  await page.close();
}
console.log(bad ? `FAIL ${bad}` : 'PASS identical');
await browser.close();
process.exit(bad ? 1 : 0);
