// UI check of the taste layer's polishing loop in the agent panel, against the scripted fake CLI:
//   PATH=$PWD/tests/fixtures/fake-claude:$PATH MOTION_BRIDGE_PORT=7836 node bridge/server.mjs &
//   npx vite --port 5185 & URL=http://localhost:5185/ BRIDGE=7836 node scripts/taste-ui-check.mjs [shot.png]
// A build turn ends → the critic finds issues → a quiet "Polishing: N fixes" row (no user bubble) →
// the follow-up runs in the same session → one review card covers build + polish. With the setting
// off, nothing follows.
import { chromium } from './pw.mjs';

const URL = (process.env.URL || 'http://localhost:5185/') + `?blank&bridge=${process.env.BRIDGE || 7836}`;
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

async function run(taste) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('motion.agent.taste', t); } catch { /* */ } }, taste);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL);
  await page.waitForFunction(() => window.editor?.store);
  await page.waitForSelector('.agent-input textarea', { timeout: 20000 });
  await page.waitForFunction(async () => (await import('/src/agent/client.ts')).agentClient.status === 'connected', null, { timeout: 15000 });
  await page.fill('.agent-input textarea', 'make two shapes');
  await page.keyboard.press('Enter');
  // the build, then (taste on) up to two polishing rounds
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => !document.querySelector('[data-testid=agent-working]'), null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.waitForFunction(() => !document.querySelector('[data-testid=agent-working]'), null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.waitForFunction(() => !document.querySelector('[data-testid=agent-working]'), null, { timeout: 60000 });
  const info = await page.locator('.agent-list, aside').first().innerText().catch(() => '');
  const users = await page.locator('.msg.user').count();
  const reviews = await page.locator('[data-testid=turn-review], .ag-review, .review').count();
  const polishing = (info.match(/Polishing: \d+ fix/g) ?? []).length;
  if (taste === 'on') {
    check(polishing >= 1, `taste on: a "Polishing" row appears (${polishing})`);
    check(users === 1, `taste on: no extra user bubbles (${users})`);
    check(reviews <= 1, `taste on: one review card for build + polish (${reviews})`);
    if (process.argv[2]) await page.locator('aside').first().screenshot({ path: process.argv[2] });
  } else check(polishing === 0, `taste off: no polishing (${polishing})`);
  check(!errs.length, `no page errors ${errs.slice(0, 2).join(' | ')}`);
  await ctx.close();
}
await run('on');
await run('off');
await browser.close();
process.exit(failed ? 1 : 0);
