// the editor store: document + undo/redo + selection + playhead.
// every document mutation goes through transact() which records inverse ops,
// so the ui and the ai agent tools share one code path and everything is undoable.

import type { Composition, Layer, Project } from './model';
import { createComp, createProject } from './model';

export interface Change {
  structure: boolean; // layers added/removed/reordered/reparented
  comp: boolean; // composition settings
  layers: Set<string>; // layers whose props/data changed
  meta: boolean; // project name etc
  assets: boolean;
}

type Op = () => void; // inverse operation

interface Entry {
  label: string;
  mergeKey?: string;
  undo: Op[];
  redo: Op[];
  selection: string[];
}

export type Listener = (c: Change) => void;

export class Tx {
  undo: Op[] = [];
  redo: Op[] = [];
  change: Change = { structure: false, comp: false, layers: new Set(), meta: false, assets: false };

  /** set obj[key] = value, recording the inverse */
  set<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]) {
    const had = Object.prototype.hasOwnProperty.call(obj, key);
    const old = obj[key];
    obj[key] = value;
    this.undo.push(() => { if (had) obj[key] = old; else delete obj[key]; });
    this.redo.push(() => { obj[key] = value; });
  }

  del<T extends object, K extends keyof T>(obj: T, key: K) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return;
    const old = obj[key];
    delete obj[key];
    this.undo.push(() => { obj[key] = old; });
    this.redo.push(() => { delete obj[key]; });
  }

  touch(layerId: string) { this.change.layers.add(layerId); }
  /** set by commands that keep keyframe indices valid (easing edits, value edits of existing keys) */
  keepKeys = false;
  structure() { this.change.structure = true; }
  comp() { this.change.comp = true; }
}

export class Store {
  project: Project;
  selection: string[] = [];
  /** selected keyframes: `${layerId}|${prop}|${index}` */
  keySelection = new Set<string>();
  time = 0;
  playing = false;
  loop = true;
  /** soloed layers (view state, not undoable): when non-empty only these + their ancestors/descendants render */
  solo = new Set<string>();
  toggleSolo(id: string) {
    this.solo.has(id) ? this.solo.delete(id) : this.solo.add(id);
    this.emitChange({ structure: true, comp: false, layers: new Set(), meta: false, assets: false });
  }
  /** preview range [start, end] in seconds (after effects "work area"); null = whole comp */
  workArea: [number, number] | null = null;
  private listeners = new Set<Listener>();
  private uiListeners = new Map<string, Set<() => void>>();
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private gesture: string | null = null;

  constructor(project?: Project) {
    this.project = project ?? createProject();
  }

  get comp(): Composition {
    return this.project.comps[this.project.activeComp];
  }

  layer(id: string): Layer | undefined {
    return this.project.layers[id];
  }

  // ---------- events ----------
  onChange(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** lightweight ui channels: 'selection' | 'time' | 'playing' | 'history' | 'keys' | 'doc' */
  on(channel: string, fn: () => void) {
    let s = this.uiListeners.get(channel);
    if (!s) this.uiListeners.set(channel, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }
  emit(channel: string) {
    const s = this.uiListeners.get(channel);
    if (s) for (const fn of s) fn();
  }

  private emitChange(c: Change) {
    for (const fn of this.listeners) fn(c);
    this.emit('doc');
  }

  // ---------- transactions ----------
  /** run a mutation. mergeKey: consecutive transactions with the same key collapse into one undo step (drags) */
  transact(label: string, fn: (tx: Tx) => void, mergeKey?: string): void {
    const tx = new Tx();
    try {
      fn(tx);
    } catch (e) {
      // atomic: roll back whatever was applied before the error
      for (let i = tx.undo.length - 1; i >= 0; i--) tx.undo[i]();
      throw e;
    }
    if (tx.undo.length === 0) return;
    // keyframe selection stores indices: edits that may insert/remove keys invalidate it
    if (!tx.keepKeys && this.keySelection.size && (tx.change.layers.size || tx.change.structure)) {
      let touched = false;
      for (const k of this.keySelection) if (tx.change.layers.has(k.slice(0, k.indexOf('|')))) { touched = true; break; }
      if (touched || tx.change.structure) { this.keySelection = new Set(); this.emit('keys'); }
    }
    this.redoStack.length = 0;
    const top = this.undoStack[this.undoStack.length - 1];
    const mk = mergeKey ?? this.gesture ?? undefined;
    if (mk && top && top.mergeKey === mk) {
      top.undo.push(...tx.undo);
      top.redo.push(...tx.redo);
    } else {
      this.undoStack.push({ label, mergeKey: mk, undo: tx.undo, redo: tx.redo, selection: this.selection.slice() });
      if (this.undoStack.length > 500) { this.undoStack.shift(); this.dropped++; }
    }
    this.emitChange(tx.change);
    this.emit('history');
  }

  /** run several commands as ONE undo step */
  batch<T>(key: string, fn: () => T): T {
    const prev = this.gesture;
    if (!prev) this.gesture = key + ':' + Math.random();
    try { return fn(); } finally { if (!prev) this.gesture = null; }
  }

  /** while a gesture is active, all transactions merge into one undo step */
  beginGesture(key: string) { this.gesture = key + ':' + Math.random(); }
  endGesture() { this.gesture = null; }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    for (let i = e.undo.length - 1; i >= 0; i--) e.undo[i]();
    this.redoStack.push(e);
    this.afterHistory(e);
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    for (const op of e.redo) op();
    this.undoStack.push(e);
    this.afterHistory(e);
  }

  get canUndo() { return this.undoStack.length > 0; }
  /** undo entries dropped off the bottom of the capped stack: keeps markers stable once the cap is hit */
  private dropped = 0;
  /** marker for "undo everything since" (agent turns). monotonic while editing, even past the 500-step cap */
  get historyLength() { return this.undoStack.length + this.dropped; }
  /** undo until the history is back at `marker` (or as far as the stack goes). returns steps undone */
  undoTo(marker: number) {
    let n = 0;
    while (this.undoStack.length && this.historyLength > marker) { this.undo(); n++; }
    return n;
  }
  get canRedo() { return this.redoStack.length > 0; }
  /** labels of the undo steps, oldest first */
  get historyLabels(): string[] { return this.undoStack.map(e => e.label); }
  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label; }

  /** the active comp can disappear (undo of "new composition"/"pre-compose", broken files): fall back */
  ensureActiveComp() {
    const P = this.project;
    if (P.comps[P.activeComp]) return false;
    const first = Object.keys(P.comps)[0];
    if (!first) { const c = createComp(); P.comps[c.id] = c; P.activeComp = c.id; }
    else P.activeComp = first;
    this.emit('comps');
    return true;
  }

  private afterHistory(_e: Entry) {
    this.ensureActiveComp();
    // we don't know precisely what changed: invalidate everything (undo is rare, so this is fine)
    this.selection = this.selection.filter(id => this.project.layers[id]);
    this.keySelection.clear();
    this.emitChange({ structure: true, comp: true, layers: new Set(Object.keys(this.project.layers)), meta: true, assets: true });
    this.emit('selection');
    this.emit('keys');
    this.emit('history');
  }

  /** replace the whole document (open file) */
  load(project: Project) {
    this.project = project;
    this.ensureActiveComp();
    this.workArea = null;
    this.solo.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.dropped = 0;
    this.selection = [];
    this.keySelection.clear();
    this.time = 0;
    this.emitChange({ structure: true, comp: true, layers: new Set(Object.keys(project.layers)), meta: true, assets: true });
    this.emit('selection');
    this.emit('time');
    this.emit('history');
  }

  /** switch the active composition (view state, not an undoable edit) */
  openComp(id: string) {
    if (!this.project.comps[id] || id === this.project.activeComp) return;
    this.project.activeComp = id;
    this.workArea = null;
    this.solo.clear();
    this.selection = [];
    this.keySelection.clear();
    this.time = Math.min(this.time, this.comp.duration);
    this.emitChange({ structure: true, comp: true, layers: new Set(), meta: false, assets: false });
    this.emit('selection');
    this.emit('keys');
    this.emit('time');
    this.emit('comps');
  }

  // ---------- selection / time ----------
  select(ids: string[], mode: 'replace' | 'add' | 'toggle' = 'replace') {
    let next: string[];
    if (mode === 'replace') next = ids.slice();
    else if (mode === 'add') next = [...new Set([...this.selection, ...ids])];
    else {
      const s = new Set(this.selection);
      for (const id of ids) s.has(id) ? s.delete(id) : s.add(id);
      next = [...s];
    }
    if (next.length === this.selection.length && next.every((v, i) => v === this.selection[i])) return;
    this.selection = next;
    if (this.keySelection.size) {
      const keep = new Set(next);
      const filtered = new Set([...this.keySelection].filter(k => keep.has(k.slice(0, k.indexOf('|')))));
      if (filtered.size !== this.keySelection.size) { this.keySelection = filtered; this.emit('keys'); }
    }
    this.emit('selection');
  }

  setTime(t: number) {
    const d = this.comp.duration;
    t = Math.max(0, Math.min(d, t));
    if (t === this.time) return;
    this.time = t;
    this.emit('time');
  }

  /** time snapped to the composition frame grid */
  snapTime(t: number) {
    const fps = this.comp.fps;
    return Math.round(t * fps) / fps;
  }

  setPlaying(p: boolean) {
    if (p === this.playing) return;
    this.playing = p;
    this.emit('playing');
  }

  // ---------- tree helpers ----------
  siblings(layer: Layer): string[] {
    return layer.parent ? this.project.layers[layer.parent].children : this.comp.root;
  }

  /** depth-first draw order (bottom to top) of the active comp */
  drawOrder(): string[] {
    const out: string[] = [];
    const L = this.project.layers;
    const walk = (ids: string[]) => {
      for (const id of ids) {
        out.push(id);
        const l = L[id];
        if (l && l.children.length) walk(l.children);
      }
    };
    walk(this.comp.root);
    return out;
  }

  /** returns ids of all descendants */
  descendants(id: string): string[] {
    const out: string[] = [];
    const walk = (ids: string[]) => { for (const c of ids) { out.push(c); walk(this.project.layers[c]?.children ?? []); } };
    walk(this.project.layers[id]?.children ?? []);
    return out;
  }

  isAncestor(maybeAncestor: string, id: string): boolean {
    let p = this.project.layers[id]?.parent;
    while (p) { if (p === maybeAncestor) return true; p = this.project.layers[p]?.parent; }
    return false;
  }
}
