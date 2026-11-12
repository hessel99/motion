// markdown tables for docs/export-parity.md from the parity harness results:
//   node scripts/export-parity-table.mjs [after.json] [before.json]
// per path: scenes passing, worst mean error, worst flat-colour error; then per scene x path.
import { readFileSync } from 'node:fs';
const [, , afterF = 'bench/results/export-parity/results-full.json', beforeF = 'bench/results/export-parity/before-full.json'] = process.argv;
const load = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const A = load(afterF), B = load(beforeF);
const paths = [...new Set([...(B?.results ?? []), ...A.results].map(r => r.path))];
const stat = (j, p) => {
  if (!j) return null;
  const rs = j.results.filter(r => r.path === p);
  if (!rs.length) return null;
  const ok = rs.filter(r => r.ok).length;
  const mean = Math.max(...rs.map(r => r.worst?.mean ?? 0));
  const col = Math.max(...rs.map(r => r.worst?.colour ?? 0));
  return { ok, n: rs.length, mean, col };
};
const f = (s, k) => (s ? (k === 'pass' ? `${s.ok}/${s.n}` : s[k] ? s[k].toFixed(2) : '–') : 'n/a');
console.log('| path | before: pass | before: worst mean | after: pass | after: worst mean | after: worst flat colour |');
console.log('|---|---|---|---|---|---|');
for (const p of paths) { const b = stat(B, p), a = stat(A, p); console.log(`| ${p} | ${f(b, 'pass')} | ${f(b, 'mean')} | ${f(a, 'pass')} | ${f(a, 'mean')} | ${f(a, 'col')} |`); }
console.log('\nAfter, per scene (worst frame mean error; ✗ = fails a tolerance):\n');
const scenes = [...new Set(A.results.map(r => r.scene))];
const ps = paths.filter(p => A.results.some(r => r.path === p));
console.log(`| scene | ${ps.join(' | ')} |`);
console.log(`|---|${ps.map(() => '---').join('|')}|`);
for (const s of scenes) {
  console.log(`| ${s} | ${ps.map(p => { const r = A.results.find(x => x.scene === s && x.path === p); return r ? `${r.worst ? r.worst.mean.toFixed(2) : '–'}${r.ok ? '' : ' ✗'}` : ''; }).join(' | ')} |`);
}
