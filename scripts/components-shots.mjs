// motion components in the real editor (chromium): builds a title card component, a showreel of six
// instances and a 9:16 version, checks what the renderer draws (patched layers, shared layers,
// timing) and takes dark screenshots (deviceScaleFactor 2) for docs/components-design.md.
// usage: URL=http://localhost:5173/ node scripts/components-shots.mjs [outdir]
import { chromium } from './pw.mjs';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL ?? 'http://localhost:5173/';
const out = process.argv[2] ?? 'docs/shots/components';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(URL + '?blank&nobridge&theme=dark');
await page.waitForFunction(() => globalThis.editor);
await page.evaluate(() => { try { localStorage.setItem('motion.ui', JSON.stringify({ leftOpen: true, leftTab: 'assets' })); } catch { /* */ } });
await page.reload();
await page.waitForFunction(() => globalThis.editor);
await page.waitForTimeout(500);

const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); console.log((ok ? 'ok   ' : 'FAIL ') + msg); };

const info = await page.evaluate(async () => {
  const ed = globalThis.editor, s = ed.store;
  const C = await import('/src/core/commands.ts');
  const M = await import('/src/core/motion-components.ts');
  document.querySelector('.welcome, .dialog-backdrop')?.querySelector('button')?.click();
  C.setCompSettings(s, { width: 1920, height: 1080, duration: 12, background: [0.05, 0.05, 0.06, 1] });
  C.renameComp(s, s.comp.id, 'Showreel');
  const txt = (content, size, weight) => ({ content, fontFamily: 'Inter', fontSize: size, fontWeight: weight, lineHeight: 1.15, letterSpacing: 0, align: 'center' });
  const bg = C.addLayer(s, 'rect', { name: 'Background', x: 0, y: 0, w: 1920, h: 1080, color: [0.09, 0.09, 0.11, 1] });
  const title = C.addLayer(s, 'text', { name: 'Title', x: 260, y: 420, w: 1400, h: 140, color: [1, 1, 1, 1], text: txt('Motion', 120, 700) });
  const sub = C.addLayer(s, 'text', { name: 'Subtitle', x: 460, y: 590, w: 1000, h: 60, color: [0.7, 0.72, 0.78, 1], text: txt('Episode one', 44, 500) });
  const bar = C.addLayer(s, 'rect', { name: 'Accent', x: 860, y: 380, w: 200, h: 10, color: [1, 0.36, 0.25, 1] });
  const key = (id, k, t, v) => { s.setTime(t); C.setProp(s, id, k, v, { forceKey: true }); };
  // in 0..0.6, hold, out 2.4..3
  for (const [id, dy] of [[title.id, 40], [sub.id, 30]]) {
    const p = s.layer(id).props.position.v;
    key(id, 'opacity', 0, [0]); key(id, 'position', 0, [p[0], p[1] + dy]);
    key(id, 'opacity', 0.6, [100]); key(id, 'position', 0.6, p);
    key(id, 'opacity', 2.4, [100]); key(id, 'opacity', 3, [0]);
  }
  key(bar.id, 'scale', 0, [0, 100]); key(bar.id, 'scale', 0.5, [100, 100]); key(bar.id, 'scale', 2.5, [100, 100]); key(bar.id, 'scale', 3, [0, 100]);
  C.setCompSettings(s, { duration: 3 });
  const { comp, layer } = M.makeComponent(s, [bg.id, title.id, sub.id, bar.id], { name: 'Title card' });
  const P = s.project;
  M.exposeProperty(s, comp.id, { name: 'Title', targets: [{ layer: title.id, field: 'text' }] });
  M.exposeProperty(s, comp.id, { name: 'Subtitle', targets: [{ layer: sub.id, field: 'text' }] });
  M.exposeProperty(s, comp.id, { name: 'Accent', targets: [{ layer: bar.id, field: 'fill' }] });
  M.exposeProperty(s, comp.id, { name: 'Show subtitle', targets: [{ layer: sub.id, field: 'visible' }] });
  M.addVariant(s, comp.id, { name: '9:16' });
  M.addVariant(s, comp.id, { name: '1:1' });
  const light = M.addVariant(s, comp.id, { name: 'Light', group: 'Theme' });
  M.editVariant(s, comp.id, light.id);
  C.setProp(s, bg.id, 'fill', [0.96, 0.95, 0.93, 1]); C.setProp(s, title.id, 'fill', [0.08, 0.08, 0.1, 1]);
  M.editVariant(s, comp.id, null);
  // the showreel: six cards, 2s apart, each playing in -> out squeezed to 2s
  C.deleteLayers(s, [layer.id]);
  s.setTime(0);
  C.setCompSettings(s, { duration: 12 });
  const names = [['Motion', 'Episode one', [1, 0.36, 0.25, 1]], ['Brand', 'Logo sting', [0.3, 0.6, 1, 1]], ['Type', 'Kinetic titles', [0.95, 0.75, 0.2, 1]], ['Social', '9:16 cutdowns', [0.4, 0.85, 0.5, 1]], ['Reels', 'Assembled', [0.75, 0.45, 1, 1]], ['Thanks', '', [1, 1, 1, 1]]];
  const ids = names.map(([t, st, c], i) => M.addMotionInstance(s, comp.id, { name: `Title · ${t}`, start: i * 2, play: { duration: 2 }, props: { Title: t, Subtitle: st, Accent: c, ...(st ? {} : { 'Show subtitle': false }) }, select: false }).id);
  s.select([ids[1]]);
  // a vertical cut of the same piece
  const vert = C.newComposition(s, { name: 'Vertical', width: 1080, height: 1920, duration: 3 });
  s.openComp(vert.id);
  const v = M.addMotionInstance(s, comp.id, { variants: { Format: comp.component.variants[0].id, Theme: light.id }, props: { Title: 'Vertical' }, select: false });
  s.openComp(Object.values(P.comps).find(c => c.name === 'Showreel').id);
  s.setTime(3.2);
  return { comp: comp.id, ids, title: title.id, bg: bg.id, vert: vert.id, v: v.id };
});

// --- renderer checks: the six instances share the main's unchanged layers and tracks
await page.waitForTimeout(400);
const r1 = await page.evaluate(({ title, bg }) => {
  const R = globalThis.editor.renderer;
  const items = R.items;
  const titles = items.filter(it => it.id === title);
  const bgs = items.filter(it => it.id === bg);
  return {
    n: items.length, titles: titles.length, distinctTitleLayers: new Set(titles.map(t => t.layer)).size, texts: titles.map(t => t.layer.text.content),
    bgsShared: new Set(bgs.map(b => b.layer)).size, patched: R.patchedLayers,
  };
}, info);
check(r1.titles === 6, `six instances expanded (${r1.titles} title items)`);
check(r1.texts.join() === 'Motion,Brand,Type,Social,Reels,Thanks', `each instance shows its own title: ${r1.texts.join(', ')}`);
check(r1.bgsShared === 1, `the background (unchanged) is the same layer object in all instances (${r1.bgsShared})`);
// timing: at 3.2s card 1 (start 2, duration 2) is 60% through its pass = 1.8s of its 3s; card 0 is hidden
const r2 = await page.evaluate(({ bg }) => {
  const R = globalThis.editor.renderer;
  R.render(3.2);
  // each instance's background item (always opaque while the instance shows)
  const o = R.items.map((it, i) => (it.id === bg ? R.opa[i] : null)).filter(x => x !== null);
  return { o0: o[0], o1: o[1], o2: o[2] };
}, info);
check(r2.o0 === 0 && r2.o1 > 0 && r2.o2 === 0, `only the second card shows at 3.2s (opacity ${r2.o0}, ${r2.o1}, ${r2.o2})`);

await page.evaluate(() => globalThis.viewport?.fit());
await page.evaluate(({ ids }) => { const s = globalThis.editor.store; s.select([ids[1]]); s.setTime(2.9); }, info);
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/instance-inspector.png` });

// the component itself: properties, variants, parts
await page.evaluate(({ comp }) => { const s = globalThis.editor.store; s.openComp(comp); s.select([]); s.setTime(1.2); globalThis.viewport?.fit(); }, info);
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/component-panel.png` });
// editing the 9:16 variant
await page.evaluate(async ({ comp }) => { const M = await import('/src/core/motion-components.ts'); const s = globalThis.editor.store; M.editVariant(s, comp, s.project.comps[comp].component.variants[0].id); globalThis.viewport?.fit(); }, info);
await page.waitForTimeout(600);
const ed916 = await page.evaluate(({ comp }) => { const c = globalThis.editor.store.project.comps[comp]; return [c.width, c.height]; }, info);
check(ed916[0] === 1080 && ed916[1] === 1920, `editing the 9:16 variant shows a ${ed916.join('×')} frame`);
await page.screenshot({ path: `${out}/variant-9x16.png` });
// expose: a layer selected inside the component
await page.evaluate(async ({ comp, title }) => { const M = await import('/src/core/motion-components.ts'); const s = globalThis.editor.store; M.editVariant(s, comp, null); s.select([title]); globalThis.viewport?.fit(); }, info);
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/expose.png` });
// the vertical comp with the 9:16 light instance
await page.evaluate(({ vert, v }) => { const s = globalThis.editor.store; s.openComp(vert); s.select([v]); s.setTime(1.2); globalThis.viewport?.fit(); }, info);
await page.waitForTimeout(600);
const vt = await page.evaluate(({ title }) => globalThis.editor.renderer.items.find(it => it.id === title)?.layer.text.content, info);
check(vt === 'Vertical', `the vertical instance shows its own title (${vt})`);
await page.screenshot({ path: `${out}/vertical-instance.png` });

// library: publish, change, review
await page.evaluate(async ({ comp, title }) => {
  const L = await import('/src/core/component-library.ts');
  const C = await import('/src/core/commands.ts');
  const U = await import('/src/ui/ComponentPanels.tsx');
  const s = globalThis.editor.store;
  const lib = L.exportLibrary(s.project, { name: 'Brand kit' });
  // pretend this project imported it, then the library changed
  s.transact('t', tx => { const d = s.project.comps[comp].component; tx.set(d, 'lib', { id: lib.id, name: lib.name, key: lib.components[0].key, rev: lib.components[0].rev }); });
  const P2 = JSON.parse(JSON.stringify(s.project));
  const { Store } = await import('/src/core/store.ts');
  const s2 = new Store(P2);
  C.setProp(s2, title, 'rotation', [-3]);
  const M = await import('/src/core/motion-components.ts');
  M.addVariant(s2, comp, { name: '4:5' });
  const lib2 = L.exportLibrary(s2.project, { name: 'Brand kit' });
  U.openLibraryText(JSON.stringify(lib2));
}, info);
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/library-review.png` });
await page.locator('.lib-review button:has-text("Update")').click();
await page.waitForTimeout(300);
const upd = await page.evaluate(({ comp }) => (globalThis.editor.store.project.comps[comp].component.variants ?? []).map(v => v.name), info);
check(upd.includes('4:5'), `library update applied (${upd.join(', ')})`);

check(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
if (fail.length) { console.log(`${fail.length} failed`); process.exit(1); }
