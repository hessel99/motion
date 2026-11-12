// UI check of the agent panel against a bridge whose `claude` is the scripted fake
// (tests/fixtures/fake-claude/claude), so no subscription is used:
//   PATH=$PWD/tests/fixtures/fake-claude:$PATH MOTION_BRIDGE_PORT=7836 node bridge/server.mjs &
//   npx vite --port 5185 & node scripts/agent-ui-check.mjs [outDir]
// Covers: storyboard card (edit/approve/progress), style picker, result preview, streaming tool steps + screenshot thumbnails, review card (diff, hold-to-compare, revert),
// @-mentions, context chips, quick actions, variations tray, Ask mode, typed errors, stop, persistence.
import { chromium } from './pw.mjs';
import fs from 'node:fs';

const URL = (process.env.URL || 'http://localhost:5185/') + `?blank&bridge=${process.env.BRIDGE || 7836}`;
const out = process.argv[2] || 'agent-ui';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const shot = (name) => page.locator('aside.left').screenshot({ path: `${out}/${name}.png` });
const idle = () => page.waitForSelector('[data-testid=agent-working]', { state: 'detached', timeout: 30000 });
const send = async (text) => { await page.fill('.agent-input textarea', text); await page.click('.agent-input button.primary'); await idle(); };
const rootCount = () => page.evaluate(() => editor.store.comp.root.length);

await page.goto(URL);
await page.click('.lp-tab[aria-label="Agent"]'); // the conversation lives on the left panel's agent tab
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('motion.agent.chat:')) localStorage.removeItem(k); });
await page.goto(URL);
await page.waitForSelector('.dot.connected', { timeout: 15000 });

// 1. a building turn
await send('Build two shapes');
check(await page.locator('[data-testid=turn-review]').count() === 1, 'review card after an editing turn');
const reviewText = await page.locator('[data-testid=turn-review]').innerText();
check(/added 2 layers/.test(reviewText) && /Box/.test(reviewText) && /Dot/.test(reviewText), 'diff lists added layers: ' + reviewText.split('\n')[0]);
const steps = await page.locator('.ag-step summary').allTextContents();
check(steps.some((s) => /Add rect “Box”/.test(s)) && steps.some((s) => /Animate 2 tracks/.test(s)), 'human tool labels: ' + steps.join(' | ').replace(/\s+/g, ' '));
check(await page.locator('.ag-shots img').count() >= 1, 'screenshot the agent took is shown inline');
check(/in · .* out/.test(await page.locator('.msg.info').last().innerText()), 'usage stats shown');
await shot('1-review');

// hold to compare (after the result preview arrived: it is part of the card's column)
await page.waitForSelector('[data-testid=result-preview]', { timeout: 10000 });
const cmp = page.locator('[data-testid=turn-review] button', { hasText: 'Hold to compare' });
await cmp.scrollIntoViewIfNeeded();
const box = await cmp.boundingBox();
await page.mouse.move(box.x + 5, box.y + 5);
await page.mouse.down();
await page.waitForTimeout(100);
const during = await rootCount();
await shot('2-comparing');
await page.mouse.up();
await page.waitForTimeout(100);
check(during === 0 && (await rootCount()) === 2, `hold-to-compare shows the before state (${during} → ${await rootCount()})`);

// click a layer in the diff selects it
await page.locator('.ag-diff-row button', { hasText: 'Box' }).click();
check((await page.evaluate(() => editor.store.selection.map((id) => editor.store.layer(id).name))).join() === 'Box', 'clicking a diff row selects the layer');

// revert
await page.locator('[data-testid=turn-review] button', { hasText: 'Revert' }).click();
check((await rootCount()) === 0, 'revert undoes the whole turn');
check(/Reverted/.test(await page.locator('[data-testid=turn-review]').innerText()), 'card shows reverted state');

// 2. build again, then @-mention + context
await send('Build two shapes again');
await page.evaluate(() => editor.store.select([Object.values(editor.store.project.layers).find((l) => l.name === 'Dot').id]));
await page.click('.agent-input textarea');
await page.keyboard.type('make @Bo');
await page.waitForSelector('.ag-mentions');
check((await page.locator('.ag-mention').allInnerTexts()).some((t) => t.includes('Box')), 'mention popup lists layers');
await page.keyboard.press('Enter');
const val = await page.inputValue('.agent-input textarea');
check(val === 'make @Box ', 'mention inserted: ' + JSON.stringify(val));
const ctx = await page.locator('.ag-context').innerText();
check(/Dot/.test(ctx) && /@Box/.test(ctx), 'context chips show selection + mention: ' + ctx.replace(/\s+/g, ' '));
await shot('3-mention');
await page.fill('.agent-input textarea', '');

// 3. variations via quick action (selection = Dot)
await page.locator('.ag-qchip', { hasText: '3 variations' }).click();
await idle();
check(await page.locator('.ag-var').count() === 3, 'variations tray shows 3 variations');
check(await page.locator('.ag-var-strip img').count() === 9, 'variation filmstrips rendered');
await page.locator('.ag-var', { hasText: 'A · Snappy' }).click();
await page.waitForTimeout(200);
const dur = await page.evaluate(() => { const l = Object.values(editor.store.project.layers).find((x) => x.name === 'Dot'); return l.props.scale.kf.at(-1).t; });
check(Math.abs(dur - 0.4) < 1e-6, 'picking variation A applies its timing');
await page.evaluate(() => editor.pause());
await shot('4-variations');
await page.locator('.ag-var-foot button', { hasText: 'Use' }).click();
check(await page.locator('[data-testid=variations]').count() === 0, 'Use closes the tray');

// 4. Ask mode (critique chip): read-only
const before = await rootCount();
const reviews = await page.locator('[data-testid=turn-review]').count();
await page.locator('.ag-qchip', { hasText: 'Critique' }).click();
await idle();
check((await rootCount()) === before && (await page.locator('[data-testid=turn-review]').count()) === reviews, 'Ask mode changed nothing');
check(await page.locator('.ag-step.err summary', { hasText: 'Add rect' }).count() === 1, 'edit attempt refused in Ask mode');
check(/edit attempt refused: true/.test(await page.locator('.msg.assistant').last().innerText()), 'agent saw the refusal');
await shot('5-critique');

// 5. typed error + retry button
await send('please fail auth');
const errText = await page.locator('.ag-error').last().innerText();
check(/Not logged in/.test(errText) && /log in/.test(errText) && /Retry/.test(errText), 'auth error card with fix + retry');
await shot('6-error');

// 6. stop
await page.fill('.agent-input textarea', 'go slow');
await page.click('.agent-input button.primary');
await page.waitForSelector('[data-testid=agent-working]');
await page.waitForTimeout(500);
await page.locator('.agent-input button[aria-label="Stop"]').click();
await idle();
check(/Stopped/.test(await page.locator('.msg.info').last().innerText()), 'stop ends the turn');

// 7. style picker + storyboard card (director workflow): propose → edit a beat → approve → per-beat progress
await page.locator('.ag-style', { hasText: 'Swiss' }).click();
check(await page.locator('.ag-style.on').count() === 1, 'style chip picked');
await send('Make a storyboard for a launch teaser');
check(await page.locator('.ag-style.on').count() === 0, 'style chip resets after sending');
check(/swiss/i.test(await page.locator('.msg.user').last().innerText()), 'user message tagged with the style');
check(/style prefix: true; wait: true/.test(await page.locator('.msg.assistant').last().innerText()), 'brief carried the style prefix; agent told to wait for approval');
const card = page.locator('[data-testid=storyboard]').last();
check((await card.count()) === 1 && (await card.locator('[data-testid=storyboard-beat]').count()) === 3, 'storyboard card with 3 beats');
check(await page.locator('.ag-step summary', { hasText: 'Read guide' }).count() >= 1, 'get_guide step labeled');
await card.locator('input[aria-label="Beat 2 name"]').fill('Logo resolve');
check(/Edited/.test(await card.innerText()), 'card shows it was edited');
await shot('7-storyboard');
await card.locator('button', { hasText: 'Approve' }).click();
await page.waitForSelector('[data-testid=agent-working]');
await idle();
const cardText = await card.innerText();
check(/built/i.test(cardText) && (await card.locator('.ag-sb-beat.done').count()) === 3, 'all beats done on the card: ' + cardText.split('\n')[0]);
check(/Logo resolve/.test(cardText), 'edited beat name kept after approval');
const labels = await page.evaluate(() => editor.store.historyLabels.slice(-3));
check(labels.join('|') === 'Beat 1 · Hook|Beat 2 · Logo resolve|Beat 3 · End card', 'each beat is one undo step: ' + labels.join(' | '));
check(/Approved storyboard \(edited\)/.test(await page.locator('.msg.user').last().innerText()), 'approval sent as a chip');
await page.waitForSelector('[data-testid=result-preview]', { timeout: 10000 }).catch(() => {});
check(await page.locator('[data-testid=result-preview]').count() >= 1, 'inline result preview (contact sheet) at the end of the turn');
await page.evaluate(() => editor.pause());
await shot('8-storyboard-built');

// 8. persistence across reload
const n = await page.locator('.agent-list .msg').count();
await page.waitForTimeout(2500); // let the project autosave so the reload reopens the same document
await page.goto(URL.replace('?blank&', '?'));
await page.waitForSelector('.dot.connected');
const n2 = await page.locator('.agent-list .msg').count();
check(n2 === n, `conversation restored after reload (${n} → ${n2} messages)`);
check(await page.locator('[data-testid=turn-review].stale').count() >= 1, 'old review cards are marked stale');

check(errs.length === 0, 'no page errors ' + (errs.length ? JSON.stringify(errs) : ''));
await browser.close();
console.log(failed ? `${failed} checks failed` : 'all agent UI checks passed');
process.exit(failed ? 1 : 0);
