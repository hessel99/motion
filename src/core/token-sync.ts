// keeping styles in sync with a design library.
//
// sources (all end up as IncomingToken lists, then planSync → preview → applySync):
//  - figma paste: the clipboard carries variable / style ids, names and values (import/figma/convert.ts)
//  - token files: W3C Design Tokens (DTCG, `$value` / `$type`), Tokens Studio (`value` / `type`, token
//    sets as modes), Figma's own variables export (DTCG with `$extensions.com.figma`)
//  - figma REST variables API (GET /v1/files/:key/variables/local; needs a token and an Enterprise
//    plan, so it is optional): same parser, `meta.variables` + `meta.variableCollections`
// a plan is pure data ("3 colors changed, 1 new"), shown before anything changes; applying it is one
// undo step that also rewrites every linked value.

import type { Project, Token, TokenLibrary, TokenSource } from './model';
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

/** apply a previewed plan: one undo step ("Sync styles: 3 colors changed") */
export function applySync(store: Store, plan: SyncPlan, source?: Omit<TokenSource, 'id'> & { id?: string }) {
  let map = new Map<string, string>();
  store.transact(`Sync styles: ${summarizePlan(plan)}`, tx => {
    map = applySyncTx(tx, store.project, plan);
    if (source) {
      const lib = store.project.tokens!;
      const list = (lib.sources ?? []).filter(s => s.location !== source.location);
      list.push({ id: source.id ?? uid('src'), kind: source.kind, label: source.label, location: source.location, lastSync: Date.now() });
      tx.set(lib, 'sources', list);
    }
  });
  store.emit('tokens');
  return map;
}

// ---------------- parsers ----------------

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

function parseNumberValue(v: any): number | null {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && typeof v.value === 'number') return v.unit === 'rem' ? v.value * 16 : v.value; // DTCG dimension
  if (typeof v === 'string') {
    const m = /^(-?[\d.]+)\s*(px|rem|em|%)?$/.exec(v.trim());
    if (m) return m[2] === 'rem' || m[2] === 'em' ? +m[1] * 16 : +m[1];
  }
  return null;
}

const COLOR_TYPES = new Set(['color']);
const NUMBER_TYPES = new Set(['number', 'dimension', 'spacing', 'sizing', 'borderradius', 'borderwidth', 'opacity', 'float']);

interface RawLeaf { path: string[]; value: any; type?: string; description?: string; ext?: any }

/** walk a DTCG / Tokens Studio tree into leaves (`$type` inherits from groups) */
function leaves(node: any, path: string[], inheritedType: string | undefined, out: RawLeaf[]) {
  if (!node || typeof node !== 'object') return;
  const type = node.$type ?? inheritedType;
  if ('$value' in node) { out.push({ path, value: node.$value, type: node.$type ?? inheritedType, description: node.$description, ext: node.$extensions }); return; }
  if ('value' in node && (typeof node.value !== 'object' || node.value === null || 'colorSpace' in node.value || 'unit' in node.value) && (typeof node.type === 'string' || inheritedType)) {
    out.push({ path, value: node.value, type: node.type ?? inheritedType, description: node.description });
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
    leaves(v, [...path, k], type, out);
  }
}

/** resolve "{group.token}" aliases (several hops, cycles end as null) */
function resolveAliases(all: Map<string, RawLeaf>, v: any, seen = new Set<string>()): any {
  if (typeof v !== 'string') return v;
  const m = /^\{([^}]+)\}$/.exec(v.trim());
  if (!m) return v;
  const ref = m[1];
  if (seen.has(ref)) return null;
  seen.add(ref);
  const target = all.get(ref);
  return target ? resolveAliases(all, target.value, seen) : null;
}

function leafToTokens(list: RawLeaf[], mode: string, out: Map<string, IncomingToken>, all: Map<string, RawLeaf>) {
  for (const leaf of list) {
    const type = (leaf.type ?? '').toLowerCase();
    const v = resolveAliases(all, leaf.value);
    let isColor = COLOR_TYPES.has(type);
    let value: number[] | null = null;
    if (isColor) { const c = parseColorValue(v); if (c) value = c; }
    else if (NUMBER_TYPES.has(type)) { const n = parseNumberValue(v); if (n !== null) value = [type === 'opacity' && n <= 1 ? n * 100 : n]; }
    else if (!type) {
      // untyped: guess from the value
      const c = parseColorValue(v);
      if (c) { value = c; isColor = true; }
    }
    if (!value) continue;
    const key = leaf.path.join('.');
    const figmaKey = leaf.ext?.['com.figma']?.variableId ?? leaf.ext?.['com.figma.variableId'];
    const name = leaf.path.join('/');
    let t = out.get(key);
    if (!t) out.set(key, (t = { key: typeof figmaKey === 'string' ? figmaKey : key, name, type: isColor ? 'color' : 'number', values: {}, kind: 'file', ...(leaf.description ? { description: leaf.description } : {}) }));
    t.values[mode] = value;
  }
}

const MODE_WORDS = /^(light|dark|default|day|night|high[- ]?contrast|dim)$/i;

/** parse a tokens file (W3C DTCG, Tokens Studio single or multi-set, Figma variables export or the
 *  Figma REST variables response). `mode` names the mode of a single-mode file. */
export function parseTokenFile(json: any, opts: { mode?: string } = {}): IncomingToken[] {
  if (typeof json === 'string') json = JSON.parse(json);
  if (!json || typeof json !== 'object') throw new Error('not a tokens file');
  if (json.meta?.variables && json.meta?.variableCollections) return parseFigmaVariablesApi(json);
  const out = new Map<string, IncomingToken>();
  const meta = json.$metadata;
  const setOrder: string[] | undefined = Array.isArray(meta?.tokenSetOrder) ? meta.tokenSetOrder : undefined;
  const topKeys = Object.keys(json).filter(k => !k.startsWith('$'));
  // tokens studio multi-set file: sets named like modes (light / dark) become modes, other sets are shared
  const sets = setOrder ?? (topKeys.length > 1 && topKeys.some(k => MODE_WORDS.test(k.split('/').pop()!)) ? topKeys : undefined);
  if (sets) {
    const modeSets = sets.filter(s => MODE_WORDS.test(s.split('/').pop()!));
    const shared = sets.filter(s => !modeSets.includes(s));
    const allLeaves = new Map<string, RawLeaf>();
    const perSet = new Map<string, RawLeaf[]>();
    for (const s of sets) {
      const list: RawLeaf[] = [];
      leaves(json[s], [], undefined, list);
      perSet.set(s, list);
    }
    // aliases resolve within shared sets + the mode's own set
    const modes = modeSets.length ? modeSets : [opts.mode ?? 'Default'];
    for (const m of modes) {
      allLeaves.clear();
      for (const s of [...shared, ...(modeSets.length ? [m] : [])]) for (const l of perSet.get(s) ?? []) allLeaves.set(l.path.join('.'), l);
      const name = modeSets.length ? cap(m.split('/').pop()!) : m;
      leafToTokens([...allLeaves.values()], name, out, allLeaves);
    }
    return [...out.values()];
  }
  const list: RawLeaf[] = [];
  leaves(json, [], undefined, list);
  const all = new Map(list.map(l => [l.path.join('.'), l] as const));
  leafToTokens(list, opts.mode ?? 'Default', out, all);
  return [...out.values()];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** GET https://api.figma.com/v1/files/:key/variables/local (or /published) */
export function parseFigmaVariablesApi(json: any): IncomingToken[] {
  const vars: Record<string, any> = json.meta.variables ?? {};
  const cols: Record<string, any> = json.meta.variableCollections ?? {};
  const out: IncomingToken[] = [];
  const resolve = (v: any, modeId: string, depth = 0): any => {
    if (v && typeof v === 'object' && v.type === 'VARIABLE_ALIAS' && depth < 8) {
      const target = vars[v.id];
      if (!target) return null;
      const tm = target.valuesByMode?.[modeId] ?? Object.values(target.valuesByMode ?? {})[0];
      return resolve(tm, modeId, depth + 1);
    }
    return v;
  };
  for (const v of Object.values(vars)) {
    if (v.remote && !v.name) continue;
    if (v.resolvedType !== 'COLOR' && v.resolvedType !== 'FLOAT') continue;
    const col = cols[v.variableCollectionId];
    const values: Record<string, number[]> = {};
    for (const [modeId, raw] of Object.entries(v.valuesByMode ?? {})) {
      const modeName = col?.modes?.find((m: any) => m.modeId === modeId)?.name ?? 'Default';
      const r = resolve(raw, modeId);
      if (v.resolvedType === 'COLOR') { const c = parseColorValue(r); if (c) values[modeName] = c; }
      else if (typeof r === 'number') values[modeName] = [r];
    }
    if (!Object.keys(values).length) continue;
    out.push({ key: v.key ?? v.id, name: v.name, type: v.resolvedType === 'COLOR' ? 'color' : 'number', values, kind: 'figma-api', ...(v.description ? { description: v.description } : {}) });
  }
  return out;
}

/** export the library as a W3C design tokens (DTCG) file: round-trips through parseTokenFile */
export function exportTokenFile(lib: TokenLibrary): any {
  const root: any = {};
  for (const t of Object.values(lib.items)) {
    const parts = t.name.split('/').map(s => s.trim()).filter(Boolean);
    let node = root;
    for (const p of parts.slice(0, -1)) node = node[p] ??= {};
    const v = tokenValue(lib, t);
    node[parts[parts.length - 1] ?? t.id] = t.type === 'color'
      ? { $type: 'color', $value: toHex(v) }
      : { $type: 'number', $value: v[0] };
  }
  return root;
}

export function toHex(c: number[]): string {
  const h = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
  return '#' + h(c[0]) + h(c[1]) + h(c[2]) + ((c[3] ?? 1) < 1 ? h(c[3]) : '');
}

export { tokenValue };
