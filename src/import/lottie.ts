// lottie / bodymovin json import.
//
// also hosts the generic "after effects layer -> our layer tree" machinery that the .aep
// importer (src/import/aep) reuses: an intermediate shape tree (ShapeNode), the shape
// layer builder, and the parenting assembler that maps ae parenting onto our tree.
//
// coordinate notes: an ae layer's local matrix is T(p)·R·S·T(-a), exactly like ours, and
// layer space of a solid / image / precomp is the box [0, size], like our rect box. so
// those map 1:1. shape primitives get position = their centre and anchor = size/2, which
// reproduces ae's "grow around the centre" behaviour even with animated size.

import { createLayer, uid, type Asset, type Composition, type Keyframe, type Layer, type LayerType, type Paint, type PathCmd, type PathGeometry, type Project, type Prop, type PropKey } from '../core/model';
import { evalProp } from '../core/evaluate';
import { cubicBezier } from '../core/easing';
import { compileExpr } from '../core/expr';

// ======================================================================================
// prop helpers
// ======================================================================================

export function sprop(v: number[]): Prop { return { v: v.slice() }; }

export function isAnimated(p: Prop | undefined): boolean { return !!p?.kf && p.kf.length > 1; }

/** value at the first keyframe (or static value) */
export function firstValue(p: Prop): number[] { return p.kf && p.kf.length ? p.kf[0].v : p.v; }

/** map every value of a prop (static + keyframes). spatial tangents are mapped with `tan` when given, else dropped */
export function mapProp(p: Prop, fn: (v: number[]) => number[], tan?: (v: number[]) => number[]): Prop {
  const out: Prop = { v: fn(p.v) };
  if (p.kf && p.kf.length) {
    out.kf = p.kf.map(k => {
      const nk: Keyframe = { t: k.t, v: fn(k.v), interp: k.interp, out: [k.out[0], k.out[1]], in: [k.in[0], k.in[1]] };
      if (tan && k.sOut) nk.sOut = tan(k.sOut);
      if (tan && k.sIn) nk.sIn = tan(k.sIn);
      return nk;
    });
    out.v = out.kf[0].v.slice();
  }
  return normalizeProp(out);
}

/** collapse keyframes that are all equal into a static prop; single keyframe -> static */
export function normalizeProp(p: Prop): Prop {
  const kf = p.kf;
  if (!kf || kf.length === 0) { delete p.kf; return p; }
  const v0 = kf[0].v;
  let same = true;
  for (let i = 1; i < kf.length && same; i++) {
    const v = kf[i].v;
    for (let d = 0; d < v0.length; d++) if (Math.abs(v[d] - v0[d]) > 1e-9) { same = false; break; }
  }
  if (same) return { v: v0.slice() };
  p.v = v0.slice();
  return p;
}

function sameTimes(a: Keyframe[], b: Keyframe[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i].t - b[i].t) > 1e-6) return false;
  return true;
}

/**
 * combine several props into one: out(t) = fn(values of each at t). exact when at most one
 * prop is animated or all animated props share key times (their easing is taken from the
 * first animated prop). otherwise keys are placed at the union of times (easing of the
 * first animated prop where it has a key there, linear elsewhere) - an approximation.
 */
export function combineProps(props: Prop[], dims: number[], fn: (vals: number[][]) => number[]): Prop {
  const anim = props.filter(isAnimated);
  if (!anim.length) return { v: fn(props.map(p => firstValue(p))) };
  const lead = anim[0].kf!;
  if (anim.every(p => sameTimes(p.kf!, lead))) {
    const kf: Keyframe[] = lead.map((k, i) => {
      const vals = props.map(p => (isAnimated(p) ? p.kf![i].v : firstValue(p)));
      const nk: Keyframe = { t: k.t, v: fn(vals), interp: k.interp, out: [k.out[0], k.out[1]], in: [k.in[0], k.in[1]] };
      return nk;
    });
    return normalizeProp({ v: kf[0].v.slice(), kf });
  }
  // union of key times
  const times = Array.from(new Set(anim.flatMap(p => p.kf!.map(k => Math.round(k.t * 1e6) / 1e6)))).sort((a, b) => a - b);
  const leadIdx = new Map(lead.map(k => [Math.round(k.t * 1e6) / 1e6, k]));
  const kf: Keyframe[] = times.map(t => {
    const vals = props.map((p, i) => evalProp(p, t, dims[i], p.v));
    const lk = leadIdx.get(t);
    return lk
      ? { t, v: fn(vals), interp: lk.interp, out: [lk.out[0], lk.out[1]], in: [lk.in[0], lk.in[1]] }
      : { t, v: fn(vals), interp: 'linear', out: [0, 0], in: [1, 1] };
  });
  return normalizeProp({ v: kf[0].v.slice(), kf });
}

/** shift all key times */
export function shiftProp(p: Prop, dt: number): Prop {
  if (!dt || !p.kf) return p;
  for (const k of p.kf) k.t += dt;
  return p;
}

// ======================================================================================
// intermediate model shared by the lottie and aep importers
// ======================================================================================

export interface TR { anchor: Prop; position: Prop; scale: Prop; rotation: Prop; opacity: Prop }

export function identityTR(opacity?: Prop): TR {
  return { anchor: sprop([0, 0]), position: sprop([0, 0]), scale: sprop([100, 100]), rotation: sprop([0]), opacity: opacity ?? sprop([100]) };
}

export type ShapeNode =
  | { kind: 'group'; name: string; tr: TR; items: ShapeNode[] }
  | { kind: 'rect'; name: string; size: Prop; position: Prop; roundness: Prop }
  | { kind: 'ellipse'; name: string; size: Prop; position: Prop }
  | { kind: 'path'; name: string; cmds: PathCmd[]; keys?: PathAnimKey[] }
  | { kind: 'fill'; name: string; color: Prop; opacity: Prop; rule: 'nonzero' | 'evenodd' }
  | { kind: 'stroke'; name: string; color: Prop; opacity: Prop; width: Prop }
  | { kind: 'gfill'; name: string; gtype: 'linear' | 'radial'; stops: { pos: number; color: [number, number, number, number] }[]; start: number[]; end: number[]; opacity: Prop; rule: 'nonzero' | 'evenodd' }
  /** trim paths modifier: applies to the primitives above it (same group and nested groups), like paints */
  | { kind: 'trim'; name: string; start: Prop; end: Prop; offset: Prop };

/** one key of an animated path (time in seconds; easing like Keyframe: segment k->k+1 uses k.out, (k+1).in) */
export interface PathAnimKey { t: number; cmds: PathCmd[]; interp: Keyframe['interp']; out: [number, number]; in: [number, number] }

/** a path source: static commands, optionally animated by keys (keys[0].cmds == cmds) */
export interface PathSrc { cmds: PathCmd[]; keys?: PathAnimKey[] }

type PaintNode = Extract<ShapeNode, { kind: 'fill' | 'stroke' | 'gfill' }>;
type TrimNode = Extract<ShapeNode, { kind: 'trim' }>;
type ModNode = PaintNode | TrimNode;
type PrimNode = Extract<ShapeNode, { kind: 'rect' | 'ellipse' | 'path' }>;

export class BuildCtx {
  layers: Record<string, Layer> = {};
  assets: Record<string, Asset> = {};
  count = 0;
  /** hard cap against pathological precomp fan-out */
  maxLayers = 200000;
  constructor(public compW: number, public compH: number) {}

  make(type: LayerType, name: string, tr: TR, extra: Partial<Layer> = {}): Layer {
    const l = createLayer(type, { w: 100, h: 100 });
    l.name = name || l.name;
    l.props.anchor = tr.anchor;
    l.props.position = tr.position;
    l.props.scale = tr.scale;
    l.props.rotation = tr.rotation;
    l.props.opacity = tr.opacity;
    Object.assign(l, extra);
    this.layers[l.id] = l;
    this.count++;
    return l;
  }

  adopt(parent: Layer, kids: Layer[]) {
    for (const k of kids) { k.parent = parent.id; parent.children.push(k.id); }
  }
}

// ---------------- geometry helpers ----------------

const K = 0.5522847498;

export function rectCmds(x: number, y: number, w: number, h: number, r = 0): PathCmd[] {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r <= 0) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
  const c = r * (1 - K);
  return [
    ['M', x + r, y], ['L', x + w - r, y], ['C', x + w - c, y, x + w, y + c, x + w, y + r],
    ['L', x + w, y + h - r], ['C', x + w, y + h - c, x + w - c, y + h, x + w - r, y + h],
    ['L', x + r, y + h], ['C', x + c, y + h, x, y + h - c, x, y + h - r],
    ['L', x, y + r], ['C', x, y + c, x + c, y, x + r, y], ['Z'],
  ];
}

export function ellipseCmds(cx: number, cy: number, rx: number, ry: number): PathCmd[] {
  const ox = rx * K, oy = ry * K;
  return [
    ['M', cx, cy - ry],
    ['C', cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy],
    ['C', cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry],
    ['C', cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy],
    ['C', cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry],
    ['Z'],
  ];
}

/** cubic path from vertices + absolute-relative tangents (lottie v/i/o) */
export function bezierCmds(v: number[][], ti: number[][], to: number[][], closed: boolean): PathCmd[] {
  const n = v.length;
  if (!n) return [];
  const cmds: PathCmd[] = [['M', v[0][0], v[0][1]]];
  const seg = (a: number, b: number) => {
    const o = to[a] ?? [0, 0], i = ti[b] ?? [0, 0];
    cmds.push(['C', v[a][0] + o[0], v[a][1] + o[1], v[b][0] + i[0], v[b][1] + i[1], v[b][0], v[b][1]]);
  };
  for (let k = 0; k < n - 1; k++) seg(k, k + 1);
  if (closed) { if (n > 1) seg(n - 1, 0); cmds.push(['Z']); }
  return cmds;
}

function cmdsBounds(cmds: PathCmd[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cmds) {
    for (let i = 1; i + 1 < c.length; i += 2) {
      const x = c[i] as number, y = c[i + 1] as number;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (!isFinite(x0)) return [0, 0, 0, 0];
  return [x0, y0, x1 - x0, y1 - y0];
}

function translateCmds(cmds: PathCmd[], dx: number, dy: number): PathCmd[] {
  return cmds.map(c => {
    if (c[0] === 'Z') return c;
    const o = c.slice() as any[];
    for (let i = 1; i + 1 < o.length; i += 2) { o[i] += dx; o[i + 1] += dy; }
    return o as PathCmd;
  });
}

function primCmdsAt(kind: 'rect' | 'ellipse', v: number[]): PathCmd[] {
  const [w, h, x, y, r] = v;
  if (kind === 'rect') return rectCmds(x - w / 2, y - h / 2, w, h, r ?? 0);
  return ellipseCmds(x, y, w / 2, h / 2);
}

/** a primitive as a path source; animated rect / ellipse parameters become path keys */
function primSrc(p: PrimNode): PathSrc {
  if (p.kind === 'path') return { cmds: p.cmds, keys: p.keys };
  const props = p.kind === 'rect' ? [p.size, p.position, p.roundness] : [p.size, p.position];
  const all = combineProps(props, props.map((_, i) => (i < 2 ? 2 : 1)), vals => [vals[0][0], vals[0][1], vals[1][0], vals[1][1], vals[2]?.[0] ?? 0]);
  const cmds = primCmdsAt(p.kind, firstValue(all));
  if (!all.kf || all.kf.length < 2) return { cmds };
  return { cmds, keys: all.kf.map(k => ({ t: k.t, cmds: primCmdsAt(p.kind as 'rect' | 'ellipse', k.v), interp: k.interp, out: [k.out[0], k.out[1]], in: [k.in[0], k.in[1]] })) };
}

function lerpCmds(a: PathCmd[], b: PathCmd[], p: number): PathCmd[] {
  if (a.length !== b.length) return p < 0.5 ? a : b;
  return a.map((ca, i) => {
    const cb = b[i];
    if (ca[0] !== cb[0]) return p < 0.5 ? ca : cb;
    return ca.map((v, k) => (k === 0 ? v : (v as number) + (((cb as any)[k] as number) - (v as number)) * p)) as PathCmd;
  });
}

/** evaluate an animated path source at time t (same easing semantics as the renderer) */
export function pathSrcAt(src: PathSrc, t: number): PathCmd[] {
  const kf = src.keys;
  if (!kf || kf.length < 2) return src.cmds;
  if (t <= kf[0].t) return kf[0].cmds;
  const last = kf[kf.length - 1];
  if (t >= last.t) return last.cmds;
  let i = 0;
  while (i < kf.length - 2 && kf[i + 1].t <= t) i++;
  const a = kf[i], b = kf[i + 1];
  if (a.interp === 'hold') return a.cmds;
  let p = (t - a.t) / (b.t - a.t || 1);
  if (a.interp !== 'linear') p = cubicBezier(a.out[0], a.out[1], b.in[0], b.in[1])(p);
  return lerpCmds(a.cmds, b.cmds, p);
}

/**
 * combine several path sources into keyed geometry lists. exact when at most one source is
 * animated or all animated sources share key times (easing from the first); otherwise keys
 * at the union of times, sampled, with the first source's easing where it has a key.
 */
function combinePathSrcs(srcs: PathSrc[]): { t: number; paths: PathCmd[][]; interp: Keyframe['interp']; out: [number, number]; in: [number, number] }[] | null {
  const anim = srcs.filter(s => s.keys && s.keys.length > 1);
  if (!anim.length) return null;
  const lead = anim[0].keys!;
  const same = anim.every(s => s.keys!.length === lead.length && s.keys!.every((k, i) => Math.abs(k.t - lead[i].t) < 1e-6));
  if (same) return lead.map((k, i) => ({ t: k.t, paths: srcs.map(s => (s.keys && s.keys.length > 1 ? s.keys[i].cmds : s.cmds)), interp: k.interp, out: k.out, in: k.in }));
  const times = Array.from(new Set(anim.flatMap(s => s.keys!.map(k => Math.round(k.t * 1e6) / 1e6)))).sort((a, b) => a - b);
  const leadAt = new Map(lead.map(k => [Math.round(k.t * 1e6) / 1e6, k]));
  return times.map(t => {
    const lk = leadAt.get(t);
    return { t, paths: srcs.map(s => pathSrcAt(s, t)), interp: lk ? lk.interp : 'linear', out: lk ? lk.out : [0, 0], in: lk ? lk.in : [1, 1] };
  });
}

// ---------------- shape tree -> layers ----------------

function applyPaints(ctx: BuildCtx, l: Layer, fill: PaintNode | undefined, stroke: PaintNode | undefined, box: [number, number, number, number]) {
  if (fill && fill.kind === 'fill') {
    l.props.fill = combineProps([fill.color, fill.opacity], [4, 1], ([c, o]) => [c[0], c[1], c[2], (c[3] ?? 1) * (o[0] ?? 100) / 100]);
  } else if (fill && fill.kind === 'gfill') {
    l.props.fill = sprop([1, 1, 1, 1]);
    const [bx, by, w0, h0] = box;
    const w = w0 || 1, h = h0 || 1;
    const sx = fill.start[0] - bx, sy = fill.start[1] - by, ex = fill.end[0] - bx, ey = fill.end[1] - by;
    let m: number[];
    if (fill.gtype === 'linear') {
      const dx = ex - sx, dy = ey - sy;
      const E = sx + dy / 2, F = sy - dx / 2;
      m = [dx / w, dy / h, -dy / w, dx / h, E / w, F / h];
    } else {
      const r = Math.hypot(ex - sx, ey - sy) || 1;
      m = [(2 * r) / w, 0, 0, (2 * r) / h, (sx - r) / w, (sy - r) / h];
    }
    const paint: Paint = { type: fill.gtype, stops: fill.stops.map(s => ({ pos: s.pos, color: s.color })), transform: m, opacity: (firstValue(fill.opacity)[0] ?? 100) / 100 };
    l.paints = [paint];
  } else {
    l.props.fill = sprop([0, 0, 0, 0]);
  }
  if (stroke && stroke.kind === 'stroke') {
    l.props.stroke = combineProps([stroke.color, stroke.opacity], [4, 1], ([c, o]) => [c[0], c[1], c[2], (c[3] ?? 1) * (o[0] ?? 100) / 100]);
    l.props.strokeWidth = stroke.width;
    l.strokeAlign = 'center';
  } else if (stroke && stroke.kind === 'gfill') {
    // gradient stroke: approximate with the first stop colour
    const c = stroke.stops[0]?.color ?? [1, 1, 1, 1];
    l.props.stroke = sprop([c[0], c[1], c[2], c[3]]);
    l.props.strokeWidth = sprop([1]);
  } else {
    l.props.stroke = sprop([0, 0, 0, 0]);
    l.props.strokeWidth = sprop([0]);
  }
}

function primLayer(ctx: BuildCtx, p: PrimNode, fill?: PaintNode, stroke?: PaintNode): Layer {
  if (p.kind === 'rect' || p.kind === 'ellipse') {
    const half = mapProp(p.size, v => [v[0] / 2, v[1] / 2]);
    const tr = identityTR();
    tr.position = p.position;
    tr.anchor = half;
    const l = ctx.make(p.kind, p.name, tr);
    l.props.size = p.size;
    if (p.kind === 'rect') l.props.radius = mapProp(p.roundness, v => [v[0], v[0], v[0], v[0]]);
    else delete l.props.radius;
    const s = firstValue(p.size), c = firstValue(p.position);
    applyPaints(ctx, l, fill, stroke, [c[0] - s[0] / 2, c[1] - s[1] / 2, s[0], s[1]]);
    return l;
  }
  return pathLayer(ctx, p.name, [primSrc(p)], fill, stroke);
}

/**
 * a path layer from one or more path sources (all in the same space). animated sources
 * become pathKf; the geometry space is the union bounds over every key.
 */
export function pathLayer(ctx: BuildCtx, name: string, srcs: PathSrc[], fill?: PaintNode, stroke?: PaintNode, trim?: TrimNode, ruleOverride?: 'nonzero' | 'evenodd',
  parts?: { n: number; rule: 'nonzero' | 'evenodd' }[]): Layer {
  const keyed = combinePathSrcs(srcs);
  const first = keyed ? keyed[0].paths : srcs.map(s => s.cmds);
  let [bx, by, bw, bh] = cmdsBounds(first.flat());
  if (keyed) {
    let x1 = bx + bw, y1 = by + bh;
    for (const k of keyed) {
      const [kx, ky, kw, kh] = cmdsBounds(k.paths.flat());
      if (kw === 0 && kh === 0 && kx === 0 && ky === 0) continue;
      bx = Math.min(bx, kx); by = Math.min(by, ky); x1 = Math.max(x1, kx + kw); y1 = Math.max(y1, ky + kh);
    }
    bw = x1 - bx; bh = y1 - by;
  }
  const tr = identityTR();
  tr.position = sprop([bx, by]);
  const l = ctx.make('path', name, tr);
  delete l.props.radius;
  const rule = ruleOverride ?? (fill && (fill.kind === 'fill' || fill.kind === 'gfill') ? fill.rule : 'nonzero');
  // one compound path (like ae shape groups): even-odd and opposite-winding holes work across
  // sub-paths. `parts` instead splits the sources into separately filled compounds (a union).
  const geo = (paths: PathCmd[][]): PathGeometry[] => {
    if (!parts) return [{ cmds: translateCmds(paths.flat(), -bx, -by), fillRule: rule }];
    const out: PathGeometry[] = [];
    let i = 0;
    for (const p of parts) { out.push({ cmds: translateCmds(paths.slice(i, i + p.n).flat(), -bx, -by), fillRule: p.rule }); i += p.n; }
    return out;
  };
  l.geometry = geo(first);
  if (keyed) l.pathKf = keyed.map(k => ({ t: k.t, geometry: geo(k.paths), interp: k.interp, out: [k.out[0], k.out[1]], in: [k.in[0], k.in[1]] }));
  l.geomSize = [bw, bh];
  l.props.size = sprop([bw, bh]);
  applyPaints(ctx, l, fill, stroke, [bx, by, bw, bh]);
  if (trim) {
    l.trimOn = true;
    l.props.trimStart = trim.start;
    l.props.trimEnd = trim.end;
    l.props.trimOffset = trim.offset;
  }
  return l;
}

function isPaint(n: ShapeNode): n is PaintNode { return n.kind === 'fill' || n.kind === 'stroke' || n.kind === 'gfill'; }
function isMod(n: ShapeNode): n is ModNode { return isPaint(n) || n.kind === 'trim'; }
function isPrim(n: ShapeNode): n is PrimNode { return n.kind === 'rect' || n.kind === 'ellipse' || n.kind === 'path'; }

/**
 * convert the items of one shape group (ae order: first item = top) into layers in our
 * order (first = bottom). paints apply to every primitive above them in the same group
 * and in nested groups above them (ae semantics); we take the nearest fill and stroke.
 */
function groupItems(ctx: BuildCtx, items: ShapeNode[], inherited: ModNode[]): Layer[] {
  const out: Layer[] = []; // top -> bottom, reversed at the end
  // paints / modifiers after index i (nearest first), computed right-to-left in one pass
  const after: ModNode[][] = new Array(items.length);
  let acc = inherited;
  for (let i = items.length - 1; i >= 0; i--) {
    after[i] = acc;
    const it = items[i];
    if (isMod(it)) acc = [it, ...acc];
  }
  const pick = (ps: ModNode[]) => {
    // a trim only affects the primitives above it: paints listed before the trim (nearer) still
    // apply, the trim applies to all of them in after effects (trim sits above the paints)
    return {
      fill: ps.find(p => p.kind === 'fill' || (p.kind === 'gfill' && !(p as any).stroke)) as PaintNode | undefined,
      stroke: ps.find(p => p.kind === 'stroke') as PaintNode | undefined,
      trim: ps.find(p => p.kind === 'trim') as TrimNode | undefined,
    };
  };
  let i = 0;
  while (i < items.length) {
    if (ctx.count > ctx.maxLayers) break;
    const it = items[i];
    if (it.kind === 'group') {
      const g = ctx.make('group', it.name, it.tr, {});
      g.props.size = sprop([0, 0]);
      g.props.fill = sprop([1, 1, 1, 0]);
      ctx.adopt(g, groupItems(ctx, it.items, after[i]));
      out.push(g);
      i++;
      continue;
    }
    if (isPrim(it)) {
      // run of consecutive primitives sharing the same paints
      let j = i + 1;
      while (j < items.length && isPrim(items[j])) j++;
      const run = items.slice(i, j) as PrimNode[];
      const { fill, stroke, trim } = pick(after[j - 1]);
      if (fill || stroke) {
        if (trim || (run.length > 1 && run.some(r => r.kind === 'path'))) {
          out.push(pathLayer(ctx, run[0].name, run.map(primSrc), fill, stroke, trim));
        } else for (const r of run) out.push(primLayer(ctx, r, fill, stroke));
      }
      i = j;
      continue;
    }
    i++;
  }
  return out.reverse();
}

function isStaticIdentityish(tr: TR) {
  if ([tr.anchor, tr.position, tr.scale, tr.rotation, tr.opacity].some(isAnimated)) return false;
  const s = tr.scale.v, r = tr.rotation.v[0], o = tr.opacity.v[0];
  return Math.abs(s[0] - 100) < 1e-9 && Math.abs(s[1] - 100) < 1e-9 && Math.abs(r) < 1e-9 && Math.abs(o - 100) < 1e-9;
}

/**
 * build a shape layer. `tr` is the ae layer transform. returns a single primitive layer
 * when the content is one rect/ellipse/path (through translation-only groups), otherwise
 * a group layer with one child layer per shape primitive / group.
 */
export function buildShapeLayer(ctx: BuildCtx, name: string, items: ShapeNode[], tr: TR): Layer {
  // try to collapse: descend through single static translation-only groups
  let offset = [0, 0];
  let cur = items.filter(n => n.kind !== 'group' || n.items.length);
  for (let guard = 0; guard < 32; guard++) {
    const groups = cur.filter(n => n.kind === 'group');
    const others = cur.filter(n => n.kind !== 'group');
    if (groups.length === 1 && others.length === 0 && isStaticIdentityish((groups[0] as any).tr)) {
      const g = groups[0] as Extract<ShapeNode, { kind: 'group' }>;
      offset = [offset[0] + g.tr.position.v[0] - g.tr.anchor.v[0], offset[1] + g.tr.position.v[1] - g.tr.anchor.v[1]];
      cur = g.items;
      continue;
    }
    break;
  }
  const prims = cur.filter(isPrim);
  const paints = cur.filter(isPaint);
  if (prims.length === 1 && cur.every(n => isPrim(n) || isMod(n)) && paints.length && cur.indexOf(prims[0]) < cur.indexOf(paints[0])) {
    const tmp = new BuildCtx(ctx.compW, ctx.compH);
    const kids = groupItems(tmp, cur, []);
    if (kids.length === 1) {
      const l = kids[0];
      // fold: layer T(p)RS T(-a) · T(c+offset) T(-k)  =>  anchor' = a - c - offset + k
      const c = l.props.position!, k = l.props.anchor!;
      l.props.anchor = combineProps([tr.anchor, c, k], [2, 2, 2], ([a, cc, kk]) => [a[0] - cc[0] - offset[0] + kk[0], a[1] - cc[1] - offset[1] + kk[1]]);
      l.props.position = tr.position;
      l.props.scale = tr.scale;
      l.props.rotation = tr.rotation;
      l.props.opacity = tr.opacity;
      l.name = name;
      ctx.layers[l.id] = l;
      ctx.count++;
      return l;
    }
  }
  const g = ctx.make('group', name, tr);
  g.props.size = sprop([ctx.compW, ctx.compH]);
  g.props.fill = sprop([1, 1, 1, 0]);
  ctx.adopt(g, groupItems(ctx, items, []));
  return g;
}

/** text layer: ae point text has its origin on the first baseline; our text box starts top-left */
export function buildTextLayer(ctx: BuildCtx, name: string, tr: TR, t: {
  content: string; fontSize: number; font: string; fontWeight?: number; italic?: boolean; color: number[]; justify: 'left' | 'center' | 'right';
  lineHeight?: number; tracking?: number; box?: { pos: number[]; size: number[] };
}): Layer {
  const fs = t.fontSize || 12;
  const lhMul = t.lineHeight ? t.lineHeight / fs : 1.2;
  const lines = t.content.split('\n');
  let size: number[], off: number[];
  if (t.box) {
    size = t.box.size.slice(0, 2);
    off = t.box.pos.slice(0, 2);
  } else {
    const longest = Math.max(1, ...lines.map(s => s.length));
    const w = Math.ceil(longest * fs * 0.62 + fs);
    const lh = fs * lhMul;
    size = [w, Math.ceil(lines.length * lh)];
    const ox = t.justify === 'center' ? -w / 2 : t.justify === 'right' ? -w : 0;
    off = [ox, -((lh - fs) / 2 + fs * 0.8)];
  }
  const ttr = { ...tr, anchor: mapProp(tr.anchor, a => [a[0] - off[0], a[1] - off[1]]) };
  const l = ctx.make('text', name, ttr);
  l.props.size = sprop(size);
  l.props.fill = sprop([t.color[0] ?? 1, t.color[1] ?? 1, t.color[2] ?? 1, t.color[3] ?? 1]);
  delete l.props.radius;
  l.text = {
    content: t.content, fontFamily: t.font || 'Inter', fontSize: fs, fontWeight: t.fontWeight ?? 400,
    fontStyle: t.italic ? 'italic' : 'normal', lineHeight: lhMul, letterSpacing: t.tracking ?? 0, align: t.justify,
  };
  return l;
}

// ---------------- parenting assembly ----------------

export interface SrcLayer {
  key: string | number;
  parent?: string | number | null;
  /** stacking index in the source, 0 = top-most */
  index: number;
  name: string;
  isNull: boolean;
  visible: boolean;
  inPoint: number;
  outPoint: number;
  tr: TR;
  /** build the visual content with the given transform; null for nothing to draw */
  build: (tr: TR) => Layer | null;
}

const WIDE_IN = -1e9, WIDE_OUT = 1e9;

/**
 * map ae parenting onto our tree. a parent with children becomes a transform-only group
 * (opacity 100, unbounded in/out, since ae parenting only inherits the transform) holding
 * the parent's own content (identity transform, own opacity + in/out) and its children,
 * all sorted by the original stacking order. returns root layers bottom -> top.
 */
export function assemble(ctx: BuildCtx, src: SrcLayer[]): Layer[] {
  const byKey = new Map<string | number, SrcLayer>();
  for (const s of src) byKey.set(s.key, s);
  const kids = new Map<string | number, SrcLayer[]>();
  const roots: SrcLayer[] = [];
  // validate parent chains in linear time (missing / cyclic parents -> root)
  const state = new Map<string | number, 1 | 2 | 3>(); // 1 visiting, 2 ok, 3 bad
  const resolve = (start: SrcLayer) => {
    const path: SrcLayer[] = [];
    let cur: SrcLayer | undefined = start;
    let cycleFrom = -1;
    while (cur) {
      const st = state.get(cur.key);
      if (st === 2 || st === 3) break;
      if (st === 1) { cycleFrom = path.indexOf(cur); break; }
      state.set(cur.key, 1);
      path.push(cur);
      cur = cur.parent != null && cur.parent !== cur.key ? byKey.get(cur.parent) : undefined;
    }
    // only the members of a cycle are bad (they become roots); the rest attach normally
    path.forEach((s, i) => state.set(s.key, cycleFrom >= 0 && i >= cycleFrom ? 3 : 2));
  };
  for (const s of src) if (!state.has(s.key)) resolve(s);
  for (const s of src) {
    const p = s.parent != null && s.parent !== s.key ? byKey.get(s.parent) : undefined;
    if (p && state.get(s.key) !== 3) {
      let arr = kids.get(p.key);
      if (!arr) kids.set(p.key, (arr = []));
      arr.push(s);
    } else roots.push(s);
  }
  const node = (s: SrcLayer): Layer | null => {
    if (ctx.count > ctx.maxLayers) return null;
    const ch = kids.get(s.key) ?? [];
    if (!ch.length) {
      const l = s.build(s.tr);
      if (!l) return null;
      l.inPoint = s.inPoint; l.outPoint = s.outPoint;
      if (!s.visible) l.visible = false;
      return l;
    }
    const g = ctx.make('group', s.name, { ...s.tr, opacity: sprop([100]) }, { inPoint: WIDE_IN, outPoint: WIDE_OUT });
    g.props.size = sprop([0, 0]);
    g.props.fill = sprop([1, 1, 1, 0]);
    const members: { idx: number; l: Layer }[] = [];
    if (!s.isNull) {
      const c = s.build(identityTR(s.tr.opacity));
      if (c) {
        c.inPoint = s.inPoint; c.outPoint = s.outPoint;
        if (!s.visible) c.visible = false;
        members.push({ idx: s.index, l: c });
      }
    }
    for (const k of ch) { const l = node(k); if (l) members.push({ idx: k.index, l }); }
    members.sort((a, b) => b.idx - a.idx);
    ctx.adopt(g, members.map(m => m.l));
    return g;
  };
  const out: { idx: number; l: Layer }[] = [];
  for (const r of roots) { const l = node(r); if (l) out.push({ idx: r.index, l }); }
  out.sort((a, b) => b.idx - a.idx);
  return out.map(o => o.l);
}

// ---------------- stacking-correct assembly with track mattes (lottie) ----------------

export interface SrcLayerX extends SrcLayer {
  /** track matte mode of this layer (lottie tt): 1 alpha, 2 alpha inverted, 3 luma, 4 luma inverted */
  matte?: number;
  /** this layer is a matte source (lottie td): never rendered on its own */
  matteSource?: boolean;
  /** explicit matte source key (lottie tp, newer exports); else the layer directly above */
  matteParent?: string | number;
  /** layer-space box used to invert a matte shape ([x, y, w, h]) */
  box?: [number, number, number, number];
  /** blend mode of the built layer */
  blend?: Layer['blend'];
}

export interface AssembleStats { mattes: number; invertedMattes: number; invertedApprox: number; lumaMattes: number }

function cloneProp(p: Prop): Prop {
  const o: Prop = { v: p.v.slice() };
  if (p.kf) o.kf = p.kf.map(k => { const n: Keyframe = { ...k, v: k.v.slice(), out: [k.out[0], k.out[1]], in: [k.in[0], k.in[1]] }; if (k.sOut) n.sOut = k.sOut.slice(); if (k.sIn) n.sIn = k.sIn.slice(); return n; });
  if (p.expr) o.expr = p.expr;
  return o;
}

/** invert a path layer's coverage inside `box` (layer space of the path's parent): box + path, even-odd */
function invertPathLayer(l: Layer, box: [number, number, number, number]): boolean {
  if (l.type !== 'path' || !l.geometry || l.children.length) return false;
  if (isAnimated(l.props.position) || isAnimated(l.props.size)) return false;
  const pos = l.props.position!.v, anc = l.props.anchor?.v ?? [0, 0];
  const sc = l.props.scale?.v ?? [100, 100], rot = l.props.rotation?.v[0] ?? 0;
  if (isAnimated(l.props.scale) || isAnimated(l.props.rotation) || isAnimated(l.props.anchor) || Math.abs(rot) > 1e-9) return false;
  const gs = l.geomSize ?? [1, 1], sz = l.props.size!.v;
  const sx = sc[0] / 100, sy = sc[1] / 100, gx = gs[0] ? sz[0] / gs[0] : 1, gy = gs[1] ? sz[1] / gs[1] : 1;
  if (!sx || !sy || !gx || !gy) return false;
  // parent space -> layer box -> geometry space (local = T(pos) S T(-anc), geometry scaled by size/geomSize)
  const toG = (x: number, y: number): [number, number] => [((x - pos[0]) / sx + anc[0]) / gx, ((y - pos[1]) / sy + anc[1]) / gy];
  const [x0, y0] = toG(box[0], box[1]), [x1, y1] = toG(box[0] + box[2], box[1] + box[3]);
  const rect: PathGeometry = { cmds: rectCmds(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)), fillRule: 'evenodd' };
  // geometry outside [0, geomSize] is fine for the rasterizer (bounds come from the geometry)
  l.geometry = [rect, ...l.geometry.map(g => ({ ...g, fillRule: 'evenodd' as const }))];
  if (l.pathKf) l.pathKf = l.pathKf.map(k => ({ ...k, geometry: [rect, ...k.geometry.map(g => ({ ...g, fillRule: 'evenodd' as const }))] }));
  return true;
}

/**
 * a layer whose masks were built as nested [mask, rest] groups cannot be used inside a mask
 * (masks inside a mask subtree are not applied). its alpha is the product of the mask
 * coverages and the content alpha, so split it into pieces (each under a copy of the layer
 * transform) that are applied as successive masks.
 */
function splitMasked(ctx: BuildCtx, l: Layer): Layer[] {
  if (l.type !== 'group' || l.children.length !== 2) return [l];
  const [m, rest] = l.children.map(id => ctx.layers[id]);
  if (!m?.mask || !rest) return [l];
  m.mask = false;
  const wrap = (child: Layer) => {
    const g = ctx.make('group', l.name, { anchor: cloneProp(l.props.anchor!), position: cloneProp(l.props.position!), scale: cloneProp(l.props.scale!), rotation: cloneProp(l.props.rotation!), opacity: cloneProp(l.props.opacity!) }, { inPoint: l.inPoint, outPoint: l.outPoint });
    g.props.size = sprop([0, 0]);
    g.props.fill = sprop([1, 1, 1, 0]);
    child.parent = null;
    ctx.adopt(g, [child]);
    return g;
  };
  const restPieces = splitMasked(ctx, rest);
  delete ctx.layers[l.id];
  return [wrap(m), ...restPieces.map(wrap)];
}

/**
 * map ae parenting + stacking onto our tree, keeping the exact ae stacking order: every
 * visual layer is placed in stacking order inside copies of its parent chain (transform-only
 * groups, opacity 100, unbounded in/out). consecutive layers sharing a parent chain share the
 * wrapper groups, so the common "null with children directly above it" case stays one group.
 * track mattes: content + matte source go into a unit group whose bottom child is a mask
 * wrapper (mask: true, always visible) holding the matte layer, so a matte outside its in/out
 * hides the content like in after effects.
 */
export function assembleStacked(ctx: BuildCtx, src: SrcLayerX[], stats?: AssembleStats): Layer[] {
  const byKey = new Map<string | number, SrcLayerX>();
  for (const s of src) byKey.set(s.key, s);
  // valid parent chains (cycles / missing parents -> root)
  const chainOf = new Map<string | number, SrcLayerX[]>();
  const parentOf = (s: SrcLayerX) => (s.parent != null && s.parent !== s.key ? byKey.get(s.parent) : undefined);
  const inCycle = (s: SrcLayerX) => {
    const seen = new Set<string | number>();
    for (let cur = parentOf(s); cur && !seen.has(cur.key); cur = parentOf(cur)) { if (cur.key === s.key) return true; seen.add(cur.key); }
    return false;
  };
  // members of a parent cycle become roots; layers parented to them attach normally
  const chain = (s: SrcLayerX): SrcLayerX[] => {
    const hit = chainOf.get(s.key);
    if (hit) return hit;
    chainOf.set(s.key, []); // guard
    const p = parentOf(s);
    const res = !p || inCycle(s) ? [] : [...chain(p), p];
    chainOf.set(s.key, res);
    return res;
  };
  const hasKids = new Set<string | number>();
  for (const s of src) for (const p of chain(s)) hasKids.add(p.key);

  const roots: Layer[] = [];
  const open: { key: string | number; g: Layer }[] = [];
  const container = () => (open.length ? open[open.length - 1].g : null);
  const put = (l: Layer) => { const c = container(); if (c) ctx.adopt(c, [l]); else roots.push(l); };
  const wrapper = (p: SrcLayerX) => {
    const g = ctx.make('group', p.name, { anchor: cloneProp(p.tr.anchor), position: cloneProp(p.tr.position), scale: cloneProp(p.tr.scale), rotation: cloneProp(p.tr.rotation), opacity: sprop([100]) }, { inPoint: WIDE_IN, outPoint: WIDE_OUT });
    g.props.size = sprop([0, 0]);
    g.props.fill = sprop([1, 1, 1, 0]);
    return g;
  };
  const enter = (ch: SrcLayerX[]) => {
    let k = 0;
    while (k < open.length && k < ch.length && open[k].key === ch[k].key) k++;
    open.length = k;
    for (; k < ch.length; k++) { const g = wrapper(ch[k]); put(g); open.push({ key: ch[k].key, g }); }
  };
  /** wrap a built layer in fresh copies of (part of) its parent chain */
  const wrapChain = (l: Layer, ch: SrcLayerX[]): Layer => {
    let cur = l;
    for (let i = ch.length - 1; i >= 0; i--) { const g = wrapper(ch[i]); ctx.adopt(g, [cur]); cur = g; }
    return cur;
  };
  const finish = (s: SrcLayerX, l: Layer) => {
    l.inPoint = s.inPoint; l.outPoint = s.outPoint;
    if (!s.visible) l.visible = false;
    if (s.blend && s.blend !== 'normal') l.blend = s.blend;
    return l;
  };
  const sorted = src.slice().sort((a, b) => b.index - a.index); // bottom -> top
  const byIndex = new Map<number, SrcLayerX>();
  for (const s of src) byIndex.set(s.index, s);
  for (const s of sorted) {
    if (ctx.count > ctx.maxLayers) break;
    if (s.matteSource) continue;
    const ch = chain(s);
    let matteSrc: SrcLayerX | undefined;
    if (s.matte) {
      matteSrc = s.matteParent != null ? byKey.get(s.matteParent) : byIndex.get(s.index - 1);
      if (matteSrc && !matteSrc.matteSource && s.matteParent == null) matteSrc = undefined;
    }
    if (matteSrc && !matteSrc.isNull) {
      const content = s.build(s.tr);
      if (!content) continue;
      finish(s, content);
      const mch = chain(matteSrc);
      let k = 0;
      while (k < ch.length && k < mch.length && ch[k].key === mch[k].key) k++;
      enter(ch.slice(0, k));
      const unit = ctx.make('group', s.name + ' (matte)', identityTR(), { inPoint: WIDE_IN, outPoint: WIDE_OUT });
      unit.props.size = sprop([0, 0]);
      unit.props.fill = sprop([1, 1, 1, 0]);
      const mw = ctx.make('group', matteSrc.name, identityTR(), { inPoint: WIDE_IN, outPoint: WIDE_OUT, mask: true });
      mw.props.size = sprop([0, 0]);
      mw.props.fill = sprop([1, 1, 1, 0]);
      const ml = matteSrc.build(matteSrc.tr);
      let pieces: Layer[] = [];
      if (ml) {
        ml.inPoint = matteSrc.inPoint; ml.outPoint = matteSrc.outPoint;
        const inv = s.matte === 2 || s.matte === 4;
        if ((s.matte ?? 0) >= 3 && stats) stats.lumaMattes++;
        if (inv) {
          if (stats) stats.invertedMattes++;
          if (!invertPathLayer(ml, matteSrc.box ?? [-ctx.compW, -ctx.compH, ctx.compW * 3, ctx.compH * 3])) {
            // cannot invert this matte: show the content unmasked (approximation)
            if (stats) stats.invertedApprox++;
            delete ctx.layers[ml.id];
            put(wrapChain(content, ch.slice(k)));
            continue;
          }
          pieces = [ml];
        } else pieces = splitMasked(ctx, ml);
      }
      if (stats) stats.mattes++;
      // one mask level per piece (alpha multiplies), content innermost
      let cur = unit;
      pieces.forEach((pc, i) => {
        const w = i === 0 ? mw : ctx.make('group', matteSrc!.name, identityTR(), { inPoint: WIDE_IN, outPoint: WIDE_OUT, mask: true });
        w.props.size = sprop([0, 0]);
        w.props.fill = sprop([1, 1, 1, 0]);
        ctx.adopt(w, [wrapChain(pc, mch.slice(k))]);
        if (i === pieces.length - 1) ctx.adopt(cur, [w, wrapChain(content, ch.slice(k))]);
        else {
          const g = ctx.make('group', s.name + ' (matte ' + (i + 2) + ')', identityTR(), { inPoint: WIDE_IN, outPoint: WIDE_OUT });
          g.props.size = sprop([0, 0]);
          g.props.fill = sprop([1, 1, 1, 0]);
          ctx.adopt(cur, [w, g]);
          cur = g;
        }
      });
      if (!pieces.length) ctx.adopt(unit, [mw, wrapChain(content, ch.slice(k))]);
      put(unit);
      continue;
    }
    if (s.isNull) {
      if (hasKids.has(s.key)) continue; // represented by its children's wrapper groups
      const l = s.build(s.tr);
      if (!l) continue;
      enter(ch);
      put(finish(s, l));
      continue;
    }
    enter(ch);
    const l = s.build(s.tr);
    if (l) put(finish(s, l));
  }
  return roots;
}

/** clamp absurd in/out values and convert wide markers */
export function finalizeTimes(layers: Record<string, Layer>) {
  for (const l of Object.values(layers)) {
    if (l.inPoint <= WIDE_IN) l.inPoint = -1e9;
    if (l.outPoint >= WIDE_OUT) l.outPoint = 1e9;
  }
}

// ======================================================================================
// lottie specifics
// ======================================================================================

function num(x: any, d = 0): number { return typeof x === 'number' && isFinite(x) ? x : d; }
function avg(x: any, d: number): number {
  if (typeof x === 'number') return x;
  if (Array.isArray(x) && x.length) { let s = 0; for (const v of x) s += num(v); return s / x.length; }
  return d;
}
function arr(x: any): number[] { return Array.isArray(x) ? x.map((v: any) => num(v)) : typeof x === 'number' ? [x] : []; }

/** fr = global frame rate; tf maps a frame of the current (pre)comp to our comp seconds */
interface LCtx { fr: number; tf: (frame: number) => number }

/**
 * convert a lottie animatable value to our prop.
 * conv maps a raw lottie value array to our value array. key times go through c.tf.
 */
function lprop(lp: any, conv: (v: number[]) => number[], def: number[], c: LCtx, spatial = false): Prop {
  if (lp == null) return sprop(def);
  const k = lp.k;
  const animated = Array.isArray(k) && k.length > 0 && typeof k[0] === 'object' && k[0] !== null && 't' in k[0];
  if (!animated) {
    const v = arr(k);
    return sprop(v.length ? conv(v) : def);
  }
  const out: Keyframe[] = [];
  let prevEnd: number[] | null = null;
  for (let i = 0; i < k.length; i++) {
    const key = k[i];
    let raw = key.s !== undefined ? arr(key.s) : prevEnd;
    if (!raw || !raw.length) raw = out.length ? null : def;
    if (key.e !== undefined) prevEnd = arr(key.e);
    if (!raw) continue;
    const kf: Keyframe = {
      t: c.tf(num(key.t)),
      v: conv(raw),
      interp: key.h === 1 ? 'hold' : 'bezier',
      out: key.o ? [avg(key.o.x, 0.333), avg(key.o.y, 0)] : [0.333, 0],
      in: [0.667, 1],
    };
    const prev = i > 0 ? k[i - 1] : null;
    if (prev?.i) kf.in = [avg(prev.i.x, 0.667), avg(prev.i.y, 1)];
    if (spatial) {
      if (Array.isArray(key.to) && (num(key.to[0]) || num(key.to[1]))) kf.sOut = [num(key.to[0]), num(key.to[1])];
      if (prev && Array.isArray(prev.ti) && (num(prev.ti[0]) || num(prev.ti[1]))) kf.sIn = [num(prev.ti[0]), num(prev.ti[1])];
    }
    out.push(kf);
  }
  // linear detection: segment handles on the diagonal
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i], b = out[i + 1];
    if (a.interp === 'bezier' && Math.abs(a.out[0] - a.out[1]) < 1e-9 && Math.abs(b.in[0] - b.in[1]) < 1e-9) a.interp = 'linear';
  }
  // last key: only its own o/i (when present) can say anything about its interpolation
  const lastRaw = k[k.length - 1], last = out[out.length - 1];
  if (last && lastRaw?.o && lastRaw?.i && last.interp === 'bezier' && Math.abs(avg(lastRaw.o.x, 0) - avg(lastRaw.o.y, 1)) < 1e-9 && Math.abs(avg(lastRaw.i.x, 0) - avg(lastRaw.i.y, 1)) < 1e-9) last.interp = 'linear';
  if (!out.length) return sprop(def);
  return normalizeProp({ v: out[0].v.slice(), kf: out });
}

function v2(v: number[]): number[] { return [v[0] ?? 0, v[1] ?? v[0] ?? 0]; }

function color01(v: number[]): number[] {
  const big = v.slice(0, 3).some(x => x > 1);
  const s = big ? 1 / 255 : 1;
  return [(v[0] ?? 0) * s, (v[1] ?? 0) * s, (v[2] ?? 0) * s, v.length > 3 ? (big && v[3] > 1 ? v[3] / 255 : v[3]) : 1];
}

function hexColor(s: any): number[] {
  if (typeof s !== 'string') return [0, 0, 0, 1];
  const h = s.replace('#', '');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  if (h.length >= 6) return [n(0), n(2), n(4), h.length >= 8 ? n(6) : 1];
  if (h.length === 3) return [0, 1, 2].map(i => parseInt(h[i] + h[i], 16) / 255).concat(1);
  return [0, 0, 0, 1];
}

function ltransform(ks: any, c: LCtx): TR {
  ks = ks ?? {};
  let position: Prop;
  if (ks.p && ks.p.s) {
    const x = lprop(ks.p.x, v => [v[0]], [0], c), y = lprop(ks.p.y, v => [v[0]], [0], c);
    position = combineProps([x, y], [1, 1], ([a, b]) => [a[0], b[0]]);
  } else position = withExpr(lprop(ks.p, v2, [0, 0], c, true), ks.p);
  return {
    anchor: lprop(ks.a, v2, [0, 0], c),
    position,
    scale: withExpr(lprop(ks.s, v2, [100, 100], c), ks.s),
    rotation: withExpr(lprop(ks.r ?? ks.rz, v => [v[0]], [0], c), ks.r ?? ks.rz),
    opacity: withExpr(lprop(ks.o, v => [v[0]], [100], c), ks.o),
  };
}

// identifiers our expression language understands (see core/expr.ts)
const EXPR_IDS = new Set(['value', 'time', 'index', 'fps', 'frameRate', 'duration', 'inPoint', 'PI', 'loopOut', 'loopIn', 'wiggle', 'clamp', 'linear', 'ease', 'easeIn', 'easeOut',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'abs', 'min', 'max', 'floor', 'ceil', 'round', 'sqrt', 'pow', 'exp', 'log', 'mod', 'random', 'noise', 'valueAtTime', 'length', 'normalize']);

/**
 * map a bodymovin expression (`x`) onto our safe mini language when it is a single
 * `$bm_rt = <expr>;` using only things we support (loopOut, wiggle, clamp(value..), time math).
 * anything referencing other layers, effects or js is dropped (keyframes still play).
 */
export function lottieExpr(x: any): string | undefined {
  if (typeof x !== 'string') return undefined;
  const body = x.replace(/^\s*var\s+\$bm_rt\s*;\s*/, '').trim();
  const m = /^\$bm_rt\s*=\s*([^;]*?)\s*;?\s*$/.exec(body);
  if (!m) return undefined;
  const e = m[1].replace(/\bthisProperty\./g, '').replace(/\bMath\./g, '').replace(/"/g, "'");
  const ids = e.replace(/'[^']*'/g, '').match(/[A-Za-z_$][\w$]*/g) ?? [];
  if (!ids.every(id => EXPR_IDS.has(id))) return undefined;
  if (compileExpr(e).error) return undefined;
  return e;
}

function withExpr(p: Prop, lp: any): Prop {
  const e = lottieExpr(lp?.x);
  if (e) p.expr = e;
  return p;
}

/** keyframed lottie shape (sh ks / mask pt) -> path source with keys */
function lpathSrc(lp: any, c: LCtx, closed?: boolean): PathSrc {
  const k = lp?.k;
  const animated = Array.isArray(k) && k.length > 0 && typeof k[0] === 'object' && k[0] !== null && 't' in k[0];
  // old exports put `closed` on the shape item instead of `c` on each shape
  const shape = (s: any) => { const v = Array.isArray(s) ? s[0] : s; return closed !== undefined && v && typeof v === 'object' && v.c === undefined ? { ...v, c: closed } : v; };
  if (!animated) return { cmds: lpathCmds(shape(k)) };
  const keys: PathAnimKey[] = [];
  let prevEnd: any = null;
  for (let i = 0; i < k.length; i++) {
    const key = k[i];
    const raw = key.s !== undefined ? shape(key.s) : prevEnd;
    if (key.e !== undefined) prevEnd = shape(key.e);
    if (!raw || typeof raw !== 'object') continue;
    const prev = i > 0 ? k[i - 1] : null;
    keys.push({
      t: c.tf(num(key.t)), cmds: lpathCmds(raw), interp: key.h === 1 ? 'hold' : 'bezier',
      out: key.o ? [avg(key.o.x, 0.333), avg(key.o.y, 0)] : [0.333, 0],
      in: prev?.i ? [avg(prev.i.x, 0.667), avg(prev.i.y, 1)] : [0.667, 1],
    });
  }
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (a.interp === 'bezier' && Math.abs(a.out[0] - a.out[1]) < 1e-9 && Math.abs(b.in[0] - b.in[1]) < 1e-9) a.interp = 'linear';
  }
  if (!keys.length) return { cmds: [] };
  if (keys.length === 1 || keys.every(kk => cmdsEqual(kk.cmds, keys[0].cmds))) return { cmds: keys[0].cmds };
  return { cmds: keys[0].cmds, keys };
}

function lpathCmds(sh: any): PathCmd[] {
  if (!sh || typeof sh !== 'object' || !Array.isArray(sh.v) || !sh.v.length) return [];
  const v = sh.v, ti = Array.isArray(sh.i) ? sh.i : [], to = Array.isArray(sh.o) ? sh.o : [];
  const n = v.length;
  const X = (p: any, d: number) => (Array.isArray(p) ? num(p[d]) : 0);
  const cmds: PathCmd[] = [['M', X(v[0], 0), X(v[0], 1)]];
  const seg = (a: number, b: number) => {
    const ax = X(v[a], 0), ay = X(v[a], 1), bx = X(v[b], 0), by = X(v[b], 1);
    cmds.push(['C', ax + X(to[a], 0), ay + X(to[a], 1), bx + X(ti[b], 0), by + X(ti[b], 1), bx, by]);
  };
  for (let k = 0; k < n - 1; k++) seg(k, k + 1);
  if (sh.c) { if (n > 1) seg(n - 1, 0); cmds.push(['Z']); }
  return cmds;
}

function cmdsEqual(a: PathCmd[], b: PathCmd[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.length !== y.length || x[0] !== y[0]) return false;
    for (let k = 1; k < x.length; k++) if (x[k] !== y[k]) return false;
  }
  return true;
}

function starCmds(sr: any): PathCmd[] {
  const pts = Math.max(3, Math.round(num(sr.pt?.k?.[0]?.s?.[0] ?? sr.pt?.k, 5)));
  const p = arr(sr.p?.k?.[0]?.s ?? sr.p?.k);
  const cx = p[0] ?? 0, cy = p[1] ?? 0;
  const or = num(sr.or?.k?.[0]?.s?.[0] ?? sr.or?.k, 50), ir = num(sr.ir?.k?.[0]?.s?.[0] ?? sr.ir?.k, 25);
  const rot = num(sr.r?.k?.[0]?.s?.[0] ?? sr.r?.k, 0) * Math.PI / 180;
  const star = sr.sy !== 2;
  const n = star ? pts * 2 : pts;
  const cmds: PathCmd[] = [];
  for (let i = 0; i < n; i++) {
    const r = star && i % 2 ? ir : or;
    const a = rot + (i / n) * Math.PI * 2 - Math.PI / 2;
    cmds.push([i ? 'L' : 'M', cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  cmds.push(['Z']);
  return cmds;
}

function lgradStops(g: any): { pos: number; color: [number, number, number, number] }[] {
  const n = num(g?.p, 0);
  let raw = g?.k?.k;
  if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object') raw = raw[0]?.s;
  const a = arr(raw);
  if (!n || a.length < n * 4) return [{ pos: 0, color: [0, 0, 0, 1] }, { pos: 1, color: [1, 1, 1, 1] }];
  const stops: { pos: number; color: [number, number, number, number] }[] = [];
  for (let i = 0; i < n; i++) stops.push({ pos: a[i * 4], color: [a[i * 4 + 1], a[i * 4 + 2], a[i * 4 + 3], 1] });
  // optional opacity stops (pos, alpha pairs): sample at each colour stop position
  const op = a.slice(n * 4);
  if (op.length >= 4) {
    const alphaAt = (p: number) => {
      for (let j = 0; j + 3 < op.length; j += 2) {
        if (p <= op[j + 2]) {
          const t = op[j + 2] - op[j] > 0 ? (p - op[j]) / (op[j + 2] - op[j]) : 0;
          return op[j + 1] + (op[j + 3] - op[j + 1]) * Math.min(1, Math.max(0, t));
        }
      }
      return op[op.length - 1];
    };
    for (const s of stops) s.color[3] = alphaAt(s.pos);
  }
  return stops;
}

function firstStatic(lp: any, def: number[]): number[] {
  const k = lp?.k;
  if (Array.isArray(k) && k.length && typeof k[0] === 'object' && k[0] && 't' in k[0]) return arr(k[0].s ?? def);
  const v = arr(k);
  return v.length ? v : def;
}

function lshapes(items: any[], c: LCtx): ShapeNode[] {
  const out: ShapeNode[] = [];
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    if (!it || it.hd === true) continue;
    const name = typeof it.nm === 'string' ? it.nm : '';
    try {
      switch (it.ty) {
        case 'gr': {
          const tr = (it.it ?? []).find((x: any) => x?.ty === 'tr');
          out.push({ kind: 'group', name: name || 'Group', tr: ltransform(tr, c), items: lshapes((it.it ?? []).filter((x: any) => x?.ty !== 'tr'), c) });
          break;
        }
        case 'rc':
          out.push({ kind: 'rect', name: name || 'Rectangle', size: lprop(it.s, v2, [100, 100], c), position: lprop(it.p, v2, [0, 0], c), roundness: lprop(it.r, v => [v[0]], [0], c) });
          break;
        case 'el':
          out.push({ kind: 'ellipse', name: name || 'Ellipse', size: lprop(it.s, v2, [100, 100], c), position: lprop(it.p, v2, [0, 0], c) });
          break;
        case 'sh': {
          const src = lpathSrc(it.ks, c, typeof it.closed === 'boolean' ? it.closed : undefined);
          out.push({ kind: 'path', name: name || 'Path', cmds: src.cmds, keys: src.keys });
          break;
        }
        case 'tm':
          out.push({ kind: 'trim', name: name || 'Trim Paths', start: lprop(it.s, v => [v[0]], [0], c), end: lprop(it.e, v => [v[0]], [100], c), offset: lprop(it.o, v => [v[0]], [0], c) });
          break;
        case 'sr':
          out.push({ kind: 'path', name: name || 'Polystar', cmds: starCmds(it) });
          break;
        case 'fl':
          out.push({ kind: 'fill', name: name || 'Fill', color: lprop(it.c, color01, [1, 1, 1, 1], c), opacity: lprop(it.o, v => [v[0]], [100], c), rule: it.r === 2 ? 'evenodd' : 'nonzero' });
          break;
        case 'st':
          out.push({ kind: 'stroke', name: name || 'Stroke', color: lprop(it.c, color01, [1, 1, 1, 1], c), opacity: lprop(it.o, v => [v[0]], [100], c), width: lprop(it.w, v => [v[0]], [1], c) });
          break;
        case 'gf':
        case 'gs': {
          const node: any = {
            kind: 'gfill', name: name || 'Gradient', gtype: it.t === 2 ? 'radial' : 'linear', stops: lgradStops(it.g),
            start: firstStatic(it.s, [0, 0]), end: firstStatic(it.e, [100, 0]), opacity: lprop(it.o, v => [v[0]], [100], c), rule: it.r === 2 ? 'evenodd' : 'nonzero',
          };
          if (it.ty === 'gs') {
            // gradient stroke -> plain stroke with the first stop colour
            const col = node.stops[0]?.color ?? [1, 1, 1, 1];
            out.push({ kind: 'stroke', name: node.name, color: sprop(col), opacity: node.opacity, width: lprop(it.w, v => [v[0]], [1], c) });
          } else out.push(node);
          break;
        }
        default: break; // rp, mm, rd, ... unsupported modifiers are skipped
      }
    } catch { /* skip malformed shape */ }
  }
  return out;
}

const FONT_WEIGHTS: [RegExp, number][] = [[/thin|hairline/i, 100], [/extra ?light|ultra ?light/i, 200], [/light/i, 300], [/medium/i, 500], [/semi ?bold|demi/i, 600], [/extra ?bold|ultra ?bold/i, 800], [/black|heavy/i, 900], [/bold/i, 700]];
export function weightFromStyle(style: string): number {
  for (const [re, w] of FONT_WEIGHTS) if (re.test(style)) return w;
  return 400;
}

function dataUrlMime(s: string): string {
  const m = /^data:([^;,]+)/.exec(s);
  return m ? m[1] : 'image/png';
}

// ---------------- layer masks ----------------

interface MaskPart { srcs: PathSrc[]; rule: 'nonzero' | 'evenodd' }
interface MaskRegion { parts: MaskPart[]; opacity: Prop }

/**
 * lottie masksProperties -> a list of regions whose INTERSECTION is the visible area. each
 * region is a union of parts (separate fills); a part is one path (nonzero) or an even-odd
 * compound (inverted / subtracted shapes: layer box + path). modes: a add (new part in the
 * current region), s subtract (new inverted region), i intersect (new region), f difference
 * (approx: even-odd with the last part), n none. the first mask starts from empty, except
 * subtract which starts from the full layer.
 */
function maskRegions(masks: any[], c: LCtx, box: [number, number, number, number]): MaskRegion[] {
  const boxSrc: PathSrc = { cmds: rectCmds(box[0], box[1], box[2], box[3]) };
  const regions: MaskRegion[] = [];
  for (const m of masks) {
    if (!m || typeof m !== 'object') continue;
    const mode = typeof m.mode === 'string' ? m.mode : 'a';
    if (mode === 'n') continue;
    const src = lpathSrc(m.pt, c, m.cl !== false);
    if (!src.cmds.length) continue;
    const opacity = lprop(m.o, v => [v[0]], [100], c);
    const shape = (): MaskPart => (m.inv ? { srcs: [boxSrc, src], rule: 'evenodd' } : { srcs: [src], rule: 'nonzero' });
    const inverse = (): MaskPart => (m.inv ? { srcs: [src], rule: 'nonzero' } : { srcs: [boxSrc, src], rule: 'evenodd' });
    if (!regions.length || mode === 's' || mode === 'i') {
      regions.push({ parts: [mode === 's' ? inverse() : shape()], opacity });
      continue;
    }
    const last = regions[regions.length - 1];
    if (mode === 'f') {
      const lp = last.parts[last.parts.length - 1];
      lp.srcs.push(...shape().srcs);
      lp.rule = 'evenodd';
    } else last.parts.push(shape());
  }
  return regions;
}

function regionLayer(ctx: BuildCtx, name: string, r: MaskRegion, fill: PaintNode): Layer {
  const srcs = r.parts.flatMap(p => p.srcs);
  const anim = srcs.filter(x => x.keys && x.keys.length > 1);
  const sameTimes = anim.every(x => x.keys!.length === anim[0].keys!.length && x.keys!.every((k, i) => Math.abs(k.t - anim[0].keys![i].t) < 1e-6));
  if (r.parts.length > 1 && !sameTimes) {
    // parts animated on different key times: one path layer per part (exact keys, no
    // resampling) in a group whose opacity carries the mask opacity (a union of alphas)
    const g = ctx.make('group', name, { ...identityTR(), opacity: (fill as any).opacity }, {});
    g.props.size = sprop([0, 0]);
    g.props.fill = sprop([1, 1, 1, 0]);
    const solidFill = { ...fill, opacity: sprop([100]) } as PaintNode;
    ctx.adopt(g, r.parts.map(p => pathLayer(ctx, name, p.srcs, { ...solidFill, rule: p.rule } as PaintNode, undefined, undefined, p.rule)));
    return g;
  }
  return pathLayer(ctx, name, srcs, fill, undefined, undefined, undefined, r.parts.map(p => ({ n: p.srcs.length, rule: p.rule })));
}

function whiteFill(opacity: Prop, rule: 'nonzero' | 'evenodd'): PaintNode {
  return { kind: 'fill', name: 'Mask', color: sprop([1, 1, 1, 1]), opacity, rule };
}

/** move a layer built at the origin of its parent space under the layer transform `t` */
function foldTransform(l: Layer, t: TR) {
  const c = l.props.position!.v, k = l.props.anchor!.v;
  l.props.anchor = mapProp(t.anchor, a => [a[0] - c[0] + k[0], a[1] - c[1] + k[1]]);
  l.props.position = t.position;
  l.props.scale = t.scale;
  l.props.rotation = t.rotation;
  const own = l.props.opacity!;
  l.props.opacity = isAnimated(own) || own.v[0] !== 100 ? combineProps([t.opacity, own], [1, 1], ([a, b]) => [(a[0] * b[0]) / 100]) : t.opacity;
}

/**
 * apply layer masks: a solid with one region becomes the masked path itself (no offscreen
 * pass, and it works inside matte sources). otherwise: group(layer transform) holding one
 * mask path layer per region, nested so the regions intersect, and the content innermost.
 */
function withMasks(ctx: BuildCtx, name: string, regions: MaskRegion[], t: TR, solid: number[] | null, content: (t: TR) => Layer | null): Layer | null {
  if (solid && regions.length === 1) {
    const r = regions[0];
    const fill: PaintNode = { kind: 'fill', name: 'Fill', color: sprop(solid), opacity: r.opacity, rule: 'nonzero' };
    const l = regionLayer(ctx, name, r, fill);
    foldTransform(l, t);
    return l;
  }
  const outer = ctx.make('group', name, { ...t, opacity: sprop([100]) });
  outer.props.size = sprop([0, 0]);
  outer.props.fill = sprop([1, 1, 1, 0]);
  let cur = outer;
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const m = regionLayer(ctx, 'Mask', r, whiteFill(r.opacity, 'nonzero'));
    m.mask = true;
    m.inPoint = WIDE_IN; m.outPoint = WIDE_OUT;
    if (i === regions.length - 1) {
      const inner = content(identityTR(t.opacity));
      ctx.adopt(cur, inner ? [m, inner] : [m]);
    } else {
      const g = ctx.make('group', name + ' mask ' + (i + 2), identityTR(), { inPoint: WIDE_IN, outPoint: WIDE_OUT });
      g.props.size = sprop([0, 0]);
      g.props.fill = sprop([1, 1, 1, 0]);
      ctx.adopt(cur, [m, g]);
      cur = g;
    }
  }
  return outer;
}

/**
 * shape / text layers have no bounds of their own: the area a subtract / inverted mask keeps is
 * the comp (mapped into layer space with the layer's first transform values) plus margin.
 */
function compBoxInLayer(tr: TR, cw: number, ch: number): [number, number, number, number] {
  const p = firstValue(tr.position), a = firstValue(tr.anchor), sc = firstValue(tr.scale);
  const sx = Math.abs(sc[0]) / 100 || 1, sy = Math.abs(sc[1]) / 100 || 1;
  const r = Math.abs(firstValue(tr.rotation)[0] ?? 0) % 180 > 1e-6;
  let x0 = (0 - p[0]) / sx + a[0], y0 = (0 - p[1]) / sy + a[1], x1 = (cw - p[0]) / sx + a[0], y1 = (ch - p[1]) / sy + a[1];
  if (r) { const m = Math.max(x1 - x0, y1 - y0); const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; x0 = cx - m; x1 = cx + m; y0 = cy - m; y1 = cy + m; }
  const px = (x1 - x0) * 0.1, py = (y1 - y0) * 0.1;
  return [x0 - px, y0 - py, x1 - x0 + 2 * px, y1 - y0 + 2 * py];
}

/** lottie layer blend mode (bm) -> ours; unsupported modes render normal and are counted */
function blendMode(bm: any, note: (k: string) => void): Layer['blend'] {
  switch (bm) {
    case undefined: case null: case 0: return undefined;
    case 1: return 'multiply';
    case 2: return 'screen';
    case 4: return 'darken';
    case 5: return 'lighten';
    case 16: return 'add';
    default: note('blend mode ' + bm); return undefined;
  }
}

// ---------------- precomp time ----------------

/**
 * frame mapping for the layers inside a precomp layer L of the comp mapped by c:
 * without time remap an inner frame k plays at parent frame st + k * sr. with time remap (tm,
 * seconds of the precomp as a function of the parent frame) we invert the sampled remap curve
 * (first crossing; constant stretches map to a near-frozen time).
 */
function precompTf(L: any, c: LCtx, lip: number, lop: number): (k: number) => number {
  const st = num(L.st, 0), sr = num(L.sr, 1) || 1;
  if (!L.tm || L.tm.k === undefined) return k => c.tf(st + k * sr);
  const fr = c.fr;
  const tmp = lprop(L.tm, v => [v[0]], [0], { fr, tf: f => f }); // keyed in parent frames
  if (!isAnimated(tmp)) {
    const v = tmp.v[0] * fr;
    const t0 = c.tf(lip);
    return k => t0 + (k - v) * 1e4; // frozen frame: everything else is far away in time
  }
  const n = Math.max(2, Math.min(4000, Math.ceil(lop - lip) + 1));
  const F0 = lip, step = (lop - lip) / (n - 1) || 1;
  const tau = new Float64Array(n);
  for (let i = 0; i < n; i++) tau[i] = evalProp(tmp, F0 + i * step, 1, [0])[0] * fr;
  return k => {
    for (let i = 0; i < n - 1; i++) {
      const a = tau[i], b = tau[i + 1];
      if (a !== b && ((a <= k && k <= b) || (b <= k && k <= a))) return c.tf(F0 + (i + (k - a) / (b - a)) * step);
    }
    // outside the remapped range: continue at normal speed before / after
    if (Math.abs(k - tau[0]) <= Math.abs(k - tau[n - 1])) return c.tf(F0 - Math.abs(k - tau[0]));
    return c.tf(F0 + (n - 1) * step + Math.abs(k - tau[n - 1]));
  };
}

/** what the importer had to approximate or skip (for reports / tests) */
export interface LottieImportStats extends AssembleStats {
  masks: number; maskRegions: number; animatedPaths: number; trims: number; expressions: number; timeRemaps: number;
  unsupported: Record<string, number>;
}

/** import a lottie / bodymovin json document (object or json string) */
export function lottieToProject(json: any, name?: string, stats?: LottieImportStats): Project {
  if (typeof json === 'string') json = JSON.parse(json);
  if (!json || typeof json !== 'object') throw new Error('invalid lottie json');
  const fr = num(json.fr, 30) || 30;
  const ip = num(json.ip, 0), op = num(json.op, ip + fr * 5);
  const w = Math.max(1, num(json.w, 512)), h = Math.max(1, num(json.h, 512));
  const ctx = new BuildCtx(w, h);
  const st: LottieImportStats = stats ?? { mattes: 0, invertedMattes: 0, invertedApprox: 0, lumaMattes: 0, masks: 0, maskRegions: 0, animatedPaths: 0, trims: 0, expressions: 0, timeRemaps: 0, unsupported: {} };
  const rootC: LCtx = { fr, tf: f => (f - ip) / fr };
  const assetsById = new Map<string, any>();
  for (const a of Array.isArray(json.assets) ? json.assets : []) if (a && a.id != null) assetsById.set(String(a.id), a);
  const imageAssets = new Map<string, string>(); // lottie id -> our asset id
  const fonts = new Map<string, any>();
  for (const f of json.fonts?.list ?? []) if (f?.fName) fonts.set(f.fName, f);
  const note = (k: string) => { st.unsupported[k] = (st.unsupported[k] ?? 0) + 1; };
  const countShapes = (items: any[]) => {
    if (!Array.isArray(items)) return;
    for (const it of items) {
      if (!it || it.hd === true) continue;
      if (it.ty === 'gr') countShapes(it.it);
      else if (it.ty === 'sh' && it.ks?.a === 1) st.animatedPaths++;
      else if (it.ty === 'tm') st.trims++;
      else if (['rp', 'rd', 'mm', 'tw', 'pb', 'op', 'zz'].includes(it.ty)) note('shape ' + it.ty);
      else if (it.ty === 'gs') note('gradient stroke');
    }
  };

  const convertLayers = (layers: any[], c: LCtx, cw: number, ch: number, depth: number): Layer[] => {
    if (!Array.isArray(layers) || depth > 16) return [];
    const src: SrcLayerX[] = [];
    layers.forEach((L, index) => {
      if (!L || typeof L !== 'object') return;
      const ty = L.ty;
      if (![0, 1, 2, 3, 4, 5].includes(ty)) return; // audio, camera, data, ... skipped
      const tr = ltransform(L.ks, c);
      for (const p of [tr.position, tr.scale, tr.rotation, tr.opacity]) if (p.expr) st.expressions++;
      const lname = typeof L.nm === 'string' ? L.nm : `Layer ${index + 1}`;
      const lip = num(L.ip, ip), lop = num(L.op, op);
      const masks = L.hasMask !== false && Array.isArray(L.masksProperties) ? L.masksProperties : [];
      if (Array.isArray(L.ef) && L.ef.length) note('effects');
      if (L.ao === 1) note('auto-orient');
      if (L.ddd === 1) note('3d layer');
      // layer-space box (for inverted masks / mattes)
      const a = ty === 0 || ty === 2 ? assetsById.get(String(L.refId)) : null;
      const box: [number, number, number, number] =
        ty === 1 ? [0, 0, num(L.sw, 100), num(L.sh, 100)]
        : ty === 0 ? [0, 0, num(L.w, num(a?.w, cw)), num(L.h, num(a?.h, ch))]
        : ty === 2 ? [0, 0, num(a?.w, 100), num(a?.h, 100)]
        : compBoxInLayer(tr, cw, ch);
      const content = (t: TR): Layer | null => {
        switch (ty) {
          case 4: countShapes(L.shapes); return buildShapeLayer(ctx, lname, lshapes(L.shapes, c), t);
          case 1: {
            const l = ctx.make('rect', lname, t);
            l.props.size = sprop([num(L.sw, 100), num(L.sh, 100)]);
            l.props.fill = sprop(hexColor(L.sc));
            return l;
          }
          case 3: {
            const l = ctx.make('group', lname, { ...t, opacity: sprop([100]) });
            l.props.size = sprop([0, 0]);
            l.props.fill = sprop([1, 1, 1, 0]);
            return l;
          }
          case 2: {
            const lw = num(a?.w, 100), lh = num(a?.h, 100);
            let ref = imageAssets.get(String(L.refId));
            const p = typeof a?.p === 'string' ? a.p : '';
            if (!ref && (a?.e === 1 || p.startsWith('data:'))) {
              ref = uid('a');
              ctx.assets[ref] = { id: ref, kind: 'image', mime: dataUrlMime(p), data: p, width: lw, height: lh };
              imageAssets.set(String(L.refId), ref);
            }
            const l = ctx.make(ref ? 'image' : 'rect', lname, t);
            l.props.size = sprop([lw, lh]);
            if (ref) { l.imageRef = ref; delete l.props.fill; delete l.props.radius; delete l.props.stroke; delete l.props.strokeWidth; }
            else l.props.fill = sprop([0.5, 0.5, 0.5, 0.5]); // external image: placeholder
            return l;
          }
          case 5: {
            const doc = L.t?.d?.k?.[0]?.s ?? {};
            const font = fonts.get(doc.f);
            const text = String(doc.t ?? '').replace(/\r\n?|\u0003/g, '\n');
            const fs = num(doc.s, 24);
            const j = num(doc.j, 0);
            return buildTextLayer(ctx, lname, t, {
              content: text, fontSize: fs, font: font?.fFamily ?? doc.f ?? 'Inter', fontWeight: weightFromStyle(String(font?.fStyle ?? doc.f ?? '')),
              italic: /italic|oblique/i.test(String(font?.fStyle ?? '')), color: color01(arr(doc.fc ?? [1, 1, 1])),
              justify: j === 1 ? 'right' : j === 2 ? 'center' : 'left', lineHeight: num(doc.lh, fs * 1.2), tracking: (num(doc.tr, 0) / 1000) * fs,
              box: Array.isArray(doc.sz) ? { pos: arr(doc.ps ?? [0, 0]), size: arr(doc.sz) } : undefined,
            });
          }
          case 0: {
            const g = ctx.make('group', lname, t, { clip: true });
            g.props.size = sprop([box[2], box[3]]);
            g.props.fill = sprop([1, 1, 1, 0]);
            if (L.tm) st.timeRemaps++;
            const inner: LCtx = { fr, tf: precompTf(L, c, lip, lop) };
            ctx.adopt(g, convertLayers(a?.layers ?? [], inner, box[2], box[3], depth + 1));
            return g;
          }
        }
        return null;
      };
      const s: SrcLayerX = {
        key: L.ind ?? `__${index}`,
        parent: L.parent ?? null,
        index,
        name: lname,
        isNull: ty === 3,
        visible: L.hd !== true,
        inPoint: c.tf(lip),
        outPoint: c.tf(lop),
        tr,
        matte: num(L.tt, 0) || undefined,
        matteSource: L.td === 1 || L.td === true,
        matteParent: L.tp ?? undefined,
        box: [0, 0, cw, ch],
        blend: blendMode(L.bm, note),
        build: (t: TR) => {
          try {
            const regions = ty === 3 ? [] : maskRegions(masks, c, box);
            if (!regions.length) return content(t);
            st.masks++;
            st.maskRegions += regions.length;
            return withMasks(ctx, lname, regions, t, ty === 1 ? hexColor(L.sc) : null, content);
          } catch { /* fall through */ }
          return null;
        },
      };
      src.push(s);
    });
    return assembleStacked(ctx, src, st);
  };

  const roots = convertLayers(json.layers ?? [], rootC, w, h, 0);
  finalizeTimes(ctx.layers);
  const comp: Composition = {
    id: uid('c'), name: typeof json.nm === 'string' && json.nm ? json.nm : name ?? 'Lottie',
    width: w, height: h, fps: fr, duration: Math.max(1 / fr, (op - ip) / fr), background: [0.07, 0.07, 0.08, 1], root: roots.map(l => l.id),
  };
  return { version: 1, name: name ?? comp.name, comps: { [comp.id]: comp }, activeComp: comp.id, layers: ctx.layers, assets: ctx.assets };
}

export type { PropKey };
