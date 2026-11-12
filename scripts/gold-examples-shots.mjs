// Replays every gold example (src/agent/guides/examples/*.md) in the real editor (Playwright + the dev
// server), runs the critic there (real font measurement) and saves a 12-frame contact sheet per example.
//   node scripts/gold-examples-shots.mjs [--url http://localhost:5271/] [--out DIR] [--only name]
// Music examples get the generated 120 BPM track (src/audio/synth-track.ts) first, like the eval briefs.
import { chromium } from './pw.mjs';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const url = opt('url', 'http://localhost:5271/');
const out = path.resolve(opt('out', 'evals/gold'));
const only = opt('only', '');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await page.goto(`${url}?blank&nobridge`);
await page.waitForFunction(() => window.editor?.store && window.editor.renderer);
const names = await page.evaluate(async () => (await import('/src/agent/examples.ts')).EXAMPLES.map((g) => g.name));
const rows = [];
for (const name of names.filter((n) => !only || n.includes(only))) {
  await page.goto(`${url}?blank&nobridge`);
  await page.waitForFunction(() => window.editor?.store && window.editor.renderer);
  const r = await page.evaluate(async (name) => {
    const { EXAMPLES, replayExample } = await import('/src/agent/examples.ts');
    const { TOOLS } = await import('/src/agent/tools.ts');
    const { critique, formatCritique } = await import('/src/agent/critic.ts');
    const g = EXAMPLES.find((x) => x.name === name);
    const st = window.editor.store;
    if (/music|song|bpm/.test(g.summary)) {
      const { synthTrack, TRACKS } = await import('/src/audio/synth-track.ts');
      const { wavDataUrl } = await import('/src/audio/wav.ts');
      const { addAudioLayer } = await import('/src/audio/import.ts');
      const { ensureAnalysis } = await import('/src/audio/analysis-store.ts');
      const tr = synthTrack(TRACKS.music120);
      const l = addAudioLayer('Launch track 120 BPM', wavDataUrl([tr.samples], tr.sr), 'audio/wav', { at: 0 });
      await ensureAnalysis(st.project.assets[l.imageRef]);
      (await import('/src/audio/timing.ts')).refreshAudioEnv(st);
    }
    const run = async (tool, a) => { const c = await TOOLS.find((t) => t.name === tool).run(a); return c[0]?.type === 'text' ? c[0].text : ''; };
    const t0 = performance.now();
    await replayExample(g, run);
    const ms = performance.now() - t0;
    const c = critique(st, { max: 10 });
    const sheet = await TOOLS.find((t) => t.name === 'contact_sheet').run({ frames: 12, start: 0, end: st.comp.duration, cell: 320 });
    return { score: c.score, text: formatCritique(c, { max: 10 }), criticMs: c.stats.ms, buildMs: Math.round(ms), image: sheet.find((x) => x.type === 'image')?.data };
  }, name);
  const file = path.join(out, name.replace(/^examples\//, '') + '.jpg');
  if (r.image) fs.writeFileSync(file, Buffer.from(r.image, 'base64'));
  rows.push({ name, score: r.score, criticMs: r.criticMs });
  console.log(`${name.padEnd(36)} critic ${r.score} (${r.criticMs} ms)  → ${path.relative(process.cwd(), file)}`);
  if (r.score < 85) console.log(r.text.split('\n').map((l) => '   ' + l).join('\n'));
}
fs.writeFileSync(path.join(out, 'scores.json'), JSON.stringify(rows, null, 1));
await browser.close();
