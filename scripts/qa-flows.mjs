// permanent QA flows (npm run qa): drives the real UI in chromium, dark mode, at 1440×900 and
// 1280×800, like a designer would, and fails on regressions found in the v0.3.2 QA sweep
// (docs/qa-report.md). every check names the bug it guards.
// usage: URL=http://localhost:5173/ node scripts/qa-flows.mjs
import { chromium } from './pw.mjs';
const base = process.env.URL || 'http://localhost:5173/';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : info}`); if (!ok) failed++; };
// noise from the software gl driver, not from the app
const benign = t => /GL Driver Message|GPU stall due to ReadPixels/.test(t);

for (const [w, h] of [[1440, 900], [1280, 800]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()); });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  await page.goto(`${base}?nobridge&theme=dark`);
  await page.waitForFunction(() => window.editor?.renderer);
  await page.waitForTimeout(300);

  // QA-1: a file opened from Home was fitted against the full-width (Home) stage, so the comp
  // overflowed the canvas once the sidebars came back
  await page.click('.preset-card >> nth=0');
  await page.waitForTimeout(400);
  const fit = await ev(() => {
    const r = document.querySelector('.viewport').getBoundingClientRect();
    const c = editor.store.comp;
    return { x0: viewport.panX, y0: viewport.panY, x1: viewport.panX + c.width * viewport.zoom, y1: viewport.panY + c.height * viewport.zoom, w: r.width, h: r.height };
  });
  check(`${w}: new file from Home fits the canvas`, fit.x0 >= 0 && fit.y0 >= 0 && fit.x1 <= fit.w + 0.5 && fit.y1 <= fit.h + 0.5, JSON.stringify(fit));
  // the fit follows a window resize until the user zooms or pans
  await page.setViewportSize({ width: w - 200, height: h });
  await page.waitForTimeout(300);
  const fit2 = await ev(() => { const r = document.querySelector('.viewport').getBoundingClientRect(); return viewport.panX >= 0 && viewport.panX + editor.store.comp.width * viewport.zoom <= r.width + 0.5; });
  check(`${w}: untouched view stays fitted after a window resize`, fit2);
  await page.setViewportSize({ width: w, height: h });

  // QA-2: a pasted Lottie opened in a tab called "clipboard"
  await ev(() => {
    const j = { v: '5.7.0', nm: 'Bounce', fr: 30, ip: 0, op: 30, w: 200, h: 200, layers: [{ ty: 4, ind: 1, ip: 0, op: 30, st: 0, ks: { p: { a: 0, k: [100, 100] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }, shapes: [{ ty: 'gr', it: [{ ty: 'rc', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [40, 40] }, r: { a: 0, k: 0 } }, { ty: 'fl', c: { a: 0, k: [1, 0.5, 0, 1] }, o: { a: 0, k: 100 } }, { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }] }] }] };
    const dt = new DataTransfer(); dt.setData('text/plain', JSON.stringify(j));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(600);
  const lot = await ev(() => ({ name: editor.store.project.name, n: editor.store.comp.root.length, tabs: document.querySelectorAll('.tb-tab').length }));
  check(`${w}: pasted Lottie opens in a tab named after it`, lot.name === 'Bounce' && lot.n === 1, JSON.stringify(lot));

  // QA-3: effect field labels ("Spread", "Density") shrank and ran into their value ("Spread0")
  await ev(async () => {
    const M = await import('/src/core/model.ts');
    const C = await import('/src/core/commands.ts');
    const s = editor.store;
    const l = M.createLayer('rect', { name: 'Fx', x: 0, y: 0, w: 100, h: 100 });
    s.transact('add', tx => C.insertLayer(s, tx, l, null));
    s.select([l.id]);
  });
  await page.waitForTimeout(200);
  for (const o of await page.locator('select[aria-label="Add effect"] option').allTextContents()) {
    if (o === 'Add…') continue;
    await page.selectOption('select[aria-label="Add effect"]', { label: o }).catch(() => {});
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(200);
  const clipped = await ev(() => [...document.querySelectorAll('.inspector .num-label')].filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map(e => e.textContent));
  check(`${w}: inspector field labels are not clipped`, clipped.length === 0, JSON.stringify(clipped));

  // QA-4: reopening a recent file wiped its thumbnail (the open stored "no thumbnail")
  if (w === 1440) {
    await page.goto(`${base}?nobridge&theme=dark`);
    await page.waitForFunction(() => window.editor?.renderer);
    await page.click('text=Open the demo animation'); await page.waitForTimeout(600);
    await ev(async () => { const D = await import('/src/app/documents.ts'); for (const d of [...D.documents()]) D.closeDoc(d.id, { force: true }); });
    await page.waitForTimeout(2600); // the recent entry is written in idle time
    await page.click('.recent-open >> nth=0'); await page.waitForTimeout(2600);
    const thumb = await ev(async () => { const R = await import('/src/app/recent.ts'); return !!(await R.recentThumb(R.recentFiles()[0].key)); });
    check('reopening a recent file keeps its thumbnail', thumb);
  }

  // no horizontal page overflow
  const overflow = await ev(() => document.documentElement.scrollWidth - innerWidth);
  check(`${w}: no horizontal page overflow`, overflow <= 0, `${overflow}px`);

  check(`${w}: no page errors`, errors.length === 0, JSON.stringify(errors.slice(0, 5)));
  await ctx.close();
}
await browser.close();
console.log(failed ? `${failed} FAILED` : 'OK');
process.exit(failed ? 1 : 0);
