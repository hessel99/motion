// Renderer side of app updates: mirrors the main-process updater state (electron/updates/) for
// Settings → Updates and the small "update ready" notice, and reports busy work (exports) so an
// update is never checked for or installed in the middle of one. No-op in the browser build.

export interface UpdateInfo { version: string; notes: string; date: string | null; kind: 'ui' | 'shell'; manual?: boolean }
export interface UpdateStatus {
  enabled: boolean; disabledReason: string | null; releasesUrl: string | null;
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'up-to-date' | 'error';
  shellVersion: string; bundledVersion: string; uiVersion: string; uiSource: 'bundled' | 'downloaded';
  channel: 'stable' | 'beta'; auto: boolean; lastCheck: number;
  progress: { received: number; total: number } | null;
  available: UpdateInfo | null; ready: UpdateInfo | null; error: string | null;
  notice: { kind: 'rolled-back' | 'revoked'; version: string; text: string } | null;
  shellSupported: boolean; shellBlocked: string | null; busy?: string[];
}

interface NativeUpdates {
  appReady(): void; state(): Promise<UpdateStatus>; check(): Promise<UpdateStatus>;
  setPrefs(p: { channel?: 'stable' | 'beta'; auto?: boolean }): Promise<UpdateStatus>;
  setBusy(reason: string, on: boolean): Promise<boolean>; restart(): Promise<{ ok: boolean; error?: string }>;
  revertUi(): Promise<UpdateStatus>; onState(cb: (s: UpdateStatus) => void): () => void;
}
const api = (): NativeUpdates | undefined => (globalThis as any).motionNative?.updates;
export const updatesAvailable = () => !!api();

let status: UpdateStatus | null = null;
const listeners = new Set<(s: UpdateStatus | null) => void>();
let subscribed = false;
const set = (s: UpdateStatus | null) => { status = s; listeners.forEach(f => f(s)); };

export function getUpdateStatus() { return status; }
export function onUpdateStatus(fn: (s: UpdateStatus | null) => void): () => void {
  listeners.add(fn);
  const a = api();
  if (a && !subscribed) {
    subscribed = true;
    a.onState(set);
    a.state().then(set, () => {});
  }
  return () => { listeners.delete(fn); };
}

/** call once the editor has rendered: tells the updater that this interface version starts fine */
export function signalAppReady() { try { api()?.appReady(); } catch { /* */ } }

export const checkForUpdates = async () => { const a = api(); if (a) set(await a.check()); };
export const setUpdatePrefs = async (p: { channel?: 'stable' | 'beta'; auto?: boolean }) => { const a = api(); if (a) set(await a.setPrefs(p)); };
export const revertUi = async () => { const a = api(); if (a) set(await a.revertUi()); };

// ---------------- busy work: exports ----------------
const busy = new Set<string>();
export function setBusy(reason: string, on: boolean) {
  on ? busy.add(reason) : busy.delete(reason);
  api()?.setBusy(reason, on).catch(() => {});
  listeners.forEach(f => f(status));
}
export const isBusy = () => busy.size > 0;

/** "Restart to update": refuses while exporting; saves the autosave copy first */
export async function restartToUpdate(flush?: () => Promise<unknown> | void): Promise<string | null> {
  const a = api();
  if (!a) return 'Updates only work in the desktop app';
  if (isBusy()) return 'Finish the export first';
  try { await flush?.(); } catch { /* the native unsaved-changes dialog still protects the work */ }
  const r = await a.restart();
  return r.ok ? null : r.error || 'Could not restart';
}

export function formatBytes(n: number) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
