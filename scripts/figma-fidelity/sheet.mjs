// contact sheets of a fidelity report: rows of truth | motion | diff (1x, half size) per case,
// worst first, one png per group. for skimming many cases at once.
// usage: node scripts/figma-fidelity/sheet.mjs [--report bench/results/figma-fidelity] [--group text] [--max 12] [--scale 0.5]
import { chromium } from '../pw.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const DIR = resolve(opt('report', 'bench/results/figma-fidelity'));
const GROUP = opt('group', '');
const MAX = +opt('max', 12), SC = +opt('scale', 0.5);
const rep = JSON.parse(readFileSync(join(DIR, 'report.json'), 'utf8'));
const groups = new Map();
for (const r of rep.results) {
  const g = r.suite === 'figma' ? r.name.split('/')[0] : r.suite;
  if (GROUP && g !== GROUP && !r.name.includes(GROUP)) continue;
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(r);
}
const uri = p => { try { return 'data:image/png;base64,' + readFileSync(join(DIR, p)).toString('base64'); } catch { return ''; } };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 400 } });
mkdirSync(join(DIR, 'sheets'), { recursive: true });
for (const [g, list] of groups) {
  for (let k = 0; k < list.length; k += MAX) {
    const part = list.slice(k, k + MAX);
    const rows = part.map(r => {
      const e = r.scales?.['1'] ?? Object.values(r.scales ?? {})[0] ?? {};
      const im = p => p ? `<img src="${uri(p)}" style="width:${400 * SC}px">` : `<div style="width:${400 * SC}px"></div>`;
      return `<div class="r"><div class="l"><b>${r.name}</b><br>${r.score ?? '–'} · ssim ${e.ssim ?? '–'} · bad ${e.badPct ?? '–'}%${r.error ? '<br><i>' + r.error + '</i>' : ''}</div>${im(e.truth)}${im(e.ours)}${im(e.diff)}</div>`;
    }).join('');
    await page.setContent(`<style>body{margin:0;font:11px sans-serif;background:#ddd}.r{display:flex;gap:4px;align-items:flex-start;margin:3px}.l{width:150px}img{background:#fff}</style>${rows}`);
    const file = join(DIR, 'sheets', `${g.replace(/[^a-z0-9-]/gi, '_')}-${k / MAX}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(file);
  }
}
await browser.close();
