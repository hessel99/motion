// build_scene: a declarative scene spec applied in ONE transaction (one undo step). layers carry a
// stable `key` (stored as layer.sceneKey), so calling it again with the same keys updates those
// layers in place instead of adding duplicates: the agent can refine a scene by re-sending it.

import { createComp, createLayer, PROP_DEFS, PROP_KEYS, TYPE_PROPS, BLEND_MODES, type Layer, type LayerType, type Paint, type PathCmd, type PropKey, type TextAnim } from '../core/model';
import { checkExpr, EXPR_PROPS } from '../core/expr';
import { EASE_PRESETS } from '../core/easing';
import { TEXT_ANIM_PRESETS } from '../core/presets';
import { starGeometry } from '../core/shapes';
import type { Tx } from '../core/store';
import { valueAt } from '../core/commands';
import { tasteOn, feel, easeArg, moveDuration, unit } from './taste';
import { st, text, need, parseColor, toValue, checkProp, buildKeys, colorSchema, easeSchema, keyframeSchema, resolveEase, type ToolDef } from './tool-kit';
import { resolveShape, parseD, polylineCmds, cmdsBounds, transformCmds, PRIMITIVE_NAMES, type ShapeOut } from './shape-lib';
import { layerSize, rng } from './motion-math';

const ANCHORS: Record<string, [number, number]> = {
  'top-left': [0, 0], top: [0.5, 0], 'top-right': [1, 0], left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5], 'bottom-left': [0, 1], bottom: [0.5, 1], 'bottom-right': [1, 1],
};

const SCENE_TYPES = ['rect', 'ellipse', 'path', 'text', 'group', 'star', 'polygon', 'image', 'precomp'] as const;

// ---------------- shared helpers (also used by the shape / type tools) ----------------

/** validate a text animator spec (preset and/or fields) into a TextAnim */
export function textAnimFrom(a: any, startOffset = 0): TextAnim {
  const base = a.preset ? TEXT_ANIM_PRESETS.find(p => p.name.toLowerCase() === String(a.preset).toLowerCase())?.anim : TEXT_ANIM_PRESETS[0].anim;
  if (!base) throw new Error(`unknown text animation preset "${a.preset}". presets: ${TEXT_ANIM_PRESETS.map(p => p.name).join(', ')}`);
  if (a.ease !== undefined) {
    const e = String(a.ease);
    if (!/^spring(:|\s|$)/i.test(e.trim()) && !EASE_PRESETS.some(p => p.name.toLowerCase() === e.toLowerCase())) throw new Error(`text animation ease must be a preset name (${EASE_PRESETS.map(p => p.name).join(', ')}) or "spring:<bounce>"`);
  }
  if (a.by !== undefined && !['char', 'word', 'line'].includes(a.by)) throw new Error('by must be char, word or line');
  const anim: any = { ...base, start: 0 };
  for (const k of ['by', 'start', 'duration', 'stagger', 'ease', 'mode', 'order']) if (a[k] !== undefined) anim[k] = a[k];
  anim.from = { ...base.from, ...(a.from ?? {}) };
  anim.start = (+anim.start || 0) + startOffset;
  return anim;
}

/** gradient / solid fill spec -> paints (+ a representative solid color) */
export function fillSpec(f: any): { color: number[]; paints?: Paint[] } {
  if (f && typeof f === 'object' && !Array.isArray(f)) {
    const type = f.type ?? 'linear';
    if (type !== 'linear' && type !== 'radial') throw new Error('gradient type must be "linear" or "radial"');
    const raw: any[] = Array.isArray(f.stops) ? f.stops : [];
    if (raw.length < 2) throw new Error('a gradient needs at least 2 stops: ["#ff0000", "#0000ff"] or [{pos:0,color:"#f00"},{pos:1,color:"#00f"}]');
    const stops = raw.map((s, i) => (typeof s === 'object' && !Array.isArray(s) ? { pos: +s.pos, color: parseColor(s.color) } : { pos: i / (raw.length - 1), color: parseColor(s) })) as any[];
    // angle: 0 = left→right, 90 = top→bottom (unit gradient space rotated about its center)
    const a = ((f.angle ?? (type === 'linear' ? 0 : 0)) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const transform = [c, s, -s, c, 0.5 - c * 0.5 + s * 0.5, 0.5 - s * 0.5 - c * 0.5];
    return { color: stops[0].color, paints: [{ type, stops, transform }] };
  }
  return { color: parseColor(f) };
}

function setStatic(tx: Tx, l: Layer, key: PropKey, v: number[]) {
  const p = l.props[key];
  if (!p) tx.set(l.props, key, { v: v.slice() });
  else tx.set(p, 'v', v.slice());
}

/** trim-path reveal keys for a path layer (draw on / draw off) */
export function drawOnTracks(t0: number, dur: number, ease: any, from: 'start' | 'end' | 'center' = 'start', off = false): Partial<Record<PropKey, any[]>> {
  const k = (a: number, b: number) => (off ? [{ t: t0, v: b, ease }, { t: t0 + dur, v: a }] : [{ t: t0, v: a, ease }, { t: t0 + dur, v: b }]);
  if (from === 'center') return { trimStart: k(50, 0), trimEnd: k(50, 100) };
  if (from === 'end') return { trimStart: k(100, 0), trimEnd: [{ t: t0, v: 100 }] };
  return { trimEnd: k(0, 100), trimStart: [{ t: t0, v: 0 }] };
}

/** delay per index for a stagger order */
export function orderDelays(n: number, order: string, step: number, seed = 1): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let rank: number[];
  switch (order) {
    case 'reverse': rank = idx.map(i => n - 1 - i); break;
    case 'center-out': rank = idx.map(i => Math.abs(i - (n - 1) / 2)); break;
    case 'edges-in': rank = idx.map(i => (n - 1) / 2 - Math.abs(i - (n - 1) / 2)); break;
    case 'random': { const R = rng(seed); const perm = idx.slice().sort(() => R() - 0.5); rank = idx.map(i => perm.indexOf(i)); break; }
    default: rank = idx;
  }
  // equal ranks start together (center-out on an even count: the two middle ones)
  const uniq = [...new Set(rank.map(r => Math.round(r * 1000) / 1000))].sort((a, b) => a - b);
  return rank.map(r => uniq.indexOf(Math.round(r * 1000) / 1000) * step);
}

// ---------------- build_scene ----------------

interface Built { id: string; key: string; created: boolean; notes: string[] }

interface Ctx {
  tx: Tx;
  byKey: Map<string, Layer>;
  out: Built[];
  delays: Map<string, number>;
  shapes: Map<any, ShapeOut & { strokeScale?: number }>;
  tracks: number;
  seen: Set<string>;
}

const num = (v: any, name: string) => { const n = +v; if (!isFinite(n)) throw new Error(`${name} must be a number (got ${JSON.stringify(v)})`); return n; };

/** async pre-pass: resolve every `shape` reference (Lucide icons load lazily) */
async function resolveShapes(specs: any[], map: Ctx['shapes'], path = 'layers') {
  for (const [i, s] of specs.entries()) {
    if (!s || typeof s !== 'object') throw new Error(`${path}[${i}] must be an object`);
    if (s.shape) {
      const w = s.w ?? 100, h = s.h ?? 100;
      map.set(s, await resolveShape(String(s.shape), w, h, s.shapeOptions ?? {}));
    }
    if (s.children) { if (!Array.isArray(s.children)) throw new Error(`${path}[${i}].children must be an array`); await resolveShapes(s.children, map, `${path}[${i}].children`); }
  }
}

function collectKeys(specs: any[], keys: Set<string>, path = 'layers') {
  for (const [i, s] of specs.entries()) {
    if (typeof s.key !== 'string' || !s.key.trim()) throw new Error(`${path}[${i}] needs a "key" (a stable name like "title" or "card-2"; re-sending the same key updates that layer)`);
    if (keys.has(s.key)) throw new Error(`duplicate key "${s.key}" in the spec`);
    keys.add(s.key);
    if (s.children) collectKeys(s.children, keys, `${path}[${i}].children`);
  }
}

/** container list (children of a layer, or a comp root) and its setter */
function container(parent: string | null, compId: string) {
  const s = st(), P = s.project;
  return parent ? { list: () => P.layers[parent].children, set: (tx: Tx, v: string[]) => tx.set(P.layers[parent], 'children', v) } : { list: () => P.comps[compId].root, set: (tx: Tx, v: string[]) => tx.set(P.comps[compId], 'root', v) };
}

function detach(tx: Tx, l: Layer) {
  const P = st().project;
  if (l.parent) { const p = P.layers[l.parent]; tx.set(p, 'children', p.children.filter(c => c !== l.id)); }
  else for (const c of Object.values(P.comps)) if (c.root.includes(l.id)) tx.set(c, 'root', c.root.filter(x => x !== l.id));
}

function deleteTree(tx: Tx, l: Layer) {
  const P = st().project;
  detach(tx, l);
  const rec = (id: string) => { const x = P.layers[id]; if (!x) return; x.children.forEach(rec); tx.del(P.layers, id); };
  rec(l.id);
  tx.structure();
}

function buildLayer(ctx: Ctx, s: any, parent: string | null, compId: string, inheritedDelay: number): string {
  const store = st(), P = store.project, tx = ctx.tx;
  const notes: string[] = [];
  const existing = ctx.byKey.get(s.key);
  // updates keep the layer's type unless the spec names another one
  let type: string = s.type ?? (existing ? (existing.shape?.kind ?? existing.type) : s.children ? 'group' : s.text !== undefined ? 'text' : s.d || s.points || s.shape ? 'path' : 'rect');
  if (!(SCENE_TYPES as readonly string[]).includes(type)) throw new Error(`layer "${s.key}": type must be one of ${SCENE_TYPES.join(', ')}`);
  const placeholder = type === 'image' && !s.asset;
  if (s.asset && !P.assets[s.asset]) throw new Error(`layer "${s.key}": no asset "${s.asset}"`);
  const modelType: LayerType = type === 'star' || type === 'polygon' ? 'path' : placeholder ? 'rect' : (type as LayerType);
  const shape = ctx.shapes.get(s);
  const delay = inheritedDelay + (s.delay !== undefined ? num(s.delay, `${s.key}.delay`) : 0) + (ctx.delays.get(s.key) ?? 0);

  let l = ctx.byKey.get(s.key);
  let created = false;
  if (l && l.type !== modelType) { notes.push(`type changed ${l.type}→${modelType}: recreated`); deleteTree(tx, l); l = undefined; }
  const cur = l;
  const comp = P.comps[compId];

  // ---- geometry box ----
  let geometry: PathCmd[] | null = null;
  let fillRule: 'nonzero' | 'evenodd' = 'nonzero';
  let strokeLook = false;
  let fitted: number[] | null = null;
  if (modelType === 'path') {
    const starLike = type === 'star' || type === 'polygon';
    if (s.d !== undefined || (s.points !== undefined && !starLike)) {
      geometry = s.d !== undefined ? parseD(s.d) : polylineCmds(s.points, !!s.closed);
      if (s.w === undefined && s.h === undefined) {
        // d in parent coordinates: fit the box around it
        const [bx, by, bw, bh] = cmdsBounds(geometry);
        fitted = [bx, by, Math.max(1, bw), Math.max(1, bh)];
        geometry = transformCmds(geometry, [1, 0, 0, 1, -bx, -by]);
      }
      if (s.d === undefined && !s.closed) strokeLook = true;
    } else if (shape) { geometry = shape.cmds; fillRule = shape.fillRule ?? 'nonzero'; strokeLook = shape.style === 'stroke'; }
    else if (starLike) geometry = starGeometry(type, s.points ?? (type === 'star' ? 5 : 6), s.inner ?? 0.45, s.w ?? 100, s.h ?? 100)[0].cmds;
    else if (!cur) throw new Error(`layer "${s.key}": a path needs "d" (SVG path data), "points" or "shape" (${PRIMITIVE_NAMES.slice(0, 8).join(', ')}, ..., lucide:<icon>)`);
  }
  const curSize = cur ? layerSize(store, cur, store.time) : null;
  const w = fitted ? fitted[2] : s.w !== undefined ? num(s.w, `${s.key}.w`) : curSize ? curSize[0] : type === 'text' ? 0 : type === 'group' || type === 'precomp' ? (parent ? P.layers[parent].props.size?.v[0] ?? comp.width : comp.width) : 100;
  const h = fitted ? fitted[3] : s.h !== undefined ? num(s.h, `${s.key}.h`) : curSize ? curSize[1] : type === 'text' ? 0 : type === 'group' || type === 'precomp' ? (parent ? P.layers[parent].props.size?.v[1] ?? comp.height : comp.height) : 100;

  if (!l) {
    created = true;
    const init: any = { w, h, x: 0, y: 0 };
    if (type === 'text') {
      const tx0 = typeof s.text === 'object' ? s.text : { content: String(s.text ?? 'Text') };
      init.text = { content: 'Text', fontFamily: 'Inter', fontSize: 64, fontWeight: 600, lineHeight: 1.2, letterSpacing: 0, align: 'left', ...tx0 };
      init.color = [1, 1, 1, 1];
    }
    l = createLayer(modelType, init);
    l.sceneKey = s.key;
    l.name = s.name ?? s.key;
    if (placeholder) { l.name = s.name ?? `${s.key} (image placeholder)`; l.props.fill!.v = [0.55, 0.58, 0.64, 1]; l.props.stroke!.v = [1, 1, 1, 0.6]; l.props.strokeWidth!.v = [2]; }
    if (modelType === 'image') l.imageRef = s.asset;
    if (type === 'precomp') {
      const c = createComp({ name: s.name ?? s.key, width: Math.round(w), height: Math.round(h), fps: comp.fps, duration: s.comp?.duration ?? comp.duration, background: [0, 0, 0, 0] });
      tx.set(P.comps, c.id, c);
      l.compRef = c.id;
      l.startTime = 0;
      tx.comp();
    }
    tx.set(P.layers, l.id, l);
    l.parent = parent;
    const ct = container(parent, compId);
    ct.set(tx, [...ct.list(), l.id]);
    tx.structure();
  } else {
    if (s.name !== undefined) tx.set(l, 'name', String(s.name));
    if (l.parent !== parent || !(parent ? P.layers[parent].children : P.comps[compId].root).includes(l.id)) {
      detach(tx, l);
      tx.set(l, 'parent', parent);
      const ct = container(parent, compId);
      ct.set(tx, [...ct.list(), l.id]);
      tx.structure();
    }
  }
  const L = l;
  ctx.seen.add(L.id);

  // ---- type data ----
  if (geometry) {
    tx.set(L, 'geometry', [{ cmds: geometry, fillRule }]);
    tx.set(L, 'geomSize', [w, h]);
    if (L.pathKf) tx.set(L, 'pathKf', undefined);
    if (type === 'star' || type === 'polygon') tx.set(L, 'shape', { kind: type, points: s.points ?? (type === 'star' ? 5 : 6), inner: s.inner ?? 0.45 });
  }
  if (type === 'text' && !created && s.text !== undefined) tx.set(L, 'text', { ...L.text!, ...(typeof s.text === 'object' ? s.text : { content: String(s.text) }) });
  if (type === 'text') {
    const patch: any = {};
    if (s.fontSize !== undefined) patch.fontSize = num(s.fontSize, 'fontSize');
    if (s.fontWeight !== undefined) patch.fontWeight = num(s.fontWeight, 'fontWeight');
    if (s.font !== undefined) patch.fontFamily = String(s.font);
    if (s.align !== undefined) patch.align = s.align;
    if (s.lineHeight !== undefined) patch.lineHeight = num(s.lineHeight, 'lineHeight');
    if (s.tracking !== undefined) patch.letterSpacing = num(s.tracking, 'tracking');
    if (s.italic !== undefined) patch.fontStyle = s.italic ? 'italic' : 'normal';
    if (Object.keys(patch).length) tx.set(L, 'text', { ...L.text!, ...patch });
  }
  for (const f of ['visible', 'mask', 'clip'] as const) if (s[f] !== undefined && L[f] !== !!s[f]) { tx.set(L, f, !!s[f]); tx.recompile(); }
  if (s.blend !== undefined) { if (!BLEND_MODES.includes(s.blend)) throw new Error(`blend must be one of ${BLEND_MODES.join(', ')}`); tx.set(L, 'blend', s.blend === 'normal' ? undefined : s.blend); tx.recompile(); }
  if (s.inPoint !== undefined) tx.set(L, 'inPoint', num(s.inPoint, 'inPoint') + delay);
  if (s.outPoint !== undefined) tx.set(L, 'outPoint', num(s.outPoint, 'outPoint') + delay);
  if (type === 'precomp' && s.comp && L.compRef) {
    const c = P.comps[L.compRef];
    for (const k of ['duration', 'fps', 'name'] as const) if (s.comp[k] !== undefined) tx.set(c, k, s.comp[k]);
    if (s.comp.startTime !== undefined) tx.set(L, 'startTime', num(s.comp.startTime, 'comp.startTime'));
    tx.comp();
  }

  // ---- static props ----
  // auto-sized text (w/h 0): pivots and centering use the measured box
  const [bw, bh] = L.type === 'text' && (w <= 0 || h <= 0) ? layerSize(store, L, 0) : [w, h];
  const statics: Partial<Record<PropKey, number[]>> = {};
  const sizeChanged = created || s.w !== undefined || s.h !== undefined || !!fitted;
  if (sizeChanged && L.props.size) statics.size = [w, h];
  // anchor: named (default center for new layers) or [x, y] px in the box
  let an: number[] = valueAt(L, 'anchor', store.time);
  if (s.anchor !== undefined) {
    if (typeof s.anchor === 'string') { const f = ANCHORS[s.anchor]; if (!f) throw new Error(`anchor must be [x,y] or one of ${Object.keys(ANCHORS).join(', ')}`); an = [f[0] * bw, f[1] * bh]; }
    else an = toValue('anchor', s.anchor);
    statics.anchor = an;
  } else if (created || (sizeChanged && cur && Math.abs(an[0] - (curSize![0]) / 2) < 0.5 && Math.abs(an[1] - curSize![1] / 2) < 0.5)) { an = [bw / 2, bh / 2]; statics.anchor = an; }
  // position: x/y = top-left of the box (rotation/scale about the anchor), center = [cx, cy], or position
  if (s.position !== undefined) statics.position = toValue('position', s.position);
  else if (s.center !== undefined) { const c = toValue('position', s.center); statics.position = [c[0] - bw / 2 + an[0], c[1] - bh / 2 + an[1]]; }
  else if (s.x !== undefined || s.y !== undefined || fitted || created || statics.anchor) {
    const p0 = valueAt(L, 'position', comp.duration / 2), a0 = cur ? valueAt(cur, 'anchor', comp.duration / 2) : [0, 0];
    const x = fitted && s.x === undefined ? fitted[0] : s.x !== undefined ? num(s.x, 'x') : cur ? p0[0] - a0[0] : 0;
    const y = fitted && s.y === undefined ? fitted[1] : s.y !== undefined ? num(s.y, 'y') : cur ? p0[1] - a0[1] : 0;
    statics.position = [x + an[0], y + an[1]];
  }
  if (s.scale !== undefined) statics.scale = toValue('scale', s.scale);
  if (s.rotation !== undefined) statics.rotation = toValue('rotation', s.rotation);
  if (s.opacity !== undefined) statics.opacity = toValue('opacity', s.opacity);
  if (s.radius !== undefined) { if (!L.props.radius) notes.push('radius ignored (only rect/group)'); else statics.radius = toValue('radius', s.radius); }
  if (s.fill !== undefined && modelType !== 'image') {
    const f = fillSpec(s.fill);
    statics.fill = f.color;
    tx.set(L, 'paints', f.paints);
  } else if (created && strokeLook) statics.fill = [0, 0, 0, 0];
  // line art (open paths, stroke shapes, icons): a given "fill" color becomes the stroke color
  if (s.stroke !== undefined) statics.stroke = parseColor(s.stroke);
  else if (created && strokeLook) { statics.stroke = s.fill !== undefined ? fillSpec(s.fill).color : [1, 1, 1, 1]; statics.fill = [0, 0, 0, 0]; tx.set(L, 'paints', undefined); }
  if (s.strokeWidth !== undefined) statics.strokeWidth = [num(s.strokeWidth, 'strokeWidth')];
  else if (created && strokeLook) statics.strokeWidth = [shape?.strokeScale ? 2 * shape.strokeScale : Math.max(2, Math.min(w, h) * 0.06)];
  if (s.strokeAlign !== undefined) tx.set(L, 'strokeAlign', s.strokeAlign);
  for (const [k, v] of Object.entries(s.props ?? {})) statics[checkProp(k)] = toValue(k as PropKey, v);
  for (const k of Object.keys(statics) as PropKey[]) {
    const allowed = [...['anchor', 'position', 'scale', 'rotation', 'opacity'], ...TYPE_PROPS[L.type]];
    if (!allowed.includes(k)) { notes.push(`${k} ignored on ${L.type}`); delete statics[k]; }
  }

  // ---- animation ----
  const owns = s.animate !== undefined || s.enter !== undefined || s.exit !== undefined || s.drawOn !== undefined;
  const tracks: Partial<Record<PropKey, any[]>> = {};
  const add = (k: PropKey, frames: any[]) => { tracks[k] = [...(tracks[k] ?? []), ...frames]; };
  // the rest value of a property: given, else its value mid-comp (between entrance and exit)
  const rest = (k: PropKey) => statics[k] ?? valueAt(L, k, comp.duration / 2);
  if (s.animate !== undefined) {
    if (typeof s.animate !== 'object' || Array.isArray(s.animate)) throw new Error(`layer "${s.key}": animate must be an object {prop: keyframes[]}, e.g. {"opacity":[{"t":0,"v":0},{"t":0.4,"v":100}]}`);
    for (const [k, frames] of Object.entries(s.animate)) {
      const key = checkProp(k);
      if (!Array.isArray(frames) || !frames.length) throw new Error(`layer "${s.key}": animate.${k} must be a non-empty keyframe array`);
      add(key, (frames as any[]).map(f => ({ ...f, t: num(f.t, `${s.key}.animate.${k}.t`) + delay })));
    }
  }
  const moveSpec = (spec: any, dir: 'enter' | 'exit') => {
    const vals = spec[dir === 'enter' ? 'from' : 'to'] ?? { opacity: 0 };
    // taste layer: unspecified duration / ease come from the timing table (distance, size, role) and the style's feel
    const taste = tasteOn(), f = feel();
    const dist = Math.hypot(+(vals.dx ?? 0) || 0, +(vals.dy ?? 0) || 0) || (vals.x !== undefined || vals.y !== undefined ? Math.hypot(vals.x !== undefined ? +vals.x + an[0] - rest('position')[0] : 0, vals.y !== undefined ? +vals.y + an[1] - rest('position')[1] : 0) : 0);
    const sc = vals.scale !== undefined ? Math.min(...toValue('scale', vals.scale)) : 100;
    const role = L.type === 'text' ? 'text' : bw * bh < comp.width * comp.height * 0.004 ? 'decoration' : undefined;
    const dur = spec.duration ?? (taste ? moveDuration(store, { distance: dist, size: Math.max(bw, bh), role, exit: dir === 'exit' }) : 0.6);
    const big = dist >= 300 * unit(store) || sc <= 30;
    const ease = spec.ease ?? (taste ? (dir === 'enter' ? easeArg(big && f.settle ? f.settle : f.enter) : f.exit) : (dir === 'enter' ? 'Expo Out' : 'Expo In'));
    const defaulted = spec.ease === undefined && taste;
    const t0 = (spec.t ?? (dir === 'enter' ? 0 : comp.duration)) + delay;
    const a = dir === 'enter' ? t0 : t0 - dur, b = dir === 'enter' ? t0 + dur : t0;
    resolveEase(ease);
    for (const [k, v] of Object.entries(vals)) {
      let key: PropKey, off: number[];
      if (k === 'dx' || k === 'dy' || k === 'x' || k === 'y') {
        key = 'position';
        const r = rest('position');
        const prev = (tracks.position ?? []).find(f => Math.abs(f.t - (dir === 'enter' ? a : b)) < 1e-9);
        const base = prev ? toValue('position', prev.v) : r.slice();
        if (k === 'dx') base[0] = r[0] + num(v, 'dx'); else if (k === 'dy') base[1] = r[1] + num(v, 'dy'); else if (k === 'x') base[0] = num(v, 'x') + an[0]; else base[1] = num(v, 'y') + an[1];
        off = base;
        if (prev) { prev.v = off; continue; }
      } else { key = checkProp(k); off = toValue(key, v); }
      // opacity fades faster than the move: it reads as "arrived" sooner
      const d2 = key === 'opacity' ? Math.min(dur, Math.max(0.15, dur * 0.5)) : dur;
      const e2 = key === 'opacity' && (defaulted || /^(spring|back)/i.test(String(ease)) || Array.isArray(ease)) ? (dir === 'enter' ? 'Ease Out' : 'Ease In') : ease;
      if (dir === 'enter') add(key, [{ t: a, v: off, ease: e2 }, { t: a + d2, v: rest(key) }]);
      else add(key, [{ t: b - d2, v: rest(key), ease: e2 }, { t: b, v: off }]);
    }
  };
  if (s.enter) moveSpec(s.enter, 'enter');
  if (s.exit) moveSpec(s.exit, 'exit');
  if (s.drawOn) {
    if (L.type !== 'path') throw new Error(`layer "${s.key}": drawOn needs a path layer (type path / shape / star)`);
    const d = s.drawOn === true ? {} : s.drawOn;
    for (const [k, fr] of Object.entries(drawOnTracks((d.t ?? 0) + delay, d.duration ?? 0.8, d.ease ?? 'Ease In Out', d.from ?? 'start'))) add(k as PropKey, fr!);
    if (!L.trimOn) { tx.set(L, 'trimOn', true); tx.recompile(); }
    if (!(statics.strokeWidth?.[0] ?? valueAt(L, 'strokeWidth', 0)[0])) notes.push('drawOn reveals the stroke: give it strokeWidth/stroke');
  }

  for (const [k, v] of Object.entries(statics) as [PropKey, number[]][]) {
    if (tracks[k]) continue;
    if (L.props[k]?.kf?.length && !owns) { notes.push(`${k} is animated: static value ignored (send "animate" to replace the animation)`); continue; }
    setStatic(tx, L, k, v);
    if (owns && L.props[k]?.kf) tx.set(L.props[k]!, 'kf', undefined);
  }
  if (owns) {
    for (const k of PROP_KEYS) {
      const p = L.props[k];
      if (tracks[k]) {
        // dedupe same-time keys (later wins), keep order
        const frames = tracks[k]!.slice().sort((x, y) => x.t - y.t).filter((f, i, arr) => !(i < arr.length - 1 && Math.abs(arr[i + 1].t - f.t) < 1e-6));
        if (frames.some(f => f.t < -1e-9)) throw new Error(`layer "${s.key}": ${k} has a key before 0s`);
        const kf = buildKeys(k, frames);
        if (!p) tx.set(L.props, k, { v: kf[kf.length - 1].v.slice(), kf });
        else { tx.set(p, 'kf', kf); tx.set(p, 'v', kf[kf.length - 1].v.slice()); }
        ctx.tracks++;
      } else if (p?.kf?.length) { tx.set(p, 'v', valueAt(L, k, store.time)); tx.set(p, 'kf', undefined); }
    }
  }
  if (s.expr) {
    for (const [k, src] of Object.entries(s.expr)) {
      const key = checkProp(k);
      if (!EXPR_PROPS.includes(key)) throw new Error(`expressions work on: ${EXPR_PROPS.join(', ')}`);
      if (src) { const err = checkExpr(String(src), PROP_DEFS[key].dim); if (err) throw new Error(`layer "${s.key}" ${k} expression: ${err}`); }
      if (!L.props[key]) tx.set(L.props, key, { v: (PROP_DEFS[key].default as unknown as number[]).slice() });
      tx.set(L.props[key]!, 'expr', src ? String(src) : undefined);
    }
  }
  if (s.textAnim !== undefined) {
    if (L.type !== 'text') throw new Error(`layer "${s.key}": textAnim needs a text layer`);
    tx.set(L, 'textAnim', s.textAnim ? textAnimFrom(s.textAnim, delay) : undefined);
  }
  tx.touch(L.id);

  // ---- children ----
  if (s.children) {
    if (!['group', 'precomp'].includes(type)) throw new Error(`layer "${s.key}": only group and precomp layers have children`);
    const kids: any[] = s.children;
    const cd = s.staggerChildren ? orderDelays(kids.length, s.staggerOrder ?? 'sequential', num(s.staggerChildren, 'staggerChildren'), s.seed ?? 1) : kids.map(() => 0);
    const ids = kids.map((c, i) => type === 'precomp' ? buildLayer(ctx, c, null, L.compRef!, cd[i]) : buildLayer(ctx, c, L.id, compId, delay + cd[i]));
    reorder(ctx.tx, type === 'precomp' ? null : L.id, type === 'precomp' ? L.compRef! : compId, ids);
  }
  ctx.out.push({ id: L.id, key: s.key, created, notes });
  return L.id;
}

/** keyed layers take the spec order among themselves; other layers keep their slots */
function reorder(tx: Tx, parent: string | null, compId: string, ids: string[]) {
  const ct = container(parent, compId);
  const list = ct.list();
  const set = new Set(ids);
  const slots = list.map((id, i) => (set.has(id) ? i : -1)).filter(i => i >= 0);
  const next = list.slice();
  slots.forEach((slot, n) => { next[slot] = ids[n]; });
  if (next.some((id, i) => id !== list[i])) { ct.set(tx, next); tx.structure(); }
}

export async function buildScene(a: any) {
  const s = st(), P = s.project;
  if (!Array.isArray(a.layers) || !a.layers.length) throw new Error('layers must be a non-empty array of layer specs');
  const keys = new Set<string>();
  collectKeys(a.layers, keys);
  const shapes: Ctx['shapes'] = new Map();
  await resolveShapes(a.layers, shapes);
  if (a.parent) { const p = need(a.parent); if (p.type !== 'group') throw new Error('parent must be a group layer'); }
  const byKey = new Map<string, Layer>();
  for (const l of Object.values(P.layers)) if (l.sceneKey && !byKey.has(l.sceneKey)) byKey.set(l.sceneKey, l);
  // stagger blocks: per-key delays, added to every time in that layer's spec (idempotent)
  const delays = new Map<string, number>();
  for (const [i, b] of (a.stagger ?? []).entries()) {
    if (!Array.isArray(b.keys) || b.keys.length < 2) throw new Error(`stagger[${i}].keys must list at least two layer keys`);
    for (const k of b.keys) if (!keys.has(k)) throw new Error(`stagger[${i}]: no layer with key "${k}" in this spec`);
    const d = orderDelays(b.keys.length, b.order ?? 'sequential', num(b.step ?? 0.08, 'step'), b.seed ?? 1);
    b.keys.forEach((k: string, j: number) => delays.set(k, (delays.get(k) ?? 0) + d[j] + (b.start ?? 0)));
  }
  // taste layer: siblings that all enter at an unspecified time overlap in reading order (the hero first)
  let autoStaggered = 0;
  if (tasteOn()) {
    const f = feel();
    const visit = (list: any[], parentStaggers: boolean) => {
      const cand = parentStaggers ? [] : list.filter(x => x && x.key && x.enter && x.enter.t === undefined && !delays.has(x.key) && x.animate === undefined);
      if (cand.length >= 3) {
        const weight = (x: any) => x.type === 'text' || x.text ? (+(x.fontSize ?? x.text?.fontSize ?? 48)) ** 2 * String(x.text?.content ?? x.text ?? '').length * 0.6 : (+(x.w ?? 0) || 100) * (+(x.h ?? 0) || 100);
        const hero = cand.reduce((m, x) => (weight(x) > weight(m) ? x : m), cand[0]);
        const ordered = [hero, ...cand.filter(x => x !== hero)];
        const step = Math.min(f.step, 0.6 / (ordered.length - 1));
        ordered.forEach((x, i) => delays.set(x.key, Math.round(i * step * 1000) / 1000));
        autoStaggered += ordered.length;
      }
      for (const x of list) if (x && Array.isArray(x.children)) visit(x.children, !!x.staggerChildren);
    };
    visit(a.layers, false);
  }
  const ctx: Ctx = { tx: null as any, byKey, out: [], delays, shapes, tracks: 0, seen: new Set() };
  let pruned = 0;
  s.transact('Agent: build scene', tx => {
    ctx.tx = tx;
    const comp = s.comp;
    if (a.comp) {
      for (const k of ['width', 'height', 'fps', 'duration', 'name'] as const) if (a.comp[k] !== undefined) tx.set(comp, k, a.comp[k]);
      if (a.comp.background !== undefined) tx.set(comp, 'background', parseColor(a.comp.background) as any);
      tx.comp();
    }
    const top = a.layers.map((spec: any) => buildLayer(ctx, spec, a.parent ?? null, comp.id, 0));
    reorder(tx, a.parent ?? null, comp.id, top);
    if (a.prune) {
      for (const l of Object.values(P.layers)) {
        if (l.sceneKey && !keys.has(l.sceneKey) && P.layers[l.id] && !ctx.seen.has(l.id)) { deleteTree(tx, l); pruned++; }
      }
    }
  });
  const created = ctx.out.filter(o => o.created).length;
  const ids: Record<string, string> = {};
  for (const o of ctx.out) ids[o.key] = o.id;
  const notes = ctx.out.filter(o => o.notes.length).map(o => `${o.key}: ${o.notes.join('; ')}`);
  const end = Math.max(0, ...ctx.out.map(o => { const l = P.layers[o.id]; let m = 0; for (const k of PROP_KEYS) for (const f of l?.props[k]?.kf ?? []) m = Math.max(m, f.t); return m; }));
  const summary = `${created} created, ${ctx.out.length - created} updated${pruned ? `, ${pruned} pruned` : ''}, ${ctx.tracks} keyframe tracks; animation ends ${Math.round(end * 100) / 100}s${end > s.comp.duration + 1e-6 ? ` (past comp end ${s.comp.duration}s!)` : ''}`;
  if (autoStaggered) notes.push(`taste layer: ${autoStaggered} entrances without a time were overlapped (hero first, ${feel().step}s apart); pass enter.t or a stagger block to control it`);
  return { summary, ids, ...(notes.length ? { notes } : {}) };
}

// ---------------- schema ----------------

const kfList = { type: 'array', items: keyframeSchema };
const moveSchema = (dir: 'from' | 'to') => ({
  type: 'object',
  description: dir === 'from' ? 'entrance: animate FROM these values to the layer\'s rest values' : 'exit: animate from rest TO these values',
  properties: {
    t: { type: 'number', description: dir === 'from' ? 'start time (default 0, plus delay)' : 'END time (default comp end)' },
    duration: { type: 'number', description: 'seconds (default 0.6; opacity uses half)' },
    ease: easeSchema,
    [dir]: { type: 'object', description: 'opacity, scale (% number or [x,y]), rotation, fill, ... (absolute values) and dx/dy (position offsets in px)', additionalProperties: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'array', items: { type: 'number' } }] } },
  },
});

const textAnimSchema = {
  description: 'per char/word/line text animator: {preset} and/or {by, start, duration, stagger, ease, mode, order, from:{opacity,dx,dy,scale,rotation}}; null removes',
  anyOf: [{ type: 'object', properties: {
    preset: { type: 'string', description: TEXT_ANIM_PRESETS.map(p => p.name).join(', ') },
    by: { enum: ['char', 'word', 'line'] }, start: { type: 'number' }, duration: { type: 'number' }, stagger: { type: 'number' },
    ease: { type: 'string' }, mode: { enum: ['in', 'out'] }, order: { enum: ['forward', 'backward', 'center', 'random'] },
    from: { type: 'object', properties: { opacity: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' }, scale: { type: 'number' }, rotation: { type: 'number' } } },
  } }, { type: 'null' }],
};

export const fillSchema = {
  description: 'color ("#rrggbb", [r,g,b,a]) or gradient {type:"linear"|"radial", stops:["#f00","#00f"] or [{pos,color}], angle (deg, 0 = left→right, 90 = top→bottom)}',
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }, { type: 'object', properties: { type: { enum: ['linear', 'radial'] }, stops: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }, { type: 'object', properties: { pos: { type: 'number' }, color: colorSchema } }] } }, angle: { type: 'number' } } }],
};

// the layer spec is recursive (children): JSON Schema here stays one level deep and describes the rest
const layerSpecProps: any = {
  key: { type: 'string', description: 'stable unique id you choose ("bg", "title", "card-1"); re-sending a key updates that layer' },
  type: { enum: [...SCENE_TYPES], description: 'default: group if children, text if text, path if d/points/shape, else rect. image without asset = placeholder rect' },
  name: { type: 'string' },
  x: { type: 'number', description: 'box top-left in parent coordinates' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
  center: { type: 'array', items: { type: 'number' }, description: 'alternative to x/y: box center [cx, cy]' },
  anchor: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }], description: 'pivot: center (default), top-left, top, bottom, left, right, bottom-right, ... or [x,y] px in the box' },
  position: { type: 'array', items: { type: 'number' }, description: 'raw anchor position (instead of x/y)' },
  scale: { anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }] }, rotation: { type: 'number' }, opacity: { type: 'number' },
  fill: fillSchema, stroke: colorSchema, strokeWidth: { type: 'number' }, strokeAlign: { enum: ['inside', 'center', 'outside'] },
  radius: { anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }] },
  d: { type: 'string', description: 'path: SVG path data. Without w/h it is in parent coordinates and the box is fitted around it; with w/h it is in box coordinates' },
  points: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'array', items: { type: 'number' } } }], description: 'path polyline "x,y x,y" (closed: true to close); star/polygon: point count' },
  closed: { type: 'boolean' }, inner: { type: 'number', description: 'star inner radius 0..1' },
  shape: { type: 'string', description: `library shape in the w x h box: ${PRIMITIVE_NAMES.join(', ')}, or "lucide:<icon>" (any Lucide icon, e.g. lucide:rocket)` },
  shapeOptions: { type: 'object', properties: { seed: { type: 'number' }, points: { type: 'number' }, inner: { type: 'number' }, turns: { type: 'number' }, waves: { type: 'number' }, amplitude: { type: 'number' }, thickness: { type: 'number' }, complexity: { type: 'number' } } },
  text: { anyOf: [{ type: 'string' }, { type: 'object', properties: { content: { type: 'string' }, fontFamily: { type: 'string' }, fontSize: { type: 'number' }, fontWeight: { type: 'number' }, align: { enum: ['left', 'center', 'right'] }, lineHeight: { type: 'number' }, letterSpacing: { type: 'number' } } }] },
  fontSize: { type: 'number' }, fontWeight: { type: 'number' }, font: { type: 'string' }, align: { enum: ['left', 'center', 'right'] }, lineHeight: { type: 'number' }, tracking: { type: 'number', description: 'letter spacing px' }, italic: { type: 'boolean' },
  blend: { enum: BLEND_MODES }, mask: { type: 'boolean', description: 'this layer\'s alpha masks the siblings above it' }, clip: { type: 'boolean', description: 'group clips its children' }, visible: { type: 'boolean' },
  inPoint: { type: 'number' }, outPoint: { type: 'number' }, asset: { type: 'string', description: 'image asset id' },
  delay: { type: 'number', description: 'seconds added to every time of this layer (and its children)' },
  animate: { type: 'object', description: 'keyframes per property: {"scale":[{"t":0,"v":0,"ease":"Back Out"},{"t":0.5,"v":100}]}. When a layer spec has animate/enter/exit/drawOn, its keyframes are exactly these (others are cleared)', additionalProperties: kfList },
  enter: moveSchema('from'), exit: moveSchema('to'),
  drawOn: { type: 'object', description: 'trim-path reveal of a path stroke', properties: { t: { type: 'number' }, duration: { type: 'number' }, ease: easeSchema, from: { enum: ['start', 'end', 'center'] } } },
  expr: { type: 'object', description: 'expressions per property, e.g. {"rotation":"time*90","position":"wiggle(2,10)"}; "" removes', additionalProperties: { type: 'string' } },
  textAnim: textAnimSchema,
  props: { type: 'object', description: 'any other static property values', additionalProperties: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'array', items: { type: 'number' } }] } },
  comp: { type: 'object', description: 'precomp: settings of its inner composition', properties: { duration: { type: 'number' }, fps: { type: 'number' }, name: { type: 'string' }, startTime: { type: 'number' } } },
  staggerChildren: { type: 'number', description: 'seconds between children\'s animations' },
  staggerOrder: { enum: ['sequential', 'reverse', 'center-out', 'edges-in', 'random'] },
  seed: { type: 'number' },
};
const childSpec = { type: 'object', description: 'a layer spec (same fields as layers[]; children may nest further)', properties: { ...layerSpecProps, children: { type: 'array', items: { type: 'object', description: 'nested layer spec (same fields)' } } }, required: ['key'] };
const layerSpec = { type: 'object', properties: { ...layerSpecProps, children: { type: 'array', items: childSpec, description: 'group/precomp children; coordinates relative to the group box (a group defaults to the full comp box at 0,0, so children can use comp coordinates)' } }, required: ['key'] };

export const SCENE_TOOLS: ToolDef[] = [
  {
    name: 'build_scene',
    description: 'Build or update a whole scene in ONE call and ONE undo step from a declarative spec: layers (rect, ellipse, path from d/points/library shape/Lucide icon, text, group, star, polygon, image placeholder, precomp) with nesting, transforms, solid/gradient fills, strokes, radius, text styles, keyframes per property (eases/springs), enter/exit shorthands, draw-on, stagger blocks, text animators, expressions, masks, blend modes. Every layer has a stable "key": calling again with the same keys UPDATES those layers (no duplicates), so refine by re-sending the changed specs. prune:true deletes earlier keyed layers missing from this spec. Returns {summary, ids: {key: layerId}, notes}.',
    inputSchema: {
      type: 'object',
      properties: {
        layers: { type: 'array', items: layerSpec, description: 'top-level layer specs, bottom → top in draw order' },
        comp: { type: 'object', description: 'composition settings to set first', properties: { width: { type: 'number' }, height: { type: 'number' }, fps: { type: 'number' }, duration: { type: 'number' }, background: colorSchema, name: { type: 'string' } } },
        stagger: { type: 'array', description: 'delays applied to whole layers\' animations by key', items: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } }, step: { type: 'number', description: 'seconds between layers (default 0.08)' }, start: { type: 'number', description: 'extra delay for the whole block' }, order: { enum: ['sequential', 'reverse', 'center-out', 'edges-in', 'random'] }, seed: { type: 'number' } }, required: ['keys'] } },
        parent: { type: 'string', description: 'existing group layer id to build inside' },
        prune: { type: 'boolean', description: 'delete keyed layers from earlier build_scene calls that are not in this spec' },
      },
      required: ['layers'],
    },
    run: async a => text(await buildScene(a)),
  },
];

export { SCENE_TYPES };
