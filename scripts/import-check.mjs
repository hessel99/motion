// imports in the real app: figma paste (synthetic payload), svg paste, lottie export -> import round trip
import { chromium } from './pw.mjs';
import { readFileSync } from 'node:fs';
const [,, figmaHtmlPath, shotDir] = process.argv;
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => m.type() === 'error' && errs.push(m.text()));
await page.goto('http://localhost:5173/?blank&nobridge');
await page.waitForFunction(() => window.editor?.renderer);
const paste = (html, text) => page.evaluate(([html, text]) => {
  const dt = new DataTransfer();
  if (html) dt.setData('text/html', html);
  if (text) dt.setData('text/plain', text);
  document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
}, [html, text]);
await paste(readFileSync(figmaHtmlPath, 'utf8'), '');
await page.waitForTimeout(800);
const fig = await page.evaluate(() => ({ comp: [editor.store.comp.width, editor.store.comp.height, editor.store.comp.name], layers: Object.values(editor.store.project.layers).map(l => `${l.type}:${l.name}`) }));
console.log('figma paste ->', JSON.stringify(fig));
await page.screenshot({ path: shotDir + '/figma-paste.png' });
await page.evaluate(() => editor.store.select([]));
await paste('', `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><circle cx="100" cy="100" r="80" fill="#ff5a6b"/><path d="M60 100 L100 140 L150 60" stroke="#fff" stroke-width="12" fill="none" stroke-linecap="round"/></svg>`);
await page.waitForTimeout(600);
console.log('svg paste -> layers', await page.evaluate(() => Object.keys(editor.store.project.layers).length));
// lottie round trip of the demo
const rt = await page.evaluate(async () => {
  const { demoProject } = await import('/src/app/demo.ts');
  const { projectToLottie } = await import('/src/export/lottie.ts');
  const { lottieToProject } = await import('/src/import/lottie.ts');
  const lot = projectToLottie(demoProject());
  const back = lottieToProject(JSON.parse(JSON.stringify(lot)), 'roundtrip');
  editor.load(back);
  editor.store.setTime(1.6);
  return { lottieLayers: lot.layers.length, imported: Object.values(back.layers).map(l => `${l.type}:${l.name}`) };
});
console.log('lottie round trip ->', JSON.stringify(rt));
await page.waitForTimeout(400);
await page.screenshot({ path: shotDir + '/lottie-rt.png' });
console.log(errs.length ? errs : 'no page errors');
await browser.close();
