// tools the ai agents can call (exposed over mcp by the bridge). every tool goes through the
// same commands as the ui, so agent edits are undoable and show up live.

import { editor } from '../app/editor';
import {
  addLayer, cloneLayers, deleteLayers, groupLayers, isAnimated, keyId, setCompSettings, setEase, setLayerField, setProp,
  setPropTx, valueAt, setSpring, precompose, setExpr,
} from '../core/commands';
import { checkExpr, EXPR_PROPS } from '../core/expr';
import { EASE_PRESETS, SPRING_PRESETS } from '../core/easing';
import { ANIM_PRESETS, applyPreset, setTextAnim, TEXT_ANIM_PRESETS } from '../core/presets';
import { parsePathD } from '../import/svg';
import { PROP_DEFS, PROP_KEYS, TYPE_PROPS, TRANSFORM_KEYS, type Keyframe, type Layer, type LayerType, type PropKey } from '../core/model';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  run: (args: any) => Promise<ToolContent[]> | ToolContent[];
}
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

const st = () => editor.store;
const text = (v: unknown): ToolContent[] => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }];

const colorSchema = { description: 'color as "#rrggbb", "#rrggbbaa" or [r,g,b,a] with 0..1 floats', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }] };
const propValueSchema = { description: 'number, number array, or color (for fill/stroke)', anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }, { type: 'string' }] };
const easeSchema = { description: `ease preset name (${EASE_PRESETS.map(p => p.name).join(', ')}), spring preset (${SPRING_PRESETS.map(p => 'spring ' + p.name).join(', ')}), "spring:<bounce 0..0.9>", or cubic-bezier [x1,y1,x2,y2]`, anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }] };

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

function toValue(key: PropKey, v: any): number[] {
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

function checkProp(p: string): PropKey {
  if (!(PROP_KEYS as string[]).includes(p)) throw new Error(`unknown property "${p}". valid: ${PROP_KEYS.join(', ')}`);
  return p as PropKey;
}

function need(id: string): Layer {
  const l = st().layer(id);
  if (!l) throw new Error(`no layer with id "${id}"`);
  return l;
}

function round(v: number[]) { return v.map(x => Math.round(x * 1000) / 1000); }

function summarize(l: Layer, deep: boolean): any {
  const t = st().time;
  const o: any = { id: l.id, name: l.name, type: l.type };
  if (!l.visible) o.visible = false;
  const keys = [...TRANSFORM_KEYS, ...TYPE_PROPS[l.type]];
  const vals: any = {};
  const anim: any = {};
  for (const k of keys) {
    if (!l.props[k]) continue;
    vals[k] = round(valueAt(l, k, t));
    if (isAnimated(l, k)) anim[k] = l.props[k]!.kf!.length;
  }
  if (deep) o.props = vals;
  else { o.position = vals.position; o.size = vals.size; }
  if (Object.keys(anim).length) o.animated = anim;
  if (l.text) o.text = l.text.content.slice(0, 80);
  if (l.children.length) o.children = deep ? l.children.map(c => summarize(st().layer(c)!, deep)) : l.children.length;
  return o;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'get_document',
    description: 'Get the composition settings and the layer tree (top-level first in draw order bottom→top). Call this first. Set deep=false for big documents.',
    inputSchema: { type: 'object', properties: { deep: { type: 'boolean', default: true }, limit: { type: 'number', default: 300 } } },
    run: ({ deep = true, limit = 300 }) => {
      const s = st();
      const c = s.comp;
      const total = Object.keys(s.project.layers).length;
      const big = total > limit;
      return text({
        file: s.project.name,
        composition: { id: c.id, name: c.name, width: c.width, height: c.height, fps: c.fps, duration: c.duration, background: round(c.background) },
        compositions: Object.values(s.project.comps).map(x => ({ id: x.id, name: x.name, active: x.id === c.id })),
        currentTime: s.time,
        selection: s.selection,
        layerCount: total,
        note: big ? `large document: showing shallow summary of root layers; use get_layer for details` : undefined,
        layers: c.root.map(id => summarize(s.layer(id)!, deep && !big)),
      });
    },
  },
  {
    name: 'get_layer',
    description: 'Get the full JSON of one layer including all keyframes (times in seconds).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: ({ id }) => text(need(id)),
  },
  {
    name: 'add_layer',
    description: 'Add a layer. Coordinates are composition pixels (top-left origin, y down). x/y/w/h define the box; the anchor point is put at the center. Returns the new id. For text use type "text" with text options. Use parent to put it inside a group (coordinates then relative to the group box).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { enum: ['rect', 'ellipse', 'text', 'group', 'path'] },
        d: { type: 'string', description: 'for type "path": SVG path data in the layer box coordinates (0..w, 0..h), e.g. "M0 0 L100 0 L50 80 Z"' },
        name: { type: 'string' },
        x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
        fill: colorSchema,
        stroke: colorSchema,
        strokeWidth: { type: 'number' },
        radius: { type: 'number' },
        opacity: { type: 'number', description: '0..100' },
        rotation: { type: 'number', description: 'degrees clockwise' },
        parent: { type: 'string' },
        text: { type: 'object', properties: { content: { type: 'string' }, fontFamily: { type: 'string' }, fontSize: { type: 'number' }, fontWeight: { type: 'number' }, align: { enum: ['left', 'center', 'right'] }, lineHeight: { type: 'number' } } },
      },
      required: ['type'],
    },
    run: (a) => {
      const s = st();
      const type = a.type as LayerType;
      if (!['rect', 'ellipse', 'text', 'group', 'path'].includes(type)) throw new Error('type must be rect, ellipse, text, group or path');
      if (type === 'path' && typeof a.d !== 'string') throw new Error('path layers need "d" (SVG path data)');
      if (a.parent) need(a.parent);
      const init: any = { x: a.x ?? 0, y: a.y ?? 0, w: a.w ?? (type === 'text' ? 0 : 200), h: a.h ?? (type === 'text' ? 0 : 200), name: a.name };
      if (a.fill !== undefined) init.color = parseColor(a.fill);
      if (type === 'text') {
        init.text = { content: 'Text', fontFamily: 'Inter', fontSize: 64, fontWeight: 600, lineHeight: 1.2, letterSpacing: 0, align: 'left', ...(a.text ?? {}) };
        init.color ??= [1, 1, 1, 1];
      }
      if (!init.name) delete init.name;
      if (type === 'path') {
        const cmds = parsePathD(a.d);
        init.geometry = [{ cmds, fillRule: 'nonzero' }];
        init.geomSize = [init.w, init.h];
      }
      const l = addLayer(s, type, init, a.parent ?? null);
      s.transact('Agent: layer props', tx => {
        const L = s.layer(l.id)!;
        if (a.stroke !== undefined) setPropTx(tx, L, 'stroke', parseColor(a.stroke), s.time);
        if (a.strokeWidth !== undefined) setPropTx(tx, L, 'strokeWidth', [a.strokeWidth], s.time);
        if (a.radius !== undefined && L.props.radius) setPropTx(tx, L, 'radius', [a.radius, a.radius, a.radius, a.radius], s.time);
        if (a.opacity !== undefined) setPropTx(tx, L, 'opacity', [a.opacity], s.time);
        if (a.rotation !== undefined) setPropTx(tx, L, 'rotation', [a.rotation], s.time);
      });
      return text({ id: l.id });
    },
  },
  {
    name: 'update_layer',
    description: 'Change a layer. props sets values: if the property is animated this creates/updates a keyframe at the current time (like After Effects), otherwise it sets the static value. Properties: ' + PROP_KEYS.map(k => `${k} (${PROP_DEFS[k].dim}d, ${PROP_DEFS[k].unit})`).join(', '),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        visible: { type: 'boolean' },
        props: { type: 'object', additionalProperties: propValueSchema },
        text: { type: 'object' },
        inPoint: { type: 'number' }, outPoint: { type: 'number' },
      },
      required: ['id'],
    },
    run: (a) => {
      const s = st();
      const l = need(a.id);
      s.transact('Agent: update layer', tx => {
        if (a.name !== undefined) tx.set(l, 'name', String(a.name));
        if (a.visible !== undefined) { tx.set(l, 'visible', !!a.visible); tx.structure(); }
        if (a.inPoint !== undefined) tx.set(l, 'inPoint', a.inPoint);
        if (a.outPoint !== undefined) tx.set(l, 'outPoint', a.outPoint);
        if (a.text && l.text) tx.set(l, 'text', { ...l.text, ...a.text });
        const props = a.props ?? {};
        // keep a centered anchor centered when the size changes (unless the anchor is set explicitly)
        if (props.size !== undefined && props.anchor === undefined && !isAnimated(l, 'anchor')) {
          const sz = valueAt(l, 'size', s.time), an = valueAt(l, 'anchor', s.time);
          const ns = toValue('size', props.size);
          if (Math.abs(an[0] - sz[0] / 2) < 0.5 && Math.abs(an[1] - sz[1] / 2) < 0.5) setPropTx(tx, l, 'anchor', [ns[0] / 2, ns[1] / 2], s.time);
        }
        for (const [k, v] of Object.entries(props)) setPropTx(tx, l, checkProp(k), toValue(k as PropKey, v), s.time);
        tx.touch(l.id);
      });
      return text('ok');
    },
  },
  {
    name: 'set_keyframes',
    description: 'Animate a property with explicit keyframes (replaces existing keyframes of that property unless merge=true). t is seconds. ease applies to the segment leaving that keyframe. Position keyframes may have spatial tangents sOut/sIn ([dx,dy] relative) for curved motion paths.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        prop: { enum: PROP_KEYS },
        keyframes: {
          type: 'array',
          items: { type: 'object', properties: { t: { type: 'number' }, v: propValueSchema, ease: easeSchema, interp: { enum: ['bezier', 'linear', 'hold'] }, sOut: { type: 'array' }, sIn: { type: 'array' } }, required: ['t', 'v'] },
        },
        merge: { type: 'boolean' },
      },
      required: ['id', 'prop', 'keyframes'],
    },
    run: (a) => {
      const s = st();
      const l = need(a.id);
      const key = checkProp(a.prop);
      const incoming: Keyframe[] = (a.keyframes as any[]).map(k => {
        const ease = resolveEase(k.ease);
        return { t: +k.t, v: toValue(key, k.v), interp: k.interp ?? (ease.bounce !== undefined ? 'spring' : ease.linear ? 'linear' : 'bezier'), bounce: ease.bounce, out: [ease.v[0], ease.v[1]], in: [0.667, 1], sOut: k.sOut, sIn: k.sIn } as Keyframe;
      });
      incoming.sort((x, y) => x.t - y.t);
      // the "in" handle of key i+1 comes from the ease of key i
      const eases = (a.keyframes as any[]).slice().sort((x, y) => x.t - y.t).map(k => resolveEase(k.ease));
      for (let i = 1; i < incoming.length; i++) incoming[i].in = [eases[i - 1].v[2], eases[i - 1].v[3]];
      s.transact('Agent: keyframes', tx => {
        const p = l.props[key] ?? { v: valueAt(l, key, s.time) };
        if (!l.props[key]) tx.set(l.props, key, p);
        let kf = incoming;
        if (a.merge && p.kf) {
          const rest = p.kf.filter(k => !incoming.some(n => Math.abs(n.t - k.t) < 1e-6));
          kf = [...rest, ...incoming].sort((x, y) => x.t - y.t);
        }
        tx.set(p, 'kf', kf);
        tx.touch(l.id);
      });
      (globalThis as any).timeline?.expand(l.id, true);
      return text(`set ${incoming.length} keyframes on ${l.name}.${key}`);
    },
  },
  {
    name: 'set_easing',
    description: 'Set easing on existing keyframes of a property (indices default to all).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, prop: { enum: PROP_KEYS }, indices: { type: 'array', items: { type: 'number' } }, ease: easeSchema }, required: ['id', 'prop', 'ease'] },
    run: (a) => {
      const l = need(a.id);
      const key = checkProp(a.prop);
      const kf = l.props[key]?.kf ?? [];
      const idx: number[] = a.indices ?? kf.map((_, i) => i);
      const e = resolveEase(a.ease);
      const ids = idx.map(i => keyId(l.id, key, i));
      if (e.bounce !== undefined) setSpring(st(), ids, e.bounce);
      else setEase(st(), ids, e.v, e.linear ? 'linear' : 'bezier');
      return text('ok');
    },
  },
  {
    name: 'delete_layers',
    description: 'Delete layers (and their children).',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
    run: ({ ids }) => { deleteLayers(st(), ids); return text('ok'); },
  },
  {
    name: 'duplicate_layers',
    description: 'Duplicate layers; returns new ids.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, offset: { type: 'number' } }, required: ['ids'] },
    run: ({ ids, offset = 0 }) => text({ ids: cloneLayers(st(), ids, offset) }),
  },
  {
    name: 'group_layers',
    description: 'Group sibling layers into a new group. Returns the group id.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, name: { type: 'string' } }, required: ['ids'] },
    run: ({ ids, name }) => {
      const b = editor.renderer ? boundsOf(ids) : { x: 0, y: 0, w: 100, h: 100 };
      const g = groupLayers(st(), ids, b);
      if (g && name) setLayerField(st(), [g.id], 'name', name);
      return text({ id: g?.id });
    },
  },
  {
    name: 'set_composition',
    description: 'Change composition settings.',
    inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, fps: { type: 'number' }, duration: { type: 'number', description: 'seconds' }, background: colorSchema, name: { type: 'string' } } },
    run: (a) => { setCompSettings(st(), { ...a, background: a.background !== undefined ? parseColor(a.background) as any : undefined }); return text('ok'); },
  },
  {
    name: 'set_time',
    description: 'Move the playhead (seconds). Values set with update_layer on animated properties go to this time.',
    inputSchema: { type: 'object', properties: { t: { type: 'number' } }, required: ['t'] },
    run: ({ t }) => { editor.pause(); st().setTime(t); return text('ok'); },
  },
  {
    name: 'playback',
    description: 'Play or pause the preview.',
    inputSchema: { type: 'object', properties: { play: { type: 'boolean' } }, required: ['play'] },
    run: ({ play }) => { play ? editor.play() : editor.pause(); return text('ok'); },
  },
  {
    name: 'select_layers',
    description: 'Select layers in the editor (shows them to the user).',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
    run: ({ ids }) => { st().select(ids.filter((id: string) => st().layer(id))); return text('ok'); },
  },
  {
    name: 'screenshot',
    description: 'Render the composition at a time (seconds, default current) and return a PNG. Use it to check your work. times: render several frames side by side info as separate images (max 4).',
    inputSchema: { type: 'object', properties: { t: { type: 'number' }, times: { type: 'array', items: { type: 'number' } }, maxSize: { type: 'number', default: 768 } } },
    run: ({ t, times, maxSize = 768 }) => {
      const list: number[] = times?.length ? times.slice(0, 4) : [t ?? st().time];
      return list.map(tt => ({ type: 'image' as const, data: editor.renderer.snapshot(tt, maxSize).split(',')[1], mimeType: 'image/png' }));
    },
  },
  {
    name: 'apply_preset',
    description: 'Apply a ready-made animation to layers at a time (default: playhead). "in" presets start at t, "out" presets end at t. stagger offsets each next layer (seconds) — great for lists/logos. Presets: ' + ANIM_PRESETS.map(p => `${p.name} (${p.kind})`).join(', '),
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, preset: { type: 'string' }, t: { type: 'number' }, duration: { type: 'number', default: 0.6 }, stagger: { type: 'number', default: 0 } }, required: ['ids', 'preset'] },
    run: ({ ids, preset, t, duration, stagger }) => {
      if (t !== undefined) st().setTime(t);
      applyPreset(st(), ids, preset, { duration, stagger });
      return text('ok');
    },
  },
  {
    name: 'set_text_animation',
    description: 'Per-letter / per-word / per-line text reveal on text layers (like After Effects text animators). Use a preset name (' + TEXT_ANIM_PRESETS.map(p => p.name).join(', ') + ') and/or explicit fields. start = seconds into the layer. from = the state units animate from (mode in) or to (mode out). Pass remove:true to remove.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } }, preset: { type: 'string' }, remove: { type: 'boolean' },
        by: { enum: ['char', 'word', 'line'] }, start: { type: 'number' }, duration: { type: 'number' }, stagger: { type: 'number' },
        ease: { type: 'string', description: 'ease preset name or "spring:<bounce>"' }, mode: { enum: ['in', 'out'] }, order: { enum: ['forward', 'backward', 'center', 'random'] },
        from: { type: 'object', properties: { opacity: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' }, scale: { type: 'number' }, rotation: { type: 'number' } } },
      },
      required: ['ids'],
    },
    run: (a) => {
      if (a.remove) { setTextAnim(st(), a.ids, undefined); return text('removed'); }
      const base = a.preset ? TEXT_ANIM_PRESETS.find(p => p.name.toLowerCase() === String(a.preset).toLowerCase())?.anim : TEXT_ANIM_PRESETS[0].anim;
      if (!base) throw new Error('unknown preset; presets: ' + TEXT_ANIM_PRESETS.map(p => p.name).join(', '));
      const anim = { ...base, start: 0, ...Object.fromEntries(['by', 'start', 'duration', 'stagger', 'ease', 'mode', 'order'].filter(k => a[k] !== undefined).map(k => [k, a[k]])), from: { ...base.from, ...(a.from ?? {}) } } as any;
      setTextAnim(st(), a.ids, anim);
      return text('ok');
    },
  },
  {
    name: 'precompose',
    description: 'Pre-compose top-level layers of the active composition into a new composition (After Effects style). Returns the new comp id and the precomp layer id. Useful to animate a group of layers as one unit or to reuse it.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, name: { type: 'string' } }, required: ['ids'] },
    run: ({ ids, name }) => { const r = precompose(st(), ids, name); return text({ compId: r.comp.id, layerId: r.layer.id }); },
  },
  {
    name: 'open_composition',
    description: 'Switch the editor (and all other tools) to another composition by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: ({ id }) => { if (!st().project.comps[id]) throw new Error('no such composition'); st().openComp(id); return text('ok'); },
  },
  {
    name: 'set_expression',
    description: 'Drive a property with an expression (After Effects style, safe subset). Variables: time, value (the keyframed value), index, fps, duration. Functions: wiggle(freq, amp), loopOut(\'cycle\'|\'pingpong\'|\'offset\'|\'continue\'), loopIn(...), linear(t,t0,t1,v0,v1), ease(...), sin/cos/abs/min/max/clamp/random/noise, valueAtTime(t). Vectors: [x, y] with element-wise math. Pass expr "" to remove.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, prop: { enum: EXPR_PROPS }, expr: { type: 'string' } }, required: ['ids', 'prop', 'expr'] },
    run: ({ ids, prop, expr }) => {
      const key = checkProp(prop);
      if (!EXPR_PROPS.includes(key)) throw new Error(`expressions are supported on: ${EXPR_PROPS.join(', ')}`);
      if (expr) { const err = checkExpr(expr, PROP_DEFS[key].dim); if (err) throw new Error('expression error: ' + err); }
      setExpr(st(), ids, key, expr || undefined);
      return text('ok');
    },
  },
  {
    name: 'export_video',
    description: 'Render the active composition to a video file. Desktop app: saved to the Movies/Videos "Motion" folder (returns the path). Browser: downloaded. Takes a while for long comps.',
    inputSchema: { type: 'object', properties: { format: { enum: ['mp4', 'webm', 'gif'] }, scale: { type: 'number', description: '0.5, 1 or 2 (resolution multiplier)' }, quality: { enum: ['low', 'medium', 'high'] } } },
    run: async (a) => {
      if (a.format === 'gif') {
        const { exportGifFile } = await import('../app/actions');
        const blob = await exportGifFile();
        return text({ format: 'gif', bytes: blob.size });
      }
      const { exportVideoDetailed } = await import('../export/video');
      const res = await exportVideoDetailed({ format: a.format ?? 'mp4', scale: a.scale ?? 1, quality: a.quality ?? 'high' });
      const name = `${(st().project.name || 'motion').replace(/[^\w\- ]+/g, '_')} - ${st().comp.name}.${res.format}`;
      const native = (globalThis as any).motionNative;
      if (native?.saveExport) {
        const buf = new Uint8Array(await res.blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        const path = await native.saveExport({ name, data: btoa(bin), encoding: 'base64' });
        return text({ saved: path, format: res.format, codec: res.codec, frames: res.frames, bytes: buf.length });
      }
      const { download } = await import('../app/actions');
      download(name, res.blob, res.blob.type);
      return text({ downloaded: name, format: res.format, codec: res.codec, frames: res.frames, bytes: res.blob.size });
    },
  },
  {
    name: 'undo',
    description: 'Undo the last change (also user changes!).',
    inputSchema: { type: 'object', properties: {} },
    run: () => { st().undo(); return text('ok'); },
  },
];

function resolveEase(e: any): { v: [number, number, number, number]; linear: boolean; bounce?: number } {
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

export const AGENT_SYSTEM_PROMPT = `You are working inside "Motion", a motion design editor (like After Effects / Figma Motion).
You can see and edit the user's open document only through the mcp__motion__* tools.
Conventions: composition pixels, origin top-left, y down. Times in seconds. Rotation in degrees clockwise.
Opacity and scale are percent (100 = normal). Colors are "#rrggbb" or [r,g,b,a] 0..1.
Each layer has an anchor point (default: center of its box) and position = where the anchor sits in the parent.
Layers inside a group use coordinates relative to the group's box.

Tools by job (prefer the high level ones):
- Entrances/exits/loops for one or many layers: apply_preset (Fade in, Slide up, Pop, Zoom in, Spin in, Fade out, Pulse, ...) with stagger for lists.
- Text reveals per letter/word/line: set_text_animation (presets: Fade up, Typewriter, Pop letters, Slide words, Drop lines, Spin letters, Center burst).
- Precise motion: set_keyframes with eases ("Expo Out" for entrances, "Back Out" for playful pops, "Easy Ease" for neutral moves, "spring Bouncy"/"spring:0.4" for physical motion). Position keys can curve with sOut/sIn.
- Procedural motion: set_expression (wiggle(2, 20), time * 90, loopOut('pingpong'), linear(time, 0, 1, 0, 100)).
- Custom shapes: add_layer type "path" with SVG path data in "d".
- Organize: group_layers, precompose (animate a group as one unit), open_composition.
- Check your work with screenshot (several times, e.g. times: [0.5, 1, 2]); export_video renders an MP4 when the user asks for a file.
Always call get_document first. Keep the user's existing work intact unless asked; every change is undoable (the user also gets a one-click "undo agent changes").
Keep replies short: say what you made and offer one or two tweaks.`;
