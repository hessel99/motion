// style library flows that need the app (files, urls, figma api, desktop file watching).
// everything ends in a SyncPlan shown in the review dialog (ui/LibraryPanel.tsx → SyncReview);
// nothing changes the document before the user clicks "Update".

import { editor } from './editor';
import { toast } from './actions';
import { applySync, exportTokenFile, parseTokenFile, planIsEmpty, planSync, summarizePlan, type SyncPlan } from '../core/token-sync';
import type { TokenSource } from '../core/model';

const st = () => editor.store;
const native = () => (window as any).motionNative as any;

export interface PendingSync { plan: SyncPlan; source: Omit<TokenSource, 'id'>; auto?: boolean }

/** the plan waiting for review (one at a time). the review dialog listens on editor 'sync' */
export let pendingSync: PendingSync | null = null;
export function reviewSync(p: PendingSync | null) { pendingSync = p; editor.emit('sync'); }

export function confirmSync() {
  const p = pendingSync;
  if (!p) return;
  applySync(st(), p.plan, p.source);
  toast(`Styles updated: ${summarizePlan(p.plan)} (undo with ⌘Z)`);
  reviewSync(null);
}

/** parse + plan, then show the review (or say it's all up to date) */
export function planFromText(text: string, source: Omit<TokenSource, 'id'>, opts: { quietIfSame?: boolean } = {}) {
  let incoming;
  try { incoming = parseTokenFile(JSON.parse(text)); } catch (e: any) { toast(`Could not read ${source.label}: ${e.message ?? e}`, 'error'); return; }
  if (!incoming.length) { toast(`${source.label} has no colors or numbers`, 'error'); return; }
  const plan = planSync(st().project, incoming, { from: source.location, removeMissing: true });
  if (planIsEmpty(plan)) {
    if (!opts.quietIfSame) toast(`${source.label}: everything is up to date`);
    // remember the source even when nothing changed (so "Sync now" is offered)
    if (!st().project.tokens?.sources?.some(s => s.location === source.location)) applySync(st(), plan, source);
    return;
  }
  reviewSync({ plan, source });
}

/** pick a tokens file (W3C / Tokens Studio / Figma variables export). the desktop app remembers the
 *  path and watches it: saving the file shows the review again */
export async function importTokensFile() {
  const n = native();
  if (n?.openFile) {
    const f = await n.openFile({ filters: [{ name: 'Design tokens', extensions: ['json'] }] });
    if (!f) return;
    planFromText(f.data, { kind: 'file', label: f.name, location: f.path });
    watchSource(f.path);
    return;
  }
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const file = inp.files?.[0];
    if (!file) return;
    planFromText(await file.text(), { kind: 'file', label: file.name, location: file.name });
  };
  inp.click();
}

export async function syncFromUrl(url?: string) {
  url ??= prompt('Tokens file URL (W3C Design Tokens or Tokens Studio JSON, e.g. a raw GitHub link)') ?? undefined;
  if (!url) return;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    planFromText(await r.text(), { kind: 'url', label: url.split('/').pop() || url, location: url });
  } catch (e: any) { toast(`Could not load ${url}: ${e.message ?? e}`, 'error'); }
}

const FIGMA_TOKEN_KEY = 'motion.figmaToken';
/** figma REST variables api (Enterprise plans; needs a personal access token with file_variables:read).
 *  the token stays in this browser (local storage), never in the project file */
export async function syncFromFigmaApi(fileKey?: string) {
  fileKey ??= prompt('Figma file link or key (the library with your variables)') ?? undefined;
  if (!fileKey) return;
  const m = /figma\.com\/(?:file|design)\/([A-Za-z0-9]+)/.exec(fileKey);
  const key = m ? m[1] : fileKey.trim();
  let token = '';
  try { token = localStorage.getItem(FIGMA_TOKEN_KEY) ?? ''; } catch { /* */ }
  if (!token) {
    token = prompt('Figma personal access token (scope: file_variables:read). Stored only on this computer.') ?? '';
    if (!token) return;
    try { localStorage.setItem(FIGMA_TOKEN_KEY, token); } catch { /* */ }
  }
  try {
    const r = await fetch(`https://api.figma.com/v1/files/${encodeURIComponent(key)}/variables/local`, { headers: { 'X-Figma-Token': token } });
    if (r.status === 403) throw new Error('access denied: the variables API needs a Figma Enterprise plan and a token with file_variables:read');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    planFromText(await r.text(), { kind: 'figma-api', label: 'Figma variables', location: key });
  } catch (e: any) { toast(`Figma sync failed: ${e.message ?? e}`, 'error'); }
}

/** re-read a remembered source */
export async function syncSource(s: TokenSource) {
  if (s.kind === 'url') return syncFromUrl(s.location);
  if (s.kind === 'figma-api') return syncFromFigmaApi(s.location);
  const n = native();
  if (n?.readTextFile) {
    try { planFromText(await n.readTextFile(s.location), { kind: 'file', label: s.label, location: s.location }); }
    catch (e: any) { toast(`Could not read ${s.location}: ${e.message ?? e}`, 'error'); }
    return;
  }
  importTokensFile(); // browser: files can't be re-read without asking
}

// ---------------- desktop: watch token files ----------------
const watched = new Set<string>();
let unsub: (() => void) | null = null;
function watchSource(path: string) {
  const n = native();
  if (!n?.watchFile || watched.has(path)) return;
  watched.add(path);
  n.watchFile(path);
  unsub ??= n.onFileChanged?.((p: string, data: string) => {
    const src = st().project.tokens?.sources?.find(s => s.location === p);
    if (!src) return;
    planFromText(data, { kind: 'file', label: src.label, location: p }, { quietIfSame: true });
  }) ?? null;
}
/** after opening a project: watch its file sources again */
export function watchProjectSources() {
  for (const s of st().project.tokens?.sources ?? []) if (s.kind === 'file' && s.location.includes('/')) watchSource(s.location);
}

export function exportTokens() {
  const lib = st().project.tokens;
  if (!lib || !Object.keys(lib.items).length) { toast('No styles to export yet', 'error'); return; }
  const blob = new Blob([JSON.stringify(exportTokenFile(lib), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${st().project.name || 'styles'}.tokens.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
