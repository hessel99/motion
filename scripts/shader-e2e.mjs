// end-to-end check of figma shaders in the app (dev server): a rect / ellipse / path with a shader
// fill, a group with a shader effect, keyframed params, export-style settle, and the timeline rows.
// uses motion's own test shaders (tests/shader-fixtures.ts); with .figma-cache/ present it also
// renders a few figma ones in the app.
// usage: (npx vite --port 5191 &) ; URL=http://localhost:5191/ node scripts/shader-e2e.mjs [out.png]
import { chromium } from './pw.mjs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const url = process.env.URL || 'http://localhost:5173/';
const figma = [];
const cache = join(root, '.figma-cache');
if (existsSync(cache) && !process.env.NOFIGMA) for (const d of readdirSync(cache)) {
  const meta = JSON.parse(readFileSync(join(cache, d, 'meta.json'), 'utf8'));
  if (['Halftone', 'Mesh gradient', 'Water caustic', 'Warp'].includes(meta.name)) figma.push({ ...meta, files: { 'main.ts': readFileSync(join(cache, d, 'main.ts'), 'utf8'), 'features.json': readFileSync(join(cache, d, 'features.json'), 'utf8') } });
}

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
await page.goto(url + '?blank&nobridge');
await page.waitForFunction(() => window.editor?.renderer);
const out = await page.evaluate(async (figma) => {
  const { addLayer, groupLayers, setProp } = await import('/src/core/commands.ts');
  const { makeShaderAsset } = await import('/src/core/shaders.ts');
  const { addShader, setShaderParamKeys, setShaderParam } = await import('/src/core/shader-commands.ts');
  const fx = await import('/tests/shader-fixtures.ts');
  const st = editor.store, r = editor.renderer;
  const fill = makeShaderAsset({ id: 'test-stripes', kind: 'fill', files: { 'main.ts': fx.TEST_FILL_MAIN, 'features.json': fx.TEST_FILL_FEATURES } });
  const eff = makeShaderAsset({ id: 'test-invert', kind: 'effect', files: { 'main.ts': fx.TEST_EFFECT_MAIN, 'features.json': fx.TEST_EFFECT_FEATURES } });
  const a = addLayer(st, 'rect', { x: 100, y: 100, w: 400, h: 300, name: 'Stripes rect', radius: undefined });
  setProp(st, a.id, 'radius', [40, 40, 40, 40]);
  const sa = addShader(st, [a.id], fill)[a.id];
  const b = addLayer(st, 'ellipse', { x: 600, y: 100, w: 300, h: 300, name: 'Stripes ellipse' });
  addShader(st, [b.id], 'test-stripes', { values: { color: { r: 0.2, g: 0.6, b: 1, a: 1 }, transform: { x: 50, y: 50, radius: 10, angle: 45 } } });
  // a group with the invert effect over two rects
  const c1 = addLayer(st, 'rect', { x: 100, y: 500, w: 300, h: 200, color: [1, 0, 0, 1], name: 'red' });
  const c2 = addLayer(st, 'rect', { x: 300, y: 550, w: 300, h: 200, color: [0, 0, 1, 1], name: 'blue' });
  const g = groupLayers(st, [c1.id, c2.id], { x: 100, y: 500, w: 500, h: 250 });
  const se = addShader(st, [g.id], eff)[g.id];
  // keyframed params (agent-style)
  setShaderParamKeys(st, a.id, sa, 'transform', [{ t: 0, v: { x: 50, y: 50, radius: 20, angle: 0 } }, { t: 2, v: { x: 50, y: 50, radius: 40, angle: 90 } }]);
  setShaderParam(st, g.id, se, 'mode', 'All channels');
  // figma shaders from the local cache
  const placed = [];
  let x = 950;
  for (const f of figma) {
    const asset = makeShaderAsset({ id: f.id, name: f.name, kind: f.type, version: f.version, files: f.files });
    if (f.type === 'fill') { const l = addLayer(st, 'rect', { x, y: 450, w: 200, h: 150, name: f.name }); addShader(st, [l.id], asset); placed.push(l.id); }
    else { const t = addLayer(st, 'rect', { x, y: 650, w: 200, h: 150, color: [1, 0.6, 0.1, 1], name: f.name }); addShader(st, [t.id], asset); placed.push(t.id); }
    x += 110;
  }
  st.select([a.id]);
  st.setTime(1);
  r.render(1);
  const t0 = performance.now();
  r.syncRaster = true;
  await r.settleShaders(1);
  r.syncRaster = false;
  const settleMs = performance.now() - t0;
  r.render(1);
  const gl = r.gl;
  const read = (cx, cy) => { const [sx, sy] = viewport.toScreen(cx, cy); const d = new Uint8Array(4); gl.readPixels(Math.round(sx * r.dpr), Math.round(r.canvas.height - sy * r.dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, d); return Array.from(d); };
  return {
    available: r.shaders.available, adapter: r.shaders.adapter, error: r.shaders.error, settleMs: Math.round(settleMs), stats: r.shaders.stats, unsettled: r.shaders.unsettled,
    errors: [...r.shaders.errors.entries()],
    // red rect under the invert effect must look cyan, blue -> yellow
    redInverted: read(150, 520), blueInverted: read(550, 720),
    stripes: [read(300, 250), read(320, 250), read(340, 250), read(360, 250)],
    corner: read(105, 105),
    rows: (globalThis.timeline?.rows ?? []).filter(x => x.kind === 'prop').map(x => x.prop),
  };
}, figma);
await page.waitForTimeout(300);
await page.screenshot({ path: process.argv[2] || join(root, 'bench/results/shaders/e2e.png') });
console.log(JSON.stringify(out, null, 1));
console.log('page errors:', errs.filter(e => !/favicon|DevTools/.test(e)).slice(0, 10));
await browser.close();
const ok = out.available && out.redInverted[0] < 60 && out.redInverted[1] > 180 && out.blueInverted[2] < 60 && out.unsettled === 0;
console.log(ok ? 'OK' : 'FAIL');
process.exit(ok ? 0 : 1);
