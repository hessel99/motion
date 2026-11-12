// concept tools: let the agent SEE what an artwork is made of (inspect_artwork), cut imported compound
// logos into animatable parts (split_shape), put pivots where the real-world object would turn
// (set_pivot), and rig parts like the thing they depict (rig: a door hinges open, a leaf grows from its
// stem, a heart beats, a rocket launches). every edit is one undo step; rigs are plain keyframes.

import { editor } from '../app/editor';
import { createLayer, type Layer, type PathCmd, type PropKey } from '../core/model';
import { insertLayer, valueAt } from '../core/commands';
import type { Tx } from '../core/store';
import { flattenCmds, type Ring } from '../import/pathops';
import { fontString, layoutText, toPath2D, getBitmap } from '../render/raster';
import { st, text, need, parseColor, idsSchema, resolveEase, buildKeys, type ToolDef, type ToolContent } from './tool-kit';
import { apply, inv, mul, worldMatrix, localMatrix, layerSize, rng, textUnitsSafe, type Mat } from './motion-math';
import { ellipseCmds, rectCmds, transformCmds, cmdsBounds } from './shape-lib';
import { fmtTime } from './describe';
import { splitTx, detach } from './tools-type';
import { SHAPE_TOOLS } from './tools-shapes';
import { textAnimFrom } from './tools-scene';

type Box = [number, number, number, number]; // x0, y0, x1, y1
const I: Mat = [1, 0, 0, 1, 0, 0];
const r0 = Math.round;
const r1 = (x: number) => Math.round(x * 10) / 10;
const hex = (c: number[]) => '#' + c.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('') + ((c[3] ?? 1) < 0.999 ? Math.round((c[3] ?? 1) * 255).toString(16).padStart(2, '0') : '');

// ---------------------------------------------------------------------------------------------
// geometry: rings, containment, connected components (holes stay with their outer contour)
// ---------------------------------------------------------------------------------------------

function boxOfPts(pts: number[], b: Box = [Infinity, Infinity, -Infinity, -Infinity]): Box {
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  return b;
}
function ringArea(r: Ring) {
  let s = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; s += r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1]; }
  return s / 2;
}
function ringPerimeter(r: Ring) {
  let s = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; s += Math.hypot(r[j * 2] - r[i * 2], r[j * 2 + 1] - r[i * 2 + 1]); }
  return s;
}
/** winding number of a closed ring around (x, y) */
function winding(r: Ring, x: number, y: number) {
  let w = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x1 = r[i * 2], y1 = r[i * 2 + 1], x2 = r[j * 2], y2 = r[j * 2 + 1];
    if (y1 <= y) { if (y2 > y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) > 0) w++; }
    else if (y2 <= y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) < 0) w--;
  }
  return w;
}
function crossings(r: Ring, y: number, out: number[]) {
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const y1 = r[i * 2 + 1], y2 = r[j * 2 + 1];
    if ((y1 <= y) !== (y2 <= y)) out.push(r[i * 2] + (y - y1) * (r[j * 2] - r[i * 2]) / (y2 - y1));
  }
}
/** a point inside ring r but outside every ring in `kids` (widest scanline span) */
function interiorPoint(r: Ring, kids: Ring[]): [number, number] {
  const b = boxOfPts(r);
  let best: [number, number] | null = null, bw = -1;
  const xs: number[] = [];
  for (const f of [0.5, 0.37, 0.63, 0.25, 0.75, 0.12, 0.88, 0.05, 0.95]) {
    const y = b[1] + (b[3] - b[1]) * f;
    xs.length = 0;
    crossings(r, y, xs);
    for (const k of kids) crossings(k, y, xs);
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k++) {
      const w = xs[k + 1] - xs[k];
      if (w <= bw) continue;
      const mx = (xs[k] + xs[k + 1]) / 2;
      if (winding(r, mx, y) !== 0 && !kids.some(c => winding(c, mx, y) !== 0)) { bw = w; best = [mx, y]; }
    }
    if (best && bw > (b[2] - b[0]) * 0.25) break;
  }
  return best ?? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

export function splitSubpaths(cmds: PathCmd[]): PathCmd[][] {
  const out: PathCmd[][] = [];
  let cur: PathCmd[] | null = null;
  let lx = 0, ly = 0;
  for (const c of cmds) {
    if (c[0] === 'M') { cur = [c]; out.push(cur); lx = c[1]; ly = c[2]; continue; }
    if (!cur) { cur = [['M', lx, ly]]; out.push(cur); }
    cur.push(c);
    if (c[0] === 'Z') { cur = null; lx = (out[out.length - 1][0] as any)[1]; ly = (out[out.length - 1][0] as any)[2]; }
  }
  return out.filter(s => s.length > 1);
}

export interface PathPart { cmds: PathCmd[]; fillRule: 'nonzero' | 'evenodd'; subs: number[]; holes: number; holeSubs: number[]; area: number; box: Box; rings: Ring[] /* outer first */; holeRings: Ring[] }

/** connected filled regions of a compound path: each solid contour with the holes directly inside it.
 *  a solid shape sitting inside a hole (a door in a door opening) is its own part. */
export function pathComponents(cmds: PathCmd[], rule: 'nonzero' | 'evenodd'): { subs: PathCmd[][]; parts: PathPart[] } {
  const subs = splitSubpaths(cmds);
  const all = cmdsBounds(cmds);
  const tol = Math.max(1e-3, Math.hypot(all[2], all[3]) * 0.0015);
  const rings = subs.map(s => flattenCmds(s, tol)[0] ?? null);
  const areas = rings.map(r => (r ? Math.abs(ringArea(r)) : 0));
  const boxes = rings.map((r, i) => (r ? boxOfPts(r) : boxOfPts(subs[i].flatMap(c => c.slice(1) as number[]))));
  const n = subs.length;
  const parent = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const ri = rings[i];
    if (!ri) continue;
    const bi = boxes[i];
    let best = -1;
    for (let j = 0; j < n; j++) {
      const rj = rings[j];
      if (j === i || !rj || areas[j] <= areas[i]) continue;
      const bj = boxes[j], e = 1e-6 * (1 + Math.abs(bj[2] - bj[0]));
      if (bi[0] < bj[0] - e || bi[1] < bj[1] - e || bi[2] > bj[2] + e || bi[3] > bj[3] + e) continue;
      const m = ri.length / 2;
      let inside = 0;
      for (const k of [0, Math.floor(m / 3), Math.floor((2 * m) / 3)]) if (winding(rj, ri[k * 2], ri[k * 2 + 1]) !== 0) inside++;
      if (inside >= 2 && (best < 0 || areas[j] < areas[best])) best = j;
    }
    parent[i] = best;
  }
  const kids: number[][] = Array.from({ length: n }, () => []);
  parent.forEach((p, i) => { if (p >= 0) kids[p].push(i); });
  const filled = (x: number, y: number) => {
    let w = 0, odd = 0;
    for (const r of rings) if (r) { const k = winding(r, x, y); w += k; odd += k & 1; }
    return rule === 'evenodd' ? (odd & 1) === 1 : w !== 0;
  };
  const solid = rings.map((r, i) => (r ? filled(...interiorPoint(r, kids[i].map(k => rings[k]!).filter(Boolean))) : true));
  // a part = a solid contour whose surroundings are empty, plus its holes and any solid contours that
  // only overlap it (same-direction nonzero nesting). the original fill rule stays exact inside a part:
  // the contours left out around it sum to "empty" there.
  const rootOf = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let r = i;
    if (!solid[i]) { r = parent[i]; while (r >= 0 && !solid[r]) r = parent[r]; }
    else while (parent[r] >= 0 && solid[parent[r]]) r = parent[r];
    rootOf[i] = r;
  }
  const parts: PathPart[] = [];
  for (let root = 0; root < n; root++) {
    if (rootOf[root] !== root) continue;
    const members = rootOf.map((r, i) => (r === root && i !== root ? i : -1)).filter(i => i >= 0);
    const holes = members.filter(i => !solid[i]);
    parts.push({
      cmds: [...subs[root], ...members.flatMap(h => subs[h])],
      fillRule: rule,
      subs: [root, ...members], holes: holes.length, holeSubs: holes,
      area: Math.max(0, areas[root] - holes.reduce((a, h) => a + areas[h], 0)),
      box: boxes[root], rings: [rings[root], ...holes.map(h => rings[h]!)].filter(Boolean) as Ring[], holeRings: holes.map(h => rings[h]!),
    });
  }
  return { subs, parts };
}

/** the layer's visual box in its own local (box) space */
function localBox(l: Layer, t: number): Box {
  const s = st();
  const [w, h] = layerSize(s, l, t);
  if (l.type === 'path' && l.geometry?.length) {
    const g = l.geomSize ?? [w, h];
    const b = cmdsBounds(l.geometry.flatMap(x => x.cmds));
    const sx = w / (g[0] || 1), sy = h / (g[1] || 1);
    if (b[2] > 0 || b[3] > 0) return [b[0] * sx, b[1] * sy, (b[0] + b[2]) * sx, (b[1] + b[3]) * sy];
  }
  if (l.type === 'group' && l.children.length) {
    const out: Box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const id of l.children) {
      const c = s.layer(id);
      if (!c || !c.visible || c.type === 'audio') continue;
      const cb = localBox(c, t), m = localMatrix(s, c, t);
      boxOfPts([...apply(m, cb[0], cb[1]), ...apply(m, cb[2], cb[1]), ...apply(m, cb[2], cb[3]), ...apply(m, cb[0], cb[3])], out);
    }
    if (isFinite(out[0])) return out;
  }
  return [0, 0, w, h];
}
/** comp-space visual bounds */
function compBox(l: Layer, t: number): Box {
  const b = localBox(l, t), m = worldMatrix(st(), l.id, t);
  return boxOfPts([...apply(m, b[0], b[1]), ...apply(m, b[2], b[1]), ...apply(m, b[2], b[3]), ...apply(m, b[0], b[3])]);
}
/** geometry space -> local box space of a path layer */
function geomScale(l: Layer, t: number): Mat {
  const [w, h] = layerSize(st(), l, t);
  const g = l.geomSize ?? [w, h];
  return [w / (g[0] || 1), 0, 0, h / (g[1] || 1), 0, 0];
}
/** outline commands of a leaf in its local box space (null: no outline, e.g. text/image -> box) */
function leafCmds(l: Layer, t: number): { cmds: PathCmd[]; rule: 'nonzero' | 'evenodd'; space: Mat }[] {
  const [w, h] = layerSize(st(), l, t);
  if (l.type === 'path' && l.geometry?.length) return l.geometry.map(g => ({ cmds: g.cmds, rule: g.fillRule, space: geomScale(l, t) }));
  if (l.type === 'ellipse') return [{ cmds: ellipseCmds(w / 2, h / 2, w / 2, h / 2), rule: 'nonzero', space: I }];
  if (l.type === 'rect') return [{ cmds: rectCmds(0, 0, w, h, valueAt(l, 'radius', t)[0]), rule: 'nonzero', space: I }];
  return [{ cmds: rectCmds(0, 0, w, h), rule: 'nonzero', space: I }];
}
const mapRing = (r: Ring, m: Mat): Ring => { const o = new Array(r.length); for (let i = 0; i < r.length; i += 2) { o[i] = m[0] * r[i] + m[2] * r[i + 1] + m[4]; o[i + 1] = m[1] * r[i] + m[3] * r[i + 1] + m[5]; } return o; };

// ---------------------------------------------------------------------------------------------
// shape reading (geometry only): what does a part look like?
// ---------------------------------------------------------------------------------------------

/** douglas-peucker corner count of a closed ring */
function corners(r: Ring, eps: number): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i < r.length; i += 2) pts.push([r[i], r[i + 1]]);
  if (pts.length < 4) return pts;
  // split the ring at two far-apart points, simplify both halves
  let a = 0, b = 0, bd = -1;
  for (let i = 0; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > bd) { bd = d; b = i; } }
  for (let i = 0; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[b][0], pts[i][1] - pts[b][1]); if (d > bd) { bd = d; a = i; } }
  const ordered = [...pts.slice(a), ...pts.slice(0, a)];
  const bi = (b - a + pts.length) % pts.length;
  const dp = (p: number[][]): number[][] => {
    if (p.length < 3) return p;
    const [x1, y1] = p[0], [x2, y2] = p[p.length - 1];
    const L = Math.hypot(x2 - x1, y2 - y1) || 1e-9;
    let k = -1, md = -1;
    for (let i = 1; i < p.length - 1; i++) { const d = Math.abs((x2 - x1) * (y1 - p[i][1]) - (x1 - p[i][0]) * (y2 - y1)) / L; if (d > md) { md = d; k = i; } }
    if (md <= eps) return [p[0], p[p.length - 1]];
    const l = dp(p.slice(0, k + 1)), rr = dp(p.slice(k));
    return [...l.slice(0, -1), ...rr];
  };
  const h1 = dp(ordered.slice(0, bi + 1)), h2 = dp([...ordered.slice(bi), ordered[0]]);
  return [...h1.slice(0, -1), ...h2.slice(0, -1)];
}

function shapeClass(outer: Ring, holes: number): string {
  const b = boxOfPts(outer), w = b[2] - b[0], h = b[3] - b[1];
  const A = Math.abs(ringArea(outer)), P = ringPerimeter(outer) || 1;
  const circ = (4 * Math.PI * A) / (P * P), fillRatio = A / ((w * h) || 1);
  const hole = holes ? ` with ${holes === 1 ? 'a hole' : holes + ' holes'}` : '';
  if (circ > 0.86) return (holes ? 'ring' : Math.abs(w / (h || 1) - 1) < 0.12 ? 'circle' : 'ellipse') + (holes > 1 ? hole : '');
  const cs = corners(outer, Math.hypot(w, h) * 0.035);
  const nv = cs.length;
  // fill ratio against the box aligned with the longest edge (rotated artwork still reads as a rectangle)
  let bestL = 0, ang = 0;
  cs.forEach((p, i) => { const q = cs[(i + 1) % nv], L = Math.hypot(q[0] - p[0], q[1] - p[1]); if (L > bestL) { bestL = L; ang = Math.atan2(q[1] - p[1], q[0] - p[0]); } });
  const rb = boxOfPts(mapRing(outer, [Math.cos(-ang), Math.sin(-ang), -Math.sin(-ang), Math.cos(-ang), 0, 0]));
  const rectRatio = Math.max(fillRatio, A / (((rb[2] - rb[0]) * (rb[3] - rb[1])) || 1));
  if (rectRatio > 0.9 && nv <= 6) return (circ > 0.72 && nv > 4 ? 'rounded rectangle' : 'rectangle') + hole;
  if (nv === 3) return 'triangle' + hole;
  if (nv === 5 || nv === 6) {
    const ys = cs.map(p => p[1]).sort((p, q) => p - q);
    const top = cs.find(p => p[1] === ys[0])!;
    if (ys[1] - ys[0] > h * 0.15 && Math.abs(top[0] - (b[0] + b[2]) / 2) < w * 0.2 && fillRatio > 0.55) return 'house-like pentagon (pointed roof)' + hole;
  }
  if (nv >= 8) {
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    const d = cs.map(p => Math.hypot(p[0] - cx, p[1] - cy));
    if (Math.min(...d) / (Math.max(...d) || 1) < 0.65 && fillRatio < 0.6) return `star/burst (${Math.round(nv / 2)} points)` + hole;
  }
  if (fillRatio > 0.78) return `blocky ${nv}-corner shape` + hole;
  if (nv > 10) return 'organic curved shape' + hole;
  return `${nv}-corner polygon` + hole;
}

// ---------------------------------------------------------------------------------------------
// inspect_artwork
// ---------------------------------------------------------------------------------------------

interface View {
  n: string; layer: Layer; comp?: PathPart; geomIdx?: number;
  rings: Ring[]; /* comp space, outer first then holes */ holeRings: Ring[];
  box: Box; area: number; atomic: boolean; isGroup?: boolean; components?: number;
}

function leafViews(l: Layer, t: number, n: string, out: View[], maxComps: number) {
  const s = st();
  const W = worldMatrix(s, l.id, t);
  if (l.type === 'path' && l.geometry?.length) {
    const sp = geomScale(l, t), M = mul(W, sp);
    const all: { part: PathPart; gi: number }[] = [];
    l.geometry.forEach((g, gi) => pathComponents(g.cmds, g.fillRule).parts.forEach(part => all.push({ part, gi })));
    const toWorld = (part: PathPart) => part.rings.map(r => mapRing(r, M));
    const det = Math.abs(M[0] * M[3] - M[1] * M[2]);
    const rings = all.flatMap(a => toWorld(a.part).slice(0, 1));
    const holes = all.flatMap(a => toWorld(a.part).slice(1));
    const box = compBox(l, t);
    const whole: View = { n, layer: l, rings, holeRings: holes, box, area: all.reduce((a, x) => a + x.part.area, 0) * det, atomic: all.length <= 1, components: all.length };
    out.push(whole);
    if (all.length > 1) {
      all.sort((a, b) => (a.part.box[1] + a.part.box[3]) - (b.part.box[1] + b.part.box[3]) || a.part.box[0] - b.part.box[0]);
      all.slice(0, maxComps).forEach((a, k) => {
        const rs = toWorld(a.part);
        out.push({ n: `${n}.${k + 1}`, layer: l, comp: a.part, geomIdx: a.gi, rings: rs.slice(0, 1), holeRings: rs.slice(1), box: boxOfPts(rs[0] ?? []), area: a.part.area * det, atomic: true });
      });
    }
    return;
  }
  const cmds = leafCmds(l, t)[0];
  const ring = flattenCmds(cmds.cmds, 0.5)[0] ?? [];
  const wr = mapRing(ring, mul(W, cmds.space));
  out.push({ n, layer: l, rings: [wr], holeRings: [], box: compBox(l, t), area: Math.abs(ringArea(wr)), atomic: true });
}

function collectViews(roots: Layer[], t: number, maxParts: number): { views: View[]; skipped: number } {
  const s = st();
  const views: View[] = [];
  let k = 0, skipped = 0;
  const leafCount = (l: Layer): number => l.type === 'group' ? l.children.reduce((a, c) => a + leafCount(s.layer(c)!), 0) : 1;
  const walk = (l: Layer, isRoot: boolean) => {
    if (!l.visible || l.type === 'audio') { skipped++; return; }
    if (k >= maxParts) { skipped++; return; }
    if (l.type === 'group' && l.children.length) {
      if (!isRoot && leafCount(l) >= 2) views.push({ n: String(++k), layer: l, rings: [], holeRings: [], box: compBox(l, t), area: 0, atomic: false, isGroup: true });
      for (const c of l.children) walk(s.layer(c)!, false);
      return;
    }
    leafViews(l, t, String(++k), views, 12);
  };
  roots.forEach(r => walk(r, true));
  return { views, skipped };
}

function colorsOf(l: Layer, t: number): string[] {
  const out: string[] = [];
  if (l.type === 'group' || l.type === 'image' || l.type === 'precomp') return out;
  const grad = l.paints?.find(p => p.type === 'linear' || p.type === 'radial');
  if (grad?.stops) out.push(`${grad.type} ${grad.stops.map(x => hex(x.color)).join('→')}`);
  else { const f = valueAt(l, 'fill', t); if (f[3] > 0.01) out.push(hex(f)); }
  const sw = l.props.strokeWidth ? valueAt(l, 'strokeWidth', t)[0] : 0;
  const sc = l.props.stroke ? valueAt(l, 'stroke', t) : [0, 0, 0, 0];
  if ((sw > 0 || l.strokeGeometry?.length) && sc[3] > 0.01) out.push(`stroke ${hex(sc)}${sw ? ' ' + r1(sw) + 'px' : ''}`);
  return out;
}

/** rows of letter-like parts: similar height, shared baseline, small gaps */
function letterRows(vs: View[]): Map<View, string> {
  const out = new Map<View, string>();
  const cand = vs.filter(v => v.atomic && !v.isGroup && v.box[3] - v.box[1] > 2 && (v.box[2] - v.box[0]) / (v.box[3] - v.box[1]) < 1.8);
  const used = new Set<View>();
  let rowN = 0;
  for (const seed of cand.slice().sort((a, b) => a.box[0] - b.box[0])) {
    if (used.has(seed)) continue;
    const h = seed.box[3] - seed.box[1];
    const row = cand.filter(v => !used.has(v) && Math.abs(v.box[3] - seed.box[3]) < h * 0.22 && Math.abs((v.box[3] - v.box[1]) - h) < h * 0.45).sort((a, b) => a.box[0] - b.box[0]);
    // keep the run that is chained with gaps under ~1 letter height
    const chain = [row[0]];
    for (let i = 1; i < row.length; i++) { if (row[i].box[0] - chain[chain.length - 1].box[2] < h * 1.1) chain.push(row[i]); else if (chain.length < 3) { chain.length = 0; chain.push(row[i]); } else break; }
    if (chain.length < 3 || !chain.includes(seed)) continue;
    rowN++;
    chain.forEach((v, i) => { used.add(v); out.set(v, `letter-like ${i + 1}/${chain.length} in text row ${String.fromCharCode(64 + rowN)}`); });
  }
  return out;
}

const boxContains = (a: Box, b: Box, e = 0.5) => b[0] >= a[0] - e && b[1] >= a[1] - e && b[2] <= a[2] + e && b[3] <= a[3] + e;
const boxGap = (a: Box, b: Box) => Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));

function describeViews(views: View[], t: number) {
  const atoms = views.filter(v => v.atomic && !v.isGroup);
  const total = atoms.reduce((a, v) => a + v.area, 0) || 1;
  const classes = new Map<View, string>();
  for (const v of views) {
    if (v.isGroup) { classes.set(v, `group of ${v.layer.children.length}`); continue; }
    if (v.layer.type === 'text') { classes.set(v, `text "${v.layer.text!.content.slice(0, 40)}"`); continue; }
    if (v.layer.type === 'image') { classes.set(v, 'image'); continue; }
    if (!v.rings[0]) { classes.set(v, 'open line'); continue; }
    if (!v.atomic) { classes.set(v, `compound path of ${v.components} separate parts`); continue; }
    classes.set(v, shapeClass(v.rings[0], v.holeRings.length));
  }
  const rows = letterRows(atoms);
  return views.map(v => {
    const l = v.layer, b = v.box, w = b[2] - b[0], h = b[3] - b[1];
    const o: any = { n: v.n, id: l.id, name: l.name, type: v.comp ? 'component' : l.type };
    o.bounds = [r0(b[0]), r0(b[1]), r0(w), r0(h)];
    if (!v.isGroup) { o.area = r0(v.area); if (v.atomic) o.areaPct = r1((v.area / total) * 100); }
    o.aspect = r1(w / (h || 1));
    if (!v.comp) { const c = colorsOf(l, t); if (c.length) o.colors = c; }
    if (l.type === 'path' && l.geometry && !v.comp) {
      o.subpaths = l.geometry.reduce((a, g) => a + splitSubpaths(g.cmds).length, 0);
      if (v.components! > 1) o.components = v.components;
      if (v.holeRings.length) o.holes = v.holeRings.length;
    } else if (v.comp) { o.subpaths = v.comp.subs.length; if (v.comp.holes) o.holes = v.comp.holes; }
    if (v.isGroup) o.children = l.children.length;
    const cls = classes.get(v)!;
    const rel: string[] = [];
    if (v.atomic && !v.isGroup) {
      const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      const others = atoms.filter(x => x !== v && !(x.layer === l && !x.comp && v.comp));
      const holeOf = others.find(x => x.holeRings.some(r => winding(r, cx, cy) !== 0));
      if (holeOf) { o.inHoleOf = holeOf.n; rel.push(`sits in the hole of #${holeOf.n} (${classes.get(holeOf)})`); }
      else {
        const inside = others.filter(x => x.area > v.area && boxContains(x.box, b) && x.rings[0] && winding(x.rings[0], cx, cy) !== 0).sort((p, q) => p.area - q.area)[0];
        if (inside) { o.inside = inside.n; rel.push(`on top of #${inside.n} (${classes.get(inside)})`); }
      }
      const contains = others.filter(x => x.area < v.area && boxContains(b, x.box) && (v.holeRings.some(r => winding(r, (x.box[0] + x.box[2]) / 2, (x.box[1] + x.box[3]) / 2) !== 0) || (v.rings[0] && winding(v.rings[0], (x.box[0] + x.box[2]) / 2, (x.box[1] + x.box[3]) / 2) !== 0)));
      if (contains.length) o.contains = contains.map(x => x.n).slice(0, 8);
      const near = others.filter(x => !boxContains(x.box, b) && !boxContains(b, x.box)).map(x => ({ x, d: boxGap(b, x.box) })).sort((p, q) => p.d - q.d).slice(0, 2);
      if (near.length) o.neighbours = near.map(({ x, d }) => {
        const dx = (x.box[0] + x.box[2]) / 2 - cx, dy = (x.box[1] + x.box[3]) / 2 - cy;
        return `#${x.n} ${Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'below' : 'above'} ${r0(d)}px`;
      });
      const row = rows.get(v);
      if (row) { o.row = row; rel.push(row); }
    }
    const size = v.isGroup ? '' : o.areaPct >= 40 ? 'dominant ' : o.areaPct !== undefined && o.areaPct < 3 ? 'small ' : '';
    const orient = v.isGroup || /circle|ring|text/.test(cls) ? '' : h > w * 1.6 ? 'tall ' : w > h * 1.6 ? 'wide ' : '';
    o.hint = `${size}${orient}${cls}${rel.length ? ', ' + rel.join(', ') : ''}${!v.atomic && !v.isGroup ? ' (split_shape to animate them separately)' : ''}`;
    return o;
  });
}

// ---- the labeled sheet (browser only) ----

function cssColor(c: number[], minA = 0) { return `rgba(${r0(c[0] * 255)},${r0(c[1] * 255)},${r0(c[2] * 255)},${Math.max(minA, c[3] ?? 1)})`; }

/** draw a layer (and its children) with canvas 2d under matrix m (local -> canvas): fast isolated preview */
function drawLayer(g: CanvasRenderingContext2D, l: Layer, m: Mat, t: number, onlyCmds?: { cmds: PathCmd[]; rule: CanvasFillRule }) {
  const s = st();
  if (!l.visible) return;
  if (l.type === 'group') { for (const c of l.children) { const ch = s.layer(c); if (ch) drawLayer(g, ch, mul(m, localMatrix(s, ch, t)), t); } return; }
  const [w, h] = layerSize(s, l, t);
  const grad = l.paints?.find(p => p.stops?.length);
  const fill = grad ? grad.stops![0].color : l.props.fill ? valueAt(l, 'fill', t) : [0.5, 0.5, 0.5, 1];
  const sw = l.props.strokeWidth ? valueAt(l, 'strokeWidth', t)[0] : 0;
  const sc = l.props.stroke ? valueAt(l, 'stroke', t) : [0, 0, 0, 0];
  g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  g.fillStyle = cssColor(fill, 0);
  if (l.type === 'path' && l.geometry) {
    const sp = geomScale(l, t);
    g.transform(sp[0], 0, 0, sp[3], 0, 0);
    if (onlyCmds) { g.fill(toPath2D({ cmds: onlyCmds.cmds, fillRule: onlyCmds.rule as any }), onlyCmds.rule); return; }
    for (const ge of l.geometry) if (fill[3] > 0.01) g.fill(toPath2D(ge), ge.fillRule);
    if (sc[3] > 0.01) {
      if (l.strokeGeometry?.length) { g.fillStyle = cssColor(sc); for (const ge of l.strokeGeometry) g.fill(toPath2D(ge), ge.fillRule); }
      else if (sw > 0) { g.strokeStyle = cssColor(sc); g.lineWidth = sw / Math.max(1e-6, (sp[0] + sp[3]) / 2); for (const ge of l.geometry) g.stroke(toPath2D(ge)); }
    }
  } else if (l.type === 'rect' || l.type === 'ellipse') {
    g.beginPath();
    if (l.type === 'ellipse') g.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else { const r = Math.min(valueAt(l, 'radius', t)[0], w / 2, h / 2); (g as any).roundRect ? (g as any).roundRect(0, 0, w, h, r) : g.rect(0, 0, w, h); }
    if (fill[3] > 0.01) g.fill();
    if (sw > 0 && sc[3] > 0.01) { g.strokeStyle = cssColor(sc); g.lineWidth = sw; g.stroke(); }
  } else if (l.type === 'text' && l.text) {
    g.font = fontString(l);
    g.textBaseline = 'top';
    const lines = layoutText(l, (l.props.size?.v[0] ?? 0) > 0 ? w : null);
    const lh = l.text.fontSize * l.text.lineHeight;
    lines.forEach((ln, i) => {
      const x = l.text!.align === 'center' ? (w - ln.width) / 2 : l.text!.align === 'right' ? w - ln.width : 0;
      g.fillText(ln.text, x, i * lh + (lh - l.text!.fontSize) / 2);
    });
  } else if (l.type === 'image') {
    const a = l.imageRef ? s.project.assets[l.imageRef] : undefined;
    const bm = a ? getBitmap(a) : null;
    if (bm) g.drawImage(bm, 0, 0, w, h); else { g.fillStyle = '#999'; g.fillRect(0, 0, w, h); }
  } else { g.fillStyle = 'rgba(128,128,128,0.5)'; g.fillRect(0, 0, w, h); }
}

const PALETTE = ['#ff3b6b', '#2fb5ff', '#ffb000', '#3ddc84', '#b06bff', '#ff7a2f', '#00d2c2', '#ff5ad1'];

async function renderSheet(views: View[], t: number): Promise<string> {
  const s = st(), comp = s.comp;
  const all: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const v of views) boxOfPts([v.box[0], v.box[1], v.box[2], v.box[3]], all);
  const pad = Math.max(16, (all[2] - all[0] + all[3] - all[1]) * 0.05);
  const A: Box = [all[0] - pad, all[1] - pad, all[2] + pad, all[3] + pad];
  const SW = 672, OVH = 380;
  const ok = Math.min(SW / (A[2] - A[0]), OVH / (A[3] - A[1]));
  const ow = Math.round((A[2] - A[0]) * ok), oh = Math.round((A[3] - A[1]) * ok);
  const cells = views.filter(v => v.atomic || v.isGroup || (v.components ?? 0) > 1);
  const cell = 128, lab = 26, gap = 4, cols = Math.floor((SW + gap) / (cell + gap));
  const rows = Math.ceil(cells.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = SW; canvas.height = oh + 20 + rows * (cell + lab + gap) + 6;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#1b1b1f'; g.fillRect(0, 0, canvas.width, canvas.height);
  // 1) the real render (renderer snapshot, same path as the preview tools), cropped, with numbered outlines
  const snapScale = Math.min(1, ok, 2048 / Math.max(comp.width, comp.height));
  const url = editor.renderer.snapshot(t, Math.max(comp.width, comp.height) * snapScale);
  const im = new Image();
  await new Promise<void>((res, rej) => { im.onload = () => res(); im.onerror = () => rej(new Error('snapshot decode failed')); im.src = url; });
  const ox = Math.round((SW - ow) / 2);
  g.drawImage(im, A[0] * snapScale, A[1] * snapScale, (A[2] - A[0]) * snapScale, (A[3] - A[1]) * snapScale, ox, 0, ow, oh);
  const toO = (x: number, y: number): [number, number] => [ox + (x - A[0]) * ok, (y - A[1]) * ok];
  g.font = 'bold 11px ui-monospace, Menlo, monospace'; g.textBaseline = 'middle';
  views.forEach((v, i) => {
    if (!v.atomic || v.isGroup) return;
    const col = PALETTE[i % PALETTE.length];
    g.strokeStyle = col; g.lineWidth = 1.5; g.setLineDash([]);
    for (const r of [...v.rings, ...v.holeRings]) {
      g.beginPath();
      for (let k = 0; k < r.length; k += 2) { const [x, y] = toO(r[k], r[k + 1]); k ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.closePath(); g.stroke();
    }
    const [lx, ly] = toO(v.box[0], v.box[1]);
    const tw = g.measureText(v.n).width + 6;
    g.fillStyle = col; g.fillRect(lx, ly, tw, 14);
    g.fillStyle = '#000'; g.fillText(v.n, lx + 3, ly + 7);
  });
  g.fillStyle = '#ccc'; g.font = '11px ui-monospace, Menlo, monospace';
  g.fillText(`t=${fmtTime(t)}  numbered outlines = parts below (n.k = component of a compound path)`, 6, oh + 10);
  // 2) every part alone on a neutral background
  cells.forEach((v, i) => {
    const x = (i % cols) * (cell + gap), y = oh + 20 + Math.floor(i / cols) * (cell + lab + gap);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#9a9a9e'; g.fillRect(x, y, cell, cell);
    const b = v.box, bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1]);
    const k = Math.min((cell - 16) / bw, (cell - 16) / bh);
    const C: Mat = [k, 0, 0, k, x + (cell - bw * k) / 2 - b[0] * k, y + (cell - bh * k) / 2 - b[1] * k];
    g.save(); g.beginPath(); g.rect(x, y, cell, cell); g.clip();
    const W = worldMatrix(st(), v.layer.id, t);
    drawLayer(g, v.layer, mul(C, W), t, v.comp ? { cmds: v.comp.cmds, rule: v.comp.fillRule } : undefined);
    g.restore();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#eee'; g.font = 'bold 11px ui-monospace, Menlo, monospace';
    g.fillText(`#${v.n} ${v.comp ? 'component' : v.layer.name}`.slice(0, 20), x + 2, y + cell + 7);
    g.fillStyle = '#999'; g.font = '9px ui-monospace, Menlo, monospace';
    g.fillText(v.layer.id.slice(0, 20), x + 2, y + cell + 19);
  });
  return canvas.toDataURL('image/jpeg', 0.86).split(',')[1];
}

// ---------------------------------------------------------------------------------------------
// split_shape
// ---------------------------------------------------------------------------------------------

function boxDist(a: Box, b: Box) { return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]); }

function splitPathTx(tx: Tx, l: Layer, mode: 'subpaths' | 'components'): { group: string; parts: { id: string; name: string }[] } {
  const s = st(), t = s.time;
  if (l.pathKf?.length) throw new Error(`"${l.name}" has an animated path shape (morph keys); remove them before splitting`);
  if (l.link || s.project.components?.[l.id]) throw new Error(`"${l.name}" is part of a component; split the main component's layers instead`);
  const geoms = l.geometry ?? [];
  type P = { cmds: PathCmd[]; rule: 'nonzero' | 'evenodd'; box: Box; area: number; holes: number; stroke: PathCmd[] };
  const parts: P[] = [];
  const subBoxes: { box: Box; part: number }[] = [];
  for (const g of geoms) {
    const { subs, parts: comps } = pathComponents(g.cmds, g.fillRule);
    if (mode === 'subpaths') {
      for (const sp of subs) {
        const bb = cmdsBounds(sp), box: Box = [bb[0], bb[1], bb[0] + bb[2], bb[1] + bb[3]];
        subBoxes.push({ box, part: parts.length });
        const ring = flattenCmds(sp, 0.5)[0];
        parts.push({ cmds: sp, rule: g.fillRule, box, area: ring ? Math.abs(ringArea(ring)) : 0, holes: 0, stroke: [] });
      }
    } else {
      for (const c of comps) {
        const idx = parts.length;
        for (const si of c.subs) { const bb = cmdsBounds(subs[si]); subBoxes.push({ box: [bb[0], bb[1], bb[0] + bb[2], bb[1] + bb[3]], part: idx }); }
        const bb = cmdsBounds(c.cmds);
        parts.push({ cmds: c.cmds, rule: c.fillRule, box: [bb[0], bb[1], bb[0] + bb[2], bb[1] + bb[3]], area: c.area, holes: c.holes, stroke: [] });
      }
    }
  }
  if (parts.length < 2) {
    const nsub = geoms.reduce((a, g) => a + splitSubpaths(g.cmds).length, 0);
    throw new Error(`"${l.name}" is one connected shape (${nsub} subpath${nsub === 1 ? '' : 's'}${mode === 'components' && nsub > 1 ? ', the others are its holes' : ''}): nothing to split${mode === 'components' && nsub > 1 ? '. mode "subpaths" splits every contour (holes become solid)' : ''}`);
  }
  // pre-outlined figma strokes: each stroke contour goes to the part whose contour it hugs
  for (const sg of l.strokeGeometry ?? []) for (const sp of splitSubpaths(sg.cmds)) {
    const bb = cmdsBounds(sp), box: Box = [bb[0], bb[1], bb[0] + bb[2], bb[1] + bb[3]];
    let best = 0, bd = Infinity;
    for (const sb of subBoxes) { const d = boxDist(sb.box, box); if (d < bd) { bd = d; best = sb.part; } }
    parts[best].stroke.push(...sp);
  }
  const [W, H] = layerSize(s, l, t);
  const G = l.geomSize ?? [W, H];
  const sx = W / (G[0] || 1), sy = H / (G[1] || 1);
  const grp = createLayer('group', { x: 0, y: 0, w: W, h: H, name: l.name });
  for (const k of ['anchor', 'position', 'scale', 'rotation', 'opacity'] as const) if (l.props[k]) grp.props[k] = structuredClone(l.props[k]!);
  grp.props.size = { v: [W, H] };
  grp.inPoint = l.inPoint; grp.outPoint = l.outPoint; grp.visible = l.visible; grp.locked = l.locked;
  if (l.mask) grp.mask = true;
  if (l.clip) grp.clip = true;
  const siblings = l.parent ? s.layer(l.parent)!.children : s.comp.root;
  insertLayer(s, tx, grp, l.parent, siblings.indexOf(l.id) + 1);
  // reading order (rows top to bottom, then left to right), size rank as a name hint
  const order = parts.map((_, i) => i).sort((a, b) => {
    const pa = parts[a].box, pb = parts[b].box, ha = pa[3] - pa[1], hb = pb[3] - pb[1];
    const sameRow = Math.abs((pa[1] + pa[3]) / 2 - (pb[1] + pb[3]) / 2) < Math.min(ha, hb) * 0.5;
    return sameRow ? pa[0] - pb[0] : pa[1] + pa[3] - pb[1] - pb[3];
  });
  const bySize = parts.map((_, i) => i).sort((a, b) => parts[b].area - parts[a].area);
  const out: { id: string; name: string }[] = [];
  order.forEach((pi, k) => {
    const p = parts[pi];
    const src = p.cmds.length ? p.cmds : p.stroke;
    const bb = cmdsBounds(p.stroke.length ? [...src, ...p.stroke] : src);
    const gw = Math.max(bb[2], 1e-3), gh = Math.max(bb[3], 1e-3);
    const rank = bySize.indexOf(pi) + 1;
    const name = `Part ${k + 1} (${rank === 1 ? 'largest' : rank === parts.length ? 'smallest' : 'size ' + rank + '/' + parts.length})`;
    const c = createLayer('path', { x: bb[0] * sx, y: bb[1] * sy, w: gw * sx, h: gh * sy, name });
    const move: Mat = [1, 0, 0, 1, -bb[0], -bb[1]];
    c.geometry = p.cmds.length ? [{ cmds: transformCmds(p.cmds, move as any), fillRule: p.rule }] : [];
    if (p.stroke.length) c.strokeGeometry = [{ cmds: transformCmds(p.stroke, move as any), fillRule: l.strokeGeometry![0].fillRule }];
    c.geomSize = [gw, gh];
    for (const key of ['fill', 'stroke', 'strokeWidth', 'trimStart', 'trimEnd', 'trimOffset'] as const) if (l.props[key]) c.props[key] = structuredClone(l.props[key]!);
    if (l.paints) c.paints = l.paints.map(pt => {
      if (!pt.transform) return structuredClone(pt);
      const m = pt.transform;
      return { ...structuredClone(pt), transform: [G[0] * m[0] / gw, G[1] * m[1] / gh, G[0] * m[2] / gw, G[1] * m[3] / gh, (G[0] * m[4] - bb[0]) / gw, (G[1] * m[5] - bb[1]) / gh] };
    });
    if (l.strokeAlign) c.strokeAlign = l.strokeAlign;
    if (l.trimOn) c.trimOn = true;
    if (l.blend) c.blend = l.blend;
    insertLayer(s, tx, c, grp.id);
    out.push({ id: c.id, name });
  });
  detach(tx, l);
  tx.del(s.project.layers, l.id);
  tx.structure();
  return { group: grp.id, parts: out };
}

// ---------------------------------------------------------------------------------------------
// set_pivot
// ---------------------------------------------------------------------------------------------

const NAMED: Record<string, [number, number]> = {
  center: [0.5, 0.5], left: [0, 0.5], right: [1, 0.5], top: [0.5, 0], bottom: [0.5, 1],
  'top-left': [0, 0], 'top-right': [1, 0], 'bottom-left': [0, 1], 'bottom-right': [1, 1],
};
const normName = (s: string) => {
  const k = String(s).toLowerCase().replace(/[\s_]+/g, '-').replace(/-center$|^center-/, m => (m === 'center-' || m === '-center' ? '' : m));
  return k === 'left-top' ? 'top-left' : k === 'right-top' ? 'top-right' : k === 'left-bottom' ? 'bottom-left' : k === 'right-bottom' ? 'bottom-right' : k === 'middle' ? 'center' : k;
};
const pivotSchema = {
  description: 'where the pivot goes: a named spot of the layer\'s visual bounds ("left", "right", "top", "bottom", "center", "top-left", ...), [x,y] in composition px, or {layerEdgeOf: otherId, edge?: "left"|"right"|"top"|"bottom"} = on another layer\'s edge (default: the edge nearest this layer, e.g. the wordmark pivots on the mark\'s right edge)',
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }, { type: 'object', properties: { layerEdgeOf: { type: 'string' }, edge: { type: 'string' } } }],
};

/** pivot spec -> point in the layer's local box space */
function pivotPoint(l: Layer, at: any, t: number): number[] {
  const s = st();
  if (typeof at === 'string') {
    const f = NAMED[normName(at)];
    if (!f) throw new Error(`unknown pivot "${at}": use ${Object.keys(NAMED).join(', ')}, [x,y] (comp px) or {layerEdgeOf: id}`);
    const b = localBox(l, t);
    return [b[0] + (b[2] - b[0]) * f[0], b[1] + (b[3] - b[1]) * f[1]];
  }
  const toLocal = inv(worldMatrix(s, l.id, t));
  if (Array.isArray(at)) {
    if (at.length !== 2 || !at.every(x => isFinite(+x))) throw new Error('pivot [x,y] must be two numbers (composition px)');
    return apply(toLocal, +at[0], +at[1]);
  }
  if (at && typeof at === 'object') {
    const oid = at.layerEdgeOf ?? at.layer;
    if (!oid) throw new Error('pivot object needs layerEdgeOf: <layer id>');
    const o = need(oid);
    if (o.id === l.id) throw new Error('layerEdgeOf must be another layer (use a named spot for this layer\'s own edges)');
    const ob = compBox(o, t), mb = compBox(l, t);
    const cx = (mb[0] + mb[2]) / 2, cy = (mb[1] + mb[3]) / 2;
    let edge = at.edge ? normName(at.edge) : '';
    if (edge && !['left', 'right', 'top', 'bottom'].includes(edge)) throw new Error('edge must be left, right, top or bottom');
    if (!edge) {
      const d = { left: Math.abs(cx - ob[0]), right: Math.abs(cx - ob[2]), top: Math.abs(cy - ob[1]), bottom: Math.abs(cy - ob[3]) };
      edge = Object.entries(d).sort((p, q) => p[1] - q[1])[0][0];
    }
    const clampY = Math.min(ob[3], Math.max(ob[1], cy)), clampX = Math.min(ob[2], Math.max(ob[0], cx));
    const p = edge === 'left' ? [ob[0], clampY] : edge === 'right' ? [ob[2], clampY] : edge === 'top' ? [clampX, ob[1]] : [clampX, ob[3]];
    return apply(toLocal, p[0], p[1]);
  }
  throw new Error('at must be a name ("left", "bottom", ...), [x,y] or {layerEdgeOf: id}');
}

/** move the anchor to local point `a2` keeping the layer where it is on screen. exact at every time
 *  when scale/rotation are static; with animated scale/rotation, exact at every position key (or at t). */
function pivotTx(tx: Tx, l: Layer, a2: number[], t: number): { from: number[]; to: number[]; note?: string } {
  const a = valueAt(l, 'anchor', t);
  const d = [a2[0] - a[0], a2[1] - a[1]];
  const from = a.slice();
  if (Math.hypot(d[0], d[1]) < 1e-9) return { from, to: a };
  const lin = (tt: number) => {
    const sc = valueAt(l, 'scale', tt), r = (valueAt(l, 'rotation', tt)[0] * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
    return [cs * sc[0] / 100 * d[0] - sn * sc[1] / 100 * d[1], sn * sc[0] / 100 * d[0] + cs * sc[1] / 100 * d[1]];
  };
  const ap = l.props.anchor ?? { v: a.slice() };
  if (!l.props.anchor) tx.set(l.props, 'anchor', ap);
  tx.set(ap, 'v', [ap.v[0] + d[0], ap.v[1] + d[1]]);
  if (ap.kf?.length) tx.set(ap, 'kf', ap.kf.map(k => ({ ...k, v: [k.v[0] + d[0], k.v[1] + d[1]] })));
  const pp = l.props.position ?? { v: valueAt(l, 'position', t) };
  if (!l.props.position) tx.set(l.props, 'position', pp);
  const now = lin(t);
  tx.set(pp, 'v', [pp.v[0] + now[0], pp.v[1] + now[1]]);
  if (pp.kf?.length) tx.set(pp, 'kf', pp.kf.map(k => { const o = lin(k.t); return { ...k, v: [k.v[0] + o[0], k.v[1] + o[1]] }; }));
  tx.touch(l.id);
  const animL = !!(l.props.scale?.kf?.length || l.props.rotation?.kf?.length);
  return { from, to: [a2[0], a2[1]], note: animL ? `scale/rotation are animated: they now turn around the new pivot (frame ${fmtTime(t)}${pp.kf?.length ? ' and the position keys' : ''} kept exact)` : undefined };
}

// ---------------------------------------------------------------------------------------------
// rig
// ---------------------------------------------------------------------------------------------

type F = { t: number; v: number[]; ease?: any; interp?: 'hold' | 'linear'; sOut?: number[]; sIn?: number[] };
interface Ctx {
  s: ReturnType<typeof st>; t0: number; dur: number; k: number; reverse: boolean; span: number; o: any;
  touched: Set<string>; created: { id: string; name: string; role: string }[]; notes: string[]; loops: string[];
}

function revEase(e: any): any {
  const r = resolveEase(e);
  if (r.bounce !== undefined) return 'Back In';
  if (r.linear) return 'Linear';
  return [1 - r.v[2], 1 - r.v[3], 1 - r.v[0], 1 - r.v[1]];
}
/** play a key list backwards inside [a, b] (exits from entrances) */
function mirror(fr: F[], a: number, b: number): F[] {
  const n = fr.length;
  return fr.map((_, j) => {
    const o = fr[n - 1 - j], seg = j < n - 1 ? fr[n - 2 - j] : undefined;
    return { t: a + b - o.t, v: o.v, ease: seg ? (seg.interp === 'hold' ? undefined : revEase(seg.ease)) : undefined, interp: seg?.interp, sOut: o.sIn, sIn: o.sOut };
  });
}

/** write keys for one property, replacing existing keys inside their time range */
function put(c: Ctx, tx: Tx, l: Layer, key: PropKey, frames: F[], loop = false) {
  let fr = frames.map(f => ({ ...f, v: f.v.slice() }));
  if (c.reverse) fr = mirror(fr, c.t0, c.t0 + c.span);
  const kf = buildKeys(key, fr);
  const p = l.props[key] ?? { v: valueAt(l, key, fr[0].t) };
  if (!l.props[key]) tx.set(l.props, key, p);
  const lo = kf[0].t - 1e-6, hi = kf[kf.length - 1].t + 1e-6;
  tx.set(p, 'kf', [...(p.kf ?? []).filter(k => k.t < lo || k.t > hi), ...kf].sort((x, y) => x.t - y.t));
  if (loop) { tx.set(p, 'expr', "loopOut('cycle')"); c.loops.push(`${l.name}.${key}`); }
  tx.touch(l.id);
  c.touched.add(l.id);
}

const edgeOf = (l: Layer, side: string, t: number): number[] => {
  const b = localBox(l, t), f = NAMED[side];
  return [b[0] + (b[2] - b[0]) * f[0], b[1] + (b[3] - b[1]) * f[1]];
};
const OPP: Record<string, string> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
const DIRS: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0], 'up-left': [-0.7071, -0.7071], 'up-right': [0.7071, -0.7071], 'down-left': [-0.7071, 0.7071], 'down-right': [0.7071, 0.7071] };
const scaleBy = (S: number[], fx: number, fy: number) => [S[0] * fx, S[1] * fy];
/** a comp-space vector expressed in the layer's parent space */
function toParentVec(l: Layer, v: number[], t: number) {
  const m = inv(worldMatrix(st(), l.parent, t));
  return [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];
}
function toParentPt(l: Layer, p: number[], t: number) { return apply(inv(worldMatrix(st(), l.parent, t)), p[0], p[1]); }

/** deep copy of a layer subtree (fresh ids) inserted into `parent` at `index` */
function cloneTx(tx: Tx, src: Layer, parent: string | null, index: number, name: string): Layer {
  const s = st();
  const rec = (l: Layer, par: string | null): Layer => {
    const c: Layer = structuredClone(l);
    c.id = createLayer('group').id;
    c.parent = par;
    delete c.sceneKey; delete c.link;
    c.children = [];
    const kids = l.children.map(id => rec(s.layer(id)!, c.id));
    c.children = kids.map(k => k.id);
    for (const k of kids) tx.set(s.project.layers, k.id, k);
    return c;
  };
  const c = rec(src, parent);
  c.name = name;
  insertLayer(s, tx, c, parent, index);
  return c;
}
function indexIn(l: Layer) { const s = st(); return (l.parent ? s.layer(l.parent)!.children : s.comp.root).indexOf(l.id); }
/** a group with an identity transform: its children use the parent's coordinates */
function identityGroup(tx: Tx, name: string, parent: string | null, index: number): Layer {
  const s = st();
  const [w, h] = parent ? layerSize(s, s.layer(parent)!, s.time) : [s.comp.width, s.comp.height];
  const g = createLayer('group', { x: 0, y: 0, w, h, name });
  g.props.anchor = { v: [0, 0] }; g.props.position = { v: [0, 0] };
  insertLayer(s, tx, g, parent, index);
  return g;
}

/** perspective taper of path geometry for a hinge: the free edge grows (toward) or shrinks (away) */
function taper(cmds: PathCmd[], gb: Box, side: string, e: number): PathCmd[] {
  const horiz = side === 'left' || side === 'right';
  const w = horiz ? gb[2] - gb[0] : gb[3] - gb[1], cy = horiz ? (gb[1] + gb[3]) / 2 : (gb[0] + gb[2]) / 2;
  const f = (x: number, y: number): [number, number] => {
    const u = side === 'left' ? (x - gb[0]) / w : side === 'right' ? (gb[2] - x) / w : side === 'top' ? (y - gb[1]) / w : (gb[3] - y) / w;
    const k = 1 + (e - 1) * Math.max(0, Math.min(1, u));
    return horiz ? [x, cy + (y - cy) * k] : [cy + (x - cy) * k, y];
  };
  return cmds.map(c => {
    if (c[0] === 'Z') return c;
    const o: any[] = [c[0]];
    for (let i = 1; i < c.length; i += 2) o.push(...f(c[i] as number, c[i + 1] as number));
    return o as PathCmd;
  });
}

/** the hole (in another path of the same parent) that layer l sits in, as commands in l's parent space */
function openingAround(l: Layer, t: number): PathCmd[] | null {
  const s = st();
  const b = compBox(l, t), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const sibs = (l.parent ? s.layer(l.parent)!.children : s.comp.root).map(id => s.layer(id)!).filter(x => x && x.id !== l.id && x.type === 'path' && x.geometry?.length);
  const toParent = inv(worldMatrix(s, l.parent, t));
  for (const o of sibs) {
    const M = mul(worldMatrix(s, o.id, t), geomScale(o, t));
    const [gx, gy] = apply(inv(M), cx, cy);
    for (const g of o.geometry!) {
      const { subs, parts } = pathComponents(g.cmds, g.fillRule);
      for (const p of parts) for (let h = 0; h < p.holeSubs.length; h++) {
        if (p.holeRings[h] && winding(p.holeRings[h], gx, gy) !== 0) return transformCmds(subs[p.holeSubs[h]], mul(toParent, M) as any);
      }
    }
  }
  return null;
}

function rigHinge(c: Ctx, tx: Tx, list: Layer[]) {
  const { s, t0, dur, k } = c;
  const side = normName(c.o.edge ?? 'left');
  if (!OPP[side]) throw new Error('hinge edge must be left, right, top or bottom (the side the hinge is on)');
  const angle = Math.min(88, Math.max(5, c.o.angle ?? 50 + 30 * k)) * Math.PI / 180;
  const mode = c.o.mode ?? 'open';
  if (!['open', 'close', 'open-close'].includes(mode)) throw new Error('hinge mode must be open, close or open-close');
  const away = (c.o.swing ?? 'in') !== 'out';
  const horiz = side === 'left' || side === 'right';
  const hold = c.o.hold ?? 0.6;
  const stagger = c.o.stagger ?? 0.12;
  list.forEach((l, i) => {
    const ts = t0 + i * stagger;
    pivotTx(tx, l, edgeOf(l, side, ts), ts);
    const S = valueAt(l, 'scale', ts);
    const [w, h] = layerSize(s, l, ts);
    const span = horiz ? w : h;
    const D = 2.6 * Math.max(w, h);
    const edgeK = (th: number) => (away ? D / (D + span * Math.sin(th)) : D / (D - span * 0.8 * Math.sin(th)));
    // angle path: open = ease into the swing, a little past, settle back; close = accelerate, slam, rebound
    let seq: { t: number; th: number; ease?: any }[];
    const open = (a: number, d: number) => [{ t: a, th: 0, ease: [0.45, 0, 0.2, 1] }, { t: a + d * 0.78, th: angle + 0.09 * k, ease: 'Sine In Out' }, { t: a + d, th: angle }];
    const close = (a: number, d: number) => [{ t: a, th: angle, ease: [0.55, 0, 0.85, 0.45] }, { t: a + d * 0.8, th: 0, ease: 'Quad Out' }, { t: a + d * 0.9, th: 0.06 + 0.06 * k, ease: 'Quad In' }, { t: a + d, th: 0 }];
    if (mode === 'open') seq = open(ts, dur);
    else if (mode === 'close') seq = close(ts, dur);
    else {
      const o = open(ts, dur), cl = close(ts + dur + Math.max(0.05, hold), dur);
      seq = [...o.slice(0, -1), { ...o[o.length - 1], ease: 'Linear' }, ...cl];
    }
    // main axis foreshortening (cos), cross axis: a hint of perspective for non-paths
    const cross = (th: number) => (l.type === 'path' ? 1 : away ? 1 - 0.05 * Math.sin(th) : 1 + 0.05 * Math.sin(th));
    put(c, tx, l, 'scale', seq.map(q => ({ t: q.t, v: horiz ? scaleBy(S, Math.max(0.04, Math.cos(q.th)), cross(q.th)) : scaleBy(S, cross(q.th), Math.max(0.04, Math.cos(q.th))), ease: q.ease })));
    if (l.type === 'path' && l.geometry?.length && c.o.perspective !== false) {
      const gb = cmdsBounds(l.geometry.flatMap(g => g.cmds)), GB: Box = [gb[0], gb[1], gb[0] + gb[2], gb[1] + gb[3]];
      const kf = seq.map(q => {
        const e = resolveEase(q.ease ?? 'Linear');
        return { t: q.t, geometry: l.geometry!.map(g => ({ cmds: taper(g.cmds, GB, side, edgeK(q.th)), fillRule: g.fillRule })), interp: 'bezier' as const, out: [e.v[0], e.v[1]] as [number, number], in: [0.667, 1] as [number, number] };
      });
      for (let j = 1; j < kf.length; j++) { const e = resolveEase(seq[j - 1].ease ?? 'Linear'); kf[j].in = [e.v[2], e.v[3]]; }
      tx.set(l, 'pathKf', kf);
      tx.recompile();
    }
    const fill = l.props.fill ? valueAt(l, 'fill', ts) : null;
    if (fill && fill[3] > 0.01 && c.o.shade !== false && !l.paints?.length) {
      const dark = (th: number) => { const f = 1 - (away ? 0.38 : 0.12) * Math.sin(th); return [fill[0] * f, fill[1] * f, fill[2] * f, fill[3]]; };
      put(c, tx, l, 'fill', seq.map(q => ({ t: q.t, v: dark(q.th), ease: q.ease })));
    }
    if (c.o.light) {
      // the opening behind the door, lit as it opens: the hole the door sits in (a doorway cut into the
      // house) when there is one, else the door's own closed outline
      const col = c.o.light === true ? [1, 0.86, 0.52, 1] : parseColor(c.o.light);
      const hole = openingAround(l, ts);
      let lt: Layer;
      if (hole) {
        const bb = cmdsBounds(hole);
        lt = createLayer('path', { x: bb[0], y: bb[1], w: Math.max(1e-3, bb[2]), h: Math.max(1e-3, bb[3]) });
        lt.geometry = [{ cmds: transformCmds(hole, [1, 0, 0, 1, -bb[0], -bb[1]]), fillRule: 'nonzero' }];
        lt.geomSize = [Math.max(1e-3, bb[2]), Math.max(1e-3, bb[3])];
      } else {
        lt = l.type === 'path' ? createLayer('path') : createLayer(l.type === 'ellipse' ? 'ellipse' : 'rect');
        for (const key of ['anchor', 'position', 'rotation', 'size'] as const) lt.props[key] = { v: valueAt(l, key, ts) };
        lt.props.scale = { v: S.slice() };
        if (l.type === 'path') { lt.geometry = structuredClone(l.geometry); lt.geomSize = l.geomSize ? [...l.geomSize] as [number, number] : undefined; }
        if (l.props.radius) lt.props.radius = { v: valueAt(l, 'radius', ts) };
      }
      lt.name = `${l.name} light`;
      lt.props.fill = { v: col };
      insertLayer(s, tx, lt, l.parent, indexIn(l));
      const op = (th: number) => [100 * Math.min(1, Math.sin(th) / Math.sin(angle))];
      put(c, tx, lt, 'opacity', seq.map(q => ({ t: q.t, v: op(q.th), ease: q.ease })));
      c.created.push({ id: lt.id, name: lt.name, role: 'light behind the opening' });
    }
  });
}

function rigGrow(c: Ctx, tx: Tx, list: Layer[]) {
  const { t0, dur, k } = c;
  const from = normName(c.o.from ?? c.o.direction ?? 'bottom');
  if (!NAMED[from]) throw new Error(`grow from must be bottom, top, left, right, center or a corner (got "${c.o.from ?? c.o.direction}")`);
  const vert = from === 'bottom' || from === 'top';
  const stagger = c.o.stagger ?? 0.08;
  list.forEach((l, i) => {
    const ts = t0 + i * stagger;
    // pivot: the "from" edge, or "keep" (set_pivot already put it, e.g. on another layer's edge), or any pivot spec
    if (c.o.pivot !== 'keep') pivotTx(tx, l, c.o.pivot !== undefined ? pivotPoint(l, c.o.pivot, ts) : edgeOf(l, from, ts), ts);
    const S = valueAt(l, 'scale', ts);
    const cross = from === 'center' || from.includes('-') ? 0 : 0.45;
    put(c, tx, l, 'scale', [{ t: ts, v: vert ? scaleBy(S, cross, 0) : scaleBy(S, 0, cross), ease: `spring:${(0.25 + 0.3 * k).toFixed(2)}` }, { t: ts + dur, v: S }]);
    if (k > 0.25 && from !== 'center') {
      // organic secondary motion: a small sway that settles after the growth
      const R = valueAt(l, 'rotation', ts)[0], a = 2 + 5 * k, sgn = i % 2 ? -1 : 1;
      put(c, tx, l, 'rotation', [{ t: ts, v: [R - sgn * a], ease: 'Sine In Out' }, { t: ts + dur * 0.55, v: [R + sgn * a * 0.6], ease: 'Sine In Out' }, { t: ts + dur * 0.85, v: [R - sgn * a * 0.2], ease: 'Sine In Out' }, { t: ts + dur * 1.1, v: [R] }]);
    }
  });
}

function rigSwing(c: Ctx, tx: Tx, list: Layer[]) {
  const { t0, dur, k } = c;
  const at = normName(c.o.pivot ?? c.o.edge ?? 'top');
  if (!NAMED[at]) throw new Error('swing pivot must be a named spot (top, left, ...)');
  const A = c.o.angle ?? 8 + 25 * k;
  const n = Math.max(2, Math.round(c.o.swings ?? 5));
  list.forEach((l, i) => {
    const ts = t0 + i * (c.o.stagger ?? 0.1);
    pivotTx(tx, l, edgeOf(l, at, ts), ts);
    const R = valueAt(l, 'rotation', ts)[0];
    if (c.o.loop) {
      const T = dur / 2;
      put(c, tx, l, 'rotation', [{ t: ts, v: [R - A], ease: 'Sine In Out' }, { t: ts + T, v: [R + A], ease: 'Sine In Out' }, { t: ts + 2 * T, v: [R - A] }], true);
      return;
    }
    // damped pendulum: each half swing a little shorter and ~45% smaller
    const fr: F[] = [];
    let tt = ts, half = dur / (n * 0.8 + 0.2);
    for (let j = 0; j <= n; j++) {
      fr.push({ t: tt, v: [R + (j === n ? 0 : A * Math.pow(-0.55, j))], ease: 'Sine In Out' });
      tt += half; half *= 0.92;
    }
    put(c, tx, l, 'rotation', fr);
  });
}

function rigUnfold(c: Ctx, tx: Tx, list: Layer[]) {
  const { s, t0, dur, k } = c;
  const dir = normName(c.o.direction ?? 'right');
  if (!OPP[dir]) throw new Error('unfold direction must be right, left, down/bottom or up/top');
  const d2 = dir === 'down' ? 'bottom' : dir === 'up' ? 'top' : dir;
  const hingeSide = OPP[d2];
  const sorted = c.o.keepOrder ? list : list.slice().sort((a, b) => { const A = compBox(a, s.time), B = compBox(b, s.time); return d2 === 'right' ? A[0] - B[0] : d2 === 'left' ? B[2] - A[2] : d2 === 'bottom' ? A[1] - B[1] : B[3] - A[3]; });
  const n = sorted.length, each = dur / (1 + (n - 1) * 0.55), step = each * 0.55;
  c.span = dur;
  const horiz = d2 === 'left' || d2 === 'right';
  sorted.forEach((l, i) => {
    const ts = t0 + i * step;
    pivotTx(tx, l, edgeOf(l, hingeSide, ts), ts);
    const S = valueAt(l, 'scale', ts);
    const over = 1 + 0.06 * k;
    put(c, tx, l, 'scale', [{ t: ts, v: horiz ? scaleBy(S, 0, 1) : scaleBy(S, 1, 0), ease: [0.3, 0.6, 0.4, 1] }, { t: ts + each * 0.75, v: horiz ? scaleBy(S, over, 1) : scaleBy(S, 1, over), ease: 'Sine In Out' }, { t: ts + each, v: S }]);
    const fill = l.props.fill ? valueAt(l, 'fill', ts) : null;
    if (fill && fill[3] > 0.01 && !l.paints?.length) put(c, tx, l, 'fill', [{ t: ts, v: [fill[0] * 0.55, fill[1] * 0.55, fill[2] * 0.55, fill[3]], ease: 'Ease Out' }, { t: ts + each * 0.8, v: fill }]);
  });
}

function rigOrbit(c: Ctx, tx: Tx, list: Layer[]) {
  const { s, t0, dur } = c;
  let C: number[];
  if (c.o.around) { const b = compBox(need(c.o.around), t0); C = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
  else if (Array.isArray(c.o.center)) C = c.o.center.map(Number);
  else throw new Error('orbit needs center: [x,y] (composition px) or around: <layer id>');
  const turns = c.o.turns ?? 1, cw = (c.o.direction ?? 'cw') !== 'ccw' ? 1 : -1;
  const tilt = Math.min(0.95, Math.max(0, c.o.tilt ?? 0));
  if (!(turns > 0)) throw new Error('turns must be > 0');
  list.forEach(l => {
    const Cp = toParentPt(l, C, t0);
    const P = valueAt(l, 'position', t0);
    const ry0 = 1 - tilt;
    const dx = P[0] - Cp[0], dy = (P[1] - Cp[1]) / (ry0 || 1);
    const R = c.o.radius ?? Math.hypot(dx, dy);
    if (!(R > 0.5)) throw new Error(`"${l.name}" sits on the orbit center: give radius, or move it out first`);
    const a0 = Math.atan2(dy, dx);
    const nq = Math.max(1, Math.round(turns * 4));
    const kk = (4 / 3) * Math.tan(((Math.PI / 2) * turns * 4 / nq) / 4);
    const fr: F[] = [];
    for (let j = 0; j <= nq; j++) {
      const a = a0 + cw * (j / nq) * turns * Math.PI * 2;
      const pos = [Cp[0] + R * Math.cos(a), Cp[1] + R * ry0 * Math.sin(a)];
      const tan = [-Math.sin(a) * R * kk * cw, Math.cos(a) * R * ry0 * kk * cw];
      fr.push({ t: t0 + (dur * j) / nq, v: pos, interp: 'linear', sOut: tan, sIn: [-tan[0], -tan[1]] });
    }
    put(c, tx, l, 'position', fr, !!c.o.loop);
    if (c.o.orient) { const r = valueAt(l, 'rotation', t0)[0]; put(c, tx, l, 'rotation', [{ t: t0, v: [r], interp: 'linear' }, { t: t0 + dur, v: [r + cw * 360 * turns] }], !!c.o.loop); }
  });
  void s;
}

function rigBlink(c: Ctx, tx: Tx, list: Layer[]) {
  const { s, t0, k } = c;
  const count = Math.max(1, Math.min(3, Math.round(c.o.count ?? 1)));
  const every = c.o.every ?? 3;
  const close = c.o.closeTime ?? 0.07, open = c.o.openTime ?? 0.13;
  const end = c.o.loop ? s.comp.duration : t0 + 0.01;
  list.forEach(l => {
    pivotTx(tx, l, edgeOf(l, normName(c.o.pivot ?? 'center'), t0), t0);
    const S = valueAt(l, 'scale', t0);
    const fr: F[] = [];
    for (let tb = t0, j = 0; tb <= end + 1e-6; tb += every, j++) {
      const n = j % 3 === 2 && c.o.loop ? Math.max(count, 2) : count; // a natural double blink now and then
      for (let b = 0; b < n; b++) {
        const tt = tb + b * (close + open + 0.06);
        fr.push({ t: tt, v: S, ease: 'Quad In' }, { t: tt + close, v: scaleBy(S, 1 + 0.04 * k, 0.06), ease: [0.2, 0.6, 0.35, 1] }, { t: tt + close + open, v: S, ease: 'Linear' });
      }
    }
    put(c, tx, l, 'scale', fr);
  });
}

function rigPulse(c: Ctx, tx: Tx, list: Layer[], beat: boolean) {
  const { t0, k } = c;
  const period = c.o.period ?? (beat ? 0.9 : 1.2);
  list.forEach((l, i) => {
    const ts = t0 + i * (c.o.stagger ?? 0);
    pivotTx(tx, l, edgeOf(l, normName(c.o.pivot ?? 'center'), ts), ts);
    const S = valueAt(l, 'scale', ts);
    const up = (f: number) => scaleBy(S, 1 + f, 1 + f);
    const big = 0.06 + 0.16 * k, small = big * 0.55;
    const fr: F[] = beat
      ? [{ t: ts, v: S, ease: [0.3, 0, 0.2, 1] }, { t: ts + period * 0.11, v: up(big), ease: [0.4, 0, 0.6, 1] }, { t: ts + period * 0.24, v: up(-0.02 * k), ease: [0.3, 0, 0.2, 1] }, { t: ts + period * 0.34, v: up(small), ease: [0.4, 0, 0.3, 1] }, { t: ts + period * 0.55, v: S, ease: 'Linear' }, { t: ts + period, v: S }]
      : [{ t: ts, v: S, ease: 'Sine In Out' }, { t: ts + period / 2, v: up(big * 0.6), ease: 'Sine In Out' }, { t: ts + period, v: S }];
    put(c, tx, l, 'scale', fr, c.o.loop !== false);
  });
}

function waveCmds(width: number, amp: number, lambda: number, depth: number): PathCmd[] {
  const out: PathCmd[] = [['M', 0, amp]];
  const half = lambda / 2;
  let x = 0, sgn = -1;
  while (x < width - 1e-6) {
    const x2 = x + half;
    out.push(['C', x + half * 0.36, amp + sgn * amp * 1.33, x + half * 0.64, amp + sgn * amp * 1.33, x2, amp]);
    x = x2; sgn = -sgn;
  }
  out.push(['L', x, depth], ['L', 0, depth], ['Z']);
  return out;
}

function rigLiquid(c: Ctx, tx: Tx, list: Layer[]) {
  const { s, t0, dur, k } = c;
  const level = Math.min(1, Math.max(0, c.o.level ?? 1));
  list.forEach(l => {
    if (!['path', 'rect', 'ellipse', 'group', 'text'].includes(l.type)) throw new Error(`liquid-fill needs a shape, text or group layer ("${l.name}" is ${l.type})`);
    const B = compBox(l, t0);
    const p0 = toParentPt(l, [B[0], B[1]], t0), p1 = toParentPt(l, [B[2], B[3]], t0);
    const bx = Math.min(p0[0], p1[0]), by0 = Math.min(p0[1], p1[1]), bw = Math.abs(p1[0] - p0[0]), bh = Math.abs(p1[1] - p0[1]);
    const fill = l.props.fill ? valueAt(l, 'fill', t0) : [0, 0, 0, 0];
    const col = c.o.color !== undefined ? parseColor(c.o.color) : fill[3] > 0.1 ? [fill[0] * 0.62, fill[1] * 0.62, fill[2] * 0.62, 1] : [0.24, 0.55, 1, 1];
    const lambda = bw / (c.o.waves ?? 1.5);
    const amp = c.o.amplitude ?? Math.max(3, bh * (0.025 + 0.035 * k));
    const period = c.o.period ?? 1.4;
    const G = identityGroup(tx, `${l.name} liquid`, l.parent, indexIn(l) + 1);
    const mask = cloneTx(tx, l, G.id, 0, `${l.name} liquid mask`);
    tx.set(mask, 'mask', true);
    tx.set(mask, 'visible', true);
    if (mask.props.fill && valueAt(mask, 'fill', t0)[3] < 0.5) tx.set(mask.props, 'fill', { v: [1, 1, 1, 1] });
    const lvl = identityGroup(tx, 'Level', G.id, 1);
    const wl = by0 + bh - level * (bh + 2 * amp); // waterline at the end
    const width = bw + lambda * 2, depth = bh + amp * 4;
    const mkWave = (name: string, color: number[], phase: number, per: number, idx: number) => {
      const w = createLayer('path', { x: 0, y: 0, w: width, h: depth, name });
      w.geometry = [{ cmds: waveCmds(width, amp, lambda, depth), fillRule: 'nonzero' }];
      w.geomSize = [width, depth];
      w.props.fill = { v: color };
      w.props.anchor = { v: [0, amp] };
      const x0 = bx - lambda * 2 + phase;
      w.props.position = { v: [x0, wl] };
      insertLayer(s, tx, w, lvl.id, idx);
      put(c, tx, w, 'position', [{ t: t0, v: [x0, wl], interp: 'linear' }, { t: t0 + per, v: [x0 + lambda, wl] }], true);
      return w;
    };
    const back = c.o.backWave === false ? null : mkWave('Back wave', [Math.min(1, col[0] * 1.25 + 0.08), Math.min(1, col[1] * 1.25 + 0.08), Math.min(1, col[2] * 1.25 + 0.08), 0.75], lambda * 0.5, period * 1.6, 0);
    const front = mkWave('Wave', col, 0, period, back ? 1 : 0);
    const rise = by0 + bh + amp * 3 - wl;
    put(c, tx, lvl, 'position', [{ t: t0, v: [0, rise], ease: c.o.ease ?? [0.35, 0, 0.25, 1] }, { t: t0 + dur, v: [0, 0] }]);
    c.created.push({ id: G.id, name: G.name, role: 'liquid group (mask + rising level)' }, { id: mask.id, name: mask.name, role: 'mask (copy of the shape)' }, { id: front.id, name: front.name, role: 'wave (loops sideways)' });
    if (back) c.created.push({ id: back.id, name: back.name, role: 'back wave' });
  });
}

function rigLaunch(c: Ctx, tx: Tx, list: Layer[]) {
  const { s, t0, dur, k } = c;
  const d = typeof c.o.direction === 'number' ? [Math.sin(c.o.direction * Math.PI / 180), -Math.cos(c.o.direction * Math.PI / 180)] : DIRS[normName(c.o.direction ?? 'up')];
  if (!d) throw new Error(`launch direction must be ${Object.keys(DIRS).join(', ')} or an angle in degrees (0 = up)`);
  const vert = Math.abs(d[1]) >= Math.abs(d[0]);
  const back = vert ? (d[1] < 0 ? 'bottom' : 'top') : d[0] < 0 ? 'right' : 'left';
  const ant = dur * 0.3;
  list.forEach((l, i) => {
    const ts = t0 + i * (c.o.stagger ?? 0.1);
    pivotTx(tx, l, edgeOf(l, back, ts), ts);
    const S = valueAt(l, 'scale', ts), P = valueAt(l, 'position', ts);
    const B = compBox(l, ts), W = s.comp.width, H = s.comp.height;
    const need2 = [d[0] > 0 ? W - B[0] : d[0] < 0 ? B[2] : Infinity, d[1] > 0 ? H - B[1] : d[1] < 0 ? B[3] : Infinity].map((x, j) => x / Math.abs(d[j] || 1e-9));
    const dist = c.o.distance ?? Math.min(...need2) + 60;
    const vec = toParentVec(l, [d[0] * dist, d[1] * dist], ts), dip = toParentVec(l, [-d[0] * (4 + 10 * k), -d[1] * (4 + 10 * k)], ts);
    const sq = (along: number, across: number) => (vert ? scaleBy(S, across, along) : scaleBy(S, along, across));
    const tl = ts + ant;
    // anticipation (crouch), release (stretch), exit with acceleration
    put(c, tx, l, 'scale', [{ t: ts, v: S, ease: 'Ease In Out' }, { t: tl, v: sq(1 - 0.22 * k, 1 + 0.12 * k), ease: [0.2, 0.8, 0.3, 1] }, { t: tl + 0.12, v: sq(1 + 0.3 * k, 1 - 0.14 * k), ease: 'Ease Out' }, { t: ts + dur, v: sq(1 + 0.12 * k, 1 - 0.05 * k) }]);
    put(c, tx, l, 'position', [{ t: ts, v: P, ease: 'Ease In Out' }, { t: tl, v: [P[0] + dip[0], P[1] + dip[1]], ease: [0.6, 0, 0.9, 0.4] }, { t: ts + dur, v: [P[0] + vec[0], P[1] + vec[1]] }]);
    if (k > 0.3 && c.o.shake !== false) {
      // rumble while it charges up
      const R = valueAt(l, 'rotation', ts)[0], a = 1 + 2.5 * k;
      const fr: F[] = [{ t: ts, v: [R], ease: 'Linear' }];
      for (let j = 1; j < 6; j++) fr.push({ t: ts + (ant * j) / 6, v: [R + (j % 2 ? a : -a) * (j / 6)], ease: 'Linear' });
      fr.push({ t: tl, v: [R] });
      put(c, tx, l, 'rotation', fr);
    }
    if (c.o.trail !== false) {
      // speed trail: fading echoes that lag behind and only show in flight
      const n = Math.max(1, Math.min(4, c.o.trail === true || c.o.trail === undefined ? 2 : +c.o.trail));
      for (let j = 1; j <= n; j++) {
        const g = cloneTx(tx, s.layer(l.id)!, l.parent, indexIn(l), `${l.name} trail ${j}`);
        const lag = 0.035 * j;
        for (const key of ['position', 'scale', 'rotation'] as const) { const p = g.props[key]; if (p?.kf) tx.set(p, 'kf', p.kf.map(x => ({ ...x, t: x.t + lag }))); }
        const O = valueAt(l, 'opacity', ts)[0];
        put(c, tx, g, 'opacity', [{ t: tl + lag - 0.01, v: [0], interp: 'hold' }, { t: tl + lag, v: [O * (0.5 / j)], ease: 'Linear' }, { t: ts + dur + lag, v: [0] }]);
        c.created.push({ id: g.id, name: g.name, role: 'trail echo' });
      }
    }
  });
}

function rigLand(c: Ctx, tx: Tx, list: Layer[]) {
  const { s, t0, dur, k } = c;
  const fromSpec = c.o.from ?? 'top';
  list.forEach((l, i) => {
    const ts = t0 + i * (c.o.stagger ?? 0.1);
    pivotTx(tx, l, edgeOf(l, 'bottom', ts), ts);
    const S = valueAt(l, 'scale', ts), P = valueAt(l, 'position', ts);
    const B = compBox(l, ts), h = B[3] - B[1];
    let off: number[];
    if (Array.isArray(fromSpec)) off = fromSpec.map(Number);
    else {
      const f = normName(fromSpec);
      const up = -(B[3] + 40);
      off = f === 'top' ? [0, up] : f === 'left' || f === 'top-left' ? [-(B[2] + 40), up * 0.6] : f === 'right' || f === 'top-right' ? [s.comp.width - B[0] + 40, up * 0.6] : (() => { throw new Error('land from must be top, left, right, top-left, top-right or an offset [dx,dy]'); })();
    }
    const offP = toParentVec(l, off, ts);
    const tl = ts + dur * 0.55;
    const start = [P[0] + offP[0], P[1] + offP[1]];
    // a falling arc: leaves sideways, arrives steeply from above
    const sOut = [-offP[0] * 0.55, 0], sIn = [offP[0] * 0.15, offP[1] * 0.5];
    const hop = toParentVec(l, [0, -h * 0.1 * k], ts);
    const fr: F[] = [{ t: ts, v: start, ease: [0.45, 0, 0.85, 0.5], sOut }, { t: tl, v: P, sIn: Math.abs(offP[0]) > 1 ? sIn : undefined }];
    if (k > 0.45) {
      // a little hop after the impact
      fr[1] = { ...fr[1], ease: 'Quad Out' };
      fr.push({ t: tl + dur * 0.14, v: [P[0] + hop[0], P[1] + hop[1]], ease: 'Quad In' }, { t: tl + dur * 0.27, v: P });
    }
    put(c, tx, l, 'position', fr);
    put(c, tx, l, 'scale', [
      { t: ts, v: scaleBy(S, 1 - 0.08 * k, 1 + 0.12 * k), ease: 'Ease In' },
      { t: tl, v: scaleBy(S, 1 - 0.1 * k, 1 + 0.14 * k), ease: 'Quad Out' },
      { t: tl + dur * 0.08, v: scaleBy(S, 1 + 0.22 * k, 1 - 0.26 * k), ease: `spring:${(0.3 + 0.3 * k).toFixed(2)}` },
      { t: ts + dur, v: S },
    ]);
    if (Math.abs(offP[0]) > 1) { const R = valueAt(l, 'rotation', ts)[0], sg = Math.sign(offP[0]); put(c, tx, l, 'rotation', [{ t: ts, v: [R + sg * 14 * k], ease: 'Ease In Out' }, { t: tl, v: [R - sg * 3 * k], ease: 'Back Out' }, { t: tl + dur * 0.3, v: [R] }]); }
  });
}

function rigTypeOn(c: Ctx, tx: Tx, list: Layer[]) {
  const { s, t0 } = c;
  list.forEach(l => {
    if (l.type === 'text' && l.text) {
      const n = Math.max(1, [...l.text.content].filter(ch => ch.trim()).length);
      const per = c.o.duration !== undefined ? c.dur / n : c.o.speed ? 1 / c.o.speed : 0.055;
      const anim = textAnimFrom({ preset: 'Typewriter', stagger: per, mode: c.reverse ? 'out' : 'in', start: t0 });
      tx.set(l, 'textAnim', anim);
      tx.touch(l.id); c.touched.add(l.id);
      if (c.o.cursor) {
        const [w] = layerSize(s, l, t0);
        const units = textUnitsSafe(l, (l.props.size?.v[0] ?? 0) > 0 ? w : 0, 'char');
        const fs = l.text.fontSize, lm = localMatrix(s, l, t0);
        const fill = valueAt(l, 'fill', t0);
        const cur = createLayer('rect', { x: 0, y: 0, w: Math.max(2, fs * 0.07), h: fs * 1.05, name: `${l.name} cursor`, color: fill });
        insertLayer(s, tx, cur, l.parent, indexIn(l) + 1);
        const at = (u: { x: number; y: number; w: number; h: number } | null) => apply(lm, u ? u.x + u.w + fs * 0.06 : 0, (u ? u.y + u.h / 2 : fs * l.text!.lineHeight / 2));
        const fr: F[] = [{ t: t0, v: at(null), interp: 'hold' }];
        units.forEach((u, j) => fr.push({ t: t0 + per * (j + 1), v: at(u), interp: 'hold' }));
        put(c, tx, cur, 'position', fr);
        const T = t0 + per * (units.length + 1);
        put(c, tx, cur, 'opacity', [{ t: T, v: [100], interp: 'hold' }, { t: T + 0.45, v: [0], interp: 'hold' }, { t: T + 0.9, v: [100] }], true);
        c.created.push({ id: cur.id, name: cur.name, role: 'blinking cursor' });
      }
      return;
    }
    if (l.type === 'group' && l.children.length) {
      // already split into letters: reveal them one after another
      const per = c.o.speed ? 1 / c.o.speed : c.dur / l.children.length;
      l.children.forEach((id, j) => { const ch = s.layer(id)!; const O = valueAt(ch, 'opacity', t0)[0]; put(c, tx, ch, 'opacity', [{ t: t0 + per * j, v: [0], interp: 'hold' }, { t: t0 + per * (j + 1), v: [O] }]); });
      return;
    }
    throw new Error(`type-on needs text layers or a group of letters ("${l.name}" is ${l.type})`);
  });
}

function rigAssemble(c: Ctx, tx: Tx, list: Layer[]) {
  const { s, t0, dur, k } = c;
  const boxes = list.map(l => compBox(l, t0));
  const cs = boxes.map(b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
  const C = c.o.center ?? [cs.reduce((a, p) => a + p[0], 0) / cs.length, cs.reduce((a, p) => a + p[1], 0) / cs.length];
  const R = rng(c.o.seed ?? 7);
  const dist = cs.map(p => Math.hypot(p[0] - C[0], p[1] - C[1]));
  const lo = Math.min(...dist), hi = Math.max(...dist);
  const spread = c.o.spread ?? dur * 0.45, each = dur - spread;
  const far = c.o.distance ?? 80 + 260 * k;
  const outsideIn = c.o.order === 'outside-in';
  list.forEach((l, i) => {
    const rel = hi > lo ? (dist[i] - lo) / (hi - lo) : i / Math.max(1, list.length - 1);
    const ts = t0 + (outsideIn ? 1 - rel : rel) * spread;
    let dx = cs[i][0] - C[0], dy = cs[i][1] - C[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-3) { const a = R() * Math.PI * 2; dx = Math.cos(a); dy = Math.sin(a); } else { dx /= L; dy /= L; }
    const jit = (R() - 0.5) * 0.6;
    const v = [(dx - dy * jit) * far, (dy + dx * jit) * far];
    const P = valueAt(l, 'position', ts), vp = toParentVec(l, v, ts);
    const S = valueAt(l, 'scale', ts), Rot = valueAt(l, 'rotation', ts)[0], O = valueAt(l, 'opacity', ts)[0];
    put(c, tx, l, 'position', [{ t: ts, v: [P[0] + vp[0], P[1] + vp[1]], ease: [0.16, 1, 0.3, 1] }, { t: ts + each, v: P }]);
    put(c, tx, l, 'rotation', [{ t: ts, v: [Rot + (R() - 0.5) * 2 * (20 + 50 * k)], ease: 'Back Out' }, { t: ts + each, v: [Rot] }]);
    put(c, tx, l, 'scale', [{ t: ts, v: scaleBy(S, 0.6, 0.6), ease: `spring:${(0.2 + 0.25 * k).toFixed(2)}` }, { t: ts + each, v: S }]);
    put(c, tx, l, 'opacity', [{ t: ts, v: [0], ease: 'Ease Out' }, { t: ts + each * 0.35, v: [O] }]);
  });
  void s;
}

function rigRevealFrom(c: Ctx, tx: Tx, list: Layer[]) {
  const { s, t0, dur, k } = c;
  if (!c.o.from) throw new Error('reveal-from needs from: <layer id> (the part it emerges from, e.g. the logo mark)');
  const src = need(c.o.from);
  if (list.some(l => l.id === src.id)) throw new Error('from must not be one of the revealed layers');
  const parent = list[0].parent;
  if (list.some(l => l.parent !== parent)) throw new Error('reveal-from: the revealed layers must share a parent (pass the wordmark group, or letters of one group)');
  const mb = compBox(src, t0);
  const wb: Box = [Infinity, Infinity, -Infinity, -Infinity];
  list.forEach(l => { const b = compBox(l, t0); boxOfPts([b[0], b[1], b[2], b[3]], wb); });
  const dx = (wb[0] + wb[2]) / 2 - (mb[0] + mb[2]) / 2, dy = (wb[1] + wb[3]) / 2 - (mb[1] + mb[3]) / 2;
  const dir = c.o.direction ? normName(c.o.direction) : Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
  const D = DIRS[dir === 'bottom' ? 'down' : dir === 'top' ? 'up' : dir];
  if (!D || (D[0] && D[1])) throw new Error('reveal-from direction must be right, left, up or down');
  // the wipe edge: the mark's side facing the wordmark. everything on the mark's side of it is hidden
  const edge = D[0] > 0 ? mb[2] : D[0] < 0 ? mb[0] : D[1] > 0 ? mb[3] : mb[1];
  const m = 4000;
  const rectC: Box = D[0] > 0 ? [edge, wb[1] - m, wb[2] + m, wb[3] + m] : D[0] < 0 ? [wb[0] - m, wb[1] - m, edge, wb[3] + m] : D[1] > 0 ? [wb[0] - m, edge, wb[2] + m, wb[3] + m] : [wb[0] - m, wb[1] - m, wb[2] + m, edge];
  const shift = D[0] > 0 ? wb[2] - edge : D[0] < 0 ? edge - wb[0] : D[1] > 0 ? wb[3] - edge : edge - wb[1];
  if (shift <= 0) throw new Error('the revealed layers do not reach past the from layer\'s edge in that direction');
  const ordered = list.slice().sort((a, b) => indexIn(a) - indexIn(b));
  const G = identityGroup(tx, 'Reveal', parent, indexIn(ordered[0]));
  const p0 = toParentPt(list[0], [rectC[0], rectC[1]], t0), p1 = toParentPt(list[0], [rectC[2], rectC[3]], t0);
  const mk = createLayer('rect', { x: Math.min(p0[0], p1[0]), y: Math.min(p0[1], p1[1]), w: Math.abs(p1[0] - p0[0]), h: Math.abs(p1[1] - p0[1]), name: 'Reveal mask', color: [1, 1, 1, 1] });
  mk.mask = true;
  insertLayer(s, tx, mk, G.id, 0);
  for (const l of ordered) { detach(tx, l); tx.set(G, 'children', [...G.children, l.id]); tx.set(l, 'parent', G.id); }
  tx.structure();
  const stagger = c.o.stagger ?? (list.length > 1 ? Math.min(0.05, dur * 0.3 / list.length) : 0);
  const each = dur - stagger * (list.length - 1);
  const ordDir = list.slice().sort((a, b) => { const A = compBox(a, t0), B = compBox(b, t0); return (D[0] * (A[0] - B[0]) + D[1] * (A[1] - B[1])); });
  ordDir.forEach((l, i) => {
    const ts = t0 + i * stagger;
    const P = valueAt(l, 'position', ts);
    const off = toParentVec(l, [-D[0] * (shift + 2), -D[1] * (shift + 2)], ts);
    put(c, tx, l, 'position', [{ t: ts, v: [P[0] + off[0], P[1] + off[1]], ease: [0.16, 1, 0.3, 1] }, { t: ts + each, v: P }]);
  });
  if (c.o.nudge !== false && k > 0.2 && !c.reverse) {
    // the mark reacts: a small push back as the wordmark slides out
    const P = valueAt(src, 'position', t0), n = toParentVec(src, [-D[0] * (3 + 8 * k), -D[1] * (3 + 8 * k)], t0);
    put(c, tx, src, 'position', [{ t: t0, v: P, ease: 'Quad Out' }, { t: t0 + dur * 0.2, v: [P[0] + n[0], P[1] + n[1]], ease: `spring:0.4` }, { t: t0 + dur * 0.8, v: P }]);
  }
  c.created.push({ id: G.id, name: 'Reveal', role: 'group: mask + revealed layers' }, { id: mk.id, name: 'Reveal mask', role: 'mask (edge at the from layer)' });
}

const RIG_KINDS = ['hinge', 'grow', 'swing', 'unfold', 'orbit', 'blink', 'pulse', 'beat', 'liquid-fill', 'draw-then-fill', 'launch', 'land', 'type-on', 'assemble', 'reveal-from'] as const;
const DEFAULT_DUR: Record<string, number> = { hinge: 1.1, grow: 0.9, swing: 2.2, unfold: 1.2, orbit: 3, blink: 0.25, pulse: 1.2, beat: 0.9, 'liquid-fill': 2.2, 'draw-then-fill': 1.2, launch: 1.3, land: 1.1, 'type-on': 1, assemble: 1.3, 'reveal-from': 0.9 };
const REVERSIBLE = new Set(['grow', 'unfold', 'assemble', 'reveal-from', 'type-on', 'draw-then-fill']);

/** rig layers: one undo step; returns a compact summary of the keys created */
export function runRig(a: any) {
  const s = st();
  const kind = String(a.kind ?? '').toLowerCase().replace(/[\s_]+/g, '-');
  if (!(RIG_KINDS as readonly string[]).includes(kind)) throw new Error(`unknown rig kind "${a.kind}". kinds: ${RIG_KINDS.join(', ')}`);
  const ids: string[] = Array.isArray(a.ids) ? a.ids : a.id ? [a.id] : s.selection;
  if (!ids.length) throw new Error('ids: the layers to rig (or select them)');
  let list = ids.map(need);
  // a single group means its parts for rigs that act per part
  if (list.length === 1 && list[0].type === 'group' && list[0].children.length && (kind === 'assemble' || kind === 'unfold')) list = list[0].children.map(need);
  const o = a.options ?? {};
  for (const k of ['edge', 'from', 'direction', 'angle', 'mode', 'light', 'center', 'around', 'loop', 'stagger', 'pivot']) if (a[k] !== undefined && o[k] === undefined) o[k] = a[k];
  const mode = String(o.mode ?? a.mode ?? '').toLowerCase();
  const reverse = mode === 'out' || (kind !== 'hinge' && mode === 'close');
  if (reverse && !REVERSIBLE.has(kind)) throw new Error(`${kind} has no "out" mode (reversible rigs: ${[...REVERSIBLE].join(', ')}; for an exit use launch)`);
  if (kind === 'hinge' && mode && !['open', 'close', 'open-close'].includes(mode)) throw new Error('hinge mode must be open, close or open-close');
  if (kind === 'hinge') o.mode = mode || 'open';
  const t0 = a.t0 ?? a.t ?? s.time, dur = a.duration ?? DEFAULT_DUR[kind];
  if (!(isFinite(t0) && t0 >= 0)) throw new Error('t0 must be a time in seconds >= 0');
  if (!(dur > 0 && dur < 600)) throw new Error('duration must be > 0 seconds');
  const kRaw = a.intensity ?? o.intensity ?? 0.6;
  const k = Math.max(0, Math.min(1, kRaw > 1 ? kRaw / 100 : kRaw));
  if (o.ease !== undefined) resolveEase(o.ease);
  const c: Ctx = { s, t0, dur, k, reverse, span: dur + (list.length - 1) * (o.stagger ?? 0.08), o: { ...o, duration: a.duration }, touched: new Set(), created: [], notes: [], loops: [] };
  const pivots: Record<string, number[]> = {};
  const before = new Map(list.map(l => [l.id, valueAt(l, 'anchor', t0)]));
  s.batch('rig', () => {
    if (kind === 'draw-then-fill') {
      const tool = SHAPE_TOOLS.find(x => x.name === 'draw_on')!;
      const r = tool.run({ ids: list.map(l => l.id), t: t0, duration: dur, stagger: o.stagger ?? 0.12, ease: o.ease ?? 'Ease In Out', fill: o.fill ?? 'fade', from: o.from, mode: reverse ? 'off' : 'on', strokeWidth: o.strokeWidth }) as ToolContent[];
      c.notes.push((r[0] as any).text);
      const walk = (l: Layer) => { if (l.type === 'group') l.children.forEach(id => walk(s.layer(id)!)); else c.touched.add(l.id); };
      list.forEach(walk);
      return;
    }
    s.transact(`Agent: rig ${kind}`, tx => {
      switch (kind) {
        case 'hinge': return rigHinge(c, tx, list);
        case 'grow': return rigGrow(c, tx, list);
        case 'swing': return rigSwing(c, tx, list);
        case 'unfold': return rigUnfold(c, tx, list);
        case 'orbit': return rigOrbit(c, tx, list);
        case 'blink': return rigBlink(c, tx, list);
        case 'pulse': return rigPulse(c, tx, list, false);
        case 'beat': return rigPulse(c, tx, list, true);
        case 'liquid-fill': return rigLiquid(c, tx, list);
        case 'launch': return rigLaunch(c, tx, list);
        case 'land': return rigLand(c, tx, list);
        case 'type-on': return rigTypeOn(c, tx, list);
        case 'assemble': return rigAssemble(c, tx, list);
        case 'reveal-from': return rigRevealFrom(c, tx, list);
      }
    });
  }, `Agent: rig ${kind}`);
  for (const l of list) { const nl = s.layer(l.id); if (!nl) continue; const a2 = valueAt(nl, 'anchor', t0), b = before.get(l.id)!; if (Math.hypot(a2[0] - b[0], a2[1] - b[1]) > 1e-6) pivots[nl.name] = a2.map(r1); }
  // summary: keys per property inside the rig's time range
  let end = t0;
  const layers = [...c.touched].map(id => s.layer(id)).filter(Boolean).map(l => {
    const keys: Record<string, number> = {};
    for (const [key, p] of Object.entries(l!.props)) {
      const n = (p?.kf ?? []).filter(x => x.t >= t0 - 1e-6).length;
      if (n) { keys[key] = n; end = Math.max(end, ...(p!.kf!.map(x => x.t))); }
    }
    if (l!.pathKf?.length) { keys.pathShape = l!.pathKf.length; end = Math.max(end, ...l!.pathKf.map(x => x.t)); }
    if (l!.textAnim) { keys.textAnim = 1; }
    return { id: l!.id, name: l!.name, keys };
  });
  const out: any = { kind, t0: r1(t0 * 100) / 100, end: Math.round(end * 100) / 100, layers: layers.slice(0, 40) };
  if (layers.length > 40) out.moreLayers = layers.length - 40;
  if (Object.keys(pivots).length) out.pivots = pivots;
  if (c.created.length) out.created = c.created;
  if (c.loops.length) out.looping = c.loops.slice(0, 12);
  if (c.notes.length) out.notes = c.notes;
  return out;
}

// ---------------------------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------------------------

export const CONCEPT_TOOLS: ToolDef[] = [
  {
    name: 'inspect_artwork',
    readOnly: true,
    description: 'SEE what an artwork (logo, illustration, imported Figma frame) is made of before animating it: one image (the real render with numbered outlines + every part alone on a neutral background, labeled with its number and id) and JSON per part: id, name, type, bounds [x,y,w,h] (comp px), area, colors, subpaths, components/holes, aspect, letter-like parts in a text row, relations (inHoleOf / inside / contains / neighbours) and a geometry-only hint ("tall rectangle, sits in the hole of #1 (house-like pentagon with a hole)"). Compound paths are broken down as n.k components: split_shape them to animate parts separately. Decide what each part depicts, then rig it like the real thing.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'layer or group (default: the selection)' }, ids: idsSchema, t: { type: 'number', description: 'time (default playhead)' }, image: { type: 'boolean', description: 'default true' }, maxParts: { type: 'number', description: 'default 40' } } },
    run: async a => {
      const s = st();
      const ids: string[] = a.ids?.length ? a.ids : a.id ? [a.id] : s.selection.length ? s.selection : s.comp.root;
      if (!ids.length) throw new Error('nothing to inspect: pass id (a layer or group) or select layers');
      const roots = ids.map(need);
      const t = a.t ?? s.time;
      const { views, skipped } = collectViews(roots, t, Math.max(1, Math.min(80, a.maxParts ?? 40)));
      if (!views.length) throw new Error('no visible parts under those layers');
      const parts = describeViews(views, t);
      const out: ToolContent[] = [{ type: 'text', text: JSON.stringify({ t, parts, ...(skipped ? { skipped: `${skipped} hidden/extra layers not listed` } : {}) }) }];
      if (a.image !== false && typeof document !== 'undefined' && editor.renderer) out.push({ type: 'image', data: await renderSheet(views, t), mimeType: 'image/jpeg' });
      return out;
    },
  },
  {
    name: 'split_shape',
    description: 'Cut one compound path (imported logos are often ONE path) into separate path layers that stay exactly where they were, inside a group named after the original (it takes the original\'s place, transform, keyframes and opacity; parts keep fill/stroke/gradients). mode "components" (default, = "auto"): connected parts, holes stay with their outer contour, a shape inside a hole (a door in a doorway) becomes its own part; "subpaths": every contour (holes become solid). Parts are named "Part n (size rank)" in reading order. A text layer splits into per-letter layers (by: char|word|line). A group splits every compound path inside. One undo step.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, mode: { enum: ['auto', 'components', 'subpaths'] }, by: { enum: ['char', 'word', 'line'], description: 'text layers' } }, required: ['id'] },
    run: a => {
      const s = st();
      const l = need(a.id);
      const mode = a.mode ?? 'auto';
      if (!['auto', 'components', 'subpaths'].includes(mode)) throw new Error('mode must be auto, components or subpaths');
      const m: 'subpaths' | 'components' = mode === 'subpaths' ? 'subpaths' : 'components';
      if (l.type === 'text') {
        let r!: { group: string; ids: string[] };
        s.transact('Agent: split shape', tx => { r = splitTx(tx, l, a.by ?? 'char', false); });
        return text({ group: r.group, parts: r.ids.length, ids: r.ids.slice(0, 200), note: `${a.by ?? 'char'} text layers in group coordinates` });
      }
      const targets: Layer[] = [];
      if (l.type === 'group') {
        const walk = (x: Layer) => { if (x.type === 'group') x.children.forEach(c => walk(s.layer(c)!)); else if (x.type === 'path' && x.geometry?.length && x.geometry.reduce((n, g) => n + pathComponents(g.cmds, g.fillRule).parts.length, 0) + (m === 'subpaths' ? 1 : 0) > 1) targets.push(x); };
        walk(l);
        if (!targets.length) throw new Error(`no compound paths with separate parts inside "${l.name}"`);
      } else if (l.type === 'path') targets.push(l);
      else throw new Error(`"${l.name}" is a ${l.type} layer: split_shape works on path, text and group layers`);
      const res: any[] = [];
      s.transact('Agent: split shape', tx => {
        for (const x of targets) {
          const r = splitPathTx(tx, x, m);
          res.push({ from: x.name, group: r.group, parts: r.parts.map(p => {
            const pl = s.layer(p.id)!, b = compBox(pl, s.time);
            return { id: p.id, name: p.name, bounds: [r0(b[0]), r0(b[1]), r0(b[2] - b[0]), r0(b[3] - b[1])] };
          }) });
        }
      });
      return text(res.length === 1 ? res[0] : { split: res });
    },
  },
  {
    name: 'set_pivot',
    description: 'Move a layer\'s anchor (the point it rotates/scales around) without moving it on screen: position is compensated, also when keyframed or inside parents. at: "left" | "right" | "top" | "bottom" | "center" | "top-left" ... (of its visual bounds), [x,y] composition px, or {layerEdgeOf: otherId, edge?} (e.g. a wordmark pivots on the mark\'s edge). Use it before rotating a door on its hinge, scaling a plant from its base, swinging a sign from its nail. One undo step.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, ids: idsSchema, at: pivotSchema, t: { type: 'number', description: 'time for reading the bounds (default playhead)' } }, required: ['at'] },
    run: a => {
      const s = st();
      const ids: string[] = a.ids?.length ? a.ids : a.id ? [a.id] : s.selection;
      if (!ids.length) throw new Error('id: the layer whose pivot moves (or select it)');
      const list = ids.map(need);
      const t = a.t ?? s.time;
      const pts = list.map(l => pivotPoint(l, a.at, t));
      const res: any[] = [];
      s.transact('Agent: set pivot', tx => {
        list.forEach((l, i) => {
          const r = pivotTx(tx, l, pts[i], t);
          const W = worldMatrix(s, l.id, t), p = apply(W, r.to[0], r.to[1]);
          res.push({ id: l.id, name: l.name, anchor: r.to.map(r1), pivotInComp: p.map(r1), ...(r.note ? { note: r.note } : {}) });
        });
      });
      return text(res.length === 1 ? res[0] : res);
    },
  },
  {
    name: 'rig',
    description: `Motion rig as editable keyframes (eases/springs, overlap, secondary motion), one undo step. Animate what the part IS: a door hinges open, a leaf grows from its stem, a heart beats. kinds:
- hinge: door/lid/flap opens around an edge (options.edge left|right|top|bottom, angle°, swing in|out, mode open|close|open-close, hold, light: true|color = lit opening behind it). Pivot moves to the edge; scale foreshortens; paths get a perspective taper; fill shades.
- grow: from an edge with overshoot + sway (from bottom|top|left|right|center; pivot: "keep" or a set_pivot spec): plants, bars, flames.
- swing: damped pendulum around pivot (top), loop:true = endless.
- unfold: parts open one after another like paper (direction right|left|down|up).
- orbit: around center [x,y] or around:<id> (turns, direction cw|ccw, tilt 0..1, orient, loop).
- blink: eye squash (count, loop: every n s). pulse: breathing; beat: heart double beat (period; loops).
- liquid-fill: masked liquid rises with looping waves (level 0..1, color, waves, amplitude).
- draw-then-fill: strokes draw on, then fills fade in (stagger).
- launch: anticipation squash, rumble, stretch, accelerate off-screen (direction up|right|.. or degrees) + trail echoes.
- land: arrive on an arc (from top|left|right|[dx,dy]), squash on contact, settle.
- type-on: typewriter (text layers or a group of letters; cursor:true).
- assemble: parts fly in from offsets to their places, staggered by distance from the center (order inside-out|outside-in).
- reveal-from: the layers slide out from behind options.from (e.g. wordmark from the mark) under a mask at the mark's edge.
Common: t0 (default playhead), duration, intensity 0..1 (default 0.6), mode in|out (out = reverse of grow/unfold/assemble/reveal-from/type-on/draw-then-fill), stagger, loop. Returns the keys created per layer.`,
    inputSchema: {
      type: 'object',
      properties: {
        ids: idsSchema, kind: { enum: [...RIG_KINDS] }, t0: { type: 'number' }, duration: { type: 'number' },
        intensity: { type: 'number', description: '0..1 (default 0.6): amplitude of overshoot, squash, sway' },
        mode: { type: 'string', description: 'hinge: open|close|open-close; others: in|out' },
        direction: { description: 'launch/unfold/reveal-from/orbit direction', anyOf: [{ type: 'string' }, { type: 'number' }] },
        loop: { type: 'boolean' },
        options: { type: 'object', description: 'kind specific (see description): edge, angle, swing, light, hold, from, center, around, turns, tilt, orient, count, every, period, level, color, waves, amplitude, trail, cursor, speed, order, seed, distance, stagger, ease, pivot, perspective, shade, nudge' },
      },
      required: ['kind'],
    },
    run: a => text(runRig(a)),
  },
];
