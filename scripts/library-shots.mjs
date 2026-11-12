// screenshots + a smoke check of the Library tab (styles + components) in chromium.
// usage: URL=http://localhost:5222/ node scripts/library-shots.mjs [outdir]
import { chromium } from './pw.mjs';

const URL = process.env.URL ?? 'http://localhost:5173/';
const out = process.argv[2] ?? 'docs/shots';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(URL + '?blank&nobridge');
await page.waitForFunction(() => (globalThis).editor);
await page.evaluate(() => { try { localStorage.setItem('motion.agentOpen', '0'); } catch { /* */ } });
await page.reload();
await page.waitForFunction(() => (globalThis).editor);
await page.waitForTimeout(500);

// a small brand scene: tokens (light / dark), a card component with animation, two instances
const info = await page.evaluate(async () => {
  const ed = globalThis.editor, s = ed.store;
  const C = await import('/src/core/commands.ts');
  const T = await import('/src/core/tokens.ts');
  const S = await import('/src/core/token-sync.ts');
  const K = await import('/src/core/components.ts');
  document.querySelector('.welcome, .dialog-backdrop')?.querySelector('button')?.click();
  C.setCompSettings(s, { width: 1280, height: 720, background: [0.96, 0.96, 0.97, 1] });
  const file = {
    light: { Brand: { $type: 'color', Primary: { $value: '#4F46E5' }, Accent: { $value: '#F59E0B' }, Surface: { $value: '#FFFFFF' }, Ink: { $value: '#111827' } }, Neutral: { $type: 'color', Muted: { $value: '#6B7280' }, Line: { $value: '#E5E7EB' } } },
    dark: { Brand: { $type: 'color', Primary: { $value: '#818CF8' }, Accent: { $value: '#FBBF24' }, Surface: { $value: '#1F2937' }, Ink: { $value: '#F9FAFB' } }, Neutral: { $type: 'color', Muted: { $value: '#9CA3AF' }, Line: { $value: '#374151' } } },
    global: { Radius: { $type: 'dimension', Card: { $value: '16px' }, Pill: { $value: '999px' } } },
  };
  S.applySync(s, S.planSync(s.project, S.parseTokenFile(file), { from: 'brand.tokens.json' }), { kind: 'file', label: 'brand.tokens.json', location: 'brand.tokens.json' });
  const tok = n => Object.values(s.project.tokens.items).find(t => t.name === n).id;
  const card = C.addLayer(s, 'group', { name: 'Card', x: 120, y: 200, w: 320, h: 200 });
  const bg = C.addLayer(s, 'rect', { name: 'Background', x: 0, y: 0, w: 320, h: 200 }, card.id);
  const dot = C.addLayer(s, 'ellipse', { name: 'Badge', x: 24, y: 24, w: 48, h: 48 }, card.id);
  const bar = C.addLayer(s, 'rect', { name: 'Bar', x: 24, y: 120, w: 200, h: 16 }, card.id);
  const bar2 = C.addLayer(s, 'rect', { name: 'Bar 2', x: 24, y: 150, w: 140, h: 16 }, card.id);
  T.linkProp(s, [bg.id], 'fill', tok('Brand/Surface'));
  T.linkProp(s, [bg.id], 'radius', tok('Radius/Card'));
  T.linkProp(s, [dot.id], 'fill', tok('Brand/Primary'));
  T.linkProp(s, [bar.id], 'fill', tok('Brand/Ink'));
  T.linkProp(s, [bar2.id], 'fill', tok('Neutral/Line'));
  C.setLayerField(s, [card.id], 'clip', true);
  // animate the main: pop in
  s.setTime(0); C.setProp(s, card.id, 'scale', [80, 80], { forceKey: true }); C.setProp(s, card.id, 'opacity', [0], { forceKey: true });
  s.setTime(0.6); C.setProp(s, card.id, 'scale', [100, 100], { forceKey: true }); C.setProp(s, card.id, 'opacity', [100], { forceKey: true });
  K.createComponent(s, card.id, 'Card');
  const a = K.createInstance(s, card.id, { x: 640, y: 300, delay: 0.15 });
  const b = K.createInstance(s, card.id, { x: 1000, y: 300, delay: 0.3 });
  // override: the third card's badge uses the accent color
  const bBadge = s.layer(b.children[1]);
  T.linkProp(s, [bBadge.id], 'fill', tok('Brand/Accent'));
  s.setTime(1);
  ed.emit('fit');
  return { card: card.id, a: a.id, b: b.id, bBadge: bBadge.id, bg: bg.id };
});
await page.evaluate(() => globalThis.viewport?.fit());
await page.waitForTimeout(300);

// 1. library tab
await page.click('.right-tabs button:has-text("Library")');
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/20-library-panel.png` });

// 2. drag a swatch onto a layer (synthetic DnD: chromium honours DataTransfer in dispatched events)
const dropped = await page.evaluate(async ({ a }) => {
  const s = globalThis.editor.store;
  const accent = Object.values(s.project.tokens.items).find(t => t.name === 'Brand/Accent').id;
  const inst = s.layer(a);
  const bar = s.layer(inst.children[2]);
  const c = globalThis.editor.renderer.corners(bar.id);
  const vp = document.querySelector('.viewport');
  const canvas = document.querySelector('.vp-canvas');
  const r = canvas.getBoundingClientRect();
  const v = globalThis.viewport;
  const [sx, sy] = v.toScreen((c[0] + c[4]) / 2, (c[1] + c[5]) / 2);
  const dt = new DataTransfer();
  dt.setData('application/x-motion-style', accent);
  const opts = { bubbles: true, cancelable: true, clientX: r.left + sx, clientY: r.top + sy, dataTransfer: dt };
  vp.dispatchEvent(new DragEvent('dragover', opts));
  vp.dispatchEvent(new DragEvent('drop', opts));
  await new Promise(r => setTimeout(r, 50));
  return { bind: s.layer(bar.id).props.fill.bind === accent, ov: s.layer(bar.id).link?.ov ?? [] };
}, info);
console.log('drop swatch on layer:', JSON.stringify(dropped));
if (!dropped.bind) throw new Error('style drop did not link the layer');
await page.evaluate(() => globalThis.editor.store.undo());

// 3. inspector of an instance layer with an override + linked fill
await page.evaluate(({ bBadge }) => globalThis.editor.store.select([bBadge]), info);
await page.click('.right-tabs button:has-text("Design")');
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/20-inspector-instance.png` });
const chip = await page.textContent('.linked-chip');
console.log('linked chip:', chip?.trim());
if (!/Linked to/.test(chip ?? '')) throw new Error('no linked chip');

// 4. the main component selected
await page.evaluate(({ card }) => globalThis.editor.store.select([card]), info);
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/20-inspector-main.png`, clip: { x: 1440 - 300, y: 0, width: 300, height: 900 } });

// 5. a library update: review dialog
await page.evaluate(async () => {
  const L = await import('/src/app/library.ts');
  const v2 = {
    light: { Brand: { $type: 'color', Primary: { $value: '#DB2777' }, Accent: { $value: '#10B981' }, Surface: { $value: '#FFFFFF' }, Ink: { $value: '#111827' } }, Neutral: { $type: 'color', Muted: { $value: '#6B7280' }, Line: { $value: '#E5E7EB' }, Wash: { $value: '#F3F4F6' } } },
    dark: { Brand: { $type: 'color', Primary: { $value: '#F472B6' }, Accent: { $value: '#34D399' }, Surface: { $value: '#1F2937' }, Ink: { $value: '#F9FAFB' } }, Neutral: { $type: 'color', Muted: { $value: '#9CA3AF' }, Line: { $value: '#374151' }, Wash: { $value: '#111827' } } },
    global: { Radius: { $type: 'dimension', Card: { $value: '24px' }, Pill: { $value: '999px' } } },
  };
  L.planFromText(JSON.stringify(v2), { kind: 'file', label: 'brand.tokens.json', location: 'brand.tokens.json' });
});
await page.waitForSelector('.sync-review');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/20-sync-review.png` });
await page.click('.sync-review button:has-text("Update")');
await page.waitForTimeout(400);
const after = await page.evaluate(({ bg }) => globalThis.editor.store.layer(bg).props.radius.v[0], info);
console.log('radius after sync:', after);
if (after !== 24) throw new Error('sync did not update the linked radius');

// 6. dark mode
await page.click('.right-tabs button:has-text("Library")');
await page.click('.lib-modes button:has-text("Dark")');
await page.evaluate(() => globalThis.editor.store.select([]));
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/20-dark-mode.png` });
// undo the mode switch in one step
await page.evaluate(() => globalThis.editor.store.undo());
const mode = await page.evaluate(() => globalThis.editor.store.project.tokens.mode);
console.log('mode after undo:', mode);
if (mode !== 'Light') throw new Error('undo did not restore the mode');

console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
await browser.close();
if (errors.length) process.exit(1);
