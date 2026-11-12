// screenshots of the agent panel's states against the scripted fake claude (no subscription used):
//   PATH=$PWD/tests/fixtures/fake-claude:$PATH MOTION_BRIDGE_PORT=7839 node bridge/server.mjs &
//   URL=http://localhost:5391/ BRIDGE=7839 node scripts/agent-panel-shots.mjs [outDir] [scale]
// states: empty, running (with the status line), finished (review card), storyboard with concepts.
import { chromium } from './pw.mjs';
import { mkdirSync } from 'node:fs';
const base = (process.env.URL || 'http://localhost:5173/') + `?blank&bridge=${process.env.BRIDGE || 7839}&theme=${process.env.THEME || 'dark'}`;
const out = process.argv[2] || 'docs/shots/ui-v3';
const scale = +(process.argv[3] || 2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: scale });
page.on('pageerror', e => errors.push(e.message));
await page.goto(base);
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('motion.agent.chat:')) localStorage.removeItem(k); });
await page.goto(base);
await page.waitForSelector('.dot.connected', { timeout: 15000 });
await page.waitForTimeout(600);
const shot = async name => { await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${name}.png` }); console.log('shot', name); };
const idle = () => page.waitForSelector('[data-testid=agent-working]', { state: 'detached', timeout: 30000 });
const send = async text => { await page.fill('.agent-input textarea', text); await page.keyboard.press('Enter'); };

await shot('20-agent-empty');
// a storyboard with concepts (the director flow)
await send('Make a storyboard for the launch teaser');
await idle();
await shot('21-agent-storyboard');
await page.evaluate(() => document.querySelector('[data-testid=storyboard]')?.scrollIntoView({ block: 'start' }));
await page.waitForTimeout(200);
await page.locator('aside.left').screenshot({ path: `${out}/21b-agent-storyboard-concepts-panel.png` });
// approve: the build runs beat by beat
await page.click('.ag-sb .ag-btn.primary');
await idle();
await page.evaluate(() => editor.store.select([]));
await page.waitForTimeout(800);
await page.evaluate(() => document.querySelector('.agent-list')?.scrollTo({ top: 1e9 }));
await shot('23-agent-finished-review');
// a running turn (the fake waits on "slow"): status line, stop button; the panel collapsed shows the pill in the timeline header
await send('slow: tighten the timing of the reveal');
await page.waitForSelector('[data-testid=agent-working]');
await page.waitForTimeout(1200);
await shot('22-agent-running');
await page.click('.tb-lead button:nth-child(2)');
await page.waitForTimeout(300);
await shot('24-agent-collapsed-progress-in-timeline');
await page.click('.tb-lead button:nth-child(2)');
await page.click('.send-btn.stop');
await idle();
await browser.close();
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
