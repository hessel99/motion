// a small, SAFE expression language for property values (after effects style).
// it is parsed and compiled here into closures built from fixed code — never passed to
// eval/Function — so project files from anywhere can't run code. supported:
//   numbers, [a, b] vectors, + - * / % ^, unary -, ( ), comparisons (< > <= >= == !=), a ? b : c
//   variables: time, value, index, fps, duration, PI, inPoint
//   math: sin cos tan asin acos atan atan2 abs min max floor ceil round sqrt pow exp log clamp mod
//   motion: linear(t, t0, t1, v0, v1) ease(...) easeIn easeOut, random(seed?), noise(x),
//           wiggle(freq, amp, octaves?), loopOut('cycle'|'pingpong'|'offset'|'continue'), loopIn(...),
//           valueAtTime(t), length(v), normalize(v)
// vectors combine element-wise; a scalar combines with every component.

export type Val = number | number[];

export type ExprNode = Node;
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

// ---------------- evaluation: the tree is compiled once into closures ----------------
// no eval / new Function: every node becomes a small closure built from fixed code below. each
// node knows its shape at compile time where it can (scalar, vector of n, or "scalar or vector up
// to n"); constants are folded and scalar ops read time / index / value directly. every result is
// written into a buffer allocated at compile time, so running a program allocates nothing. those
// buffers belong to the program (shared by every layer using the same expression), so runs must not
// nest; nothing in the language can re-enter the evaluator.
// the language semantics are those of the reference tree interpreter (tests/expr-reference.ts),
// which the tests compare against on many random expressions.

/** inputs of one evaluation. keep one per (layer, property) and update it in place every frame */
export interface ExprFrame {
  time: number;
  index: number;
  fps: number;
  duration: number;
  inPoint: number;
  /** stable seed for random / wiggle / noise */
  seed: number;
  /** keyframe times of this property (for loops) */
  keyTimes: ArrayLike<number>;
  /** current (keyframed / static) value, components 0..dim-1. runProgram fills it with
   *  valueAt(time) itself, and only when the expression (or its error fallback) needs it */
  value: Float64Array;
  /** writes the property value at time t into out[0..dim-1] (loopOut / valueAtTime) */
  valueAt: (t: number, out: Float64Array) => void;
  /** random() call counter, reset by every run */
  calls: number;
}

/** writes the result into o and returns -1 for a scalar (in o[0]) or the vector length.
 *  results travel through typed arrays, never as return values: a double returned from a call
 *  that is not inlined (closure calls usually are not) is boxed, i.e. a heap allocation */
type Vf = (fr: ExprFrame, o: Float64Array) => number;
/** compiled node. k: 0 scalar, 1 vector of exactly n, 2 scalar or vector of at most n, 3 always throws.
 *  n bounds what f writes. cv: the node is this constant (folded at compile time); fd: the node
 *  reads a frame field (1 time, 2 index, 3 scalar value). both let parents skip a closure call */
interface C { k: 0 | 1 | 2 | 3; n: number; f: Vf; cv?: number; fd?: 1 | 2 | 3 }

const S = (f: Vf): C => ({ k: 0, n: 1, f });
const K = (v: number): C => ({ k: 0, n: 1, f: (_fr, o) => { o[0] = v; return -1; }, cv: v });
const F = (fd: 1 | 2 | 3, f: Vf): C => ({ k: 0, n: 1, f, fd });
const rd = (fr: ExprFrame, fd: number) => (fd === 1 ? fr.time : fd === 2 ? fr.index : fr.value[0]);
const V = (n: number, f: Vf): C => ({ k: 1, n, f });
const Dyn = (n: number, f: Vf): C => ({ k: 2, n: Math.max(1, n), f });
const fail = (msg: string): C => { const th = (): never => { throw new ExprError(msg); }; return { k: 3, n: 1, f: th }; };
/** always a scalar (or never returns) */
const isS = (c: C) => c.k === 0 || c.k === 3;
const buf = (c: C) => new Float64Array(Math.max(1, c.n));
/** same shape as c, other code */
const like = (c: C, f: Vf): C => (isS(c) ? S(f) : c.k === 1 ? V(c.n, f) : Dyn(c.n, f));
/** shape of an element-wise combination of a and b */
const like2 = (a: C, b: C, f: Vf): C => {
  const sa = isS(a), sb = isS(b);
  if (sa && sb) return S(f);
  if ((sa || a.k === 1) && (sb || b.k === 1)) return V(Math.max(sa ? 0 : a.n, sb ? 0 : b.n), f);
  return Dyn(Math.max(a.n, b.n), f);
};
/** num(v) of a result written to b with tag n: the scalar, or the first component (0 for an empty vector) */
const num = (n: number, b: Float64Array) => (n === 0 ? 0 : b[0]);
/** evaluates c for its side effects / errors only (arguments a function ignores but still evaluates) */
function effect(c: C): (fr: ExprFrame) => void {
  const b = buf(c), f = c.f;
  return fr => { f(fr, b); };
}
// element-wise operations are small integer codes switched on in ap / ap1 (not function values:
// closures share their code, so calling a function value from them would be a megamorphic call).
// they take arrays and indices and return nothing: no double crosses a call boundary, so nothing is
// boxed even where a call is not inlined
const ADD = 0, SUB = 1, MUL = 2, DIV = 3, REM = 4, POW = 5, MIN = 6, MAX = 7, MOD = 8, LERP = 9;
/** progress of LERP (linear / random): set right before comb */
const PB = new Float64Array(1);
/** o[k] = op(o[k], b[k]) */
function ap(op: number, o: Float64Array, b: Float64Array, k: number): void {
  const x = o[k], y = b[k];
  switch (op) {
    case ADD: o[k] = x + y; return;
    case SUB: o[k] = x - y; return;
    case MUL: o[k] = x * y; return;
    case DIV: o[k] = y === 0 ? 0 : x / y; return;
    case REM: o[k] = y === 0 ? 0 : x % y; return;
    case POW: o[k] = Math.pow(x, y); return;
    case MIN: o[k] = Math.min(x, y); return;
    case MAX: o[k] = Math.max(x, y); return;
    case MOD: o[k] = ((x % y) + y) % y; return;
    default: o[k] = x + (y - x) * PB[0]; // LERP
  }
}
const NEG = 0, ABS = 7, SIGN = 16;
// one-argument math functions by name (null prototype: names like "constructor" are not found)
const M1: Record<string, number> = Object.assign(Object.create(null), { sin: 1, cos: 2, tan: 3, asin: 4, acos: 5, atan: 6, abs: 7, floor: 8, ceil: 9, round: 10, sqrt: 11, exp: 12, log: 13, degreesToRadians: 14, radiansToDegrees: 15 });
/** o[k] = op(o[k]) */
function ap1(op: number, o: Float64Array, k: number): void {
  const x = o[k];
  switch (op) {
    case NEG: o[k] = -x; return;
    case 1: o[k] = Math.sin(x); return;
    case 2: o[k] = Math.cos(x); return;
    case 3: o[k] = Math.tan(x); return;
    case 4: o[k] = Math.asin(x); return;
    case 5: o[k] = Math.acos(x); return;
    case 6: o[k] = Math.atan(x); return;
    case 7: o[k] = Math.abs(x); return;
    case 8: o[k] = Math.floor(x); return;
    case 9: o[k] = Math.ceil(x); return;
    case 10: o[k] = Math.round(x); return;
    case 11: o[k] = Math.sqrt(x); return;
    case 12: o[k] = Math.exp(x); return;
    case 13: o[k] = Math.log(x); return;
    case 14: o[k] = x * Math.PI / 180; return;
    case 15: o[k] = x * 180 / Math.PI; return;
    default: o[k] = Math.sign(x); // SIGN
  }
}
/** element-wise o = op(a, b) in place: a is in o (na), b in b (nb); scalars combine with every
 *  component, missing components are 0. o and b must both hold max(na, nb) */
function comb(o: Float64Array, na: number, b: Float64Array, nb: number, op: number): number {
  let n: number;
  if (na < 0) {
    if (nb < 0) { ap(op, o, b, 0); return -1; }
    const x = o[0];
    for (let k = 1; k < nb; k++) o[k] = x;
    n = nb;
  } else if (nb < 0) {
    const y = b[0];
    for (let k = 1; k < na; k++) b[k] = y;
    n = na;
  } else {
    n = na > nb ? na : nb;
    for (let k = na; k < n; k++) o[k] = 0;
    for (let k = nb; k < n; k++) b[k] = 0;
  }
  for (let k = 0; k < n; k++) ap(op, o, b, k);
  return n;
}
/** scratch for the second operand: big enough for either */
const buf2 = (a: C, b: C) => new Float64Array(Math.max(1, a.n, b.n));
function map2(a: C, b: C, op: number): C {
  const af = a.f, bf = b.f;
  if (isS(a) && isS(b)) {
    // scalar: fold constants, read time / index / value directly
    const ca = a.cv, cb = b.cv, B = new Float64Array(1);
    if (ca !== undefined && cb !== undefined) { const A = new Float64Array([ca]); B[0] = cb; ap(op, A, B, 0); return K(A[0]); }
    if (cb !== undefined) {
      const d = a.fd;
      B[0] = cb;
      return S(d ? (fr, o) => { o[0] = rd(fr, d); ap(op, o, B, 0); return -1; } : (fr, o) => { af(fr, o); ap(op, o, B, 0); return -1; });
    }
    if (ca !== undefined) {
      const d = b.fd;
      return S(d ? (fr, o) => { B[0] = rd(fr, d); o[0] = ca; ap(op, o, B, 0); return -1; } : (fr, o) => { bf(fr, B); o[0] = ca; ap(op, o, B, 0); return -1; });
    }
    return S((fr, o) => { af(fr, o); bf(fr, B); ap(op, o, B, 0); return -1; });
  }
  const bb = buf2(a, b);
  return like2(a, b, (fr, o) => comb(o, af(fr, o), bb, bf(fr, bb), op));
}
function map1(a: C, op: number): C {
  const af = a.f;
  if (isS(a)) {
    const c = a.cv, d = a.fd;
    if (c !== undefined) { const A = new Float64Array([c]); ap1(op, A, 0); return K(A[0]); }
    return S(d ? (fr, o) => { o[0] = rd(fr, d); ap1(op, o, 0); return -1; } : (fr, o) => { af(fr, o); ap1(op, o, 0); return -1; });
  }
  return like(a, (fr, o) => {
    const n = af(fr, o);
    if (n < 0) { ap1(op, o, 0); return -1; }
    for (let k = 0; k < n; k++) ap1(op, o, k);
    return n;
  });
}
/** c, then the extra (ignored) arguments evaluated after it */
function withExtras(c: C, extras: C[]): C {
  if (!extras.length) return c;
  const ev = extras.map(effect), m = ev.length, f = c.f;
  return like(c, (fr, o) => { const n = f(fr, o); for (let i = 0; i < m; i++) ev[i](fr); return n; });
}
/** evaluate the arguments (their errors come first), then fail */
function seqFail(cs: C[], msg: string): C {
  const ev = cs.map(effect), m = ev.length;
  return { k: 3, n: 1, f: (fr: ExprFrame): never => { for (let i = 0; i < m; i++) ev[i](fr); throw new ExprError(msg); } };
}
/** Math.hypot over b[0..n-1] without spreading an array */
function hyp(b: Float64Array, n: number): number {
  switch (n) {
    case 0: return 0;
    case 1: return Math.hypot(b[0]);
    case 2: return Math.hypot(b[0], b[1]);
    case 3: return Math.hypot(b[0], b[1], b[2]);
    case 4: return Math.hypot(b[0], b[1], b[2], b[3]);
  }
  return Math.hypot(...Array.from(b.subarray(0, n)));
}


/** smooth 1d value noise in [-1, 1] */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  const s0 = Math.sin((i + seed * 101.7) * 127.1) * 43758.5453, s1 = Math.sin((i + 1 + seed * 101.7) * 127.1) * 43758.5453;
  return ((s0 - Math.floor(s0)) * 2 - 1) * (1 - u) + ((s1 - Math.floor(s1)) * 2 - 1) * u;
}

/** random(): after effects re-rolls every frame; each call in an expression gets its own number */
function rnd(fr: ExprFrame): number {
  const callN = ++fr.calls;
  const frame = Math.floor(fr.time * fr.fps + 1e-6);
  return ((Math.sin(fr.seed * 12.9898 + callN * 78.233 + frame * 37.719) * 43758.5453) % 1 + 1) % 1;
}

/** wiggle offset (before amplitude) of component d */
function wig(time: number, freq: number, oct: number, seed: number, d: number): number {
  let s = 0, ampk = 1, fk = 1, norm = 0;
  for (let o = 0; o < oct; o++) { s += noise1(time * freq * fk, seed + d * 17.3 + o * 3.1) * ampk; norm += ampk; ampk *= 0.5; fk *= 2; }
  return s / norm;
}


/** linear / ease progress */
function lin(t: number, t0: number, t1: number, mode: number): number {
  let p = t1 === t0 ? (t >= t1 ? 1 : 0) : Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  if (mode === 1) p = p * p * (3 - 2 * p);
  else if (mode === 2) p = p * p;
  else if (mode === 3) p = 1 - (1 - p) * (1 - p);
  return p;
}
const LT = 0, GT = 1, LE = 2, GE = 3, EQ = 4, NE = 5;
const CMP: Record<string, number> = { '<': LT, '>': GT, '<=': LE, '>=': GE, '==': EQ, '!=': NE };
function cmp(op: number, x: number, y: number): boolean {
  switch (op) {
    case LT: return x < y;
    case GT: return x > y;
    case LE: return x <= y;
    case GE: return x >= y;
    case EQ: return x === y;
    default: return x !== y;
  }
}

/** compile node for a property whose value is a scalar (sv) or a vector of dim components */
function comp(n: Node, sv: boolean, dim: number): C {
  const cc = (x: Node) => comp(x, sv, dim);
  switch (n.t) {
    case 'num': return K(n.v);
    case 'str': return fail('strings are only allowed as loop arguments');
    case 'arr': {
      const cs = n.items.map(cc), fs = cs.map(c => c.f), len = cs.length;
      const B = new Float64Array(Math.max(1, ...cs.map(c => c.n)));
      return V(len, (fr, o) => { for (let k = 0; k < len; k++) o[k] = num(fs[k](fr, B), B); return len; });
    }
    case 'var':
      switch (n.name) {
        case 'time': return F(1, (fr, o) => { o[0] = fr.time; return -1; });
        case 'value':
          readsValue = true;
          return sv ? F(3, (fr, o) => { o[0] = fr.value[0]; return -1; }) : V(dim, (fr, o) => { const v = fr.value; for (let k = 0; k < dim; k++) o[k] = v[k]; return dim; });
        case 'index': return F(2, (fr, o) => { o[0] = fr.index; return -1; });
        case 'fps': case 'frameRate': return S((fr, o) => { o[0] = fr.fps; return -1; });
        case 'duration': return S((fr, o) => { o[0] = fr.duration; return -1; });
        case 'inPoint': return S((fr, o) => { o[0] = fr.inPoint; return -1; });
        case 'PI': return K(Math.PI);
        case 'E': return K(Math.E);
        case 'true': return K(1);
        case 'false': return K(0);
      }
      return fail(`unknown name "${n.name}"`);
    case 'un': {
      const a = cc(n.a);
      if (n.op === '-') return map1(a, NEG);
      if (n.op === '!') { const af = a.f, A = buf(a); return S((fr, o) => { o[0] = num(af(fr, A), A) ? 0 : 1; return -1; }); }
      return a;
    }
    case 'index': {
      const a = cc(n.a), i = cc(n.i), af = a.f, if_ = i.f, A = buf(a), I = buf(i);
      return S((fr, o) => {
        const len = af(fr, A), ix = Math.floor(num(if_(fr, I), I));
        o[0] = len < 0 ? A[0] : ix >= 0 && ix < len ? A[ix] : 0;
        return -1;
      });
    }
    case 'cond': {
      const c = cc(n.c), a = cc(n.a), b = cc(n.b), cf = c.f, af = a.f, bf = b.f, Cb = buf(c);
      const f: Vf = (fr, o) => (num(cf(fr, Cb), Cb) ? af(fr, o) : bf(fr, o));
      if (isS(a) && isS(b)) return S(f);
      if (a.k === 3) return like(b, f);
      if (b.k === 3) return like(a, f);
      if (a.k === 1 && b.k === 1 && a.n === b.n) return V(a.n, f);
      return Dyn(Math.max(a.n, b.n), f);
    }
    case 'bin': {
      const a = cc(n.a), b = cc(n.b);
      switch (n.op) {
        case '+': return map2(a, b, ADD);
        case '-': return map2(a, b, SUB);
        case '*': return map2(a, b, MUL);
        case '/': return map2(a, b, DIV);
        case '%': return map2(a, b, REM);
        case '^': return map2(a, b, POW);
      }
      const af = a.f, bf = b.f, A = buf(a), B = buf(b);
      if (n.op === '&&') return S((fr, o) => { o[0] = num(af(fr, A), A) && num(bf(fr, B), B) ? 1 : 0; return -1; });
      if (n.op === '||') return S((fr, o) => { o[0] = num(af(fr, A), A) || num(bf(fr, B), B) ? 1 : 0; return -1; });
      const op = CMP[n.op];
      if (op === undefined) return fail(`bad operator ${n.op}`);
      return S((fr, o) => { const x = num(af(fr, A), A); o[0] = cmp(op, x, num(bf(fr, B), B)) ? 1 : 0; return -1; });
    }
    case 'call': return compCall(n.name, n.args, sv, dim);
  }
}

function compCall(name: string, args: Node[], sv: boolean, dim: number): C {
  const cc = (x: Node) => comp(x, sv, dim);
  const m1 = M1[name];
  if (m1 !== undefined) return args.length ? map1(cc(args[0]), m1) : fail(`${name}() needs an argument`);
  switch (name) {
    case 'min': case 'max': {
      const cs = args.map(cc);
      if (!cs.length) return fail(`${name}() needs an argument`);
      const op = name === 'min' ? MIN : MAX;
      let acc = cs[0];
      for (let i = 1; i < cs.length; i++) acc = map2(acc, cs[i], op);
      return acc;
    }
    case 'pow': case 'mod': {
      const cs = args.map(cc);
      if (cs.length < 2) return seqFail(cs, `${name}(a, b)`);
      return withExtras(map2(cs[0], cs[1], name === 'pow' ? POW : MOD), cs.slice(2));
    }
    case 'atan2': {
      const cs = args.map(cc);
      if (cs.length < 2) return seqFail(cs, 'atan2(y, x)');
      const yf = cs[0].f, xf = cs[1].f, Y = buf(cs[0]), X = buf(cs[1]);
      return withExtras(S((fr, o) => { const y = num(yf(fr, Y), Y); o[0] = Math.atan2(y, num(xf(fr, X), X)); return -1; }), cs.slice(2));
    }
    case 'clamp': {
      const cs = args.map(cc);
      if (cs.length < 3) return seqFail(cs, 'clamp(value, min, max)');
      return withExtras(map2(map2(cs[0], cs[1], MAX), cs[2], MIN), cs.slice(3));
    }
    case 'length': {
      if (!args.length) return fail('length(v)');
      const a = cc(args[0]);
      if (isS(a)) return map1(a, ABS);
      const af = a.f, A = buf(a);
      return S((fr, o) => { const n = af(fr, A); o[0] = n < 0 ? Math.abs(A[0]) : hyp(A, n); return -1; });
    }
    case 'normalize': {
      if (!args.length) return fail('normalize(v)');
      const a = cc(args[0]);
      if (isS(a)) return map1(a, SIGN);
      const af = a.f;
      return like(a, (fr, o) => {
        const n = af(fr, o);
        if (n < 0) { o[0] = Math.sign(o[0]); return -1; }
        const l = hyp(o, n) || 1;
        for (let k = 0; k < n; k++) o[k] = o[k] / l;
        return n;
      });
    }
    case 'linear': case 'ease': case 'easeIn': case 'easeOut': {
      const cs = args.map(cc);
      if (cs.length !== 3 && cs.length !== 5) return seqFail(cs, `${name}(t, [tMin, tMax,] v1, v2)`);
      const five = cs.length === 5, mode = name === 'ease' ? 1 : name === 'easeIn' ? 2 : name === 'easeOut' ? 3 : 0;
      const tf = cs[0].f, T = buf(cs[0]);
      const t0f = five ? cs[1].f : null, T0 = five ? buf(cs[1]) : T, t1f = five ? cs[2].f : null, T1 = five ? buf(cs[2]) : T;
      const a = cs[five ? 3 : 1], b = cs[five ? 4 : 2], af = a.f, bf = b.f, bb = buf2(a, b);
      return like2(a, b, (fr, o) => {
        const t = num(tf(fr, T), T);
        let t0 = 0, t1 = 1;
        if (t0f && t1f) { t0 = num(t0f(fr, T0), T0); t1 = num(t1f(fr, T1), T1); }
        const p = lin(t, t0, t1, mode), na = af(fr, o), nb = bf(fr, bb);
        PB[0] = p;
        return comb(o, na, bb, nb, LERP);
      });
    }
    case 'random': {
      // deterministic per layer/property and frame: random() 0..1, random(max), random(min, max)
      const cs = args.map(cc);
      if (!cs.length) return S((fr, o) => { o[0] = rnd(fr); return -1; });
      const a = cs[0], af = a.f;
      if (cs.length === 1) {
        return like(a, (fr, o) => {
          const n = af(fr, o), r = rnd(fr);
          if (n < 0) { o[0] = o[0] * r; return -1; }
          for (let k = 0; k < n; k++) o[k] = o[k] * r;
          return n;
        });
      }
      const b = cs[1], bf = b.f, bb = buf2(a, b), ev = cs.slice(2).map(effect), m = ev.length;
      return like2(a, b, (fr, o) => {
        const na = af(fr, o), nb = bf(fr, bb);
        for (let i = 0; i < m; i++) ev[i](fr);
        PB[0] = rnd(fr);
        return comb(o, na, bb, nb, LERP);
      });
    }
    case 'noise': {
      if (!args.length) return fail('noise(x)');
      const a = cc(args[0]), af = a.f;
      return like(a, (fr, o) => {
        const n = af(fr, o);
        if (n < 0) { o[0] = noise1(o[0], fr.seed); return -1; }
        for (let k = 0; k < n; k++) o[k] = noise1(o[k], fr.seed);
        return n;
      });
    }
    case 'wiggle': {
      readsValue = true;
      const cs = args.map(cc);
      const c0 = cs[0] ?? K(1), c1 = cs[1] ?? K(10), c2 = cs[2] ?? K(1);
      const f0 = c0.f, f1 = c1.f, f2 = c2.f, A0 = buf(c0), AB = buf(c1), A2 = buf(c2);
      const ev = cs.slice(3).map(effect), m = ev.length;
      const f: Vf = (fr, o) => {
        // arguments in order: freq, amp (scalar, or per component: an = its length), octaves, extras
        const freq = num(f0(fr, A0), A0), an = f1(fr, AB), oct = Math.max(1, Math.min(6, Math.round(num(f2(fr, A2), A2))));
        for (let i = 0; i < m; i++) ev[i](fr);
        const base = fr.value, time = fr.time, seed = fr.seed;
        if (sv) { o[0] = base[0] + wig(time, freq, oct, seed, 0) * (an === 0 ? 0 : AB[0]); return -1; }
        for (let d = 0; d < dim; d++) o[d] = base[d] + wig(time, freq, oct, seed, d) * (an < 0 ? AB[0] : d < an ? AB[d] : 0);
        return dim;
      };
      return sv ? S(f) : V(dim, f);
    }
    case 'loopOut': case 'loopIn': {
      readsValue = true;
      const a0 = args[0];
      const type = a0 && a0.t === 'str' ? a0.v : 'cycle';
      const out = name === 'loopOut', N = sv ? 1 : dim, tag = sv ? -1 : dim;
      const b1 = new Float64Array(Math.max(1, N)), b2 = new Float64Array(Math.max(1, N));
      const f: Vf = (fr, o) => {
        const k = fr.keyTimes, t = fr.time;
        const t0 = k[0], t1 = k[k.length - 1], span = t1 - t0;
        if (k.length < 2 || (out ? t <= t1 : t >= t0)) { const v = fr.value; for (let d = 0; d < N; d++) o[d] = v[d]; return tag; }
        if (type === 'continue') {
          const edge = out ? t1 : t0, h = 1 / fr.fps;
          fr.valueAt(edge, o);
          fr.valueAt(out ? edge - h : edge + h, b1);
          for (let d = 0; d < N; d++) { const x = o[d], y = b1[d]; const s = (out ? (x - y) : (y - x)) / h; o[d] = x + s * (t - edge); }
          return tag;
        }
        const cycles = Math.floor((out ? t - t0 : t1 - t) / span);
        let lt = out ? t0 + ((t - t0) % span) : t1 - ((t1 - t) % span);
        if (type === 'pingpong' && cycles % 2 === 1) lt = t0 + t1 - lt;
        fr.valueAt(lt, o);
        if (type === 'offset') {
          fr.valueAt(t1, b1);
          fr.valueAt(t0, b2);
          const c = out ? cycles : -cycles;
          for (let d = 0; d < N; d++) o[d] = o[d] + (b1[d] - b2[d]) * c;
        }
        return tag;
      };
      return sv ? S(f) : V(dim, f);
    }
    case 'valueAtTime': {
      if (!args.length) return fail('valueAtTime(t)');
      const a = cc(args[0]), af = a.f, T = buf(a), tag = sv ? -1 : dim;
      const f: Vf = (fr, o) => { fr.valueAt(num(af(fr, T), T), o); return tag; };
      return sv ? S(f) : V(dim, f);
    }
  }
  return fail(`unknown function "${name}"`);
}
/** a compiled expression for one property shape */
export interface ExprProgram { readonly dim: number; readonly scalar: boolean; readonly root: C; readonly buf: Float64Array; readonly readsValue: boolean }
/** set while compiling: the expression reads the current value (value, wiggle, loops) */
let readsValue = false;
const programs = new WeakMap<Node, Map<number, ExprProgram>>();
/** compile a parsed expression once for a property of `dim` components (scalar value when `scalar`) */
export function compileProgram(node: Node, dim: number, scalar = dim === 1): ExprProgram {
  let m = programs.get(node);
  if (!m) programs.set(node, m = new Map());
  const key = scalar ? -1 : dim;
  let p = m.get(key);
  if (!p) {
    readsValue = false;
    const root = comp(node, scalar, dim);
    p = { dim, scalar, root, buf: new Float64Array(Math.max(1, root.n, dim)), readsValue };
    m.set(key, p);
  }
  return p;
}

/** run a program at fr.time and write `dim` finite numbers to out[off..]. the current value is
 *  fetched (fr.valueAt(fr.time) into fr.value) only when needed; on errors the value is kept */
export function runProgram(p: ExprProgram, fr: ExprFrame, out: Float64Array | number[], off: number) {
  fr.calls = 0;
  const b = p.buf, v = fr.value, dim = p.dim, sv = p.scalar;
  if (p.readsValue) fr.valueAt(fr.time, v);
  let n: number;
  try { n = p.root.f(fr, b); } catch { n = -2; }
  // errors and missing components fall back to the value
  if (!p.readsValue && (n === -2 || (n >= 0 && n < dim))) fr.valueAt(fr.time, v);
  for (let d = 0; d < dim; d++) {
    const x = n === -1 ? b[0] : n >= 0 && d < n ? b[d] : sv ? v[0] : v[d];
    out[off + d] = Number.isFinite(x) ? x : 0;
  }
}

/** context of evalExpr (convenience form: values as numbers / arrays) */
export interface ExprContext {
  time: number;
  value: Val;
  index: number;
  fps: number;
  duration: number;
  inPoint: number;
  /** property value at another time (for loopOut / valueAtTime) */
  valueAt: (t: number) => Val;
  /** keyframe times of this property (for loops) */
  keyTimes: number[];
  /** stable seed for random / wiggle */
  seed: number;
  /** per-evaluation call counter (random) */
  calls?: number;
}

/** evaluate once with plain values (allocates; the renderer uses compileProgram + runProgram). throws on errors */
export function evalExpr(node: Node, ctx: ExprContext): Val {
  const sv = typeof ctx.value === 'number';
  const dim = sv ? 1 : (ctx.value as number[]).length;
  const p = compileProgram(node, dim, sv);
  const value = new Float64Array(Math.max(1, dim));
  if (sv) value[0] = ctx.value as number; else for (let d = 0; d < dim; d++) value[d] = (ctx.value as number[])[d];
  const fr: ExprFrame = {
    time: ctx.time, index: ctx.index, fps: ctx.fps, duration: ctx.duration, inPoint: ctx.inPoint, seed: ctx.seed, keyTimes: ctx.keyTimes, value, calls: 0,
    valueAt: (t, o) => { const r = ctx.valueAt(t); for (let d = 0; d < dim; d++) o[d] = typeof r === 'number' ? r : r[d] ?? 0; },
  };
  try {
    const n = p.root.f(fr, p.buf);
    return n < 0 ? p.buf[0] : Array.from(p.buf.subarray(0, n));
  } finally { ctx.calls = fr.calls; }
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
