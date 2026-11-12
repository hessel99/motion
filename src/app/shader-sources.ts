// figma shader sources in the editor: pasted / opened designs reference figma shaders whose source
// figma's data never carries. this asks the bridge (bridge/figma-shaders.mjs: figma's mcp server or
// claude code's, with an app-level cache) for every library entry without source, fills it in when
// it arrives and re-renders. sources are not undoable content: they are written into the library
// directly, outside the undo history (the paste stays one undo step).

import { agentClient } from '../agent/client';
import type { Layer, Prop } from '../core/model';
import { flattenValue, makeShaderAsset, MOUSE_PARAM, SHADER_MAIN, shaderPropKey, shaderRefs, type ShaderAsset, type ShaderKind, type ShaderRef } from '../core/shaders';
import type { Store } from '../core/store';

export interface FigmaStatus { figma: 'connected' | 'disconnected'; claude: boolean; encrypted: boolean; error: string; cacheDir?: string }
export type SourceState = { state: 'fetching' } | { state: 'error'; error: string } | { state: 'done'; via: string; warning?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** the request the bridge resolves for a library entry without source */
export function sourceRequest(a: ShaderAsset): { id?: string; hash?: string; version?: string; kind: ShaderKind; name?: string; params: string[] } {
  return {
    ...(UUID.test(a.id) ? { id: a.id } : { hash: a.id }),
    version: a.version,
    kind: a.kind,
    name: a.name && a.name !== 'Shader' ? a.name : undefined,
    params: a.params.filter(p => p.key !== MOUSE_PARAM).map(p => p.key),
  };
}

/** put a fetched / imported source into the library entry `key` and rebuild the params of every
 *  layer that uses it (schema from the source). no undo entry. returns the touched layer ids */
export function applySource(store: Store, key: string, src: { id?: string; name?: string; kind?: ShaderKind; version?: string; description?: string; files: Record<string, string> }): string[] {
  const P = store.project;
  const prev = P.shaders?.[key];
  const kind = (src.kind ?? prev?.kind ?? 'fill') as ShaderKind;
  const asset = makeShaderAsset({ id: prev?.id ?? src.id ?? key, name: src.name ?? prev?.name, kind, version: prev?.version ?? src.version, description: src.description, files: src.files });
  P.shaders ??= {};
  P.shaders[key] = asset;
  const touched: string[] = [];
  for (const l of Object.values(P.layers)) {
    let hit = false;
    for (const { ref } of shaderRefs(l)) {
      if (ref.shader !== key && ref.asset?.id !== asset.id) continue;
      if (ref.asset) { ref.shader = key; delete ref.asset; }
      rebuildProps(l, ref, asset);
      hit = true;
    }
    if (hit) touched.push(l.id);
  }
  return touched;
}

function rebuildProps(l: Layer, ref: ShaderRef, a: ShaderAsset) {
  const props = l.props as Record<string, Prop | undefined>;
  for (const d of a.params) {
    const k = shaderPropKey(ref.slot, d.key);
    const want = flattenValue(d, ref.init?.[d.key]);
    const cur = props[k];
    // keep keyframes / expressions the user added, as long as the shape of the value still fits
    if (cur && cur.v.length === want.length && (cur.kf?.length || cur.expr || !ref.init)) continue;
    props[k] = { v: want };
  }
  delete ref.init;
}

function notify(msg: string, kind: 'info' | 'error' = 'info') {
  if (typeof document === 'undefined') return;
  void import('./actions').then(a => a.toast(msg, kind)).catch(() => {});
}

class ShaderSources {
  status: FigmaStatus | null = null;
  readonly states = new Map<string, SourceState>();
  private listeners = new Set<() => void>();
  private reqs = new Map<number, (m: any) => void>();
  private seq = 1;
  private store: Store | null = null;
  private started = false;

  on(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { this.listeners.forEach(f => f()); }

  /** wire to the bridge and watch the document (called once by the editor) */
  start(store: Store) {
    if (this.started) return;
    this.started = true;
    this.store = store;
    agentClient.listen(m => this.handle(m));
    agentClient.on(() => { if (agentClient.status === 'connected') { this.refresh(); this.resolveMissing(); } });
    store.onChange(c => { if (c.structure || c.layers.size) queueMicrotask(() => this.resolveMissing()); });
  }

  private handle(m: any) {
    if (m.type === 'figma_status') { const { type: _t, ...s } = m; this.status = s; this.emit(); }
    else if (m.type === 'figma_connect') {
      if (m.error) { this.status = { ...(this.status ?? { figma: 'disconnected', claude: false, encrypted: false }), error: m.error } as FigmaStatus; this.emit(); }
      else if (m.url) window.open(m.url, '_blank', 'noopener'); // electron: the system browser
      else this.refresh();
    } else if (m.type === 'shader_fetch_result') {
      const f = this.reqs.get(m.reqId);
      this.reqs.delete(m.reqId);
      f?.(m);
    }
  }

  refresh() { agentClient.post({ type: 'figma_status' }); }
  connect() { if (!agentClient.post({ type: 'figma_connect' })) this.status = { figma: 'disconnected', claude: false, encrypted: false, error: 'the agent bridge is offline' }; this.emit(); }
  disconnect() { agentClient.post({ type: 'figma_disconnect' }); }

  /** library entries (and pasted refs) without source */
  missing(store: Store): { key: string; asset: ShaderAsset }[] {
    const out = new Map<string, ShaderAsset>();
    for (const [k, a] of Object.entries(store.project.shaders ?? {})) if (!a.files[SHADER_MAIN]) out.set(k, a);
    for (const l of Object.values(store.project.layers)) for (const { ref } of shaderRefs(l)) if (ref.asset && !ref.asset.files[SHADER_MAIN] && !out.has(ref.shader)) out.set(ref.shader, ref.asset);
    return [...out].map(([key, asset]) => ({ key, asset }));
  }

  /** ask the bridge for every missing source (deduplicated; errors are retried after a reconnect) */
  resolveMissing() {
    const store = this.store;
    if (!store || agentClient.status !== 'connected') return;
    let started = 0;
    for (const { key, asset } of this.missing(store)) {
      const st = this.states.get(key);
      if (st?.state === 'fetching' || st?.state === 'error') continue;
      this.states.set(key, { state: 'fetching' });
      const reqId = this.seq++;
      this.reqs.set(reqId, m => {
        if (!m.ok) this.states.set(key, { state: 'error', error: m.error });
        else {
          const touched = applySource(store, key, m.shader);
          this.states.set(key, { state: 'done', via: m.shader.via, warning: m.shader.warning });
          store.notifyExternal(touched);
          if (m.shader.warning) notify(`${m.shader.name ?? 'Shader'}: ${m.shader.warning}`);
        }
        this.batchDone(m.ok);
        this.emit();
      });
      if (!agentClient.post({ type: 'shader_fetch', reqId, req: sourceRequest(asset) })) { this.states.delete(key); this.reqs.delete(reqId); }
      else started++;
    }
    if (started) {
      // (fetches from cache come back at once: say something only for real waits)
      this.batch.left += started;
      if (!this.batch.timer) this.batch.timer = setTimeout(() => { this.batch.timer = 0; if (this.batch.left > 0) { this.batch.announced = true; notify(this.batch.left === 1 ? 'Fetching a shader from Figma…' : `Fetching ${this.batch.left} shaders from Figma…`); } }, 400);
    }
    this.emit();
  }

  private batch = { left: 0, ok: 0, failed: 0, announced: false, timer: 0 as ReturnType<typeof setTimeout> | 0 };
  private batchDone(ok: boolean) {
    const b = this.batch;
    b.left = Math.max(0, b.left - 1);
    if (ok) b.ok++; else b.failed++;
    if (b.left) return;
    if (b.failed) notify(b.failed === 1 && !b.ok ? 'A shader could not be fetched: it shows as a placeholder (see the layer’s shader panel)' : `${b.failed} shader${b.failed > 1 ? 's' : ''} could not be fetched: shown as placeholders`, 'error');
    else if (b.announced) notify(b.ok === 1 ? 'Shader loaded' : `${b.ok} shaders loaded`);
    b.ok = b.failed = 0; b.announced = false;
  }

  /** retry the failed ones (after connecting figma) */
  retry() { for (const [k, s] of this.states) if (s.state === 'error') this.states.delete(k); this.resolveMissing(); }

  /** "Import shader…": the user hands the files. they fill the missing entry they match (by
   *  name or params), else join the library as a new shader. returns the library key */
  importFiles(store: Store, files: Record<string, string>, target?: string): string {
    const probe = makeShaderAsset({ id: 'import', kind: 'fill', files });
    if (!files[SHADER_MAIN]) throw new Error('main.ts is missing');
    let key = target;
    if (!key) {
      const names = new Set(probe.params.map(p => p.key));
      let best = -1;
      for (const m of this.missing(store)) {
        const score = (m.asset.name && m.asset.name === probe.name ? 10 : 0) + m.asset.params.filter(p => names.has(p.key)).length / Math.max(1, m.asset.params.length);
        if (score > best && score >= 0.6) { best = score; key = m.key; }
      }
    }
    if (key) {
      const touched = applySource(store, key, { files, name: probe.name });
      this.states.set(key, { state: 'done', via: 'import' });
      const a = store.project.shaders![key];
      agentClient.post({ type: 'shader_put', shader: { id: a.id, name: a.name, kind: a.kind, version: a.version, files } });
      store.notifyExternal(touched);
    } else {
      key = `local-${Date.now().toString(36)}`;
      const kind: ShaderKind = /frame\.input\b/.test(files[SHADER_MAIN]) ? 'effect' : 'fill';
      store.project.shaders ??= {};
      store.project.shaders[key] = makeShaderAsset({ id: key, kind, files });
      store.notifyExternal([]);
    }
    this.emit();
    return key;
  }
}

export const shaderSources = new ShaderSources();
