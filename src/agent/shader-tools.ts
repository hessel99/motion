// agent tools for figma shaders (custom webgpu fills and effects pasted from figma). every shader
// param is an ordinary animatable property: these tools read the schema, set values, keyframe them
// (with eases) and attach / detach shaders. registered in agent/tools.ts.

import { editor } from '../app/editor';
import { setExpr, valueAt } from '../core/commands';
import { EASE_PRESETS, SPRING_PRESETS } from '../core/easing';
import type { Keyframe, Layer, PropKey } from '../core/model';
import { addShader, removeShader, setShaderEnabled, setShaderParam, setShaderParamKeys, shaderParam } from '../core/shader-commands';
import { componentLabels, isDiscrete, shaderPropKey, shaderRefs, unflattenValue, type ShaderAsset, type ShaderParamDef } from '../core/shaders';
import type { ToolContent, ToolDef } from './tools';

const st = () => editor.store;
const text = (v: unknown): ToolContent[] => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }];

function need(id: string): Layer {
  const l = st().layer(id);
  if (!l) throw new Error(`no layer with id "${id}"`);
  return l;
}

function round(x: unknown): unknown {
  if (typeof x === 'number') return Math.round(x * 1000) / 1000;
  if (Array.isArray(x)) return x.map(round);
  if (x && typeof x === 'object') { const o: Record<string, unknown> = {}; for (const [k, v] of Object.entries(x)) o[k] = round(v); return o; }
  return x;
}

function schemaOf(d: ShaderParamDef) {
  const o: Record<string, unknown> = { key: d.key, label: d.label, type: d.type };
  if (d.control) o.control = d.control;
  if (d.min !== undefined) o.min = d.min;
  if (d.max !== undefined) o.max = d.max;
  if (d.step !== undefined) o.step = d.step;
  if (d.unit) o.unit = d.unit;
  if (d.options) o.options = d.options.map(x => x.label === String(x.value) ? x.value : `${x.value} (${x.label})`);
  if (d.type === 'point' || d.type === 'point-angle-radius' || d.type === 'point-radius' || d.type === 'color-point') o.position = `${d.positionUnit ?? d.unit ?? '%'} of the layer box`;
  if (d.description) o.description = d.description;
  if (isDiscrete(d)) o.discrete = true;
  return o;
}

function libraryList() {
  return Object.entries(st().project.shaders ?? {}).map(([key, a]) => ({ shader: key, name: a.name, kind: a.kind, animated: !!a.features.isAnimated, params: a.params.length }));
}

function describeLayer(l: Layer) {
  const t = st().time, lib = st().project.shaders ?? {};
  return {
    id: l.id, name: l.name,
    shaders: shaderRefs(l).map(({ ref, kind }) => {
      const a: ShaderAsset | undefined = lib[ref.shader];
      if (!a) return { slot: ref.slot, kind, missing: ref.shader };
      return {
        slot: ref.slot, kind, name: a.name, shader: ref.shader, enabled: ref.enabled !== false, animatedShader: !!a.features.isAnimated,
        params: a.params.map(d => {
          const key = shaderPropKey(ref.slot, d.key) as unknown as PropKey;
          const p = l.props[key];
          const v = valueAt(l, key, t);
          const o: Record<string, unknown> = { ...schemaOf(d), value: round(unflattenValue(d, v)) };
          if (d.type !== 'number' && d.type !== 'boolean' && d.type !== 'string') o.components = componentLabels(d, v.length);
          if (p?.kf?.length) o.keyframes = p.kf.map(k => ({ t: k.t, v: round(unflattenValue(d, k.v)) }));
          if (p?.expr) o.expr = p.expr;
          return o;
        }),
      };
    }),
  };
}

/** ease name / bezier / spring -> keyframe handles (same vocabulary as set_keyframes) */
function easeOf(e: unknown): Pick<Keyframe, 'interp' | 'out' | 'in'> & { bounce?: number } {
  if (e === undefined || e === null) return { interp: 'bezier', out: [0.333, 0], in: [0.667, 1] };
  if (Array.isArray(e) && e.length === 4) return { interp: 'bezier', out: [+e[0], +e[1]], in: [+e[2], +e[3]] };
  if (typeof e === 'string') {
    if (/^spring/i.test(e.trim())) {
      const m = e.match(/spring\s*[:\s]\s*([\d.]+)/i);
      const preset = SPRING_PRESETS.find(p => e.toLowerCase().includes(p.name.toLowerCase()));
      return { interp: 'spring', out: [0.333, 0], in: [0.667, 1], bounce: m ? Math.min(0.9, +m[1]) : preset?.bounce ?? 0.3 };
    }
    if (/^hold$/i.test(e)) return { interp: 'hold', out: [0.333, 0], in: [0.667, 1] };
    const p = EASE_PRESETS.find(p => p.name.toLowerCase() === e.toLowerCase().replace(/[-_]/g, ' '));
    if (!p) throw new Error(`unknown ease "${e}". presets: ${EASE_PRESETS.map(p => p.name).join(', ')}`);
    return { interp: p.name === 'Linear' ? 'linear' : 'bezier', out: [p.v[0], p.v[1]], in: [p.v[2], p.v[3]] };
  }
  throw new Error('ease must be a preset name or [x1,y1,x2,y2]');
}

const valueSchema = { description: 'param value: number; option value or label (selects); true/false; color "#rrggbb" or {r,g,b,a} (0..1); point {x,y} (% of the layer); point-angle-radius {x,y,radius,angle}; color-point {x,y,color}; gradient {stops:[{position,color}]}; or the flat number array', anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'boolean' }, { type: 'object' }, { type: 'array', items: { type: 'number' } }] };

export const SHADER_TOOLS: ToolDef[] = [
  {
    name: 'list_shader_params',
    readOnly: true,
    description: 'Figma shaders on layers (custom WebGPU fills and effects pasted from Figma: halftone, bloom, warp, mesh gradient, noise, CRT, ...). For each layer: its shader slots (fill or effect, in order) and every parameter with its schema (type, range, unit, options), current value at the playhead, keyframes and expression. EVERY shader parameter is an animatable property: keyframe it with set_shader_param (keyframes + eases), or drive it with an expression, like position or opacity. Also lists the document\'s shader library (shaders that add_shader can attach). Without ids: the selected layers, or every layer that has shaders.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'layer ids (default: selection, else all layers with shaders)' } } },
    run: (a) => {
      const s = st();
      let ids: string[] = a.ids?.length ? a.ids : s.selection.filter(id => shaderRefs(s.layer(id)!).length);
      if (!ids.length) ids = Object.values(s.project.layers).filter(l => shaderRefs(l).length).map(l => l.id);
      return text({ layers: ids.map(id => describeLayer(need(id))), library: libraryList() });
    },
  },
  {
    name: 'set_shader_param',
    description: 'Set or animate one parameter of a shader on a layer (slot and param from list_shader_params; param accepts the key or the label). Shader params are keyframable like any property: pass `value` to set it at the playhead (adds a key if the param is already animated), or `keyframes` [{t (seconds), v, ease}] to replace its animation (ease = preset name like "Expo Out", "Easy Ease", "Linear", "spring:0.4", "hold", or cubic-bezier [x1,y1,x2,y2]; it shapes the segment leaving that key). Discrete params (selects, toggles) always hold. `expr` sets an expression (wiggle(2, 10), time * 30, loopOut("pingpong")); `enabled` bypasses / enables the whole shader. Values use the authored form (numbers in the param\'s unit, points in % of the layer box, colors 0..1 or hex).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'layer id' },
        slot: { type: 'string', description: 'shader slot (e.g. "f0" fill, "e0" first effect)' },
        param: { type: 'string', description: 'param key or label' },
        value: valueSchema,
        keyframes: { type: 'array', items: { type: 'object', properties: { t: { type: 'number' }, v: valueSchema, ease: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }] } }, required: ['t', 'v'] } },
        expr: { type: 'string', description: 'expression ("" removes it)' },
        enabled: { type: 'boolean' },
      },
      required: ['id', 'slot'],
    },
    run: (a) => {
      const s = st();
      const l = need(a.id);
      if (a.enabled !== undefined) setShaderEnabled(s, l.id, a.slot, !!a.enabled);
      if (!a.param) { if (a.enabled === undefined) throw new Error('pass param (with value / keyframes / expr) or enabled'); return text('ok'); }
      const sp = shaderParam(s, l, a.slot, a.param);
      if (!sp) {
        const r = shaderRefs(l).find(x => x.ref.slot === a.slot);
        const lib = s.project.shaders ?? {};
        throw new Error(r ? `no param "${a.param}" on ${lib[r.ref.shader]?.name}. params: ${lib[r.ref.shader]?.params.map(p => p.key).join(', ')}` : `no shader slot "${a.slot}" on ${l.name}. slots: ${shaderRefs(l).map(x => x.ref.slot).join(', ') || 'none'}`);
      }
      const done: string[] = [];
      if (a.keyframes) {
        setShaderParamKeys(s, l.id, a.slot, sp.def.key, a.keyframes.map((k: { t: number; v: unknown; ease?: unknown }) => ({ t: +k.t, v: k.v, ease: k.ease as string })), e => easeOf(e));
        (globalThis as { timeline?: { expand(id: string, v: boolean): void } }).timeline?.expand(l.id, true);
        done.push(`${a.keyframes.length} keyframes`);
      }
      if (a.value !== undefined) { setShaderParam(s, l.id, a.slot, sp.def.key, a.value); done.push('value'); }
      if (a.expr !== undefined) { setExpr(s, [l.id], sp.key, a.expr || undefined); done.push(a.expr ? 'expression' : 'expression removed'); }
      const v = valueAt(need(l.id), sp.key, s.time);
      return text(`${l.name} ${sp.asset.name} · ${sp.def.label}: ${done.join(', ') || 'unchanged'}; now ${JSON.stringify(round(unflattenValue(sp.def, v)))}`);
    },
  },
  {
    name: 'add_shader',
    description: 'Attach a shader from this document\'s shader library (list_shader_params shows it; shaders arrive with pasted Figma layers) to layers, as their fill (replaces how the shape is filled, clipped to its shape) or as an effect (processes the rendered layer and its children; several effects chain in order). `values` sets initial params ({param: value}); every param can then be keyframed with set_shader_param. Returns the new slot per layer.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        shader: { type: 'string', description: 'library key or shader name (e.g. "Halftone")' },
        as: { enum: ['fill', 'effect'], description: 'default: what the shader is (fill shaders can only be fills)' },
        values: { type: 'object', description: 'initial param values {key or label: value}' },
      },
      required: ['ids', 'shader'],
    },
    run: (a) => {
      const s = st();
      const lib = s.project.shaders ?? {};
      const key = lib[a.shader] ? a.shader : Object.keys(lib).find(k => lib[k].name.toLowerCase() === String(a.shader).toLowerCase());
      if (!key) throw new Error(`no shader "${a.shader}" in this document. library: ${libraryList().map(x => `${x.name} (${x.kind})`).join(', ') || 'empty (paste Figma layers that use shaders)'}`);
      const asset = lib[key];
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a.values ?? {})) {
        const d = asset.params.find(p => p.key === k || p.label.toLowerCase() === k.toLowerCase());
        if (!d) throw new Error(`no param "${k}" on ${asset.name}. params: ${asset.params.map(p => p.key).join(', ')}`);
        values[d.key] = v;
      }
      for (const id of a.ids) need(id);
      const slots = addShader(s, a.ids, key, { kind: a.as, values: {} });
      // initial values through the same conversion as set_shader_param (labels, hex colors, ...)
      s.batch('agent-shader', () => { for (const id of a.ids) for (const [k, v] of Object.entries(values)) setShaderParam(s, id, slots[id], k, v); });
      return text({ shader: asset.name, kind: a.as ?? asset.kind, slots });
    },
  },
  {
    name: 'remove_shader',
    description: 'Remove a shader (fill or effect) from a layer, with its params and their keyframes. To keep it but turn it off, use set_shader_param with enabled=false instead.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, slot: { type: 'string' } }, required: ['id', 'slot'] },
    run: (a) => {
      const l = need(a.id);
      if (!shaderRefs(l).some(r => r.ref.slot === a.slot)) throw new Error(`no shader slot "${a.slot}" on ${l.name}`);
      removeShader(st(), l.id, a.slot);
      return text('ok');
    },
  },
];
