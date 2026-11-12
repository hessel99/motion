// path booleans (union / difference / intersection / xor) on flattened beziers, for lottie
// merge paths. inputs are filled with the nonzero rule.
//
// method: flatten every operand into polygon rings, split all edges at every intersection
// (including t-junctions and collinear overlaps, so shared edges become identical), then keep
// an edge when the result is inside on exactly one side of it. the inside test is a winding
// number of each operand at points just left / right of the edge midpoint. kept edges are
// oriented with the inside on their left and chained into closed rings, so the output is
// correct with either fill rule. o(n log n + k) intersections (sweep) and a banded winding
// count; fine for the few hundred to few thousand edges of a typical shape group.

import type { PathCmd } from '../core/model';

/** a closed polygon ring: flat [x0, y0, x1, y1, ...] (implicitly closed) */
export type Ring = number[];
export type BoolOp = 'union' | 'difference' | 'intersect' | 'xor';

/** flatten path commands into rings (every subpath is closed, like a fill closes it) */
export function flattenCmds(cmds: PathCmd[], tol: number): Ring[] {
  const rings: Ring[] = [];
  let cur: Ring | null = null;
  let x = 0, y = 0;
  const tol2 = Math.max(tol, 1e-9);
  const flush = () => { if (cur && cur.length >= 6) rings.push(cur); cur = null; };
  for (const c of cmds) {
    switch (c[0]) {
      case 'M': flush(); x = c[1]; y = c[2]; cur = [x, y]; break;
      case 'L': if (!cur) cur = [x, y]; x = c[1]; y = c[2]; cur.push(x, y); break;
      case 'Q': case 'C': {
        if (!cur) cur = [x, y];
        const [x1, y1, x2, y2, x3, y3] = c[0] === 'C' ? [c[1], c[2], c[3], c[4], c[5], c[6]]
          : [x + (2 / 3) * (c[1] - x), y + (2 / 3) * (c[2] - y), c[3] + (2 / 3) * (c[1] - c[3]), c[4] + (2 / 3) * (c[2] - c[4]), c[3], c[4]];
        // segments from the second-difference bound: deviation <= 3/4 * max|d2| / n^2
        const dd = Math.max(Math.hypot(x - 2 * x1 + x2, y - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3));
        const n = Math.max(1, Math.min(96, Math.ceil(Math.sqrt((0.75 * dd) / tol2))));
        for (let k = 1; k <= n; k++) {
          const t = k / n, u = 1 - t;
          const a = u * u * u, b = 3 * u * u * t, cc = 3 * u * t * t, d = t * t * t;
          cur.push(a * x + b * x1 + cc * x2 + d * x3, a * y + b * y1 + cc * y2 + d * y3);
        }
        x = x3; y = y3;
        break;
      }
      case 'Z': if (cur) { x = cur[0]; y = cur[1]; } flush(); break;
    }
  }
  flush();
  return rings;
}

export function ringsToCmds(rings: Ring[]): PathCmd[] {
  const out: PathCmd[] = [];
  for (const r of rings) {
    if (r.length < 6) continue;
    out.push(['M', r[0], r[1]]);
    for (let i = 2; i < r.length; i += 2) out.push(['L', r[i], r[i + 1]]);
    out.push(['Z']);
  }
  return out;
}

function ringsBounds(rs: Ring[][]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const set of rs) for (const r of set) for (let i = 0; i < r.length; i += 2) {
    const x = r[i], y = r[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** banded edge index for winding numbers */
class Winding {
  private bands: number[][] = [];
  private y0: number; private bh: number;
  constructor(private seg: Float64Array, private n: number, y0: number, y1: number) {
    const nb = Math.max(1, Math.min(256, Math.ceil(n / 8)));
    this.y0 = y0; this.bh = (y1 - y0) / nb || 1;
    for (let b = 0; b < nb; b++) this.bands.push([]);
    for (let i = 0; i < n; i++) {
      const ya = seg[i * 4 + 1], yb = seg[i * 4 + 3];
      const b0 = this.band(Math.min(ya, yb)), b1 = this.band(Math.max(ya, yb));
      for (let b = b0; b <= b1; b++) this.bands[b].push(i);
    }
  }
  private band(y: number) { return Math.max(0, Math.min(this.bands.length - 1, Math.floor((y - this.y0) / this.bh))); }
  at(px: number, py: number): number {
    if (py < this.y0 || py > this.y0 + this.bh * this.bands.length) return 0;
    const s = this.seg;
    let w = 0;
    for (const i of this.bands[this.band(py)]) {
      const x1 = s[i * 4], y1 = s[i * 4 + 1], x2 = s[i * 4 + 2], y2 = s[i * 4 + 3];
      if (y1 <= py) {
        if (y2 > py && (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1) > 0) w++;
      } else if (y2 <= py && (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1) < 0) w--;
    }
    return w;
  }
}

function edgesOf(rings: Ring[], snap: (v: number) => number): number[] {
  const out: number[] = [];
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x1 = snap(r[i * 2]), y1 = snap(r[i * 2 + 1]), x2 = snap(r[j * 2]), y2 = snap(r[j * 2 + 1]);
      if (x1 !== x2 || y1 !== y2) out.push(x1, y1, x2, y2);
    }
  }
  return out;
}

/** a op b, both filled nonzero. output rings have the inside on their left (ccw in y-down = clockwise visually) */
/** rings with any non-finite coordinate are dropped (NaN would index the sweep bands) */
const finiteRings = (rs: Ring[]) => rs.filter(r => { for (let i = 0; i < r.length; i++) if (!isFinite(r[i])) return false; return true; });

export function booleanRings(a: Ring[], b: Ring[], op: BoolOp): Ring[] {
  a = finiteRings(a); b = finiteRings(b);
  const [bx0, by0, bx1, by1] = ringsBounds([a, b]);
  if (!isFinite(bx0)) return [];
  const diag = Math.hypot(bx1 - bx0, by1 - by0) || 1;
  const g = diag * 1e-7; // snapping grid
  const snap = (v: number) => Math.round(v / g) * g;
  const ea = edgesOf(a, snap), eb = edgesOf(b, snap);
  const na = ea.length / 4, nb = eb.length / 4, n = na + nb;
  const seg = new Float64Array(n * 4);
  seg.set(ea, 0); seg.set(eb, na * 4);
  const wa = new Winding(seg.subarray(0, na * 4), na, by0 - g, by1 + g);
  const wb = new Winding(seg.subarray(na * 4), nb, by0 - g, by1 + g);

  // ---- split at intersections (sweep over x) ----
  const splits: number[][] = Array.from({ length: n }, () => []);
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => Math.min(seg[i * 4], seg[i * 4 + 2]) - Math.min(seg[j * 4], seg[j * 4 + 2]));
  const eps = g * 4;
  const addSplit = (i: number, x: number, y: number) => {
    const x1 = seg[i * 4], y1 = seg[i * 4 + 1], x2 = seg[i * 4 + 2], y2 = seg[i * 4 + 3];
    if ((Math.abs(x - x1) <= eps && Math.abs(y - y1) <= eps) || (Math.abs(x - x2) <= eps && Math.abs(y - y2) <= eps)) return;
    splits[i].push(snap(x), snap(y));
  };
  /** point (px,py) within eps of segment i (strictly inside): split there */
  const onSeg = (i: number, px: number, py: number) => {
    const x1 = seg[i * 4], y1 = seg[i * 4 + 1], dx = seg[i * 4 + 2] - x1, dy = seg[i * 4 + 3] - y1;
    const l2 = dx * dx + dy * dy;
    if (!l2) return;
    const t = ((px - x1) * dx + (py - y1) * dy) / l2;
    if (t <= 0 || t >= 1) return;
    const qx = x1 + dx * t, qy = y1 + dy * t;
    if (Math.abs(qx - px) <= eps && Math.abs(qy - py) <= eps) addSplit(i, px, py);
  };
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    const ix1 = seg[i * 4], iy1 = seg[i * 4 + 1], ix2 = seg[i * 4 + 2], iy2 = seg[i * 4 + 3];
    const imaxX = Math.max(ix1, ix2) + eps, iminY = Math.min(iy1, iy2) - eps, imaxY = Math.max(iy1, iy2) + eps;
    for (let oj = oi + 1; oj < n; oj++) {
      const j = order[oj];
      const jx1 = seg[j * 4], jy1 = seg[j * 4 + 1], jx2 = seg[j * 4 + 2], jy2 = seg[j * 4 + 3];
      if (Math.min(jx1, jx2) > imaxX) break;
      if (Math.max(jy1, jy2) < iminY || Math.min(jy1, jy2) > imaxY) continue;
      const rx = ix2 - ix1, ry = iy2 - iy1, sx = jx2 - jx1, sy = jy2 - jy1;
      const d = rx * sy - ry * sx;
      const qpx = jx1 - ix1, qpy = jy1 - iy1;
      const lr = Math.hypot(rx, ry), ls = Math.hypot(sx, sy);
      if (Math.abs(d) > 1e-12 * lr * ls) {
        const t = (qpx * sy - qpy * sx) / d, u = (qpx * ry - qpy * rx) / d;
        const te = eps / lr, ue = eps / ls;
        if (t >= -te && t <= 1 + te && u >= -ue && u <= 1 + ue) {
          const x = ix1 + rx * t, y = iy1 + ry * t;
          addSplit(i, x, y); addSplit(j, x, y);
        }
      }
      // t-junctions and collinear overlaps: endpoints lying on the other segment
      onSeg(i, jx1, jy1); onSeg(i, jx2, jy2); onSeg(j, ix1, iy1); onSeg(j, ix2, iy2);
    }
  }

  // ---- classify sub-edges ----
  const inside = (p: number, q: number) => {
    const A = wa.at(p, q) !== 0, B = wb.at(p, q) !== 0;
    switch (op) {
      case 'union': return A || B;
      case 'intersect': return A && B;
      case 'difference': return A && !B;
      case 'xor': return A !== B;
    }
  };
  const kept = new Map<string, [number, number, number, number]>();
  const key = (x1: number, y1: number, x2: number, y2: number) => `${x1},${y1},${x2},${y2}`;
  const consider = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (len < g * 0.5) return;
    const e = Math.min(len * 0.25, diag * 1e-5);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, nx = (-dy / len) * e, ny = (dx / len) * e;
    // y-down screen space: "left" of the direction (dx, dy) is (dy, -dx); orientation only has to be consistent
    const inL = inside(mx + nx, my + ny), inR = inside(mx - nx, my - ny);
    if (inL === inR) return;
    const s = inL ? [x1, y1, x2, y2] as [number, number, number, number] : [x2, y2, x1, y1] as [number, number, number, number];
    const k = key(...s), rk = key(s[2], s[3], s[0], s[1]);
    if (kept.has(rk)) { kept.delete(rk); return; } // opposite duplicates cancel
    kept.set(k, s);
  };
  for (let i = 0; i < n; i++) {
    const x1 = seg[i * 4], y1 = seg[i * 4 + 1], x2 = seg[i * 4 + 2], y2 = seg[i * 4 + 3];
    const sp = splits[i];
    if (!sp.length) { consider(x1, y1, x2, y2); continue; }
    const dx = x2 - x1, dy = y2 - y1;
    const pts: [number, number, number][] = [];
    for (let k = 0; k < sp.length; k += 2) pts.push([((sp[k] - x1) * dx + (sp[k + 1] - y1) * dy), sp[k], sp[k + 1]]);
    pts.sort((p, q) => p[0] - q[0]);
    let px = x1, py = y1;
    for (const [, x, y] of pts) { if (x === px && y === py) continue; consider(px, py, x, y); px = x; py = y; }
    consider(px, py, x2, y2);
  }

  // ---- chain into rings ----
  const out = new Map<string, [number, number, number, number][]>();
  for (const s of kept.values()) {
    const k = s[0] + ',' + s[1];
    let l = out.get(k);
    if (!l) out.set(k, (l = []));
    l.push(s);
  }
  const rings: Ring[] = [];
  for (const s0 of kept.values()) {
    const l0 = out.get(s0[0] + ',' + s0[1]);
    if (!l0 || !l0.includes(s0)) continue; // used
    const ring: Ring = [s0[0], s0[1]];
    let s = s0;
    const startK = s0[0] + ',' + s0[1];
    for (let guard = 0; guard <= kept.size; guard++) {
      const from = out.get(s[0] + ',' + s[1])!;
      from.splice(from.indexOf(s), 1);
      const endK = s[2] + ',' + s[3];
      if (endK === startK) break;
      ring.push(s[2], s[3]);
      const next = out.get(endK);
      if (!next || !next.length) break;
      // several continuations (touching rings): take the sharpest turn to the same side
      let best = next[0];
      if (next.length > 1) {
        const ax = s[2] - s[0], ay = s[3] - s[1];
        let bestA = Infinity;
        for (const c of next) {
          const bx = c[2] - c[0], by = c[3] - c[1];
          const ang = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
          if (ang < bestA) { bestA = ang; best = c; }
        }
      }
      s = best;
    }
    if (ring.length >= 6) rings.push(simplify(ring, g * 2));
  }
  return rings.filter(r => r.length >= 6);
}

/** drop collinear / duplicate points */
function simplify(r: Ring, eps: number): Ring {
  const n = r.length / 2;
  const out: Ring = [];
  for (let i = 0; i < n; i++) {
    const px = r[((i - 1 + n) % n) * 2], py = r[((i - 1 + n) % n) * 2 + 1];
    const x = r[i * 2], y = r[i * 2 + 1];
    const nx = r[((i + 1) % n) * 2], ny = r[((i + 1) % n) * 2 + 1];
    const cr = (x - px) * (ny - y) - (y - py) * (nx - x);
    const l = Math.hypot(nx - px, ny - py);
    if (Math.abs(cr) <= eps * l && (x - px) * (nx - x) + (y - py) * (ny - y) >= 0) continue;
    out.push(x, y);
  }
  return out.length >= 6 ? out : r;
}

/** signed area (shoelace) of rings, for tests */
export function ringsArea(rings: Ring[]): number {
  let s = 0;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; s += r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1]; }
  }
  return s / 2;
}

/**
 * merge-paths boolean of several operands (each a list of rings, nonzero), applied in order:
 * ((p0 op p1) op p2) ... like after effects / skottie. one operand returns it unchanged.
 */
export function booleanMany(ops: Ring[][], op: BoolOp): Ring[] {
  if (!ops.length) return [];
  let acc = ops[0];
  if (ops.length === 1) return acc;
  // normalize the first operand (self overlaps) only through the first op
  for (let i = 1; i < ops.length; i++) acc = booleanRings(acc, ops[i], op);
  return acc;
}
