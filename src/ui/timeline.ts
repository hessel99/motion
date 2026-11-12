// canvas timeline: layer list (left) + time tracks with keyframes (right).
// fully virtualized (only visible rows are drawn) and the static part is cached in an
// offscreen canvas, so during playback each frame is one drawImage + the playhead.

import type { Editor } from '../app/editor';
import {
  isAnimated, keyId, layerKeyTimes, moveKeyframes, moveLayers, parseKeyId, renameLayer, setLayerField, valueAt,
  addKeyframe, deleteKeyframes, toggleAnimated,
} from '../core/commands';
import { PROP_DEFS, TYPE_PROPS, TRANSFORM_KEYS, type Keyframe, type Layer, type PropKey } from '../core/model';
import { showContextMenu, type MenuItem } from './menu';
import { EASE_PRESETS, SPRING_PRESETS } from '../core/easing';
import { setEase, setInterp, setSpring } from '../core/commands';

const HEADER_H = 28;
const ROW_H = 24;
const INDENT = 14;

interface Row {
  kind: 'layer' | 'prop';
  id: string;
  layer: Layer;
  depth: number;
  prop?: PropKey;
  hasChildren?: boolean;
}

type Drag =
  | { kind: 'scrub' }
  | { kind: 'keys'; sx: number; t0: number; moved: boolean; dt: number; key: string }
  | { kind: 'marquee'; sx: number; sy: number; x: number; y: number; base: Set<string> }
  | { kind: 'rows'; ids: string[]; sy: number; y: number; moved: boolean }
  | { kind: 'split'; sx: number; w0: number }
  | { kind: 'bar'; id: string; sx: number; in0: number; out0: number; mode: 'in' | 'out' }
  | { kind: 'shift'; sx: number; moved: boolean; orig: Map<string, { inP: number; outP: number; kf: Partial<Record<PropKey, Keyframe[]>> }> };

export class Timeline {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  base: HTMLCanvasElement;
  bg: CanvasRenderingContext2D;
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
  private hoverRow = -1;
  private input: HTMLInputElement | null = null;
  private autoFit = true;

  constructor(private ed: Editor, private host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'tl-canvas';
    host.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.bg = this.base.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const st = ed.store;
    let lastDur = st.comp.duration;
    st.on('doc', () => {
      this.rowsDirty = true; this.baseDirty = true;
      if (st.comp.duration !== lastDur) { lastDur = st.comp.duration; this.fitTime(); }
    });
    st.on('selection', () => { this.baseDirty = true; });
    st.on('keys', () => { this.baseDirty = true; });
    st.on('time', () => { if (!st.playing) this.baseDirty = true; });
    ed.on('loaded', () => {
      lastDur = st.comp.duration; this.expanded.clear(); this.scrollY = 0; this.autoFit = true; this.rowsDirty = true; this.baseDirty = true; this.resize(); });
    ed.onFrame(() => this.frame());
    this.canvas.addEventListener('pointerdown', e => this.down(e));
    this.canvas.addEventListener('pointermove', e => this.move(e));
    this.canvas.addEventListener('pointerup', e => this.up(e));
    this.canvas.addEventListener('dblclick', e => this.dbl(e));
    this.canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', e => this.context(e));
    this.canvas.addEventListener('pointerleave', () => { this.hoverRow = -1; this.baseDirty = true; });
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    for (const c of [this.canvas, this.base]) {
      c.width = Math.max(1, Math.round(r.width * this.dpr));
      c.height = Math.max(1, Math.round(r.height * this.dpr));
    }
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
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
    const walk = (ids: string[], depth: number) => {
      // list order: top-most first (reverse draw order)
      for (let i = ids.length - 1; i >= 0; i--) {
        const l = L[ids[i]];
        if (!l) continue;
        rows.push({ kind: 'layer', id: l.id, layer: l, depth, hasChildren: l.children.length > 0 });
        if (this.expanded.has(l.id)) {
          const keys = [...TRANSFORM_KEYS, ...TYPE_PROPS[l.type]];
          for (const k of keys) if (isAnimated(l, k)) rows.push({ kind: 'prop', id: l.id, layer: l, depth: depth + 1, prop: k });
          walk(l.children, depth + 1);
        }
      }
    };
    walk(st.comp.root, 0);
    this.rows = rows;
    this.rowsDirty = false;
    this.clampScroll();
  }

  private clampScroll() {
    const max = Math.max(0, this.rows.length * ROW_H - (this.h - HEADER_H) + ROW_H);
    this.scrollY = Math.max(0, Math.min(max, this.scrollY));
  }

  /** expand a layer (and its ancestors) and scroll it into view */
  reveal(id: string) {
    const st = this.ed.store;
    let p = st.layer(id)?.parent;
    while (p) { this.expanded.add(p); p = st.layer(p)?.parent; }
    this.rowsDirty = true;
    this.buildRows();
    const i = this.rows.findIndex(r => r.kind === 'layer' && r.id === id);
    if (i >= 0) {
      const y = i * ROW_H;
      if (y < this.scrollY) this.scrollY = y;
      else if (y + ROW_H > this.scrollY + this.h - HEADER_H) this.scrollY = y + ROW_H - (this.h - HEADER_H);
    }
    this.baseDirty = true;
  }

  expand(id: string, on = true) {
    if (on) this.expanded.add(id); else this.expanded.delete(id);
    this.rowsDirty = true;
    this.baseDirty = true;
  }

  // ---------- drawing ----------
  private frame() {
    if (this.rowsDirty) { this.buildRows(); this.baseDirty = true; }
    const st = this.ed.store;
    const px = Math.round(this.tToX(st.time));
    if (!this.baseDirty && px === this.lastPlayheadX) return;
    if (this.baseDirty) { this.drawBase(); this.baseDirty = false; }
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'copy';
    g.drawImage(this.base, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawPlayhead(px);
    this.lastPlayheadX = px;
  }

  private drawPlayhead(x: number) {
    const g = this.g;
    if (x < this.leftW) return;
    g.fillStyle = '#ff5a4f';
    g.fillRect(x - 0.5, HEADER_H - 6, 1, this.h);
    g.beginPath();
    g.moveTo(x - 6, 4); g.lineTo(x + 6, 4); g.lineTo(x + 6, HEADER_H - 10); g.lineTo(x, HEADER_H - 4); g.lineTo(x - 6, HEADER_H - 10);
    g.closePath();
    g.fill();
  }

  private drawBase() {
    const g = this.bg;
    const st = this.ed.store;
    const comp = st.comp;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#161618';
    g.fillRect(0, 0, this.w, this.h);
    g.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
    g.textBaseline = 'middle';
    const sel = new Set(st.selection);
    const first = Math.max(0, Math.floor(this.scrollY / ROW_H));
    const last = Math.min(this.rows.length, first + Math.ceil((this.h - HEADER_H) / ROW_H) + 1);
    const x0 = this.leftW;
    const tEnd = this.tToX(comp.duration);

    // track background past comp end
    g.fillStyle = '#111113';
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
      if (isSel) { g.fillStyle = 'rgba(76,141,255,0.18)'; g.fillRect(0, y, this.w, ROW_H); }
      else if (i === this.hoverRow) { g.fillStyle = 'rgba(255,255,255,0.03)'; g.fillRect(0, y, this.w, ROW_H); }
      g.fillStyle = 'rgba(255,255,255,0.04)';
      g.fillRect(0, y + ROW_H - 1, this.w, 1);
      if (r.kind === 'layer') this.drawLayerRow(g, r, y, isSel);
      else this.drawPropRow(g, r, y);
    }
    g.restore();

    // left/right divider
    g.fillStyle = '#2a2a2e';
    g.fillRect(x0 - 1, 0, 1, this.h);

    // ruler
    g.fillStyle = '#1c1c1f';
    g.fillRect(0, 0, this.w, HEADER_H);
    g.fillStyle = '#2a2a2e';
    g.fillRect(0, HEADER_H - 1, this.w, 1);
    this.drawRuler(g);
    g.fillStyle = '#8a8a93';
    g.font = '11px system-ui, sans-serif';
    g.fillText(`${this.rows.filter(r => r.kind === 'layer').length} layers`, 10, HEADER_H / 2);

    // drag feedback
    const d = this.drag;
    if (d?.kind === 'marquee') {
      g.fillStyle = 'rgba(76,141,255,0.1)';
      g.strokeStyle = '#4c8dff';
      const x = Math.min(d.sx, d.x), y = Math.min(d.sy, d.y);
      g.fillRect(x, y, Math.abs(d.x - d.sx), Math.abs(d.y - d.sy));
      g.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x - d.sx), Math.abs(d.y - d.sy));
    }
    if (d?.kind === 'rows' && d.moved) {
      const tgt = this.dropTarget(d.y);
      if (tgt) {
        g.fillStyle = '#4c8dff';
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
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let f = fStart; f <= tStop * fps + 1e-6; f += stepF) {
      const x = Math.round(this.tToX(f / fps)) + 0.5;
      if (x < this.leftW) continue;
      g.fillStyle = '#3a3a40';
      g.fillRect(x, HEADER_H - 8, 1, 8);
      g.fillStyle = 'rgba(255,255,255,0.025)';
      g.fillRect(x, HEADER_H, 1, this.h);
      g.fillStyle = '#8a8a93';
      g.fillText(fmtTime(f / fps, fps), x + 3, HEADER_H / 2 - 1);
      // minor ticks
      const minor = stepF >= 5 ? stepF / 5 : 0;
      if (minor >= 1) for (let m = 1; m < 5; m++) {
        const mx = Math.round(this.tToX((f + m * minor) / fps)) + 0.5;
        g.fillStyle = '#2f2f35';
        g.fillRect(mx, HEADER_H - 4, 1, 4);
      }
    }
    const endX = this.tToX(comp.duration);
    if (endX > this.leftW && endX < this.w) {
      g.fillStyle = '#4c8dff';
      g.fillRect(endX, 0, 1, HEADER_H);
    }
  }

  private drawLayerRow(g: CanvasRenderingContext2D, r: Row, y: number, isSel: boolean) {
    const l = r.layer;
    const st = this.ed.store;
    const cy = y + ROW_H / 2;
    const ix = 8 + r.depth * INDENT;
    const animated = Object.values(l.props).some(p => p?.kf?.length);
    // twirl
    if (r.hasChildren || animated) {
      g.fillStyle = '#9a9aa3';
      g.beginPath();
      if (this.expanded.has(l.id)) { g.moveTo(ix, cy - 2); g.lineTo(ix + 8, cy - 2); g.lineTo(ix + 4, cy + 3); }
      else { g.moveTo(ix + 2, cy - 4); g.lineTo(ix + 7, cy); g.lineTo(ix + 2, cy + 4); }
      g.closePath();
      g.fill();
    }
    // type icon
    const tx = ix + 14;
    g.strokeStyle = l.visible ? '#b9b9c2' : '#55555c';
    g.fillStyle = g.strokeStyle;
    g.lineWidth = 1.2;
    drawTypeIcon(g, l.type, tx, cy);
    // name
    g.fillStyle = !l.visible ? '#66666e' : isSel ? '#ffffff' : '#d6d6dc';
    g.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
    const nameX = tx + 16;
    const maxW = this.leftW - nameX - 52;
    g.fillText(ellipsize(g, l.name, maxW), nameX, cy);
    // eye + lock
    g.fillStyle = l.visible ? '#8a8a93' : '#4a4a50';
    drawEye(g, this.leftW - 40, cy, l.visible);
    g.fillStyle = l.locked ? '#d6d6dc' : '#3a3a40';
    drawLock(g, this.leftW - 20, cy);

    // track: layer bar
    const comp = st.comp;
    const inX = Math.max(this.leftW, this.tToX(Math.max(0, l.inPoint)));
    const outX = Math.min(this.w, this.tToX(Math.min(comp.duration, l.outPoint)));
    if (outX > inX) {
      g.fillStyle = isSel ? 'rgba(76,141,255,0.30)' : 'rgba(255,255,255,0.06)';
      g.beginPath();
      g.roundRect(inX, y + 4, outX - inX, ROW_H - 8, 3);
      g.fill();
    }
    // keyframe summary (collapsed) — union of key times
    if (!this.expanded.has(l.id) && animated) {
      const times = layerKeyTimes(l);
      g.fillStyle = isSel ? '#cfe0ff' : '#9a9aa3';
      let lastX = -10;
      for (const t of times) {
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
    g.fillStyle = atKey ? '#4c8dff' : '#5a5a62';
    diamond(g, ix + 18, cy, 4);
    atKey ? g.fill() : (g.strokeStyle = '#7a7a82', g.stroke());
    g.fillStyle = '#b9b9c2';
    g.font = '12px system-ui, sans-serif';
    g.fillText(PROP_DEFS[key].label, ix + 30, cy);
    // current value
    const v = valueAt(l, key, st.time);
    g.fillStyle = '#6aa3ff';
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const txt = fmtValue(key, v);
    const tw = g.measureText(txt).width;
    g.fillText(txt, this.leftW - 12 - tw, cy);
    // keyframes
    for (let i = 0; i < kf.length; i++) {
      const x = this.tToX(kf[i].t);
      if (x < this.leftW - 6 || x > this.w + 6) continue;
      const selected = st.keySelection.has(keyId(l.id, key, i));
      // segment line between keys when interpolated
      if (i < kf.length - 1 && kf[i].interp !== 'hold') {
        const x2 = this.tToX(kf[i + 1].t);
        const segSel = selected && st.keySelection.has(keyId(l.id, key, i + 1));
        g.fillStyle = segSel ? 'rgba(76,141,255,0.8)' : kf[i].interp === 'spring' ? 'rgba(255,190,90,0.35)' : 'rgba(255,255,255,0.12)';
        g.fillRect(Math.max(this.leftW, x), cy - (segSel ? 1 : 0.5), Math.max(0, Math.min(this.w, x2) - Math.max(this.leftW, x)), segSel ? 2 : 1);
      }
      g.fillStyle = selected ? '#4c8dff' : '#d6d6dc';
      g.strokeStyle = selected ? '#bcd4ff' : '#16161a';
      g.lineWidth = 1;
      if (kf[i].interp === 'hold') { g.beginPath(); g.rect(x - 4, cy - 4, 8, 8); }
      else if (kf[i].interp === 'linear') diamond(g, x, cy, 5);
      else if (kf[i].interp === 'spring') { g.beginPath(); g.arc(x, cy, 4.5, 0, Math.PI * 2); }
      else easeShape(g, x, cy, 5);
      g.fill();
      g.stroke();
    }
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
    const summary = k ? [] : this.summaryKeysAt(x, y);
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
      this.drag = { kind: 'keys', sx: x, t0, moved: false, dt: 0, key: keys[0] };
      st.beginGesture('keys');
      return;
    }
    const segKeys = this.segmentAt(x, y);
    if (segKeys.length) {
      st.keySelection = new Set(e.shiftKey ? [...st.keySelection, ...segKeys] : segKeys);
      if (!st.selection.includes(this.rows[i].id)) st.select([this.rows[i].id]);
      st.emit('keys');
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
        const orig = new Map<string, { inP: number; outP: number; kf: Partial<Record<PropKey, Keyframe[]>> }>();
        for (const id of st.selection) {
          const ll = st.layer(id);
          if (!ll) continue;
          const kf: Partial<Record<PropKey, Keyframe[]>> = {};
          for (const k in ll.props) { const p = ll.props[k as PropKey]; if (p?.kf?.length) kf[k as PropKey] = p.kf; }
          orig.set(id, { inP: ll.inPoint, outP: ll.outPoint, kf });
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
      this.canvas.style.cursor = Math.abs(x - this.leftW) < 4 ? 'col-resize' : '';
      return;
    }
    if (d.kind === 'scrub') this.scrubTo(x, e.shiftKey);
    else if (d.kind === 'split') { this.leftW = Math.max(180, Math.min(this.w - 200, d.w0 + x - d.sx)); this.baseDirty = true; }
    else if (d.kind === 'keys') {
      let dt = (x - d.sx) / this.pxPerSec;
      if (!d.moved && Math.abs(x - d.sx) < 3) return;
      d.moved = true;
      // snap the dragged key to frames (and playhead)
      let nt = st.snapTime(d.t0 + dt);
      if (Math.abs(this.tToX(st.time) - this.tToX(d.t0 + dt)) < 6) nt = st.time;
      dt = Math.max(-d.t0, nt - d.t0);
      const step = dt - d.dt;
      if (Math.abs(step) < 1e-9) return;
      d.dt = dt;
      moveKeyframes(st, st.keySelection, step);
    } else if (d.kind === 'marquee') {
      d.x = x; d.y = y;
      const t0 = this.xToT(Math.min(d.sx, x)), t1 = this.xToT(Math.max(d.sx, x));
      const r0 = this.rowAtY(Math.min(d.sy, y)), r1 = this.rowAtY(Math.max(d.sy, y));
      const sel = new Set(d.base);
      const a = r0 < 0 ? 0 : r0, b = r1 < 0 ? this.rows.length - 1 : r1;
      for (let i = a; i <= b; i++) {
        const r = this.rows[i];
        if (!r) continue;
        if (r.kind === 'prop') {
          (r.layer.props[r.prop!]?.kf ?? []).forEach((k, j) => { if (k.t >= t0 && k.t <= t1) sel.add(keyId(r.id, r.prop!, j)); });
        } else if (!this.expanded.has(r.id)) {
          for (const pk in r.layer.props) (r.layer.props[pk as PropKey]?.kf ?? []).forEach((k, j) => { if (k.t >= t0 && k.t <= t1) sel.add(keyId(r.id, pk as PropKey, j)); });
        }
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
    st.endGesture();
    if (d?.kind === 'rows' && d.moved) {
      const tgt = this.dropTarget(d.y);
      if (tgt) moveLayers(st, d.ids, tgt.parent, tgt.index);
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
    const i = this.rowAtY(y);
    if (i < 0) return;
    const r = this.rows[i];
    if (x < this.leftW && r.kind === 'layer') this.startRename(r, i);
    else if (x > this.leftW && r.kind === 'prop') {
      // double click on empty track: add keyframe at that time
      const st = this.ed.store;
      addKeyframe(st, [r.id], r.prop!, st.snapTime(this.xToT(x)));
    }
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
    case 'text': g.font = 'bold 11px system-ui'; g.fillText('T', x - 3.5, y + 0.5); break;
    case 'image': g.rect(x - 5, y - 4, 10, 8); g.moveTo(x - 5, y + 3); g.lineTo(x - 1, y - 1); g.lineTo(x + 2, y + 2); g.stroke(); break;
    case 'path': g.moveTo(x - 5, y + 4); g.bezierCurveTo(x - 3, y - 6, x + 3, y + 6, x + 5, y - 4); g.stroke(); break;
  }
}
function ellipsize(g: CanvasRenderingContext2D, s: string, max: number) {
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
