// per-turn change review: snapshot the document before an agent turn, diff it after.
// the diff lists added / removed / changed layers with the properties that changed, so the
// user can see (and click through) exactly what the agent did before keeping or reverting it.

import type { Project, PropKey } from '../core/model';
import { PROP_KEYS } from '../core/model';

interface LayerSig {
  name: string;
  type: string;
  parent: string | null;
  fields: Record<string, string>; // field -> json signature
  keys: Partial<Record<PropKey, number>>; // keyframe counts
}

export interface DocSnapshot {
  layers: Map<string, LayerSig>;
  comp: Record<string, string>;
  compId: string;
}

export interface LayerChange {
  id: string;
  name: string;
  type: string;
  /** human readable changed fields, e.g. "scale (+2 keys)", "text", "opacity" */
  fields: string[];
}

export interface TurnDiff {
  added: LayerChange[];
  removed: LayerChange[];
  changed: LayerChange[];
  comp: string[];
}

const META_FIELDS = ['name', 'visible', 'locked', 'inPoint', 'outPoint', 'parent', 'children', 'text', 'textAnim', 'geometry', 'pathKf', 'paints', 'mask', 'clip', 'blend', 'trimOn', 'shape', 'startTime', 'compRef', 'volume'] as const;

export function snapshotDoc(p: Project): DocSnapshot {
  const layers = new Map<string, LayerSig>();
  for (const l of Object.values(p.layers)) {
    const fields: Record<string, string> = {};
    const keys: LayerSig['keys'] = {};
    for (const f of META_FIELDS) { const v = (l as any)[f]; if (v !== undefined) fields[f] = JSON.stringify(v); }
    for (const k of PROP_KEYS) {
      const pr = l.props[k];
      if (!pr) continue;
      fields['prop:' + k] = JSON.stringify(pr);
      if (pr.kf?.length) keys[k] = pr.kf.length;
    }
    layers.set(l.id, { name: l.name, type: l.type, parent: l.parent, fields, keys });
  }
  const c = p.comps[p.activeComp];
  const comp: Record<string, string> = {};
  if (c) for (const f of ['width', 'height', 'fps', 'duration', 'background', 'name', 'root'] as const) comp[f] = JSON.stringify((c as any)[f] ?? null);
  return { layers, comp, compId: p.activeComp };
}

export function diffDocs(a: DocSnapshot, b: DocSnapshot): TurnDiff {
  const out: TurnDiff = { added: [], removed: [], changed: [], comp: [] };
  for (const [id, s] of b.layers) {
    const o = a.layers.get(id);
    if (!o) { out.added.push({ id, name: s.name, type: s.type, fields: Object.keys(s.keys).map(k => `${k} (${s.keys[k as PropKey]} keys)`) }); continue; }
    const fields: string[] = [];
    const names = new Set([...Object.keys(o.fields), ...Object.keys(s.fields)]);
    for (const f of names) {
      if (o.fields[f] === s.fields[f]) continue;
      if (f === 'children') continue; // reported through the added/removed children themselves
      if (f.startsWith('prop:')) {
        const k = f.slice(5) as PropKey;
        const ka = o.keys[k] ?? 0, kb = s.keys[k] ?? 0;
        let note = '';
        if (kb && !ka) note = ` (animated, ${kb} keys)`;
        else if (ka && !kb) note = ' (keys removed)';
        else if (kb !== ka) note = ` (${ka}→${kb} keys)`;
        else if (kb) note = ' (keys edited)';
        if (s.fields[f]?.includes('"expr"') !== o.fields[f]?.includes('"expr"')) note += s.fields[f]?.includes('"expr"') ? ' (expression)' : ' (expression removed)';
        fields.push(k + note);
      } else fields.push(f === 'textAnim' ? 'text animator' : f === 'pathKf' ? 'path shape' : f);
    }
    if (fields.length) out.changed.push({ id, name: s.name, type: s.type, fields });
  }
  for (const [id, s] of a.layers) if (!b.layers.has(id)) out.removed.push({ id, name: s.name, type: s.type, fields: [] });
  if (a.compId === b.compId) for (const f of Object.keys(b.comp)) if (f !== 'root' && a.comp[f] !== b.comp[f]) out.comp.push(f);
  // don't list children of added/removed groups separately when the parent is listed? keep them: precise is better.
  return out;
}

export function diffIsEmpty(d: TurnDiff) { return !d.added.length && !d.removed.length && !d.changed.length && !d.comp.length; }

export function summarizeDiff(d: TurnDiff): string {
  const parts: string[] = [];
  const n = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;
  if (d.added.length) parts.push(`added ${n(d.added.length, 'layer')}`);
  if (d.changed.length) parts.push(`changed ${n(d.changed.length, 'layer')}`);
  if (d.removed.length) parts.push(`removed ${n(d.removed.length, 'layer')}`);
  if (d.comp.length) parts.push(`composition ${d.comp.join(', ')}`);
  return parts.join(' · ') || 'no document changes';
}
