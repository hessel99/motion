import { chromium } from './pw.mjs';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => m.type() === 'error' && errs.push(m.text()));
await page.goto((process.env.URL || 'http://localhost:5173/') + '?demo&nobridge');
await page.waitForFunction(() => window.editor?.renderer?.stats?.layers > 0);
const hash = () => page.evaluate(() => { editor.renderer.render(2); const url = editor.renderer.snapshot(2, 256); let h = 0; for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0; return h; });
const before = await hash();
await page.evaluate(() => editor.store.select(editor.store.comp.root.slice()));
await page.mouse.move(800, 300);
await page.keyboard.press('Control+Shift+c');
await page.waitForTimeout(200);
const s1 = await page.evaluate(() => ({ root: editor.store.comp.root.map(id => editor.store.layer(id).type), comps: Object.keys(editor.store.project.comps).length }));
const after = await hash();
console.log('precompose:', JSON.stringify(s1), 'render identical:', before === after);
// start offset: shift the precomp by 1s -> at t=2 we see the inner comp at t=1
await page.evaluate(async () => { const { setLayerField } = await import('/src/core/commands.ts'); setLayerField(editor.store, [editor.store.comp.root[0]], 'startTime', 1); });
const shifted = await hash();
console.log('start offset changes frame:', shifted !== after);
// open the precomp by double click on it
await page.evaluate(() => { const id = editor.store.comp.root[0]; editor.store.openComp(editor.store.layer(id).compRef); });
await page.waitForTimeout(200);
console.log('opened:', JSON.stringify(await page.evaluate(() => ({ comp: editor.store.comp.name, root: editor.store.comp.root.length }))));
await page.screenshot({ path: process.argv[2] });
console.log(errs.length ? errs : 'no errors');
await browser.close();
