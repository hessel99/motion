// recent files for the Home view: a short list (name, path, when, size) in localStorage, and per
// entry the project data + a thumbnail in IndexedDB (no 5 MB localStorage limit, async). in the
// desktop app a recent entry also remembers the file path, so saving keeps going to that file.
// listeners: editor channel 'recent'.

import { editor } from './editor';
import type { Project } from '../core/model';

export interface RecentEntry {
  key: string;
  name: string;
  path: string | null;
  openedAt: number;
  /** "1920×1080 · 4s" */
  info: string;
  /** whether the project data is stored (big projects are not) */
  stored: boolean;
}

const KEY = 'motion.recent';
const MAX = 12;
/** projects above this many layers are listed but not stored (serializing them would hitch) */
const MAX_LAYERS = 4000;

function readList(): RecentEntry[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
let list: RecentEntry[] = readList();

export function recentFiles(): RecentEntry[] { return list; }

function writeList() {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ }
  editor.emit('recent');
}

// ---------------- indexeddb ----------------
let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise(res => {
    try {
      const r = indexedDB.open('motion-recent', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('files'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}
async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise(res => {
    try {
      const tx = d.transaction('files', mode);
      const req = fn(tx.objectStore('files'));
      tx.oncomplete = () => res(req ? (req.result as T) : undefined);
      tx.onerror = tx.onabort = () => res(undefined);
    } catch { res(undefined); }
  });
}

/** the stable key of a project: its file path, else its first composition's id */
export function recentKey(p: Project, path: string | null) {
  return path ?? 'p:' + (Object.keys(p.comps)[0] ?? p.name);
}

/** remember a project (file opened, saved or closed). `thumb`: a png data url of its current frame */
export function rememberRecent(p: Project, path: string | null, thumb?: string) {
  const key = recentKey(p, path);
  const c = p.comps[p.activeComp] ?? Object.values(p.comps)[0];
  const layers = Object.keys(p.layers).length;
  const stored = layers <= MAX_LAYERS;
  const e: RecentEntry = { key, name: p.name || 'Untitled', path, openedAt: Date.now(), info: c ? `${c.width}×${c.height} · ${+c.duration.toFixed(2)}s` : '', stored };
  list = [e, ...list.filter(x => x.key !== key)].slice(0, MAX);
  writeList();
  // the data and thumbnail are written in idle time: serializing a big project is not free
  const write = () => {
    let data: string | null = null;
    if (stored) { try { data = JSON.stringify(p); } catch { /* */ } }
    // no new thumbnail (a file opened, a background tab closed): keep the one stored before,
    // so reopening a recent file doesn't blank its card on Home
    const put = (t: string | null) => idb('readwrite', s => s.put({ data, thumb: t }, key));
    if (thumb !== undefined) void put(thumb);
    else void idb<{ thumb: string | null } | undefined>('readonly', s => s.get(key)).then(old => put(old?.thumb ?? null));
    // entries that fell off the list leave the database too
    void idb<IDBValidKey[]>('readonly', s => s.getAllKeys()).then(keys => {
      const keep = new Set(list.map(x => x.key));
      const gone = (keys ?? []).filter(k => !keep.has(String(k)));
      if (gone.length) void idb('readwrite', s => { for (const k of gone) s.delete(k); });
    });
  };
  'requestIdleCallback' in window ? (window as any).requestIdleCallback(write, { timeout: 2000 }) : setTimeout(write, 50);
}

export async function recentThumb(key: string): Promise<string | null> {
  const v = await idb<{ thumb: string | null } | undefined>('readonly', s => s.get(key));
  return v?.thumb ?? null;
}

export async function recentProject(key: string): Promise<Project | null> {
  const v = await idb<{ data: string | null } | undefined>('readonly', s => s.get(key));
  if (!v?.data) return null;
  try { return JSON.parse(v.data) as Project; } catch { return null; }
}

export function forgetRecent(key: string) {
  list = list.filter(x => x.key !== key);
  writeList();
  void idb('readwrite', s => s.delete(key));
}
