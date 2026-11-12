// screenshots of the window structure (docs/shots/ui-v3/): Home, a selected shape, a text layer,
// comp settings, two documents, two comp tabs, the export dialog, the ask bar, dark mode.
// usage: URL=http://localhost:5391/ node scripts/ui-shots.mjs [outDir] [scale]
import { chromium } from './pw.mjs';
import { mkdirSync } from 'node:fs';
const base = process.env.URL || 'http://localhost:5173/';
const out = process.argv[2] || 'docs/shots/ui-v3';
const scale = +(process.argv[3] || 2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const errors = [];
async function page(q, theme = 'light') {
  const p = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: scale });
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/bridge|WebSocket|ERR_CONNECTION/i.test(m.text())) errors.push(m.text()); });
  await p.goto(`${base}?nobridge${q}&theme=${theme}`);
  await p.waitForFunction(() => window.editor?.renderer);
  await p.waitForTimeout(900);
  return p;
}
const selectByName = (p, name) => p.evaluate(n => { const l = Object.values(editor.store.project.layers).find(x => x.name === n); editor.store.select(l ? [l.id] : []); editor.store.setTime(1.2); }, name);
const shot = async (p, name) => { await p.waitForTimeout(500); await p.screenshot({ path: `${out}/${name}.png` }); console.log('shot', name); };

let p = await page('');
await shot(p, '01-home');
await p.close();

p = await page('&demo');
await shot(p, '02-nothing-selected-comp-settings');
await selectByName(p, 'Pill');
await shot(p, '03-shape-selected');
await selectByName(p, 'Title');
await shot(p, '04-text-selected');
// a second comp tab
await p.evaluate(() => { editor.store.select([]); const c = window.__cmds.newComposition(editor.store, { name: 'End card' }); editor.store.openComp(c.id); const first = editor.store.compTabs()[0]; editor.store.openComp(first); });
await shot(p, '05-two-comp-tabs');
// a second document
await p.keyboard.press('Control+t');
await p.waitForTimeout(400);
await shot(p, '06-new-document-empty-canvas');
await p.evaluate(() => document.querySelectorAll('.tb-tab')[0].click());
await shot(p, '07-two-documents');
await p.keyboard.press('Control+e');
await p.waitForSelector('.xv-dialog');
await shot(p, '08-export-dialog');
await p.keyboard.press('Escape');
await selectByName(p, 'Square');
await p.keyboard.press('Control+k');
await p.keyboard.type('make it bounce a bit more');
await shot(p, '09-ask-bar');
await p.keyboard.press('Escape');
await p.close();

p = await page('&demo', 'dark');
await selectByName(p, 'Pill');
await shot(p, '10-dark-shape-selected');
await p.evaluate(() => editor.emit('home'));
await shot(p, '11-dark-home');
await p.close();

await browser.close();
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
