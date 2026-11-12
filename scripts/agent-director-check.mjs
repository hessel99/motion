// REAL director-flow run through the sidebar (uses your Claude subscription): pick a style chip,
// send a brief, approve the storyboard card the agent proposes, let it build beat by beat, then
// print the transcript (tool steps, beats, cost) and save screenshots + the result contact sheet.
//   MOTION_BRIDGE_PORT=7863 node bridge/server.mjs &  npx vite --port 5273 &
//   URL=http://localhost:5273/ BRIDGE=7863 node scripts/agent-director-check.mjs outDir [style] [brief]
import { chromium } from './pw.mjs';
import fs from 'node:fs';

const out = process.argv[2] || 'director-run';
const style = process.argv[3] || 'Swiss';
const brief = process.argv[4] || (process.env.SETUP ? JSON.parse(fs.readFileSync(new URL('../src/agent/guides/evals/concept-briefs.json', import.meta.url), 'utf8')).briefs.find((x) => x.id === process.env.SETUP).brief : '') || 'Make a 10 second launch teaser for "Orbit", a calendar app for teams. Tagline: "Plan less. Do more."';
fs.mkdirSync(out, { recursive: true });
const URL = (process.env.URL || 'http://localhost:5273/') + `?blank&bridge=${process.env.BRIDGE || 7863}`;
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL);
await page.click('.lp-tab[aria-label="Agent"]').catch(() => {});
await page.evaluate((model) => { localStorage.setItem('motion.agent.model', model); localStorage.setItem('motion.agent.storyboard', 'ask'); for (const k of Object.keys(localStorage)) if (k.startsWith('motion.agent.chat:')) localStorage.removeItem(k); }, process.env.MODEL || 'auto').catch(() => {});
await page.goto(URL);
await page.waitForSelector('.dot.connected', { timeout: 15000 });
// SETUP=<brief id> builds an eval brief's artwork first (src/agent/guides/evals/concept-briefs.json) through MCP
if (process.env.SETUP) {
  const evals = JSON.parse(fs.readFileSync(new URL('../src/agent/guides/evals/concept-briefs.json', import.meta.url), 'utf8'));
  const b = evals.briefs.find((x) => x.id === process.env.SETUP);
  let n = 0;
  for (const c of b.setup) await fetch(`http://127.0.0.1:${process.env.BRIDGE || 7863}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name: c.tool, arguments: c.args } }) });
  await page.evaluate(() => editor.store.select([]));
  console.log('setup', b.id, '→ brief:', b.brief);
}
const idle = (ms = 900000) => page.waitForSelector('[data-testid=agent-working]', { state: 'detached', timeout: ms });
const t0 = Date.now();

if (style && style !== '-') await page.locator('.ag-style', { hasText: style }).first().click();
await page.fill('.agent-input textarea', brief);
await page.click('.agent-input button.primary');
await page.waitForSelector('[data-testid=agent-working]', { timeout: 10000 }).catch(() => {});
await idle();
console.log(`turn 1 (plan) ${Math.round((Date.now() - t0) / 1000)}s`);
const card = page.locator('[data-testid=storyboard]').last();
if (await card.count()) {
  console.log('STORYBOARD:\n' + (await card.innerText()));
  await card.screenshot({ path: `${out}/storyboard.png` });
  const approve = card.locator('button', { hasText: 'Approve' });
  if (await approve.count()) {
    await approve.click();
    await page.waitForSelector('[data-testid=agent-working]', { timeout: 10000 }).catch(() => {});
    await idle();
    console.log(`turn 2 (build) done at ${Math.round((Date.now() - t0) / 1000)}s`);
  }
} else console.log('no storyboard card');

const transcript = await page.evaluate(() => [...document.querySelectorAll('.agent-list > *')].map((m) => {
  if (m.matches('.ag-steps')) return '[steps] ' + [...m.querySelectorAll('.ag-step summary')].map((s) => s.textContent.trim()).join(' | ');
  return `[${m.className}] ` + m.textContent.replace(/\s+/g, ' ').slice(0, 400);
}));
console.log(transcript.join('\n'));
console.log('undo labels:', await page.evaluate(() => editor.store.historyLabels.slice(-8).join(' | ')));
console.log('layers:', await page.evaluate(() => Object.values(editor.store.project.layers).length), 'duration:', await page.evaluate(() => editor.store.comp.duration));
const prev = page.locator('[data-testid=result-preview]').last();
await prev.waitFor({ timeout: 20000 }).catch(() => {});
if (await prev.count()) {
  const src = await prev.getAttribute('src');
  fs.writeFileSync(`${out}/result.jpg`, Buffer.from(src.split(',')[1], 'base64'));
}
for (const t of [0.5, 2, 4, 6, 8, 9.5]) {
  await page.evaluate((tt) => { editor.pause(); editor.store.setTime(Math.min(tt, editor.store.comp.duration)); }, t);
  await page.waitForTimeout(200);
  await page.locator('.stage, canvas').first().screenshot({ path: `${out}/frame-${t}.png` }).catch(() => {});
}
await page.screenshot({ path: `${out}/full.png` });
console.log(errs.length ? errs : 'no page errors');
await browser.close();
