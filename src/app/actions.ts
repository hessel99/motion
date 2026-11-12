// app level actions: files, import/export, clipboard (incl. figma paste), shortcuts.

import { editor } from './editor';
import {
  cloneLayers, deleteLayers, groupLayers, insertLayer, reorder, setEase, setProp, ungroup, valueAt, deleteKeyframes,
  setCompSettings, toggleAnimated, parseKeyId, precompose,
} from '../core/commands';
import { createProject, uid, type Asset, type Layer, type Project } from '../core/model';
import { boundsOf } from '../agent/tools';
import { demoProject, stressProject } from './demo';

// importers are loaded lazily (keeps startup fast; missing modules are simply unavailable)
const mods = import.meta.glob(['../import/figma/index.ts', '../import/svg.ts', '../import/lottie.ts', '../import/aep/index.ts', '../export/lottie.ts']);
async function mod(path: string): Promise<any | null> {
  const m = mods[path];
  return m ? m() : null;
}

/** warm up the importers in idle time so the first paste/drop is instant */
export function preloadImporters() {
  const idle = (cb: () => void) => ('requestIdleCallback' in window ? (window as any).requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 1500));
  idle(() => { mod('../import/figma/index.ts'); mod('../import/svg.ts'); });
}

const st = () => editor.store;
const native = () => (globalThis as any).motionNative as undefined | {
  openFile(o?: any): Promise<{ path: string; name: string; data: string } | null>;
  saveFile(o: any): Promise<string | null>;
  onMenu(cb: (cmd: string) => void): void;
};

let currentPath: string | null = null;

// ---------------- dirty state + window title ----------------
let savedAt = 0; // undo stack length at the last save/open
export function markSaved() { savedAt = st().historyLength; updateTitle(); }
export function isDirty() { return st().historyLength !== savedAt; }
function updateTitle() {
  const name = st().project.name || 'Untitled';
  document.title = `${isDirty() ? '● ' : ''}${name} — Motion`;
}
export function setupTitle() {
  st().on('history', updateTitle);
  st().on('doc', updateTitle);
  editor.on('loaded', () => { savedAt = st().historyLength; updateTitle(); });
  window.addEventListener('beforeunload', e => { if (isDirty() && !(window as any).__noUnloadGuard) { e.preventDefault(); e.returnValue = ''; } });
  updateTitle();
}

export function toast(msg: string, kind: 'info' | 'error' = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), kind === 'error' ? 5000 : 2200);
  setTimeout(() => el.remove(), kind === 'error' ? 5400 : 2600);
}

// ---------------- files ----------------
export function newProject() {
  editor.load(createProject('Untitled'));
  currentPath = null;
}

export function loadDemo() { editor.load(demoProject()); currentPath = null; }

export function loadStress(count: number, kinds?: any[], nested = false) {
  const t0 = performance.now();
  editor.load(stressProject({ count, kinds, nested }));
  currentPath = null;
  toast(`${count} animated layers generated in ${Math.round(performance.now() - t0)}ms`);
}

/** in-app benchmark: plays stress scenes and reports real fps / frame times on this machine */
export async function runBenchmark(onRow?: (row: Record<string, string | number>) => void) {
  const saved = serialize();
  const counts = [1000, 5000, 10000, 25000];
  const rows: Record<string, string | number>[] = [];
  const gl = editor.renderer.gl;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  for (const n of counts) {
    editor.load(stressProject({ count: n }));
    editor.play();
    await new Promise(r => setTimeout(r, 700)); // warm up
    const frames: number[] = [], cpu: number[] = [];
    let last = performance.now();
    await new Promise<void>(res => {
      const end = last + 2500;
      const loop = (now: number) => {
        frames.push(now - last); last = now;
        cpu.push(editor.renderer.stats.frameMs);
        if (now < end) requestAnimationFrame(loop); else res();
      };
      requestAnimationFrame(loop);
    });
    editor.pause();
    const med = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
    const p95 = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length * 0.95)]; };
    const row = { layers: n, fps: +(1000 / med(frames)).toFixed(0), 'p95 frame ms': +p95(frames).toFixed(1), 'cpu ms/frame': +med(cpu).toFixed(2), gpu };
    rows.push(row);
    onRow?.(row);
  }
  editor.load(JSON.parse(saved));
  return rows;
}

export function serialize(): string {
  return JSON.stringify(st().project);
}

export async function saveProject(saveAs = false) {
  const data = serialize();
  const name = (st().project.name || 'Untitled') + '.motion';
  const n = native();
  if (n) {
    const p = await n.saveFile({ defaultPath: saveAs || !currentPath ? name : currentPath, path: saveAs ? undefined : currentPath, data, filters: [{ name: 'Motion project', extensions: ['motion'] }] });
    if (p) { currentPath = p; markSaved(); toast('Saved'); }
    return;
  }
  download(name, data, 'application/json');
  markSaved();
}

export function download(name: string, data: string | Blob, mime: string) {
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function openFileDialog() {
  const n = native();
  if (n) {
    const f = await n.openFile({});
    if (f) await openData(f.name, f.data, f.path);
    return;
  }
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.motion,.json,.aep,.svg,image/*';
  inp.onchange = async () => { for (const f of inp.files ?? []) await openBrowserFile(f); };
  inp.click();
}

export async function openBrowserFile(f: File) {
  const ext = f.name.split('.').pop()!.toLowerCase();
  // svg is "image/svg+xml" but must go to the vector importer, not the bitmap path
  if (ext === 'svg' || f.type === 'image/svg+xml') return importSvgText(await f.text());
  if (ext === 'aep' || f.type.startsWith('image/')) {
    const buf = await f.arrayBuffer();
    if (ext === 'aep') return importAep(buf, f.name);
    return importImage(f);
  }
  return openData(f.name, await f.text());
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}

/** data: text for text formats; base64 for binary (from the electron dialog) */
export async function openData(name: string, data: string, path?: string) {
  const ext = name.split('.').pop()!.toLowerCase();
  try {
    if (ext === 'motion') {
      const p = JSON.parse(data) as Project;
      if (!p.comps || !p.layers) throw new Error('not a motion project');
      editor.load(p);
      currentPath = path ?? null;
      return;
    }
    if (ext === 'json') {
      const json = JSON.parse(data);
      if (json.layers && json.comps) { editor.load(json); currentPath = path ?? null; return; }
      const m = await mod('../import/lottie.ts');
      if (!m) throw new Error('lottie import not available');
      const t0 = performance.now();
      editor.load(m.lottieToProject(json, name.replace(/\.json$/i, '')));
      toast(`Lottie imported in ${Math.round(performance.now() - t0)}ms`);
      return;
    }
    if (ext === 'aep') return importAep(b64ToBuf(data), name);
    if (ext === 'svg') return importSvgText(data);
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
      const blob = new Blob([b64ToBuf(data)], { type: 'image/' + (ext === 'jpg' ? 'jpeg' : ext) });
      return importImage(new File([blob], name, { type: blob.type }));
    }
    throw new Error(`unsupported file type .${ext}`);
  } catch (e: any) {
    console.error(e);
    toast(`Could not open ${name}: ${e.message ?? e}`, 'error');
  }
}

async function importAep(buf: ArrayBuffer, name: string) {
  const m = await mod('../import/aep/index.ts');
  if (!m) { toast('After Effects import not available yet', 'error'); return; }
  try {
    const t0 = performance.now();
    const p: Project = m.aepToProject(buf);
    p.name ||= name.replace(/\.aep$/i, '');
    editor.load(p);
    toast(`After Effects project imported in ${Math.round(performance.now() - t0)}ms`);
  } catch (e: any) {
    console.error(e);
    toast(`Could not import ${name}: ${e.message ?? e}`, 'error');
  }
}

/** gif export with a progress toast; desktop saves into the Motion export folder */
export async function exportGifFile() {
  const { exportGif } = await import('../export/gif');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = 'Exporting GIF…';
  document.body.appendChild(el);
  try {
    const blob = await exportGif({}, (d, n) => { el.textContent = `Exporting GIF… ${Math.round((d / n) * 100)}%`; });
    const name = `${(st().project.name || 'motion').replace(/[^\w\- ]+/g, '_')} - ${st().comp.name}.gif`;
    const nat = native() as any;
    if (nat?.saveExport) {
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const p = await nat.saveExport({ name, data: btoa(bin), encoding: 'base64' });
      toast(`GIF saved: ${p}`);
    } else { download(name, blob, 'image/gif'); toast(`GIF exported (${Math.round(blob.size / 1024)} KB)`); }
    return blob;
  } catch (e: any) {
    toast('GIF export failed: ' + (e?.message ?? e), 'error');
    throw e;
  } finally { el.remove(); }
}

export async function exportLottie() {
  const m = await mod('../export/lottie.ts');
  if (!m) { toast('Lottie export not available yet', 'error'); return; }
  download((st().project.name || 'animation') + '.json', JSON.stringify(m.projectToLottie(st().project)), 'application/json');
}

// ---------------- inserting layers (paste / import) ----------------
export function insertLayers(res: { layers: Layer[]; roots: string[]; assets: Asset[] }, opts: { label: string; fitCompIfEmpty?: boolean }) {
  const s = st();
  if (!res.roots.length) return;
  const byId = new Map(res.layers.map(l => [l.id, l]));
  const wasEmpty = s.comp.root.length === 0;
  // bounding box of the roots (unrotated approx)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of res.roots) {
    const l = byId.get(id)!;
    const p = l.props.position?.v ?? [0, 0], a = l.props.anchor?.v ?? [0, 0], sz = l.props.size?.v ?? [0, 0], sc = l.props.scale?.v ?? [100, 100];
    const lx = p[0] - a[0] * sc[0] / 100, ly = p[1] - a[1] * sc[1] / 100;
    x0 = Math.min(x0, lx); y0 = Math.min(y0, ly);
    x1 = Math.max(x1, lx + sz[0] * Math.abs(sc[0]) / 100); y1 = Math.max(y1, ly + sz[1] * Math.abs(sc[1]) / 100);
  }
  const comp = s.comp;
  let dx = 0, dy = 0;
  const single = res.roots.length === 1 ? byId.get(res.roots[0])! : null;
  const frameToComp = opts.fitCompIfEmpty && wasEmpty && single && single.type === 'group' && single.children.length > 0;
  if (frameToComp) {
    // pasting one frame into an empty project: the frame becomes the composition (figma motion style)
    const sz = single!.props.size!.v;
    setCompSettings(s, { width: Math.round(sz[0]), height: Math.round(sz[1]), name: single!.name });
    const fill = single!.props.fill?.v;
    if (fill && fill[3] > 0) setCompSettings(s, { background: [fill[0], fill[1], fill[2], 1] });
    dx = -x0; dy = -y0;
  } else if (isFinite(x0) && (x0 < 0 || y0 < 0 || x1 > comp.width || y1 > comp.height)) {
    // outside the comp: center it
    dx = comp.width / 2 - (x0 + x1) / 2;
    dy = comp.height / 2 - (y0 + y1) / 2;
  }
  s.transact(opts.label, tx => {
    for (const a of res.assets) tx.set(s.project.assets, a.id, a);
    if (res.assets.length) tx.change.assets = true;
    for (const id of res.roots) {
      const l = byId.get(id)!;
      if (dx || dy) {
        const p = l.props.position!;
        p.v = [p.v[0] + dx, p.v[1] + dy];
        if (p.kf) for (const k of p.kf) k.v = [k.v[0] + dx, k.v[1] + dy];
      }
      const extra = collect(byId, id);
      insertLayer(s, tx, l, null, undefined, extra);
    }
  });
  s.select(res.roots);
}

function collect(byId: Map<string, Layer>, id: string): Layer[] {
  const out: Layer[] = [];
  const walk = (ids: string[]) => { for (const c of ids) { const l = byId.get(c); if (l) { out.push(l); walk(l.children); } } };
  walk(byId.get(id)!.children);
  return out;
}

async function importSvgText(text: string) {
  const m = await mod('../import/svg.ts');
  if (!m) { toast('SVG import not available yet', 'error'); return; }
  const res = m.svgToLayers(text);
  insertLayers(res, { label: 'Import SVG', fitCompIfEmpty: true });
  toast(`Imported ${res.layers.length} layers from SVG`);
}

async function importImage(f: File) {
  const data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(f); });
  const bmp = await createImageBitmap(f);
  const asset: Asset = { id: uid('a'), kind: 'image', mime: f.type, data, width: bmp.width, height: bmp.height };
  const comp = st().comp;
  const sc = Math.min(1, (comp.width * 0.8) / bmp.width, (comp.height * 0.8) / bmp.height);
  const w = bmp.width * sc, h = bmp.height * sc;
  const { createLayer } = await import('../core/model');
  const l = createLayer('image', { x: (comp.width - w) / 2, y: (comp.height - h) / 2, w, h, name: f.name.replace(/\.[^.]+$/, '') });
  l.imageRef = asset.id;
  insertLayers({ layers: [l], roots: [l.id], assets: [asset] }, { label: 'Import image' });
}

// ---------------- clipboard ----------------
const CLIP_PREFIX = 'motion-layers:';
let memClipboard: string | null = null;

function copyPayload(ids: string[]): string {
  const s = st();
  const layers: Layer[] = [];
  const assets = new Set<string>();
  const walk = (id: string) => { const l = s.layer(id)!; layers.push(l); if (l.imageRef) assets.add(l.imageRef); l.children.forEach(walk); };
  const roots = ids.filter(id => s.layer(id) && !ids.some(o => o !== id && s.isAncestor(o, id)));
  roots.forEach(walk);
  // roots are stored in comp space-ish: we copy local values; parent space differences are ignored
  return CLIP_PREFIX + JSON.stringify({ roots, layers, assets: [...assets].map(a => s.project.assets[a]).filter(Boolean) });
}

const KEYS_PREFIX = 'motion-keys:';

/** copied keyframes are stored per property with times relative to the earliest key */
function copyKeysPayload(): string | null {
  const s = st();
  if (!s.keySelection.size) return null;
  const byProp: Record<string, any[]> = {};
  let t0 = Infinity;
  for (const k of s.keySelection) {
    const { layerId, key, index } = parseKeyId(k);
    const f = s.layer(layerId)?.props[key]?.kf?.[index];
    if (!f) continue;
    (byProp[key] ??= []).push(structuredClone(f));
    t0 = Math.min(t0, f.t);
  }
  for (const arr of Object.values(byProp)) for (const f of arr) f.t -= t0;
  return KEYS_PREFIX + JSON.stringify(byProp);
}

/** paste keyframes at the playhead onto the selected layers (same property names) */
function pasteKeys(text: string) {
  const s = st();
  const byProp = JSON.parse(text.slice(KEYS_PREFIX.length)) as Record<string, any[]>;
  if (!s.selection.length) { toast('Select a layer to paste keyframes onto', 'error'); return; }
  let n = 0;
  s.transact('Paste keyframes', tx => {
    for (const id of s.selection) {
      const l = s.layer(id);
      if (!l) continue;
      for (const [key, frames] of Object.entries(byProp)) {
        if (!(key in l.props) && !['position', 'scale', 'rotation', 'opacity', 'anchor'].includes(key)) continue;
        const p = l.props[key as keyof typeof l.props] ?? { v: valueAt(l, key as any, s.time) };
        if (!l.props[key as keyof typeof l.props]) tx.set(l.props, key as any, p);
        const incoming = frames.map(f => ({ ...f, t: s.time + f.t }));
        const rest = (p.kf ?? []).filter(k => !incoming.some(n2 => Math.abs(n2.t - k.t) < 1e-6));
        tx.set(p, 'kf', [...rest, ...incoming].sort((a, b) => a.t - b.t));
        n += incoming.length;
      }
      tx.touch(id);
    }
  });
  toast(`Pasted ${n} keyframes`);
}

export function copySelection(e?: ClipboardEvent) {
  const s = st();
  const keys = copyKeysPayload();
  if (keys) {
    memClipboard = keys;
    if (e?.clipboardData) { e.clipboardData.setData('text/plain', keys); e.preventDefault(); }
    else navigator.clipboard?.writeText(keys).catch(() => {});
    return false; // not a layer copy (cut must not delete layers)
  }
  if (!s.selection.length) return false;
  const payload = copyPayload(s.selection);
  memClipboard = payload;
  if (e?.clipboardData) { e.clipboardData.setData('text/plain', payload); e.preventDefault(); }
  else navigator.clipboard?.writeText(payload).catch(() => {});
  return true;
}

function pasteMotion(text: string) {
  const data = JSON.parse(text.slice(CLIP_PREFIX.length));
  // fresh ids
  const map = new Map<string, string>();
  for (const l of data.layers as Layer[]) map.set(l.id, uid());
  const layers: Layer[] = (data.layers as Layer[]).map(l => ({
    ...structuredClone(l),
    id: map.get(l.id)!,
    parent: l.parent && map.has(l.parent) ? map.get(l.parent)! : null,
    children: l.children.map(c => map.get(c)!).filter(Boolean),
  }));
  const roots = (data.roots as string[]).map(r => map.get(r)!);
  const s = st();
  const offset = roots.every(r => s.comp.root.length) ? 0 : 0;
  void offset;
  insertLayers({ layers, roots, assets: (data.assets ?? []).filter((a: Asset) => !s.project.assets[a.id]) }, { label: 'Paste' });
}

export async function handlePaste(e: ClipboardEvent) {
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  const cd = e.clipboardData;
  if (!cd) return;
  e.preventDefault();
  const html = cd.getData('text/html');
  const textData = cd.getData('text/plain');
  try {
    if (html && /figma|\(figmeta\)/i.test(html)) {
      const m = await mod('../import/figma/index.ts');
      const t0 = performance.now();
      const res = m?.parseFigmaClipboard(html);
      if (res && res.roots.length) {
        insertLayers(res, { label: 'Paste from Figma', fitCompIfEmpty: true });
        toast(`Pasted ${res.layers.length} layers from Figma (${Math.round(performance.now() - t0)}ms)`);
        return;
      }
    }
    if (textData.startsWith(CLIP_PREFIX)) return pasteMotion(textData);
    if (textData.startsWith(KEYS_PREFIX)) return pasteKeys(textData);
    if (/^\s*<svg[\s>]/i.test(textData) || /^\s*<\?xml[\s\S]*<svg/i.test(textData)) return importSvgText(textData);
    for (const item of cd.files) if (item.type.startsWith('image/') || item.name.endsWith('.svg') || item.name.endsWith('.json')) return openBrowserFile(item);
    if (textData.trim().startsWith('{')) {
      const json = JSON.parse(textData);
      if (json.layers && (json.v || json.fr)) return openData('clipboard.json', textData);
    }
    if (memClipboard && !textData) return memClipboard.startsWith(KEYS_PREFIX) ? pasteKeys(memClipboard) : pasteMotion(memClipboard);
    if (html && /figma/i.test(html)) toast('Figma data found but could not be decoded', 'error');
  } catch (err: any) {
    console.error(err);
    toast(`Paste failed: ${err.message ?? err}`, 'error');
  }
}

// ---------------- autosave ----------------
const AUTOSAVE_KEY = 'motion.autosave';
export function setupAutosave() {
  let timer = 0;
  const save = () => {
    const nat = native() as any;
    if (nat?.autosaveWrite) { Promise.resolve(nat.autosaveWrite(serialize())).catch(() => {}); return; } // desktop: file in app data, any size
    // big projects don't fit local storage anyway (~5MB): skip instead of serializing megabytes on the main thread
    if (Object.keys(st().project.layers).length > 1500) return;
    try {
      const s = serialize();
      if (s.length < 4_000_000) localStorage.setItem(AUTOSAVE_KEY, s);
    } catch { /* quota */ }
  };
  st().on('doc', () => {
    clearTimeout(timer);
    // save when the user pauses editing, in idle time
    timer = window.setTimeout(() => ('requestIdleCallback' in window ? (window as any).requestIdleCallback(save, { timeout: 3000 }) : save()), 1200);
  });
}
export async function restoreAutosaveNative(): Promise<boolean> {
  const nat = native() as any;
  if (!nat?.autosaveRead) return false;
  try {
    const s = await nat.autosaveRead();
    if (!s) return false;
    const p = JSON.parse(s);
    if (!p.comps || !p.layers) return false;
    editor.load(p);
    return true;
  } catch { return false; }
}

export function restoreAutosave(): boolean {
  try {
    const s = localStorage.getItem(AUTOSAVE_KEY);
    if (!s) return false;
    const p = JSON.parse(s);
    if (!p.comps || !p.layers) return false;
    editor.load(p);
    return true;
  } catch { return false; }
}

// ---------------- keyboard ----------------
export function setupShortcuts(hooks: { fit(): void; zoom(f: number): void; toggleAgent(): void; editText(id: string): void }) {
  window.addEventListener('copy', e => { if (!isTyping(e)) copySelection(e); });
  window.addEventListener('cut', e => {
    if (isTyping(e)) return;
    const keys = [...st().keySelection];
    if (copySelection(e)) deleteLayers(st(), st().selection);
    else if (keys.length) deleteKeyframes(st(), keys);
  });
  window.addEventListener('paste', e => handlePaste(e));
  window.addEventListener('keydown', e => {
    if (isTyping(e)) return;
    const s = st();
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const run = (fn: () => void) => { e.preventDefault(); fn(); };
    if (mod && k === 'z') return run(() => (e.shiftKey ? s.redo() : s.undo()));
    if (mod && k === 'y') return run(() => s.redo());
    if (mod && k === 's') return run(() => saveProject(e.shiftKey));
    if (mod && k === 'o') return run(() => openFileDialog());
    if (mod && k === 'd') return run(() => cloneLayers(s, s.selection, 10));
    if (mod && e.shiftKey && k === 'c') return run(() => { try { precompose(s, s.selection); } catch (err: any) { toast(err.message, 'error'); } });
    if (mod && k === 'a') return run(() => s.select(s.comp.root.slice()));
    if (mod && k === 'g') return run(() => {
      try { e.shiftKey ? s.selection.forEach(id => ungroup(s, id)) : s.selection.length && groupLayers(s, s.selection, boundsOf(s.selection)); }
      catch (err: any) { toast(err.message, 'error'); }
    });
    if (mod && k === ']') return run(() => reorder(s, s.selection, e.altKey ? 'top' : 'up'));
    if (mod && k === '[') return run(() => reorder(s, s.selection, e.altKey ? 'bottom' : 'down'));
    if (mod && (k === '=' || k === '+')) return run(() => hooks.zoom(1.25));
    if (mod && k === '-') return run(() => hooks.zoom(0.8));
    if (mod && k === '0') return run(() => hooks.fit());
    if (mod && k === 'i') return run(() => hooks.toggleAgent());
    if (mod) return;
    if (e.key === '?') return run(() => editor.emit('help'));
    if (e.code === 'Space') return run(() => editor.togglePlay());
    if (k === 'delete' || k === 'backspace') return run(() => (s.keySelection.size ? deleteKeyframes(s, [...s.keySelection]) : deleteLayers(s, s.selection)));
    if (k === 'escape') return run(() => { if (s.keySelection.size) { s.keySelection.clear(); s.emit('keys'); } else s.select([]); editor.setTool('select'); });
    if (k === 'v') return run(() => editor.setTool('select'));
    if (k === 'r') return run(() => editor.setTool('rect'));
    if (k === 'o' || k === 'e') return run(() => editor.setTool('ellipse'));
    if (k === 't') return run(() => editor.setTool('text'));
    if (k === 'p' && !e.shiftKey) return run(() => editor.setTool('pen'));
    if (k === 'h') return run(() => editor.setTool('hand'));
    if (k === 'b' || k === 'n') return run(() => {
      const wa = s.workArea ?? [0, s.comp.duration];
      s.workArea = k === 'b' ? [Math.min(s.time, wa[1] - 1 / s.comp.fps), wa[1]] : [wa[0], Math.max(s.time, wa[0] + 1 / s.comp.fps)];
      s.emit('workarea');
      toast(`Preview range ${s.workArea[0].toFixed(2)}s – ${s.workArea[1].toFixed(2)}s`);
    });
    if (k === 'home') return run(() => s.setTime(s.workArea?.[0] ?? 0));
    if (k === 'end') return run(() => s.setTime(s.comp.duration));
    if (k === ',' || k === 'pageup') return run(() => editor.stepFrames(e.shiftKey ? -10 : -1));
    if (k === '.' || k === 'pagedown') return run(() => editor.stepFrames(e.shiftKey ? 10 : 1));
    if (k === 'enter' && s.selection.length === 1 && s.layer(s.selection[0])?.type === 'text') return run(() => hooks.editText(s.selection[0]));
    if (e.key === 'F9') return run(() => setEase(s, [...s.keySelection], 'Easy Ease'));
    if (k === 'j' || k === 'k') {
      // jump to previous / next keyframe of selection (after effects)
      return run(() => {
        const times = new Set<number>();
        for (const id of s.selection.length ? s.selection : Object.keys(s.project.layers)) {
          const l = s.layer(id);
          if (l) for (const p of Object.values(l.props)) p?.kf?.forEach(f => times.add(f.t));
        }
        const sorted = [...times].sort((a, b) => a - b);
        const t = k === 'j' ? [...sorted].reverse().find(x => x < s.time - 1e-6) : sorted.find(x => x > s.time + 1e-6);
        if (t !== undefined) s.setTime(t);
      });
    }
    // after effects-style property shortcuts: P S R T A add a keyframe on that property
    const propKeys: Record<string, any> = { p: 'position', s: 'scale', a: 'anchor' };
    if (e.shiftKey && propKeys[k] && s.selection.length) return run(() => toggleAnimated(s, s.selection, propKeys[k]));
    if (k.startsWith('arrow') && s.selection.length) {
      return run(() => {
        const d = e.shiftKey ? 10 : 1;
        const dx = k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0;
        const dy = k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0;
        for (const id of s.selection) {
          const l = s.layer(id);
          if (!l || l.locked) continue;
          const p = valueAt(l, 'position', s.time);
          setProp(s, id, 'position', [p[0] + dx, p[1] + dy], { mergeKey: 'nudge:' + s.selection.join(',') + ':' + s.time });
        }
      });
    }
  });
  native()?.onMenu(cmd => {
    if (cmd === 'new') newProject();
    else if (cmd === 'open' || cmd === 'import') openFileDialog();
    else if (cmd === 'save') saveProject(false);
    else if (cmd === 'saveAs') saveProject(true);
    else if (cmd === 'export-lottie') exportLottie();
  });
}

function isTyping(e: Event) {
  const t = e.target as HTMLElement;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
