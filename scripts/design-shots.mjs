// design screenshots of the motion-first layout (2×, 1440×900, dark + light) into docs/shots/design-v2/.
//   URL=http://localhost:5173/ node scripts/design-shots.mjs [only]
import { chromium } from './pw.mjs';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL || 'http://localhost:5173/';
const OUT = 'docs/shots/design-v2';
const only = process.argv[2];
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });

const chat = [
  { role: 'user', text: 'Make the circle pop in after the square, with a little overshoot' },
  { role: 'tool', text: '', tool: { id: 't1', name: 'get_animation', input: { layers: ['Circle'] }, result: 'Circle: position, scale, rotation, opacity keyed 0.30s–1.10s' } },
  { role: 'tool', text: '', tool: { id: 't2', name: 'animate', input: { layer: 'Circle', scale: [[0.4, 0], [0.9, 103]], ease: 'overshoot' } } },
  { role: 'assistant', text: 'Done. The circle now scales from 0 to 103% between 0.40s and 0.90s with a snappy overshoot, so it lands just after the square settles. Hold the review card to compare with the previous version.' },
];

async function open(theme, ui) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
  const page = await ctx.newPage();
  await page.addInitScript(([ui, theme]) => {
    try {
      localStorage.setItem('motion.welcomed', '1');
      localStorage.setItem('motion.ui', JSON.stringify(ui));
      localStorage.setItem('motion.theme', theme);
    } catch { /* */ }
  }, [ui, theme]);
  await page.goto(`${URL}?nobridge&demo&theme=${theme}`);
  await page.waitForFunction(() => window.editor?.renderer && window.timeline);
  await page.waitForTimeout(400);
  return { ctx, page };
}

const shots = {
  // a layer with keys selected: its property rows open in the timeline, the inspector shows them
  async main(page) {
    await page.evaluate(() => {
      const s = editor.store;
      const id = Object.values(s.project.layers).find(l => l.name === 'Circle').id;
      s.select([id]); s.setTime(0.9); timeline.expand(id, true);
    });
  },
  // a key segment selected: the ease studio leads the inspector
  async ease(page) {
    await page.evaluate(() => {
      const s = editor.store;
      const id = Object.values(s.project.layers).find(l => l.name === 'Circle').id;
      s.select([id]); s.setTime(0.9); timeline.expand(id, true);
      s.keySelection = new Set([id + '|position|0', id + '|position|1']); s.emit('keys');
    });
  },
  async nothing(page) {
    await page.evaluate(() => { editor.store.select([]); editor.store.setTime(1.2); });
  },
  async agent(page) {
    await page.evaluate(() => {
      const s = editor.store;
      const id = Object.values(s.project.layers).find(l => l.name === 'Circle').id;
      s.select([id]); s.setTime(0.6);
    });
  },
  async settings(page) {
    await page.keyboard.press('Control+,');
  },
};

for (const theme of ['dark', 'light']) {
  for (const [name, fn] of Object.entries(shots)) {
    if (only && only !== name) continue;
    const leftOpen = name !== 'nothing';
    const { ctx, page } = await open(theme, { leftOpen, leftTab: 'agent', section: 'appearance' });
    if (name === 'agent') {
      // seed a conversation for this project (keyed by its first comp id), keep the project in
      // the autosave and reload from it (a fresh demo would get new ids)
      await page.evaluate(async msgs => {
        const { serialize } = await import('/src/app/actions.ts');
        localStorage.setItem('motion.autosave', serialize());
        const key = Object.keys(editor.store.project.comps)[0];
        localStorage.setItem('motion.agent.chat:' + key, JSON.stringify({ v: 1, msgs, sessions: {}, savedAt: Date.now() }));
      }, chat);
      await page.goto(`${URL}?nobridge&theme=${theme}`);
      await page.waitForFunction(() => window.editor?.renderer && window.timeline);
      await page.waitForTimeout(400);
    }
    await fn(page);
    await page.mouse.move(700, 300);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${name}-${theme}.png` });
    console.log('wrote', `${OUT}/${name}-${theme}.png`);
    await ctx.close();
  }
}
await browser.close();
