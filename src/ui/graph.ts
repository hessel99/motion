// graph editor (value graph) drawn inside the timeline's track area.
// shows the animated value curves of the selected properties; keyframes and bezier
// handles can be dragged directly on the curve.

import type { Store } from '../core/store';
import { Track } from '../core/evaluate';
import { PROP_DEFS, type Keyframe, type Layer, type PropKey } from '../core/model';
import { keyId, setSegmentHandles } from '../core/commands';

export interface GraphArea { x0: number; y0: number; x1: number; y1: number; tToX(t: number): number; xToT(x: number): number }
interface Curve { layer: Layer; key: PropKey; dim: number; color: string; handles: boolean }

const DIM_COLORS = ['#ff6b6b', '#4cd964', '#4c8dff', '#ffcc00'];

type GDrag =
  | { kind: 'key'; c: Curve; i: number; sx: number; sy: number; t0: number; v0: number[]; moved: boolean }
  | { kind: 'handle'; c: Curve; seg: number; which: 'out' | 'in' }
  | null;

export class GraphView {
  private vmin = 0;
  private vmax = 1;
  private curves: Curve[] = [];
  private drag: GDrag = null;
  private area: GraphArea | null = null;
  /** speed graph (after effects): |d value / dt| per property instead of values */
  speed = false;

  constructor(private store: Store) {}

  /** which curves to show: props with selected keys, else animated props of selected layers */
  private pick(): Curve[] {
    const st = this.store;
    const out: Curve[] = [];
    const seen = new Set<string>();
    const add = (l: Layer, key: PropKey) => {
      const k = l.id + key;
      if (seen.has(k) || !l.props[key]?.kf?.length) return;
      seen.add(k);
      const dim = PROP_DEFS[key].unit === 'color' ? 3 : key === 'radius' ? 1 : PROP_DEFS[key].dim;
      // bezier handles go on the dimension that changes the most (a flat curve can't show easing)
      const kf = l.props[key]!.kf!;
      let best = 0, bestSpan = -1;
      for (let d = 0; d < dim; d++) {
        let lo = Infinity, hi = -Infinity;
        for (const k of kf) { lo = Math.min(lo, k.v[d]); hi = Math.max(hi, k.v[d]); }
        if (hi - lo > bestSpan) { bestSpan = hi - lo; best = d; }
      }
      for (let d = 0; d < dim; d++) out.push({ layer: l, key, dim: d, handles: d === best, color: PROP_DEFS[key].unit === 'color' ? ['#ff6b6b', '#4cd964', '#4c8dff'][d] : dim === 1 ? '#c792ea' : DIM_COLORS[d] });
    };
    for (const k of st.keySelection) {
      const [lid, key] = k.split('|');
      const l = st.layer(lid);
      if (l) add(l, key as PropKey);
    }
    if (!out.length) for (const id of st.selection) {
      const l = st.layer(id);
      if (l) for (const key in l.props) add(l, key as PropKey);
    }
    return out.slice(0, 12);
  }

  private vToY(v: number) {
    const a = this.area!;
    const pad = 24;
    return a.y1 - pad - ((v - this.vmin) / (this.vmax - this.vmin || 1)) * (a.y1 - a.y0 - pad * 2);
  }
  private yToV(y: number) {
    const a = this.area!;
    const pad = 24;
    return this.vmin + ((a.y1 - pad - y) / (a.y1 - a.y0 - pad * 2)) * (this.vmax - this.vmin || 1);
  }

  draw(g: CanvasRenderingContext2D, area: GraphArea) {
    this.area = area;
    // keep the vertical scale stable while dragging, otherwise the curve jumps under the cursor
    if (!this.drag) this.curves = this.pick();
    const curves = this.curves;
    g.save();
    g.beginPath();
    g.rect(area.x0, area.y0, area.x1 - area.x0, area.y1 - area.y0);
    g.clip();
    g.fillStyle = '#141416';
    g.fillRect(area.x0, area.y0, area.x1 - area.x0, area.y1 - area.y0);
    if (!curves.length) {
      g.fillStyle = '#6a6a72';
      g.font = '12px system-ui, sans-serif';
      g.fillText('Select an animated layer or keyframes to see value curves', area.x0 + 16, area.y0 + 24);
      g.restore();
      return;
    }
    // sample curves
    const t0 = Math.max(0, area.xToT(area.x0)), t1 = area.xToT(area.x1);
    const steps = Math.min(600, Math.max(60, Math.round((area.x1 - area.x0) / 2)));
    const samples: Float64Array[] = [];
    let lo = Infinity, hi = -Infinity;
    const tmp = new Float64Array(4);
    for (const c of curves) {
      const p = c.layer.props[c.key]!;
      const dimN = PROP_DEFS[c.key].dim;
      const tr = new Track(p, dimN, c.key === 'position');
      const arr = new Float64Array(steps + 1);
      if (this.speed) {
        // one speed curve per property (vector speed), drawn on the "handles" dimension only
        if (!c.handles) { arr.fill(NaN); samples.push(arr); continue; }
        const dt = (t1 - t0) / steps;
        const prev = new Float64Array(4);
        tr.eval(t0 - dt, prev, 0);
        for (let s = 0; s <= steps; s++) {
          tr.eval(t0 + (t1 - t0) * (s / steps), tmp, 0);
          let d2 = 0;
          for (let d = 0; d < Math.min(dimN, 3); d++) d2 += (tmp[d] - prev[d]) ** 2;
          arr[s] = Math.sqrt(d2) / dt;
          prev.set(tmp);
          if (arr[s] < lo) lo = arr[s];
          if (arr[s] > hi) hi = arr[s];
        }
        lo = Math.min(lo, 0);
        samples.push(arr);
        continue;
      }
      for (let s = 0; s <= steps; s++) {
        tr.eval(t0 + (t1 - t0) * (s / steps), tmp, 0);
        arr[s] = tmp[c.dim];
        if (arr[s] < lo) lo = arr[s];
        if (arr[s] > hi) hi = arr[s];
      }
      for (const k of p.kf!) { lo = Math.min(lo, k.v[c.dim]); hi = Math.max(hi, k.v[c.dim]); }
      samples.push(arr);
    }
    if (!this.drag) {
      if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
      const m = (hi - lo) * 0.08;
      this.vmin = lo - m; this.vmax = hi + m;
    }
    // horizontal grid with value labels
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'middle';
    const range = this.vmax - this.vmin;
    const stepV = niceStep(range / 5);
    for (let v = Math.ceil(this.vmin / stepV) * stepV; v <= this.vmax; v += stepV) {
      const y = Math.round(this.vToY(v)) + 0.5;
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(area.x0, y, area.x1 - area.x0, 1);
      g.fillStyle = '#6a6a72';
      g.fillText(fmt(v), area.x0 + 4, y - 6);
    }
    // curves
    if (this.speed) {
      g.fillStyle = '#6a6a72';
      g.fillText('speed (units / s)', area.x1 - 110, area.y0 + 12);
    }
    curves.forEach((c, ci) => {
      const arr = samples[ci];
      if (Number.isNaN(arr[0])) return;
      g.strokeStyle = c.color;
      g.lineWidth = 1.6;
      g.beginPath();
      for (let s = 0; s <= steps; s++) {
        const x = area.tToX(t0 + (t1 - t0) * (s / steps));
        const y = this.vToY(arr[s]);
        s ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    });
    // keyframes + handles
    const st = this.store;
    if (this.speed) {
      // keyframe times as ticks (speed mode is for reading the easing; edit in value mode)
      g.fillStyle = 'rgba(255,255,255,0.35)';
      for (const c of curves) if (c.handles) for (const k of c.layer.props[c.key]!.kf!) g.fillRect(Math.round(area.tToX(k.t)), area.y1 - 10, 1, 10);
      g.restore();
      return;
    }
    for (const c of curves) {
      const kf = c.layer.props[c.key]!.kf!;
      for (let i = 0; i < kf.length; i++) {
        const k = kf[i];
        const x = area.tToX(k.t), y = this.vToY(k.v[c.dim]);
        const sel = st.keySelection.has(keyId(c.layer.id, c.key, i));
        if (sel && c.handles) this.drawHandles(g, c, kf, i);
        g.fillStyle = sel ? '#ffffff' : c.color;
        g.strokeStyle = '#141416';
        g.lineWidth = 1.5;
        g.beginPath();
        g.rect(x - 4, y - 4, 8, 8);
        g.fill();
        g.stroke();
      }
    }
    g.restore();
  }

  /** bezier handles of the segments around key i, drawn on the first dimension's curve */
  private drawHandles(g: CanvasRenderingContext2D, c: Curve, kf: Keyframe[], i: number) {
    for (const seg of [i - 1, i]) {
      const h = this.handlePos(c, kf, seg);
      if (!h) continue;
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.lineWidth = 1;
      g.beginPath();
      if (seg === i) { g.moveTo(h.ax, h.ay); g.lineTo(h.ox, h.oy); }
      else { g.moveTo(h.bx, h.by); g.lineTo(h.ix, h.iy); }
      g.stroke();
      g.fillStyle = '#ffd34d';
      g.beginPath();
      if (seg === i) g.arc(h.ox, h.oy, 4, 0, Math.PI * 2);
      else g.arc(h.ix, h.iy, 4, 0, Math.PI * 2);
      g.fill();
    }
  }

  private handlePos(c: Curve, kf: Keyframe[], seg: number) {
    if (seg < 0 || seg >= kf.length - 1) return null;
    const a = kf[seg], b = kf[seg + 1];
    if (a.interp !== 'bezier') return null;
    const A = this.area!;
    const v0 = a.v[c.dim], v1 = b.v[c.dim];
    const dv = v1 - v0;
    const ax = A.tToX(a.t), bx = A.tToX(b.t);
    return {
      ax, ay: this.vToY(v0), bx, by: this.vToY(v1),
      ox: ax + (bx - ax) * a.out[0], oy: this.vToY(v0 + dv * a.out[1]),
      ix: ax + (bx - ax) * b.in[0], iy: this.vToY(v0 + dv * b.in[1]),
    };
  }

  /** returns true if the pointer event was handled */
  down(x: number, y: number, shift: boolean): boolean {
    if (!this.area || this.speed) return false;
    const st = this.store;
    // handles first (only visible on selected keys)
    for (const c of this.curves) {
      if (!c.handles) continue;
      const kf = c.layer.props[c.key]?.kf;
      if (!kf) continue;
      for (let i = 0; i < kf.length; i++) {
        if (!st.keySelection.has(keyId(c.layer.id, c.key, i))) continue;
        for (const seg of [i - 1, i]) {
          const h = this.handlePos(c, kf, seg);
          if (!h) continue;
          if (seg === i && Math.hypot(h.ox - x, h.oy - y) < 7) { this.drag = { kind: 'handle', c, seg, which: 'out' }; st.beginGesture('graph'); return true; }
          if (seg === i - 1 && Math.hypot(h.ix - x, h.iy - y) < 7) { this.drag = { kind: 'handle', c, seg, which: 'in' }; st.beginGesture('graph'); return true; }
        }
      }
    }
    for (const c of this.curves) {
      const kf = c.layer.props[c.key]?.kf;
      if (!kf) continue;
      for (let i = 0; i < kf.length; i++) {
        const kx = this.area.tToX(kf[i].t), ky = this.vToY(kf[i].v[c.dim]);
        if (Math.abs(kx - x) <= 6 && Math.abs(ky - y) <= 6) {
          const id = keyId(c.layer.id, c.key, i);
          if (shift) st.keySelection.has(id) ? st.keySelection.delete(id) : st.keySelection.add(id);
          else if (!st.keySelection.has(id)) st.keySelection = new Set([id]);
          st.emit('keys');
          this.drag = { kind: 'key', c, i, sx: x, sy: y, t0: kf[i].t, v0: kf[i].v.slice(), moved: false };
          st.beginGesture('graph');
          return true;
        }
      }
    }
    return false;
  }

  move(x: number, y: number, shift: boolean): boolean {
    const d = this.drag;
    if (!d || !this.area) return false;
    const st = this.store;
    if (d.kind === 'handle') {
      const c = d.c;
      const kf = c.layer.props[c.key]!.kf!;
      const a = kf[d.seg], b = kf[d.seg + 1];
      const ax = this.area.tToX(a.t), bx = this.area.tToX(b.t);
      const fx = Math.min(1, Math.max(0, (x - ax) / (bx - ax || 1)));
      const dv = b.v[c.dim] - a.v[c.dim];
      const fy = Math.abs(dv) < 1e-9 ? (d.which === 'out' ? a.out[1] : b.in[1]) : (this.yToV(y) - a.v[c.dim]) / dv;
      const out: [number, number] = d.which === 'out' ? [fx, fy] : [a.out[0], a.out[1]];
      const inn: [number, number] = d.which === 'in' ? [fx, fy] : [b.in[0], b.in[1]];
      setSegmentHandles(st, c.layer.id, c.key, d.seg, out, inn);
      return true;
    }
    if (d.kind === 'key') {
      if (!d.moved && Math.hypot(x - d.sx, y - d.sy) < 3) return true;
      d.moved = true;
      const c = d.c;
      const p = c.layer.props[c.key]!;
      // vertical: value of this dimension. horizontal: time (snapped to frames, shift = vertical only)
      const nv = d.v0.slice();
      nv[c.dim] = d.v0[c.dim] + (this.yToV(y) - this.yToV(d.sy));
      let nt = shift ? d.t0 : st.snapTime(d.t0 + (x - d.sx) / ((this.area.tToX(1) - this.area.tToX(0)) || 1));
      const kf = p.kf!;
      // keep order: clamp between neighbours
      const lo = d.i > 0 ? kf[d.i - 1].t + 1e-3 : 0, hi = d.i < kf.length - 1 ? kf[d.i + 1].t - 1e-3 : Infinity;
      nt = Math.min(hi, Math.max(lo, nt));
      const idx = d.i;
      st.transact('Edit keyframe', tx => {
        tx.keepKeys = true;
        tx.set(p, 'kf', kf.map((k, j) => (j === idx ? { ...k, t: nt, v: nv } : k)));
        tx.touch(c.layer.id);
      });
      return true;
    }
    return false;
  }

  up(): boolean {
    if (!this.drag) return false;
    this.drag = null;
    this.store.endGesture();
    return true;
  }
}

function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}
function fmt(v: number) {
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2);
}
