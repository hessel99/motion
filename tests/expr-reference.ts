// reference tree interpreter: the evaluator that src/core/expr.ts used before expressions were
// compiled to closures. kept only for tests, which check that the compiled evaluator agrees with it.
import { ExprError, noise1, parseExpr, type ExprContext, type Val } from '../src/core/expr';

type Node = ReturnType<typeof parseExpr>;

const map2 = (a: Val, b: Val, f: (x: number, y: number) => number): Val => {
  if (typeof a === 'number' && typeof b === 'number') return f(a, b);
  if (typeof a === 'number') return (b as number[]).map(y => f(a, y));
  if (typeof b === 'number') return a.map(x => f(x, b));
  const n = Math.max(a.length, b.length);
  return Array.from({ length: n }, (_, k) => f(a[k] ?? 0, b[k] ?? 0));
};
const map1 = (a: Val, f: (x: number) => number): Val => (typeof a === 'number' ? f(a) : a.map(f));
const num = (v: Val): number => (typeof v === 'number' ? v : v[0] ?? 0);
function lerpV(a: Val, b: Val, p: number): Val { return map2(a, b, (x, y) => x + (y - x) * p); }

const M1: Record<string, (x: number) => number> = Object.assign(Object.create(null), { sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, sqrt: Math.sqrt, exp: Math.exp, log: Math.log, degreesToRadians: (x: number) => x * Math.PI / 180, radiansToDegrees: (x: number) => x * 180 / Math.PI });

export function refEvalExpr(node: Node, ctx: ExprContext): Val {
  ctx.calls = 0;
  const ev = (n: Node): Val => {
    switch (n.t) {
      case 'num': return n.v;
      case 'str': throw new ExprError('strings are only allowed as loop arguments');
      case 'arr': return n.items.map(x => num(ev(x)));
      case 'var':
        switch (n.name) {
          case 'time': return ctx.time;
          case 'value': return ctx.value;
          case 'index': return ctx.index;
          case 'fps': case 'frameRate': return ctx.fps;
          case 'duration': return ctx.duration;
          case 'inPoint': return ctx.inPoint;
          case 'PI': return Math.PI;
          case 'E': return Math.E;
          case 'true': return 1;
          case 'false': return 0;
        }
        throw new ExprError(`unknown name "${n.name}"`);
      case 'un': {
        const a = ev(n.a);
        return n.op === '-' ? map1(a, x => -x) : n.op === '!' ? (num(a) ? 0 : 1) : a;
      }
      case 'index': { const a = ev(n.a); const i = Math.floor(num(ev(n.i))); return typeof a === 'number' ? a : a[i] ?? 0; }
      case 'cond': return num(ev(n.c)) ? ev(n.a) : ev(n.b);
      case 'bin': {
        if (n.op === '&&') return num(ev(n.a)) && num(ev(n.b)) ? 1 : 0;
        if (n.op === '||') return num(ev(n.a)) || num(ev(n.b)) ? 1 : 0;
        const a = ev(n.a), b = ev(n.b);
        switch (n.op) {
          case '+': return map2(a, b, (x, y) => x + y);
          case '-': return map2(a, b, (x, y) => x - y);
          case '*': return map2(a, b, (x, y) => x * y);
          case '/': return map2(a, b, (x, y) => (y === 0 ? 0 : x / y));
          case '%': return map2(a, b, (x, y) => (y === 0 ? 0 : x % y));
          case '^': return map2(a, b, (x, y) => Math.pow(x, y));
          case '<': return num(a) < num(b) ? 1 : 0;
          case '>': return num(a) > num(b) ? 1 : 0;
          case '<=': return num(a) <= num(b) ? 1 : 0;
          case '>=': return num(a) >= num(b) ? 1 : 0;
          case '==': return num(a) === num(b) ? 1 : 0;
          case '!=': return num(a) !== num(b) ? 1 : 0;
        }
        throw new ExprError(`bad operator ${n.op}`);
      }
      case 'call': return call(n.name, n.args);
    }
  };
  const call = (name: string, args: Node[]): Val => {
    const A = () => args.map(ev);
    if (M1[name]) return map1(ev(args[0]), M1[name]);
    switch (name) {
      case 'min': { const a = A(); return a.reduce((p, c) => map2(p, c, Math.min)); }
      case 'max': { const a = A(); return a.reduce((p, c) => map2(p, c, Math.max)); }
      case 'pow': { const [a, b] = A(); return map2(a, b, Math.pow); }
      case 'atan2': { const [a, b] = A(); return Math.atan2(num(a), num(b)); }
      case 'mod': { const [a, b] = A(); return map2(a, b, (x, y) => ((x % y) + y) % y); }
      case 'clamp': { const [v, lo, hi] = A(); return map2(map2(v, lo, Math.max), hi, Math.min); }
      case 'length': { const v = ev(args[0]); return typeof v === 'number' ? Math.abs(v) : Math.hypot(...v); }
      case 'normalize': { const v = ev(args[0]); if (typeof v === 'number') return Math.sign(v); const l = Math.hypot(...v) || 1; return v.map(x => x / l); }
      case 'linear': case 'ease': case 'easeIn': case 'easeOut': {
        const a = A();
        let t: number, t0 = 0, t1 = 1, v0: Val, v1: Val;
        if (a.length === 3) { t = num(a[0]); v0 = a[1]; v1 = a[2]; } else if (a.length === 5) { t = num(a[0]); t0 = num(a[1]); t1 = num(a[2]); v0 = a[3]; v1 = a[4]; } else throw new ExprError(`${name}(t, [tMin, tMax,] v1, v2)`);
        let p = t1 === t0 ? (t >= t1 ? 1 : 0) : Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
        if (name === 'ease') p = p * p * (3 - 2 * p);
        else if (name === 'easeIn') p = p * p;
        else if (name === 'easeOut') p = 1 - (1 - p) * (1 - p);
        return lerpV(v0, v1, p);
      }
      case 'random': {
        const a = A();
        const callN = ctx.calls = (ctx.calls ?? 0) + 1;
        const frame = Math.floor(ctx.time * ctx.fps + 1e-6);
        const r = ((Math.sin(ctx.seed * 12.9898 + callN * 78.233 + frame * 37.719) * 43758.5453) % 1 + 1) % 1;
        if (!a.length) return r;
        if (a.length === 1) return map1(a[0], m => m * r);
        return map2(a[0], a[1], (lo, hi) => lo + (hi - lo) * r);
      }
      case 'noise': return map1(ev(args[0]), x => noise1(x, ctx.seed));
      case 'wiggle': {
        const a = A();
        const freq = num(a[0] ?? 1), amp = a[1] ?? 10, oct = Math.max(1, Math.min(6, Math.round(num(a[2] ?? 1))));
        const base = ctx.value;
        const dims = typeof base === 'number' ? 1 : base.length;
        const off = Array.from({ length: dims }, (_, d) => {
          let s = 0, ampk = 1, fk = 1, norm = 0;
          for (let o = 0; o < oct; o++) { s += noise1(ctx.time * freq * fk, ctx.seed + d * 17.3 + o * 3.1) * ampk; norm += ampk; ampk *= 0.5; fk *= 2; }
          return s / norm;
        });
        return typeof base === 'number' ? base + off[0] * num(amp) : base.map((v, d) => v + off[d] * (typeof amp === 'number' ? amp : amp[d] ?? 0));
      }
      case 'loopOut': case 'loopIn': {
        const type = args[0]?.t === 'str' ? args[0].v : 'cycle';
        const k = ctx.keyTimes;
        if (k.length < 2) return ctx.value;
        const t0 = k[0], t1 = k[k.length - 1], span = t1 - t0;
        const t = ctx.time;
        if (name === 'loopOut' ? t <= t1 : t >= t0) return ctx.value;
        if (type === 'continue') {
          const edge = name === 'loopOut' ? t1 : t0, h = 1 / ctx.fps;
          const v = ctx.valueAt(edge), vp = ctx.valueAt(name === 'loopOut' ? edge - h : edge + h);
          const vel = map2(v, vp, (x, y) => (name === 'loopOut' ? (x - y) : (y - x)) / h);
          return map2(v, vel, (x, s) => x + s * (t - edge));
        }
        const cycles = Math.floor((name === 'loopOut' ? t - t0 : t1 - t) / span);
        let lt = name === 'loopOut' ? t0 + ((t - t0) % span) : t1 - ((t1 - t) % span);
        if (type === 'pingpong' && cycles % 2 === 1) lt = t0 + t1 - lt;
        const v = ctx.valueAt(lt);
        if (type === 'offset') {
          const delta = map2(ctx.valueAt(t1), ctx.valueAt(t0), (x, y) => x - y);
          return map2(v, delta, (x, d) => x + d * (name === 'loopOut' ? cycles : -cycles));
        }
        return v;
      }
      case 'valueAtTime': return ctx.valueAt(num(ev(args[0])));
    }
    throw new ExprError(`unknown function "${name}"`);
  };
  return ev(node);
}
