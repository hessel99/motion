// Calibrate the motion critic (src/agent/critic.ts) against the eval judge: runs the critic over saved
// eval documents (evals/results/<dir>/<brief>/document.json) and correlates its score with judge.json.
//
//   npx vite-node scripts/critic-calibrate.ts evals/results/2026-11-12 [more dirs] [--fit] [--json out.json] [--verbose]
//
// --fit: grid-searches the category weights (CAT_WEIGHTS) for the best leave-one-out correlation and
// prints them (copy into critic.ts by hand: weights stay reviewed code, not a hidden file).
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/core/store';
import { critique, scoreOf, CATEGORIES, CAT_WEIGHTS, type Category } from '../src/agent/critic';

const args = process.argv.slice(2);
const dirs = args.filter(a => !a.startsWith('--') && fs.existsSync(a) && fs.statSync(a).isDirectory());
const flag = (n: string) => args.includes('--' + n);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

interface Row { name: string; dir: string; judge: number; judgeSub: Record<string, number>; score: number; sub: Record<Category, number>; pen: Record<Category, number>; ms: number; issues: string[] }
const rows: Row[] = [];
for (const dir of dirs) {
  for (const d of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, d);
    if (!fs.existsSync(path.join(p, 'document.json')) || !fs.existsSync(path.join(p, 'judge.json'))) continue;
    const doc = JSON.parse(fs.readFileSync(path.join(p, 'document.json'), 'utf8'));
    const judge = JSON.parse(fs.readFileSync(path.join(p, 'judge.json'), 'utf8'));
    const probe = fs.existsSync(path.join(p, 'probe.json')) ? JSON.parse(fs.readFileSync(path.join(p, 'probe.json'), 'utf8')) : {};
    const fonts: Record<string, boolean> = probe.fonts ?? {};
    const store = new Store(doc);
    const c = critique(store, { fontOk: f => fonts[f.replace(/^["']|["']$/g, '')] ?? /^(inter|serif|sans-serif|monospace|system-ui)$/i.test(f), max: 40 });
    rows.push({ name: d, dir, judge: judge.overall, judgeSub: judge.scores, score: c.score, sub: c.sub, pen: c.penalties, ms: c.stats.ms, issues: c.issues.map(i => `${i.severity[0]}:${i.rule}`) });
  }
}
if (!rows.length) { console.error('no runs with document.json + judge.json in', dirs); process.exit(1); }

function pearson(a: number[], b: number[]) {
  const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}
const rank = (a: number[]) => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); let i = 0; while (i < s.length) { let j = i; while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j++; for (let k = i; k <= j; k++) r[s[k][1]] = (i + j) / 2; i = j + 1; } return r; };
const spearman = (a: number[], b: number[]) => pearson(rank(a), rank(b));
const scoreWith = (w: Record<Category, number>, r: Row) => scoreOf(r.pen, true, w);

const J = rows.map(r => r.judge);
const C = rows.map(r => r.score);
console.log('run'.padEnd(34), 'judge', 'critic', 'ms   ', 'issues');
for (const r of rows) console.log(`${path.basename(r.dir)}/${r.name}`.slice(-34).padEnd(34), String(r.judge).padEnd(5), String(r.score).padEnd(6), String(r.ms).padEnd(5), flag('verbose') ? r.issues.join(' ') : r.issues.slice(0, 6).join(' '));
console.log(`\n${rows.length} runs: pearson r = ${pearson(C, J).toFixed(3)}, spearman ρ = ${spearman(C, J).toFixed(3)}, critic mean ${(C.reduce((a, b) => a + b, 0) / C.length).toFixed(1)}, max ms ${Math.max(...rows.map(r => r.ms))}`);
for (const c of CATEGORIES) { const v = rows.map(r => r.sub[c]); if (new Set(v).size > 1) console.log(`  ${c.padEnd(13)} r(judge overall) ${pearson(v, J).toFixed(2)}`); }

if (flag('fit')) {
  // coordinate search over category weights 0..2 (step 0.2), objective = mean of in-sample and leave-one-out pearson
  const w = { ...CAT_WEIGHTS };
  const obj = (ww: Record<Category, number>) => pearson(rows.map(r => scoreWith(ww, r)), J);
  let best = obj(w);
  for (let pass = 0; pass < 4; pass++) for (const c of CATEGORIES) for (let v = 0; v <= 2.001; v += 0.2) {
    const t = { ...w, [c]: Math.round(v * 10) / 10 };
    const o = obj(t);
    if (o > best + 1e-4) { best = o; Object.assign(w, t); }
  }
  // leave-one-out: fit on n-1, predict the held-out one
  const loo: number[] = [];
  for (let k = 0; k < rows.length; k++) {
    const train = rows.filter((_, i) => i !== k), Jt = train.map(r => r.judge);
    const ww = { ...CAT_WEIGHTS };
    let b = pearson(train.map(r => scoreWith(ww, r)), Jt);
    for (let pass = 0; pass < 3; pass++) for (const c of CATEGORIES) for (let v = 0; v <= 2.001; v += 0.2) {
      const t = { ...ww, [c]: Math.round(v * 10) / 10 }; const o = pearson(train.map(r => scoreWith(t, r)), Jt); if (o > b + 1e-4) { b = o; Object.assign(ww, t); }
    }
    loo.push(scoreWith(ww, rows[k]));
  }
  console.log(`\nfit: pearson ${best.toFixed(3)} with`, JSON.stringify(w));
  console.log(`leave-one-out pearson ${pearson(loo, J).toFixed(3)}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ n: rows.length, pearson: pearson(C, J), spearman: spearman(C, J), rows }, null, 1));
