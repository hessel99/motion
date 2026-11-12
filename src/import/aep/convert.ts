// AepProject (raw, stored units) -> our Project.
//
// supported: compositions (size, fps, duration, bg colour), solids (rect), nulls (group),
// precomps (flattened into clipped groups, start-time offset applied), shape layers
// (groups with transforms + opacity / rect / ellipse / polystar / static and animated paths /
// fill / stroke / gradient fill / trim paths), text layers (first document: text, font, size,
// colour, justification, tracking, leading), file footage (grey placeholder rect, pixels are
// not embedded in .aep), ae parenting and stacking order (assembleStacked), transform
// keyframes with temporal ease (speed/influence -> normalized bezier via aeEaseToBezier),
// linear / hold, auto-bezier, spatial tangents and separated position, transform expressions
// that our safe language accepts (checkExpr), blend modes (add, multiply, screen, darken,
// lighten), layer enabled / solo, track mattes (alpha, alpha inverted; luma as alpha) and
// layer masks (add / subtract / intersect / difference, inverted, opacity, animated paths).
// verified against real files: py-aep samples (blendingMode, trackMatteType, expression,
// mask*, versions/ae2025/complete) and lottie-android "After Effects Samples" (Masks,
// HamburgerArrow, LottieLogos, MatteTimeStretch, MatteMask, TrimPathsInsideAndOutsideGroup)
// rendered next to their official lottie exports.
// skipped: cameras, lights, adjustment layers (kept only as transform parents), effects,
// mask feather / expansion, luma mattes (treated as alpha), expressions beyond the safe subset
// or on separated position, time remapping, 3D (z ignored), layer stretch inside nested comps
// (only the start offset), repeaters / merge paths / round corners, animated polystars.

import { aeEaseToBezier } from '../../core/easing';
import { checkExpr } from '../../core/expr';
import type { Keyframe, Layer, Project, Prop, PathCmd } from '../../core/model';
import { uid } from '../../core/model';
import {
  BuildCtx, assembleStacked, buildShapeLayer, buildTextLayer, combineProps, finalizeTimes, firstValue, identityTR, isAnimated, mapProp,
  normalizeProp, pathLayer, rectCmds, ellipseCmds, sprop, weightFromStyle, bezierCmds,
  type PathAnimKey, type PathSrc, type ShapeNode, type SrcLayerX, type TR,
} from '../lottie';
import {
  parseAep, child, childGroup, childStream, INTERP_HOLD, INTERP_LINEAR,
  type AepComp, type AepGroup, type AepKeyframe, type AepLayer, type AepPathProp, type AepPathValue, type AepProject, type AepStream, type AepItem, type AepFootage,
} from './parse';

const DEFAULT_INFLUENCE = 0.16666666667;

// ---------------------------------------------------------------- streams -> props

interface StreamOpts {
  /** stored value -> our value (must be linear per component for easing to stay valid) */
  conv: (v: number[]) => number[];
  /** spatial tangent conversion (defaults to conv without offset: first 2 comps) */
  tan?: (v: number[]) => number[];
  /** layer seconds -> our comp seconds */
  time: (t: number) => number;
}

function cubicLen(p0: number[], p1: number[], p2: number[], p3: number[], dims: number): number {
  let len = 0;
  let prev = p0.slice(0, dims);
  for (let s = 1; s <= 16; s++) {
    const t = s / 16, u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    const cur: number[] = [];
    for (let d = 0; d < dims; d++) cur.push(w0 * p0[d] + w1 * p1[d] + w2 * p2[d] + w3 * p3[d]);
    let q = 0;
    for (let d = 0; d < dims; d++) q += (cur[d] - prev[d]) ** 2;
    len += Math.sqrt(q);
    prev = cur;
  }
  return len;
}

const add = (a: number[], b: number[]) => a.map((x, i) => x + (b[i] ?? 0));
const sub = (a: number[], b: number[]) => a.map((x, i) => x - (b[i] ?? 0));
const scl = (a: number[], s: number) => a.map(x => x * s);
const dist = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, x, i) => s + (x - (b[i] ?? 0)) ** 2, 0));

/** resolve auto-bezier keys: temporal speeds (and spatial tangents) from neighbours */
function resolveAuto(ks: AepKeyframe[], s: AepStream): AepKeyframe[] {
  const n = ks.length;
  return ks.map((k, i) => {
    const temporalAuto = !!(k.flags & 0x10);
    const spatialAuto = s.spatial && !!(k.spatialFlags & 2);
    if (!temporalAuto && !spatialAuto) return k;
    const prev = ks[i - 1], next = ks[i + 1];
    const q: AepKeyframe = { ...k };
    if (spatialAuto && k.value.length) {
      const a = prev?.value ?? k.value, b = next?.value ?? k.value;
      const out = scl(sub(b, a), 1 / 6);
      q.outTangent = out;
      q.inTangent = scl(out, -1);
    }
    if (temporalAuto) {
      const slope = (a: AepKeyframe, b: AepKeyframe) => {
        const dt = b.time - a.time || 1;
        if (s.singleEase) return [dist(b.value, a.value) / dt];
        return b.value.map((v, d) => (v - (a.value[d] ?? 0)) / dt);
      };
      const zero = s.singleEase ? [0] : k.value.map(() => 0);
      const sp = prev && next ? slope(prev, next) : null;
      const inS = sp ?? (prev ? slope(prev, k) : zero);
      const outS = sp ?? (next ? slope(k, next) : zero);
      q.inSpeed = inS; q.outSpeed = outS;
      q.inInfluence = inS.map(() => DEFAULT_INFLUENCE);
      q.outInfluence = outS.map(() => DEFAULT_INFLUENCE);
    }
    return q;
  });
}

export function streamToProp(s: AepStream | undefined, def: number[], o: StreamOpts): Prop {
  if (!s) return sprop(def);
  const kfs = s.keyframes;
  if (!kfs || !kfs.length) return sprop(s.value && s.value.length ? o.conv(s.value) : def);
  const ks = resolveAuto(kfs.filter(k => k.value.length), s);
  if (!ks.length) return sprop(def);
  const out: Keyframe[] = ks.map(k => ({ t: o.time(k.time), v: o.conv(k.value), interp: 'bezier', out: [0.333, 0], in: [0.667, 1] }));
  const tan = o.tan ?? xy;
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1], ka = out[i], kb = out[i + 1];
    const dt = b.time - a.time;
    if (s.spatial) {
      const to = a.outTangent ?? [], ti = b.inTangent ?? [];
      if (to.some(x => x !== 0)) ka.sOut = tan(to).slice(0, 2);
      if (ti.some(x => x !== 0)) kb.sIn = tan(ti).slice(0, 2);
    }
    if (a.outInterp === INTERP_HOLD) { ka.interp = 'hold'; continue; }
    if (a.outInterp === INTERP_LINEAR && b.inInterp === INTERP_LINEAR) { ka.interp = 'linear'; continue; }
    let dv: number, so: number, io: number, si: number, ii: number;
    if (s.singleEase) {
      // one ease for the whole value: distance along the motion path / colour distance
      dv = s.spatial
        ? cubicLen(a.value, add(a.value, a.outTangent ?? []), add(b.value, b.inTangent ?? []), b.value, Math.min(3, a.value.length))
        : dist(a.value, b.value);
      so = a.outSpeed[0]; io = a.outInfluence[0]; si = b.inSpeed[0]; ii = b.inInfluence[0];
    } else {
      // per-dimension eases: use the dimension that changes most
      let best = 0, bd = -1;
      for (let d = 0; d < a.value.length; d++) { const m = Math.abs((b.value[d] ?? 0) - a.value[d]); if (m > bd) { bd = m; best = d; } }
      dv = (b.value[best] ?? 0) - a.value[best];
      so = a.outSpeed[best] ?? 0; io = a.outInfluence[best] ?? DEFAULT_INFLUENCE;
      si = b.inSpeed[best] ?? 0; ii = b.inInfluence[best] ?? DEFAULT_INFLUENCE;
    }
    // a linear side of a mixed segment acts as the average slope with influence 1/6
    const avg = dt > 0 ? dv / dt : 0;
    if (a.outInterp === INTERP_LINEAR) { so = avg; io = DEFAULT_INFLUENCE; }
    if (b.inInterp === INTERP_LINEAR) { si = avg; ii = DEFAULT_INFLUENCE; }
    const e = aeEaseToBezier(so, (io || 0) * 100, si, (ii || 0) * 100, dv, dt);
    ka.out = [e.x1, e.y1];
    kb.in = [e.x2, e.y2];
  }
  return normalizeProp({ v: out[0].v.slice(), kf: out });
}

/** stored colour (A,R,G,B in 0..255, or 0..1) -> rgba 0..1 */
export function argbToRgba(v: number[]): number[] {
  const big = v.some(x => x > 1.0000001);
  const s = big ? 1 / 255 : 1;
  if (v.length >= 4) return [v[1] * s, v[2] * s, v[3] * s, v[0] * s];
  return [(v[0] ?? 0) * s, (v[1] ?? 0) * s, (v[2] ?? 0) * s, 1];
}

const xy = (v: number[]) => [v[0] ?? 0, v[1] ?? 0];

// ---------------------------------------------------------------- expressions

/**
 * an ae expression -> our safe language (core/expr.ts), or undefined when it uses anything
 * we cannot evaluate. only single-expression bodies survive (`wiggle(2, 50)`, `time * 36`,
 * `[100 + Math.sin(time) * 20, 100]`, `loopOut('cycle')`); statements, other layers,
 * effects and comp lookups are dropped (the keyframes still play).
 */
export function aeExpr(src: string | undefined, dim: number): string | undefined {
  if (typeof src !== 'string' || src.length > 2000) return undefined;
  let e = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n\r]*/g, ' ').trim();
  e = e.replace(/;\s*$/, '').trim();
  if (!e || e.includes(';')) return undefined;
  e = e.replace(/\s+/g, ' ').replace(/\bthisProperty\./g, '').replace(/\bMath\./g, '').replace(/"/g, "'");
  return checkExpr(e, dim) === null ? e : undefined;
}

function withExpr(p: Prop, s: AepStream | undefined, dim: number): Prop {
  if (!s?.expression || s.expressionDisabled) return p;
  const e = aeExpr(s.expression, dim);
  if (e) p.expr = e;
  return p;
}

// ---------------------------------------------------------------- blend modes

/** ldta blending mode (AE SDK PF_Xfer value) -> ours; modes we cannot render stay normal */
export function aeBlend(v: number): Layer['blend'] {
  switch (v) {
    case 4: case 29: return 'add'; // add, linear dodge
    case 5: return 'multiply';
    case 6: return 'screen';
    case 10: case 36: return 'darken'; // darken, darker color
    case 11: case 35: return 'lighten'; // lighten, lighter color
    default: return undefined;
  }
}

// ---------------------------------------------------------------- paths

function valueCmds(v: AepPathValue, sx: number, sy: number): PathCmd[] {
  if (!v.vertices.length) return [];
  const S = (p: number[]) => [(p[0] ?? 0) * sx, (p[1] ?? 0) * sy];
  const vs = v.vertices.map(S);
  const ti = v.vertices.map((p0, i) => sub(S(v.inPoints[i] ?? p0), vs[i]));
  const to = v.vertices.map((p0, i) => sub(S(v.outPoints[i] ?? p0), vs[i]));
  return bezierCmds(vs, ti, to, v.closed) as PathCmd[];
}

/**
 * a path property (shape path or mask path) -> path source, animated when the stream has one
 * keyframe per stored value. path keys carry influence but no meaningful speed, so each
 * segment eases with the stored influences at zero speed (ae's default easy ease).
 */
export function pathSrc(p: AepPathProp, time: (t: number) => number, sx = 1, sy = 1): PathSrc {
  const cmds = p.values.length ? valueCmds(p.values[0], sx, sy) : [];
  const ks = p.stream?.keyframes;
  if (!ks || ks.length < 2 || ks.length !== p.values.length) return { cmds };
  const keys: PathAnimKey[] = ks.map((k, i) => ({
    t: time(k.time), cmds: valueCmds(p.values[i], sx, sy), interp: 'bezier' as Keyframe['interp'],
    out: [Math.min(1, Math.max(0.01, k.outInfluence[0] || DEFAULT_INFLUENCE)), 0] as [number, number],
    in: [1 - Math.min(1, Math.max(0.01, k.inInfluence[0] || DEFAULT_INFLUENCE)), 1] as [number, number],
  }));
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1];
    if (a.outInterp === INTERP_HOLD) keys[i].interp = 'hold';
    else if (a.outInterp === INTERP_LINEAR && b.inInterp === INTERP_LINEAR) keys[i].interp = 'linear';
    else {
      if (a.outInterp === INTERP_LINEAR) keys[i].out = [1 / 3, 1 / 3];
      if (b.inInterp === INTERP_LINEAR) keys[i + 1].in = [2 / 3, 2 / 3];
    }
  }
  return { cmds, keys };
}

// ---------------------------------------------------------------- transforms

function layerTransform(l: AepLayer, comp: AepComp, srcSize: number[] | null, time: (t: number) => number): TR {
  const t = l.transform;
  const o = { conv: xy, time };
  const pct = { conv: (v: number[]) => [(v[0] ?? 0) * 100, (v[1] ?? v[0] ?? 0) * 100], time };
  // anchor of source-backed layers may be stored as a fraction of the source size
  const as = childStream(t, 'ADBE Anchor Point');
  let anchorConv = xy;
  if (srcSize && as) {
    const vals = as.keyframes ? as.keyframes.flatMap(k => k.value.slice(0, 2)) : (as.value ?? []).slice(0, 2);
    const fractional = (as.arcAccuracy > 0 && as.arcAccuracy < 1e-9) || (vals.length > 0 && vals.every(v => Math.abs(v) <= 1.5) && Math.max(srcSize[0], srcSize[1]) > 8);
    if (fractional) anchorConv = v => [(v[0] ?? 0) * srcSize[0], (v[1] ?? 0) * srcSize[1]];
  }
  const anchor = withExpr(streamToProp(as, srcSize ? [srcSize[0] / 2, srcSize[1] / 2] : [0, 0], { conv: anchorConv, time, tan: anchorConv }), as, 2);
  const center = [comp.width / 2, comp.height / 2];
  const ps = childStream(t, 'ADBE Position');
  let position: Prop;
  const p0 = childStream(t, 'ADBE Position_0'), p1 = childStream(t, 'ADBE Position_1');
  if (ps?.separated || (!ps && ((p0 && !p0.hidden) || (p1 && !p1.hidden)))) {
    const px = streamToProp(p0, [center[0]], { conv: v => [v[0] ?? 0], time });
    const py = streamToProp(p1, [center[1]], { conv: v => [v[0] ?? 0], time });
    position = combineProps([px, py], [1, 1], ([a, b]) => [a[0], b[0]]);
  } else position = withExpr(streamToProp(ps, center, { ...o, tan: xy }), ps, 2);
  const sc = childStream(t, 'ADBE Scale'), rz = childStream(t, 'ADBE Rotate Z'), op = childStream(t, 'ADBE Opacity');
  return {
    anchor,
    position,
    scale: withExpr(streamToProp(sc, [100, 100], pct), sc, 2),
    rotation: withExpr(streamToProp(rz, [0], { conv: v => [v[0] ?? 0], time }), rz, 1),
    opacity: withExpr(streamToProp(op, [100], { conv: v => [(v[0] ?? 0) * 100], time }), op, 1),
  };
}

// ---------------------------------------------------------------- shapes

const KAPPA = 0.5522847498;

/** static polystar (first value of each stream) -> closed bezier path, the ae construction */
function starCmds(c: AepGroup): PathCmd[] {
  const val = (mn: string, d: number[]) => { const s = childStream(c, mn); return s?.value ?? s?.keyframes?.[0]?.value ?? d; };
  const points = Math.round(val('ADBE Vector Star Points', [5])[0]);
  if (!(points >= 3 && points <= 1000)) return [];
  const star = val('ADBE Vector Star Type', [1])[0] === 1;
  const [x, y] = val('ADBE Vector Star Position', [0, 0]);
  const outer = val('ADBE Vector Star Outer Radius', [100])[0], outerRound = val('ADBE Vector Star Outer Roundess', [0])[0] / 100;
  const inner = star ? val('ADBE Vector Star Inner Radius', [50])[0] : outer;
  const innerRound = star ? val('ADBE Vector Star Inner Roundess', [0])[0] / 100 : outerRound;
  const count = star ? points * 2 : points;
  const handle = KAPPA * Math.sin(Math.PI / points);
  let a = -Math.PI / 2 + (val('ADBE Vector Star Rotation', [0])[0] * Math.PI) / 180;
  const vs: number[][] = [], ti: number[][] = [], to: number[][] = [];
  for (let i = 0; i < count; i++) {
    const [r, rd] = i % 2 === 0 || !star ? [outer, outerRound] : [inner, innerRound];
    const co = Math.cos(a), si = Math.sin(a), len = r * rd * handle;
    vs.push([(x ?? 0) + r * co, (y ?? 0) + r * si]);
    ti.push([si * len, -co * len]);
    to.push([-si * len, co * len]);
    a += (2 * Math.PI) / count;
  }
  return bezierCmds(vs, ti, to, true) as PathCmd[];
}

function shapeItems(g: AepGroup | undefined, time: (t: number) => number, depth = 0): ShapeNode[] {
  const out: ShapeNode[] = [];
  if (!g || depth > 32) return out;
  const one = { conv: (v: number[]) => [v[0] ?? 0], time };
  const two = { conv: xy, time };
  const col = { conv: argbToRgba, time };
  for (const c of g.children) {
    if (c.kind !== 'group' || !c.enabled) continue;
    const name = c.name ?? '';
    switch (c.matchName) {
      case 'ADBE Vector Group': {
        const tg = childGroup(c, 'ADBE Vector Transform Group');
        out.push({
          kind: 'group', name: name || 'Group', items: shapeItems(childGroup(c, 'ADBE Vectors Group'), time, depth + 1),
          tr: {
            anchor: streamToProp(childStream(tg, 'ADBE Vector Anchor'), [0, 0], two),
            position: streamToProp(childStream(tg, 'ADBE Vector Position'), [0, 0], two),
            scale: streamToProp(childStream(tg, 'ADBE Vector Scale'), [100, 100], two),
            rotation: streamToProp(childStream(tg, 'ADBE Vector Rotation'), [0], one),
            opacity: streamToProp(childStream(tg, 'ADBE Vector Group Opacity'), [100], one),
          },
        });
        break;
      }
      case 'ADBE Vector Shape - Rect':
        out.push({
          kind: 'rect', name: name || 'Rectangle',
          size: streamToProp(childStream(c, 'ADBE Vector Rect Size'), [100, 100], two),
          position: streamToProp(childStream(c, 'ADBE Vector Rect Position'), [0, 0], two),
          roundness: streamToProp(childStream(c, 'ADBE Vector Rect Roundness'), [0], one),
        });
        break;
      case 'ADBE Vector Shape - Ellipse':
        out.push({
          kind: 'ellipse', name: name || 'Ellipse',
          size: streamToProp(childStream(c, 'ADBE Vector Ellipse Size'), [100, 100], two),
          position: streamToProp(childStream(c, 'ADBE Vector Ellipse Position'), [0, 0], two),
        });
        break;
      case 'ADBE Vector Shape - Group': {
        const p = child(c, 'ADBE Vector Shape');
        if (p && p.kind === 'path') {
          const src = pathSrc(p, time);
          if (src.cmds.length) out.push({ kind: 'path', name: name || 'Path', cmds: src.cmds, keys: src.keys });
        }
        break;
      }
      case 'ADBE Vector Shape - Star': {
        const cmds = starCmds(c);
        if (cmds.length) out.push({ kind: 'path', name: name || 'Polystar', cmds });
        break;
      }
      case 'ADBE Vector Filter - Trim':
        out.push({
          kind: 'trim', name: name || 'Trim Paths',
          start: streamToProp(childStream(c, 'ADBE Vector Trim Start'), [0], one),
          end: streamToProp(childStream(c, 'ADBE Vector Trim End'), [100], one),
          offset: streamToProp(childStream(c, 'ADBE Vector Trim Offset'), [0], one),
        });
        break;
      case 'ADBE Vector Graphic - Fill':
        out.push({
          kind: 'fill', name: name || 'Fill',
          color: streamToProp(childStream(c, 'ADBE Vector Fill Color'), [1, 0, 0, 1], col),
          opacity: streamToProp(childStream(c, 'ADBE Vector Fill Opacity'), [100], one),
          rule: (childStream(c, 'ADBE Vector Fill Rule')?.value?.[0] ?? 1) === 2 ? 'evenodd' : 'nonzero',
        });
        break;
      case 'ADBE Vector Graphic - Stroke':
        out.push({
          kind: 'stroke', name: name || 'Stroke',
          color: streamToProp(childStream(c, 'ADBE Vector Stroke Color'), [1, 1, 1, 1], col),
          opacity: streamToProp(childStream(c, 'ADBE Vector Stroke Opacity'), [100], one),
          width: streamToProp(childStream(c, 'ADBE Vector Stroke Width'), [2], one),
        });
        break;
      case 'ADBE Vector Graphic - G-Fill':
      case 'ADBE Vector Graphic - G-Stroke': {
        const gc = child(c, 'ADBE Vector Grad Colors');
        const stops = gc && gc.kind === 'gradient' && gc.stops.length ? gc.stops : [{ pos: 0, color: [1, 1, 1, 1] as [number, number, number, number] }, { pos: 1, color: [0, 0, 0, 1] as [number, number, number, number] }];
        const opacity = streamToProp(childStream(c, 'ADBE Vector Fill Opacity') ?? childStream(c, 'ADBE Vector Stroke Opacity'), [100], one);
        if (c.matchName.endsWith('G-Stroke')) {
          out.push({ kind: 'stroke', name: name || 'Gradient Stroke', color: sprop(stops[0].color), opacity, width: streamToProp(childStream(c, 'ADBE Vector Stroke Width'), [2], one) });
        } else {
          const st = childStream(c, 'ADBE Vector Grad Start Pt'), en = childStream(c, 'ADBE Vector Grad End Pt');
          out.push({
            kind: 'gfill', name: name || 'Gradient Fill', gtype: (childStream(c, 'ADBE Vector Grad Type')?.value?.[0] ?? 1) === 2 ? 'radial' : 'linear',
            stops, start: xy(st?.value ?? st?.keyframes?.[0]?.value ?? [0, 0]), end: xy(en?.value ?? en?.keyframes?.[0]?.value ?? [100, 0]),
            opacity, rule: (childStream(c, 'ADBE Vector Fill Rule')?.value?.[0] ?? 1) === 2 ? 'evenodd' : 'nonzero',
          });
        }
        break;
      }
      default: break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- masks

const WIDE_IN = -1e9, WIDE_OUT = 1e9;
type Rule = 'nonzero' | 'evenodd';
interface MaskPart { srcs: PathSrc[]; rule: Rule }
interface MaskRegion { parts: MaskPart[]; opacity: Prop }
type FillNode = Extract<ShapeNode, { kind: 'fill' }>;

/**
 * the masks of a layer ('ADBE Mask Parade') -> regions whose INTERSECTION is the visible area
 * (same scheme as the lottie importer). a region is a union of parts; a part is one path
 * (nonzero) or an even-odd compound (inverted / subtracted shapes: layer box + path).
 * mkif modes: 1 add (new part of the current region), 2 subtract (new inverted region),
 * 3 intersect (new region), 4 lighten ~ add, 5 darken ~ intersect, 6 difference (even-odd
 * with the previous part), 0 none. the first mask starts from empty, except subtract which
 * starts from the full layer. mask paths of source-backed layers are stored as fractions of
 * the source size (sx, sy); on shape / text layers they are in layer pixels. feather and
 * expansion are ignored.
 */
export function maskRegions(parade: AepGroup | undefined, time: (t: number) => number, sx: number, sy: number, box: [number, number, number, number]): MaskRegion[] {
  const regions: MaskRegion[] = [];
  if (!parade) return regions;
  const boxSrc: PathSrc = { cmds: rectCmds(box[0], box[1], box[2], box[3]) };
  for (const m of parade.children) {
    if (m.kind !== 'group' || m.matchName !== 'ADBE Mask Atom') continue;
    const info = m.mask ?? { inverted: false, mode: 1 };
    if (info.mode === 0) continue;
    const ps = child(m, 'ADBE Mask Shape');
    // a mask without a stored shape is the rectangle of its whole mask space
    const src: PathSrc = ps && ps.kind === 'path' && ps.values.length ? pathSrc(ps, time, sx, sy) : { cmds: rectCmds(0, 0, sx, sy) };
    if (!src.cmds.length) continue;
    const opacity = streamToProp(childStream(m, 'ADBE Mask Opacity'), [100], { conv: v => [(v[0] ?? 1) * 100], time });
    const shape = (): MaskPart => (info.inverted ? { srcs: [boxSrc, src], rule: 'evenodd' } : { srcs: [src], rule: 'nonzero' });
    const inverse = (): MaskPart => (info.inverted ? { srcs: [src], rule: 'nonzero' } : { srcs: [boxSrc, src], rule: 'evenodd' });
    const mode = info.mode === 4 ? 1 : info.mode === 5 ? 3 : info.mode;
    if (!regions.length || mode === 2 || mode === 3) {
      regions.push({ parts: [mode === 2 ? inverse() : shape()], opacity });
      continue;
    }
    const last = regions[regions.length - 1];
    if (mode === 6) {
      const lp = last.parts[last.parts.length - 1];
      lp.srcs.push(...shape().srcs);
      lp.rule = 'evenodd';
    } else last.parts.push(shape());
  }
  return regions;
}

function regionLayer(ctx: BuildCtx, name: string, r: MaskRegion, fill: FillNode): Layer {
  return pathLayer(ctx, name, r.parts.flatMap(p => p.srcs), fill, undefined, undefined, undefined, r.parts.map(p => ({ n: p.srcs.length, rule: p.rule })));
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
 * pass, works inside matte sources). otherwise a group (layer transform) holding one mask
 * path layer per region, nested so the regions intersect, with the content innermost.
 */
function withMasks(ctx: BuildCtx, name: string, regions: MaskRegion[], t: TR, solid: number[] | null, content: (t: TR) => Layer | null): Layer | null {
  if (solid && regions.length === 1) {
    const r = regions[0];
    const l = regionLayer(ctx, name, r, { kind: 'fill', name: 'Fill', color: sprop(solid), opacity: r.opacity, rule: 'nonzero' });
    foldTransform(l, t);
    return l;
  }
  const outer = ctx.make('group', name, { ...t, opacity: sprop([100]) });
  outer.props.size = sprop([0, 0]);
  outer.props.fill = sprop([1, 1, 1, 0]);
  let cur = outer;
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const m = regionLayer(ctx, 'Mask', r, { kind: 'fill', name: 'Mask', color: sprop([1, 1, 1, 1]), opacity: r.opacity, rule: 'nonzero' });
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

/** shape / text layers have no bounds: the comp mapped into layer space (first transform values) plus margin */
function compBoxInLayer(tr: TR, cw: number, ch: number): [number, number, number, number] {
  const p = firstValue(tr.position), a = firstValue(tr.anchor), sc = firstValue(tr.scale);
  const sx = Math.abs(sc[0]) / 100 || 1, sy = Math.abs(sc[1]) / 100 || 1;
  const r = Math.abs(firstValue(tr.rotation)[0] ?? 0) % 180 > 1e-6;
  let x0 = (0 - p[0]) / sx + a[0], y0 = (0 - p[1]) / sy + a[1], x1 = (cw - p[0]) / sx + a[0], y1 = (ch - p[1]) / sy + a[1];
  if (r) { const m = Math.max(x1 - x0, y1 - y0); const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; x0 = cx - m; x1 = cx + m; y0 = cy - m; y1 = cy + m; }
  const px = (x1 - x0) * 0.1, py = (y1 - y0) * 0.1;
  return [x0 - px, y0 - py, x1 - x0 + 2 * px, y1 - y0 + 2 * py];
}

/**
 * a static rect / ellipse layer -> the same shape as a path layer, so it can be inverted when
 * it is the source of an inverted track matte (only path layers can be inverted)
 */
function primToPath(l: Layer): Layer {
  if (l.type !== 'rect' && l.type !== 'ellipse') return l;
  if (isAnimated(l.props.size) || isAnimated(l.props.radius)) return l;
  const [w, h] = l.props.size!.v;
  if (!(w > 0 && h > 0)) return l;
  const r = l.type === 'rect' ? Math.min(l.props.radius?.v[0] ?? 0, w / 2, h / 2) : 0;
  const cmds = l.type === 'rect' ? rectCmds(0, 0, w, h, r) : ellipseCmds(w / 2, h / 2, w / 2, h / 2);
  l.type = 'path';
  l.geometry = [{ cmds, fillRule: 'nonzero' }];
  l.geomSize = [w, h];
  delete l.props.radius;
  return l;
}

/**
 * invert a path layer's coverage inside `box` (its parent space): one even-odd compound of
 * the box and every sub-path, so the shape becomes a hole. needs a static, unrotated layer
 * transform. returns false when the layer cannot be inverted.
 */
function invertPath(l: Layer, box: [number, number, number, number]): boolean {
  if (l.type !== 'path' || !l.geometry?.length || l.children.length) return false;
  if ([l.props.position, l.props.scale, l.props.rotation, l.props.anchor, l.props.size].some(isAnimated)) return false;
  if (Math.abs(l.props.rotation?.v[0] ?? 0) > 1e-9) return false;
  const pos = l.props.position!.v, anc = l.props.anchor?.v ?? [0, 0], sc = l.props.scale?.v ?? [100, 100];
  const gs = l.geomSize ?? [1, 1], sz = l.props.size!.v;
  const sx = sc[0] / 100, sy = sc[1] / 100, gx = gs[0] ? sz[0] / gs[0] : 1, gy = gs[1] ? sz[1] / gs[1] : 1;
  if (!sx || !sy || !gx || !gy) return false;
  const toG = (x: number, y: number) => [((x - pos[0]) / sx + anc[0]) / gx, ((y - pos[1]) / sy + anc[1]) / gy];
  const [x0, y0] = toG(box[0], box[1]), [x1, y1] = toG(box[0] + box[2], box[1] + box[3]);
  const rect = rectCmds(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  const merge = (g: NonNullable<Layer['geometry']>) => [{ cmds: [...rect, ...g.flatMap(x => x.cmds)], fillRule: 'evenodd' as const }];
  l.geometry = merge(l.geometry);
  if (l.pathKf) l.pathKf = l.pathKf.map(k => ({ ...k, geometry: merge(k.geometry) }));
  return true;
}

// ---------------------------------------------------------------- comps

function fontParts(ps: string | undefined): { family: string; weight: number; italic: boolean } {
  if (!ps) return { family: 'Inter', weight: 400, italic: false };
  const [fam, style = ''] = ps.split('-');
  return { family: fam.replace(/(PS)?MT$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'), weight: weightFromStyle(style || ps), italic: /italic|oblique/i.test(style) };
}

interface ConvCtx { ctx: BuildCtx; project: AepProject; depth: number }

const keyOf = (l: AepLayer) => l.id || `i${l.index}`;

function convertCompLayers(cc: ConvCtx, comp: AepComp, offset: number, stack: Set<number>): Layer[] {
  const { ctx, project } = cc;
  const src: SrcLayerX[] = [];
  // solo: when any visible layer is soloed, only soloed layers render (mattes still apply)
  const anySolo = comp.layers.some(l => l.flags.solo && l.flags.video);
  // track matte sources: explicit ids (ae 2023+) or the layer directly above (older files)
  const matteOf = new Map<AepLayer, AepLayer>();
  for (const l of comp.layers) {
    if (!(l.trackMatte >= 1 && l.trackMatte <= 4)) continue;
    const m = l.matteLayerId ? comp.layers.find(x => x.id === l.matteLayerId) : comp.layers[l.index - 1];
    if (m && m !== l) matteOf.set(l, m);
  }
  const usedAsMatte = new Set(matteOf.values());
  // inverted mattes: a hidden matte source inverts itself (one even-odd compound) and the
  // content uses it as a plain matte. (a visible source keeps the shared inversion path.)
  const selfInverted = new Set([...matteOf].filter(([l, m]) => (l.trackMatte === 2 || l.trackMatte === 4) && !m.flags.video).map(([, m]) => m));
  const invBox: [number, number, number, number] = [-comp.width, -comp.height, comp.width * 3, comp.height * 3];
  for (const l of comp.layers) {
    try {
      const st = Math.abs(l.stretch) || 1;
      const time = (t: number) => offset + l.startTime + t * st;
      const source: AepItem | undefined = l.sourceId ? project.items.get(l.sourceId) : undefined;
      const srcSize = source && source.type !== 'folder' ? [source.width, source.height] : null;
      const tr = layerTransform(l, comp, l.kind === 'av' ? srcSize : null, time);
      const isNullish = l.flags.null || l.flags.adjustment || l.kind === 'camera' || l.kind === 'light' || l.kind === 'model' || l.kind === 'mesh' || l.kind === 'unknown';
      const name = l.name || (source && source.type !== 'folder' ? source.name : '') || `Layer ${l.index + 1}`;
      const fo = source?.type === 'footage' ? source : undefined;
      const solid = fo?.source === 'solid' && fo.color ? [fo.color[0], fo.color[1], fo.color[2], 1] : null;
      const content = (t: TR): Layer | null => {
        if (l.flags.null) {
          const g = ctx.make('group', name, { ...t, opacity: sprop([100]) });
          g.props.size = sprop(srcSize ?? [100, 100]);
          g.props.fill = sprop([1, 1, 1, 0]);
          return g;
        }
        if (isNullish) return null;
        if (l.kind === 'shape') return buildShapeLayer(ctx, name, shapeItems(childGroup(l.root, 'ADBE Root Vectors Group'), time), t);
        if (l.kind === 'text') {
          const tp = child(childGroup(l.root, 'ADBE Text Properties'), 'ADBE Text Document');
          const doc = tp && tp.kind === 'text' ? tp.docs[0] : undefined;
          const f = fontParts(doc?.font);
          const fs = doc?.fontSize ?? 36;
          const j = doc?.justification ?? 0;
          return buildTextLayer(ctx, name, t, {
            content: doc?.text ?? name, fontSize: fs, font: f.family, fontWeight: f.weight, italic: f.italic, color: doc?.fill ?? [1, 1, 1, 1],
            justify: j === 1 ? 'right' : j === 2 ? 'center' : 'left',
            lineHeight: doc && doc.autoLeading === false && doc.leading ? doc.leading : fs * 1.2,
            tracking: doc?.tracking ? (doc.tracking / 1000) * fs : 0,
          });
        }
        // av layers
        if (source?.type === 'comp') {
          const g = ctx.make('group', name, t, { clip: true });
          g.props.size = sprop([source.width, source.height]);
          g.props.fill = sprop([1, 1, 1, 0]);
          if (!stack.has(source.id) && cc.depth < 16) {
            stack.add(source.id);
            cc.depth++;
            ctx.adopt(g, convertCompLayers(cc, source, offset + l.startTime, stack));
            cc.depth--;
            stack.delete(source.id);
          }
          return g;
        }
        const r = ctx.make('rect', name, t);
        r.props.size = sprop(srcSize ?? [100, 100]);
        r.props.fill = sprop(solid ?? [0.5, 0.5, 0.5, 0.5]);
        return r;
      };
      // layer-space box (inverted / subtracted masks) and mask space
      const sized = l.kind === 'av' && srcSize && srcSize[0] > 0 && srcSize[1] > 0;
      const box: [number, number, number, number] = sized ? [0, 0, srcSize![0], srcSize![1]] : compBoxInLayer(tr, comp.width, comp.height);
      const matte = matteOf.get(l);
      src.push({
        key: keyOf(l), parent: l.parentId || null, index: l.index, name, isNull: isNullish,
        visible: l.flags.video && !l.flags.guide && (!anySolo || l.flags.solo),
        inPoint: offset + l.compIn, outPoint: offset + l.compOut, tr,
        matte: matte ? (selfInverted.has(matte) ? l.trackMatte - 1 : l.trackMatte) : undefined,
        matteParent: matte ? keyOf(matte) : undefined,
        matteSource: usedAsMatte.has(l) && !l.flags.video,
        box: [0, 0, comp.width, comp.height],
        blend: aeBlend(l.blendMode),
        build: (t: TR) => {
          if (isNullish) return content(t);
          const regions = maskRegions(childGroup(l.root, 'ADBE Mask Parade'), time, sized ? srcSize![0] : 1, sized ? srcSize![1] : 1, box);
          const out = regions.length ? withMasks(ctx, name, regions, t, solid, content) : content(t);
          if (!out || !selfInverted.has(l)) return out;
          if (invertPath(primToPath(out), invBox)) return out;
          // cannot invert (groups, animated transforms): a full-box matte shows the content unmasked
          const drop = (x: Layer) => { delete ctx.layers[x.id]; for (const c of x.children) if (ctx.layers[c]) drop(ctx.layers[c]); };
          drop(out);
          const r = ctx.make('rect', name, identityTR());
          r.props.position = sprop([invBox[0], invBox[1]]);
          r.props.size = sprop([invBox[2], invBox[3]]);
          r.props.fill = sprop([1, 1, 1, 1]);
          return r;
        },
      });
    } catch (e) {
      project.warnings.push(`convert ${l.name}: ${(e as Error).message}`);
    }
  }
  return assembleStacked(ctx, src);
}

/** convert a parsed project. top-level compositions (not used as a precomp) become comps */
export function aepProjectToProject(ap: AepProject, name = 'After Effects Import'): Project {
  const used = new Set<number>();
  for (const c of ap.comps) for (const l of c.layers) {
    const s = l.sourceId ? ap.items.get(l.sourceId) : undefined;
    if (s && s.type === 'comp' && s.id !== c.id) used.add(s.id);
  }
  let tops = ap.comps.filter(c => !used.has(c.id));
  if (!tops.length) tops = ap.comps.slice(0, 1);
  const layers: Project['layers'] = {};
  const comps: Project['comps'] = {};
  let active = '', best = -1;
  for (const c of tops) {
    const ctx = new BuildCtx(c.width, c.height);
    const roots = convertCompLayers({ ctx, project: ap, depth: 0 }, c, 0, new Set([c.id]));
    finalizeTimes(ctx.layers);
    Object.assign(layers, ctx.layers);
    const id = uid('c');
    comps[id] = {
      id, name: c.name || 'Comp', width: c.width || 1920, height: c.height || 1080, fps: c.fps, duration: c.duration || 1,
      background: [c.bgColor[0] / 255, c.bgColor[1] / 255, c.bgColor[2] / 255, 1], root: roots.map(l => l.id),
    };
    if (c.layers.length > best) { best = c.layers.length; active = id; }
  }
  if (!active) {
    const id = uid('c');
    comps[id] = { id, name: 'Comp', width: 1920, height: 1080, fps: 30, duration: 5, background: [0, 0, 0, 1], root: [] };
    active = id;
  }
  return { version: 1, name, comps, activeComp: active, layers, assets: {} };
}

/** parse + convert an .aep file */
export function aepToProject(buf: ArrayBuffer, name?: string): Project {
  return aepProjectToProject(parseAep(buf), name);
}

