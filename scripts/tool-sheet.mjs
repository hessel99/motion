// Runs a JSON list of agent tool calls ([{tool, args}], "<key>" = the id build_scene returned for that key)
// in the real editor (Playwright + the dev server) and saves a contact sheet of the result, plus the critic.
// For checking a recipe or a gold example draft before it becomes a file:
//   node scripts/tool-sheet.mjs calls.json out.jpg [--url http://localhost:5271/] [--frames 12] [--times 0.5,1,1.5]
import { chromium } from './pw.mjs';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const [callsFile, outFile] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!callsFile || !outFile) { console.error('usage: node scripts/tool-sheet.mjs calls.json out.jpg [--url URL] [--frames N] [--times a,b,c]'); process.exit(1); }
const url = opt('url', 'http://localhost:5271/');
const frames = +opt('frames', 12);
const times = opt('times', '') ? opt('times', '').split(',').map(Number) : undefined;
const calls = JSON.parse(fs.readFileSync(callsFile, 'utf8'));

const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await page.goto(`${url}?blank&nobridge`);
await page.waitForFunction(() => window.editor?.store && window.editor.renderer);
const r = await page.evaluate(async ({ calls, frames, times }) => {
  const { TOOLS } = await import('/src/agent/tools.ts');
  const { resolveKeys } = await import('/src/agent/examples.ts');
  const { critique, formatCritique } = await import('/src/agent/critic.ts');
  const st = window.editor.store;
  const ids = {};
  for (const c of calls) {
    const out = await TOOLS.find((t) => t.name === c.tool).run(resolveKeys(c.args, ids));
    const txt = out[0]?.type === 'text' ? out[0].text : '';
    if (c.tool === 'build_scene') { try { Object.assign(ids, JSON.parse(txt).ids); } catch { /* */ } }
  }
  const c = critique(st, { max: 12 });
  const sheet = await TOOLS.find((t) => t.name === 'contact_sheet').run(times ? { times, cell: 360 } : { frames, start: 0, end: st.comp.duration, cell: 320 });
  return { text: formatCritique(c, { max: 12 }), image: sheet.find((x) => x.type === 'image')?.data };
}, { calls, frames, times });
if (r.image) fs.writeFileSync(outFile, Buffer.from(r.image, 'base64'));
console.log(r.text);
await browser.close();
