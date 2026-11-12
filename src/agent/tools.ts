// tools the ai agents can call (exposed over mcp by the bridge). every tool goes through the
// same commands as the ui, so agent edits are undoable and show up live.

import { editor } from '../app/editor';
import {
  addLayer, cloneLayers, deleteLayers, groupLayers, isAnimated, keyId, setCompSettings, setEase, setLayerField, setProp,
  setPropTx, valueAt, setSpring, precompose, setExpr, addMarker, updateMarker, deleteMarker,
} from '../core/commands';
import { checkExpr, EXPR_PROPS } from '../core/expr';
import { EASE_PRESETS, SPRING_PRESETS } from '../core/easing';
import { ANIM_PRESETS, applyPreset, setTextAnim, TEXT_ANIM_PRESETS } from '../core/presets';
import { parsePathD } from '../import/svg';
import { PROP_DEFS, PROP_KEYS, TYPE_PROPS, TRANSFORM_KEYS, type Keyframe, type Layer, type LayerType, type PropKey } from '../core/model';
import type { Tx } from '../core/store';
import { animRange, describeLayerAnimation, fmtTime } from './describe';
import { editorContext } from './context';
import { variations } from './variations';
import { addToken, BINDABLE, findToken, linkProp, prettyName, setTokenMode, setTokenValue, tokenUsage, tokenValue, linkOf } from '../core/tokens';
import { toHex } from '../core/token-sync';
import { createComponent, createInstance, instanceRootOf, instancesOf } from '../core/components';
import { SHADER_TOOLS } from './shader-tools';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  run: (args: any) => Promise<ToolContent[]> | ToolContent[];
  /** does not change the document (allowed in Ask mode; advertised as readOnlyHint over MCP) */
  readOnly?: boolean;
}
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

const st = () => editor.store;
// compact json: tool results go straight into the model context, whitespace is wasted tokens
const text = (v: unknown): ToolContent[] => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }];

const colorSchema = { description: 'color as "#rrggbb", "#rrggbbaa" or [r,g,b,a] with 0..1 floats', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }] };
const propValueSchema = { description: 'number, number array, or color (for fill/stroke)', anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }, { type: 'string' }] };
const vec2Schema = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
const easeSchema = { description: `ease preset name (${EASE_PRESETS.map(p => p.name).join(', ')}), spring preset (${SPRING_PRESETS.map(p => 'spring ' + p.name).join(', ')}), "spring:<bounce 0..0.9>", or cubic-bezier [x1,y1,x2,y2]`, anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }] };

const keyframeSchema = {
  type: 'object',
  properties: {
    t: { type: 'number', description: 'seconds' }, v: propValueSchema, ease: easeSchema,
    interp: { enum: ['bezier', 'linear', 'hold'] },
    sOut: { ...vec2Schema, description: 'position only: outgoing spatial tangent [dx,dy]' },
    sIn: { ...vec2Schema, description: 'position only: incoming spatial tangent [dx,dy]' },
  },
  required: ['t', 'v'],
};
const idsSchema = { type: 'array', items: { type: 'string' } };

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
  const P = st().project;
  if (P.tokens) {
    const linked: any = {};
    for (const k of BINDABLE) { const id = linkOf(l, k); const tk = id ? P.tokens.items[id] : undefined; if (tk) linked[k] = tk.name; }
    if (Object.keys(linked).length) o.linkedStyles = linked;
  }
  if (P.components?.[l.id]) o.component = P.components[l.id].name;
  else if (l.link && P.components?.[l.link.main]) o.instanceOf = P.components[l.link.main].name;
  if (l.link?.ov?.length) o.overrides = l.link.ov;
  if (l.children.length) o.children = deep ? l.children.map(c => summarize(st().layer(c)!, deep)) : l.children.length;
  return o;
}

function needComponent(ref: string): string {
  const P = st().project;
  if (P.components?.[ref] && P.layers[ref]) return ref;
  const hit = Object.entries(P.components ?? {}).find(([id, c]) => P.layers[id] && c.name.toLowerCase() === String(ref).toLowerCase());
  if (!hit) throw new Error(`no component "${ref}". components: ${Object.values(P.components ?? {}).map(c => c.name).join(', ') || 'none (create_component first)'}`);
  return hit[0];
}

const STYLE_TOOLS: ToolDef[] = [
  {
    name: 'list_styles',
    readOnly: true,
    description: 'List the project library: named color/number styles (design tokens, e.g. "Brand/Primary", synced from Figma or a tokens file) with values in the active mode and how many layers use them, the modes (e.g. Light/Dark), and the components with their instance counts. Prefer linking layers to these styles over hard-coded colors.',
    inputSchema: { type: 'object', properties: {} },
    run: () => {
      const P = st().project;
      const lib = P.tokens;
      const usage = tokenUsage(P);
      const styles = Object.values(lib?.items ?? {}).map(t => {
        const v = tokenValue(lib!, t);
        return { id: t.id, name: t.name, type: t.type, value: t.type === 'color' ? toHex(v) : v[0], usedBy: usage.get(t.id)?.layers.size ?? 0, ...(t.missing ? { removedFromLibrary: true } : {}) };
      });
      const components = Object.entries(P.components ?? {}).filter(([id]) => P.layers[id]).map(([id, c]) => ({ id, name: c.name, instances: instancesOf(P, id).length }));
      return text({ mode: lib?.mode, modes: lib?.modes, styles, components });
    },
  },
  {
    name: 'link_style',
    description: `Link a layer property to a named style so it follows library changes (colors: fill, stroke; numbers: opacity, radius, strokeWidth). On an animated property the keyframe at "time" (default: playhead) is linked. style null (or "") detaches and keeps the current value.`,
    inputSchema: { type: 'object', properties: { ids: idsSchema, prop: { enum: BINDABLE }, style: { description: 'style name ("Brand/Primary") or id; null to detach', anyOf: [{ type: 'string' }, { type: 'null' }] }, time: { type: 'number' } }, required: ['ids', 'prop'] },
    run: ({ ids, prop, style, time }) => {
      const key = checkProp(prop);
      ids.forEach(need);
      if (!style) { linkProp(st(), ids, key, null, time); return text('detached'); }
      const t = findToken(st().project, style);
      if (!t) throw new Error(`no style "${style}". use list_styles, or set_style to create one`);
      linkProp(st(), ids, key, t.id, time ?? st().time);
      return text(`linked ${ids.length} layer(s) ${key} to ${t.name}`);
    },
  },
  {
    name: 'set_style',
    description: 'Create a named color or number style, or change its value (every linked layer and keyframe updates, one undo step). Use "/" to group: "Brand/Primary". mode: which mode to change (default: the active one).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, value: { description: 'color ("#rrggbb", [r,g,b,a]) or a number', anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'array', items: { type: 'number' } }] }, mode: { type: 'string' } }, required: ['name', 'value'] },
    run: ({ name, value, mode }) => {
      const s = st();
      const isNum = typeof value === 'number';
      const v = isNum ? [value] : parseColor(value);
      const t = findToken(s.project, name);
      if (t) {
        if ((t.type === 'number') !== isNum) throw new Error(`${t.name} is a ${t.type} style`);
        setTokenValue(s, t.id, v, { mode });
        return text({ id: t.id, updated: t.name });
      }
      const n = addToken(s, { name, type: isNum ? 'number' : 'color', value: v });
      return text({ id: n.id, created: n.name });
    },
  },
  {
    name: 'set_style_mode',
    description: 'Switch the library mode (e.g. "Light" / "Dark"): every linked value changes to that mode\'s value.',
    inputSchema: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'] },
    run: ({ mode }) => {
      const lib = st().project.tokens;
      const m = lib?.modes.find(x => x.toLowerCase() === String(mode).toLowerCase());
      if (!m) throw new Error(`no mode "${mode}". modes: ${lib?.modes.join(', ') ?? 'none'}`);
      setTokenMode(st(), m);
      return text(`mode ${m}`);
    },
  },
  {
    name: 'create_component',
    description: 'Make a layer (usually a group, e.g. a logo, button or card, with its animation) a reusable main component. Instances follow every later change of the main (properties, keyframes, added/removed layers) except properties changed on the instance (overrides).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id'] },
    run: ({ id, name }) => { need(id); const c = createComponent(st(), id, name); return text({ component: id, name: c.name }); },
  },
  {
    name: 'add_instance',
    description: 'Add an instance of a component to the active composition (or inside a parent group). x/y = where its position goes (default: next to the main). delay = seconds its animation starts after the main\'s. Edit instance layers with update_layer etc. to override.',
    inputSchema: { type: 'object', properties: { component: { type: 'string', description: 'component id or name' }, x: { type: 'number' }, y: { type: 'number' }, delay: { type: 'number' }, parent: { type: 'string' } }, required: ['component'] },
    run: ({ component, x, y, delay, parent }) => {
      const mainId = needComponent(component);
      if (parent) need(parent);
      const l = createInstance(st(), mainId, { x, y, delay, parent: parent ?? null });
      return text({ id: l.id, name: l.name, instanceOf: prettyName(st().project.components![mainId].name), children: l.children.length, root: instanceRootOf(st().project, l.id) === l.id });
    },
  },
];

export const TOOLS: ToolDef[] = [
  {
    name: 'get_document',
    readOnly: true,
    description: 'Get the composition settings and the layer tree (top-level first in draw order bottom→top). Call this first. Set deep=false for big documents.',
    inputSchema: { type: 'object', properties: { deep: { type: 'boolean', default: true }, limit: { type: 'number', default: 300 } } },
    run: ({ deep = true, limit = 300 }) => {
      const s = st();
      const c = s.comp;
      const total = Object.keys(s.project.layers).length;
      const big = total > limit;
      return text({
        file: s.project.name,
        composition: { id: c.id, name: c.name, width: c.width, height: c.height, fps: c.fps, duration: c.duration, background: round(c.background), markers: (c.markers ?? []).map(m => ({ id: m.id, t: m.t, label: m.label })) },
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
    description: 'Get the JSON of one layer including all keyframes (times in seconds). Large path geometry is summarized unless full=true. For reading animation, get_animation is much more compact.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, full: { type: 'boolean', description: 'include full path geometry' } }, required: ['id'] },
    readOnly: true,
    run: ({ id, full }) => {
      const l = need(id);
      if (full) return text(l);
      const o: any = { ...l };
      const cmds = (g?: { cmds: unknown[] }[]) => (g ?? []).reduce((n, x) => n + x.cmds.length, 0);
      if (l.geometry && cmds(l.geometry) > 40) o.geometry = `${l.geometry.length} paths, ${cmds(l.geometry)} commands (pass full:true)`;
      if (l.strokeGeometry && cmds(l.strokeGeometry) > 40) o.strokeGeometry = '(omitted)';
      if (l.pathKf?.length) o.pathKf = l.pathKf.map(k => ({ t: k.t, interp: k.interp, commands: cmds(k.geometry) }));
      delete o.collapsed;
      // style ids mean nothing to the model: name them
      const P = st().project;
      const linked: any = {};
      for (const k of BINDABLE) { const tid = linkOf(l, k); const tk = tid ? P.tokens?.items[tid] : undefined; if (tk) linked[k] = tk.name; }
      if (Object.keys(linked).length) o.linkedStyles = linked;
      if (l.link && P.components?.[l.link.main]) o.instanceOf = P.components[l.link.main].name;
      return text(o);
    },
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
          items: keyframeSchema,
        },
        merge: { type: 'boolean' },
      },
      required: ['id', 'prop', 'keyframes'],
    },
    run: (a) => {
      const s = st();
      const l = need(a.id);
      const key = checkProp(a.prop);
      const incoming = buildKeys(key, a.keyframes);
      s.transact('Agent: keyframes', tx => writeTrack(tx, l, key, incoming, !!a.merge));
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
    name: 'smart_animate',
    description: 'Figma-style smart animate between two versions of a design (e.g. two pasted frames, start and end state). Layers are matched by name path inside the two roots; every differing property gets keys from t0 to t0+duration, unmatched layers fade in/out, and the end root is removed (the start root becomes the animated one).',
    inputSchema: { type: 'object', properties: { start_id: { type: 'string' }, end_id: { type: 'string' }, t0: { type: 'number', description: 'seconds, default playhead' }, duration: { type: 'number', default: 0.6 }, ease: { type: 'string', description: 'ease preset name, default "Cubic Out"' }, spring: { type: 'number', description: 'use a spring with this bounce (0..1) instead of an ease' } }, required: ['start_id', 'end_id'] },
    run: async ({ start_id, end_id, t0, duration, ease, spring }) => {
      const { smartAnimate } = await import('../core/smart');
      const r = smartAnimate(st(), start_id, end_id, { t0, duration, ease, spring });
      return text(JSON.stringify(r));
    },
  },
  {
    name: 'set_markers',
    description: 'Timeline markers (e.g. beats or story moments the user cares about). add: [{t, label}], remove: marker ids. Returns the markers. Markers are listed in get_document.',
    inputSchema: { type: 'object', properties: { add: { type: 'array', items: { type: 'object', properties: { t: { type: 'number' }, label: { type: 'string' } }, required: ['t'] } }, remove: { type: 'array', items: { type: 'string' } } } },
    run: ({ add, remove }) => {
      st().batch('Agent markers', () => {
        for (const id of remove ?? []) deleteMarker(st(), id);
        for (const m of add ?? []) { const mk = addMarker(st(), +m.t, m.label ?? ''); if (m.label && mk.label !== m.label) updateMarker(st(), mk.id, { label: m.label }); }
      }, 'Agent: markers');
      return text(JSON.stringify(st().comp.markers ?? []));
    },
  },
  {
    name: 'set_time',
    readOnly: true,
    description: 'Move the playhead (seconds). Values set with update_layer on animated properties go to this time.',
    inputSchema: { type: 'object', properties: { t: { type: 'number' } }, required: ['t'] },
    run: ({ t }) => { editor.pause(); st().setTime(t); return text('ok'); },
  },
  {
    name: 'playback',
    readOnly: true,
    description: 'Play or pause the preview.',
    inputSchema: { type: 'object', properties: { play: { type: 'boolean' } }, required: ['play'] },
    run: ({ play }) => { play ? editor.play() : editor.pause(); return text('ok'); },
  },
  {
    name: 'select_layers',
    readOnly: true,
    description: 'Select layers in the editor (shows them to the user).',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
    run: ({ ids }) => { st().select(ids.filter((id: string) => st().layer(id))); return text('ok'); },
  },
  {
    name: 'screenshot',
    readOnly: true,
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
  {
    name: 'get_editor_context',
    description: 'What the user is looking at right now: composition, playhead, work area, markers, selected layers (with what is animated) and selected keyframes. "this"/"these" in the user\'s message usually mean the selection.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    run: () => text(editorContext(st())),
  },
  {
    name: 'get_animation',
    description: 'Read the animation of layers compactly, one line per animated property: "scale: 0.2s 0 ─Back Out→ 0.8s 100". Shows keyframe times, values, eases/springs, expressions and text animators. Much cheaper than get_layer. ids default to the selection, else every animated layer.',
    inputSchema: { type: 'object', properties: { ids: { ...idsSchema, description: 'layer ids (children are not included automatically)' }, includeStatic: { type: 'boolean', description: 'also list layers without animation' } } },
    readOnly: true,
    run: ({ ids, includeStatic }) => {
      const s = st();
      const list: Layer[] = (ids?.length ? ids.map(need) : s.selection.length ? s.selection.map(need) : s.drawOrder().map(id => s.layer(id)!));
      const out: string[] = [`comp ${fmtTime(s.comp.duration)} @${s.comp.fps}fps`];
      let n = 0;
      for (const l of list) {
        const d = describeLayerAnimation(l, { always: !!includeStatic || !!ids?.length });
        if (!d) continue;
        if (++n > 80) { out.push(`… more layers omitted; pass ids`); break; }
        out.push(d);
      }
      if (n === 0) out.push('no animated layers' + (ids?.length || s.selection.length ? ' in the given set' : ''));
      return text(out.join('\n'));
    },
  },
  {
    name: 'animate',
    description: 'Set keyframes on many layers/properties in ONE call and ONE undo step (preferred over many set_keyframes calls). Each track replaces that property\'s keys unless merge=true. stagger (seconds) delays each next distinct layer in track order — handy for lists.',
    inputSchema: {
      type: 'object',
      properties: {
        tracks: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, prop: { enum: PROP_KEYS }, keyframes: { type: 'array', items: keyframeSchema }, merge: { type: 'boolean' } },
            required: ['id', 'prop', 'keyframes'],
          },
        },
        stagger: { type: 'number', description: 'seconds added per distinct layer (0 for the first)' },
      },
      required: ['tracks'],
    },
    run: ({ tracks, stagger = 0 }) => {
      const s = st();
      if (!Array.isArray(tracks) || !tracks.length) throw new Error('tracks must be a non-empty array');
      const order: string[] = [];
      const prepared = tracks.map((tr: any, i: number) => {
        const l = need(tr.id);
        const key = checkProp(tr.prop);
        if (!Array.isArray(tr.keyframes) || !tr.keyframes.length) throw new Error(`tracks[${i}].keyframes must be a non-empty array`);
        if (!order.includes(l.id)) order.push(l.id);
        const delay = order.indexOf(l.id) * stagger;
        return { l, key, kf: buildKeys(key, tr.keyframes.map((k: any) => ({ ...k, t: +k.t + delay }))), merge: !!tr.merge };
      });
      s.transact('Agent: animate', tx => { for (const p of prepared) writeTrack(tx, p.l, p.key, p.kf, p.merge); });
      for (const id of order) (globalThis as any).timeline?.expand(id, true);
      return text(`ok: ${prepared.length} tracks on ${order.length} layers`);
    },
  },
  {
    name: 'retime',
    description: 'Speed up / slow down / shift animation: key times become pivot + (t - pivot) * scale + offset, for every animated property, path shape keys and text animators of the layers. scale 1.25 = 25% slower, 0.8 = faster. ids default to the selection, else all layers. pivot defaults to the earliest key.',
    inputSchema: { type: 'object', properties: { ids: idsSchema, scale: { type: 'number', default: 1 }, offset: { type: 'number', default: 0, description: 'seconds' }, pivot: { type: 'number' } } },
    run: ({ ids, scale = 1, offset = 0, pivot }) => {
      const s = st();
      if (!(scale > 0) || !isFinite(scale)) throw new Error('scale must be a positive number');
      if (!isFinite(offset) || (pivot != null && !isFinite(pivot))) throw new Error('offset and pivot must be numbers');
      const list: Layer[] = ids?.length ? ids.map(need) : s.selection.length ? s.selection.map(need) : Object.values(s.project.layers);
      const ranges = list.map(animRange).filter(Boolean) as [number, number][];
      if (!ranges.length) throw new Error('none of these layers is animated');
      const p0 = pivot ?? Math.min(...ranges.map(r => r[0]));
      // the whole mapping must keep keys at t >= 0: clamping each key would stack them on 0
      const earliest = Math.min(...ranges.map(r => r[0]));
      const mapped0 = p0 + (earliest - p0) * scale + offset;
      if (mapped0 < -1e-9) throw new Error(`this would move the first key to ${fmtTime(mapped0)} (before 0). The smallest allowed offset here is ${fmtTime(offset - mapped0)}.`);
      const f = (t: number) => Math.max(0, p0 + (t - p0) * scale + offset);
      let end = 0;
      s.transact('Agent: retime', tx => {
        for (const l of list) {
          if (shiftLayerKeys(tx, l, f, scale)) { end = Math.max(end, animRange(l)?.[1] ?? 0); tx.touch(l.id); }
        }
      });
      return text(`retimed ${ranges.length} layers; animation now ends at ${fmtTime(end)}${end > s.comp.duration ? ` — past the comp end (${fmtTime(s.comp.duration)}); consider set_composition duration` : ''}`);
    },
  },
  {
    name: 'stagger',
    description: 'Offset whole layer animations so each next layer (in the given order) starts `step` seconds after the previous one. Keeps each layer\'s own timing. start = when the first layer starts (default: its current start).',
    inputSchema: { type: 'object', properties: { ids: { ...idsSchema, description: 'in order; default: selection order' }, step: { type: 'number', description: 'seconds, e.g. 0.08' }, start: { type: 'number' } }, required: ['step'] },
    run: ({ ids, step, start }) => {
      const s = st();
      const list: Layer[] = (ids?.length ? ids : s.selection).map(need);
      if (list.length < 2) throw new Error('stagger needs at least two layers (pass ids or select them)');
      const animated = list.filter(l => animRange(l));
      if (!animated.length) throw new Error('none of these layers is animated yet; animate them first (e.g. apply_preset with stagger)');
      if (!isFinite(step) || (start != null && !isFinite(start))) throw new Error('step and start must be numbers');
      const base = start ?? animRange(animated[0])![0];
      // every layer's first key must stay at t >= 0 (clamping per key would stack keys on 0)
      for (const [i, l] of animated.entries()) {
        const at = base + i * step;
        if (at < -1e-9) throw new Error(`layer "${l.name}" would start at ${fmtTime(at)} (before 0); use a later start or a positive step`);
      }
      s.transact('Agent: stagger', tx => {
        animated.forEach((l, i) => {
          const d = base + i * step - animRange(l)![0];
          if (Math.abs(d) > 1e-9) { shiftLayerKeys(tx, l, t => Math.max(0, t + d), 1); tx.touch(l.id); }
        });
      });
      const skipped = list.length - animated.length;
      return text(`staggered ${animated.length} layers by ${step}s${skipped ? `; skipped ${skipped} without animation` : ''}`);
    },
  },
  {
    name: 'contact_sheet',
    description: 'One image with a grid of frames over time (like a film contact sheet), each labeled with its time. The cheapest way to SEE motion: use it to check timing, spacing and overlaps, or to critique an animation. Defaults: 6 frames across the work area or the whole composition.',
    inputSchema: { type: 'object', properties: { frames: { type: 'number', default: 6, description: '2..12' }, start: { type: 'number' }, end: { type: 'number' }, times: { type: 'array', items: { type: 'number' }, description: 'explicit times instead of frames/start/end' }, cell: { type: 'number', default: 320, description: 'max cell size in px' } } },
    readOnly: true,
    run: async ({ frames = 6, start, end, times, cell = 320 }) => {
      const s = st();
      const wa = s.workArea;
      const a = start ?? wa?.[0] ?? 0, b = end ?? wa?.[1] ?? s.comp.duration;
      const n = Math.max(2, Math.min(12, Math.round(frames)));
      const list: number[] = times?.length ? times.slice(0, 12).map(Number) : Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
      const ts = list.map(t => Math.min(s.comp.duration, Math.max(0, Math.round(t * s.comp.fps) / s.comp.fps)));
      const img = await contactSheet(ts, Math.max(96, Math.min(512, cell)));
      return [{ type: 'text', text: `${ts.length} frames left→right, top→bottom at ${ts.map(fmtTime).join(', ')}` }, { type: 'image', data: img, mimeType: 'image/jpeg' }];
    },
  },
  {
    name: 'save_variation',
    description: 'Save the current animation of some layers as a named variation the user can preview and pick in the sidebar (A/B/C). Workflow: build version A, save_variation; change it into version B, save_variation; ... The last saved one stays applied. Use distinct ideas (e.g. snappy / bouncy / elegant), not tiny tweaks.',
    inputSchema: { type: 'object', properties: { ids: { ...idsSchema, description: 'every layer whose animation differs between the variations' }, label: { type: 'string', description: 'short, e.g. "B · Bouncy"' }, note: { type: 'string', description: 'one line: what is different' } }, required: ['ids', 'label'] },
    run: ({ ids, label, note }) => {
      const v = variations.capture(st(), ids, label, note);
      return text(`saved variation ${JSON.stringify(v.label)} (${Object.keys(v.layers).length} layers, id ${v.id}); ${variations.list.length} variations so far.`);
    },
  },
  {
    name: 'apply_variation',
    description: 'Apply a saved variation (by id) to the document, e.g. to go back to a base before building the next one.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: ({ id }) => { const v = variations.apply(st(), id); return text(`applied ${JSON.stringify(v.label)}`); },
  },
  ...STYLE_TOOLS,
  ...SHADER_TOOLS,
];

/** keyframes from the tool format ({t, v, ease, interp, sOut, sIn}) to the model format */
function buildKeys(key: PropKey, raw: any[]): Keyframe[] {
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

function writeTrack(tx: Tx, l: Layer, key: PropKey, incoming: Keyframe[], merge: boolean) {
  const s = st();
  const p = l.props[key] ?? { v: valueAt(l, key, s.time) };
  if (!l.props[key]) tx.set(l.props, key, p);
  let kf = incoming;
  if (merge && p.kf) {
    const rest = p.kf.filter(k => !incoming.some(n => Math.abs(n.t - k.t) < 1e-6));
    kf = [...rest, ...incoming].sort((x, y) => x.t - y.t);
  }
  tx.set(p, 'kf', kf);
  tx.touch(l.id);
}

/** remap every key time of a layer (props, path shape, text animator). returns whether anything moved */
function shiftLayerKeys(tx: Tx, l: Layer, f: (t: number) => number, scale: number): boolean {
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
async function contactSheet(times: number[], cell: number): Promise<string> {
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

Every user message ends with an <editor_context> block: composition, playhead, markers, the SELECTED layers
(ids, what is animated) and layers the user @-mentioned. "this", "these", "it" mean the selection unless said otherwise.
If the selection already tells you enough, you don't need get_document.

Tools by job (prefer the high level ones, and batch: fewer calls = faster for the user):
- Read animation: get_animation (compact keys/eases per layer). get_layer only for raw details.
- Entrances/exits/loops for one or many layers: apply_preset (Fade in, Slide up, Pop, Zoom in, Spin in, Fade out, Pulse, ...) with stagger for lists.
- Text reveals per letter/word/line: set_text_animation (presets: Fade up, Typewriter, Pop letters, Slide words, Drop lines, Spin letters, Center burst).
- Precise motion: animate (many layers/properties in one call, one undo step) or set_keyframes, with eases ("Expo Out" for entrances, "Back Out" for playful pops, "Easy Ease" for neutral moves, "spring Bouncy"/"spring:0.4" for physical motion). Position keys can curve with sOut/sIn.
- Timing edits: retime (faster/slower/shift), stagger (offset layers one after another), set_easing (change feel without moving keys).
- Procedural motion: set_expression (wiggle(2, 20), time * 90, loopOut('pingpong'), linear(time, 0, 1, 0, 100)).
- Custom shapes: add_layer type "path" with SVG path data in "d".
- Two versions of a design (e.g. two pasted Figma frames, start and end state): smart_animate matches layers by name and animates every difference.
- Timing to music or story beats: markers are in the context; set_markers adds/removes them. Put keys on marker times.
- Organize: group_layers, precompose (animate a group as one unit), open_composition.
- Reuse: create_component turns a layer (logo, button, card + its animation) into a main component; add_instance places linked copies (own position and delay; edits on an instance become overrides).
- Brand colors: list_styles shows the project's named colors/numbers (often synced from Figma); use link_style instead of raw hex so they follow library updates and light/dark mode (set_style_mode).
- Options for the user to choose from: build each version, then save_variation (A, B, C...). The user previews and picks in the sidebar.
- Check your work: contact_sheet (one image, many frames: best for motion), screenshot for a single detailed frame. export_video renders a file only when asked.
Motion craft: entrances ease out, exits ease in; overlap and stagger (60-120ms) instead of moving everything at once;
anticipation = small opposite move before the main move; follow-through/overshoot via Back Out or springs; keep 0.2-0.6s for UI moves.
Keep the user's existing work intact unless asked. The user reviews every turn's changes (with a diff and one-click revert), so act, don't ask for permission.
Keep replies short: say what you changed (layer names) and offer one or two tweaks.`;

/** extra instruction for read-only "Ask" turns (critique / explain): the editor also blocks editing tools */
export const ASK_MODE_PROMPT = 'This turn is READ-ONLY (Ask mode): do not try to change the document; editing tools are disabled. Inspect with get_animation, contact_sheet and screenshot, then answer.';

/** tool names the agent may use in Ask mode */
export const READ_ONLY_TOOLS = () => TOOLS.filter(t => t.readOnly).map(t => t.name);
