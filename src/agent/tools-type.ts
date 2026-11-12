// typography tools: stacked type layouts with roles (fit to width), split text into per-letter /
// word / line layers for bespoke animation, and text on a path.

import { createLayer, type Layer } from '../core/model';
import { insertLayer, valueAt } from '../core/commands';
import { applyPreset, ANIM_PRESETS } from '../core/presets';
import type { Tx } from '../core/store';
import { st, text, need, colorSchema, parseColor, type ToolDef } from './tool-kit';
import { buildScene } from './tools-scene';
import { textLines, textUnitsSafe, layerSize, samplePath, inv, worldMatrix } from './motion-math';
import { parseD } from './shape-lib';
import { transformCmds } from '../import/svg';

const ROLES: Record<string, { size: number; weight: number; lh: number; tracking: number; upper?: boolean }> = {
  eyebrow: { size: 0.2, weight: 600, lh: 1.2, tracking: 0.14, upper: true },
  headline: { size: 1, weight: 800, lh: 1.04, tracking: -0.02 },
  subline: { size: 0.42, weight: 500, lh: 1.25, tracking: 0 },
  body: { size: 0.28, weight: 400, lh: 1.45, tracking: 0 },
  caption: { size: 0.2, weight: 500, lh: 1.3, tracking: 0.02 },
};

/** measure a text block (fontSize, wrap width) with a throwaway layer */
function measure(content: string, font: string, size: number, weight: number, lh: number, spacing: number, boxW: number | null) {
  const l = createLayer('text', { text: { content, fontFamily: font, fontSize: size, fontWeight: weight, lineHeight: lh, letterSpacing: spacing, align: 'left' } as any });
  const lines = textLines(l, boxW);
  return { lines: lines.length, width: Math.max(...lines.map(x => x.width)), height: lines.length * size * lh };
}

/** move a layer out of its container (parent children or comp root) */
export function detach(tx: Tx, l: Layer) {
  const s = st();
  if (l.parent) { const p = s.layer(l.parent)!; tx.set(p, 'children', p.children.filter(c => c !== l.id)); }
  else for (const c of Object.values(s.project.comps)) if (c.root.includes(l.id)) tx.set(c, 'root', c.root.filter(x => x !== l.id));
}

/** split text layer `l` into one text layer per unit inside a new group (same place on screen) */
export function splitTx(tx: Tx, l: Layer, by: 'char' | 'word' | 'line', keep: boolean, units?: { text: string; x: number; y: number; w: number; h: number }[]) {
  const s = st();
  const [w, h] = layerSize(s, l, s.time);
  const sz = l.props.size?.v ?? [0, 0];
  const us = units ?? textUnitsSafe(l, sz[0] > 0 ? w : 0, by);
  if (!us.length) throw new Error(`"${l.name}" has no visible ${by}s to split`);
  const g = createLayer('group', { x: 0, y: 0, w, h, name: l.name });
  // the group takes the text layer's transform (incl. its keyframes): the pieces stay where they were
  for (const k of ['anchor', 'position', 'scale', 'rotation', 'opacity'] as const) if (l.props[k]) g.props[k] = structuredClone(l.props[k]!);
  g.inPoint = l.inPoint; g.outPoint = l.outPoint;
  const siblings = l.parent ? s.layer(l.parent)!.children : s.comp.root;
  insertLayer(s, tx, g, l.parent, siblings.indexOf(l.id) + 1);
  const ids: string[] = [];
  for (const u of us) {
    const c = createLayer('text', { w: 0, h: 0, name: u.text.trim() || by, text: { ...l.text!, content: u.text, align: 'left' } as any, color: valueAt(l, 'fill', s.time) });
    c.props.anchor!.v = [u.w / 2, u.h / 2];
    c.props.position!.v = [u.x + u.w / 2, u.y + u.h / 2];
    if (l.props.fill?.bind) c.props.fill!.bind = l.props.fill.bind;
    insertLayer(s, tx, c, g.id);
    ids.push(c.id);
  }
  if (keep) { if (l.visible) { tx.set(l, 'visible', false); tx.recompile(); } }
  else { detach(tx, l); tx.del(s.project.layers, l.id); tx.structure(); }
  return { group: g.id, ids };
}

export const TYPE_TOOLS: ToolDef[] = [
  {
    name: 'type_layout',
    description: 'Lay out a typographic block in one call: stacked text blocks by role (eyebrow, headline, subline, body, caption) with a type scale from one base size, tracking (em), line height, alignment and gaps inside a box; fit:true shrinks blocks that would not fit the width on one line. Builds through build_scene with keys "<key>/<i>", so calling again with the same key updates the layout. Returns ids and the measured size of each block.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'stable key of the layout group (default "type")' },
        blocks: { type: 'array', items: { type: 'object', properties: {
          text: { type: 'string' }, role: { enum: Object.keys(ROLES) }, size: { type: 'number', description: 'px, overrides the role scale' }, weight: { type: 'number' },
          tracking: { type: 'number', description: 'letter spacing in em (0.1 = 10%)' }, lineHeight: { type: 'number' }, color: colorSchema, font: { type: 'string' }, uppercase: { type: 'boolean' }, gapBefore: { type: 'number' },
        }, required: ['text'] } },
        x: { type: 'number' }, y: { type: 'number', description: 'top (default: vertically centered in the comp)' }, w: { type: 'number', description: 'box width (default 80% of the comp)' },
        align: { enum: ['left', 'center', 'right'] }, baseSize: { type: 'number', description: 'headline size px (default 9% of comp height)' },
        gap: { type: 'number', description: 'px between blocks (default 0.25 × base)' }, fit: { type: 'boolean', description: 'shrink to fit the width on one line (default true for headline/eyebrow)' },
        font: { type: 'string', description: 'default font family (Inter)' }, color: colorSchema,
      },
      required: ['blocks'],
    },
    run: async a => {
      const s = st(), comp = s.comp;
      if (!Array.isArray(a.blocks) || !a.blocks.length) throw new Error('blocks must be a non-empty array of {text, role}');
      const W = a.w ?? comp.width * 0.8, align = a.align ?? 'left';
      const X = a.x ?? (comp.width - W) / 2;
      const base = a.baseSize ?? Math.round(comp.height * 0.09);
      const gap = a.gap ?? base * 0.25;
      const key = a.key ?? 'type';
      const metrics: any[] = [];
      const specs = a.blocks.map((b: any, i: number) => {
        const role = ROLES[b.role ?? (i === 0 && a.blocks.length > 1 ? 'headline' : 'body')];
        if (!role) throw new Error(`blocks[${i}].role must be one of ${Object.keys(ROLES).join(', ')}`);
        if (typeof b.text !== 'string' || !b.text) throw new Error(`blocks[${i}].text must be a non-empty string`);
        const content = b.uppercase ?? role.upper ? b.text.toUpperCase() : b.text;
        const font = b.font ?? a.font ?? 'Inter', weight = b.weight ?? role.weight, lh = b.lineHeight ?? role.lh;
        let size = b.size ?? Math.round(base * role.size);
        const trackEm = b.tracking ?? role.tracking;
        const oneLine = a.fit ?? (b.role === 'headline' || b.role === 'eyebrow' || (!b.role && i === 0));
        let fitted = false;
        if (oneLine) {
          const m = measure(content, font, size, weight, lh, trackEm * size, null);
          if (m.width > W) { size = Math.max(8, Math.floor(size * W / m.width)); fitted = true; }
        }
        const m = measure(content, font, size, weight, lh, trackEm * size, oneLine ? null : W);
        metrics.push({ key: `${key}/${i}`, role: b.role ?? (i === 0 && a.blocks.length > 1 ? 'headline' : 'body'), fontSize: size, lines: m.lines, height: Math.round(m.height), ...(fitted ? { shrunkToFit: true } : {}) });
        return { b, content, font, weight, lh, size, track: trackEm * size, height: m.height, wrap: !oneLine };
      });
      const total = specs.reduce((sum: number, x: any, i: number) => sum + x.height + (i ? (x.b.gapBefore ?? gap) : 0), 0);
      let y = a.y ?? (comp.height - total) / 2;
      const children = specs.map((x: any, i: number) => {
        if (i) y += x.b.gapBefore ?? gap;
        const spec = {
          key: `${key}/${i}`, type: 'text', text: x.content, font: x.font, fontSize: x.size, fontWeight: x.weight, lineHeight: x.lh, tracking: x.track, align,
          x: X, y, w: W, h: 0, fill: x.b.color ?? a.color ?? '#ffffff',
        };
        y += x.height;
        return spec;
      });
      const r = await buildScene({ layers: [{ key, type: 'group', name: a.key ?? 'Type', children }] });
      return text({ ids: r.ids, box: [Math.round(X), Math.round((a.y ?? (comp.height - total) / 2)), Math.round(W), Math.round(total)], blocks: metrics, ...(r.notes ? { notes: r.notes } : {}) });
    },
  },
  {
    name: 'split_text',
    description: 'Split a text layer into one text layer per char / word / line, inside a group that takes the original\'s place and transform (pieces stay exactly where the letters were). Use it for bespoke per-letter animation (animate, choreograph, secondary_motion on the pieces). preset (optional) applies an entrance preset to the pieces with stagger. The original is deleted unless keep:true (then hidden).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, by: { enum: ['char', 'word', 'line'] }, keep: { type: 'boolean' },
        preset: { type: 'string', description: `entrance for the pieces: ${ANIM_PRESETS.filter(p => p.kind === 'in').map(p => p.name).join(', ')}` },
        t: { type: 'number' }, duration: { type: 'number' }, stagger: { type: 'number', description: 'default 0.04' },
      },
      required: ['id'],
    },
    run: a => {
      const s = st();
      const l = need(a.id);
      if (l.type !== 'text' || !l.text) throw new Error(`"${l.name}" is a ${l.type} layer; split_text needs a text layer`);
      const by = a.by ?? 'char';
      if (a.preset && !ANIM_PRESETS.some(p => p.name.toLowerCase() === String(a.preset).toLowerCase())) throw new Error(`unknown preset; presets: ${ANIM_PRESETS.map(p => p.name).join(', ')}`);
      const note = l.textAnim ? ' (its text animator was dropped: animate the pieces instead)' : '';
      const r = s.batch('split', () => {
        let res!: { group: string; ids: string[] };
        s.transact('Agent: split text', tx => { res = splitTx(tx, l, by, !!a.keep); });
        if (a.preset) {
          if (a.t !== undefined) s.setTime(a.t);
          applyPreset(s, res.ids, a.preset, { duration: a.duration ?? 0.5, stagger: a.stagger ?? 0.04 });
        }
        return res;
      }, 'Agent: split text');
      return text({ group: r.group, pieces: r.ids.length, ids: r.ids.slice(0, 200), note: `pieces are ${by} text layers in group coordinates${note}` });
    },
  },
  {
    name: 'text_on_path',
    description: 'Set text along a path: each letter becomes its own layer placed and rotated along the curve (SVG d in composition coordinates, or a path layer). From an existing text layer (id; it is replaced) or new text + style. offset = where the text starts along the path (0..1), align start/center/end. Returns the group and letter ids (animate them like split_text pieces).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'existing text layer (top-level)' },
        text: { type: 'string', description: 'or new text' }, fontSize: { type: 'number' }, fontWeight: { type: 'number' }, font: { type: 'string' }, fill: colorSchema, tracking: { type: 'number', description: 'px' },
        d: { type: 'string', description: 'SVG path in composition coordinates' }, path: { type: 'string', description: 'or a path layer id' },
        offset: { type: 'number', description: '0..1 along the path (default 0; with align center: 0.5)' }, align: { enum: ['start', 'center', 'end'] },
        baseline: { type: 'number', description: 'px the letters sit above the path (default 0.3 × font size)' },
      },
    },
    run: a => {
      const s = st(), t = s.time;
      let cmds;
      if (a.d) cmds = parseD(a.d);
      else if (a.path) {
        const pl = need(a.path);
        if (pl.type !== 'path' || !pl.geometry?.length) throw new Error('path must be a path layer id');
        const [w, h] = layerSize(s, pl, t), g = pl.geomSize ?? [w, h];
        cmds = transformCmds(transformCmds(pl.geometry.flatMap(x => x.cmds), [w / (g[0] || 1), 0, 0, h / (g[1] || 1), 0, 0]), worldMatrix(s, pl.id, t) as any);
      } else throw new Error('give d (SVG path in comp coordinates) or path (a path layer id)');
      let src: Layer;
      if (a.id) { src = need(a.id); if (src.type !== 'text') throw new Error('id must be a text layer'); if (src.parent) throw new Error('text_on_path works on top-level text layers'); }
      else {
        if (!a.text) throw new Error('give id (a text layer) or text');
        src = createLayer('text', { w: 0, h: 0, name: a.text, text: { content: a.text, fontFamily: a.font ?? 'Inter', fontSize: a.fontSize ?? 48, fontWeight: a.fontWeight ?? 600, lineHeight: 1.2, letterSpacing: a.tracking ?? 0, align: 'left' } as any, color: a.fill !== undefined ? parseColor(a.fill) : [1, 1, 1, 1] });
      }
      const units = textUnitsSafe(src, 0, 'char');
      const fs = src.text!.fontSize;
      const dense = samplePath(cmds, 600);
      const acc = [0];
      for (let i = 1; i < dense.length; i++) acc.push(acc[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y));
      const L = acc[acc.length - 1];
      const textW = units.length ? units[units.length - 1].x + units[units.length - 1].w : 0;
      if (textW > L * 1.02) throw new Error(`the text is ${Math.round(textW)}px long but the path only ${Math.round(L)}px: use a smaller fontSize or a longer path`);
      const align = a.align ?? 'start';
      const off = (a.offset ?? (align === 'center' ? 0.5 : align === 'end' ? 1 : 0)) * L - (align === 'center' ? textW / 2 : align === 'end' ? textW : 0);
      const at = (d: number) => { let j = 1; while (j < acc.length - 1 && acc[j] < d) j++; const p = dense[j - 1], q = dense[j], f = Math.min(1, Math.max(0, (d - acc[j - 1]) / ((acc[j] - acc[j - 1]) || 1))); return { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f, angle: Math.atan2(q.y - p.y, q.x - p.x) }; };
      const lift = a.baseline ?? fs * 0.3;
      let res!: { group: string; ids: string[] };
      s.transact('Agent: text on path', tx => {
        if (!a.id) insertLayer(s, tx, src, null);
        const W = s.comp.width, H = s.comp.height;
        res = splitTx(tx, src, 'char', false, units);
        const g = s.layer(res.group)!;
        // the group spans the comp at rest so letter positions are comp coordinates
        tx.set(g.props, 'anchor', { v: [W / 2, H / 2] }); tx.set(g.props, 'position', { v: [W / 2, H / 2] }); tx.set(g.props, 'size', { v: [W, H] });
        for (const k of ['scale', 'rotation'] as const) tx.set(g.props, k, { v: k === 'scale' ? [100, 100] : [0] });
        const toG = inv([1, 0, 0, 1, 0, 0]);
        res.ids.forEach((id, i) => {
          const u = units[i], c = s.layer(id)!;
          const p = at(Math.min(L, Math.max(0, off + u.x + u.w / 2)));
          const nx = Math.sin(p.angle), ny = -Math.cos(p.angle);
          tx.set(c.props, 'position', { v: [p.x + nx * lift + toG[4], p.y + ny * lift + toG[5]] });
          tx.set(c.props, 'rotation', { v: [p.angle * 180 / Math.PI] });
        });
      });
      return text({ group: res.group, letters: res.ids.length, ids: res.ids.slice(0, 200), pathLength: Math.round(L), textLength: Math.round(textW) });
    },
  },
];
