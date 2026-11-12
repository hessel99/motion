// colors and numbers that layer properties can link to ("styles" in the ui, "variables" in figma,
// "design tokens" in w3c / tokens studio files).
//
// design: a linked property keeps its RESOLVED value in `prop.v` (or `keyframe.v`) and only adds the
// token id (`prop.bind` / `keyframe.tok`). the renderer, the exporters and the agent read plain numbers,
// so a link costs nothing per frame. whatever changes a token's value (edit, mode switch, library sync)
// rewrites the linked values in the same transaction (one undo step). an edit that writes a different
// value into a linked property unlinks it (figma does the same), enforced in one place: tokenTxHook,
// which runs inside every transaction (see Store.transact).

import type { Keyframe, Layer, Project, Prop, PropKey, Token, TokenLibrary } from './model';
import { PROP_DEFS, propDef, uid } from './model';
import type { Store, Tx } from './store';

/** properties a token can drive, by token type */
export const COLOR_PROPS: PropKey[] = ['fill', 'stroke'];
export const NUMBER_PROPS: PropKey[] = ['opacity', 'radius', 'strokeWidth'];
export const BINDABLE: PropKey[] = [...COLOR_PROPS, ...NUMBER_PROPS];

export function canBind(key: PropKey, t: Token | undefined): boolean {
  if (!t) return false;
  return t.type === 'color' ? COLOR_PROPS.includes(key) : NUMBER_PROPS.includes(key);
}

export function emptyLibrary(): TokenLibrary {
  return { items: {}, modes: ['Default'], mode: 'Default' };
}

/** token value in the library's active mode (falls back to the first mode, then any value) */
export function tokenValue(lib: TokenLibrary, t: Token, mode = lib.mode): number[] {
  return t.values[mode] ?? t.values[lib.modes[0]] ?? Object.values(t.values)[0] ?? (t.type === 'color' ? [0, 0, 0, 1] : [0]);
}

/** the value a property gets from a token (numbers fill every component: radius → 4 corners) */
export function valueForProp(key: PropKey, raw: number[]): number[] {
  const dim = propDef(key).dim;
  if (propDef(key).unit === 'color') return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 1];
  return new Array(dim).fill(raw[0] ?? 0);
}

export function resolvedFor(project: Project, key: PropKey, tokenId: string): number[] | null {
  const lib = project.tokens;
  const t = lib?.items[tokenId];
  if (!lib || !t) return null;
  return valueForProp(key, tokenValue(lib, t));
}

const eqv = (a: number[] | undefined, b: number[] | undefined) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false;
  return true;
};

/** display name: "Brand/Primary" → "Brand / Primary" */
export const prettyName = (name: string) => name.split('/').map(s => s.trim()).filter(Boolean).join(' / ');
/** group (everything before the last slash) and leaf */
export function splitName(name: string): { group: string; leaf: string } {
  const parts = name.split('/').map(s => s.trim()).filter(Boolean);
  const leaf = parts.pop() ?? name;
  return { group: parts.join(' / '), leaf };
}

export function findToken(project: Project, ref: string): Token | undefined {
  const lib = project.tokens;
  if (!lib) return undefined;
  if (lib.items[ref]) return lib.items[ref];
  const norm = (s: string) => s.toLowerCase().replace(/\s*\/\s*/g, '/').replace(/[.]/g, '/').trim();
  const r = norm(ref);
  return Object.values(lib.items).find(t => norm(t.name) === r);
}

// ---------------- usage ----------------

export interface Usage { layers: Set<string>; props: number; keys: number }

/** which layers use which token (all compositions) */
export function tokenUsage(project: Project): Map<string, Usage> {
  const out = new Map<string, Usage>();
  const get = (id: string) => { let u = out.get(id); if (!u) out.set(id, (u = { layers: new Set(), props: 0, keys: 0 })); return u; };
  for (const l of Object.values(project.layers)) {
    for (const k in l.props) {
      const p = l.props[k as PropKey];
      if (!p) continue;
      if (p.bind) { const u = get(p.bind); u.layers.add(l.id); u.props++; }
      if (p.kf) for (const kf of p.kf) if (kf.tok) { const u = get(kf.tok); u.layers.add(l.id); u.keys++; }
    }
  }
  return out;
}

/** the token a property is linked to at time t (static link, or the keyframe at t) */
export function linkOf(l: Layer, key: PropKey, t?: number): string | undefined {
  const p = l.props[key];
  if (!p) return undefined;
  if (p.kf?.length) {
    if (t === undefined) return p.kf.find(k => k.tok)?.tok;
    return p.kf.find(k => Math.abs(k.t - t) < 1e-6)?.tok;
  }
  return p.bind;
}

// ---------------- transactions ----------------

function ensureLib(tx: Tx, project: Project): TokenLibrary {
  if (!project.tokens) tx.set(project, 'tokens', emptyLibrary());
  return project.tokens!;
}

/** rewrite every value linked to one of `ids` (all of them when ids is null) to the token's value */
export function refreshLinked(tx: Tx, project: Project, ids: Set<string> | null) {
  const lib = project.tokens;
  if (!lib) return 0;
  let n = 0;
  for (const l of Object.values(project.layers)) {
    let touched = false;
    for (const k in l.props) {
      const key = k as PropKey;
      const p = l.props[key];
      if (!p) continue;
      if (p.bind && (!ids || ids.has(p.bind))) {
        const t = lib.items[p.bind];
        if (t) { const v = valueForProp(key, tokenValue(lib, t)); if (!eqv(v, p.v)) { tx.set(p, 'v', v); touched = true; } }
      }
      if (p.kf?.some(kf => kf.tok && (!ids || ids.has(kf.tok)))) {
        let changed = false;
        const next = p.kf.map(kf => {
          if (!kf.tok || (ids && !ids.has(kf.tok))) return kf;
          const t = lib.items[kf.tok];
          if (!t) return kf;
          const v = valueForProp(key, tokenValue(lib, t));
          if (eqv(v, kf.v)) return kf;
          changed = true;
          return { ...kf, v };
        });
        if (changed) { tx.set(p, 'kf', next); touched = true; }
      }
    }
    if (touched) { tx.touch(l.id); n++; }
  }
  return n;
}

/** link (or with tokenId null: unlink) a property. animated properties link the keyframe at `time`
 *  (one is created if needed); static ones link the value */
export function linkProp(store: Store, ids: string[], key: PropKey, tokenId: string | null, time = store.time) {
  const P = store.project;
  const t = tokenId ? P.tokens?.items[tokenId] : undefined;
  if (tokenId && !t) throw new Error('no such style');
  if (t && !canBind(key, t)) throw new Error(`a ${t.type} style can't be linked to ${PROP_DEFS[key].label}`);
  store.transact(tokenId ? `Link ${PROP_DEFS[key].label} to ${prettyName(t!.name)}` : `Detach ${PROP_DEFS[key].label}`, tx => {
    for (const id of ids) {
      const l = P.layers[id];
      if (!l) continue;
      let p = l.props[key];
      if (!p && !t) continue;
      if (!p) { p = { v: (PROP_DEFS[key].default as unknown as number[]).slice() }; tx.set(l.props, key, p); }
      if (p.kf?.length) {
        if (!t) {
          // detach: every key of the property
          if (p.kf.some(k => k.tok)) tx.set(p, 'kf', p.kf.map(k => { if (!k.tok) return k; const { tok: _t, ...rest } = k; return rest as Keyframe; }));
        } else {
          const v = valueForProp(key, tokenValue(P.tokens!, t));
          const kf = p.kf.map(k => ({ ...k }));
          const i = kf.findIndex(k => Math.abs(k.t - time) < 1e-6);
          if (i >= 0) kf[i] = { ...kf[i], v, tok: t.id };
          else {
            const prev = [...kf].reverse().find(k => k.t < time) ?? kf[0];
            kf.push({ t: time, v, interp: prev.interp, out: [...prev.out] as [number, number], in: [...prev.in] as [number, number], ...(prev.bounce !== undefined ? { bounce: prev.bounce } : {}), tok: t.id });
            kf.sort((a, b) => a.t - b.t);
          }
          tx.set(p, 'kf', kf);
        }
      } else if (t) {
        tx.set(p, 'v', valueForProp(key, tokenValue(P.tokens!, t)));
        tx.set(p, 'bind', t.id);
      } else if (p.bind) tx.set(p, 'bind', undefined);
      tx.touch(id);
    }
  });
}

export function addToken(store: Store, init: { name: string; type: Token['type']; value: number[]; description?: string }): Token {
  const P = store.project;
  const t: Token = { id: uid('tk'), name: init.name.trim() || 'Untitled', type: init.type, values: {}, ...(init.description ? { description: init.description } : {}) };
  store.transact(`Add style ${prettyName(t.name)}`, tx => {
    const lib = ensureLib(tx, P);
    for (const m of lib.modes) t.values[m] = init.value.slice();
    tx.set(lib.items, t.id, t);
    tx.change.meta = true;
  });
  store.emit('tokens');
  return t;
}

/** change a token's value (in the active mode, or in every mode with allModes) and everything linked to it */
export function setTokenValue(store: Store, id: string, value: number[], opts: { mode?: string; allModes?: boolean; mergeKey?: string } = {}) {
  const P = store.project;
  const t = P.tokens?.items[id];
  if (!t) return;
  store.transact(`Change ${prettyName(t.name)}`, tx => {
    const lib = P.tokens!;
    const modes = opts.allModes ? lib.modes : [opts.mode ?? lib.mode];
    const values = { ...t.values };
    for (const m of modes) values[m] = value.slice();
    tx.set(t, 'values', values);
    tx.change.meta = true;
    refreshLinked(tx, P, new Set([id]));
  }, opts.mergeKey);
  store.emit('tokens');
}

export function renameToken(store: Store, id: string, name: string) {
  const t = store.project.tokens?.items[id];
  if (!t || !name.trim() || name === t.name) return;
  store.transact('Rename style', tx => { tx.set(t, 'name', name.trim()); tx.change.meta = true; });
  store.emit('tokens');
}

/** delete a token. layers keep their current values (they are just no longer linked) */
export function deleteToken(store: Store, id: string) {
  const P = store.project;
  const t = P.tokens?.items[id];
  if (!t) return;
  store.transact(`Delete style ${prettyName(t.name)}`, tx => {
    unlinkEverywhere(tx, P, new Set([id]));
    tx.del(P.tokens!.items, id);
    tx.change.meta = true;
  });
  store.emit('tokens');
}

export function unlinkEverywhere(tx: Tx, project: Project, ids: Set<string>) {
  for (const l of Object.values(project.layers)) {
    let touched = false;
    for (const k in l.props) {
      const p = l.props[k as PropKey];
      if (!p) continue;
      if (p.bind && ids.has(p.bind)) { tx.set(p, 'bind', undefined); touched = true; }
      if (p.kf?.some(kf => kf.tok && ids.has(kf.tok))) {
        tx.set(p, 'kf', p.kf.map(kf => { if (!kf.tok || !ids.has(kf.tok)) return kf; const { tok: _t, ...rest } = kf; return rest as Keyframe; }));
        touched = true;
      }
    }
    if (touched) tx.touch(l.id);
  }
}

/** switch the active mode (light / dark): every linked value follows, one undo step */
export function setTokenMode(store: Store, mode: string) {
  const P = store.project;
  const lib = P.tokens;
  if (!lib || !lib.modes.includes(mode) || lib.mode === mode) return;
  store.transact(`Switch to ${mode}`, tx => {
    tx.set(lib, 'mode', mode);
    tx.change.meta = true;
    refreshLinked(tx, P, null);
  });
  store.emit('tokens');
}

/** select every layer (in the active composition) that uses a token */
export function layersUsing(project: Project, tokenId: string): string[] {
  return [...(tokenUsage(project).get(tokenId)?.layers ?? [])];
}

// ---------------- transaction hook ----------------

/** runs inside every transaction (Store.transact) for the layers it touched:
 *  - a linked static value that no longer equals its token's value was edited by hand: unlink it
 *  - a linked static property that got keyframes: the link moves to the keys that hold the token value
 *  - a linked keyframe whose value changed: unlink that keyframe */
export function tokenTxHook(project: Project, tx: Tx) {
  const lib = project.tokens;
  if (!lib || !tx.change.layers.size) return;
  for (const id of tx.change.layers) {
    const l = project.layers[id];
    if (!l) continue;
    for (const k in l.props) {
      const key = k as PropKey;
      const p: Prop | undefined = l.props[key];
      if (!p) continue;
      if (p.bind) {
        const t = lib.items[p.bind];
        if (!t) { tx.set(p, 'bind', undefined); continue; }
        const v = valueForProp(key, tokenValue(lib, t));
        if (p.kf?.length) {
          const tokId = p.bind;
          tx.set(p, 'bind', undefined);
          if (p.kf.some(kf => !kf.tok && eqv(kf.v, v))) tx.set(p, 'kf', p.kf.map(kf => (!kf.tok && eqv(kf.v, v) ? { ...kf, tok: tokId } : kf)));
        } else if (!eqv(p.v, v)) tx.set(p, 'bind', undefined);
      }
      if (p.kf?.some(kf => kf.tok)) {
        let bad = false;
        for (const kf of p.kf) {
          if (!kf.tok) continue;
          const t = lib.items[kf.tok];
          if (!t || !eqv(kf.v, valueForProp(key, tokenValue(lib, t)))) { bad = true; break; }
        }
        if (bad) tx.set(p, 'kf', p.kf.map(kf => {
          if (!kf.tok) return kf;
          const t = lib.items[kf.tok];
          if (t && eqv(kf.v, valueForProp(key, tokenValue(lib, t)))) return kf;
          const { tok: _t, ...rest } = kf;
          return rest as Keyframe;
        }));
      }
    }
  }
}
