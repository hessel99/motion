// pen tool (create bezier paths) + path point editing (double-click a path layer).
// all coordinates here are composition space unless noted.

import type { Editor } from '../app/editor';
import { createLayer, type Layer, type PathCmd, type PathGeometry } from '../core/model';
import { insertLayer } from '../core/commands';
import { T } from './theme';

interface PenPt { x: number; y: number; hx: number; hy: number } // handle = outgoing tangent (incoming is mirrored)

type EditRef = { g: number; c: number; a: number }; // geometry index, command index, arg index (x at a, y at a+1)

export class PenTool {
  pts: PenPt[] = [];
  private dragging = -1;
  private hover: [number, number] | null = null;
  // path edit mode
  editId: string | null = null;
  private editDrag: { refs: EditRef[]; sx: number; sy: number; orig: PathGeometry[]; inv: number[] } | null = null;

  constructor(private ed: Editor, private toScreen: (x: number, y: number) => number[], private redraw: () => void) {}

  get active() { return this.pts.length > 0; }

  // ---------------- creation ----------------
  down(cx: number, cy: number, zoom: number) {
    const st = this.ed.store;
    if (this.pts.length >= 2) {
      const f = this.pts[0];
      if (Math.hypot(f.x - cx, f.y - cy) * zoom < 8) { this.finish(true); return; }
    }
    this.pts.push({ x: cx, y: cy, hx: 0, hy: 0 });
    this.dragging = this.pts.length - 1;
    void st;
    this.redraw();
  }

  move(cx: number, cy: number) {
    this.hover = [cx, cy];
    if (this.dragging >= 0) {
      const p = this.pts[this.dragging];
      p.hx = cx - p.x; p.hy = cy - p.y;
    }
    this.redraw();
  }

  up() { this.dragging = -1; }

  cancel() { this.pts = []; this.dragging = -1; this.redraw(); }

  /** build the layer. closed: fill; open: stroke only */
  finish(closed: boolean) {
    const pts = this.pts;
    this.pts = [];
    this.dragging = -1;
    if (pts.length < 2) { this.redraw(); return; }
    // bounds of anchors + handles
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const p of pts) { grow(p.x, p.y); grow(p.x + p.hx, p.y + p.hy); grow(p.x - p.hx, p.y - p.hy); }
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const cmds: PathCmd[] = [['M', pts[0].x - x0, pts[0].y - y0]];
    const seg = (a: PenPt, b: PenPt) => {
      if (!a.hx && !a.hy && !b.hx && !b.hy) cmds.push(['L', b.x - x0, b.y - y0]);
      else cmds.push(['C', a.x + a.hx - x0, a.y + a.hy - y0, b.x - b.hx - x0, b.y - b.hy - y0, b.x - x0, b.y - y0]);
    };
    for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
    if (closed) { seg(pts[pts.length - 1], pts[0]); cmds.push(['Z']); }
    const st = this.ed.store;
    const l = createLayer('path', { x: x0, y: y0, w, h, name: closed ? 'Shape' : 'Path', color: closed ? [0.85, 0.85, 0.85, 1] : [0, 0, 0, 0] });
    l.geometry = [{ cmds, fillRule: 'nonzero' }];
    l.geomSize = [w, h];
    if (!closed) { l.props.stroke = { v: [1, 1, 1, 1] }; l.props.strokeWidth = { v: [4] }; }
    st.transact('Pen', tx => insertLayer(st, tx, l, null));
    st.select([l.id]);
    this.ed.setTool('select');
    this.redraw();
  }

  draw(g: CanvasRenderingContext2D) {
    if (this.editId) this.drawEdit(g);
    if (!this.pts.length) return;
    const S = this.toScreen;
    g.strokeStyle = T.vpSelection;
    g.lineWidth = 1.5;
    g.beginPath();
    const p0 = S(this.pts[0].x, this.pts[0].y);
    g.moveTo(p0[0], p0[1]);
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1], b = this.pts[i];
      const c1 = S(a.x + a.hx, a.y + a.hy), c2 = S(b.x - b.hx, b.y - b.hy), e = S(b.x, b.y);
      g.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], e[0], e[1]);
    }
    if (this.hover && this.dragging < 0) {
      const a = this.pts[this.pts.length - 1];
      const c1 = S(a.x + a.hx, a.y + a.hy), e = S(this.hover[0], this.hover[1]);
      g.bezierCurveTo(c1[0], c1[1], e[0], e[1], e[0], e[1]);
    }
    g.stroke();
    for (const p of this.pts) {
      const s = S(p.x, p.y);
      if (p.hx || p.hy) {
        const a = S(p.x + p.hx, p.y + p.hy), b = S(p.x - p.hx, p.y - p.hy);
        g.strokeStyle = T.vpTangent;
        g.beginPath(); g.moveTo(b[0], b[1]); g.lineTo(a[0], a[1]); g.stroke();
        g.fillStyle = T.vpHandle;
        for (const q of [a, b]) { g.beginPath(); g.arc(q[0], q[1], 3, 0, Math.PI * 2); g.fill(); }
      }
      g.fillStyle = T.vpHandle;
      g.strokeStyle = T.vpSelection;
      g.beginPath(); g.rect(s[0] - 3.5, s[1] - 3.5, 7, 7); g.fill(); g.stroke();
    }
  }

  // ---------------- edit existing path ----------------
  private layerToComp(l: Layer): number[] | null {
    const W = this.ed.renderer.worldMatrix(l.id);
    if (!W) return null;
    const sz = this.ed.renderer.sizeOf(l.id);
    const gs = l.geomSize ?? sz;
    const gx = gs[0] ? sz[0] / gs[0] : 1, gy = gs[1] ? sz[1] / gs[1] : 1;
    return [W[0] * gx, W[1] * gx, W[2] * gy, W[3] * gy, W[4], W[5]];
  }

  private points(l: Layer): { ref: EditRef; anchor: boolean; x: number; y: number }[] {
    const M = this.layerToComp(l);
    if (!M) return [];
    const out: { ref: EditRef; anchor: boolean; x: number; y: number }[] = [];
    (l.geometry ?? []).forEach((g, gi) => g.cmds.forEach((c, ci) => {
      for (let a = 1; a + 1 < c.length; a += 2) {
        const px = c[a] as number, py = c[a + 1] as number;
        out.push({ ref: { g: gi, c: ci, a }, anchor: a + 2 >= c.length, x: M[0] * px + M[2] * py + M[4], y: M[1] * px + M[3] * py + M[5] });
      }
    }));
    return out;
  }

  private drawEdit(g: CanvasRenderingContext2D) {
    const l = this.ed.store.layer(this.editId!);
    if (!l?.geometry) { this.editId = null; return; }
    const pts = this.points(l);
    const S = this.toScreen;
    // handle lines: control points to their anchors
    g.strokeStyle = T.vpTangent;
    g.lineWidth = 1;
    l.geometry.forEach((geo, gi) => geo.cmds.forEach((c, ci) => {
      if (c[0] !== 'C') return;
      const at = (a: number) => pts.find(p => p.ref.g === gi && p.ref.c === ci && p.ref.a === a)!;
      const prevEnd = this.prevAnchor(pts, gi, ci);
      const c1 = at(1), c2 = at(3), e = at(5);
      if (prevEnd) { const a = S(prevEnd.x, prevEnd.y), b = S(c1.x, c1.y); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); }
      { const a = S(e.x, e.y), b = S(c2.x, c2.y); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); }
    }));
    for (const p of pts) {
      const s = S(p.x, p.y);
      g.fillStyle = p.anchor ? T.vpHandle : T.vpSelection;
      g.strokeStyle = T.vpSelection;
      g.beginPath();
      if (p.anchor) g.rect(s[0] - 3.5, s[1] - 3.5, 7, 7); else g.arc(s[0], s[1], 3, 0, Math.PI * 2);
      g.fill(); g.stroke();
    }
  }

  private prevAnchor(pts: { ref: EditRef; anchor: boolean; x: number; y: number }[], gi: number, ci: number) {
    for (let c = ci - 1; c >= 0; c--) {
      const cand = pts.filter(p => p.ref.g === gi && p.ref.c === c && p.anchor);
      if (cand.length) return cand[cand.length - 1];
    }
    return null;
  }

  /** returns true if it grabbed a point */
  editDown(sx: number, sy: number): boolean {
    const l = this.ed.store.layer(this.editId!);
    if (!l?.geometry) return false;
    const pts = this.points(l);
    let best = -1, bd = 8;
    pts.forEach((p, i) => { const s = this.toScreen(p.x, p.y); const d = Math.hypot(s[0] - sx, s[1] - sy); if (d < bd || (d <= bd && p.anchor)) { bd = d; best = i; } });
    if (best < 0) return false;
    const hit = pts[best];
    const refs: EditRef[] = [];
    const cmds = l.geometry[hit.ref.g].cmds;
    const addAnchor = (r: EditRef) => {
      refs.push(r);
      // moving an anchor also moves its two handles (incoming = this C's c2, outgoing = next C's c1)
      if (cmds[r.c][0] === 'C') refs.push({ g: r.g, c: r.c, a: 3 });
      const next = cmds[r.c + 1];
      if (next && next[0] === 'C') refs.push({ g: r.g, c: r.c + 1, a: 1 });
    };
    if (hit.anchor) {
      // closed paths repeat the start point at the end: move every coincident anchor together
      for (const p of pts) if (p.anchor && p.ref.g === hit.ref.g && Math.abs(p.x - hit.x) < 1e-3 && Math.abs(p.y - hit.y) < 1e-3) addAnchor(p.ref);
    } else refs.push(hit.ref);
    const M = this.layerToComp(l)!;
    const det = M[0] * M[3] - M[1] * M[2] || 1;
    const inv = [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det];
    this.editDrag = { refs, sx, sy, orig: structuredClone(l.geometry), inv };
    this.ed.store.beginGesture('path-edit');
    return true;
  }

  editMove(sx: number, sy: number, zoom: number): boolean {
    const d = this.editDrag;
    if (!d) return false;
    const st = this.ed.store;
    const l = st.layer(this.editId!);
    if (!l) return false;
    const dcx = (sx - d.sx) / zoom, dcy = (sy - d.sy) / zoom;
    const dx = d.inv[0] * dcx + d.inv[2] * dcy, dy = d.inv[1] * dcx + d.inv[3] * dcy;
    const geo = structuredClone(d.orig);
    for (const r of d.refs) {
      const c = geo[r.g].cmds[r.c] as any[];
      c[r.a] += dx; c[r.a + 1] += dy;
    }
    st.transact('Edit path', tx => { tx.set(l, 'geometry', geo); tx.touch(l.id); });
    return true;
  }

  editUp(): boolean {
    if (!this.editDrag) return false;
    this.editDrag = null;
    this.ed.store.endGesture();
    return true;
  }
}
