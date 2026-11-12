// the editor store: document + undo/redo + selection + playhead.
// every document mutation goes through transact() which records inverse ops,
// so the ui and the ai agent tools share one code path and everything is undoable.

import type { Composition, Layer, Project } from './model';
import { createProject } from './model';

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
    fn(tx);
    if (tx.undo.length === 0) return;
    this.redoStack.length = 0;
    const top = this.undoStack[this.undoStack.length - 1];
    const mk = mergeKey ?? this.gesture ?? undefined;
    if (mk && top && top.mergeKey === mk) {
      top.undo.push(...tx.undo);
      top.redo.push(...tx.redo);
    } else {
      this.undoStack.push({ label, mergeKey: mk, undo: tx.undo, redo: tx.redo, selection: this.selection.slice() });
      if (this.undoStack.length > 500) this.undoStack.shift();
    }
    this.emitChange(tx.change);
    this.emit('history');
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
  /** marker for "undo everything since" (agent turns) */
  get historyLength() { return this.undoStack.length; }
  /** undo until the undo stack is back at `marker`. returns steps undone */
  undoTo(marker: number) {
    let n = 0;
    while (this.undoStack.length > marker) { this.undo(); n++; }
    return n;
  }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label; }

  private afterHistory(_e: Entry) {
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
    this.undoStack.length = 0;
    this.redoStack.length = 0;
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
