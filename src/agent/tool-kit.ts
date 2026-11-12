// shared helpers for the agent tool modules (tools.ts and tools-*.ts): argument parsing, keyframe
// building, compact output. kept separate so the tool files can import it without a cycle.

import { editor } from '../app/editor';
import { valueAt } from '../core/commands';
import { EASE_PRESETS, SPRING_PRESETS } from '../core/easing';
import { PROP_DEFS, PROP_KEYS, type Keyframe, type Layer, type PropKey } from '../core/model';
import type { Tx } from '../core/store';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  run: (args: any) => Promise<ToolContent[]> | ToolContent[];
  /** does not change the document (allowed in Ask mode; advertised as readOnlyHint over MCP) */
  readOnly?: boolean;
}
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  /** a rendered file (base64): the bridge saves it to a temp file and replaces it with its path */
  | { type: 'file'; name: string; data: string; mimeType: string };

export const st = () => editor.store;
// compact json: tool results go straight into the model context, whitespace is wasted tokens
export const text = (v: unknown): ToolContent[] => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }];

export const colorSchema = { description: 'color as "#rrggbb", "#rrggbbaa" or [r,g,b,a] with 0..1 floats', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }] };
export const propValueSchema = { description: 'number, number array, or color (for fill/stroke)', anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }, { type: 'string' }] };
export const vec2Schema = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
export const easeSchema = { description: `ease preset name (${EASE_PRESETS.map(p => p.name).join(', ')}), spring preset (${SPRING_PRESETS.map(p => 'spring ' + p.name).join(', ')}), "spring:<bounce 0..0.9>", or cubic-bezier [x1,y1,x2,y2]`, anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }] };

export const keyframeSchema = {
  type: 'object',
  properties: {
    t: { type: 'number', description: 'seconds' }, v: propValueSchema, ease: easeSchema,
    interp: { enum: ['bezier', 'linear', 'hold'] },
    sOut: { ...vec2Schema, description: 'position only: outgoing spatial tangent [dx,dy]' },
    sIn: { ...vec2Schema, description: 'position only: incoming spatial tangent [dx,dy]' },
  },
  required: ['t', 'v'],
};
export const idsSchema = { type: 'array', items: { type: 'string' } };

export function parseColor(c: any): number[] {
  if (Array.isArray(c)) {
    const v = c.map(Number);
    const scale = v.slice(0, 3).some(x => x > 1) ? 1 / 255 : 1;
    return [v[0] * scale, v[1] * scale, v[2] * scale, v[3] ?? 1];
  }
  if (typeof c === 'string') {
    const h = c.trim().replace('#', '');
    const full = h.length === 3 || h.length === 4 ? h.split('').map(x => x + x).join('') : h;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
    if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return [n(0), n(2), n(4), full.length === 8 ? n(6) : 1];
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(',').map(s => parseFloat(s)); return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] ?? 1]; }
  }
  throw new Error(`invalid color ${JSON.stringify(c)}`);
}

export function toValue(key: PropKey, v: any): number[] {
  const def = PROP_DEFS[key];
  if (def.unit === 'color') return parseColor(v);
  if (typeof v === 'number') {
    if (key === 'scale') return [v, v];
    if (key === 'radius') return [v, v, v, v];
    return def.dim === 1 ? [v] : new Array(def.dim).fill(v);
  }
  if (!Array.isArray(v)) throw new Error(`invalid value for ${key}: ${JSON.stringify(v)}`);
  if (key === 'radius' && v.length === 1) return [v[0], v[0], v[0], v[0]];
  return v.map(Number);
}

export function checkProp(p: string): PropKey {
  if (!(PROP_KEYS as string[]).includes(p)) throw new Error(`unknown property "${p}". valid: ${PROP_KEYS.join(', ')}`);
  return p as PropKey;
}

export function need(id: string): Layer {
  const l = st().layer(id);
  if (!l) throw new Error(`no layer with id "${id}"`);
  return l;
}

export function round(v: number[]) { return v.map(x => Math.round(x * 1000) / 1000); }

/** keyframes from the tool format ({t, v, ease, interp, sOut, sIn}) to the model format */
export function buildKeys(key: PropKey, raw: any[]): Keyframe[] {
  if (!Array.isArray(raw)) throw new Error('keyframes must be an array');
  const sorted = raw.slice().sort((x, y) => +x.t - +y.t);
  const eases = sorted.map(k => resolveEase(k.ease));
  const out = sorted.map((k, i) => {
    if (!isFinite(+k.t)) throw new Error(`keyframe time must be a number (got ${JSON.stringify(k.t)})`);
    const ease = eases[i];
    return { t: +k.t, v: toValue(key, k.v), interp: k.interp ?? (ease.bounce !== undefined ? 'spring' : ease.linear ? 'linear' : 'bezier'), bounce: ease.bounce, out: [ease.v[0], ease.v[1]], in: [0.667, 1], sOut: k.sOut, sIn: k.sIn } as Keyframe;
  });
  // the "in" handle of key i+1 comes from the ease of key i
  for (let i = 1; i < out.length; i++) out[i].in = [eases[i - 1].v[2], eases[i - 1].v[3]];
  for (const k of out) { if (k.bounce === undefined) delete k.bounce; if (k.sOut === undefined) delete k.sOut; if (k.sIn === undefined) delete k.sIn; }
  return out;
}

export function writeTrack(tx: Tx, l: Layer, key: PropKey, incoming: Keyframe[], merge: boolean) {
  const s = st();
  const p = l.props[key] ?? { v: valueAt(l, key, s.time) };
  if (!l.props[key]) tx.set(l.props, key, p);
  let kf = incoming;
  if (merge && p.kf) {
    const rest = p.kf.filter(k => !incoming.some(n => Math.abs(n.t - k.t) < 1e-6));
    kf = [...rest, ...incoming].sort((x, y) => x.t - y.t);
  }
  tx.set(p, 'kf', kf);
  enableTrim(tx, l, key);
  tx.touch(l.id);
}

/** trim keys/values only render with the layer's "Trim paths" switch on: turn it on for the agent */
export function enableTrim(tx: Tx, l: Layer, key: PropKey) {
  if ((key === 'trimStart' || key === 'trimEnd' || key === 'trimOffset') && !l.trimOn) { tx.set(l, 'trimOn', true); tx.recompile(); }
}

/** remap every key time of a layer (props, path shape, text animator). returns whether anything moved */
export function shiftLayerKeys(tx: Tx, l: Layer, f: (t: number) => number, scale: number): boolean {
  let moved = false;
  for (const k of PROP_KEYS) {
    const p = l.props[k];
    if (!p?.kf?.length) continue;
    tx.set(p, 'kf', p.kf.map(x => ({ ...x, t: f(x.t) })));
    moved = true;
  }
  if (l.pathKf?.length) { tx.set(l, 'pathKf', l.pathKf.map(x => ({ ...x, t: f(x.t) }))); moved = true; }
  if (l.textAnim) { const a = l.textAnim; tx.set(l, 'textAnim', { ...a, start: f(a.start), duration: a.duration * scale, stagger: a.stagger * scale }); moved = true; }
  return moved;
}

/** render frames and lay them out in one labeled jpeg (base64, no data: prefix) */
export async function contactSheet(times: number[], cell: number): Promise<string> {
  const c = st().comp;
  const sc = Math.min(1, cell / Math.max(c.width, c.height));
  const w = Math.round(c.width * sc), h = Math.round(c.height * sc);
  const cols = times.length <= 4 ? times.length : times.length <= 6 ? 3 : 4;
  const rows = Math.ceil(times.length / cols);
  const pad = 4, label = 16;
  const canvas = document.createElement('canvas');
  canvas.width = cols * (w + pad) + pad;
  canvas.height = rows * (h + pad + label) + pad;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#111';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.font = '11px ui-monospace, Menlo, monospace';
  g.textBaseline = 'middle';
  for (let i = 0; i < times.length; i++) {
    const url = editor.renderer.snapshot(times[i], Math.max(w, h));
    const im = new Image();
    await new Promise<void>((res, rej) => { im.onload = () => res(); im.onerror = () => rej(new Error('snapshot decode failed')); im.src = url; });
    const x = pad + (i % cols) * (w + pad), y = pad + Math.floor(i / cols) * (h + pad + label);
    g.fillStyle = '#ddd';
    g.fillText(`${(Math.round(times[i] * 100) / 100).toFixed(2)}s  f${Math.round(times[i] * c.fps)}`, x + 2, y + label / 2);
    g.drawImage(im, x, y + label, w, h);
  }
  return canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
}

export function resolveEase(e: any): { v: [number, number, number, number]; linear: boolean; bounce?: number } {
  if (e === undefined || e === null) return { v: [0.333, 0, 0.667, 1], linear: false };
  if (typeof e === 'string' && /^spring/i.test(e.trim())) {
    const m = e.match(/spring\s*[:\s]\s*([\d.]+)/i);
    const preset = SPRING_PRESETS.find(p => e.toLowerCase().includes(p.name.toLowerCase()));
    return { v: [0.333, 0, 0.667, 1], linear: false, bounce: m ? Math.min(0.9, +m[1]) : preset?.bounce ?? 0.3 };
  }
  if (Array.isArray(e) && e.length === 4) return { v: e.map(Number) as any, linear: false };
  if (typeof e === 'string') {
    const p = EASE_PRESETS.find(p => p.name.toLowerCase() === e.toLowerCase().replace(/[-_]/g, ' '));
    if (!p) throw new Error(`unknown ease "${e}". presets: ${EASE_PRESETS.map(p => p.name).join(', ')}`);
    return { v: p.v, linear: p.name === 'Linear' };
  }
  throw new Error('ease must be a preset name or [x1,y1,x2,y2]');
}

export function boundsOf(ids: string[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const r = editor.renderer;
  for (const id of ids) {
    // bounds in the parent's space: use world corners mapped through the parent inverse
    const l = st().layer(id);
    const c = r.corners(id);
    if (!c || !l) continue;
    const pw = l.parent ? r.worldMatrix(l.parent)! : [1, 0, 0, 1, 0, 0];
    const det = pw[0] * pw[3] - pw[1] * pw[2] || 1;
    for (let i = 0; i < 4; i++) {
      const dx = c[i * 2] - pw[4], dy = c[i * 2 + 1] - pw[5];
      const x = (pw[3] * dx - pw[2] * dy) / det, y = (-pw[1] * dx + pw[0] * dy) / det;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  if (!isFinite(x0)) return { x: 0, y: 0, w: 100, h: 100 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

