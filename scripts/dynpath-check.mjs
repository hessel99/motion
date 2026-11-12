import { chromium } from './pw.mjs';
import { writeFileSync } from 'node:fs';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => m.type() === 'error' && errs.push(m.text()));
await page.goto((process.env.URL || 'http://localhost:5173/') + '?blank&nobridge');
await page.waitForFunction(() => window.editor?.renderer);
const shots = await page.evaluate(async () => {
  const { insertLayer } = await import('/src/core/commands.ts');
  const { createLayer } = await import('/src/core/model.ts');
  const st = editor.store;
  const sq = [['M', 0, 0], ['L', 400, 0], ['L', 400, 400], ['L', 0, 400], ['Z']];
  const dia = [['M', 200, 0], ['L', 400, 200], ['L', 200, 400], ['L', 0, 200], ['Z']];
  const a = createLayer('path', { x: 300, y: 340, w: 400, h: 400, color: [0.3, 0.6, 1, 1], name: 'Morph' });
  a.geometry = [{ cmds: sq, fillRule: 'nonzero' }]; a.geomSize = [400, 400];
  a.pathKf = [{ t: 0, geometry: [{ cmds: sq, fillRule: 'nonzero' }], interp: 'bezier', out: [0.42, 0], in: [0.58, 1] }, { t: 2, geometry: [{ cmds: dia, fillRule: 'nonzero' }], interp: 'bezier', out: [0.42, 0], in: [0.58, 1] }];
  const circ = [['M', 200, 0], ['C', 310, 0, 400, 90, 400, 200], ['C', 400, 310, 310, 400, 200, 400], ['C', 90, 400, 0, 310, 0, 200], ['C', 0, 90, 90, 0, 200, 0], ['Z']];
  const b = createLayer('path', { x: 1100, y: 340, w: 400, h: 400, color: [0, 0, 0, 0], name: 'Trim' });
  b.geometry = [{ cmds: circ, fillRule: 'nonzero' }]; b.geomSize = [400, 400];
  b.props.stroke = { v: [1, 0.8, 0.2, 1] }; b.props.strokeWidth = { v: [24] };
  b.trim = { start: { v: [0] }, end: { v: [0], kf: [{ t: 0, v: [0], interp: 'bezier', out: [0.42, 0], in: [0.58, 1] }, { t: 2, v: [100], interp: 'linear', out: [0, 0], in: [1, 1] }] }, offset: { v: [0] } };
  st.transact('x', tx => { insertLayer(st, tx, a, null); insertLayer(st, tx, b, null); });
  const out = [];
  for (const t of [0, 0.7, 1.3, 2]) { editor.renderer.render(t); out.push(editor.renderer.snapshot(t, 700)); }
  return out;
});
shots.forEach((u, i) => writeFileSync(`${process.argv[2]}-${i}.png`, Buffer.from(u.split(',')[1], 'base64')));
console.log(errs.length ? errs : 'no errors');
await browser.close();
