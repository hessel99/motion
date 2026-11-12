// Compare two agent-eval result dirs (summary.json from scripts/agent-eval.mjs): per-brief deltas B − A.
//   node scripts/agent-eval-compare.mjs evals/results/2026-11-12 evals/results/2026-11-20 [--threshold 1]
// Regressions (judge overall down by ≥ threshold, new tool errors, fewer checklist hits) are flagged with ▼.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const [A, B] = argv.filter((a) => !a.startsWith('--'));
const ti = argv.indexOf('--threshold');
const threshold = ti >= 0 ? +argv[ti + 1] : 1;
if (!A || !B) { console.error('usage: node scripts/agent-eval-compare.mjs <resultsA> <resultsB> [--threshold 1]'); process.exit(1); }
const load = (d) => {
  const f = fs.existsSync(path.join(d, 'summary.json')) ? path.join(d, 'summary.json') : d;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};
const a = load(A), b = load(B);
// runs of the same brief (repeats) are averaged
const group = (rows) => {
  const g = {};
  for (const r of rows) (g[r.id] ??= []).push(r);
  return Object.fromEntries(Object.entries(g).map(([id, rs]) => {
    const avg = (f) => { const v = rs.map(f).filter((x) => typeof x === 'number'); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    return [id, {
      overall: avg((r) => r.judge?.overall), fit: avg((r) => r.judge?.brief_fit), style: avg((r) => r.judge?.style_match), timing: avg((r) => r.judge?.timing_easing),
      checklist: avg((r) => r.checklistHits), checkable: avg((r) => r.checklistCheckable), toolErrors: avg((r) => r.toolErrors), toolCalls: avg((r) => r.toolCalls),
      turns: avg((r) => r.turns), wallS: avg((r) => r.wallS), cost: avg((r) => r.costUsd), layers: avg((r) => r.layers), n: rs.length,
    }];
  }));
};
const ga = group(a.rows), gb = group(b.rows);
const ids = [...new Set([...Object.keys(ga), ...Object.keys(gb)])].sort();
const f = (x, d = 1) => (x == null ? '–' : (Math.round(x * 10 ** d) / 10 ** d).toString());
const delta = (x, y, d = 1) => (x == null || y == null ? '–' : `${y - x >= 0 ? '+' : ''}${f(y - x, d)}`);
const cols = ['brief', 'overall A→B', 'Δ', 'fit Δ', 'style Δ', 'timing Δ', 'checklist A→B', 'tool err A→B', 'turns Δ', 'time Δ s', 'cost Δ $', ''];
const rows = [];
let reg = 0;
for (const id of ids) {
  const x = ga[id], y = gb[id];
  if (!x || !y) { rows.push([id, x ? 'only in A' : 'only in B', '', '', '', '', '', '', '', '', '', '']); continue; }
  const flags = [];
  if (x.overall != null && y.overall != null && y.overall - x.overall <= -threshold) flags.push('▼ judge');
  if (y.toolErrors > x.toolErrors) flags.push('▼ errors');
  if (y.checklist < x.checklist) flags.push('▼ checklist');
  if (x.overall != null && y.overall != null && y.overall - x.overall >= threshold) flags.push('▲');
  if (flags.some((s) => s.startsWith('▼'))) reg++;
  rows.push([id, `${f(x.overall, 2)} → ${f(y.overall, 2)}`, delta(x.overall, y.overall, 2), delta(x.fit, y.fit), delta(x.style, y.style), delta(x.timing, y.timing),
    `${f(x.checklist)}/${f(x.checkable)} → ${f(y.checklist)}/${f(y.checkable)}`, `${f(x.toolErrors)} → ${f(y.toolErrors)}`, delta(x.turns, y.turns), delta(x.wallS, y.wallS, 0), delta(x.cost, y.cost, 3), flags.join(' ')]);
}
const w = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i]).length)));
const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
console.log(`A: ${A}\nB: ${B}\n`);
console.log(line(cols));
console.log(w.map((n) => '-'.repeat(n)).join('  '));
for (const r of rows) console.log(line(r));
const ta = a.totals, tb = b.totals;
console.log(`\ntotals: judge ${f(ta.judgeOverall, 2)} → ${f(tb.judgeOverall, 2)} (${delta(ta.judgeOverall, tb.judgeOverall, 2)}), checklist ${Math.round(ta.checklistRate * 100)}% → ${Math.round(tb.checklistRate * 100)}%, tool errors ${ta.toolErrors} → ${tb.toolErrors}, mean turns ${f(ta.meanTurns)} → ${f(tb.meanTurns)}, mean time ${f(ta.meanWallS, 0)}s → ${f(tb.meanWallS, 0)}s, cost $${ta.costUsd} → $${tb.costUsd}`);
console.log(reg ? `${reg} brief(s) regressed` : 'no regressions');
process.exitCode = 0;
