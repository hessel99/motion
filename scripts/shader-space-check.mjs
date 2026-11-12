// checks two renderer behaviours of shaders in the app (dev server), with motion's own test shaders:
//  - effects on a rotated layer run in the layer's local space (a "left half turns green" effect
//    greens the layer's own left half, not the screen's), also while the layer is partly off-screen
//  - mouse-driven shaders: the keyframable mouse prop drives renders / exports, the hovering
//    canvas cursor drives the editor
// usage: (npx vite --port 5191 &) ; URL=http://localhost:5191/ node scripts/shader-space-check.mjs
import { chromium } from './pw.mjs';

const url = process.env.URL || 'http://localhost:5173/';
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(url + '?blank&nobridge');
await page.waitForFunction(() => window.editor?.renderer);
const out = await page.evaluate(async () => {
  const { addLayer, setProp } = await import('/src/core/commands.ts');
  const { makeShaderAsset } = await import('/src/core/shaders.ts');
  const { addShader, setShaderParam } = await import('/src/core/shader-commands.ts');
  const fx = await import('/tests/shader-fixtures.ts');
  const st = editor.store, r = editor.renderer;
  const half = makeShaderAsset({ id: 'test-half', kind: 'effect', files: { 'main.ts': fx.TEST_HALF_MAIN, 'features.json': fx.TEST_HALF_FEATURES } });
  const mouse = makeShaderAsset({ id: 'test-mouse', kind: 'fill', files: { 'main.ts': fx.TEST_MOUSE_MAIN, 'features.json': fx.TEST_MOUSE_FEATURES } });
  const a = addLayer(st, 'rect', { x: 150, y: 150, w: 300, h: 200, color: [1, 0, 0, 1], name: 'rotated' });
  setProp(st, a.id, 'rotation', [90]);
  addShader(st, [a.id], half);
  const m = addLayer(st, 'rect', { x: 700, y: 150, w: 200, h: 200, name: 'mouse' });
  const ms = addShader(st, [m.id], mouse)[m.id];
  setShaderParam(st, m.id, ms, '__mouse', { x: 25, y: 25 });
  st.setTime(0);
  const gl = r.gl;
  // pixel at local (u, v) (fractions) of a layer, read from the canvas
  const at = (id, u, v) => {
    const c = r.corners(id);
    const x = c[0] + u * (c[2] - c[0]) + v * (c[6] - c[0]), y = c[1] + u * (c[3] - c[1]) + v * (c[7] - c[1]);
    const [sx, sy] = viewport.toScreen(x, y);
    const d = new Uint8Array(4);
    gl.readPixels(Math.round(sx * r.dpr), Math.round(r.canvas.height - sy * r.dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, d);
    return Array.from(d);
  };
  const settle = async () => { r.render(0); r.syncRaster = true; await r.settleShaders(0); r.syncRaster = false; r.render(0); };
  const res = {};
  r.pointer = null;
  await settle();
  res.localLeft = at(a.id, 0.25, 0.2); res.localRight = at(a.id, 0.75, 0.8);
  res.mouseProp = at(m.id, 0.25, 0.25); res.mouseOff = at(m.id, 0.75, 0.75);
  // pan so the rotated layer is half off the left edge: the effect still sees its whole box
  const z0 = viewport.zoom, px0 = viewport.panX, py0 = viewport.panY;
  const c = r.corners(a.id);
  const cx = (c[0] + c[4]) / 2;
  viewport.setView(z0, -cx * z0, py0);
  await settle();
  res.panLeftVisible = at(a.id, 0.25, 0.2); res.panRightVisible = at(a.id, 0.75, 0.2);
  res.panInfo = { lw: r.items[r.index.get(a.id)].shd?.frame?.lw, lh: r.items[r.index.get(a.id)].shd?.frame?.lh, local: r.items[r.index.get(a.id)].shd?.frame?.local };
  viewport.setView(z0, px0, py0);
  await settle();
  // hover: the cursor at 75% / 75% of the mouse layer (editor render, not an export)
  const mc = r.corners(m.id);
  r.pointer = { x: mc[0] + 0.75 * (mc[2] - mc[0]), y: mc[1] + 0.75 * (mc[7] - mc[1]) };
  for (let i = 0; i < 40; i++) { r.render(0); await r.shaders.nextResult(100); }
  r.render(0);
  res.hoverAt = at(m.id, 0.75, 0.75); res.hoverProp = at(m.id, 0.25, 0.25);
  // exports ignore the cursor
  await settle();
  res.exportProp = at(m.id, 0.25, 0.25);
  r.pointer = null;
  res.available = r.shaders.available; res.errors = [...r.shaders.errors.entries()];
  res.mouseParam = st.project.shaders && Object.values(st.project.shaders).find(x => x.id === 'test-mouse')?.params.map(p => p.key);
  return res;
});
console.log(JSON.stringify(out));
console.log('page errors:', errs.slice(0, 5));
await browser.close();
const green = p => p[1] > 180 && p[0] < 60, red = p => p[0] > 180 && p[1] < 60, white = p => p[0] > 200 && p[1] > 200, black = p => p[0] < 40 && p[1] < 40 && p[3] > 200;
const checks = {
  localLeft: green(out.localLeft), localRight: red(out.localRight),
  panLeft: out.panInfo.local === true && green(out.panLeftVisible), panRight: red(out.panRightVisible),
  mouseProp: white(out.mouseProp), mouseOff: black(out.mouseOff),
  hover: white(out.hoverAt) && black(out.hoverProp), exportUsesProp: white(out.exportProp),
};
console.log(checks);
const ok = out.available && Object.values(checks).every(Boolean);
console.log(ok ? 'OK' : 'FAIL');
process.exit(ok ? 0 : 1);
