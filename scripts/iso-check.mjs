// visual check: group opacity isolation + figma-style mask
import { chromium } from './pw.mjs';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => m.type() === 'error' && errs.push(m.text()));
await page.goto((process.env.URL || 'http://localhost:5173/') + '?blank&nobridge');
await page.waitForFunction(() => window.editor?.renderer);
const r = await page.evaluate(async () => {
  const { addLayer, groupLayers, setProp, setLayerField } = await import('/src/core/commands.ts');
  const st = editor.store;
  // 1) two overlapping squares in a group at 50% opacity: overlap must NOT be darker/brighter than the rest
  const a = addLayer(st, 'rect', { x: 200, y: 300, w: 300, h: 300, color: [1, 0.3, 0.3, 1], name: 'A' });
  const b = addLayer(st, 'rect', { x: 350, y: 400, w: 300, h: 300, color: [0.3, 0.5, 1, 1], name: 'B' });
  editor.renderer.render(0);
  const g = groupLayers(st, [a.id, b.id], { x: 200, y: 300, w: 450, h: 400 });
  setProp(st, g.id, 'opacity', [50]);
  // 2) mask: circle masks a group of stripes above it
  const stripes = [];
  for (let i = 0; i < 6; i++) stripes.push(addLayer(st, 'rect', { x: 1000, y: 280 + i * 70, w: 500, h: 35, color: [1, 0.8, 0.2, 1], name: 'stripe' + i }).id);
  const m = addLayer(st, 'ellipse', { x: 1050, y: 300, w: 400, h: 400, color: [1, 1, 1, 1], name: 'Mask' });
  editor.renderer.render(0);
  // put the mask at the bottom of a new group containing the stripes
  const mg = groupLayers(st, [m.id, ...stripes], { x: 1000, y: 280, w: 500, h: 420 });
  const { moveLayers } = await import('/src/core/commands.ts');
  moveLayers(st, [m.id], mg.id, 0);
  setLayerField(st, [m.id], 'mask', true);
  st.select([]);
  editor.renderer.render(0);
  return { isolated: editor.renderer.isolatedLastFrame };
});
await page.waitForTimeout(400);
await page.screenshot({ path: process.argv[2] });
// sample pixels: overlap vs single in the opacity group (read back from the webgl canvas)
const px = await page.evaluate(() => {
  const r = editor.renderer, gl = r.gl;
  r.render(0);
  const read = (cx, cy) => { const [sx, sy] = viewport.toScreen(cx, cy); const d = new Uint8Array(4); gl.readPixels(Math.round(sx * r.dpr), Math.round(r.canvas.height - sy * r.dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, d); return Array.from(d); };
  return { onlyA: read(250, 350), overlap: read(450, 550), onlyB: read(600, 650), maskInside: read(1250, 500), maskOutsideStripe: read(1010, 280 + 5) };
});
console.log(JSON.stringify(r), JSON.stringify(px));
console.log(errs.length ? errs : 'no errors');
await browser.close();
