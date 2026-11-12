// AepProject (raw, stored units) -> our Project.
//
// supported: compositions (size, fps, duration, bg colour), solids (rect), nulls (group),
// precomps (flattened into clipped groups, start-time offset applied), shape layers
// (groups / rect / ellipse / path / fill / stroke / gradient fill), text layers (first
// document: text, font, size, colour, justification), file footage (grey placeholder rect,
// pixels are not embedded in .aep), ae parenting (mapped onto our tree via assemble()),
// transform keyframes with temporal ease (speed/influence -> normalized bezier via
// aeEaseToBezier), linear / hold, auto-bezier, spatial tangents and separated position.
// skipped: cameras, lights, adjustment layers (kept only as transform parents), effects,
// masks, track mattes, expressions, time remapping, 3D (z ignored), layer stretch inside
// nested comps (only the start offset), shape modifiers (trim, repeater, ...), polystars.

import { aeEaseToBezier } from '../../core/easing';
import type { Keyframe, Project, Prop, PathCmd } from '../../core/model';
import { uid } from '../../core/model';
import {
  BuildCtx, assemble, buildShapeLayer, buildTextLayer, combineProps, finalizeTimes, normalizeProp, sprop, weightFromStyle,
  bezierCmds, type ShapeNode, type SrcLayer, type TR,
} from '../lottie';
import {
  parseAep, child, childGroup, childStream, INTERP_HOLD, INTERP_LINEAR,
  type AepComp, type AepGroup, type AepKeyframe, type AepLayer, type AepProject, type AepStream, type AepItem, type AepFootage,
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
  const anchor = streamToProp(as, srcSize ? [srcSize[0] / 2, srcSize[1] / 2] : [0, 0], { conv: anchorConv, time, tan: anchorConv });
  const center = [comp.width / 2, comp.height / 2];
  const ps = childStream(t, 'ADBE Position');
  let position: Prop;
  const p0 = childStream(t, 'ADBE Position_0'), p1 = childStream(t, 'ADBE Position_1');
  if (ps?.separated || (!ps && ((p0 && !p0.hidden) || (p1 && !p1.hidden)))) {
    const px = streamToProp(p0, [center[0]], { conv: v => [v[0] ?? 0], time });
    const py = streamToProp(p1, [center[1]], { conv: v => [v[0] ?? 0], time });
    position = combineProps([px, py], [1, 1], ([a, b]) => [a[0], b[0]]);
  } else position = streamToProp(ps, center, { ...o, tan: xy });
  return {
    anchor,
    position,
    scale: streamToProp(childStream(t, 'ADBE Scale'), [100, 100], pct),
    rotation: streamToProp(childStream(t, 'ADBE Rotate Z'), [0], { conv: v => [v[0] ?? 0], time }),
    opacity: streamToProp(childStream(t, 'ADBE Opacity'), [100], { conv: v => [(v[0] ?? 0) * 100], time }),
  };
}

// ---------------------------------------------------------------- shapes

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
        const v = p && p.kind === 'path' ? p.values[0] : undefined;
        if (v && v.vertices.length) {
          const ti = v.vertices.map((p0, i) => sub(v.inPoints[i] ?? p0, p0));
          const to = v.vertices.map((p0, i) => sub(v.outPoints[i] ?? p0, p0));
          out.push({ kind: 'path', name: name || 'Path', cmds: bezierCmds(v.vertices, ti, to, v.closed) as PathCmd[] });
        }
        break;
      }
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

// ---------------------------------------------------------------- comps

function fontParts(ps: string | undefined): { family: string; weight: number; italic: boolean } {
  if (!ps) return { family: 'Inter', weight: 400, italic: false };
  const [fam, style = ''] = ps.split('-');
  return { family: fam.replace(/([a-z])([A-Z])/g, '$1 $2'), weight: weightFromStyle(style || ps), italic: /italic|oblique/i.test(style) };
}

interface ConvCtx { ctx: BuildCtx; project: AepProject; depth: number }

function convertCompLayers(cc: ConvCtx, comp: AepComp, offset: number, stack: Set<number>): import('../../core/model').Layer[] {
  const { ctx, project } = cc;
  const src: SrcLayer[] = [];
  for (const l of comp.layers) {
    try {
      const st = Math.abs(l.stretch) || 1;
      const time = (t: number) => offset + l.startTime + t * st;
      const source: AepItem | undefined = l.sourceId ? project.items.get(l.sourceId) : undefined;
      const srcSize = source && source.type !== 'folder' ? [source.width, source.height] : null;
      const tr = layerTransform(l, comp, l.kind === 'av' ? srcSize : null, time);
      const isNullish = l.flags.null || l.flags.adjustment || l.kind === 'camera' || l.kind === 'light' || l.kind === 'model' || l.kind === 'mesh' || l.kind === 'unknown';
      const name = l.name || (source && source.type !== 'folder' ? source.name : '') || `Layer ${l.index + 1}`;
      src.push({
        key: l.id || `i${l.index}`, parent: l.parentId || null, index: l.index, name, isNull: isNullish,
        visible: l.flags.video && !l.flags.guide,
        inPoint: offset + l.compIn, outPoint: offset + l.compOut, tr,
        build: (t: TR) => {
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
          const fo = source as AepFootage | undefined;
          const r = ctx.make('rect', name, t);
          r.props.size = sprop(srcSize ?? [100, 100]);
          r.props.fill = sprop(fo?.source === 'solid' && fo.color ? [fo.color[0], fo.color[1], fo.color[2], 1] : [0.5, 0.5, 0.5, 0.5]);
          return r;
        },
      });
    } catch (e) {
      project.warnings.push(`convert ${l.name}: ${(e as Error).message}`);
    }
  }
  return assemble(ctx, src);
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

