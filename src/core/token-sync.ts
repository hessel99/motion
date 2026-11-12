// keeping styles in sync with a design library: a figma paste carries variable / style keys, names
// and values (import/figma/convert.ts → IncomingToken lists). planSync diffs them against the
// project's styles ("3 colors changed, 1 new"); applying a plan is one undo step that also rewrites
// every linked value. (0.4 removed the token-file, URL and Figma REST API sources.)

import type { Project, Token, TokenLibrary } from './model';
import { uid } from './model';
import type { Store, Tx } from './store';
import { emptyLibrary, refreshLinked, tokenUsage, tokenValue, unlinkEverywhere } from './tokens';

export interface IncomingToken {
  /** stable key in its library (figma variable/style key, or the token path in a file) */
  key: string;
  name: string;
  type: 'color' | 'number';
  values: Record<string, number[]>;
  kind: NonNullable<Token['source']>['kind'];
  description?: string;
}

export interface TokenChange {
  id: string;
  name: string;
  /** new name when the library renamed it */
  rename?: string;
  /** mode → [before, after] for the modes whose value changed */
  values: Record<string, [number[] | undefined, number[]]>;
  type: Token['type'];
}

export interface SyncPlan {
  added: IncomingToken[];
  changed: TokenChange[];
  /** tokens of this source the library no longer has. `used` = layers still using it (kept, marked missing) */
  removed: { id: string; name: string; used: number }[];
  unchanged: number;
  /** mode names after the sync */
  modes: string[];
  /** the source these tokens came from (removal only applies to tokens of the same source) */
  from?: string;
  incoming: IncomingToken[];
}

const eqv = (a: number[] | undefined, b: number[] | undefined) => !!a && !!b && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1 / 512);

export function planIsEmpty(p: SyncPlan) { return !p.added.length && !p.changed.length && !p.removed.length; }

export function summarizePlan(p: SyncPlan): string {
  const part = (n: number, w: string) => (n ? `${n} ${w}${n > 1 ? 's' : ''}` : '');
  const kind = (list: { type: string }[]) => (list.every(x => x.type === 'color') ? 'color' : 'style');
  const out = [
    p.changed.length ? `${part(p.changed.length, kind(p.changed))} changed` : '',
    p.added.length ? `${part(p.added.length, kind(p.added))} new` : '',
    p.removed.length ? `${part(p.removed.length, 'style')} removed` : '',
  ].filter(Boolean);
  return out.length ? out.join(', ') : 'Everything is up to date';
}

/** match an incoming token to an existing one: same library key first, then same name and type */
function matchToken(lib: TokenLibrary, inc: IncomingToken, taken: Set<string>): Token | undefined {
  const items = Object.values(lib.items);
  const byKey = items.find(t => !taken.has(t.id) && t.source?.key === inc.key);
  if (byKey) return byKey;
  const n = inc.name.toLowerCase().replace(/\s*\/\s*/g, '/');
  return items.find(t => !taken.has(t.id) && t.type === inc.type && t.name.toLowerCase().replace(/\s*\/\s*/g, '/') === n);
}

export function planSync(project: Project, incoming: IncomingToken[], opts: { from?: string; removeMissing?: boolean } = {}): SyncPlan {
  const lib = project.tokens ?? emptyLibrary();
  const plan: SyncPlan = { added: [], changed: [], removed: [], unchanged: 0, modes: mergeModes(lib, incoming), from: opts.from, incoming };
  const taken = new Set<string>();
  for (const inc of incoming) {
    const t = matchToken(lib, inc, taken);
    if (!t) { plan.added.push(inc); continue; }
    taken.add(t.id);
    const values: TokenChange['values'] = {};
    for (const [m, v] of Object.entries(mapModes(lib, inc.values))) if (!eqv(t.values[m], v)) values[m] = [t.values[m], v];
    const rename = inc.name !== t.name ? inc.name : undefined;
    if (Object.keys(values).length || rename) plan.changed.push({ id: t.id, name: t.name, rename, values, type: t.type });
    else plan.unchanged++;
  }
  if (opts.removeMissing && opts.from) {
    const usage = tokenUsage(project);
    for (const t of Object.values(lib.items)) {
      if (taken.has(t.id) || t.source?.from !== opts.from || t.missing) continue;
      plan.removed.push({ id: t.id, name: t.name, used: usage.get(t.id)?.layers.size ?? 0 });
    }
  }
  return plan;
}

/** incoming mode names → library mode names. a single-mode file (or the "Default" mode) updates the
 *  library's first mode; multi-mode files keep their names */
function mapModes(lib: TokenLibrary, values: Record<string, number[]>): Record<string, number[]> {
  const keys = Object.keys(values);
  if (keys.length === 1 && !lib.modes.includes(keys[0])) {
    const out: Record<string, number[]> = {};
    for (const m of lib.modes) out[m] = values[keys[0]]; // one value for every mode
    return out;
  }
  return values;
}

function mergeModes(lib: TokenLibrary, incoming: IncomingToken[]): string[] {
  const modes = lib.modes.slice();
  const multi = incoming.filter(t => Object.keys(t.values).length > 1);
  if (!multi.length) return modes;
  const names: string[] = [];
  for (const t of multi) for (const m of Object.keys(t.values)) if (!names.includes(m)) names.push(m);
  // a library that only had the placeholder mode takes the incoming names
  if (modes.length === 1 && modes[0] === 'Default' && !names.includes('Default')) return names;
  for (const m of names) if (!modes.includes(m)) modes.push(m);
  return modes;
}

/** apply a plan inside an existing transaction (paste uses this) */
export function applySyncTx(tx: Tx, project: Project, plan: SyncPlan, opts: { from?: string } = {}): Map<string, string> {
  if (!project.tokens) tx.set(project, 'tokens', emptyLibrary());
  const lib = project.tokens!;
  const keyToId = new Map<string, string>();
  const changedIds = new Set<string>();
  const from = opts.from ?? plan.from;
  // modes: a library going from the placeholder "Default" to real modes renames its values
  if (plan.modes.join('\u0000') !== lib.modes.join('\u0000')) {
    const wasPlaceholder = lib.modes.length === 1 && lib.modes[0] === 'Default' && !plan.modes.includes('Default');
    if (wasPlaceholder) {
      for (const t of Object.values(lib.items)) {
        const v = t.values.Default;
        if (!v) continue;
        const values: Record<string, number[]> = {};
        for (const m of plan.modes) values[m] = v;
        tx.set(t, 'values', values);
      }
    }
    tx.set(lib, 'modes', plan.modes.slice());
    if (!plan.modes.includes(lib.mode)) { tx.set(lib, 'mode', plan.modes[0]); for (const id of Object.keys(lib.items)) changedIds.add(id); }
  }
  const fill = (values: Record<string, number[]>) => {
    const out: Record<string, number[]> = { ...values };
    const first = Object.values(values)[0];
    for (const m of lib.modes) if (!out[m] && first) out[m] = first;
    return out;
  };
  for (const c of plan.changed) {
    const t = lib.items[c.id];
    if (!t) continue;
    const inc = plan.incoming.find(i => (t.source?.key && i.key === t.source.key) || i.name === (c.rename ?? c.name));
    const values = { ...t.values };
    for (const [m, [, after]] of Object.entries(c.values)) values[m] = after;
    tx.set(t, 'values', fill(values));
    if (c.rename) tx.set(t, 'name', c.rename);
    if (t.missing) tx.set(t, 'missing', undefined);
    if (inc && (!t.source || t.source.key !== inc.key)) tx.set(t, 'source', { kind: inc.kind, key: inc.key, ...(from ? { from } : {}) });
    changedIds.add(t.id);
  }
  for (const inc of plan.added) {
    const t: Token = { id: uid('tk'), name: inc.name, type: inc.type, values: fill(mapModes(lib, inc.values)), source: { kind: inc.kind, key: inc.key, ...(from ? { from } : {}) } };
    if (inc.description) t.description = inc.description;
    tx.set(lib.items, t.id, t);
  }
  const drop = new Set<string>();
  for (const r of plan.removed) {
    const t = lib.items[r.id];
    if (!t) continue;
    if (r.used) tx.set(t, 'missing', true);
    else drop.add(r.id);
  }
  if (drop.size) { unlinkEverywhere(tx, project, drop); for (const id of drop) tx.del(lib.items, id); }
  tx.change.meta = true;
  refreshLinked(tx, project, changedIds);
  // keys of every incoming token → library ids (for linking pasted layers)
  const taken = new Set<string>();
  for (const inc of plan.incoming) { const t = matchToken(lib, inc, taken); if (t) keyToId.set(inc.key, t.id); }
  return keyToId;
}

/** apply a plan as one undo step ("Sync styles: 3 colors changed") */
export function applySync(store: Store, plan: SyncPlan) {
  let map = new Map<string, string>();
  store.transact(`Sync styles: ${summarizePlan(plan)}`, tx => { map = applySyncTx(tx, store.project, plan); });
  store.emit('tokens');
  return map;
}

// ---------------- colors ----------------

/** "#rgb", "#rrggbb", "#rrggbbaa", "rgb(a)()", "hsl(a)()", DTCG color objects → [r,g,b,a] 0..1 */
export function parseColorValue(v: any): number[] | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    // DTCG 2025: { colorSpace: 'srgb', components: [r,g,b], alpha, hex }
    if (Array.isArray(v.components) && (!v.colorSpace || /srgb/i.test(v.colorSpace))) {
      const c = v.components.map((x: any) => (x === 'none' ? 0 : +x));
      return [c[0], c[1], c[2], typeof v.alpha === 'number' ? v.alpha : 1];
    }
    if (typeof v.hex === 'string') return parseColorValue(v.hex);
    // figma api: {r,g,b,a}
    if (typeof v.r === 'number' && typeof v.g === 'number' && typeof v.b === 'number') return [v.r, v.g, v.b, typeof v.a === 'number' ? v.a : 1];
    return null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = (x: string) => (x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x) / 255);
    const a = p[3] === undefined ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    return [ch(p[0]), ch(p[1]), ch(p[2]), a];
  }
  m = /^hsla?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const h = ((parseFloat(p[0]) % 360) + 360) % 360, sat = parseFloat(p[1]) / 100, l = parseFloat(p[2]) / 100;
    const a = p[3] === undefined ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    const k = (n: number) => (n + h / 30) % 12;
    const f = (n: number) => l - sat * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4), a];
  }
  return null;
}

export function toHex(c: number[]): string {
  const h = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
  return '#' + h(c[0]) + h(c[1]) + h(c[2]) + ((c[3] ?? 1) < 1 ? h(c[3]) : '');
}

export { tokenValue };
