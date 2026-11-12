import { describe, it, expect, beforeEach } from 'vitest';
import { TOOLS } from '../src/agent/tools';
import { editor } from '../src/app/editor';
import { createProject } from '../src/core/model';
import { addLayer, valueAt } from '../src/core/commands';
import { matchShapes, primitive, PRIMITIVE_NAMES, booleanCmds, rectCmds } from '../src/agent/shape-lib';
import { parsePathD } from '../src/import/svg';

const run = async (name: string, args: any) => {
  const c = await TOOLS.find(t => t.name === name)!.run(args);
  return c[0].type === 'text' ? c[0].text : '';
};
const json = async (name: string, args: any) => JSON.parse(await run(name, args));

beforeEach(() => { editor.store.load(createProject()); });

describe('shape library', () => {
  it('every primitive builds finite commands in its box', () => {
    for (const n of PRIMITIVE_NAMES) {
      const s = primitive(n, 200, 100, { seed: 3 });
      expect(s.cmds.length, n).toBeGreaterThan(1);
      for (const c of s.cmds) for (const v of c.slice(1)) expect(Number.isFinite(v as number), n).toBe(true);
    }
  });

  it('matchShapes makes any two shapes structurally identical', () => {
    const pairs = [[primitive('heart', 100, 100).cmds, primitive('star', 100, 100).cmds], [primitive('circle', 100, 100).cmds, primitive('ring', 100, 100).cmds], [primitive('check', 100, 100).cmds, primitive('square', 100, 100).cmds]];
    for (const [a, b] of pairs) {
      const [A, B] = matchShapes(a, b);
      expect(A.length).toBe(B.length);
      expect(A.map(c => c[0])).toEqual(B.map(c => c[0]));
    }
  });

  it('booleans: subtract a circle from a square leaves a hole (two rings)', () => {
    const r = booleanCmds([rectCmds(0, 0, 100, 100), primitive('circle', 50, 50).cmds.map(c => c[0] === 'Z' ? c : [c[0], ...c.slice(1).map(v => (v as number) + 25)] as any)], 'difference');
    expect(r.filter(c => c[0] === 'M')).toHaveLength(2);
  });
});

describe('shape tools', () => {
  it('add_shape_path: plain d, polyline, and boolean of existing layers (one undo step)', async () => {
    const s = editor.store;
    const p = await json('add_shape_path', { d: 'M100 100 L300 100 L200 300 Z', fill: '#ff0000' });
    const l = s.layer(p.id)!;
    expect(l.geomSize).toEqual([200, 200]);
    expect(valueAt(l, 'position', 0)).toEqual([200, 200]);
    const line = await json('add_shape_path', { points: '0,0 100,50 200,0' });
    expect(s.layer(line.id)!.props.strokeWidth!.v[0]).toBeGreaterThan(0);
    const a = addLayer(s, 'rect', { x: 0, y: 0, w: 100, h: 100 });
    const b = addLayer(s, 'ellipse', { x: 50, y: 50, w: 100, h: 100 });
    const h = s.historyLength;
    const u = await json('add_shape_path', { op: 'union', operands: [{ layer: a.id }, { layer: b.id }], name: 'Blob' });
    expect(s.historyLength).toBe(h + 1);
    expect(u.deleted).toEqual([a.id, b.id]);
    expect(s.layer(a.id)).toBeUndefined();
    expect(s.layer(u.id)!.geomSize!.map(Math.round)).toEqual([150, 150]);
    await expect(run('add_shape_path', { op: 'intersect', operands: [{ d: 'M0 0 L10 0 L10 10 Z' }, { d: 'M100 100 L110 100 L110 110 Z' }] })).rejects.toThrow(/empty/);
    await expect(run('add_shape_path', { op: 'union', operands: [{ d: 'M0 0 L1 1' }] })).rejects.toThrow(/at least 2/);
  });

  it('shape_library: lists, builds primitives and lucide icons, rejects unknown names', async () => {
    expect(await run('shape_library', {})).toMatch(/heart/);
    const h = await json('shape_library', { shape: 'heart', center: [960, 540], w: 200, h: 180, fill: '#ff3366' });
    expect(h.style).toBe('fill');
    const i = await json('shape_library', { shape: 'lucide:sparkles', x: 0, y: 0, w: 48, h: 48, fill: '#ffffff' });
    expect(i.style).toBe('stroke');
    const L = editor.store.layer(i.id)!;
    expect(L.props.stroke!.v).toEqual([1, 1, 1, 1]);
    expect(L.props.fill!.v[3]).toBe(0);
    await expect(run('shape_library', { shape: 'lucide:rockt' })).rejects.toThrow(/similar|no Lucide/);
    await expect(run('shape_library', { shape: 'hexagon-ish' })).rejects.toThrow(/unknown shape/);
  });

  it('draw_on: converts rects, adds strokes, staggers groups, fades fills', async () => {
    const s = editor.store;
    const r = addLayer(s, 'rect', { x: 0, y: 0, w: 100, h: 100, color: [1, 0, 0, 1] });
    const out = await run('draw_on', { ids: [r.id], t: 0.5, duration: 1 });
    expect(out).toMatch(/→ path/);
    const l = s.layer(r.id)!;
    expect(l.type).toBe('path');
    expect(l.trimOn).toBe(true);
    expect(valueAt(l, 'trimEnd', 0.5)[0]).toBe(0);
    expect(valueAt(l, 'trimEnd', 1.5)[0]).toBe(100);
    expect(valueAt(l, 'fill', 0.5)[3]).toBe(0);
    expect(valueAt(l, 'fill', 1.5)[3]).toBe(1);
    expect(l.props.strokeWidth!.v[0]).toBe(4);
    await expect(run('draw_on', { ids: [] })).rejects.toThrow(/ids/);
  });

  it('morph: rect to star with matched structure, and back', async () => {
    const s = editor.store;
    const r = addLayer(s, 'rect', { x: 0, y: 0, w: 100, h: 100 });
    const out = await run('morph', { id: r.id, to: { shape: 'star' }, t: 0, duration: 0.5, back: 0.2 });
    expect(out).toMatch(/and back/);
    const l = s.layer(r.id)!;
    expect(l.pathKf!.map(k => k.t)).toEqual([0, 0.5, 0.7, 1.2]);
    const [a, b] = [l.pathKf![0].geometry[0].cmds, l.pathKf![1].geometry[0].cmds];
    expect(a.map(c => c[0])).toEqual(b.map(c => c[0]));
    const o = addLayer(s, 'ellipse', { x: 300, y: 0, w: 50, h: 50 });
    await run('morph', { id: r.id, to: { layer: o.id }, t: 2 });
    expect(s.layer(o.id)!.visible).toBe(false);
    await expect(run('morph', { id: r.id, to: { shape: 'heart' }, ease: 'spring:0.4' })).rejects.toThrow(/spring/);
    const d = parsePathD('M0 0 L10 0');
    expect(d.length).toBe(2);
  });
});
