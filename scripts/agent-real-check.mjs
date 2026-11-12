// REAL agent session through the sidebar (uses the owner's Claude subscription — keep runs few).
//   node scripts/agent-real-check.mjs <outDir> [step ...]
// steps: build | bouncier | variations | critique   (default: build critique)
// env: URL (vite, default http://localhost:5185/), BRIDGE (port, default 7823), MODEL (default sonnet)
import { chromium } from './pw.mjs';
import fs from 'node:fs';

const out = process.argv[2] || 'agent-real';
const steps = process.argv.slice(3).length ? process.argv.slice(3) : ['build', 'critique'];
fs.mkdirSync(out, { recursive: true });
const URL = (process.env.URL || 'http://localhost:5185/') + `?blank&bridge=${process.env.BRIDGE || 7823}`;
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL);
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('motion.agent.chat:')) localStorage.removeItem(k); });
await page.goto(URL);
await page.waitForSelector('.dot.connected', { timeout: 15000 });
await page.selectOption('.model-select', process.env.MODEL ?? 'sonnet');

const idle = () => page.waitForSelector('[data-testid=agent-working]', { state: 'detached', timeout: 600000 });
async function turn(label, run) {
  const sel = '.agent-list > :is(.msg, .ag-steps, .ag-review)';
  const n0 = await page.locator(sel).count();
  const t0 = Date.now();
  await run();
  await page.waitForSelector('[data-testid=agent-working]', { timeout: 10000 }).catch(() => {});
  await idle();
  const items = await page.evaluate(([n0, sel]) => [...document.querySelectorAll(sel)].slice(n0).map((el) => {
    if (el.classList.contains('ag-steps')) return '[steps] ' + [...el.querySelectorAll('.ag-step')].map((s) => (s.classList.contains('err') ? '✕ ' : '') + s.querySelector('summary').textContent.trim()).join(' | ');
    return `[${el.className}] ${el.textContent.slice(0, 400)}`;
  }), [n0, sel]);
  console.log(`\n=== ${label} (${Math.round((Date.now() - t0) / 1000)}s)\n` + items.join('\n'));
  await page.evaluate(() => editor.pause());
  await page.locator('aside.left').screenshot({ path: `${out}/${label}.png` });
}
const typeSend = (text) => async () => { await page.fill('.agent-input textarea', text); await page.click('.agent-input button.primary'); };
const chip = (name) => async () => { await page.locator('.ag-qchip', { hasText: name }).click(); };
const selectAll = () => page.evaluate(() => editor.store.select(editor.store.comp.root.slice()));

for (const s of steps) {
  if (s === 'build') await turn('build', typeSend('Three small cards in a row that slide up and fade in one after another. Under 2 seconds.'));
  if (s === 'bouncier') { await selectAll(); await turn('bouncier', chip('Bouncier')); }
  if (s === 'variations') { await selectAll(); await turn('variations', chip('3 variations')); console.log('variations:', await page.locator('.ag-var-label').allTextContents()); }
  if (s === 'critique') { await page.evaluate(() => editor.store.select([])); await turn('critique', chip('Critique')); }
}
console.log('\nlayers:', await page.evaluate(() => Object.values(editor.store.project.layers).map((l) => `${l.name}:${Object.keys(l.props).filter((k) => l.props[k].kf?.length).join('+')}`).join(', ')));
console.log(errs.length ? errs : 'no page errors');
await browser.close();
