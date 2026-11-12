// viewport interaction + overlay drawing (vanilla ts, no framework in the hot path).
// coordinates: css px "screen" = comp * zoom + pan.

import type { Editor } from '../app/editor';
import { addLayer, valueAt, deleteLayers, cloneLayers, setPropTx } from '../core/commands';
import type { Tx } from '../core/store';
import { PenTool } from './pen';
import type { Layer } from '../core/model';
import { Track } from '../core/evaluate';

type Drag =
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  | { kind: 'move'; sx: number; sy: number; start: Map<string, { pos: number[]; inv: number[] }>; moved: boolean; box: number[]; xs: Float64Array; ys: Float64Array }
  | { kind: 'marquee'; sx: number; sy: number; x: number; y: number; base: string[] }
  | { kind: 'create'; type: 'rect' | 'ellipse'; cx: number; cy: number; id: string | null }
  | { kind: 'resize'; id: string; handle: number; inv: number[]; size: number[]; anchor: number[]; local: number[]; shift: boolean }
  | { kind: 'rotate'; id: string; cx: number; cy: number; a0: number; r0: number }
  | { kind: 'pathkey'; id: string; idx: number; part: 'key' | 'out' | 'in'; inv: number[]; sx: number; sy: number; v0: number[] };

const HANDLE = 8;

export class ViewportController {
  overlay: HTMLCanvasElement;
  octx: CanvasRenderingContext2D;
  zoom = 0.5;
  panX = 0;
  panY = 0;
  private drag: Drag | null = null;
  private hover: string | null = null;
  private spaceDown = false;
  private overlayDirty = true;
  private fitted = false;
  private lastSelKey = '';
  private mouse = { x: 0, y: 0 };
  onTextEdit: ((id: string) => void) | null = null;
  pen: PenTool;

  constructor(private ed: Editor, private host: HTMLElement, private canvas: HTMLCanvasElement) {
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'vp-overlay';
    host.appendChild(this.overlay);
    this.octx = this.overlay.getContext('2d')!;
    this.pen = new PenTool(ed, (x, y) => this.toScreen(x, y), () => { this.overlayDirty = true; });
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(host);
    this.resize();
    host.addEventListener('pointerdown', e => this.down(e));
    host.addEventListener('pointermove', e => this.move(e));
    host.addEventListener('pointerup', e => this.up(e));
    host.addEventListener('pointercancel', e => this.up(e));
    host.addEventListener('dblclick', e => this.dbl(e));
    host.addEventListener('wheel', e => this.wheel(e), { passive: false });
    window.addEventListener('keydown', e => { if (e.code === 'Space' && !isTyping(e)) { this.spaceDown = true; this.updateCursor(); } });
    window.addEventListener('keyup', e => { if (e.code === 'Space') { this.spaceDown = false; this.updateCursor(); } });
    const st = ed.store;
    st.on('selection', () => (this.overlayDirty = true));
    st.on('doc', () => (this.overlayDirty = true));
    st.on('time', () => (this.overlayDirty = true));
    ed.on('tool', () => { this.updateCursor(); if (ed.tool !== 'pen' && this.pen.active) this.pen.finish(false); });
    st.on('selection', () => { if (this.pen.editId && !(st.selection.length === 1 && st.selection[0] === this.pen.editId)) { this.pen.editId = null; this.overlayDirty = true; } });
    window.addEventListener('keydown', e => {
      if (isTyping(e)) return;
      if (this.pen.active && (e.key === 'Enter' || e.key === 'Escape')) { e.preventDefault(); e.stopImmediatePropagation(); this.pen.finish(false); }
      else if (this.pen.editId && (e.key === 'Escape' || e.key === 'Enter')) { e.preventDefault(); e.stopImmediatePropagation(); this.pen.editId = null; this.overlayDirty = true; }
    }, true);
    ed.on('loaded', () => { this.fitted = false; this.resize(); });
    ed.onFrame((_now, _t, playing) => {
      // overlay only depends on selection/time/view: redraw when needed (during playback only if something is selected)
      if (playing && st.selection.length) this.overlayDirty = true;
      if (this.overlayDirty) { this.drawOverlay(); this.overlayDirty = false; }
    });
  }

  // ---------- view ----------
  resize() {
    const r = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.ed.renderer.resize(r.width, r.height, dpr);
    this.overlay.width = Math.round(r.width * dpr);
    this.overlay.height = Math.round(r.height * dpr);
    this.overlay.style.width = r.width + 'px';
    this.overlay.style.height = r.height + 'px';
    if (!this.fitted && r.width > 10) { this.fit(); this.fitted = true; }
    this.applyView();
  }

  fit() {
    const r = this.host.getBoundingClientRect();
    const comp = this.ed.store.comp;
    const z = Math.min((r.width - 80) / comp.width, (r.height - 80) / comp.height);
    this.zoom = Math.max(0.02, z);
    this.panX = (r.width - comp.width * this.zoom) / 2;
    this.panY = (r.height - comp.height * this.zoom) / 2;
    this.applyView();
  }

  setZoom(z: number, cx?: number, cy?: number) {
    const r = this.host.getBoundingClientRect();
    cx ??= r.width / 2; cy ??= r.height / 2;
    z = Math.min(64, Math.max(0.02, z));
    const wx = (cx - this.panX) / this.zoom, wy = (cy - this.panY) / this.zoom;
    this.zoom = z;
    this.panX = cx - wx * z;
    this.panY = cy - wy * z;
    this.applyView();
  }

  private applyView() {
    this.ed.renderer.setView(this.zoom, this.panX, this.panY);
    this.overlayDirty = true;
    this.ed.emit('view');
  }

  toComp(sx: number, sy: number) { return [(sx - this.panX) / this.zoom, (sy - this.panY) / this.zoom]; }
  toScreen(x: number, y: number) { return [x * this.zoom + this.panX, y * this.zoom + this.panY]; }

  private local(e: PointerEvent | MouseEvent | WheelEvent) {
    const r = this.host.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const [x, y] = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      // pinch / ctrl+wheel zoom
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
      this.setZoom(this.zoom * f, x, y);
    } else {
      this.panX -= e.deltaX;
      this.panY -= e.deltaY;
      this.applyView();
    }
  }

  // ---------- selection helpers ----------
  /** figma-like pick: click selects the top-most ancestor unless already inside the selection's subtree */
  private pick(deepId: string, deep: boolean): string {
    if (deep) return deepId;
    const st = this.ed.store;
    const chain: string[] = [];
    let cur: string | null = deepId;
    while (cur) { chain.unshift(cur); cur = st.layer(cur)?.parent ?? null; }
    // chain[0] = root ancestor. if selection contains an ancestor (or sibling under same parent), go one level deeper
    for (let i = 0; i < chain.length; i++) {
      const id = chain[i];
      if (st.selection.includes(id)) return chain[Math.min(i + 1, chain.length - 1)] === id ? id : (i + 1 < chain.length ? chain[i + 1] : id);
      const parent = st.layer(id)?.parent;
      if (parent && st.selection.some(s => st.layer(s)?.parent === parent)) return id;
    }
    return chain[0];
  }

  private handleAt(x: number, y: number): { id: string; handle: number } | null {
    const st = this.ed.store;
    if (st.selection.length !== 1) return null;
    const id = st.selection[0];
    const c = this.ed.renderer.corners(id);
    if (!c) return null;
    const pts = this.handlePoints(c);
    for (let i = 0; i < pts.length; i++) {
      const [hx, hy] = pts[i];
      if (Math.abs(hx - x) <= HANDLE && Math.abs(hy - y) <= HANDLE) return { id, handle: i };
    }
    // rotation zone: just outside corners
    for (let i = 0; i < 4; i++) {
      const [hx, hy] = pts[i * 2];
      const d = Math.hypot(hx - x, hy - y);
      if (d > HANDLE && d < HANDLE * 3) return { id, handle: 100 + i };
    }
    return null;
  }

  /** motion path: keyframes + spatial tangent handles of selected layers (screen space) */
  private pathPoints() {
    const st = this.ed.store, r = this.ed.renderer;
    const out: { id: string; idx: number; part: 'key' | 'out' | 'in'; x: number; y: number }[] = [];
    for (const id of st.selection) {
      const l = st.layer(id);
      const kf = l?.props.position?.kf;
      if (!l || !kf || kf.length < 2) continue;
      const pw = l.parent ? r.worldMatrix(l.parent) : [1, 0, 0, 1, 0, 0];
      if (!pw) continue;
      const P = (x: number, y: number) => this.toScreen(pw[0] * x + pw[2] * y + pw[4], pw[1] * x + pw[3] * y + pw[5]);
      kf.forEach((k, i) => {
        const [sx, sy] = P(k.v[0], k.v[1]);
        out.push({ id, idx: i, part: 'key', x: sx, y: sy });
        const keySel = st.keySelection.has(`${id}|position|${i}`);
        if (keySel || k.sOut?.some(v => v) || k.sIn?.some(v => v)) {
          if (i < kf.length - 1 && k.sOut) { const [hx, hy] = P(k.v[0] + k.sOut[0], k.v[1] + k.sOut[1]); out.push({ id, idx: i, part: 'out', x: hx, y: hy }); }
          if (i > 0 && k.sIn) { const [hx, hy] = P(k.v[0] + k.sIn[0], k.v[1] + k.sIn[1]); out.push({ id, idx: i, part: 'in', x: hx, y: hy }); }
        }
      });
    }
    return out;
  }

  /** screen-space handle points: 0 tl,1 t,2 tr,3 r,4 br,5 b,6 bl,7 l */
  private handlePoints(c: number[]) {
    const s = (i: number) => this.toScreen(c[i * 2], c[i * 2 + 1]);
    const [p0, p1, p2, p3] = [s(0), s(1), s(2), s(3)];
    const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return [p0, mid(p0, p1), p1, mid(p1, p2), p2, mid(p2, p3), p3, mid(p3, p0)];
  }

  // ---------- pointer ----------
  private down(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('.vp-ui')) return;
    const [x, y] = this.local(e);
    this.host.setPointerCapture(e.pointerId);
    const st = this.ed.store;
    const tool = this.ed.tool;
    if (e.button === 1 || this.spaceDown || tool === 'hand') {
      this.drag = { kind: 'pan', sx: x, sy: y, px: this.panX, py: this.panY };
      return;
    }
    if (e.button !== 0) return;
    const [cx, cy] = this.toComp(x, y);
    if (tool === 'pen') { this.pen.down(cx, cy, this.zoom); return; }
    if (this.pen.editId && this.pen.editDown(x, y)) return;
    if (tool === 'rect' || tool === 'ellipse') {
      this.drag = { kind: 'create', type: tool, cx, cy, id: null };
      st.beginGesture('create');
      return;
    }
    if (tool === 'text') {
      const l = addLayer(st, 'text', {
        x: cx, y: cy, w: 0, h: 0, name: 'Text', color: [1, 1, 1, 1],
        text: { content: 'Text', fontFamily: 'Inter', fontSize: 64, fontWeight: 600, lineHeight: 1.2, letterSpacing: 0, align: 'left' },
      } as any);
      // auto width text: size from measure
      this.ed.renderer.render(st.time);
      st.select([l.id]);
      this.ed.setTool('select');
      e.preventDefault(); // keep focus for the text editor that opens after this event
      setTimeout(() => this.onTextEdit?.(l.id), 0);
      return;
    }
    // select tool: motion path keys / tangents first
    const pp = this.pathPoints().reverse().find(p => Math.hypot(p.x - x, p.y - y) <= (p.part === 'key' ? 6 : 5));
    if (pp) {
      const l = st.layer(pp.id)!;
      const kf = l.props.position!.kf!;
      const k = kf[pp.idx];
      if (pp.part === 'key' && e.altKey) {
        // alt-click: toggle curve handles (straight <-> smooth) for this key
        const curved = k.sOut?.some(v => v) || k.sIn?.some(v => v);
        const prev = kf[pp.idx - 1], next = kf[pp.idx + 1];
        const dir = prev && next ? [(next.v[0] - prev.v[0]) / 6, (next.v[1] - prev.v[1]) / 6] : next ? [(next.v[0] - k.v[0]) / 3, (next.v[1] - k.v[1]) / 3] : prev ? [(k.v[0] - prev.v[0]) / 3, (k.v[1] - prev.v[1]) / 3] : [0, 0];
        st.transact('Toggle path curve', tx => {
          const nk = kf.map((f, i) => (i === pp.idx ? { ...f, sOut: curved ? [0, 0] : dir, sIn: curved ? [0, 0] : [-dir[0], -dir[1]] } : f));
          tx.keepKeys = true;
          tx.set(l.props.position!, 'kf', nk);
          tx.touch(l.id);
        });
        return;
      }
      st.keySelection = new Set([`${pp.id}|position|${pp.idx}`]);
      st.emit('keys');
      const pw = l.parent ? this.ed.renderer.worldMatrix(l.parent)! : [1, 0, 0, 1, 0, 0];
      const v0 = pp.part === 'key' ? k.v.slice() : (pp.part === 'out' ? (k.sOut ?? [0, 0]) : (k.sIn ?? [0, 0])).slice();
      this.drag = { kind: 'pathkey', id: pp.id, idx: pp.idx, part: pp.part, inv: invert(pw), sx: x, sy: y, v0 };
      st.beginGesture('pathkey');
      return;
    }
    const h = this.handleAt(x, y);
    if (h) {
      const l = st.layer(h.id)!;
      if (h.handle >= 100) {
        const W = this.ed.renderer.worldMatrix(h.id)!;
        const anc = valueAt(l, 'anchor', st.time);
        const ax = W[0] * anc[0] + W[2] * anc[1] + W[4], ay = W[1] * anc[0] + W[3] * anc[1] + W[5];
        this.drag = { kind: 'rotate', id: h.id, cx: ax, cy: ay, a0: Math.atan2(cy - ay, cx - ax), r0: valueAt(l, 'rotation', st.time)[0] };
      } else {
        const W = this.ed.renderer.worldMatrix(h.id)!;
        this.drag = {
          kind: 'resize', id: h.id, handle: h.handle, inv: invert(W), size: valueAt(l, 'size', st.time),
          anchor: valueAt(l, 'anchor', st.time), local: localMatrix(l, st.time), shift: e.shiftKey,
        };
      }
      st.beginGesture('transform');
      return;
    }
    const hit = this.ed.renderer.hitTest(cx, cy);
    if (hit) {
      const id = this.pick(hit, e.metaKey || e.ctrlKey);
      if (e.shiftKey) st.select([id], 'toggle');
      else if (!st.selection.includes(id)) st.select([id]);
      if (e.altKey) {
        // alt-drag duplicates (figma)
        cloneLayers(st, st.selection);
        this.startMove(x, y);
        return;
      }
      this.startMove(x, y);
    } else {
      this.drag = { kind: 'marquee', sx: x, sy: y, x, y, base: e.shiftKey ? st.selection.slice() : [] };
      if (!e.shiftKey) st.select([]);
    }
  }

  private startMove(x: number, y: number) {
    const st = this.ed.store;
    this.ed.renderer.render(st.time); // fresh bounds (e.g. right after alt-drag duplicate)
    const start = new Map<string, { pos: number[]; inv: number[] }>();
    for (const id of st.selection) {
      const l = st.layer(id);
      if (!l || l.locked) continue;
      // skip if an ancestor is also selected
      if (st.selection.some(o => o !== id && st.isAncestor(o, id))) continue;
      const pw = l.parent ? this.ed.renderer.worldMatrix(l.parent) : [1, 0, 0, 1, 0, 0];
      start.set(id, { pos: valueAt(l, 'position', st.time), inv: invert(pw ?? [1, 0, 0, 1, 0, 0]) });
    }
    // snapping: selection bounds + candidate lines (comp edges/center, sibling layer edges/centers)
    const box = this.boundsOf([...start.keys()]);
    const xs: number[] = [], ys: number[] = [];
    const comp = st.comp;
    xs.push(0, comp.width / 2, comp.width);
    ys.push(0, comp.height / 2, comp.height);
    const moving = new Set<string>();
    for (const id of start.keys()) { moving.add(id); for (const d of st.descendants(id)) moving.add(d); }
    const first = st.layer([...start.keys()][0]);
    const siblings = first ? st.siblings(first) : [];
    // siblings plus the parent box (so children snap inside their frame); capped for huge scenes
    const cands = [...siblings.slice(-2000), ...(first?.parent ? [first.parent] : [])];
    for (const id of cands) {
      if (moving.has(id)) continue;
      const b = this.boundsOf([id]);
      if (!b) continue;
      xs.push(b[0], (b[0] + b[2]) / 2, b[2]);
      ys.push(b[1], (b[1] + b[3]) / 2, b[3]);
    }
    this.drag = { kind: 'move', sx: x, sy: y, start, moved: false, box: box ?? [0, 0, 0, 0], xs: Float64Array.from(xs).sort(), ys: Float64Array.from(ys).sort() };
    st.beginGesture('move');
  }

  /** comp-space axis aligned bounds of layers [x0,y0,x1,y1] */
  boundsOf(ids: string[]): number[] | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids) {
      const c = this.ed.renderer.corners(id);
      if (!c) continue;
      for (let i = 0; i < 4; i++) {
        x0 = Math.min(x0, c[i * 2]); x1 = Math.max(x1, c[i * 2]);
        y0 = Math.min(y0, c[i * 2 + 1]); y1 = Math.max(y1, c[i * 2 + 1]);
      }
    }
    return isFinite(x0) ? [x0, y0, x1, y1] : null;
  }

  /** active snap guides (comp coords) for the overlay */
  private guides: { x: number[]; y: number[] } = { x: [], y: [] };

  /** best snap offset for any of `vals` against sorted `lines` within `tol` */
  private snap1(vals: number[], lines: Float64Array, tol: number): { d: number; at: number[] } {
    let best = Infinity, d = 0;
    for (const v of vals) {
      // binary search nearest line
      let lo = 0, hi = lines.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (lines[m] < v) lo = m + 1; else hi = m; }
      for (const j of [lo - 1, lo]) {
        if (j < 0 || j >= lines.length) continue;
        const dd = lines[j] - v;
        if (Math.abs(dd) < Math.abs(best) && Math.abs(dd) <= tol) { best = dd; d = dd; }
      }
    }
    if (!isFinite(best)) return { d: 0, at: [] };
    const at = vals.map(v => v + d).filter(v => { for (let j = 0; j < lines.length; j++) if (Math.abs(lines[j] - v) < 1e-6) return true; return false; });
    return { d, at };
  }

  private move(e: PointerEvent) {
    const [x, y] = this.local(e);
    this.mouse = { x, y };
    const st = this.ed.store;
    const d = this.drag;
    if (this.ed.tool === 'pen') { const [cx, cy] = this.toComp(x, y); this.pen.move(cx, cy); return; }
    if (this.pen.editMove(x, y, this.zoom)) return;
    if (!d) {
      if (this.ed.tool === 'select') {
        const [cx, cy] = this.toComp(x, y);
        const h = this.handleAt(x, y);
        this.host.style.cursor = h ? (h.handle >= 100 ? 'alias' : HANDLE_CURSORS[h.handle]) : '';
        const hit = h ? null : this.ed.renderer.hitTest(cx, cy);
        const hov = hit ? this.pick(hit, e.metaKey || e.ctrlKey) : null;
        if (hov !== this.hover) { this.hover = hov; this.overlayDirty = true; }
      }
      return;
    }
    if (d.kind === 'pan') {
      this.panX = d.px + (x - d.sx);
      this.panY = d.py + (y - d.sy);
      this.applyView();
    } else if (d.kind === 'move') {
      let dx = (x - d.sx) / this.zoom, dy = (y - d.sy) / this.zoom;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      if (!d.moved && Math.hypot(x - d.sx, y - d.sy) < 3) return;
      d.moved = true;
      this.guides = { x: [], y: [] };
      if (!(e.metaKey || e.ctrlKey)) {
        const tol = 6 / this.zoom;
        const b = d.box;
        const sx = this.snap1([b[0] + dx, (b[0] + b[2]) / 2 + dx, b[2] + dx], d.xs, tol);
        const sy = this.snap1([b[1] + dy, (b[1] + b[3]) / 2 + dy, b[3] + dy], d.ys, tol);
        if (!(e.shiftKey && dx === 0)) { dx += sx.d; this.guides.x = sx.at; }
        if (!(e.shiftKey && dy === 0)) { dy += sy.d; this.guides.y = sy.at; }
      }
      st.transact('Move', tx => {
        for (const [id, s] of d.start) {
          const l = st.layer(id);
          if (!l) continue;
          const ldx = s.inv[0] * dx + s.inv[2] * dy, ldy = s.inv[1] * dx + s.inv[3] * dy;
          setPropTx(tx, l, 'position', [Math.round((s.pos[0] + ldx) * 100) / 100, Math.round((s.pos[1] + ldy) * 100) / 100], st.time);
        }
      });
    } else if (d.kind === 'marquee') {
      d.x = x; d.y = y;
      const [ax, ay] = this.toComp(Math.min(d.sx, x), Math.min(d.sy, y));
      const [bx, by] = this.toComp(Math.max(d.sx, x), Math.max(d.sy, y));
      const hits = this.ed.renderer.hitRect(ax, ay, bx, by).map(id => topAncestor(st, id));
      st.select([...new Set([...d.base, ...hits])]);
      this.overlayDirty = true;
    } else if (d.kind === 'create') {
      const [cx, cy] = this.toComp(x, y);
      let w = cx - d.cx, h = cy - d.cy;
      if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      const x0 = Math.min(d.cx, d.cx + w), y0 = Math.min(d.cy, d.cy + h);
      const aw = Math.max(1, Math.abs(w)), ah = Math.max(1, Math.abs(h));
      if (!d.id) {
        if (Math.hypot(w, h) * this.zoom < 3) return;
        const l = addLayer(st, d.type, { x: x0, y: y0, w: aw, h: ah, name: d.type === 'rect' ? 'Rectangle' : 'Ellipse', color: [0.85, 0.85, 0.85, 1] });
        d.id = l.id;
        st.select([l.id]);
      } else {
        const id = d.id;
        st.transact('Resize', tx => {
          const l = st.layer(id)!;
          setTx(tx, l, 'size', [aw, ah]);
          setTx(tx, l, 'anchor', [aw / 2, ah / 2]);
          setTx(tx, l, 'position', [x0 + aw / 2, y0 + ah / 2]);
        });
      }
    } else if (d.kind === 'resize') {
      const [cx, cy] = this.toComp(x, y);
      const lx = d.inv[0] * cx + d.inv[2] * cy + d.inv[4];
      const ly = d.inv[1] * cx + d.inv[3] * cy + d.inv[5];
      let x0 = 0, y0 = 0, x1 = d.size[0], y1 = d.size[1];
      const hnd = d.handle;
      if (hnd === 0 || hnd === 6 || hnd === 7) x0 = lx;
      if (hnd === 2 || hnd === 3 || hnd === 4) x1 = lx;
      if (hnd === 0 || hnd === 1 || hnd === 2) y0 = ly;
      if (hnd === 4 || hnd === 5 || hnd === 6) y1 = ly;
      if (e.shiftKey && d.size[0] > 0 && d.size[1] > 0) {
        const ar = d.size[0] / d.size[1];
        const w = x1 - x0, h = y1 - y0;
        if (hnd % 2 === 0) {
          if (Math.abs(w) / ar > Math.abs(h)) { const nh = Math.abs(w) / ar * Math.sign(h || 1); if (hnd <= 2) y0 = y1 - nh; else y1 = y0 + nh; }
          else { const nw = Math.abs(h) * ar * Math.sign(w || 1); if (hnd === 0 || hnd === 6) x0 = x1 - nw; else x1 = x0 + nw; }
        }
      }
      if (e.altKey) {
        // resize from center
        const cxl = d.size[0] / 2, cyl = d.size[1] / 2;
        if (x0 !== 0) x1 = 2 * cxl - x0; else if (x1 !== d.size[0]) x0 = 2 * cxl - x1;
        if (y0 !== 0) y1 = 2 * cyl - y0; else if (y1 !== d.size[1]) y0 = 2 * cyl - y1;
      }
      const nx0 = Math.min(x0, x1), ny0 = Math.min(y0, y1);
      const nw = Math.max(0.5, Math.abs(x1 - x0)), nh = Math.max(0.5, Math.abs(y1 - y0));
      const fax = d.size[0] ? d.anchor[0] / d.size[0] : 0.5, fay = d.size[1] ? d.anchor[1] / d.size[1] : 0.5;
      const na = [fax * nw, fay * nh];
      const q = [nx0 + na[0], ny0 + na[1]];
      const L = d.local;
      const pos = [L[0] * q[0] + L[2] * q[1] + L[4], L[1] * q[0] + L[3] * q[1] + L[5]];
      st.transact('Resize', tx => {
        const l = st.layer(d.id)!;
        setTx(tx, l, 'size', [round2(nw), round2(nh)]);
        setTx(tx, l, 'anchor', [round2(na[0]), round2(na[1])]);
        setTx(tx, l, 'position', [round2(pos[0]), round2(pos[1])]);
      });
    } else if (d.kind === 'pathkey') {
      const dcx = (x - d.sx) / this.zoom, dcy = (y - d.sy) / this.zoom;
      const dx = d.inv[0] * dcx + d.inv[2] * dcy, dy = d.inv[1] * dcx + d.inv[3] * dcy;
      const l = st.layer(d.id);
      const p = l?.props.position;
      if (!l || !p?.kf) return;
      const nv = [Math.round((d.v0[0] + dx) * 100) / 100, Math.round((d.v0[1] + dy) * 100) / 100];
      st.transact('Edit motion path', tx => {
        tx.keepKeys = true;
        const kf = p.kf!.map((f, i) => {
          if (i !== d.idx) return f;
          if (d.part === 'key') return { ...f, v: nv };
          // tangent: keep the opposite one mirrored unless alt is held (broken tangents)
          const mirror = !e.altKey;
          if (d.part === 'out') return { ...f, sOut: nv, ...(mirror ? { sIn: [-nv[0], -nv[1]] } : {}) };
          return { ...f, sIn: nv, ...(mirror ? { sOut: [-nv[0], -nv[1]] } : {}) };
        });
        tx.set(p, 'kf', kf);
        tx.touch(l.id);
      });
    } else if (d.kind === 'rotate') {
      const [cx, cy] = this.toComp(x, y);
      let deg = d.r0 + (Math.atan2(cy - d.cy, cx - d.cx) - d.a0) * 180 / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      st.transact('Rotate', tx => setTx(tx, st.layer(d.id)!, 'rotation', [round2(deg)]));
    }
  }

  private up(e: PointerEvent) {
    this.pen.up();
    if (this.pen.editUp()) { this.host.releasePointerCapture?.(e.pointerId); return; }
    const d = this.drag;
    this.drag = null;
    this.guides = { x: [], y: [] };
    this.host.releasePointerCapture?.(e.pointerId);
    const st = this.ed.store;
    st.endGesture();
    if (d?.kind === 'create') {
      if (!d.id) {
        // click without drag: default sized shape
        const l = addLayer(st, d.type, { x: d.cx - 50, y: d.cy - 50, w: 100, h: 100, name: d.type === 'rect' ? 'Rectangle' : 'Ellipse', color: [0.85, 0.85, 0.85, 1] });
        st.select([l.id]);
      }
      this.ed.setTool('select');
    }
    if (d?.kind === 'move' && !d.moved && !e.shiftKey) {
      // click (no drag) on a selected item inside a multi-selection: select just it
      const [cx, cy] = this.toComp(...(this.local(e) as [number, number]));
      const hit = this.ed.renderer.hitTest(cx, cy);
      if (hit && st.selection.length > 1) st.select([this.pick(hit, e.metaKey || e.ctrlKey)]);
    }
    this.overlayDirty = true;
  }

  private dbl(e: MouseEvent) {
    const [x, y] = this.local(e);
    const [cx, cy] = this.toComp(x, y);
    const hit = this.ed.renderer.hitTest(cx, cy);
    if (!hit) return;
    const st = this.ed.store;
    const l = st.layer(hit)!;
    if (l.type === 'text') { st.select([hit]); this.onTextEdit?.(hit); return; }
    if (l.type === 'precomp' && l.compRef) { st.openComp(l.compRef); return; }
    if (l.type === 'path' && l.geometry?.length && (st.selection[0] === hit || st.selection.length === 0 || l.parent === null)) { st.select([hit]); this.pen.editId = hit; this.overlayDirty = true; return; }
    // double click enters groups: select the next level down
    const sel = st.selection[0];
    let cur: string | null = hit, prev = hit;
    while (cur && cur !== sel) { prev = cur; cur = st.layer(cur)?.parent ?? null; }
    if (cur === sel) st.select([prev]);
  }

  private updateCursor() {
    const t = this.ed.tool;
    this.host.style.cursor = this.spaceDown || t === 'hand' ? 'grab' : t === 'select' ? '' : t === 'text' ? 'text' : 'crosshair';
  }

  // ---------- overlay ----------
  drawOverlay() {
    const g = this.octx;
    const dpr = window.devicePixelRatio || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.overlay.width, this.overlay.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const st = this.ed.store, r = this.ed.renderer;
    const comp = st.comp;
    // comp frame outline
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 1;
    const [c0x, c0y] = this.toScreen(0, 0);
    g.strokeRect(Math.round(c0x) - 0.5, Math.round(c0y) - 0.5, Math.round(comp.width * this.zoom) + 1, Math.round(comp.height * this.zoom) + 1);
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.font = '11px system-ui, sans-serif';
    g.fillText(`${comp.name}  ${comp.width}×${comp.height}`, c0x, c0y - 6);

    const accent = '#4c8dff';
    const poly = (c: number[]) => {
      g.beginPath();
      for (let i = 0; i < 4; i++) {
        const [sx, sy] = this.toScreen(c[i * 2], c[i * 2 + 1]);
        i ? g.lineTo(sx, sy) : g.moveTo(sx, sy);
      }
      g.closePath();
    };
    if (this.hover && !st.selection.includes(this.hover) && !this.drag) {
      const c = r.corners(this.hover);
      if (c) { g.strokeStyle = accent; g.lineWidth = 1; poly(c); g.stroke(); }
    }
    // motion path of selected layers with animated position
    for (const id of st.selection) {
      const l = st.layer(id);
      const p = l?.props.position;
      if (!l || !p?.kf || p.kf.length < 2) continue;
      const pw = l.parent ? r.worldMatrix(l.parent) : [1, 0, 0, 1, 0, 0];
      if (!pw) continue;
      const tr = new Track(p, 2, true);
      const t0 = p.kf[0].t, t1 = p.kf[p.kf.length - 1].t;
      const steps = Math.min(400, Math.max(20, Math.round((t1 - t0) * comp.fps)));
      const o = [0, 0];
      g.beginPath();
      for (let s = 0; s <= steps; s++) {
        tr.eval(t0 + (t1 - t0) * s / steps, o, 0);
        const wx = pw[0] * o[0] + pw[2] * o[1] + pw[4], wy = pw[1] * o[0] + pw[3] * o[1] + pw[5];
        const [sx, sy] = this.toScreen(wx, wy);
        s ? g.lineTo(sx, sy) : g.moveTo(sx, sy);
      }
      g.strokeStyle = 'rgba(76,141,255,0.6)';
      g.setLineDash([4, 3]);
      g.stroke();
      g.setLineDash([]);
      // spatial tangent handles
      for (const pt of this.pathPoints()) {
        if (pt.part === 'key' || pt.id !== id) continue;
        const k = p.kf[pt.idx];
        const kx = pw[0] * k.v[0] + pw[2] * k.v[1] + pw[4], ky = pw[1] * k.v[0] + pw[3] * k.v[1] + pw[5];
        const [ax, ay] = this.toScreen(kx, ky);
        g.strokeStyle = 'rgba(255,255,255,0.55)';
        g.beginPath(); g.moveTo(ax, ay); g.lineTo(pt.x, pt.y); g.stroke();
        g.fillStyle = '#ffd34d';
        g.beginPath(); g.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2); g.fill();
      }
      // frame ticks + keyframe squares
      g.fillStyle = accent;
      for (const k of p.kf) {
        const wx = pw[0] * k.v[0] + pw[2] * k.v[1] + pw[4], wy = pw[1] * k.v[0] + pw[3] * k.v[1] + pw[5];
        const [sx, sy] = this.toScreen(wx, wy);
        g.fillRect(sx - 3, sy - 3, 6, 6);
      }
    }
    // selection
    for (const id of st.selection) {
      const c = r.corners(id);
      if (!c) continue;
      g.strokeStyle = accent;
      g.lineWidth = 1;
      poly(c);
      g.stroke();
    }
    if (st.selection.length === 1 && !(this.drag && this.drag.kind === 'move')) {
      const c = r.corners(st.selection[0]);
      if (c) {
        const pts = this.handlePoints(c);
        g.fillStyle = '#fff';
        g.strokeStyle = accent;
        for (const [hx, hy] of pts) {
          g.beginPath();
          g.rect(Math.round(hx) - 3.5, Math.round(hy) - 3.5, 7, 7);
          g.fill();
          g.stroke();
        }
        // anchor point
        const l = st.layer(st.selection[0])!;
        const W = r.worldMatrix(l.id)!;
        const a = valueAt(l, 'anchor', st.time);
        const [ax, ay] = this.toScreen(W[0] * a[0] + W[2] * a[1] + W[4], W[1] * a[0] + W[3] * a[1] + W[5]);
        g.beginPath();
        g.arc(ax, ay, 3.5, 0, Math.PI * 2);
        g.strokeStyle = accent;
        g.stroke();
        // size label
        const sz = r.sizeOf(l.id);
        const sc = valueAt(l, 'scale', st.time);
        const label = `${Math.round(sz[0] * sc[0] / 100)} × ${Math.round(sz[1] * sc[1] / 100)}`;
        const by = Math.max(...[1, 3, 5, 7].map(i => this.toScreen(0, c[i])[1]));
        const bx = [0, 2, 4, 6].reduce((s, i) => s + this.toScreen(c[i], 0)[0], 0) / 4;
        g.font = '11px system-ui, sans-serif';
        const tw = g.measureText(label).width + 10;
        g.fillStyle = accent;
        roundRect(g, bx - tw / 2, by + 8, tw, 18, 3);
        g.fill();
        g.fillStyle = '#fff';
        g.fillText(label, bx - tw / 2 + 5, by + 21);
      }
    }
    if (this.guides.x.length || this.guides.y.length) {
      g.strokeStyle = '#ff4d6d';
      g.lineWidth = 1;
      const H = this.overlay.height, W = this.overlay.width;
      for (const gx of this.guides.x) { const [sx] = this.toScreen(gx, 0); g.beginPath(); g.moveTo(Math.round(sx) + 0.5, 0); g.lineTo(Math.round(sx) + 0.5, H); g.stroke(); }
      for (const gy of this.guides.y) { const [, sy] = this.toScreen(0, gy); g.beginPath(); g.moveTo(0, Math.round(sy) + 0.5); g.lineTo(W, Math.round(sy) + 0.5); g.stroke(); }
    }
    this.pen.draw(g);
    const d = this.drag;
    if (d?.kind === 'marquee') {
      g.fillStyle = 'rgba(76,141,255,0.08)';
      g.strokeStyle = accent;
      const x = Math.min(d.sx, d.x), y = Math.min(d.sy, d.y);
      g.fillRect(x, y, Math.abs(d.x - d.sx), Math.abs(d.y - d.sy));
      g.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x - d.sx), Math.abs(d.y - d.sy));
    }
  }

  requestOverlay() { this.overlayDirty = true; }

  deleteSelection() { deleteLayers(this.ed.store, this.ed.store.selection); }
}

const HANDLE_CURSORS = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];

function round2(v: number) { return Math.round(v * 100) / 100; }

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

export function invert(m: number[]) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1e-12;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** layer local matrix (parent space <- local box) at time t */
export function localMatrix(l: Layer, t: number) {
  const a = valueAt(l, 'anchor', t), p = valueAt(l, 'position', t), s = valueAt(l, 'scale', t), r = valueAt(l, 'rotation', t)[0] * Math.PI / 180;
  const cs = Math.cos(r), sn = Math.sin(r);
  const A = cs * s[0] / 100, B = sn * s[0] / 100, C = -sn * s[1] / 100, D = cs * s[1] / 100;
  return [A, B, C, D, p[0] - (A * a[0] + C * a[1]), p[1] - (B * a[0] + D * a[1])];
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

function topAncestor(st: Editor['store'], id: string) {
  let cur = id;
  while (st.layer(cur)?.parent) cur = st.layer(cur)!.parent!;
  return cur;
}

// property setter that respects "animated => keyframe at current time"
function setTx(tx: Tx, l: Layer, key: 'size' | 'anchor' | 'position' | 'rotation', v: number[]) {
  setPropTx(tx, l, key, v, (globalThis as any).editor.store.time);
}
