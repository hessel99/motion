// canvas timeline: layer list (left) + time tracks with keyframes (right).
// fully virtualized (only visible rows are drawn). the rows are drawn straight into the visible
// canvas only when something changed; the playhead lives on its own overlay canvas, so during
// playback a frame only clears and redraws the playhead strip (no full-canvas copy).
// rows are rebuilt lazily (once per frame at most) and incrementally: edits that don't change
// the row structure (key drags, value edits) don't walk the layer tree at all.

import type { Editor } from '../app/editor';
import {
  isAnimated, keyId, layerKeyTimes, moveKeyframes, moveLayers, parseKeyId, renameLayer, setLayerField, valueAt,
  addKeyframe, deleteKeyframes, toggleAnimated, precompose, snapshotKeys, moveKeysFrom, type KeySnapshot,
} from '../core/commands';
import { PROP_DEFS, TYPE_PROPS, TRANSFORM_KEYS, type Keyframe, type Layer, type LayerType, type PropKey } from '../core/model';
import { showContextMenu, type MenuItem } from './menu';
import { createComponent, createInstance, detachInstance, instanceRootOf, overridesOf, resetOverrides } from '../core/components';
import { GraphView } from './graph';
import { T, onThemeChange } from './theme';
import { audioDuration, audioFailed, audioPeaks } from '../audio/engine';
import { EASE_PRESETS, SPRING_PRESETS } from '../core/easing';
import { setEase, setInterp, setSpring, updateMarker, deleteMarker, cloneLayers, deleteLayers } from '../core/commands';

const HEADER_H = 28;
const ROW_H = 24;
const INDENT = 14;

/** prop rows a layer type can show, in row order (built once per type, not per layer per rebuild) */
const ROW_KEYS = new Map<LayerType, PropKey[]>();
function rowKeys(type: LayerType) {
  let k = ROW_KEYS.get(type);
  if (!k) ROW_KEYS.set(type, (k = [...TRANSFORM_KEYS, ...TYPE_PROPS[type]]));
  return k;
}
/** which prop rows an expanded layer shows, as a bit mask over rowKeys(type) */
function propRowMask(l: Layer) {
  const keys = rowKeys(l.type);
  let m = 0;
  for (let i = 0; i < keys.length; i++) { const p = l.props[keys[i]]; if (p && (p.kf?.length || p.expr)) m |= 1 << i; }
  return m;
}
function hasAnim(l: Layer) {
  for (const k in l.props) { const p = l.props[k as PropKey]; if (p && (p.kf?.length || p.expr)) return true; }
  return false;
}
/** lower-cased name / text per layer, reused across keystrokes while they don't change */
const lowered = new WeakMap<Layer, { n: string; t: string | undefined; ln: string; lt: string }>();
function matchesFilter(l: Layer, f: string) {
  const t = l.text?.content;
  let c = lowered.get(l);
  if (!c || c.n !== l.name || c.t !== t) lowered.set(l, (c = { n: l.name, t, ln: l.name.toLowerCase(), lt: t ? t.toLowerCase() : '' }));
  return c.ln.includes(f) || (t !== undefined && c.lt.includes(f));
}
function anyIn(ids: string[], set: Set<string>) {
  for (const id of ids) if (set.has(id)) return true;
  return false;
}
/** first index with kf[i].t >= t (keys are sorted by time) */
function lowerBound(kf: Keyframe[], t: number) {
  let lo = 0, hi = kf.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (kf[m].t < t) lo = m + 1; else hi = m; }
  return lo;
}

interface Row {
  kind: 'layer' | 'prop';
  id: string;
  layer: Layer;
  depth: number;
  prop: PropKey | undefined;
  hasChildren: boolean;
  /** layer rows: the prop rows shown under it as a propRowMask (-1: collapsed / prop row) */
  mask: number;
}

type Drag =
  | { kind: 'scrub' }
  | { kind: 'keys'; sx: number; t0: number; moved: boolean; dt: number; key: string; snap: KeySnapshot }
  | { kind: 'marquee'; sx: number; sy: number; x: number; y: number; base: Set<string>; seg?: string[]; shift?: boolean }
  | { kind: 'rows'; ids: string[]; sy: number; y: number; moved: boolean }
  | { kind: 'split'; sx: number; w0: number }
  | { kind: 'graph' }
  | { kind: 'vscroll'; sy: number; s0: number }
  | { kind: 'hscroll'; sx: number; s0: number }
  | { kind: 'compEnd' }
  | { kind: 'marker'; id: string; sx: number; moved: boolean }
  | { kind: 'bar'; id: string; sx: number; in0: number; out0: number; mode: 'in' | 'out' }
  | { kind: 'shift'; sx: number; moved: boolean; orig: Map<string, { inP: number; outP: number; start: number; kf: Partial<Record<PropKey, Keyframe[]>> }> };

export class Timeline {
  canvas: HTMLCanvasElement;
  /** the rows / ruler (redrawn only when baseDirty) */
  g: CanvasRenderingContext2D;
  /** transparent playhead layer stacked over `canvas` (no pointer events) */
  over: HTMLCanvasElement;
  og: CanvasRenderingContext2D;
  w = 0; h = 0; dpr = 1;
  leftW = 300;
  pxPerSec = 120;
  scrollT = 0;
  scrollY = 0;
  rows: Row[] = [];
  expanded = new Set<string>();
  private rowsDirty = true;
  private baseDirty = true;
  private drag: Drag | null = null;
  private lastPlayheadX = -1;
  /** last drawn playhead strip on the overlay (null: nothing drawn) */
  private playheadDrawn: number | null = null;
  /** incremental rows: direct search matches of the last build */
  private matched = new Set<string>();
  /** search results per filter string, dropped on any document change */
  private matchCache = new Map<string, Set<string>>();
  /** layer id -> index of its layer row (built lazily, for reveal) */
  private rowIndex: Map<string, number> | null = null;
  /** collapsed-row key summary per layer (dropped when the layer changes) */
  private keyTimesCache = new Map<string, number[]>();
  private hoverRow = -1;
  private input: HTMLInputElement | null = null;
  private autoFit = true;
  graphMode = false;
  private graph: GraphView;
  /** layer name filter (search box in the header) */
  filter = '';

  constructor(private ed: Editor, private host: HTMLElement) {
    this.graph = new GraphView(ed.store);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'tl-canvas';
    host.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    this.over = document.createElement('canvas');
    this.over.className = 'tl-overlay';
    host.appendChild(this.over);
    this.og = this.over.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const st = ed.store;
    let lastDur = st.comp.duration;
    st.onChange(c => {
      if ((c.structure || c.comp || c.layers.size) && this.matchCache.size) this.matchCache.clear();
      // visibility / clip / start time recompile the renderer but keep the row list: per-layer path
      if (c.comp || (c.structure && !c.sameTree)) { this.rowsDirty = true; this.keyTimesCache.clear(); return; }
      for (const id of c.layers) this.keyTimesCache.delete(id);
      if (!this.rowsDirty) this.rowsDirty = this.rowsChanged(c.layers);
    });
    st.on('doc', () => {
      this.baseDirty = true;
      if (st.comp.duration !== lastDur) { lastDur = st.comp.duration; if (this.drag?.kind !== 'compEnd') this.fitTime(); }
    });
    st.on('selection', () => { this.baseDirty = true; });
    st.on('workarea', () => { this.baseDirty = true; });
    st.on('keys', () => { this.baseDirty = true; });
    st.on('time', () => { if (!st.playing) this.baseDirty = true; });
    st.on('comps', () => { this.expanded.clear(); this.scrollY = 0; this.fitTime(); this.rowsDirty = true; this.baseDirty = true; });
    ed.on('loaded', () => {
      lastDur = st.comp.duration; this.expanded.clear(); this.scrollY = 0; this.autoFit = true; this.rowsDirty = true; this.baseDirty = true; this.resize(); });
    ed.onFrame(() => this.frame());
    ed.on('audio', () => { this.baseDirty = true; });
    onThemeChange(() => { this.baseDirty = true; this.lastPlayheadX = -1; });
    this.canvas.addEventListener('pointerdown', e => this.down(e));
    this.canvas.addEventListener('pointermove', e => this.move(e));
    this.canvas.addEventListener('pointerup', e => this.up(e));
    this.canvas.addEventListener('pointercancel', e => this.up(e));
    this.canvas.addEventListener('dblclick', e => this.dbl(e));
    this.canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', e => this.context(e));
    this.canvas.addEventListener('pointerleave', () => { this.hoverRow = -1; this.baseDirty = true; });
    const search = document.createElement('input');
    search.className = 'tl-search';
    search.placeholder = 'Search layers';
    search.addEventListener('input', () => { this.filter = search.value.trim().toLowerCase(); this.scrollY = 0; this.rowsDirty = true; this.baseDirty = true; });
    search.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') { search.value = ''; this.filter = ''; this.rowsDirty = true; search.blur(); } });
    host.appendChild(search);
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    for (const c of [this.canvas, this.over]) {
      c.width = Math.max(1, Math.round(r.width * this.dpr));
      c.height = Math.max(1, Math.round(r.height * this.dpr));
      c.style.width = r.width + 'px';
      c.style.height = r.height + 'px';
    }
    this.playheadDrawn = null; this.lastPlayheadX = -1;
    if (this.autoFit && r.width > 0) { this.fitTime(); this.autoFit = false; }
    this.baseDirty = true;
  }

  fitTime() {
    const dur = this.ed.store.comp.duration;
    const avail = Math.max(100, this.w - this.leftW - 30);
    this.pxPerSec = avail / dur;
    this.scrollT = 0;
    this.baseDirty = true;
  }

  // ---------- geometry ----------
  tToX(t: number) { return this.leftW + 12 + (t - this.scrollT) * this.pxPerSec; }
  xToT(x: number) { return (x - this.leftW - 12) / this.pxPerSec + this.scrollT; }
  rowAtY(y: number) {
    if (y < HEADER_H) return -1;
    const i = Math.floor((y - HEADER_H + this.scrollY) / ROW_H);
    return i >= 0 && i < this.rows.length ? i : -1;
  }
  rowY(i: number) { return HEADER_H + i * ROW_H - this.scrollY; }

  private buildRows() {
    const st = this.ed.store;
    const L = st.project.layers;
    const rows: Row[] = [];
    // search: keep matching layers + their ancestors (shown expanded)
    const f = this.filter;
    let keep: Set<string> | null = null;
    if (f) {
      const k = (keep = new Set<string>());
      // match sets per filter string, valid while the document doesn't change: backspace reuses an
      // earlier result, and typing more characters only rescans the matches of a shorter filter
      const cache = this.matchCache;
      let matched = cache.get(f);
      if (!matched) {
        let base: Set<string> | undefined, baseLen = -1;
        for (const [q, set] of cache) if (q.length > baseLen && f.includes(q)) { base = set; baseLen = q.length; }
        matched = new Set<string>();
        if (base) { for (const id of base) { const l = L[id]; if (l && matchesFilter(l, f)) matched.add(id); } }
        else for (const id in L) if (matchesFilter(L[id], f)) matched.add(id);
        if (cache.size >= 64) cache.delete(cache.keys().next().value!);
        cache.set(f, matched);
      }
      for (const id of matched) {
        let cur: string | null = id;
        while (cur && !k.has(cur)) { k.add(cur); cur = L[cur]?.parent ?? null; }
      }
      this.matched = matched;
    }
    const expanded = this.expanded;
    // all rows share one object shape (monomorphic access in the draw / hit-test loops)
    const walk = (ids: string[], depth: number) => {
      // list order: top-most first (reverse draw order)
      for (let i = ids.length - 1; i >= 0; i--) {
        const l = L[ids[i]];
        if (!l) continue;
        if (keep && !keep.has(l.id)) continue;
        const row: Row = { kind: 'layer', id: l.id, layer: l, depth, prop: undefined, hasChildren: l.children.length > 0, mask: -1 };
        rows.push(row);
        if (expanded.has(l.id) || (keep && anyIn(l.children, keep))) {
          const keys = rowKeys(l.type);
          let m = 0;
          for (let k = 0; k < keys.length; k++) {
            const p = l.props[keys[k]];
            if (p && (p.kf?.length || p.expr)) { m |= 1 << k; rows.push({ kind: 'prop', id: l.id, layer: l, depth: depth + 1, prop: keys[k], hasChildren: false, mask: -1 }); }
          }
          row.mask = m;
          walk(l.children, depth + 1);
        }
      }
    };
    walk(st.comp.root, 0);
    this.rows = rows;
    this.rowIndex = null;
    this.rowsDirty = false;
    this.clampScroll();
  }

  /** after a non-structural edit of `ids`: could the row list differ? (prop rows of open layers
   *  appear/disappear, or a search match changes). O(changed layers), no tree walk */
  private rowsChanged(ids: Set<string>) {
    const L = this.ed.store.project.layers;
    const f = this.filter;
    for (const id of ids) {
      const l = L[id];
      if (!l) return true;
      const i = this.layerRowIndex(id);
      if (i >= 0 && this.rows[i].mask >= 0 && this.rows[i].mask !== propRowMask(l)) return true;
      if (f && matchesFilter(l, f) !== this.matched.has(id)) return true;
    }
    return false;
  }

  /** index of a layer's row (-1 when not listed) */
  private layerRowIndex(id: string) {
    if (!this.rowIndex) {
      this.rowIndex = new Map();
      for (let i = 0; i < this.rows.length; i++) if (this.rows[i].kind === 'layer') this.rowIndex.set(this.rows[i].id, i);
    }
    return this.rowIndex.get(id) ?? -1;
  }

  private clampScroll() {
    const max = Math.max(0, this.rows.length * ROW_H - (this.h - HEADER_H) + ROW_H);
    this.scrollY = Math.max(0, Math.min(max, this.scrollY));
  }

  /** expand a layer (and its ancestors) and scroll it into view */
  reveal(id: string) {
    const st = this.ed.store;
    let p = st.layer(id)?.parent;
    while (p) { if (!this.expanded.has(p)) { this.expanded.add(p); this.rowsDirty = true; } p = st.layer(p)?.parent; }
    // rows only change when an ancestor had to be expanded (or an edit is pending)
    if (this.rowsDirty) this.buildRows();
    const i = this.layerRowIndex(id);
    if (i >= 0) {
      const y = i * ROW_H;
      if (y < this.scrollY) this.scrollY = y;
      else if (y + ROW_H > this.scrollY + this.h - HEADER_H) this.scrollY = y + ROW_H - (this.h - HEADER_H);
    }
    this.baseDirty = true;
  }

  expand(id: string, on = true) {
    if (on === this.expanded.has(id)) return;
    if (on) this.expanded.add(id); else this.expanded.delete(id);
    this.rowsDirty = true;
    this.baseDirty = true;
  }

  // ---------- drawing ----------
  private frame() {
    if (this.rowsDirty) { this.buildRows(); this.baseDirty = true; }
    if (this.baseDirty) { this.drawBase(); this.baseDirty = false; }
    const px = Math.round(this.tToX(this.ed.store.time));
    if (px === this.lastPlayheadX) return;
    this.lastPlayheadX = px;
    // overlay: clear only the previous playhead strip, then draw the new one
    const g = this.og;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.playheadDrawn !== null) { g.clearRect(this.playheadDrawn - 8, 0, 16, this.h); this.playheadDrawn = null; }
    if (px >= this.leftW) { this.drawPlayhead(px); this.playheadDrawn = px; }
  }

  private drawPlayhead(x: number) {
    const g = this.og;
    g.fillStyle = T.tlPlayhead;
    g.fillRect(x - 0.5, HEADER_H - 6, 1, this.h);
    g.beginPath();
    g.moveTo(x - 6, 4); g.lineTo(x + 6, 4); g.lineTo(x + 6, HEADER_H - 10); g.lineTo(x, HEADER_H - 4); g.lineTo(x - 6, HEADER_H - 10);
    g.closePath();
    g.fill();
  }

  private drawBase() {
    const g = this.g;
    const st = this.ed.store;
    const comp = st.comp;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = T.tlBg;
    g.fillRect(0, 0, this.w, this.h);
    g.font = T.font.ui;
    g.textBaseline = 'middle';
    const sel = new Set(st.selection);
    const first = Math.max(0, Math.floor(this.scrollY / ROW_H));
    const last = Math.min(this.rows.length, first + Math.ceil((this.h - HEADER_H) / ROW_H) + 1);
    const x0 = this.leftW;
    const tEnd = this.tToX(comp.duration);

    // track background past comp end
    g.fillStyle = T.tlBgOutside;
    g.fillRect(Math.max(x0, tEnd), HEADER_H, this.w, this.h);

    // rows
    g.save();
    g.beginPath();
    g.rect(0, HEADER_H, this.w, this.h - HEADER_H);
    g.clip();
    for (let i = first; i < last; i++) {
      const r = this.rows[i];
      const y = this.rowY(i);
      const isSel = sel.has(r.id) && r.kind === 'layer';
      if (isSel) { g.fillStyle = T.tlRowSelected; g.fillRect(0, y, this.w, ROW_H); }
      else if (i === this.hoverRow) { g.fillStyle = T.tlRowHover; g.fillRect(0, y, this.w, ROW_H); }
      g.fillStyle = T.tlRowLine;
      g.fillRect(0, y + ROW_H - 1, this.w, 1);
      if (r.kind === 'layer') this.drawLayerRow(g, r, y, isSel);
      else this.drawPropRow(g, r, y);
    }
    g.restore();

    if (this.graphMode) {
      this.graph.draw(g, { x0: x0, y0: HEADER_H, x1: this.w, y1: this.h, tToX: t => this.tToX(t), xToT: x => this.xToT(x) });
    }

    // left/right divider
    g.fillStyle = T.tlDivider;
    g.fillRect(x0 - 1, 0, 1, this.h);

    // ruler
    g.fillStyle = T.tlRulerBg;
    g.fillRect(0, 0, this.w, HEADER_H);
    g.fillStyle = T.tlDivider;
    g.fillRect(0, HEADER_H - 1, this.w, 1);
    this.drawRuler(g);
    g.fillStyle = T.tlTabText;
    g.font = T.font.uiSm;
    // (layer count lives in the search box placeholder area)
    // keys / graph / speed toggle
    const tx0 = this.leftW - 150;
    for (const [i, label] of ['Keys', 'Graph', 'Speed'].entries()) {
      const mode = !this.graphMode ? 0 : this.graph.speed ? 2 : 1;
      const on = i === mode;
      const bx = tx0 + i * 48;
      g.fillStyle = on ? T.tlTabOn : T.tlTab;
      g.beginPath(); g.roundRect(bx, 5, 44, HEADER_H - 10, 4); g.fill();
      g.fillStyle = on ? T.tlTabOnText : T.tlTabText;
      g.fillText(label, bx + 22 - g.measureText(label).width / 2, HEADER_H / 2);
    }

    // scrollbars
    const vs = this.vScroll(), hs = this.hScroll();
    g.fillStyle = T.tlScrollbar;
    if (vs) { g.beginPath(); g.roundRect(this.w - 7, vs.y, 5, vs.h, 2.5); g.fill(); }
    if (hs) { g.beginPath(); g.roundRect(hs.x, this.h - 7, hs.w, 5, 2.5); g.fill(); }

    // drag feedback
    const d = this.drag;
    if (d?.kind === 'marquee') {
      g.fillStyle = T.tlMarqueeFill;
      g.strokeStyle = T.tlMarqueeStroke;
      const x = Math.min(d.sx, d.x), y = Math.min(d.sy, d.y);
      g.fillRect(x, y, Math.abs(d.x - d.sx), Math.abs(d.y - d.sy));
      g.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x - d.sx), Math.abs(d.y - d.sy));
    }
    if (d?.kind === 'rows' && d.moved) {
      const tgt = this.dropTarget(d.y);
      if (tgt) {
        g.fillStyle = T.tlDrop;
        if (tgt.into) { g.globalAlpha = 0.25; g.fillRect(0, tgt.lineY, this.leftW, ROW_H); g.globalAlpha = 1; }
        else g.fillRect(8 + tgt.depth * INDENT, tgt.lineY - 1, this.leftW - 8 - tgt.depth * INDENT, 2);
      }
    }
  }

  private drawRuler(g: CanvasRenderingContext2D) {
    const comp = this.ed.store.comp;
    const fps = comp.fps;
    const pxPerFrame = this.pxPerSec / fps;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3000];
    let stepF = steps.find(s => s * pxPerFrame >= 70) ?? 6000;
    if (stepF > fps && stepF % fps) stepF = Math.ceil(stepF / fps) * fps;
    const tStart = Math.max(0, this.xToT(this.leftW));
    const tStop = Math.min(comp.duration, this.xToT(this.w));
    const fStart = Math.floor(tStart * fps / stepF) * stepF;
    g.font = T.font.uiXs;
    g.textBaseline = 'middle';
    for (let f = fStart; f <= tStop * fps + 1e-6; f += stepF) {
      const x = Math.round(this.tToX(f / fps)) + 0.5;
      if (x < this.leftW) continue;
      g.fillStyle = T.tlTick;
      g.fillRect(x, HEADER_H - 8, 1, 8);
      g.fillStyle = T.tlGrid;
      g.fillRect(x, HEADER_H, 1, this.h);
      g.fillStyle = T.tlRulerText;
      g.fillText(fmtTime(f / fps, fps), x + 3, HEADER_H / 2 - 1);
      // minor ticks
      const minor = stepF >= 5 ? stepF / 5 : 0;
      if (minor >= 1) for (let m = 1; m < 5; m++) {
        const mx = Math.round(this.tToX((f + m * minor) / fps)) + 0.5;
        g.fillStyle = T.tlTickMinor;
        g.fillRect(mx, HEADER_H - 4, 1, 4);
      }
    }
    // work area (preview range)
    const wa = this.ed.store.workArea;
    if (wa) {
      const ax = Math.max(this.leftW, this.tToX(wa[0])), bx = Math.min(this.w, this.tToX(wa[1]));
      if (bx > ax) {
        g.fillStyle = T.tlWorkArea;
        g.fillRect(ax, HEADER_H - 5, bx - ax, 4);
        g.fillStyle = T.tlWorkAreaDim;
        g.fillRect(this.leftW, HEADER_H, Math.max(0, ax - this.leftW), this.h);
        g.fillRect(bx, HEADER_H, Math.max(0, this.w - bx), this.h);
      }
    }
    // markers: a small flag in the ruler, a faint line through the rows, label next to it
    for (const m of comp.markers ?? []) {
      const mx = Math.round(this.tToX(m.t)) + 0.5;
      if (mx < this.leftW - 2 || mx > this.w + 2) continue;
      g.fillStyle = T.tlMarkerLine;
      g.fillRect(mx - 0.5, HEADER_H, 1, this.h);
      g.fillStyle = T.tlMarker;
      g.beginPath(); g.moveTo(mx - 4, HEADER_H - 13); g.lineTo(mx + 4, HEADER_H - 13); g.lineTo(mx + 4, HEADER_H - 6); g.lineTo(mx, HEADER_H - 2); g.lineTo(mx - 4, HEADER_H - 6); g.closePath(); g.fill();
      if (m.label) { g.font = T.font.uiXs; g.fillText(m.label, mx + 6, HEADER_H - 7); }
    }
    const endX = this.tToX(comp.duration);
    if (endX > this.leftW && endX < this.w) {
      g.fillStyle = T.tlCompEnd;
      g.fillRect(endX, 0, 1, HEADER_H);
    }
  }

  private drawLayerRow(g: CanvasRenderingContext2D, r: Row, y: number, isSel: boolean) {
    const l = r.layer;
    const st = this.ed.store;
    const cy = y + ROW_H / 2;
    const ix = 8 + r.depth * INDENT;
    const animated = hasAnim(l);
    // twirl
    if (r.hasChildren || animated) {
      g.fillStyle = T.tlTwirl;
      g.beginPath();
      if (this.expanded.has(l.id)) { g.moveTo(ix, cy - 2); g.lineTo(ix + 8, cy - 2); g.lineTo(ix + 4, cy + 3); }
      else { g.moveTo(ix + 2, cy - 4); g.lineTo(ix + 7, cy); g.lineTo(ix + 2, cy + 4); }
      g.closePath();
      g.fill();
    }
    // type icon
    const tx = ix + 14;
    g.strokeStyle = l.visible ? T.tlIcon : T.tlIconOff;
    g.fillStyle = g.strokeStyle;
    g.lineWidth = 1.2;
    drawTypeIcon(g, l.type, tx, cy);
    // component badge: filled diamond = main component, hollow = instance
    const comps = st.project.components;
    if (comps && (comps[l.id] || (l.link && comps[l.link.main]))) {
      const bx = tx + 8, by = cy + 4;
      g.beginPath(); g.moveTo(bx, by - 3.5); g.lineTo(bx + 3.5, by); g.lineTo(bx, by + 3.5); g.lineTo(bx - 3.5, by); g.closePath();
      g.fillStyle = T.tlBg; g.fill();
      g.strokeStyle = T.tlComponent; g.lineWidth = 1.2;
      if (comps[l.id]) { g.fillStyle = T.tlComponent; g.fill(); } else g.stroke();
    }
    // name
    g.fillStyle = !l.visible ? T.tlLayerNameHidden : isSel ? T.tlLayerNameSelected : T.tlLayerName;
    g.font = T.font.ui;
    const nameX = tx + 16;
    const maxW = this.leftW - nameX - 70;
    g.fillText(ellipsize(g, l.name, maxW), nameX, cy);
    // solo + eye + lock
    const soloed = st.solo.has(l.id);
    g.fillStyle = soloed ? T.tlSolo : T.tlControlOff;
    g.beginPath(); g.arc(this.leftW - 58, cy, soloed ? 4 : 3, 0, Math.PI * 2); g.fill();
    g.fillStyle = l.visible ? T.tlControl : T.tlControlOff;
    drawEye(g, this.leftW - 40, cy, l.visible);
    g.fillStyle = l.locked ? T.tlControlOn : T.tlControlOff;
    drawLock(g, this.leftW - 20, cy);

    // track: layer bar
    const comp = st.comp;
    const inX = Math.max(this.leftW, this.tToX(Math.max(0, l.inPoint)));
    const outX = Math.min(this.w, this.tToX(Math.min(comp.duration, l.outPoint)));
    if (outX > inX) {
      g.fillStyle = isSel ? T.tlBarSelected : T.tlBar;
      g.beginPath();
      g.roundRect(inX, y + 4, outX - inX, ROW_H - 8, 3);
      g.fill();
    }
    // audio waveform
    if (l.type === 'audio' && l.imageRef) {
      const asset = st.project.assets[l.imageRef];
      const peaks = asset ? audioPeaks(asset) : null;
      const dur = asset ? audioDuration(asset) : null;
      if (peaks && dur) {
        const start = l.startTime ?? 0;
        const x0 = this.tToX(start), x1 = this.tToX(start + dur);
        g.fillStyle = isSel ? T.tlAudioSelected : T.tlAudio;
        const h = (ROW_H - 8) / 2;
        for (let x = Math.max(this.leftW, Math.floor(x0)); x < Math.min(this.w, x1); x += 2) {
          const p = peaks[Math.min(peaks.length - 1, Math.floor(((x - x0) / (x1 - x0)) * peaks.length))];
          const ph = Math.max(0.5, p * h);
          g.fillRect(x, cy - ph, 1.5, ph * 2);
        }
      } else { g.fillStyle = T.tlHint; g.font = T.font.uiXs; g.fillText(asset && audioFailed(asset) ? 'audio could not be decoded' : 'decoding audio…', Math.max(this.leftW + 6, this.tToX(l.startTime ?? 0)), cy); }
    }
    // text animation range (per-unit reveal) as a bar
    if (l.textAnim && l.text) {
      const ta = l.textAnim;
      const units = ta.by === 'char' ? [...l.text.content].filter(c => c.trim()).length : ta.by === 'word' ? l.text.content.split(/\s+/).filter(Boolean).length : l.text.content.split('\n').length;
      const t0 = l.inPoint + ta.start;
      const t1 = t0 + ta.duration + ta.stagger * Math.max(0, units - 1);
      const x0 = Math.max(this.leftW, this.tToX(t0)), x1 = Math.min(this.w, this.tToX(t1));
      if (x1 > x0) {
        g.fillStyle = T.tlTextAnim;
        g.beginPath(); g.roundRect(x0, y + 7, x1 - x0, ROW_H - 14, 3); g.fill();
        g.fillStyle = T.tlTextAnimLabel;
        g.font = T.font.uiXs;
        if (x1 - x0 > 60) g.fillText(`text ${ta.by}`, x0 + 5, cy);
      }
    }
    // keyframe summary (collapsed) — union of key times
    if (!this.expanded.has(l.id) && animated) {
      let times = this.keyTimesCache.get(l.id);
      if (!times) this.keyTimesCache.set(l.id, (times = layerKeyTimes(l)));
      g.fillStyle = isSel ? T.tlKeySummarySelected : T.tlKeySummary;
      let lastX = -10;
      // only the keys inside the visible time range (times are sorted)
      const tMax = this.xToT(this.w);
      let j0 = 0, hi = times.length;
      const tMin = this.xToT(this.leftW);
      while (j0 < hi) { const m = (j0 + hi) >> 1; if (times[m] < tMin) j0 = m + 1; else hi = m; }
      for (let j = j0; j < times.length; j++) {
        const t = times[j];
        if (t > tMax) break;
        const x = this.tToX(t);
        if (x < this.leftW || x > this.w || x - lastX < 2) continue;
        lastX = x;
        diamond(g, x, cy, 3.5);
        g.fill();
      }
    }
  }

  private drawPropRow(g: CanvasRenderingContext2D, r: Row, y: number) {
    const l = r.layer, key = r.prop!;
    const st = this.ed.store;
    const cy = y + ROW_H / 2;
    const ix = 8 + r.depth * INDENT;
    // keyframe nav: ◆ at current time indicator
    const kf = l.props[key]?.kf ?? [];
    const atKey = kf.some(k => Math.abs(k.t - st.time) < 1e-6);
    g.fillStyle = atKey ? T.tlKeySelected : T.tlKeyOff;
    diamond(g, ix + 18, cy, 4);
    atKey ? g.fill() : (g.strokeStyle = T.tlKeyOffStroke, g.stroke());
    g.fillStyle = T.tlPropName;
    g.font = T.font.ui;
    g.fillText(PROP_DEFS[key].label + (l.props[key]?.expr ? '  =' : ''), ix + 30, cy);
    // current value
    const v = valueAt(l, key, st.time);
    g.fillStyle = T.tlValue;
    g.font = T.font.monoSm;
    const txt = fmtValue(key, v);
    const tw = g.measureText(txt).width;
    g.fillText(txt, this.leftW - 12 - tw, cy);
    // keyframes: only the visible time range (keys are sorted by time)
    for (let i = lowerBound(kf, this.xToT(this.leftW - 6) - 1e-9); i < kf.length; i++) {
      const x = this.tToX(kf[i].t);
      if (x > this.w + 6) break;
      if (x < this.leftW - 6) continue;
      const selected = st.keySelection.has(keyId(l.id, key, i));
      // segment line between keys when interpolated
      if (i < kf.length - 1 && kf[i].interp !== 'hold') {
        const x2 = this.tToX(kf[i + 1].t);
        const segSel = selected && st.keySelection.has(keyId(l.id, key, i + 1));
        g.fillStyle = segSel ? T.tlSegmentSelected : kf[i].interp === 'spring' ? T.tlSegmentSpring : T.tlSegment;
        g.fillRect(Math.max(this.leftW, x), cy - (segSel ? 1 : 0.5), Math.max(0, Math.min(this.w, x2) - Math.max(this.leftW, x)), segSel ? 2 : 1);
      }
      g.fillStyle = selected ? T.tlKeySelected : T.tlKey;
      g.strokeStyle = selected ? T.tlKeySelectedStroke : T.tlKeyStroke;
      g.lineWidth = 1;
      if (kf[i].interp === 'hold') { g.beginPath(); g.rect(x - 4, cy - 4, 8, 8); }
      else if (kf[i].interp === 'linear') diamond(g, x, cy, 5);
      else if (kf[i].interp === 'spring') { g.beginPath(); g.arc(x, cy, 4.5, 0, Math.PI * 2); }
      else easeShape(g, x, cy, 5);
      g.fill();
      g.stroke();
    }
  }

  /** vertical scrollbar thumb (null when everything fits) */
  private vScroll() {
    const total = this.rows.length * ROW_H + ROW_H, view = this.h - HEADER_H;
    if (total <= view) return null;
    const h = Math.max(24, view * (view / total));
    return { y: HEADER_H + (view - h) * (this.scrollY / (total - view)), h, total, view };
  }
  /** horizontal scrollbar thumb over the composition duration */
  private hScroll() {
    const dur = this.ed.store.comp.duration;
    const span = this.w - this.leftW;
    const visible = span / this.pxPerSec;
    if (visible >= dur && this.scrollT <= 0) return null;
    const total = Math.max(dur, this.scrollT + visible);
    const w = Math.max(30, span * (visible / total));
    return { x: this.leftW + (span - w) * (this.scrollT / Math.max(1e-6, total - visible)), w, total, visible };
  }

  // ---------- hit testing ----------
  private keyAt(x: number, y: number): string | null {
    const i = this.rowAtY(y);
    if (i < 0) return null;
    const r = this.rows[i];
    if (r.kind === 'prop') {
      const kf = r.layer.props[r.prop!]?.kf ?? [];
      for (let k = kf.length - 1; k >= 0; k--) if (Math.abs(this.tToX(kf[k].t) - x) <= 6) return keyId(r.id, r.prop!, k);
    }
    return null;
  }

  /** click on the line between two keyframes (figma motion style): returns both keys */
  private segmentAt(x: number, y: number): string[] {
    const i = this.rowAtY(y);
    if (i < 0) return [];
    const r = this.rows[i];
    if (r.kind !== 'prop') return [];
    const cy = this.rowY(i) + ROW_H / 2;
    if (Math.abs(y - cy) > 5) return [];
    const kf = r.layer.props[r.prop!]?.kf ?? [];
    const t = this.xToT(x);
    for (let k = 0; k < kf.length - 1; k++) if (kf[k].t < t && t < kf[k + 1].t && kf[k].interp !== 'hold') return [keyId(r.id, r.prop!, k), keyId(r.id, r.prop!, k + 1)];
    return [];
  }

  /** collapsed-layer summary diamonds: returns all keys of that layer at the hit time */
  private summaryKeysAt(x: number, y: number): string[] {
    const i = this.rowAtY(y);
    if (i < 0) return [];
    const r = this.rows[i];
    if (r.kind !== 'layer' || this.expanded.has(r.id)) return [];
    const out: string[] = [];
    for (const k in r.layer.props) {
      const kf = r.layer.props[k as PropKey]?.kf ?? [];
      kf.forEach((f, j) => { if (Math.abs(this.tToX(f.t) - x) <= 5) out.push(keyId(r.id, k as PropKey, j)); });
    }
    return out;
  }

  private local(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private down(e: PointerEvent) {
    if (e.button !== 0) return;
    const [x, y] = this.local(e);
    const st = this.ed.store;
    this.canvas.setPointerCapture(e.pointerId);
    if (Math.abs(x - this.leftW) < 4) { this.drag = { kind: 'split', sx: x, w0: this.leftW }; return; }
    const vs = this.vScroll();
    if (vs && x > this.w - 10 && y > HEADER_H) {
      if (y < vs.y || y > vs.y + vs.h) { this.scrollY = ((y - HEADER_H - vs.h / 2) / (vs.view - vs.h)) * (vs.total - vs.view); this.clampScroll(); this.baseDirty = true; }
      this.drag = { kind: 'vscroll', sy: y, s0: this.scrollY };
      return;
    }
    const hs = this.hScroll();
    if (hs && y > this.h - 10 && x > this.leftW) { this.drag = { kind: 'hscroll', sx: x, s0: this.scrollT }; return; }
    if (y < HEADER_H && Math.abs(x - this.tToX(st.comp.duration)) < 5) { this.drag = { kind: 'compEnd' }; st.beginGesture('duration'); return; }
    const mk = this.markerAt(x, y);
    if (mk) { this.drag = { kind: 'marker', id: mk.id, sx: x, moved: false }; st.beginGesture('marker'); return; }
    if (y < HEADER_H && x < this.leftW && x >= this.leftW - 150 && x < this.leftW - 6) {
      const i = Math.floor((x - (this.leftW - 150)) / 48);
      this.graphMode = i >= 1;
      this.graph.speed = i === 2;
      this.baseDirty = true;
      return;
    }
    if (this.graphMode && x > this.leftW && y > HEADER_H) {
      if (this.graph.down(x, y, e.shiftKey)) { this.drag = { kind: 'graph' }; this.baseDirty = true; }
      else if (!e.shiftKey) { st.keySelection = new Set(); st.emit('keys'); }
      return;
    }
    if (y < HEADER_H && x > this.leftW) {
      this.drag = { kind: 'scrub' };
      this.scrubTo(x, e.shiftKey);
      return;
    }
    const i = this.rowAtY(y);
    if (x < this.leftW) {
      if (i < 0) { st.select([]); return; }
      const r = this.rows[i];
      const ix = 8 + r.depth * INDENT;
      if (r.kind === 'layer') {
        if (x >= ix - 2 && x <= ix + 10) { this.expand(r.id, !this.expanded.has(r.id)); return; }
        if (x >= this.leftW - 66 && x < this.leftW - 50) { st.toggleSolo(r.id); this.baseDirty = true; return; }
        if (x >= this.leftW - 48 && x < this.leftW - 30) { setLayerField(st, [r.id], 'visible', !r.layer.visible, 'Toggle visibility'); return; }
        if (x >= this.leftW - 28) { setLayerField(st, [r.id], 'locked', !r.layer.locked, 'Toggle lock'); return; }
        if (e.shiftKey && st.selection.length) {
          // range select within visible layer rows
          const layerRows = this.rows.filter(rr => rr.kind === 'layer');
          const a = layerRows.findIndex(rr => rr.id === st.selection[st.selection.length - 1]);
          const b = layerRows.findIndex(rr => rr.id === r.id);
          if (a >= 0 && b >= 0) { st.select(layerRows.slice(Math.min(a, b), Math.max(a, b) + 1).map(rr => rr.id)); return; }
        }
        if (e.metaKey || e.ctrlKey) st.select([r.id], 'toggle');
        else if (!st.selection.includes(r.id)) st.select([r.id]);
        this.drag = { kind: 'rows', ids: st.selection.slice(), sy: y, y, moved: false };
      } else {
        // prop row: diamond toggles key at current time, else select layer
        if (x >= ix + 10 && x <= ix + 26) {
          const kf = r.layer.props[r.prop!]?.kf ?? [];
          const idx = kf.findIndex(k => Math.abs(k.t - st.time) < 1e-6);
          if (idx >= 0) deleteKeyframes(st, [keyId(r.id, r.prop!, idx)]);
          else addKeyframe(st, [r.id], r.prop!);
          return;
        }
        st.select([r.id]);
        // select all keys of the property
        const kf = r.layer.props[r.prop!]?.kf ?? [];
        st.keySelection = new Set(kf.map((_, j) => keyId(r.id, r.prop!, j)));
        st.emit('keys');
      }
      return;
    }
    // track area
    const k = this.keyAt(x, y);
    // a collapsed layer's summary key on the bar edge: the outer side of the edge trims
    let edgeTrim = false;
    if (!k && i >= 0 && this.rows[i].kind === 'layer') {
      const l = this.rows[i].layer;
      const inX = this.tToX(Math.max(0, l.inPoint)), outX = this.tToX(Math.min(st.comp.duration, l.outPoint));
      edgeTrim = (x <= inX && inX - x < 5) || (x >= outX && x - outX < 5);
    }
    const summary = k || edgeTrim ? [] : this.summaryKeysAt(x, y);
    if (k || summary.length) {
      const keys = k ? [k] : summary;
      const already = keys.every(kk => st.keySelection.has(kk));
      if (e.shiftKey) {
        for (const kk of keys) already ? st.keySelection.delete(kk) : st.keySelection.add(kk);
      } else if (!already) st.keySelection = new Set(keys);
      const r = this.rows[i];
      if (!st.selection.includes(r.id)) st.select([r.id]);
      st.emit('keys');
      const first = parseKeyId(keys[0]);
      const t0 = st.layer(first.layerId)!.props[first.key]!.kf![first.index].t;
      this.drag = { kind: 'keys', sx: x, t0, moved: false, dt: 0, key: keys[0], snap: snapshotKeys(st, st.keySelection) };
      st.beginGesture('keys');
      return;
    }
    // a click (no drag) on the line between two keys selects that segment; a drag is a marquee
    const segKeys = this.segmentAt(x, y);
    if (segKeys.length) {
      this.drag = { kind: 'marquee', sx: x, sy: y, x, y, base: e.shiftKey ? new Set(st.keySelection) : new Set(), seg: segKeys, shift: e.shiftKey };
      return;
    }
    // layer bar drag (move / trim in-out)
    if (i >= 0 && this.rows[i].kind === 'layer') {
      const l = this.rows[i].layer;
      const comp = st.comp;
      const inX = this.tToX(Math.max(0, l.inPoint)), outX = this.tToX(Math.min(comp.duration, l.outPoint));
      if (Math.abs(x - inX) < 5 && l.inPoint > 0 || Math.abs(x - inX) < 5) { st.select([l.id]); this.drag = { kind: 'bar', id: l.id, sx: x, in0: l.inPoint, out0: Math.min(l.outPoint, comp.duration), mode: 'in' }; st.beginGesture('trim'); return; }
      if (Math.abs(x - outX) < 5) { st.select([l.id]); this.drag = { kind: 'bar', id: l.id, sx: x, in0: l.inPoint, out0: Math.min(l.outPoint, comp.duration), mode: 'out' }; st.beginGesture('trim'); return; }
      // drag the bar body: move the layer (and all its keyframes) in time. alt-drag: marquee instead
      if (x > inX && x < outX && !e.altKey) {
        if (!st.selection.includes(l.id)) st.select([l.id]);
        const orig = new Map<string, { inP: number; outP: number; start: number; kf: Partial<Record<PropKey, Keyframe[]>> }>();
        for (const id of st.selection) {
          const ll = st.layer(id);
          if (!ll) continue;
          const kf: Partial<Record<PropKey, Keyframe[]>> = {};
          for (const k in ll.props) { const p = ll.props[k as PropKey]; if (p?.kf?.length) kf[k as PropKey] = p.kf; }
          orig.set(id, { inP: ll.inPoint, outP: ll.outPoint, start: ll.startTime ?? 0, kf });
        }
        this.drag = { kind: 'shift', sx: x, moved: false, orig };
        st.beginGesture('shift');
        return;
      }
    }
    this.drag = { kind: 'marquee', sx: x, sy: y, x, y, base: e.shiftKey ? new Set(st.keySelection) : new Set() };
    if (!e.shiftKey) { st.keySelection = new Set(); st.emit('keys'); }
    if (i >= 0 && !e.shiftKey) st.select([this.rows[i].id]);
  }

  private scrubTo(x: number, free: boolean) {
    const st = this.ed.store;
    let t = Math.max(0, this.xToT(x));
    if (!free) {
      t = st.snapTime(t);
      // snap to nearby keyframes of selected layers
      for (const id of st.selection) {
        const l = st.layer(id);
        if (!l) continue;
        for (const kt of layerKeyTimes(l)) if (Math.abs(this.tToX(kt) - x) < 6) t = kt;
      }
    }
    if (st.playing) this.ed.pause();
    st.setTime(t);
  }

  private move(e: PointerEvent) {
    const [x, y] = this.local(e);
    const d = this.drag;
    const st = this.ed.store;
    if (!d) {
      const i = this.rowAtY(y);
      if (i !== this.hoverRow) { this.hoverRow = i; this.baseDirty = true; }
      this.canvas.style.cursor = Math.abs(x - this.leftW) < 4 || (y < HEADER_H && Math.abs(x - this.tToX(st.comp.duration)) < 5) ? 'col-resize' : '';
      return;
    }
    if (d.kind === 'graph') { this.graph.move(x, y, e.shiftKey); this.baseDirty = true; return; }
    if (d.kind === 'vscroll') {
      const vs = this.vScroll();
      if (vs) { this.scrollY = d.s0 + (y - d.sy) * ((vs.total - vs.view) / (vs.view - vs.h)); this.clampScroll(); this.baseDirty = true; }
      return;
    }
    if (d.kind === 'hscroll') {
      const hs = this.hScroll();
      if (hs) { this.scrollT = Math.max(0, d.s0 + (x - d.sx) * ((hs.total - hs.visible) / Math.max(1, (this.w - this.leftW) - hs.w))); this.baseDirty = true; }
      return;
    }
    if (d.kind === 'marker') {
      if (!d.moved && Math.abs(x - d.sx) < 3) return;
      d.moved = true;
      updateMarker(st, d.id, { t: st.snapTime(this.xToT(x)) });
      return;
    }
    if (d.kind === 'compEnd') {
      const dur = Math.max(1 / st.comp.fps, st.snapTime(this.xToT(x)));
      if (dur !== st.comp.duration) st.transact('Composition duration', tx => { tx.set(st.comp, 'duration', dur); tx.comp(); });
      if (st.time > dur) st.setTime(dur);
      return;
    }
    if (d.kind === 'scrub') this.scrubTo(x, e.shiftKey);
    else if (d.kind === 'split') { this.leftW = Math.max(180, Math.min(this.w - 200, d.w0 + x - d.sx)); this.baseDirty = true; }
    else if (d.kind === 'keys') {
      let dt = (x - d.sx) / this.pxPerSec;
      if (!d.moved && Math.abs(x - d.sx) < 3) return;
      d.moved = true;
      // snap the dragged key to frames (and the playhead / markers within 6px; alt: frames only)
      let nt = st.snapTime(d.t0 + dt);
      if (!e.altKey) {
        const rawX = this.tToX(d.t0 + dt);
        let best = 6;
        for (const t of [st.time, ...(st.comp.markers ?? []).map(m => m.t)]) {
          const dd = Math.abs(this.tToX(t) - rawX);
          if (dd < best) { best = dd; nt = t; }
        }
      }
      dt = Math.max(-d.snap.minT, nt - d.t0);
      if (Math.abs(dt - d.dt) < 1e-9) return;
      d.dt = dt;
      moveKeysFrom(st, d.snap, dt);
    } else if (d.kind === 'marquee') {
      d.x = x; d.y = y;
      const t0 = this.xToT(Math.min(d.sx, x)), t1 = this.xToT(Math.max(d.sx, x));
      const r0 = this.rowAtY(Math.min(d.sy, y)), r1 = this.rowAtY(Math.max(d.sy, y));
      const sel = new Set(d.base);
      const a = r0 < 0 ? 0 : r0, b = r1 < 0 ? this.rows.length - 1 : r1;
      for (let i = a; i <= b; i++) {
        const r = this.rows[i];
        if (!r) continue;
        // keys are sorted by time: binary search to the first one inside [t0, t1]
        const addRange = (pk: PropKey) => {
          const kf = r.layer.props[pk]?.kf;
          if (!kf) return;
          for (let j = lowerBound(kf, t0); j < kf.length && kf[j].t <= t1; j++) sel.add(keyId(r.id, pk, j));
        };
        if (r.kind === 'prop') addRange(r.prop!);
        else if (!this.expanded.has(r.id)) for (const pk in r.layer.props) addRange(pk as PropKey);
      }
      st.keySelection = sel;
      st.emit('keys');
      this.baseDirty = true;
    } else if (d.kind === 'rows') {
      d.y = y;
      if (!d.moved && Math.abs(y - d.sy) < 4) return;
      d.moved = true;
      this.baseDirty = true;
    } else if (d.kind === 'shift') {
      if (!d.moved && Math.abs(x - d.sx) < 3) return;
      d.moved = true;
      let dt = st.snapTime((x - d.sx) / this.pxPerSec);
      if (e.shiftKey) dt = (x - d.sx) / this.pxPerSec;
      st.transact('Move layer in time', tx => {
        for (const [id, o] of d.orig) {
          const l = st.layer(id);
          if (!l) continue;
          tx.set(l, 'inPoint', o.inP + dt);
          if (o.outP < 1e8) tx.set(l, 'outPoint', o.outP + dt);
          for (const k in o.kf) tx.set(l.props[k as PropKey]!, 'kf', o.kf[k as PropKey]!.map(f => ({ ...f, t: f.t + dt })));
          if (l.type === 'precomp' || l.type === 'audio') { tx.set(l, 'startTime', o.start + dt); tx.recompile(); }
          tx.touch(id);
        }
      });
    } else if (d.kind === 'bar') {
      const comp = st.comp;
      const dt = st.snapTime((x - d.sx) / this.pxPerSec);
      const id = d.id;
      st.transact('Trim layer', tx => {
        const l = st.layer(id)!;
        if (d.mode === 'in') tx.set(l, 'inPoint', Math.max(0, Math.min(d.out0 - 1 / comp.fps, d.in0 + dt)));
        else tx.set(l, 'outPoint', Math.max(d.in0 + 1 / comp.fps, d.out0 + dt) >= comp.duration - 1e-6 ? 1e9 : Math.max(d.in0 + 1 / comp.fps, d.out0 + dt));
        tx.touch(id);
      });
    }
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    this.canvas.releasePointerCapture?.(e.pointerId);
    const st = this.ed.store;
    if (d?.kind === 'graph') this.graph.up();
    st.endGesture();
    if (d?.kind === 'marker' && !d.moved) { const m = st.comp.markers?.find(q => q.id === d.id); if (m) st.setTime(m.t); }
    if (d?.kind === 'rows' && d.moved) {
      const tgt = this.dropTarget(d.y);
      if (tgt) { moveLayers(st, d.ids, tgt.parent, tgt.index, { keepWorld: true }); if (tgt.parent) this.expand(tgt.parent); }
    }
    if (d?.kind === 'marquee' && d.seg && Math.abs(d.x - d.sx) < 3 && Math.abs(d.y - d.sy) < 3) {
      st.keySelection = new Set(d.shift ? [...st.keySelection, ...d.seg] : d.seg);
      const r = this.rows[this.rowAtY(d.sy)];
      if (r && !st.selection.includes(r.id)) st.select([r.id]);
      st.emit('keys');
    }
    if (d?.kind === 'rows' && !d.moved && !(e.metaKey || e.ctrlKey || e.shiftKey)) {
      const i = this.rowAtY(d.sy);
      if (i >= 0) st.select([this.rows[i].id]);
    }
    this.baseDirty = true;
  }

  /** where would dropped rows go: returns parent + index in draw order */
  private dropTarget(y: number): { parent: string | null; index: number; lineY: number; depth: number; into: boolean } | null {
    const st = this.ed.store;
    const rel = y - HEADER_H + this.scrollY;
    let i = Math.floor(rel / ROW_H);
    const frac = rel / ROW_H - i;
    i = Math.max(0, Math.min(this.rows.length - 1, i));
    const r = this.rows[i];
    if (!r) return { parent: null, index: 0, lineY: HEADER_H, depth: 0, into: false };
    const row = r.kind === 'layer' ? r : this.rows.slice(0, i).reverse().find(rr => rr.kind === 'layer' && rr.id === r.id)!;
    const l = row.layer;
    if (l.type === 'group' && frac > 0.3 && frac < 0.7 && r.kind === 'layer') {
      return { parent: l.id, index: l.children.length, lineY: this.rowY(i), depth: row.depth + 1, into: true };
    }
    const sib = l.parent ? st.layer(l.parent)!.children : st.comp.root;
    const di = sib.indexOf(l.id);
    // list is reversed draw order: dropping above row => index after it in draw order
    const above = frac < 0.5;
    return { parent: l.parent, index: above ? di + 1 : di, lineY: this.rowY(i) + (above ? 0 : ROW_H), depth: row.depth, into: false };
  }

  private dbl(e: MouseEvent) {
    const [x, y] = this.local(e);
    const mk = this.markerAt(x, y);
    if (mk) { this.renameMarker(mk.id); return; }
    if (y < HEADER_H && x > this.leftW) {
      // double click on the work area bar clears it, elsewhere fits the time
      if (this.ed.store.workArea && y > HEADER_H - 8) { this.ed.store.workArea = null; this.ed.store.emit('workarea'); return; }
      this.fitTime();
      return;
    }
    const i = this.rowAtY(y);
    if (i < 0) return;
    const r = this.rows[i];
    if (x < this.leftW && r.kind === 'layer' && r.layer.type === 'precomp' && r.layer.compRef && x < this.leftW - 50 && x > 8 + r.depth * INDENT + 10 && x < 8 + r.depth * INDENT + 28) { this.ed.store.openComp(r.layer.compRef); return; }
    if (x < this.leftW && r.kind === 'layer') this.startRename(r, i);
    else if (x > this.leftW && r.kind === 'prop') {
      // double click on empty track: add keyframe at that time
      const st = this.ed.store;
      addKeyframe(st, [r.id], r.prop!, st.snapTime(this.xToT(x)));
    }
  }

  /** marker flag under the pointer (ruler only) */
  private markerAt(x: number, y: number) {
    // only the flag strip at the bottom of the ruler: the playhead knob above it stays draggable
    if (y >= HEADER_H || y < HEADER_H - 14 || x < this.leftW) return null;
    let best: { id: string; t: number } | null = null, bd = 6;
    for (const m of this.ed.store.comp.markers ?? []) {
      const d = Math.abs(this.tToX(m.t) - x);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  private renameMarker(id: string) {
    const st = this.ed.store;
    const m = st.comp.markers?.find(q => q.id === id);
    if (!m) return;
    this.input?.remove();
    const inp = document.createElement('input');
    inp.className = 'tl-rename';
    inp.value = m.label;
    inp.placeholder = 'Marker name';
    const x = Math.min(this.w - 160, Math.max(this.leftW, this.tToX(m.t) + 6));
    Object.assign(inp.style, { left: x + 'px', top: '3px', width: '150px', height: HEADER_H - 8 + 'px' });
    this.host.appendChild(inp);
    inp.focus();
    inp.select();
    const done = (ok: boolean) => {
      if (!this.input) return;
      this.input = null;
      if (ok && inp.value !== m.label) updateMarker(st, id, { label: inp.value.trim() });
      inp.remove();
    };
    inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
    this.input = inp;
  }

  private startRename(r: Row, i: number) {
    this.input?.remove();
    const inp = document.createElement('input');
    inp.className = 'tl-rename';
    inp.value = r.layer.name;
    const x = 8 + r.depth * INDENT + 30;
    Object.assign(inp.style, { left: x + 'px', top: this.rowY(i) + 2 + 'px', width: this.leftW - x - 50 + 'px', height: ROW_H - 4 + 'px' });
    this.host.appendChild(inp);
    inp.focus();
    inp.select();
    const done = (ok: boolean) => {
      if (!this.input) return;
      this.input = null;
      if (ok && inp.value.trim()) renameLayer(this.ed.store, r.id, inp.value.trim());
      inp.remove();
    };
    inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
    this.input = inp;
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const [x] = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      const t = this.xToT(x);
      const f = Math.exp(-e.deltaY * 0.004);
      this.pxPerSec = Math.max(5, Math.min(5000, this.pxPerSec * f));
      this.scrollT = Math.max(0, t - (x - this.leftW - 12) / this.pxPerSec);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dx = e.shiftKey ? e.deltaY : e.deltaX;
      this.scrollT = Math.max(0, this.scrollT + dx / this.pxPerSec);
    } else {
      this.scrollY += e.deltaY;
      this.clampScroll();
    }
    this.baseDirty = true;
  }

  private context(e: MouseEvent) {
    e.preventDefault();
    const [x, y] = this.local(e);
    const st = this.ed.store;
    const k = this.keyAt(x, y);
    if (k && !st.keySelection.has(k)) { st.keySelection = new Set([k]); st.emit('keys'); }
    const items: MenuItem[] = [];
    const mk = this.markerAt(x, y);
    if (mk) {
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Rename marker', action: () => this.renameMarker(mk.id) },
        { label: 'Delete marker', action: () => deleteMarker(st, mk.id) },
      ]);
      return;
    }
    if (st.keySelection.size) {
      const keys = [...st.keySelection];
      items.push({ label: 'Easy Ease', shortcut: 'F9', action: () => setEase(st, keys, 'Easy Ease') });
      items.push({ label: 'Linear', action: () => setInterp(st, keys, 'linear') });
      items.push({ label: 'Hold', action: () => setInterp(st, keys, 'hold') });
      items.push({ label: 'Easing', submenu: EASE_PRESETS.map(p => ({ label: p.name, action: () => setEase(st, keys, p.name) })) });
      items.push({ label: 'Spring', submenu: SPRING_PRESETS.map(p => ({ label: p.name, action: () => setSpring(st, keys, p.bounce) })) });
      items.push({ separator: true });
      items.push({ label: 'Delete keyframes', shortcut: '⌫', action: () => deleteKeyframes(st, keys) });
    } else {
      const i = this.rowAtY(y);
      const r = i >= 0 ? this.rows[i] : null;
      if (r) {
        if (!st.selection.includes(r.id)) st.select([r.id]);
        const props = [...TRANSFORM_KEYS, ...TYPE_PROPS[r.layer.type]];
        items.push({ label: 'Animate', submenu: props.map(p => ({ label: (isAnimated(r.layer, p) ? '✓ ' : '') + PROP_DEFS[p].label, action: () => { toggleAnimated(st, st.selection, p); this.expand(r.id); } })) });
        items.push({ label: r.layer.visible ? 'Hide' : 'Show', action: () => setLayerField(st, st.selection, 'visible', !r.layer.visible) });
        items.push({ label: 'Rename', action: () => this.startRename(r, i) });
        items.push({ label: 'Duplicate', shortcut: '⌘D', action: () => { const ids = cloneLayers(st, st.selection); if (ids?.length) st.select(ids); } });
        items.push({ label: 'Delete', shortcut: '⌫', action: () => deleteLayers(st, st.selection) });
        items.push({ label: 'Pre-compose', shortcut: '⇧⌘C', action: () => { try { precompose(st, st.selection); } catch (err: any) { alert(err.message); } } });
        if (r.layer.type === 'precomp' && r.layer.compRef) items.push({ label: 'Open composition', action: () => st.openComp(r.layer.compRef!) });
        const P = st.project;
        const inst = instanceRootOf(P, r.id);
        if (inst) {
          items.push({ separator: true });
          if (overridesOf(r.layer).length || P.layers[inst].link?.ov?.length) items.push({ label: 'Reset instance changes', action: () => resetOverrides(st, inst) });
          items.push({ label: 'Detach instance', action: () => detachInstance(st, inst) });
        } else if (P.components?.[r.id]) {
          items.push({ separator: true });
          items.push({ label: 'Add instance', action: () => createInstance(st, r.id) });
        } else if (st.selection.length === 1) {
          items.push({ label: 'Create component', shortcut: '⌥⌘K', action: () => { try { createComponent(st, r.id); } catch (err: any) { alert(err.message); } } });
        }
      }
    }
    if (items.length) showContextMenu(e.clientX, e.clientY, items);
  }
}

// ---------- drawing helpers ----------
function diamond(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.beginPath();
  g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y);
  g.closePath();
}
function easeShape(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  // hourglass-ish (after effects easy ease)
  g.beginPath();
  g.moveTo(x - r * 0.8, y - r); g.lineTo(x + r * 0.8, y - r); g.lineTo(x + r * 0.15, y); g.lineTo(x + r * 0.8, y + r); g.lineTo(x - r * 0.8, y + r); g.lineTo(x - r * 0.15, y);
  g.closePath();
}
function drawEye(g: CanvasRenderingContext2D, x: number, y: number, open: boolean) {
  g.beginPath();
  g.ellipse(x, y, 6, 3.5, 0, 0, Math.PI * 2);
  g.strokeStyle = g.fillStyle as string;
  g.lineWidth = 1.2;
  g.stroke();
  if (open) { g.beginPath(); g.arc(x, y, 1.6, 0, Math.PI * 2); g.fill(); }
  else { g.beginPath(); g.moveTo(x - 6, y + 4); g.lineTo(x + 6, y - 4); g.stroke(); }
}
function drawLock(g: CanvasRenderingContext2D, x: number, y: number) {
  g.fillRect(x - 4, y - 1, 8, 6);
  g.strokeStyle = g.fillStyle as string;
  g.lineWidth = 1.2;
  g.beginPath();
  g.arc(x, y - 2, 2.6, Math.PI, 0);
  g.stroke();
}
function drawTypeIcon(g: CanvasRenderingContext2D, type: Layer['type'], x: number, y: number) {
  g.beginPath();
  switch (type) {
    case 'rect': g.rect(x - 4.5, y - 4.5, 9, 9); g.stroke(); break;
    case 'ellipse': g.arc(x, y, 5, 0, Math.PI * 2); g.stroke(); break;
    case 'group': g.rect(x - 5, y - 4, 10, 8); g.moveTo(x - 5, y - 1.5); g.lineTo(x + 5, y - 1.5); g.stroke(); break;
    case 'text': g.font = T.font.uiBoldSm; g.fillText('T', x - 3.5, y + 0.5); break;
    case 'image': g.rect(x - 5, y - 4, 10, 8); g.moveTo(x - 5, y + 3); g.lineTo(x - 1, y - 1); g.lineTo(x + 2, y + 2); g.stroke(); break;
    case 'path': g.moveTo(x - 5, y + 4); g.bezierCurveTo(x - 3, y - 6, x + 3, y + 6, x + 5, y - 4); g.stroke(); break;
    case 'precomp': g.rect(x - 5, y - 4, 10, 8); g.rect(x - 2.5, y - 1.5, 5, 3); g.stroke(); break;
    case 'audio': for (let k = -4; k <= 4; k += 2) { const hh = [2, 4, 5, 3, 2][(k + 4) / 2]; g.fillRect(x + k - 0.5, y - hh, 1.2, hh * 2); } break;
  }
}
/** ellipsized labels by font + width + text: the visible names are re-measured on every redraw otherwise */
const fitCache = new Map<string, string>();
// a web font finishing to load changes the widths
if (typeof document !== 'undefined') document.fonts?.addEventListener?.('loadingdone', () => fitCache.clear());
function ellipsize(g: CanvasRenderingContext2D, s: string, max: number) {
  const key = g.font + '\n' + max + '\n' + s;
  let r = fitCache.get(key);
  if (r === undefined) {
    if (fitCache.size > 4000) fitCache.clear();
    fitCache.set(key, (r = ellipsizeUncached(g, s, max)));
  }
  return r;
}
function ellipsizeUncached(g: CanvasRenderingContext2D, s: string, max: number) {
  if (g.measureText(s).width <= max) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (g.measureText(s.slice(0, m) + '…').width <= max) lo = m; else hi = m - 1; }
  return s.slice(0, lo) + '…';
}
export function fmtTime(t: number, fps: number) {
  const s = Math.floor(t + 1e-6);
  const f = Math.round((t - s) * fps);
  return f ? `${s}:${String(f).padStart(2, '0')}` : `${s}s`;
}
export function fmtValue(key: PropKey, v: number[]) {
  const def = PROP_DEFS[key];
  if (def.unit === 'color') return '#' + v.slice(0, 3).map(c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('') + (v[3] < 1 ? ` ${Math.round(v[3] * 100)}%` : '');
  const r = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1)).replace(/\.0$/, '');
  if (key === 'radius' && v.every(x => x === v[0])) return r(v[0]);
  return v.map(r).join(', ') + (def.unit === '%' ? '%' : def.unit === '°' ? '°' : '');
}
