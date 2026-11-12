// open documents (window tabs). one Store serves the active document; a background document keeps
// its whole editor state (project, undo/redo, selection, playhead, comp tabs, canvas view) as a
// plain object (Store.saveState), so switching tabs swaps that object back in: no reload, no
// re-parse, the undo history survives. the renderer, timeline and panels follow through the usual
// store channels plus editor 'loaded' (with `switching` set, so nothing treats it as a new file).
// listeners: editor channel 'docs' (tab list, active tab, dirty dots).

import { editor } from './editor';
import type { DocState } from '../core/store';
import { createProject, type Project } from '../core/model';
import { rememberRecent } from './recent';

export interface Doc {
  id: string;
  /** null while the document is the active one (its state lives in the store) */
  state: DocState | null;
  /** file on disk (desktop app) */
  path: string | null;
  /** id of the top undo entry at the last save / open */
  savedAt: number;
  /** canvas view to restore on switch */
  view: { zoom: number; panX: number; panY: number } | null;
  /** serialized project of a background document for autosave (background documents don't change) */
  json: string | null;
}

let seq = 0;
const docs: Doc[] = [];
let active: Doc | null = null;
/** true while a tab switch emits 'loaded' */
export let switching = false;
/** the path the next load belongs to (openProject) */
let pendingPath: string | null = null;

const vp = () => (globalThis as any).viewport as { zoom: number; panX: number; panY: number; setView(z: number, x: number, y: number): void } | undefined;

export function documents(): readonly Doc[] { return docs; }
export function activeDoc(): Doc | null { return active; }

export function docProject(d: Doc): Project { return d.state ? d.state.project : editor.store.project; }
export function docName(d: Doc) { return docProject(d).name || 'Untitled'; }

export function isDocDirty(d: Doc | null = active): boolean {
  if (!d) return false;
  if (!d.state) return editor.store.topEntryId !== d.savedAt;
  const u = d.state.undo;
  return (u[u.length - 1]?.id ?? 0) !== d.savedAt;
}

function emit() { editor.emit('docs'); }

/** a tab that was never touched: a new file can take its place instead of opening another tab */
function pristine(d: Doc) {
  const s = editor.store;
  return !d.state && !d.path && s.historyLength === 0 && Object.keys(s.project.layers).length === 0;
}

/** every editor.load() lands in the active tab (a new one when none is open) */
export function setupDocuments() {
  editor.on('loaded', () => {
    if (switching) return;
    if (!active) { active = { id: 'd' + ++seq, state: null, path: null, savedAt: 0, view: null, json: null }; docs.push(active); }
    active.path = pendingPath;
    active.savedAt = editor.store.topEntryId;
    pendingPath = null;
    emit();
    editor.emit('doc-open');
  });
  editor.store.on('history', () => { if (active) emit(); });
  editor.store.on('doc', () => { if (active) active.json = null; });
}

function park() {
  if (!active) return;
  editor.pause();
  const v = vp();
  active.view = v ? { zoom: v.zoom, panX: v.panX, panY: v.panY } : null;
  active.state = editor.store.saveState();
}

/** open a project in a new tab (or in the active tab when that one is empty and untouched) */
export function openProject(p: Project, path: string | null = null) {
  if (active && !pristine(active)) { park(); active = null; }
  pendingPath = path;
  editor.load(p);
  if (path || Object.keys(p.layers).length) rememberRecent(p, path);
}

/** a new, empty document in its own tab */
export function newDocument(init?: { name?: string; width?: number; height?: number; fps?: number; duration?: number }) {
  const p = createProject(init?.name ?? 'Untitled');
  const c = p.comps[p.activeComp];
  if (init?.width) c.width = init.width;
  if (init?.height) c.height = init.height;
  if (init?.fps) c.fps = init.fps;
  if (init?.duration) c.duration = init.duration;
  // always its own tab (opening a file may take the place of an untouched one: openProject)
  if (active) { park(); active = null; }
  pendingPath = null;
  editor.load(p);
}

export function switchTo(id: string) {
  const d = docs.find(x => x.id === id);
  if (!d || d === active) return;
  park();
  active = d;
  const st = d.state!;
  d.state = null;
  d.json = null;
  switching = true;
  try {
    editor.store.restoreState(st);
    editor.emit('loaded');
    if (d.view) vp()?.setView(d.view.zoom, d.view.panX, d.view.panY);
  } finally { switching = false; }
  emit();
  editor.emit('doc-open');
}

/** next / previous tab (ctrl+tab) */
export function cycleDocs(dir: 1 | -1) {
  if (docs.length < 2 || !active) return;
  const i = docs.indexOf(active);
  switchTo(docs[(i + dir + docs.length) % docs.length].id);
}

/** drag a tab to another place */
export function moveDoc(id: string, to: number) {
  const i = docs.findIndex(x => x.id === id);
  if (i < 0) return;
  const [d] = docs.splice(i, 1);
  docs.splice(Math.max(0, Math.min(docs.length, to)), 0, d);
  emit();
}

/** how a dirty document is closed: the ui registers a dialog (Save / Don't save / Cancel) and the
 *  save action (setCloseGuard); without one (tests, early startup) the browser confirm is used */
export type CloseAnswer = 'save' | 'discard' | 'cancel';
let closeGuard: { ask: (name: string) => Promise<CloseAnswer>; save: () => Promise<void> } | null = null;
export function setCloseGuard(g: typeof closeGuard) { closeGuard = g; }

/** close a tab. asks first when it has unsaved changes (save, don't save or cancel). resolves to
 *  false when the user kept it */
export async function closeDoc(id: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const d = docs.find(x => x.id === id);
  if (!d) return true;
  if (!opts.force && isDocDirty(d) && !navigator.webdriver && !(window as any).__noUnloadGuard) {
    const answer: CloseAnswer = closeGuard
      ? await closeGuard.ask(docName(d))
      : window.confirm(`“${docName(d)}” has unsaved changes. Close it without saving?`) ? 'discard' : 'cancel';
    if (answer === 'cancel') return false;
    if (answer === 'save') {
      if (d !== active) switchTo(d.id);
      await closeGuard!.save();
      // the save dialog was cancelled: keep the file open
      if (isDocDirty(d)) return false;
    }
    if (!docs.includes(d)) return true;
  }
  if (d === active) {
    // the closing document goes to the recent files with a fresh thumbnail
    try {
      const p = editor.store.project;
      if (d.path || Object.keys(p.layers).length) rememberRecent(p, d.path, editor.renderer.snapshot(editor.store.time, 360));
    } catch { /* no renderer yet */ }
    const i = docs.indexOf(d);
    const next = docs[i + 1] ?? docs[i - 1];
    if (next) switchTo(next.id);
    else {
      // last tab: an empty store behind the Home view
      docs.splice(i, 1);
      active = null;
      switching = true;
      try { editor.store.load(createProject('Untitled')); editor.emit('loaded'); } finally { switching = false; }
      emit();
      editor.emit('home');
      return true;
    }
  } else if (d.state) {
    const p = d.state.project;
    if (d.path || Object.keys(p.layers).length) rememberRecent(p, d.path);
  }
  docs.splice(docs.indexOf(d), 1);
  emit();
  return true;
}

/** autosave payload: every open document (background ones from their cached json) */
export function serializeSession(serialize: () => string): string {
  if (!docs.length) return JSON.stringify({ session: 1, docs: [], active: 0 });
  const out = docs.map(d => {
    if (!d.state) return serialize();
    return d.json ??= JSON.stringify(d.state.project);
  });
  return `{"session":1,"active":${active ? docs.indexOf(active) : 0},"paths":${JSON.stringify(docs.map(d => d.path))},"docs":[${out.join(',')}]}`;
}

/** reopen an autosaved session (all tabs, the active one last so it ends up in front) */
export function restoreSession(data: any): boolean {
  if (data?.session !== 1 || !Array.isArray(data.docs)) {
    if (!data?.comps || !data?.layers) return false;
    editor.load(data);
    return true;
  }
  const projects = (data.docs as Project[]).filter(p => p?.comps && p?.layers);
  if (!projects.length) return false;
  const paths: (string | null)[] = data.paths ?? [];
  projects.forEach((p, i) => {
    if (active) { park(); active = null; }
    pendingPath = paths[i] ?? null;
    editor.load(p);
  });
  const want = docs[Math.min(projects.length - 1, Math.max(0, data.active | 0))];
  if (want) switchTo(want.id);
  return true;
}
