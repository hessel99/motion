// the compiled evaluator (closures, preallocated buffers) must agree exactly with the reference
// tree interpreter: same values and shapes, same errors, same random() call counts.
import { describe, it, expect } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';
import { parseExpr, evalExpr, compileProgram, runProgram, type ExprContext, type ExprFrame, type Val } from '../src/core/expr';
import { refEvalExpr } from './expr-reference';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const VARS = ['time', 'value', 'value', 'index', 'fps', 'frameRate', 'duration', 'inPoint', 'PI', 'E', 'true', 'false', 'thisLayer.time', 'nope'];
const FUNCS = ['sin', 'cos', 'abs', 'floor', 'round', 'sqrt', 'log', 'degreesToRadians', 'min', 'max', 'pow', 'atan2', 'mod', 'clamp', 'length', 'normalize',
  'linear', 'ease', 'easeIn', 'easeOut', 'random', 'random', 'noise', 'wiggle', 'wiggle', 'loopOut', 'loopIn', 'valueAtTime', 'Math.max', 'bogus', 'constructor'];
const LOOPS = ["'cycle'", "'pingpong'", "'offset'", "'continue'", "'weird'", '"pingpong"', '1', ''];
const BIN = ['+', '-', '*', '/', '%', '^', '<', '>', '<=', '>=', '==', '!=', '&&', '||'];

function genExpr(r: () => number, depth: number): string {
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const leaf = () => {
    const x = r();
    if (x < 0.35) return pick(['0', '1', '2', '0.5', '3.25', '10', '100', '1e2', '360', '-1']);
    if (x < 0.85) return pick(VARS);
    if (x < 0.9) return "'str'";
    return `[${Array.from({ length: Math.floor(r() * 4) }, () => pick(['1', 'time', 'value', '2', '-3'])).join(', ')}]`;
  };
  if (depth <= 0) return leaf();
  const sub = () => genExpr(r, depth - 1 - Math.floor(r() * 2));
  const x = r();
  if (x < 0.15) return leaf();
  if (x < 0.4) return `(${sub()} ${pick(BIN)} ${sub()})`;
  if (x < 0.47) return `${pick(['-', '+', '!'])}${sub()}`;
  if (x < 0.55) return `(${sub()} ? ${sub()} : ${sub()})`;
  if (x < 0.62) return `[${Array.from({ length: Math.floor(r() * 5) }, sub).join(', ')}]`;
  if (x < 0.67) return `(${sub()})[${pick(['0', '1', '2', '5', '-1', 'time', sub()])}]`;
  const f = pick(FUNCS);
  if (f === 'loopOut' || f === 'loopIn') return `${f}(${pick(LOOPS)})`;
  const nArgs = f === 'linear' || f === 'ease' || f === 'easeIn' || f === 'easeOut' ? pick([3, 5, 5, 3, 2, 4]) : Math.floor(r() * (r() < 0.8 ? 4 : 7));
  return `${f}(${Array.from({ length: nArgs }, sub).join(', ')})`;
}

const valueAtFor = (shape: number) => (t: number): Val => {
  const f = (d: number) => Math.round((10 * t + d * 3 + Math.sin(t * (d + 1)) * 7) * 1e6) / 1e6;
  return shape < 0 ? f(0) : Array.from({ length: shape }, (_, d) => f(d));
};

function makeCtx(r: () => number): ExprContext {
  const shape = [-1, -1, 2, 2, 2, 1, 3, 4, 0][Math.floor(r() * 9)];
  const va = valueAtFor(shape);
  const keyTimes = [[], [1], [0, 2], [0.5, 1, 3], [1, 1], [-1, 0.25]][Math.floor(r() * 6)];
  const fps = [24, 30, 60, 25][Math.floor(r() * 4)];
  const time = r() < 0.3 ? Math.floor(r() * 200) / fps : (r() - 0.2) * 12;
  return { time, value: va(time * 0.5 + 0.1), index: Math.floor(r() * 50), fps, duration: 5 + Math.floor(r() * 5), inPoint: r() < 0.5 ? 0 : 0.5, seed: Math.floor(r() * 9973), valueAt: va, keyTimes };
}

type Out = { ok: true; v: Val; calls: number } | { ok: false };
const attempt = (f: (c: ExprContext) => Val, c: ExprContext): Out => {
  try { const v = f(c); return { ok: true, v, calls: c.calls ?? 0 }; } catch { return { ok: false }; }
};
const same = (a: Val, b: Val) => {
  if (typeof a === 'number' || typeof b === 'number') return typeof a === typeof b && Object.is(a, b);
  return a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
};

describe('compiled expressions match the reference interpreter', () => {
  it('on thousands of random expressions, contexts and times', () => {
    const r = rng(12345);
    let compared = 0, errors = 0;
    for (let n = 0; n < 4000; n++) {
      const src = genExpr(r, 1 + Math.floor(r() * 4));
      let node;
      try { node = parseExpr(src); } catch { continue; }
      for (let j = 0; j < 4; j++) {
        const c = makeCtx(r);
        const a = attempt(x => refEvalExpr(node, x), { ...c });
        const b = attempt(x => evalExpr(node, x), { ...c });
        if (a.ok !== b.ok || (a.ok && b.ok && (!same(a.v, b.v) || a.calls !== b.calls))) {
          throw new Error(`mismatch for ${src} at ${JSON.stringify({ ...c, valueAt: undefined })}: ref ${JSON.stringify(a)} compiled ${JSON.stringify(b)}`);
        }
        compared++;
        if (!a.ok) errors++;
      }
    }
    expect(compared).toBeGreaterThan(10000);
    expect(errors).toBeGreaterThan(500); // errors were exercised too ...
    expect(compared - errors).toBeGreaterThan(5000); // ... but most runs produce values
  });

  const fixed = [
    'wiggle(2, 30)', 'wiggle(3, [10, 40], 3)', 'wiggle(time, 20, 7)', 'wiggle(2, 20, 0)', 'wiggle()', 'wiggle(1, [5])', 'wiggle(1, [])', 'wiggle(2, 10, 2, random())',
    'random()', 'random(10)', 'random(1, 5)', 'random([1, 2], [10, 20])', 'random(value)', 'random(random(5), random(3))', '[random(), random(), random()]',
    'noise(time)', 'noise([time, time * 2])', 'value + noise(time * 3) * 10',
    "loopOut('cycle')", "loopOut('pingpong')", "loopOut('offset')", "loopOut('continue')", "loopIn('cycle')", "loopIn('pingpong')", "loopIn('offset')", "loopIn('continue')", 'loopOut()', 'loopOut(5)',
    'valueAtTime(time - 0.5)', 'valueAtTime(0) + valueAtTime(1)', 'value - valueAtTime(time / 2)',
    'value + [sin(time * 3 + index) * 20, cos(time * 2 + index) * 20]', 'clamp(50 + 50 * sin(time * 2 + index * 0.1), 10, 100)', 'time * 90',
    'length(value)', 'normalize(value)', 'normalize([3, 4]) * 10', 'length([1, 2, 3, 4, 5, 6])', 'normalize([0, 0])', 'length()',
    'linear(time, 0, 2, value, value * 2)', 'ease(time, [0, 0], [100, 50])', 'easeIn(time, 1, 1, 0, 10)', 'easeOut(time, 0, 4, [0], [10, 20, 30])', 'linear(time, 1)',
    'min(value, [50, 60])', 'max(1, value, 3)', 'min()', 'max([1, 2, 3])', 'pow(value, 2)', 'pow(2)', 'mod(-time, 1)', 'mod(value, [7, 0])', 'atan2(1, time)', 'atan2(1)', 'clamp(value, 0)',
    'value / 0', 'value % [0, 3]', '[1, 2] + [1, 2, 3]', '[] + value', '[value, value][1]', 'value[time]', 'time[0]', '(time > 1 ? value : 5) * 2', 'time > 1 ? [1, 2] : [1, 2, 3]',
    'time > 1 ? nope : value', "'str' + 1", 'sin()', 'bogus(nope)', 'nope', '!value', '-value', '+value', '0 && nope', '1 || nope', 'time > 2 && value', '1 ? 2 : nope',
  ];
  const ctxs = (r: () => number) => [makeCtx(r), makeCtx(r), makeCtx(r), makeCtx(r), makeCtx(r), makeCtx(r)];
  it('on a fixed list: wiggle/noise/random, loops, valueAtTime, vector math, errors', () => {
    const r = rng(99);
    for (const src of fixed) {
      const node = parseExpr(src);
      for (const c0 of ctxs(r)) for (const kt of [c0.keyTimes, [0, 2], [0.5, 1, 3]]) for (const time of [c0.time, -1.3, 0, 0.75, 2, 2.5, 4.1, 7.9, 13.37]) {
        const c = { ...c0, keyTimes: kt, time };
        const a = attempt(x => refEvalExpr(node, x), { ...c });
        const b = attempt(x => evalExpr(node, x), { ...c });
        expect(b.ok, src).toBe(a.ok);
        if (a.ok && b.ok) {
          expect(same(a.v, b.v), `${src} @${time}: ${JSON.stringify(a.v)} vs ${JSON.stringify(b.v)}`).toBe(true);
          expect(b.calls).toBe(a.calls);
        }
      }
    }
  });

  it('random and wiggle are deterministic within a frame and change between frames', () => {
    const c = (time: number, seed = 7): ExprContext => ({ time, value: [100, 50], index: 1, fps: 30, duration: 5, inPoint: 0, seed, valueAt: () => [0, 0], keyTimes: [] });
    const n = parseExpr('[random(100), random(100)]');
    const a = evalExpr(n, c(1.01)) as number[], b = evalExpr(n, c(1.02)) as number[], d = evalExpr(n, c(1.1)) as number[];
    expect(a).toEqual(b); // same frame (30 fps): random re-rolls per frame, not per sub-frame time
    expect(a[0]).not.toBe(a[1]); // each call its own number
    expect(d[0]).not.toBe(a[0]);
    expect(evalExpr(n, c(1.01, 8))).not.toEqual(a); // per layer seed
    // wiggle is a smooth function of time: the same time (and seed) gives the same value, every run
    const w = parseExpr('wiggle(2, 30)');
    expect(evalExpr(w, c(1.37))).toEqual(evalExpr(w, c(1.37)));
    expect(evalExpr(w, c(1.37))).not.toEqual(evalExpr(w, c(1.37, 8)));
  });

  it('runProgram writes finite numbers into the output buffer and keeps the value on errors', () => {
    // value(t) = [10 t, 20 t]: runProgram fetches the current value itself when it needs it
    const fr: ExprFrame = { time: 1, index: 0, fps: 30, duration: 5, inPoint: 0, seed: 3, keyTimes: [0, 2], value: new Float64Array(4), valueAt: (t, o) => { o[0] = 10 * t; o[1] = 20 * t; }, calls: 0 };
    const out = new Float64Array(6);
    runProgram(compileProgram(parseExpr('value + [1, 2]'), 2), fr, out, 2);
    expect(Array.from(out)).toEqual([0, 0, 11, 22, 0, 0]);
    fr.value.fill(0);
    runProgram(compileProgram(parseExpr('[time, 2]'), 2), fr, out, 0); // value not needed: not fetched
    expect(Array.from(fr.value)).toEqual([0, 0, 0, 0]);
    runProgram(compileProgram(parseExpr('nope'), 2), fr, out, 0);
    expect(Array.from(out.subarray(0, 2))).toEqual([10, 20]);
    runProgram(compileProgram(parseExpr('[5]'), 2), fr, out, 0); // missing components come from value
    expect(Array.from(out.subarray(0, 2))).toEqual([5, 20]);
    runProgram(compileProgram(parseExpr('[1 / 0 * 0 + log(-1), 3]'), 2), fr, out, 0);
    expect(Array.from(out.subarray(0, 2))).toEqual([0, 3]);
    runProgram(compileProgram(parseExpr('value * 2'), 1), fr, out, 0); // scalar property
    expect(out[0]).toBe(20);
    runProgram(compileProgram(parseExpr("loopOut('offset')"), 2), { ...fr, time: 3 }, out, 0);
    expect(Array.from(out.subarray(0, 2))).toEqual([30, 60]); // value(1) + (value(2) - value(0)) * 1
  });

  it('a compiled frame allocates nothing (heap stays flat over many runs)', () => {
    const srcs = ['wiggle(2.5, 30)', "loopOut('pingpong')", 'value + [sin(time * 3 + index) * 20, cos(time * 2 + index) * 20]', 'clamp(50 + 50 * sin(time * 2 + index * 0.1), 10, 100)', 'random([1, 2], [10, 20]) + normalize(value) * length(value)'];
    const progs = srcs.map(s => compileProgram(parseExpr(s), 2));
    const fr: ExprFrame = { time: 0, index: 3, fps: 30, duration: 5, inPoint: 0, seed: 11, keyTimes: [0, 1, 2], value: new Float64Array([1, 2, 0, 0]), valueAt: (t, o) => { o[0] = t; o[1] = 2 * t; }, calls: 0 };
    const out = new Float64Array(2);
    const run = (n: number) => { for (let i = 0; i < n; i++) { fr.time = i / 30; for (const p of progs) runProgram(p, fr, out, 0); } };
    run(20000);
    v8.setFlagsFromString('--expose-gc');
    const g = vm.runInNewContext('gc') as () => void;
    // best of 3: under a loaded machine the JIT may not have tiered up yet on the first attempt
    let best = Infinity;
    for (let k = 0; k < 3 && best >= 4 << 20; k++) {
      g(); const before = process.memoryUsage().heapUsed;
      run(200000); // 1M program runs
      best = Math.min(best, process.memoryUsage().heapUsed - before);
    }
    // the old renderer path allocated hundreds of bytes per run (context closure, arrays, vector
    // temporaries). what can remain is a boxed time argument where a valueAt call is not inlined
    expect(best).toBeLessThan(4 << 20);
  });
});
