// agent tools for motion components (core/motion-components.ts, guide: get_guide "components"):
// make an animated piece reusable, expose its knobs, add variants (formats, themes), place
// instances with their own values and timing, and lay instances out in sequence (a showreel).

import {
  addFormatVariants, addMotionInstance, addVariant, componentComps, describeComponent, describeInstance, editVariant,
  exposeProperty, findComponent, findVariant, instanceComp, instanceSpan, effectivePlay, makeComponent, passLength, setInstanceProps,
  setInstanceVariant, setPlay, setRanges,
} from '../core/motion-components';
import { newComposition } from '../core/commands';
import type { ExposedValue, Layer, PlaySpec } from '../core/model';
import { idsSchema, need, parseColor, st, text, type ToolDef } from './tool-kit';

const playSchema = {
  type: 'object',
  description: 'timing of the instance: range (a named part such as "in", "hold", "out"), from/to (seconds or part names), speed (2 = twice as fast) or duration (stretch the played part to this many seconds), loop ("loop" | "pingpong", loops = how many), reverse, hold ("first" | "last" | "both": show the first frame before the start / the last frame after the end)',
  properties: {
    range: { type: 'string' }, from: { anyOf: [{ type: 'number' }, { type: 'string' }] }, to: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    speed: { type: 'number' }, duration: { type: 'number' }, loop: { enum: ['none', 'loop', 'pingpong'] }, loops: { type: 'number' },
    reverse: { type: 'boolean' }, hold: { enum: ['none', 'first', 'last', 'both'] },
  },
};
const valuesSchema = { type: 'object', description: 'property name -> value: text (string), color ("#rrggbb" or [r,g,b,a]), number, toggle (boolean), image (asset id). null = back to the component\'s value', additionalProperties: true };
const variantsSchema = { type: 'object', description: 'variant group -> variant name, e.g. {"Format": "9:16", "Theme": "Dark"}', additionalProperties: { type: 'string' } };

/** colors may come as hex: convert by the property's kind */
function values(compRef: string, v: Record<string, unknown> | undefined): Record<string, ExposedValue | null> | undefined {
  if (!v) return undefined;
  const comp = findComponent(st().project, compRef);
  const out: Record<string, ExposedValue | null> = {};
  for (const [k, x] of Object.entries(v)) {
    const p = (comp?.component?.props ?? []).find(q => q.id === k || q.name.toLowerCase() === k.toLowerCase());
    out[k] = x === null ? null : p?.kind === 'color' ? parseColor(x) : (x as ExposedValue);
  }
  return out;
}

/** variant names -> ids for a component (group: name) */
function variantIds(compRef: string, v: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!v) return undefined;
  const comp = findComponent(st().project, compRef)!;
  const out: Record<string, string> = {};
  for (const [g, name] of Object.entries(v)) {
    const hit = (comp.component?.variants ?? []).find(x => x.group.toLowerCase() === g.toLowerCase() && x.name.toLowerCase() === String(name).toLowerCase()) ?? findVariant(comp.component, name);
    if (!hit) throw new Error(`${comp.name} has no ${g} variant "${name}". variants: ${(comp.component?.variants ?? []).map(x => `${x.group}=${x.name}`).join(', ') || 'none (add_variant first)'}`);
    out[hit.group] = hit.id;
  }
  return out;
}

const needComp = (ref: string) => {
  const c = findComponent(st().project, ref);
  if (!c) throw new Error(`no component "${ref}". components: ${componentComps(st().project).map(x => x.name).join(', ') || 'none (make_component first)'}`);
  return c;
};

function instanceInfo(l: Layer) { return { id: l.id, name: l.name, ...describeInstance(st().project, l) }; }

export const COMPONENT_TOOLS: ToolDef[] = [
  {
    name: 'list_components',
    readOnly: true,
    description: 'The animated components of the project: size, duration, named parts (in / hold / out), exposed properties with their defaults, variants (formats, themes...) and instance counts.',
    inputSchema: { type: 'object', properties: {} },
    run: () => text(componentComps(st().project).map(c => describeComponent(st().project, c))),
  },
  {
    name: 'make_component',
    description: 'Turn top-level layers of the active composition (a logo sting, lower third, title card, end card, transition) into a reusable ANIMATED component: they move into their own composition with their animation, and one instance takes their place. Named parts in / hold / out are found when the animation rests in the middle. Then expose_property for what changes per use (text, colors, logo).',
    inputSchema: { type: 'object', properties: { ids: { ...idsSchema, description: 'top-level layers (default: the selection)' }, name: { type: 'string' } }, required: ['name'] },
    run: ({ ids, name }) => {
      const s = st();
      const list: string[] = ids?.length ? ids : s.selection;
      list.forEach(need);
      const { comp, layer } = makeComponent(s, list, { name });
      return text({ component: describeComponent(s.project, comp), instance: layer.id, note: 'the layers now live in the component composition; edit them there (open_composition) and every instance follows' });
    },
  },
  {
    name: 'expose_property',
    description: 'Give a component a property instances can set: a layer\'s text ("text"), color ("fill" | "stroke"), image ("image"), visibility ("visible": a toggle), a number ("opacity", "rotation", "scale": on an animated property it scales the swing, an intensity) or "delay" (seconds that layer\'s animation starts later). One property can drive several layers (targets). Layers must be inside the component.',
    inputSchema: {
      type: 'object',
      properties: {
        component: { type: 'string' }, name: { type: 'string', description: 'e.g. "Title", "Accent", "Logo"' },
        layer: { type: 'string', description: 'layer id inside the component' }, field: { type: 'string' },
        targets: { type: 'array', items: { type: 'object', properties: { layer: { type: 'string' }, field: { type: 'string' } }, required: ['layer', 'field'] }, description: 'instead of layer/field: several layers driven by one property' },
        min: { type: 'number' }, max: { type: 'number' },
      },
      required: ['component', 'name'],
    },
    run: ({ component, name, layer, field, targets, min, max }) => {
      const t = targets?.length ? targets : layer && field ? [{ layer, field }] : null;
      if (!t) throw new Error('pass layer + field, or targets');
      const p = exposeProperty(st(), needComp(component).id, { name, targets: t, min, max });
      return text({ property: p.name, kind: p.kind, targets: p.targets.length });
    },
  },
  {
    name: 'set_component_parts',
    description: 'Name parts of a component\'s timeline so instances can play just one (e.g. in 0-0.6, hold 0.6-2.4, out 2.4-3). Replaces the list.',
    inputSchema: { type: 'object', properties: { component: { type: 'string' }, parts: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, from: { type: 'number' }, to: { type: 'number' } }, required: ['name', 'from', 'to'] } } }, required: ['component', 'parts'] },
    run: ({ component, parts }) => { const c = needComp(component); setRanges(st(), c.id, parts); return text({ parts: c.component?.ranges ?? [] }); },
  },
  {
    name: 'add_variant',
    description: 'Add variants to a component: the same layers and animation with differences. Formats: name "9:16", "1:1", "4:5" or "16:9" (or width/height) get a responsive layout (backgrounds stretch, content fits), or formats: ["9:16", "1:1", "4:5"] adds several at once. Other groups (group "Theme" name "Dark", group "Language" name "DE", group "Cut" name "Short" with play {speed: 1.5}) start equal to the base: change them with edit_variant.',
    inputSchema: { type: 'object', properties: { component: { type: 'string' }, name: { type: 'string' }, group: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, play: playSchema, formats: { type: 'array', items: { type: 'string' } } }, required: ['component'] },
    run: ({ component, name, group, width, height, play, formats }) => {
      const c = needComp(component);
      const made = formats?.length ? addFormatVariants(st(), c.id, formats) : name ? [addVariant(st(), c.id, { name, group, width, height, play })] : [];
      if (!made.length) throw new Error('pass name, or formats');
      return text({ variants: made.map(v => ({ group: v.group, name: v.name, ...(v.width ? { size: [v.width, v.height] } : {}), changedLayers: Object.keys(v.ov).length })) });
    },
  },
  {
    name: 'edit_variant',
    description: 'Show a variant in the component\'s composition so you can adjust it: while shown, position / size / scale / rotation / color / opacity / text edits (update_layer etc.) belong to that variant; keyframe timing and new layers apply to every variant. variant null: back to the base (records the variant). Open the component first (open_composition) to look at it.',
    inputSchema: { type: 'object', properties: { component: { type: 'string' }, variant: { description: 'variant name ("9:16", "Dark") or null for the base', anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['component'] },
    run: ({ component, variant }) => {
      const c = needComp(component);
      const v = variant ? findVariant(c.component, variant) : null;
      if (variant && !v) throw new Error(`no variant "${variant}"`);
      editVariant(st(), c.id, v?.id ?? null);
      return text(v ? `showing ${v.group} ${v.name} (${c.width}×${c.height}); edit layouts / colors / texts now, then edit_variant with variant null` : 'back to the base; the variant\'s differences are saved');
    },
  },
  {
    name: 'add_component_instance',
    description: 'Place an instance of a component in the active composition: its property values, variants (one per group), start time and timing (play: a part, speed or a length, loop, reverse, hold). x/y = center (default: the composition center).',
    inputSchema: { type: 'object', properties: { component: { type: 'string' }, name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, start: { type: 'number' }, values: valuesSchema, variants: variantsSchema, play: playSchema, parent: { type: 'string' } }, required: ['component'] },
    run: ({ component, name, x, y, start, values: v, variants, play, parent }) => {
      const c = needComp(component);
      const vals = values(c.id, v);
      const l = addMotionInstance(st(), c.id, { name, x, y, start, play, props: vals as any, variants: variantIds(c.id, variants), parent: parent ?? null });
      return text(instanceInfo(l));
    },
  },
  {
    name: 'set_instance',
    description: 'Change component instances: values (property name -> value, null resets), variants (group -> name, null clears), play (timing; a field null removes it), start (seconds).',
    inputSchema: { type: 'object', properties: { ids: idsSchema, values: valuesSchema, variants: { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, play: playSchema, start: { type: 'number' } }, required: ['ids'] },
    run: ({ ids, values: v, variants, play, start }) => {
      const s = st();
      const list: Layer[] = ids.map(need);
      const comps = list.map(l => { const c = instanceComp(s.project, l); if (!c) throw new Error(`"${l.name}" is not a component instance`); return c; });
      s.batch('set-instance', () => {
        list.forEach((l, i) => {
          if (v) setInstanceProps(s, [l.id], values(comps[i].id, v)!);
          for (const [g, name] of Object.entries(variants ?? {})) setInstanceVariant(s, [l.id], g, name ? Object.values(variantIds(comps[i].id, { [g]: name as string })!)[0] : null);
        });
        if (play) setPlay(s, ids, play);
        if (start !== undefined) s.transact('Instance start', tx => { for (const l of list) { tx.set(l, 'startTime', start); tx.touch(l.id); } tx.recompile(); });
      }, 'Agent: set instance');
      return text(list.map(l => instanceInfo(s.project.layers[l.id])));
    },
  },
  {
    name: 'build_sequence',
    description: 'A showreel / sequence from one component: one instance per item, back to back (overlap seconds: negative gap), each with its own values, variants and timing. into: a new composition name (made at the size of the first item\'s format) or omitted for the active one. Each item plays the whole component unless play says otherwise; duration stretches it.',
    inputSchema: {
      type: 'object',
      properties: {
        component: { type: 'string' }, into: { type: 'string' }, start: { type: 'number' }, overlap: { type: 'number', description: 'seconds each item overlaps the previous (transitions); default 0' },
        variants: { ...variantsSchema, description: 'variants for every item (items can override)' },
        items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, values: valuesSchema, variants: variantsSchema, play: playSchema, duration: { type: 'number' } } } },
      },
      required: ['component', 'items'],
    },
    run: ({ component, into, start = 0, overlap = 0, variants, items }) => {
      const s = st();
      const c = needComp(component);
      if (!items?.length) throw new Error('items is empty');
      return s.batch('sequence', () => {
        if (into) {
          const vs = variantIds(c.id, { ...(variants ?? {}), ...(items[0].variants ?? {}) }) ?? {};
          const sizeV = (c.component?.variants ?? []).find(v => Object.values(vs).includes(v.id) && v.width);
          const nc = newComposition(s, { name: into, width: sizeV?.width ?? s.comp.width, height: sizeV?.height ?? s.comp.height, fps: s.comp.fps });
          s.openComp(nc.id);
        }
        let t = start;
        const placed: Layer[] = [];
        for (const [i, it] of items.entries()) {
          const play: PlaySpec | undefined = it.play || it.duration ? { ...(it.play ?? {}), ...(it.duration ? { duration: it.duration } : {}) } : undefined;
          const vids = variantIds(c.id, { ...(variants ?? {}), ...(it.variants ?? {}) });
          const l = addMotionInstance(s, c.id, { name: it.name ?? `${c.name} ${i + 1}`, start: t, play, props: values(c.id, it.values) as any, variants: vids, select: false });
          placed.push(l);
          const span = instanceSpan(c, effectivePlay(s.project, l));
          t += (Number.isFinite(span) ? span : passLength(c, effectivePlay(s.project, l))) - overlap;
        }
        const end = t + overlap;
        if (end > s.comp.duration + 1e-6) s.transact('Sequence length', tx => { tx.set(s.comp, 'duration', Math.round(end * s.comp.fps) / s.comp.fps); tx.comp(); });
        s.select(placed.map(l => l.id));
        return text({ composition: s.comp.name, duration: s.comp.duration, instances: placed.map(l => ({ id: l.id, name: l.name, start: l.startTime })) });
      }, 'Agent: build sequence');
    },
  },
];
