// a small, SAFE expression language for property values (after effects style).
// it is parsed and interpreted here — never passed to eval/Function — so project files
// from anywhere can't run code. supported:
//   numbers, [a, b] vectors, + - * / % ^, unary -, ( ), comparisons (< > <= >= == !=), a ? b : c
//   variables: time, value, index, fps, duration, PI, inPoint
//   math: sin cos tan asin acos atan atan2 abs min max floor ceil round sqrt pow exp log clamp mod
//   motion: linear(t, t0, t1, v0, v1) ease(...) easeIn easeOut, random(seed?), noise(x),
//           wiggle(freq, amp, octaves?), loopOut('cycle'|'pingpong'|'offset'|'continue'), loopIn(...),
//           valueAtTime(t), length(v), normalize(v)
// vectors combine element-wise; a scalar combines with every component.

export type Val = number | number[];

type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'var'; name: string }
  | { t: 'arr'; items: Node[] }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'cond'; c: Node; a: Node; b: Node }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'index'; a: Node; i: Node };

export interface ExprContext {
  time: number;
  value: Val;
  index: number;
  fps: number;
  duration: number;
  inPoint: number;
  /** property value at another time (for loopOut / valueAtTime / wiggle base) */
  valueAt: (t: number) => Val;
  /** keyframe times of this property (for loops) */
  keyTimes: number[];
  /** stable seed for random / wiggle */
  seed: number;
  /** per-evaluation call counter (random) */
  calls?: number;
}

export class ExprError extends Error {}

// ---------------- parser (pratt) ----------------
function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(<=|>=|==|!=|&&|\|\||[-+*/%^()[\],?:<>!.]))/gy;
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    m = re.exec(src);
    if (!m) {
      if (/^\s*;?\s*$/.test(src.slice(pos))) break;
      throw new ExprError(`unexpected "${src.slice(pos, pos + 10).trim()}"`);
    }
    out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
    pos = re.lastIndex;
  }
  return out;
}

const PREC: Record<string, number> = Object.assign(Object.create(null), { '?': 1, '||': 2, '&&': 3, '==': 4, '!=': 4, '<': 5, '>': 5, '<=': 5, '>=': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7, '^': 9 });

export function parseExpr(src: string): Node {
  // allow a trailing statement form like "value + 10;" and AE-style "temp = ...; temp" is not supported
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const expect = (t: string) => { if (toks[i] !== t) throw new ExprError(`expected "${t}"`); i++; };
  const primary = (): Node => {
    const t = next();
    if (t === undefined) throw new ExprError('unexpected end');
    if (/^[\d.]/.test(t)) return { t: 'num', v: parseFloat(t) };
    if (t[0] === "'" || t[0] === '"') return { t: 'str', v: t.slice(1, -1) };
    if (t === '(') { const e = expr(0); expect(')'); return e; }
    if (t === '[') {
      const items: Node[] = [];
      if (peek() !== ']') { do items.push(expr(0)); while (peek() === ',' && next()); }
      expect(']');
      return { t: 'arr', items };
    }
    if (t === '-' || t === '+' || t === '!') return { t: 'un', op: t, a: unary() };
    if (/^[A-Za-z_]/.test(t)) {
      let name = t;
      // allow Math.sin / thisComp.duration style prefixes
      while (peek() === '.') { next(); const p = next(); if (!p || !/^[A-Za-z_]/.test(p)) throw new ExprError('bad member access'); name = p; }
      if (peek() === '(') {
        next();
        const args: Node[] = [];
        if (peek() !== ')') { do args.push(expr(0)); while (peek() === ',' && next()); }
        expect(')');
        return { t: 'call', name, args };
      }
      return { t: 'var', name };
    }
    throw new ExprError(`unexpected "${t}"`);
  };
  const unary = (): Node => {
    let n = primary();
    while (peek() === '[') { next(); const ix = expr(0); expect(']'); n = { t: 'index', a: n, i: ix }; }
    return n;
  };
  const expr = (minPrec: number): Node => {
    let left = unary();
    for (;;) {
      const op = peek();
      const p = op !== undefined ? PREC[op] : undefined;
      if (p === undefined || p < minPrec) break;
      next();
      if (op === '?') {
        const a = expr(0);
        expect(':');
        const b = expr(1);
        left = { t: 'cond', c: left, a, b };
        continue;
      }
      const right = expr(op === '^' ? p : p + 1);
      left = { t: 'bin', op: op!, a: left, b: right };
    }
    return left;
  };
  const n = expr(0);
  if (i < toks.length && toks[i] !== ';') throw new ExprError(`unexpected "${toks[i]}"`);
  return n;
}

// ---------------- evaluation ----------------
const map2 = (a: Val, b: Val, f: (x: number, y: number) => number): Val => {
  if (typeof a === 'number' && typeof b === 'number') return f(a, b);
  if (typeof a === 'number') return (b as number[]).map(y => f(a, y));
  if (typeof b === 'number') return a.map(x => f(x, b));
  const n = Math.max(a.length, b.length);
  return Array.from({ length: n }, (_, k) => f(a[k] ?? 0, b[k] ?? 0));
};
const map1 = (a: Val, f: (x: number) => number): Val => (typeof a === 'number' ? f(a) : a.map(f));
const num = (v: Val): number => (typeof v === 'number' ? v : v[0] ?? 0);

/** smooth 1d value noise in [-1, 1] */
export function noise1(x: number, seed = 0): number {
  const h = (n: number) => { const s = Math.sin((n + seed * 101.7) * 127.1) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

function lerpV(a: Val, b: Val, p: number): Val { return map2(a, b, (x, y) => x + (y - x) * p); }

export function evalExpr(node: Node, ctx: ExprContext): Val {
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
    const M1: Record<string, (x: number) => number> = Object.assign(Object.create(null), { sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, sqrt: Math.sqrt, exp: Math.exp, log: Math.log, degreesToRadians: (x: number) => x * Math.PI / 180, radiansToDegrees: (x: number) => x * 180 / Math.PI });
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
        // deterministic per layer/property: random() 0..1, random(max), random(min, max)
        const a = A();
        // after effects re-rolls every frame; each call in an expression gets its own number
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

/** compile with a cache; returns null + error message on failure */
const cache = new Map<string, Node | ExprError>();
export function compileExpr(src: string): { node: Node | null; error: string | null } {
  let r = cache.get(src);
  if (!r) {
    try { r = parseExpr(src); } catch (e: any) { r = e instanceof ExprError ? e : new ExprError(String(e?.message ?? e)); }
    cache.set(src, r);
  }
  return r instanceof ExprError ? { node: null, error: r.message } : { node: r, error: null };
}

/** evaluate to a fixed-size numeric vector (dim), falling back to `value` on errors */
export function runExpr(node: Node, ctx: ExprContext, dim: number, out: Float64Array | number[], off: number) {
  let v: Val;
  try { v = evalExpr(node, ctx); } catch { v = ctx.value; }
  for (let d = 0; d < dim; d++) {
    const x = typeof v === 'number' ? v : v[d] ?? (typeof ctx.value === 'number' ? ctx.value : ctx.value[d] ?? 0);
    out[off + d] = Number.isFinite(x) ? x : 0;
  }
}

/** parse + trial-run with a neutral context: catches unknown functions / bad arguments, not only syntax */
export function checkExpr(src: string, dim: number): string | null {
  const c = compileExpr(src);
  if (c.error) return c.error;
  const value = dim === 1 ? 0 : new Array(dim).fill(0);
  try {
    const v = evalExpr(c.node!, { time: 1, value, index: 0, fps: 30, duration: 5, inPoint: 0, valueAt: () => value, keyTimes: [0, 1], seed: 1 });
    if (typeof v !== 'number' && !Array.isArray(v)) return 'expression must produce a number or [x, y]';
    return null;
  } catch (e: any) { return String(e?.message ?? e); }
}

/** properties that support expressions (the renderer's evaluated transform/style set) */
export const EXPR_PROPS = ['anchor', 'position', 'scale', 'rotation', 'opacity', 'size', 'radius', 'fill', 'stroke', 'strokeWidth'];
