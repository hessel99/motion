// micro-benchmark of one frame of the stress lab's expr-3k scene (3,000 layers, 4 expressions each):
// the old path (tree interpreter, per-frame context closure / arrays / seed hash) against the
// compiled programs with cached frames. run: npx vitest bench tests/expr.bench.ts
import { bench, describe } from 'vitest';
import { Track } from '../src/core/evaluate';
import { parseExpr, compileProgram, runProgram, type ExprContext, type ExprFrame, type Val } from '../src/core/expr';
import { refEvalExpr } from './expr-reference';

const N = 3000;
const rot = ["loopOut('pingpong')", "loopOut('cycle')", 'time * 90', "loopOut('offset')"];
const kf = (vs: number[][]) => vs.map((v, i) => ({ t: i, v, interp: 'linear' as const, in: [0, 0] as [number, number], out: [1, 1] as [number, number] }));
type Ex = { node: ReturnType<typeof parseExpr>; dim: number; track: Track; keyTimes: number[]; id: string; k: number };
const layers: Ex[][] = [];
for (let i = 0; i < N; i++) {
  const id = 'layer-' + i;
  const props: [string, number, any][] = [
    [`wiggle(${(1 + (i % 40) / 10).toFixed(1)}, ${10 + (i % 40)})`, 2, { v: [i, i * 2] }],
    [rot[i % 4], 1, { v: [0], kf: kf([[0], [(i % 90) - 45], [i % 30]]) }],
    ['value + [sin(time * 3 + index) * 20, cos(time * 2 + index) * 20]', 2, { v: [100, 100] }],
    ['clamp(50 + 50 * sin(time * 2 + index * 0.1), 10, 100)', 1, { v: [100] }],
  ];
  layers.push(props.map(([src, dim, p], k) => ({ node: parseExpr(src), dim, track: new Track(p, dim), keyTimes: (p.kf ?? []).map((f: { t: number }) => f.t), id, k })));
}
const hashStr = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
const out = new Float64Array(N * 8);

// before: what renderer.evalExprs did per expression per frame
const tmp = new Float64Array(4);
const ctx: ExprContext = { time: 0, value: 0, index: 0, fps: 30, duration: 10, inPoint: 0, valueAt: () => 0, keyTimes: [], seed: 0 };
function frameOld(t: number) {
  for (let i = 0; i < N; i++) for (const e of layers[i]) {
    const dim = e.dim;
    e.track.eval(t, tmp, 0);
    ctx.time = t; ctx.index = i; ctx.keyTimes = e.keyTimes;
    ctx.value = dim === 1 ? tmp[0] : Array.from(tmp.subarray(0, dim));
    ctx.seed = (hashStr(e.id) + e.k * 31) % 9973;
    ctx.valueAt = (tt: number) => { const o = new Float64Array(4); e.track.eval(tt, o, 0); return dim === 1 ? o[0] : Array.from(o.subarray(0, dim)); };
    let v: Val;
    try { v = refEvalExpr(e.node, ctx); } catch { v = ctx.value; }
    for (let d = 0; d < dim; d++) { const x = typeof v === 'number' ? v : v[d] ?? 0; out[i * 8 + e.k * 2 + d] = Number.isFinite(x) ? x : 0; }
  }
}

// after: compiled once, frame objects cached per (layer, property)
const compiled = layers.map(ls => ls.map(e => {
  const fr: ExprFrame = { time: 0, index: 0, fps: 30, duration: 10, inPoint: 0, seed: (hashStr(e.id) + e.k * 31) % 9973, keyTimes: e.keyTimes, value: new Float64Array(4), valueAt: (tt, o) => e.track.eval(tt, o, 0), calls: 0 };
  return { prog: compileProgram(e.node, e.dim), fr, k: e.k };
}));
function frameNew(t: number) {
  for (let i = 0; i < N; i++) {
    const ls = compiled[i];
    for (let j = 0; j < ls.length; j++) {
      const e = ls[j], fr = e.fr;
      fr.time = t; fr.index = i; // runProgram fetches the value through fr.valueAt when needed
      runProgram(e.prog, fr, out, i * 8 + e.k * 2);
    }
  }
}

let f1 = 0, f2 = 0;
describe('expr-3k frame', () => {
  bench('interpreter (before)', () => { frameOld((f1++ % 300) / 30); });
  bench('compiled (after)', () => { frameNew((f2++ % 300) / 30); });
});
