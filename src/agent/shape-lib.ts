// shape generation for the agent: named primitives (arrow, heart, blob, ...), Lucide icons by name,
// path booleans and structure matching for morphs. every shape is path commands in a w x h box.

import type { PathCmd, PathGeometry } from '../core/model';
import { parsePathD, cmdsBounds, transformCmds, arcToCubics } from '../import/svg';
import { booleanMany, flattenCmds, ringsToCmds, type BoolOp } from '../import/pathops';
import { starGeometry } from '../core/shapes';
import { rng } from './motion-math';

export interface ShapeOut {
  cmds: PathCmd[];
  /** suggested look: 'fill' (closed solid shape) or 'stroke' (open line art: check, wave, spiral, icons) */
  style: 'fill' | 'stroke';
  fillRule?: 'nonzero' | 'evenodd';
}

export interface ShapeOpts { seed?: number; points?: number; inner?: number; turns?: number; waves?: number; amplitude?: number; thickness?: number; complexity?: number }

const K = 0.5522847498;

/** ellipse as 4 cubics (starts at the top, clockwise) */
export function ellipseCmds(cx: number, cy: number, rx: number, ry: number): PathCmd[] {
  return [
    ['M', cx, cy - ry],
    ['C', cx + rx * K, cy - ry, cx + rx, cy - ry * K, cx + rx, cy],
    ['C', cx + rx, cy + ry * K, cx + rx * K, cy + ry, cx, cy + ry],
    ['C', cx - rx * K, cy + ry, cx - rx, cy + ry * K, cx - rx, cy],
    ['C', cx - rx, cy - ry * K, cx - rx * K, cy - ry, cx, cy - ry],
    ['Z'],
  ];
}

/** rounded rect (radius clamped), clockwise from the top-left corner's end */
export function rectCmds(x: number, y: number, w: number, h: number, r = 0): PathCmd[] {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r <= 0) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
  const k = r * (1 - K);
  return [
    ['M', x + r, y], ['L', x + w - r, y], ['C', x + w - k, y, x + w, y + k, x + w, y + r],
    ['L', x + w, y + h - r], ['C', x + w, y + h - k, x + w - k, y + h, x + w - r, y + h],
    ['L', x + r, y + h], ['C', x + k, y + h, x, y + h - k, x, y + h - r],
    ['L', x, y + r], ['C', x, y + k, x + k, y, x + r, y], ['Z'],
  ];
}

const poly = (pts: number[][], close = true): PathCmd[] => [...pts.map((p, i): PathCmd => [i ? 'L' : 'M', p[0], p[1]]), ...(close ? [['Z'] as PathCmd] : [])];

/** smooth closed curve through points (catmull-rom -> cubic) */
function smoothClosed(pts: number[][], tension = 1): PathCmd[] {
  const n = pts.length;
  const out: PathCmd[] = [['M', pts[0][0], pts[0][1]]];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    out.push(['C', p1[0] + (p2[0] - p0[0]) / 6 * tension, p1[1] + (p2[1] - p0[1]) / 6 * tension, p2[0] - (p3[0] - p1[0]) / 6 * tension, p2[1] - (p3[1] - p1[1]) / 6 * tension, p2[0], p2[1]]);
  }
  out.push(['Z']);
  return out;
}

function smoothOpen(pts: number[][]): PathCmd[] {
  const n = pts.length;
  const out: PathCmd[] = [['M', pts[0][0], pts[0][1]]];
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    out.push(['C', p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]]);
  }
  return out;
}

/** primitives authored in a 100 x 100 box (scaled to w x h afterwards) */
const PRIMITIVES: Record<string, { desc: string; make: (o: ShapeOpts) => ShapeOut }> = {
  arrow: { desc: 'solid arrow pointing right', make: o => { const t = (o.thickness ?? 0.36) * 50; return { style: 'fill', cmds: poly([[0, 50 - t / 2], [58, 50 - t / 2], [58, 14], [100, 50], [58, 86], [58, 50 + t / 2], [0, 50 + t / 2]]) }; } },
  'arrow-line': { desc: 'line arrow pointing right (stroke; good for draw_on)', make: () => ({ style: 'stroke', cmds: [['M', 4, 50], ['L', 96, 50], ['M', 66, 20], ['L', 96, 50], ['L', 66, 80]] }) },
  chevron: { desc: 'chevron > (stroke)', make: () => ({ style: 'stroke', cmds: [['M', 30, 8], ['L', 72, 50], ['L', 30, 92]] }) },
  check: { desc: 'check mark (stroke; draw_on it)', make: () => ({ style: 'stroke', cmds: [['M', 8, 54], ['L', 36, 82], ['L', 92, 20]] }) },
  cross: { desc: 'x mark (stroke)', make: () => ({ style: 'stroke', cmds: [['M', 12, 12], ['L', 88, 88], ['M', 88, 12], ['L', 12, 88]] }) },
  plus: { desc: 'solid plus', make: o => { const t = (o.thickness ?? 0.3) * 50; return { style: 'fill', cmds: poly([[50 - t, 0], [50 + t, 0], [50 + t, 50 - t], [100, 50 - t], [100, 50 + t], [50 + t, 50 + t], [50 + t, 100], [50 - t, 100], [50 - t, 50 + t], [0, 50 + t], [0, 50 - t], [50 - t, 50 - t]]) }; } },
  heart: { desc: 'heart', make: () => ({ style: 'fill', cmds: [['M', 50, 92], ['C', 18, 70, 0, 50, 0, 30], ['C', 0, 12, 14, 2, 28, 2], ['C', 38, 2, 46, 8, 50, 18], ['C', 54, 8, 62, 2, 72, 2], ['C', 86, 2, 100, 12, 100, 30], ['C', 100, 50, 82, 70, 50, 92], ['Z']] }) },
  bubble: { desc: 'speech bubble with a tail bottom-left', make: () => { const c = rectCmds(0, 0, 100, 76, 18); c.pop(); return { style: 'fill', cmds: booleanCmds([[...c, ['Z']], poly([[18, 60], [40, 70], [14, 100]])], 'union') }; } },
  badge: { desc: 'seal / sticker badge (wavy circle; points = bumps)', make: o => { const n = Math.max(6, Math.round(o.points ?? 16)); const pts: number[][] = []; for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + i * Math.PI / n; const r = i % 2 ? 44 : 50; pts.push([50 + Math.cos(a) * r, 50 + Math.sin(a) * r]); } return { style: 'fill', cmds: smoothClosed(pts, 0.8) }; } },
  blob: { desc: 'organic blob (seed: variant, complexity: 3..12 lobes)', make: o => { const R = rng(o.seed ?? 1); const n = Math.max(3, Math.min(12, Math.round(o.complexity ?? 6))); const pts: number[][] = []; for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / n + (R() - 0.5) * 0.5; const r = 32 + R() * 18; pts.push([50 + Math.cos(a) * r, 50 + Math.sin(a) * r]); } return { style: 'fill', cmds: fitCmds(smoothClosed(pts), 100, 100) }; } },
  wave: { desc: 'sine wave line (waves: count, amplitude 0..1; stroke)', make: o => { const n = Math.max(1, o.waves ?? 2), A = (o.amplitude ?? 0.8) * 50; const pts: number[][] = []; const steps = Math.ceil(n * 8); for (let i = 0; i <= steps; i++) pts.push([i / steps * 100, 50 - Math.sin(i / steps * n * 2 * Math.PI) * A]); return { style: 'stroke', cmds: smoothOpen(pts) }; } },
  burst: { desc: 'radiating rays (points = ray count; stroke)', make: o => { const n = Math.max(3, Math.round(o.points ?? 12)); const c: PathCmd[] = []; const ri = (o.inner ?? 0.45) * 50; for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / n; c.push(['M', 50 + Math.cos(a) * ri, 50 + Math.sin(a) * ri], ['L', 50 + Math.cos(a) * 50, 50 + Math.sin(a) * 50]); } return { style: 'stroke', cmds: c }; } },
  spiral: { desc: 'spiral from the center (turns; stroke)', make: o => { const turns = o.turns ?? 3; const steps = Math.ceil(turns * 16); const pts: number[][] = []; for (let i = 0; i <= steps; i++) { const f = i / steps; const a = f * turns * 2 * Math.PI; pts.push([50 + Math.cos(a) * f * 48, 50 + Math.sin(a) * f * 48]); } return { style: 'stroke', cmds: smoothOpen(pts) }; } },
  star: { desc: 'star (points, inner 0..1)', make: o => ({ style: 'fill', cmds: starGeometry('star', o.points ?? 5, o.inner ?? 0.45, 100, 100)[0].cmds }) },
  polygon: { desc: 'regular polygon (points = sides)', make: o => ({ style: 'fill', cmds: starGeometry('polygon', o.points ?? 6, 1, 100, 100)[0].cmds }) },
  triangle: { desc: 'triangle pointing up', make: () => ({ style: 'fill', cmds: poly([[50, 4], [96, 92], [4, 92]]) }) },
  diamond: { desc: 'diamond', make: () => ({ style: 'fill', cmds: poly([[50, 0], [100, 50], [50, 100], [0, 50]]) }) },
  circle: { desc: 'circle (as path: morphable, drawable)', make: () => ({ style: 'fill', cmds: ellipseCmds(50, 50, 50, 50) }) },
  ring: { desc: 'ring / donut (thickness 0..1)', make: o => { const t = (o.thickness ?? 0.25) * 50; return { style: 'fill', fillRule: 'evenodd', cmds: [...ellipseCmds(50, 50, 50, 50), ...ellipseCmds(50, 50, 50 - t, 50 - t)] }; } },
  square: { desc: 'square / rect as a path (morphable)', make: () => ({ style: 'fill', cmds: rectCmds(0, 0, 100, 100, 0) }) },
  'rounded-rect': { desc: 'rounded rect as a path', make: () => ({ style: 'fill', cmds: rectCmds(0, 0, 100, 100, 18) }) },
  pill: { desc: 'pill / capsule', make: () => ({ style: 'fill', cmds: rectCmds(0, 25, 100, 50, 25) }) },
  line: { desc: 'straight horizontal line (stroke)', make: () => ({ style: 'stroke', cmds: [['M', 0, 50], ['L', 100, 50]] }) },
  underline: { desc: 'hand-drawn swoosh underline (stroke)', make: () => ({ style: 'stroke', cmds: [['M', 2, 62], ['C', 30, 44, 70, 40, 98, 52]] }) },
  sparkle: { desc: '4-point sparkle', make: () => ({ style: 'fill', cmds: [['M', 50, 0], ['C', 54, 36, 64, 46, 100, 50], ['C', 64, 54, 54, 64, 50, 100], ['C', 46, 64, 36, 54, 0, 50], ['C', 36, 46, 46, 36, 50, 0], ['Z']] }) },
  drop: { desc: 'water drop', make: () => ({ style: 'fill', cmds: [['M', 50, 0], ['C', 50, 0, 88, 44, 88, 64], ['C', 88, 85, 71, 100, 50, 100], ['C', 29, 100, 12, 85, 12, 64], ['C', 12, 44, 50, 0, 50, 0], ['Z']] }) },
  cloud: { desc: 'cloud', make: () => ({ style: 'fill', cmds: booleanCmds([ellipseCmds(30, 62, 26, 24), ellipseCmds(56, 44, 30, 30), ellipseCmds(78, 64, 22, 20), rectCmds(10, 62, 80, 24, 12)], 'union') }) },
};

export const PRIMITIVE_NAMES = Object.keys(PRIMITIVES);
export const PRIMITIVE_DOC = Object.entries(PRIMITIVES).map(([k, v]) => `${k} (${v.desc})`).join(', ');

/** scale commands so their bounds fill a w x h box (keep aspect: centered) */
export function fitCmds(cmds: PathCmd[], w: number, h: number, keepAspect = false): PathCmd[] {
  const [x, y, bw, bh] = cmdsBounds(cmds);
  if (!(bw > 0) && !(bh > 0)) return cmds;
  let sx = bw > 0 ? w / bw : 1, sy = bh > 0 ? h / bh : 1;
  if (bw <= 0) sx = sy; if (bh <= 0) sy = sx;
  if (keepAspect) { const s = Math.min(sx, sy); const ox = (w - bw * s) / 2, oy = (h - bh * s) / 2; return transformCmds(cmds, [s, 0, 0, s, ox - x * s, oy - y * s]); }
  return transformCmds(cmds, [sx, 0, 0, sy, -x * sx, -y * sy]);
}

export function primitive(name: string, w: number, h: number, o: ShapeOpts = {}): ShapeOut {
  const p = PRIMITIVES[name.toLowerCase()];
  if (!p) throw new Error(`unknown shape "${name}". shapes: ${PRIMITIVE_NAMES.join(', ')}; or "lucide:<icon-name>" (e.g. lucide:rocket)`);
  const s = p.make(o);
  return { ...s, cmds: transformCmds(s.cmds, [w / 100, 0, 0, h / 100, 0, 0]) };
}

// ---------------- lucide icons ----------------

type IconNode = [string, Record<string, string>][];
let lucideMod: Record<string, any> | null = null;
async function lucide() { return (lucideMod ??= await import('lucide-preact') as any); }
const pascal = (s: string) => s.replace(/(^|[-_\s]+)([a-z0-9])/gi, (_, __, c) => c.toUpperCase());

/** svg nodes of a Lucide icon (24 x 24, stroke 2) by kebab or Pascal name */
export async function lucideNodes(name: string): Promise<IconNode> {
  const L = await lucide();
  const key = pascal(name.trim().replace(/^lucide[:/]/i, ''));
  const Icon = L[key] ?? L[key + 'Icon'];
  if (!Icon) {
    const all = Object.keys(L).filter(k => /^[A-Z]/.test(k) && !k.endsWith('Icon') && !k.startsWith('Lucide'));
    const q = key.toLowerCase();
    const near = all.filter(k => k.toLowerCase().includes(q) || q.includes(k.toLowerCase())).slice(0, 12);
    const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Za-z])([0-9])/g, '$1-$2').toLowerCase();
    throw new Error(`no Lucide icon "${name}".${near.length ? ' similar: ' + near.map(kebab).join(', ') : ''} (names are kebab-case, see lucide.dev/icons)`);
  }
  try { return ((Icon as any)({}) as any)?.props?.icon?.node ?? []; } catch { return []; }
}

/** a Lucide icon as one stroke path in a w x h box (24-unit icon space scaled) */
export async function lucideShape(name: string, w: number, h: number): Promise<ShapeOut & { strokeScale: number }> {
  const nodes = await lucideNodes(name);
  const cmds: PathCmd[] = [];
  for (const [tag, a] of nodes) {
    const n = (k: string) => +(a[k] ?? 0);
    switch (tag) {
      case 'path': cmds.push(...parsePathD(a.d)); break;
      case 'circle': cmds.push(...ellipseCmds(n('cx'), n('cy'), n('r'), n('r'))); break;
      case 'ellipse': cmds.push(...ellipseCmds(n('cx'), n('cy'), n('rx'), n('ry'))); break;
      case 'rect': cmds.push(...rectCmds(n('x'), n('y'), n('width'), n('height'), n('rx'))); break;
      case 'line': cmds.push(['M', n('x1'), n('y1')], ['L', n('x2'), n('y2')]); break;
      case 'polyline': case 'polygon': {
        const pts = (a.points ?? '').trim().split(/[\s,]+/).map(Number);
        const ps: number[][] = [];
        for (let i = 0; i + 1 < pts.length; i += 2) ps.push([pts[i], pts[i + 1]]);
        cmds.push(...poly(ps, tag === 'polygon'));
        break;
      }
    }
  }
  const s = Math.min(w, h) / 24;
  const ox = (w - 24 * s) / 2, oy = (h - 24 * s) / 2;
  return { style: 'stroke', cmds: transformCmds(cmds, [s, 0, 0, s, ox, oy]), strokeScale: s };
}

/** resolve a shape reference: primitive name, "lucide:<name>" or "icon:<name>" */
export async function resolveShape(ref: string, w: number, h: number, o: ShapeOpts = {}): Promise<ShapeOut & { strokeScale?: number }> {
  const m = /^(lucide|icon)[:/](.+)$/i.exec(ref.trim());
  if (m) return lucideShape(m[2], w, h);
  return primitive(ref, w, h, o);
}

// ---------------- booleans ----------------

export function booleanCmds(operands: PathCmd[][], op: BoolOp): PathCmd[] {
  const all = operands.flat();
  const [, , bw, bh] = cmdsBounds(all);
  const tol = Math.max(0.02, Math.max(bw, bh) / 2000);
  return ringsToCmds(booleanMany(operands.map(c => flattenCmds(c, tol)), op));
}

export function parseD(d: string): PathCmd[] {
  const cmds = parsePathD(String(d ?? ''));
  if (!cmds.length) throw new Error(`could not parse SVG path data ${JSON.stringify(String(d).slice(0, 60))} (expected e.g. "M0 0 L100 0 L50 80 Z")`);
  return cmds;
}

/** "x,y x,y ..." or [[x,y],...] -> polyline commands */
export function polylineCmds(points: any, close: boolean): PathCmd[] {
  const flat: number[] = Array.isArray(points) ? points.flat().map(Number) : String(points).trim().split(/[\s,]+/).map(Number);
  if (flat.length < 4 || flat.some(x => !isFinite(x))) throw new Error('points must be at least two x,y pairs, e.g. "0,0 100,0 50,80" or [[0,0],[100,0]]');
  const ps: number[][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) ps.push([flat[i], flat[i + 1]]);
  return poly(ps, close);
}

// ---------------- morph structure matching ----------------

/** a subpath as cubic segments: start point + [c1x,c1y,c2x,c2y,x,y] per segment */
interface Sub { x: number; y: number; segs: number[][]; closed: boolean }

function toSubs(cmds: PathCmd[]): Sub[] {
  const subs: Sub[] = [];
  let cur: Sub | null = null, x = 0, y = 0;
  for (const c of cmds) {
    if (c[0] === 'M') { cur = { x: c[1], y: c[2], segs: [], closed: false }; subs.push(cur); x = c[1]; y = c[2]; continue; }
    if (!cur) { cur = { x, y, segs: [], closed: false }; subs.push(cur); }
    if (c[0] === 'L') { cur.segs.push([x + (c[1] - x) / 3, y + (c[2] - y) / 3, x + (c[1] - x) * 2 / 3, y + (c[2] - y) * 2 / 3, c[1], c[2]]); x = c[1]; y = c[2]; }
    else if (c[0] === 'Q') { cur.segs.push([x + 2 / 3 * (c[1] - x), y + 2 / 3 * (c[2] - y), c[3] + 2 / 3 * (c[1] - c[3]), c[4] + 2 / 3 * (c[2] - c[4]), c[3], c[4]]); x = c[3]; y = c[4]; }
    else if (c[0] === 'C') { cur.segs.push([c[1], c[2], c[3], c[4], c[5], c[6]]); x = c[5]; y = c[6]; }
    else if (c[0] === 'Z') {
      if (Math.hypot(x - cur.x, y - cur.y) > 1e-6) cur.segs.push([x + (cur.x - x) / 3, y + (cur.y - y) / 3, x + (cur.x - x) * 2 / 3, y + (cur.y - y) * 2 / 3, cur.x, cur.y]);
      cur.closed = true; x = cur.x; y = cur.y; cur = null;
    }
  }
  return subs.filter(s => s.segs.length);
}

const segLen = (x: number, y: number, s: number[]) => Math.hypot(s[0] - x, s[1] - y) + Math.hypot(s[2] - s[0], s[3] - s[1]) + Math.hypot(s[4] - s[2], s[5] - s[3]);

/** split the longest segments (de casteljau at 0.5) until the subpath has n segments */
function splitTo(sub: Sub, n: number) {
  while (sub.segs.length < n) {
    let best = 0, bl = -1, px = sub.x, py = sub.y, bx = 0, by = 0;
    sub.segs.forEach((s, i) => { const l = segLen(px, py, s); if (l > bl) { bl = l; best = i; bx = px; by = py; } px = s[4]; py = s[5]; });
    const s = sub.segs[best];
    const m = (a: number, b: number) => (a + b) / 2;
    const p01 = [m(bx, s[0]), m(by, s[1])], p12 = [m(s[0], s[2]), m(s[1], s[3])], p23 = [m(s[2], s[4]), m(s[3], s[5])];
    const p012 = [m(p01[0], p12[0]), m(p01[1], p12[1])], p123 = [m(p12[0], p23[0]), m(p12[1], p23[1])];
    const mid = [m(p012[0], p123[0]), m(p012[1], p123[1])];
    sub.segs.splice(best, 1, [p01[0], p01[1], p012[0], p012[1], mid[0], mid[1]], [p123[0], p123[1], p23[0], p23[1], s[4], s[5]]);
  }
}

function centroid(s: Sub) { let x = s.x, y = s.y; for (const g of s.segs) { x += g[4]; y += g[5]; } return [x / (s.segs.length + 1), y / (s.segs.length + 1)]; }
function area(s: Sub) { let a = 0, px = s.x, py = s.y; for (const g of s.segs) { a += px * g[5] - g[4] * py; px = g[4]; py = g[5]; } return a / 2; }

/** rotate a closed subpath's start so its points line up with `ref` (least squared distance) */
function alignStart(sub: Sub, ref: Sub) {
  if (!sub.closed) return;
  const n = sub.segs.length;
  const pts = (s: Sub) => [[s.x, s.y], ...s.segs.slice(0, -1).map(g => [g[4], g[5]])];
  const a = pts(ref), b = pts(sub);
  let best = 0, bd = Infinity;
  for (let k = 0; k < n; k++) { let d = 0; for (let i = 0; i < n; i++) { const p = b[(i + k) % n], q = a[i]; d += (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2; } if (d < bd) { bd = d; best = k; } }
  if (!best) return;
  const segs = [...sub.segs.slice(best), ...sub.segs.slice(0, best)];
  const start = sub.segs[best - 1];
  sub.x = start[4]; sub.y = start[5]; sub.segs = segs;
}

function reverseSub(s: Sub) {
  const pts: number[][] = [[s.x, s.y], ...s.segs.map(g => [g[4], g[5]])];
  const segs: number[][] = [];
  for (let i = s.segs.length - 1; i >= 0; i--) { const g = s.segs[i], p = pts[i]; segs.push([g[2], g[3], g[0], g[1], p[0], p[1]]); }
  const last = pts[pts.length - 1];
  s.x = last[0]; s.y = last[1]; s.segs = segs;
}

const subCmds = (s: Sub): PathCmd[] => [['M', s.x, s.y], ...s.segs.map(g => ['C', ...g] as PathCmd), ...(s.closed ? [['Z'] as PathCmd] : [])];

/** make two shapes interpolatable: same subpath count, same cubic segment count per subpath,
 *  matching winding and start points. returns the two command lists */
export function matchShapes(a: PathCmd[], b: PathCmd[]): [PathCmd[], PathCmd[]] {
  const A = toSubs(a), B = toSubs(b);
  if (!A.length || !B.length) throw new Error('both shapes need at least one drawable segment');
  // biggest subpaths pair first; missing ones collapse to a point at the partner's centroid
  const byArea = (s: Sub[]) => s.slice().sort((p, q) => Math.abs(area(q)) - Math.abs(area(p)));
  const As = byArea(A), Bs = byArea(B);
  const n = Math.max(As.length, Bs.length);
  const point = (ref: Sub): Sub => { const [cx, cy] = centroid(ref); return { x: cx, y: cy, segs: [[cx, cy, cx, cy, cx, cy]], closed: ref.closed }; };
  const outA: PathCmd[] = [], outB: PathCmd[] = [];
  for (let i = 0; i < n; i++) {
    const sa = As[i] ?? point(Bs[i]), sb = Bs[i] ?? point(As[i]);
    sa.closed = sb.closed = sa.closed || sb.closed;
    if (Math.sign(area(sa)) * Math.sign(area(sb)) < 0) reverseSub(sb);
    const m = Math.max(sa.segs.length, sb.segs.length);
    splitTo(sa, m); splitTo(sb, m);
    alignStart(sb, sa);
    outA.push(...subCmds(sa)); outB.push(...subCmds(sb));
  }
  return [outA, outB];
}

export const geom = (cmds: PathCmd[], fillRule: 'nonzero' | 'evenodd' = 'nonzero'): PathGeometry[] => [{ cmds, fillRule }];
export { cmdsBounds, transformCmds, arcToCubics };
