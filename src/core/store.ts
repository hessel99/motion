// the editor store: document + undo/redo + selection + playhead.
// every document mutation goes through transact() which records inverse ops,
// so the ui and the ai agent tools share one code path and everything is undoable.

import type { Composition, Layer, Project, Prop, PropKey } from './model';
import { createComp, createProject } from './model';
import { tokenTxHook } from './tokens';
import { componentTxHook, rememberTree } from './components';

export interface Change {
  structure: boolean; // layers added/removed/reordered/reparented
  comp: boolean; // composition settings
  layers: Set<string>; // layers whose props/data changed
  meta: boolean; // project name etc
  assets: boolean;
  /** with `structure`: the renderer must recompile, but the layer tree itself (membership, order,
   *  parents) is unchanged (visibility, clip/mask flags, start time). the timeline keeps its rows */
  sameTree?: boolean;
}

type Op = () => void; // inverse operation

/** undo entry ids: monotonic for the whole page lifetime (and seeded from the clock, so ids from an
 *  earlier session never collide with this one's) */
let entrySeq = Date.now();

interface Entry {
  /** unique id. changes whenever the step's content changes (a merge), so "the top entry is X"
   *  really means the document is in the state X left it in */
  id: number;
  label: string;
  mergeKey?: string;
  undo: Op[];
  redo: Op[];
  selection: string[];
  /** what the transaction(s) of this step changed: undo/redo invalidate exactly that */
  change: Change;
  /** merged steps (drags): index of the LAST redo op per written slot (obj, key). a later merge that
   *  writes the same slot replaces that redo op and drops its undo op, so a 100-move drag of 6k keys
   *  keeps one undo/redo pair per slot instead of 100 (same result: undo restores the first old value,
   *  redo writes the last new value, and ops on different slots commute) */
  slots?: WeakMap<object, Map<PropertyKey, number>>;
}

export type Listener = (c: Change) => void;

export class Tx {
  undo: Op[] = [];
  redo: Op[] = [];
  /** the slot (obj, key) each undo/redo pair writes */
  slotObj: object[] = [];
  slotKey: PropertyKey[] = [];
  change: Change = { structure: false, comp: false, layers: new Set(), meta: false, assets: false };

  /** set obj[key] = value, recording the inverse */
  set<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]) {
    const had = Object.prototype.hasOwnProperty.call(obj, key);
    const old = obj[key];
    obj[key] = value;
    this.undo.push(() => { if (had) obj[key] = old; else delete obj[key]; });
    this.redo.push(() => { obj[key] = value; });
    this.slotObj.push(obj); this.slotKey.push(key);
  }

  del<T extends object, K extends keyof T>(obj: T, key: K) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return;
    const old = obj[key];
    delete obj[key];
    this.undo.push(() => { obj[key] = old; });
    this.redo.push(() => { delete obj[key]; });
    this.slotObj.push(obj); this.slotKey.push(key);
  }

  touch(layerId: string) { this.change.layers.add(layerId); }
  /** set by commands that keep keyframe indices valid (easing edits, value edits of existing keys) */
  keepKeys = false;
  structure() { this.change.structure = true; this.change.sameTree = false; }
  /** a structural change for the renderer that leaves the layer tree as it is (see Change.sameTree) */
  recompile() { if (!this.change.structure) { this.change.structure = true; this.change.sameTree = true; } }
  comp() { this.change.comp = true; }
}

/** one open document's editor state (see Store.saveState) */
export interface DocState {
  project: Project; selection: string[]; keySelection: Set<string>; time: number; loop: boolean;
  workArea: [number, number] | null; solo: Set<string>; undo: Entry[]; redo: Entry[]; dropped: number; openComps: string[];
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

  /** transient preview overrides (ease swatch hover, Perform recording): view state, never part of
   *  the document. the renderer evaluates `previewProps[layer][key]` instead of the document prop,
   *  so autosave/serialize, undo and agent tools never see previewed values. */
  readonly previewProps = new Map<string, Partial<Record<PropKey, Prop>>>();
  /** set (or with `prop` undefined: remove) a preview override and redraw that layer */
  setPreviewProp(layerId: string, key: PropKey, prop: Prop | undefined) {
    let m = this.previewProps.get(layerId);
    if (prop) { if (!m) this.previewProps.set(layerId, (m = {})); m[key] = prop; }
    else if (m) { delete m[key]; if (!Object.keys(m).length) this.previewProps.delete(layerId); }
    this.notifyPreview([layerId]);
  }
  /** the prop the renderer should evaluate: the preview override if any, else the document's */
  renderProp(layer: Layer, key: PropKey): Prop | undefined {
    return this.previewProps.get(layer.id)?.[key] ?? layer.props[key];
  }

  /** redraw only (renderer listeners): no undo, no ui 'doc' event. used by preview overrides */
  notifyPreview(layerIds: Iterable<string>) {
    const c: Change = { structure: false, comp: false, layers: new Set(layerIds), meta: false, assets: false };
    for (const fn of this.listeners) fn(c);
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
      // linked styles and components: unlink hand-edited values, record instance overrides and copy
      // main-component edits into instances, all inside this transaction (one undo step)
      if (tx.undo.length && (this.project.tokens || this.project.components)) {
        tokenTxHook(this.project, tx);
        componentTxHook(this, tx);
      }
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
      const slots = top.slots ??= new WeakMap();
      for (let i = 0; i < tx.undo.length; i++) {
        const o = tx.slotObj[i], k = tx.slotKey[i];
        if (o === undefined) { top.undo.push(tx.undo[i]); top.redo.push(tx.redo[i]); continue; } // op pushed by hand
        let m = slots.get(o);
        const j = m?.get(k);
        if (j !== undefined) { top.redo[j] = tx.redo[i]; continue; }
        if (!m) slots.set(o, (m = new Map()));
        m.set(k, top.redo.length);
        top.undo.push(tx.undo[i]);
        top.redo.push(tx.redo[i]);
      }
      top.id = ++entrySeq;
      const c = top.change, d = tx.change;
      const sameTree = (!c.structure || !!c.sameTree) && (!d.structure || !!d.sameTree);
      c.structure ||= d.structure;
      c.sameTree = c.structure && sameTree; c.comp ||= d.comp; c.meta ||= d.meta; c.assets ||= d.assets;
      for (const id of d.layers) c.layers.add(id);
    } else {
      const d = tx.change;
      let slots: Entry['slots'];
      if (mk) {
        slots = new WeakMap();
        for (let i = 0; i < tx.undo.length; i++) {
          const o = tx.slotObj[i];
          if (o === undefined) continue;
          let m = slots.get(o);
          if (!m) slots.set(o, (m = new Map()));
          m.set(tx.slotKey[i], i); // last write wins
        }
      }
      this.undoStack.push({ id: ++entrySeq, label, mergeKey: mk, undo: tx.undo, redo: tx.redo, selection: this.selection.slice(), change: { ...d, layers: new Set(d.layers) }, slots });
      if (this.undoStack.length > 500) { this.undoStack.shift(); this.dropped++; }
    }
    this.emitChange(tx.change);
    this.emit('history');
  }

  /** run several commands as ONE undo step */
  batch<T>(key: string, fn: () => T, label?: string): T {
    const prev = this.gesture;
    if (prev) return fn();
    const g = key + ':' + Math.random();
    this.gesture = g;
    // entries are counted, not matched by merge key: inner commands may pass their own merge key
    const before = this.undoStack.length;
    try {
      const r = fn();
      const top = this.undoStack[this.undoStack.length - 1];
      if (label && top && this.undoStack.length === before + 1) { top.label = label; this.emit('history'); }
      return r;
    } catch (e) {
      // all or nothing: undo every entry the batch added (merges into older entries can't be split)
      this.gesture = null;
      let n = 0;
      while (this.undoStack.length > before) { this.undo(); n++; }
      if (n) { this.redoStack.splice(this.redoStack.length - n, n); this.emit('history'); }
      throw e;
    } finally { this.gesture = null; }
  }

  /** collapse every undo entry above entry `sinceId` (0 = the bottom) into ONE labeled step: a
   *  group of steps made across several async calls (an agent's storyboard beat), where batch()
   *  can't span the awaits. no-op (returns 0) when `sinceId` is no longer in the stack or nothing
   *  came after it; with one entry it is only relabeled. returns the number of entries merged */
  squashSince(sinceId: number, label: string): number {
    const at = sinceId === 0 ? -1 : this.undoStack.findIndex(e => e.id === sinceId);
    if (sinceId !== 0 && at < 0) return 0;
    const parts = this.undoStack.slice(at + 1);
    if (!parts.length) return 0;
    if (parts.length === 1) { parts[0].label = label; this.emit('history'); return 1; }
    const change: Change = { ...parts[0].change, layers: new Set(parts[0].change.layers) };
    for (const p of parts.slice(1)) {
      const d = p.change;
      const sameTree = (!change.structure || !!change.sameTree) && (!d.structure || !!d.sameTree);
      change.structure ||= d.structure;
      change.sameTree = change.structure && sameTree; change.comp ||= d.comp; change.meta ||= d.meta; change.assets ||= d.assets;
      for (const id of d.layers) change.layers.add(id);
    }
    const merged: Entry = { id: ++entrySeq, label, undo: parts.flatMap(p => p.undo), redo: parts.flatMap(p => p.redo), selection: parts[0].selection, change };
    this.undoStack.splice(at + 1, parts.length, merged);
    this.emit('history');
    return parts.length;
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
  /** id of the top undo entry (0 = empty): identifies the document state exactly, unlike
   *  historyLength (a count: undo agent steps + make as many own edits = same count) */
  get topEntryId() { return this.undoStack[this.undoStack.length - 1]?.id ?? 0; }
  /** undo until entry `id` is on top (0 or an entry that is gone: as far as the stack goes). returns steps undone */
  undoToEntry(id: number) {
    let n = 0;
    while (this.undoStack.length && this.topEntryId !== id) { this.undo(); n++; }
    return n;
  }
  /** redo until entry `id` is on top again; does nothing if `id` is not on the redo stack
   *  (a new edit cleared it). returns steps redone */
  redoToEntry(id: number) {
    if (!this.redoStack.some(e => e.id === id)) return 0;
    let n = 0;
    while (this.redoStack.length && this.topEntryId !== id) { this.redo(); n++; }
    return n;
  }
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

  private afterHistory(e: Entry) {
    const compSwitched = this.ensureActiveComp();
    this.selection = this.selection.filter(id => this.project.layers[id]);
    this.keySelection.clear();
    // invalidate what the step changed (recorded per transaction). invalidating every layer made
    // each undo a full recompile: ~350ms per undo in a 10k layer scene (stress lab undo-storm).
    const c = e.change;
    if (compSwitched) this.emitChange({ structure: true, comp: true, layers: new Set(Object.keys(this.project.layers)), meta: true, assets: true });
    else this.emitChange({ structure: c.structure, sameTree: c.sameTree, comp: c.comp, layers: new Set(c.layers), meta: c.meta, assets: c.assets });
    this.emit('selection');
    this.emit('keys');
    this.emit('history');
  }

  /** replace the whole document (open file) */
  load(project: Project) {
    this.project = project;
    // fields of removed features (0.4: timeline markers) are dropped from older files
    for (const c of Object.values(project.comps)) delete (c as { markers?: unknown }).markers;
    for (const id in project.components ?? {}) rememberTree(project, id);
    this.ensureActiveComp();
    this.workArea = null;
    this.previewProps.clear();
    // fresh objects, never cleared in place: a background document (window tab) may hold the old ones
    this.undoStack = [];
    this.redoStack = [];
    this.dropped = 0;
    this.selection = [];
    this.keySelection = new Set();
    this.solo = new Set();
    this.openComps = [project.activeComp];
    this.time = 0;
    this.emitChange({ structure: true, comp: true, layers: new Set(Object.keys(project.layers)), meta: true, assets: true });
    this.emit('selection');
    this.emit('time');
    this.emit('history');
    this.emit('comps');
  }

  /** everything that belongs to one open document (project, history, selection, playhead, view
   *  state). documents in other window tabs keep this object while they are in the background */
  saveState(): DocState {
    return {
      project: this.project, selection: this.selection, keySelection: this.keySelection, time: this.time, loop: this.loop,
      workArea: this.workArea, solo: this.solo, undo: this.undoStack, redo: this.redoStack, dropped: this.dropped, openComps: this.openComps,
    };
  }

  /** bring a document back (window tab switch): like load() but keeps its history and view state */
  restoreState(d: DocState) {
    this.playing = false;
    this.project = d.project;
    this.selection = d.selection;
    this.keySelection = d.keySelection;
    this.time = d.time;
    this.loop = d.loop;
    this.workArea = d.workArea;
    this.solo = d.solo;
    this.undoStack = d.undo;
    this.redoStack = d.redo;
    this.dropped = d.dropped;
    this.openComps = d.openComps;
    this.gesture = null;
    this.previewProps.clear();
    this.ensureActiveComp();
    this.emitChange({ structure: true, comp: true, layers: new Set(Object.keys(this.project.layers)), meta: true, assets: true });
    this.emit('playing');
    this.emit('selection');
    this.emit('keys');
    this.emit('time');
    this.emit('history');
    this.emit('comps');
    this.emit('workarea');
  }

  /** compositions shown as tabs in the timeline header (view state, not part of the document).
   *  the active comp is always in it */
  openComps: string[] = [];
  /** the open comp tabs that still exist, the active one included */
  compTabs(): string[] {
    const P = this.project;
    const ids = this.openComps.filter(id => P.comps[id]);
    if (!ids.includes(P.activeComp)) ids.push(P.activeComp);
    if (ids.length !== this.openComps.length || ids.some((x, i) => x !== this.openComps[i])) this.openComps = ids;
    return ids;
  }
  /** close a comp tab; closing the active one opens its neighbour. the last tab stays */
  closeCompTab(id: string) {
    const tabs = this.compTabs();
    if (tabs.length <= 1) return;
    const i = tabs.indexOf(id);
    if (i < 0) return;
    this.openComps = tabs.filter(x => x !== id);
    if (id === this.project.activeComp) this.openComp(this.openComps[Math.min(i, this.openComps.length - 1)]);
    else this.emit('comps');
  }

  /** switch the active composition (view state, not an undoable edit) */
  openComp(id: string) {
    if (this.project.comps[id] && !this.openComps.includes(id)) { this.openComps = [...this.compTabs(), id]; if (id === this.project.activeComp) this.emit('comps'); }
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
