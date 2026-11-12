// shape & illustration tools: SVG paths with boolean ops, a named shape library (incl. Lucide icons),
// trim-path draw-on and path morphs. each call is one undo step.

import { createLayer, type Layer, type PathCmd, type PropKey } from '../core/model';
import { insertLayer, valueAt } from '../core/commands';
import type { Tx } from '../core/store';
import { st, text, need, parseColor, colorSchema, easeSchema, idsSchema, resolveEase, buildKeys, type ToolDef } from './tool-kit';
import { booleanCmds, cmdsBounds, ellipseCmds, matchShapes, parseD, polylineCmds, PRIMITIVE_DOC, rectCmds, resolveShape, transformCmds, fitCmds, type ShapeOut } from './shape-lib';
import { inv, layerSize, mul, worldMatrix } from './motion-math';
import { drawOnTracks, fillSchema, fillSpec } from './tools-scene';
import { fmtTime } from './describe';

/** a layer's outline as commands in its own box space (rect / ellipse / path / star) */
function layerCmds(l: Layer, t: number): PathCmd[] {
  const s = st();
  const [w, h] = layerSize(s, l, t);
  if (l.type === 'rect' || l.type === 'group') return rectCmds(0, 0, w, h, valueAt(l, 'radius', t)[0]);
  if (l.type === 'ellipse') return ellipseCmds(w / 2, h / 2, w / 2, h / 2);
  if (l.type === 'path' && l.geometry?.length) {
    const g = l.geomSize ?? [w, h];
    return transformCmds(l.geometry.flatMap(x => x.cmds), [w / (g[0] || 1), 0, 0, h / (g[1] || 1), 0, 0]);
  }
  throw new Error(`layer "${l.name}" (${l.type}) has no outline (use rect, ellipse or path layers)`);
}

/** outline of layer `l` mapped into the coordinate space of `parent` (null = composition) */
function layerCmdsIn(l: Layer, parent: string | null, t: number): PathCmd[] {
  const s = st();
  const m = mul(inv(worldMatrix(s, parent, t)), worldMatrix(s, l.id, t));
  return transformCmds(layerCmds(l, t), m as any);
}

/** resolve an operand ({d}, {points}, {shape, x, y, w, h}, {layer}) into commands in parent space */
async function operandCmds(o: any, parent: string | null, i: number): Promise<PathCmd[]> {
  if (typeof o === 'string') return parseD(o);
  if (!o || typeof o !== 'object') throw new Error(`operands[${i}] must be {d}, {points}, {shape,x,y,w,h} or {layer}`);
  if (o.d !== undefined) return parseD(o.d);
  if (o.points !== undefined) return polylineCmds(o.points, true);
  if (o.layer !== undefined) return layerCmdsIn(need(o.layer), parent, st().time);
  if (o.shape !== undefined) {
    const w = o.w ?? 100, h = o.h ?? 100;
    const sh = await resolveShape(o.shape, w, h, o.options ?? {});
    return transformCmds(sh.cmds, [1, 0, 0, 1, o.x ?? 0, o.y ?? 0]);
  }
  throw new Error(`operands[${i}] must have d, points, shape or layer`);
}

interface PathLayerOpts { name?: string; parent?: string | null; fill?: any; stroke?: any; strokeWidth?: number; style: 'fill' | 'stroke'; fillRule?: 'nonzero' | 'evenodd'; strokeScale?: number }

/** add a path layer whose box is fitted around commands given in parent coordinates */
function addPathLayer(tx: Tx, cmds: PathCmd[], o: PathLayerOpts): Layer {
  const s = st();
  if (!cmds.length) throw new Error('the resulting shape is empty (e.g. an intersect of shapes that do not overlap)');
  const [bx, by, bw, bh] = cmdsBounds(cmds);
  const w = Math.max(1, bw), h = Math.max(1, bh);
  const l = createLayer('path', { x: bx, y: by, w, h, name: o.name ?? 'Shape' });
  l.geometry = [{ cmds: transformCmds(cmds, [1, 0, 0, 1, -bx, -by]), fillRule: o.fillRule ?? 'nonzero' }];
  l.geomSize = [w, h];
  if (o.style === 'stroke') {
    l.props.fill!.v = [0, 0, 0, 0];
    l.props.stroke!.v = o.stroke !== undefined ? parseColor(o.stroke) : o.fill !== undefined ? fillSpec(o.fill).color : [1, 1, 1, 1];
    l.props.strokeWidth!.v = [o.strokeWidth ?? (o.strokeScale ? 2 * o.strokeScale : Math.max(2, Math.min(w, h) * 0.06))];
  } else {
    if (o.fill !== undefined) { const f = fillSpec(o.fill); l.props.fill!.v = f.color; if (f.paints) l.paints = f.paints; }
    if (o.stroke !== undefined) l.props.stroke!.v = parseColor(o.stroke);
    if (o.strokeWidth !== undefined) l.props.strokeWidth!.v = [o.strokeWidth];
  }
  insertLayer(s, tx, l, o.parent ?? null);
  return l;
}

/** convert a rect / ellipse layer into an equivalent path (keeps its transform and animation) */
function toPathTx(tx: Tx, l: Layer): boolean {
  if (l.type === 'path') return false;
  if (l.type !== 'rect' && l.type !== 'ellipse') throw new Error(`layer "${l.name}" is a ${l.type}: only path, rect and ellipse layers can be drawn on or morphed`);
  const [w, h] = layerSize(st(), l, st().time);
  tx.set(l, 'geometry', [{ cmds: layerCmds(l, st().time), fillRule: 'nonzero' }]);
  tx.set(l, 'geomSize', [w, h]);
  tx.set(l, 'type', 'path');
  if (l.props.radius) tx.del(l.props, 'radius');
  tx.structure();
  return true;
}

/** path layers under the given ids (groups expand to their descendants, in draw order) */
function pathTargets(ids: string[]): Layer[] {
  const s = st();
  const out: Layer[] = [];
  const walk = (l: Layer) => {
    if (l.type === 'group' && l.children.length) l.children.forEach(c => walk(s.layer(c)!));
    else if (['path', 'rect', 'ellipse'].includes(l.type)) out.push(l);
  };
  ids.map(need).forEach(walk);
  return out;
}

const OPS: Record<string, 'union' | 'difference' | 'intersect' | 'xor'> = { union: 'union', subtract: 'difference', difference: 'difference', intersect: 'intersect', exclude: 'xor', xor: 'xor' };

export const SHAPE_TOOLS: ToolDef[] = [
  {
    name: 'add_shape_path',
    description: 'Add a custom vector shape layer from SVG path data or a polyline, optionally combined with boolean ops (union / subtract / intersect / exclude) of several operands: SVG d strings, polylines, library shapes or EXISTING layers (rect/ellipse/path; deleted unless keep:true, like Figma booleans). Coordinates are in the parent\'s space (composition px for top level); the layer box is fitted around the result.',
    inputSchema: {
      type: 'object',
      properties: {
        d: { type: 'string', description: 'SVG path data in parent coordinates, e.g. "M100 100 C 200 0 300 200 400 100"' },
        points: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'array', items: { type: 'number' } } }], description: 'polyline "x,y x,y ..." (alternative to d)' },
        closed: { type: 'boolean', description: 'close the polyline (default false = open line, stroked)' },
        op: { enum: ['union', 'subtract', 'intersect', 'exclude'], description: 'boolean op applied left to right over operands (subtract = first minus the rest)' },
        operands: { type: 'array', description: 'with op: shapes to combine. each: {d}, {points}, {shape, x, y, w, h, options} or {layer: id}', items: { type: 'object', properties: { d: { type: 'string' }, points: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'array', items: { type: 'number' } } }] }, shape: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, layer: { type: 'string' }, options: { type: 'object' } } } },
        keep: { type: 'boolean', description: 'keep operand layers (default: delete them)' },
        name: { type: 'string' }, parent: { type: 'string' },
        fill: fillSchema, stroke: colorSchema, strokeWidth: { type: 'number' },
        fillRule: { enum: ['nonzero', 'evenodd'] },
      },
    },
    run: async a => {
      const s = st();
      const parent: string | null = a.parent ?? null;
      if (parent && need(parent).type !== 'group') throw new Error('parent must be a group layer');
      let cmds: PathCmd[];
      let style: 'fill' | 'stroke' = 'fill';
      const used: string[] = [];
      if (a.op) {
        const op = OPS[a.op];
        if (!op) throw new Error('op must be union, subtract, intersect or exclude');
        const ops: any[] = [...(a.d !== undefined ? [{ d: a.d }] : []), ...(a.operands ?? [])];
        if (ops.length < 2) throw new Error('a boolean op needs at least 2 operands (d plus operands[], or operands[] alone)');
        const list = [];
        for (const [i, o] of ops.entries()) { list.push(await operandCmds(o, parent, i)); if (o.layer) used.push(o.layer); }
        cmds = booleanCmds(list, op);
      } else if (a.d !== undefined) { cmds = parseD(a.d); style = /z\s*$/i.test(a.d.trim()) || a.fill !== undefined ? 'fill' : 'stroke'; }
      else if (a.points !== undefined) { cmds = polylineCmds(a.points, !!a.closed); style = a.closed ? 'fill' : 'stroke'; }
      else throw new Error('give d, points, or op + operands');
      let id = '';
      s.transact('Agent: shape', tx => {
        const l = addPathLayer(tx, cmds, { name: a.name ?? (a.op ? `${a.op[0].toUpperCase()}${a.op.slice(1)}` : 'Path'), parent, fill: a.fill, stroke: a.stroke, strokeWidth: a.strokeWidth, style, fillRule: a.fillRule });
        id = l.id;
        if (!a.keep) for (const u of used) {
          const ul = s.layer(u)!;
          if (ul.parent) tx.set(s.layer(ul.parent)!, 'children', s.layer(ul.parent)!.children.filter(c => c !== u)); else tx.set(s.comp, 'root', s.comp.root.filter(c => c !== u));
          for (const d of [u, ...s.descendants(u)]) tx.del(s.project.layers, d);
          tx.structure();
        }
      });
      const l = s.layer(id)!;
      return text({ id, size: l.geomSize!.map(Math.round), commands: cmds.length, ...(used.length && !a.keep ? { deleted: used } : {}) });
    },
  },
  {
    name: 'shape_library',
    description: `Add a ready-made vector shape as a path layer (morphable, drawable with draw_on). Shapes: ${PRIMITIVE_DOC}. Also any Lucide icon: "lucide:<kebab-name>" (e.g. lucide:rocket, lucide:sparkles, lucide:shopping-cart) as stroked line art. Call without shape to list. Line-art shapes (check, wave, spiral, icons...) are stroked: "fill" sets their stroke color.`,
    inputSchema: {
      type: 'object',
      properties: {
        shape: { type: 'string' }, name: { type: 'string' }, parent: { type: 'string' },
        x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number', default: 100 }, h: { type: 'number', default: 100 },
        center: { type: 'array', items: { type: 'number' }, description: '[cx, cy] instead of x/y' },
        fill: fillSchema, stroke: colorSchema, strokeWidth: { type: 'number' },
        options: { type: 'object', description: 'seed (blob variant), points (star/badge/burst), inner, turns (spiral), waves + amplitude (wave), thickness (arrow/plus/ring), complexity (blob lobes)', properties: { seed: { type: 'number' }, points: { type: 'number' }, inner: { type: 'number' }, turns: { type: 'number' }, waves: { type: 'number' }, amplitude: { type: 'number' }, thickness: { type: 'number' }, complexity: { type: 'number' } } },
      },
    },
    run: async a => {
      if (!a.shape) return text(`shapes: ${PRIMITIVE_DOC}; and "lucide:<icon-name>" for any Lucide icon`);
      const s = st();
      const w = a.w ?? 100, h = a.h ?? 100;
      const sh: ShapeOut & { strokeScale?: number } = await resolveShape(a.shape, w, h, a.options ?? {});
      const x = a.center ? a.center[0] - w / 2 : a.x ?? (s.comp.width - w) / 2, y = a.center ? a.center[1] - h / 2 : a.y ?? (s.comp.height - h) / 2;
      if (a.parent && need(a.parent).type !== 'group') throw new Error('parent must be a group layer');
      let l!: Layer;
      // keep the requested box even when the shape does not touch every edge (icons have padding)
      s.transact('Agent: shape', tx => {
        l = addPathLayer(tx, transformCmds(sh.cmds, [1, 0, 0, 1, x, y]), { name: a.name ?? String(a.shape).replace(/^(lucide|icon)[:/]/, ''), parent: a.parent ?? null, fill: a.fill, stroke: a.stroke, strokeWidth: a.strokeWidth, style: sh.style, fillRule: sh.fillRule, strokeScale: sh.strokeScale });
      });
      return text({ id: l.id, style: sh.style, box: [Math.round(valueAt(l, 'position', 0)[0] - l.geomSize![0] / 2), Math.round(valueAt(l, 'position', 0)[1] - l.geomSize![1] / 2), Math.round(l.geomSize![0]), Math.round(l.geomSize![1])] });
    },
  },
  {
    name: 'draw_on',
    description: 'Trim-path reveal: strokes draw themselves on (or off) over time. Works on path layers, rect/ellipse (converted to paths) and groups (every path inside, optionally staggered). Layers without a stroke get one in their fill color. fill: "fade" fades the fill in as the line completes (default for filled shapes), "keep" leaves it, "hide" makes it stroke-only.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: idsSchema, t: { type: 'number', description: 'start (default playhead)' }, duration: { type: 'number', default: 0.8 }, ease: easeSchema,
        from: { enum: ['start', 'end', 'center'], description: 'where the line grows from' }, mode: { enum: ['on', 'off'], description: 'off = erase (ends at t+duration)' },
        stagger: { type: 'number', description: 'seconds between paths (groups)' }, fill: { enum: ['fade', 'keep', 'hide'] }, strokeWidth: { type: 'number', description: 'stroke width for layers that have none (default 4)' },
      },
      required: ['ids'],
    },
    run: a => {
      const s = st();
      if (!Array.isArray(a.ids) || !a.ids.length) throw new Error('ids must list path/rect/ellipse/group layers');
      const targets = pathTargets(a.ids);
      if (!targets.length) throw new Error('no path, rect or ellipse layers found in ids');
      const t0 = a.t ?? s.time, dur = a.duration ?? 0.8, ease = a.ease ?? 'Ease In Out';
      resolveEase(ease);
      const notes: string[] = [];
      s.transact('Agent: draw on', tx => {
        targets.forEach((l, i) => {
          const tt = t0 + i * (a.stagger ?? 0);
          if (toPathTx(tx, l)) notes.push(`${l.name} → path`);
          const fill = valueAt(l, 'fill', tt);
          if (!(valueAt(l, 'strokeWidth', tt)[0] > 0) || !(valueAt(l, 'stroke', tt)[3] > 0)) {
            tx.set(l.props, 'stroke', { v: fill[3] > 0 ? fill.slice(0, 3).concat(1) : [1, 1, 1, 1] });
            tx.set(l.props, 'strokeWidth', { v: [a.strokeWidth ?? 4] });
            notes.push(`${l.name}: stroke added`);
          }
          const mode = a.fill ?? (fill[3] > 0.01 ? 'fade' : 'keep');
          for (const [k, frames] of Object.entries(drawOnTracks(tt, dur, ease, a.from ?? 'start', a.mode === 'off'))) {
            const kf = buildKeys(k as PropKey, frames!);
            tx.set(l.props, k as PropKey, { v: kf[kf.length - 1].v.slice(), kf });
          }
          if (mode === 'hide') tx.set(l.props, 'fill', { v: [fill[0], fill[1], fill[2], 0] });
          if (mode === 'fade' && fill[3] > 0.01) {
            const on = a.mode !== 'off';
            const kf = buildKeys('fill', on ? [{ t: tt + dur * 0.6, v: [fill[0], fill[1], fill[2], 0], ease: 'Ease Out' }, { t: tt + dur, v: fill }] : [{ t: tt, v: fill, ease: 'Ease In' }, { t: tt + dur * 0.4, v: [fill[0], fill[1], fill[2], 0] }]);
            tx.set(l.props, 'fill', { v: fill, kf });
          }
          if (!l.trimOn) tx.set(l, 'trimOn', true);
          tx.recompile();
          tx.touch(l.id);
        });
      });
      const end = t0 + (targets.length - 1) * (a.stagger ?? 0) + dur;
      return text(`draw ${a.mode === 'off' ? 'off' : 'on'}: ${targets.length} path(s) ${fmtTime(t0)}–${fmtTime(end)}${notes.length ? '; ' + notes.join(', ') : ''}`);
    },
  },
  {
    name: 'morph',
    description: 'Morph a shape layer into another shape over time (path shape keyframes). The target can be SVG d (in the layer\'s box coordinates), a library shape name or "lucide:<icon>" (fitted to the layer box), or another layer (fit "box": scaled into this layer\'s box; fit "none": where it is on screen; that layer is hidden). Structures are matched automatically (segment counts, winding, start points). back: seconds to hold before morphing back. rect/ellipse layers are converted to paths.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        to: { type: 'object', properties: { d: { type: 'string' }, shape: { type: 'string' }, layer: { type: 'string' }, options: { type: 'object' } }, description: 'one of d / shape / layer' },
        t: { type: 'number', description: 'start (default playhead)' }, duration: { type: 'number', default: 0.6 },
        ease: { description: 'ease preset or cubic-bezier (springs are not supported on shape keys)', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }] },
        fit: { enum: ['box', 'none'] }, back: { type: 'number', description: 'hold seconds, then morph back (same duration)' },
      },
      required: ['id', 'to'],
    },
    run: async a => {
      const s = st();
      const l = need(a.id);
      if (!a.to || typeof a.to !== 'object') throw new Error('to must be {d}, {shape} or {layer}');
      const e = resolveEase(a.ease ?? 'Ease In Out');
      if (e.bounce !== undefined) throw new Error('shape morphs take bezier eases (e.g. "Back Out", "Expo In Out"), not springs');
      if (!['path', 'rect', 'ellipse'].includes(l.type)) throw new Error(`layer "${l.name}" is a ${l.type}: morph needs a path, rect or ellipse`);
      const t0 = a.t ?? s.time, dur = a.duration ?? 0.6;
      const [w, h] = layerSize(s, l, t0);
      const g = l.type === 'path' ? (l.geomSize ?? [w, h]) : [w, h];
      const src: PathCmd[] = l.type === 'path' ? (l.pathKf?.length ? l.pathKf[l.pathKf.length - 1].geometry : l.geometry ?? []).flatMap(x => x.cmds) : layerCmds(l, t0);
      let tgt: PathCmd[];
      let hide: string | null = null;
      if (a.to.d !== undefined) tgt = parseD(a.to.d);
      else if (a.to.shape !== undefined) tgt = (await resolveShape(a.to.shape, g[0], g[1], a.to.options ?? {})).cmds;
      else if (a.to.layer !== undefined) {
        const o = need(a.to.layer);
        if (o.id === l.id) throw new Error('to.layer must be another layer');
        if (a.fit === 'none') {
          const toLocal = inv(worldMatrix(s, l.id, t0));
          tgt = transformCmds(transformCmds(layerCmdsIn(o, null, t0), toLocal as any), [g[0] / (w || 1), 0, 0, g[1] / (h || 1), 0, 0]);
        } else tgt = fitCmds(layerCmds(o, t0), g[0], g[1]);
        hide = o.id;
      } else throw new Error('to needs d, shape or layer');
      if (!tgt.length) throw new Error('the target shape is empty');
      const [A, B] = matchShapes(src, tgt);
      const key = (t: number, cmds: PathCmd[]) => ({ t, geometry: [{ cmds, fillRule: 'nonzero' as const }], interp: e.linear ? 'linear' as const : 'bezier' as const, out: [e.v[0], e.v[1]] as [number, number], in: [e.v[2], e.v[3]] as [number, number] });
      const keys = [key(t0, A), key(t0 + dur, B)];
      if (a.back !== undefined) keys.push(key(t0 + dur + a.back, B), key(t0 + dur * 2 + a.back, A));
      s.transact('Agent: morph', tx => {
        toPathTx(tx, l);
        tx.set(l, 'geometry', [{ cmds: A, fillRule: 'nonzero' }]);
        if (l.type === 'path' && !l.geomSize) tx.set(l, 'geomSize', [g[0], g[1]]);
        tx.set(l, 'pathKf', keys);
        if (hide) { const o = s.layer(hide)!; if (o.visible) tx.set(o, 'visible', false); }
        tx.recompile();
        tx.touch(l.id);
      });
      return text(`morph ${l.name}: ${fmtTime(t0)}→${fmtTime(t0 + dur)}${a.back !== undefined ? ` and back by ${fmtTime(t0 + dur * 2 + a.back)}` : ''}; ${A.length} commands per key${hide ? `; target layer hidden` : ''}`);
    },
  },
];
