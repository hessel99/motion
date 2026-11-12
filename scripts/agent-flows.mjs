// agent flows across documents, undo, entry points and errors, against an in-process bridge whose
// `claude` is the scripted fake (tests/fixtures/fake-claude/claude): no subscription is used.
//   npx vite --port 5291 &   URL=http://localhost:5291/ node scripts/agent-flows.mjs [outDir]
// every check names the QA finding it guards (scratchpad qa-ai-ux.json, docs/next-up.md "Now"):
//   AIUX-01 runs survive tab switches · AIUX-09 a turn is one undo step · AIUX-04 the result plays
//   AIUX-02/03/14 asks never overwrite the draft, queue while busy, selection-bar inline ask
//   AIUX-19/20/21 errors with one fix (Continue / Check again / Reconnect), error toasts stay
//   AIUX-22 critique runs read-only
import { chromium } from './pw.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PATH = `${root}/tests/fixtures/fake-claude${path.delimiter}${process.env.PATH}`;
const { startBridge } = await import('../bridge/server.mjs');
let bridge = await startBridge({ port: 0, log: () => {}, claudeShaders: false, dataDir: fs.mkdtempSync('/tmp/motion-flows-') });
const port = bridge.port;

const base = process.env.URL || 'http://localhost:5291/';
const out = process.argv[2] || 'agent-flows';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
let failed = 0;
const check = (ok, what, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ' ' + info}`); if (!ok) failed++; };
const ev = (fn, arg) => page.evaluate(fn, arg);
const idle = (timeout = 30000) => page.waitForSelector('[data-testid=agent-working]', { state: 'detached', timeout });
const working = () => page.waitForSelector('[data-testid=agent-working]', { timeout: 10000 });
const type = async (text) => { await page.fill('.agent-input textarea', text); await page.press('.agent-input textarea', 'Enter'); };
const send = async (text) => { await type(text); await working(); await idle(); };
const rootNames = () => ev(() => editor.store.comp.root.map((id) => editor.store.layer(id).name));
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });

await page.goto(`${base}?blank&bridge=${port}`);
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('motion.agent')) localStorage.removeItem(k); });
await page.goto(`${base}?blank&bridge=${port}`);
await page.waitForFunction(() => window.editor?.renderer);
if (!(await page.locator('.agent-head').count())) await page.click('[aria-label="Agent"]');
await page.waitForSelector('.dot.connected', { timeout: 15000 });

// ---------- AIUX-09 + AIUX-04: one turn = one undo step; the result plays on the canvas ----------
await send('Build two shapes');
check((await rootNames()).join() === 'Box,Dot', 'turn built two shapes', (await rootNames()).join());
const labels = await ev(() => editor.store.historyLabels);
check(labels.length === 1 && /^Agent: /.test(labels[0]), 'AIUX-09: the turn is ONE labelled undo step', JSON.stringify(labels));
await page.waitForTimeout(1500);
const t = await ev(() => ({ time: editor.store.time, playing: editor.store.playing }));
check(t.time > 0.5 && !t.playing, 'AIUX-04: the result played once and the playhead rests on its end state', JSON.stringify(t));
await ev(() => editor.store.undo());
check((await rootNames()).length === 0, 'AIUX-09: one ⌘Z undoes the whole turn');
const rev = page.locator('[data-testid=turn-review]').last();
check(await rev.locator('button', { hasText: 'Revert' }).isDisabled(), 'the review card follows the history (no Revert after the undo)');
await ev(() => editor.store.redo());

// ---------- AIUX-01: a run keeps going in its document while another tab is in front ----------
const before = await rootNames();
await type('wait 4s then build');
await working();
await page.click('.tb-add'); // a new file opens in front while the agent works in the first one
await page.waitForTimeout(300);
check(await page.locator('[data-testid=tab-running]').count() === 1, 'AIUX-01: the running tab shows a spinner');
check((await page.locator('.agent-list .msg.user').count()) === 0, 'the new file shows its own (empty) conversation');
await shot('01-background-run');
await page.waitForSelector('[data-testid=tab-running]', { state: 'detached', timeout: 15000 });
check((await rootNames()).length === 0 && (await ev(() => editor.store.historyLength)) === 0, 'AIUX-01: the run never edited the file in front');
await page.locator('.tb-tab').first().click();
await page.waitForTimeout(300);
const after = await rootNames();
check(after.length === before.length + 2, 'AIUX-01: the run finished in its own file', `${before.join()} → ${after.join()}`);
const cards = page.locator('[data-testid=turn-review]');
check(await cards.count() === 2 && (await page.locator('[data-testid=turn-review].stale').count()) === 0, 'AIUX-01: no review card went stale', String(await cards.count()));
check(await ev(() => editor.store.historyLabels.length) === 2, 'the background turn is one undo step too');
await cards.last().locator('button', { hasText: 'Revert' }).click();
check((await rootNames()).join() === before.join(), 'AIUX-01: the background turn reverts from its card after the switch');
check(!(await cards.first().locator('button', { hasText: 'Revert' }).isDisabled()), 'the earlier card is live again (Revert enabled)');
await shot('02-back-in-first-tab');

// ---------- AIUX-02 / AIUX-03: asks never overwrite the draft; Enter queues while running ----------
await type('wait 3s then build');
await working();
await page.click('.agent-input textarea');
await page.keyboard.type('my long unsent draft');
await ev(() => editor.store.workArea = [0.5, 1.5]);
await page.keyboard.press('Control+k');
await page.fill('.askbar-input', 'make it feel more premium');
await page.press('.askbar-input', 'Enter');
await page.waitForTimeout(200);
check(await page.inputValue('.agent-input textarea') === 'my long unsent draft', 'AIUX-02: a ⌘K ask keeps the unsent draft');
const q = page.locator('[data-testid=agent-queued]');
check(await q.count() === 1 && /premium/.test(await q.innerText()) && /queued/i.test(await q.innerText()), 'AIUX-02: the ask waits as a visible queued bubble', await q.allInnerTexts().then((x) => x.join('|')));
check(/time range 0\.50s–1\.50s/.test(await q.innerText()), 'AIUX-02: the time range stays with the ask as a chip');
await page.fill('.agent-input textarea', 'also slower please');
await page.press('.agent-input textarea', 'Enter');
check(await q.count() === 2 && (await page.inputValue('.agent-input textarea')) === '', 'AIUX-03: Enter while running queues the follow-up');
await shot('03-queued');
await ev(() => editor.store.workArea = null);
// the queue drains in order once the agent is free
await page.waitForFunction(() => document.querySelectorAll('[data-testid=agent-queued]').length === 0, null, { timeout: 30000 });
await idle();
const users = await page.locator('.agent-list .msg.user').allInnerTexts();
check(/premium/.test(users.at(-2)) && /also slower/.test(users.at(-1)), 'queued messages were sent in order', users.slice(-2).join(' | '));
check(await page.locator('.msg.user .ag-msg-ctx', { hasText: 'time range' }).count() >= 1, 'the sent ask shows its context chip');

// ---------- AIUX-14: the selection bar asks inline, at the layer ----------
await ev(() => { editor.pause(); editor.store.select([editor.store.comp.root[0]]); });
await page.waitForSelector('.sel-bar .sel-ask', { state: 'visible' });
await page.click('.sel-bar .sel-ask');
check(await page.locator('.sel-ask-pop input').count() === 1 && (await page.locator('.askbar').count()) === 0, 'AIUX-14: Ask opens an inline prompt (not the command palette)');
await shot('04-inline-ask');
const nUsers = await page.locator('.agent-list .msg.user').count();
await page.fill('.sel-ask-pop input', 'make it bouncier');
await page.press('.sel-ask-pop input', 'Enter');
await working(); await idle();
check(await page.locator('.agent-list .msg.user').count() === nUsers + 1 && /bouncier/.test(await page.locator('.agent-list .msg.user').last().innerText()), 'AIUX-14: the inline ask is sent with the layer');

// ---------- AIUX-22: critique runs read-only ----------
const n0 = (await rootNames()).length;
await ev(async () => { const m = await import('/src/ui/agent-menu.ts'); m.agentMenuItems('comp').find((i) => i.label === 'Critique the motion').action(); });
await working(); await idle();
check((await rootNames()).length === n0, 'AIUX-22: critique changed nothing');
check(await page.locator('.ag-step.err summary', { hasText: 'Add rect' }).count() >= 1 && /refused: true/.test(await page.locator('.msg.assistant').last().innerText()), 'AIUX-22: its edit attempt was refused');
check(/read-only/i.test(await page.locator('.agent-list .msg.user').last().innerText()), 'AIUX-22: the bubble is tagged read-only');

// ---------- AIUX-19: turn budget → Continue ----------
await send('please fail budget');
const budget = page.locator('[data-testid=agent-error]').last();
check(await budget.locator('button.primary', { hasText: 'Continue' }).count() === 1 && (await budget.locator('button', { hasText: 'Retry' }).count()) === 0, 'AIUX-19: the budget error offers Continue (not a Retry that fails again)');
await budget.locator('button', { hasText: 'Continue' }).click();
await working(); await idle();
check(/Continue/.test(await page.locator('.agent-list .msg.user').last().innerText()), 'AIUX-19: Continue sends "continue"');

// ---------- AIUX-20: not signed in → steps in the app + Check again ----------
await send('please fail auth');
const auth = page.locator('[data-testid=agent-error]').last();
const authText = await auth.innerText();
check(/Sign in to Claude/.test(authText) && /Check again/.test(authText) && !/Reset session/.test(authText), 'AIUX-20: sign-in steps with Check again', authText.replace(/\s+/g, ' '));
check(await auth.locator('details summary', { hasText: 'details' }).count() === 1, 'AIUX-20: the raw error stays behind "details"');
await shot('05-auth');

// ---------- error toasts stay until dismissed ----------
await ev(async () => { (await import('/src/app/actions.ts')).toast('Export failed: disk full', 'error'); });
await page.waitForTimeout(6000);
const toast = page.locator('.toast.error', { hasText: 'disk full' });
check(await toast.count() === 1, 'error toast still there after 6s');
await toast.locator('.toast-x').click();
check(await toast.count() === 0, 'error toast closes with its ✕');

// ---------- AIUX-21: offline → Reconnect; a brief from the brief box waits and sends on connect ----------
await bridge.close();
await page.waitForSelector('[data-testid=agent-reconnect]', { timeout: 10000 });
await page.click('.tb-add');
// with the agent panel open, the empty canvas only shows a note (the panel's composer is the one brief box)
await page.waitForSelector('.vp-empty-note', { timeout: 5000 });
check(await page.locator('[data-testid=agent-reconnect]').count() >= 1, 'AIUX-21: the panel offers Reconnect while offline');
await page.fill('.agent-input textarea', 'Build two shapes for the offline test');
await page.press('.agent-input textarea', 'Enter');
await page.waitForTimeout(300);
const pend = page.locator('[data-testid=agent-queued]');
check(await pend.count() === 1 && /waiting for the agent/i.test(await pend.innerText()), 'AIUX-21: the brief waits as a pending bubble');
await shot('06-offline-pending');
bridge = await startBridge({ port, log: () => {}, claudeShaders: false, dataDir: fs.mkdtempSync('/tmp/motion-flows-') });
await page.click('[data-testid=agent-reconnect]');
await page.waitForSelector('.dot.connected', { timeout: 10000 });
await page.waitForFunction(() => document.querySelectorAll('[data-testid=agent-queued]').length === 0, null, { timeout: 10000 });
await idle();
check((await rootNames()).join() === 'Box,Dot', 'AIUX-21: Reconnect sent the pending brief and it ran', (await rootNames()).join());

// ---------- closing a tab with a running turn stops it visibly ----------
await type('wait 5s then build');
await working();
await page.click('.tb-add');
await ev(async () => { const d = await import('/src/app/documents.ts'); const all = d.documents(); d.closeDoc(all[all.length - 2].id, { force: true }); });
await page.waitForTimeout(300);
check(await page.locator('[data-testid=tab-running]').count() === 0, 'closing the running tab stops its run');

check(errs.length === 0, 'no page errors', JSON.stringify(errs));
await browser.close();
await bridge.close();
console.log(failed ? `${failed} checks failed` : 'all agent flow checks passed');
process.exit(failed ? 1 : 0);
