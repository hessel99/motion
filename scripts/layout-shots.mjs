// screenshots of every window layout (docs/layouts.md) at 2x, in realistic states:
// demo selected with keys, during playback, with an agent conversation, and the command palette.
// usage: URL=http://localhost:5173/ node scripts/layout-shots.mjs [outDir=docs/layouts] [layout...]
import { chromium } from './pw.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.env.URL || 'http://localhost:5173/';
const [outDir = 'docs/layouts', ...only] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const LAYOUTS = only.length ? only : ['classic', 'stage', 'score', 'director', 'studio'];

// a short, plausible conversation (seeded through localStorage, the panel's own persistence)
const CHAT = {
  v: 1, sessions: {}, savedAt: Date.now(),
  msgs: [
    { role: 'user', mode: 'edit', text: 'Make the three shapes pop in one after another, then land the title on the beat at 1.5s' },
    { role: 'tool', text: '', tool: { id: 't1', name: 'get_animation', input: {}, result: 'ok', ms: 40 } },
    { role: 'tool', text: '', tool: { id: 't2', name: 'stagger', input: { ids: ['Square', 'Circle', 'Pill'], step: 0.12 }, result: 'ok', ms: 60 } },
    { role: 'tool', text: '', tool: { id: 't3', name: 'set_easing', input: { id: 'Title', prop: 'position', ease: 'Back Out' }, result: 'ok', ms: 30 } },
    { role: 'tool', text: '', tool: { id: 't4', name: 'screenshot', input: { times: [0.4, 0.9, 1.5] }, result: 'ok', ms: 220 } },
    { role: 'assistant', text: 'Done. The square, circle and pill now scale in 0.12 s apart with a soft overshoot, and the title rises into place with **Back Out**, landing exactly on 1.5 s.\n\n- Want the cascade to *rush* (fast start, then settle)? Try the Groove knob.\n- Everything is one undo step.' },
    { role: 'user', mode: 'edit', text: 'A bit snappier on the pill' },
  ],
};

const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const errors = [];

async function open(layout, { chat = false, agent = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => errors.push(`${layout}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${layout}: ${m.text()}`); });
  await page.addInitScript(([chatJson, agentOpen]) => {
    localStorage.setItem('motion.welcomed', '1');
    localStorage.setItem('motion.agentOpen', agentOpen ? '1' : '0');
    if (chatJson) {
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (k) { return String(k).startsWith('motion.agent.chat:') ? chatJson : get.call(this, k); };
    }
  }, [chat ? JSON.stringify(CHAT) : null, agent]);
  await page.goto(`${BASE}?demo&nobridge&layout=${layout}`);
  await page.waitForFunction(() => window.editor?.renderer && window.editor.store.comp.root.length);
  await page.waitForTimeout(600);
  return page;
}

/** the demo's "Pill" selected at 0.9 s with its position segment's keys selected */
const selectPill = page => page.evaluate(() => {
  const s = editor.store;
  const id = s.comp.root.find(i => s.layer(i).name === 'Pill') ?? s.comp.root[0];
  s.select([id]);
  s.setTime(0.9);
  const kf = s.layer(id).props.position.kf;
  if (kf?.length >= 2) { s.keySelection = new Set([`${id}|position|0`, `${id}|position|1`]); s.emit('keys'); }
});

for (const L of LAYOUTS) {
  // 1. composing / timing: a layer selected, a segment of keys selected
  {
    const page = await open(L, { agent: L !== 'stage' && L !== 'studio' });
    await selectPill(page);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${outDir}/${L}-1-selected.png` });
    // 2. playback
    await page.evaluate(() => { editor.store.setTime(0.2); editor.play(); });
    await page.waitForTimeout(650);
    await page.screenshot({ path: `${outDir}/${L}-2-playback.png` });
    await page.evaluate(() => editor.pause());
    await page.close();
  }
  // 3. with the agent conversation
  {
    const page = await open(L, { chat: true, agent: true });
    await selectPill(page);
    await page.evaluate(() => { editor.store.keySelection = new Set(); editor.store.emit('keys'); });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${outDir}/${L}-3-agent.png` });
    if (L === 'stage') {
      // the drawer pulled up to the full timeline (` key), agent closed
      await page.keyboard.press('Control+i');
      await page.keyboard.press('Backquote');
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${outDir}/${L}-4-full-timeline.png` });
    }
    await page.close();
  }
}

// command palette (director: panels are summoned)
if (LAYOUTS.includes('director')) {
  const page = await open('director', { chat: true });
  await selectPill(page);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(150);
  await page.keyboard.type('tim');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/director-4-palette.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  // the summoned sheets
  await page.keyboard.press('Backquote');
  await page.evaluate(() => { const b = [...document.querySelectorAll('.summon-bar button')].find(b => b.textContent.includes('Properties')); b?.click(); });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/director-5-sheets.png` });
  await page.close();
}

// studio: the transitions & effects browser, a layer selected
if (LAYOUTS.includes('studio')) {
  const page = await open('studio', { agent: false });
  await page.evaluate(() => { const s = editor.store; s.select([s.comp.root.find(i => s.layer(i).name === 'Pill')]); s.setTime(0.9); });
  await page.locator('.studio-fx-pill').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/studio-4-effects.png` });
  await page.close();
}

await browser.close();
console.log(errors.length ? errors.join('\n') : 'no console errors');
