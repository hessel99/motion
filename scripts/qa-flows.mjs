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

  // no horizontal page overflow
  const overflow = await ev(() => document.documentElement.scrollWidth - innerWidth);
  check(`${w}: no horizontal page overflow`, overflow <= 0, `${overflow}px`);

  check(`${w}: no page errors`, errors.length === 0, JSON.stringify(errors.slice(0, 5)));
  await ctx.close();
}
await browser.close();
console.log(failed ? `${failed} FAILED` : 'OK');
process.exit(failed ? 1 : 0);
