import { describe, it, expect, beforeEach } from 'vitest';
import { TOOLS } from '../src/agent/tools';
import { editor } from '../src/app/editor';
import { createProject } from '../src/core/model';
import { valueAt } from '../src/core/commands';

const run = async (name: string, args: any) => {
  const c = await TOOLS.find(t => t.name === name)!.run(args);
  return c[0].type === 'text' ? c[0].text : '';
};
const json = async (name: string, args: any) => JSON.parse(await run(name, args));

beforeEach(() => { editor.store.load(createProject()); });

describe('build_scene', () => {
  const spec = () => ({
    comp: { duration: 4, background: '#101018' },
    markers: [{ t: 1, label: 'hit' }],
    layers: [
      { key: 'bg', type: 'rect', x: 0, y: 0, w: 1920, h: 1080, fill: { type: 'linear', stops: ['#111133', '#331111'], angle: 90 } },
      { key: 'title', text: 'Hello', fontSize: 120, x: 200, y: 300, fill: '#ffffff', enter: { t: 0.2, duration: 0.8, from: { opacity: 0, dy: 60 } } },
      { key: 'cards', staggerChildren: 0.1, children: [
        { key: 'c1', x: 100, y: 600, w: 200, h: 120, radius: 16, fill: '#ff5500', enter: { from: { scale: 0 }, ease: 'spring:0.4' } },
        { key: 'c2', x: 400, y: 600, w: 200, h: 120, radius: 16, fill: '#ff5500', enter: { from: { scale: 0 }, ease: 'spring:0.4' } },
      ] },
      { key: 'check', shape: 'check', x: 900, y: 600, w: 120, h: 120, fill: '#22cc88', drawOn: { t: 0.5, duration: 0.6 } },
      { key: 'spin', type: 'star', points: 5, x: 1200, y: 600, w: 100, h: 100, expr: { rotation: 'time*90' } },
    ],
  });

  it('builds a scene in one undo step and returns an id map', async () => {
    const s = editor.store;
    const h = s.historyLength;
    const r = await json('build_scene', spec());
    expect(s.historyLength).toBe(h + 1);
    expect(Object.keys(r.ids)).toEqual(expect.arrayContaining(['bg', 'title', 'cards', 'c1', 'c2', 'check', 'spin']));
    expect(r.summary).toMatch(/7 created/);
    const title = s.layer(r.ids.title)!;
    expect(title.type).toBe('text');
    expect(title.props.opacity!.kf!.map(k => +k.t.toFixed(6))).toEqual([0.2, 0.6]);
    expect(valueAt(title, 'position', 0.2)[1] - valueAt(title, 'position', 2)[1]).toBeCloseTo(60);
    expect(s.layer(r.ids.c2)!.props.scale!.kf![0].t).toBeCloseTo(0.1); // staggered child
    expect(s.layer(r.ids.c1)!.parent).toBe(r.ids.cards);
    expect(s.layer(r.ids.bg)!.paints![0].type).toBe('linear');
    const chk = s.layer(r.ids.check)!;
    expect(chk.trimOn).toBe(true);
    expect(chk.props.trimEnd!.kf!.map(k => k.v[0])).toEqual([0, 100]);
    expect(chk.props.stroke!.v.slice(0, 3)).toEqual([0x22 / 255, 0xcc / 255, 0x88 / 255]);
    expect(s.layer(r.ids.spin)!.props.rotation!.expr).toBe('time*90');
    expect(s.comp.duration).toBe(4);
    expect(s.comp.markers!.map(m => m.label)).toEqual(['hit']);
    s.undo();
    expect(Object.keys(s.project.layers)).toHaveLength(0);
  });

  it('is idempotent: same keys update in place, prune removes the rest', async () => {
    const s = editor.store;
    const r1 = await json('build_scene', spec());
    const n = Object.keys(s.project.layers).length;
    const sp = spec();
    (sp.layers[1] as any).fill = '#ff0000';
    (sp.layers[1] as any).text = 'Bye';
    const r2 = await json('build_scene', sp);
    expect(Object.keys(s.project.layers)).toHaveLength(n);
    expect(r2.ids).toEqual(r1.ids);
    expect(r2.summary).toMatch(/0 created, 7 updated/);
    const t = s.layer(r1.ids.title)!;
    expect(t.text!.content).toBe('Bye');
    expect(t.props.fill!.v).toEqual([1, 0, 0, 1]);
    expect(t.props.opacity!.kf).toHaveLength(2);
    // partial update: only fill; animation stays
    await run('build_scene', { layers: [{ key: 'title', fill: '#00ff00' }] });
    expect(t.props.opacity!.kf).toHaveLength(2);
    expect(t.props.fill!.v).toEqual([0, 1, 0, 1]);
    // prune
    await run('build_scene', { layers: [{ key: 'bg' }, { key: 'title' }], prune: true });
    expect(Object.values(s.project.layers).map(l => l.sceneKey).sort()).toEqual(['bg', 'title']);
  });

  it('reorders keyed layers to the spec order and supports precomps and lucide icons', async () => {
    const s = editor.store;
    const r = await json('build_scene', { layers: [
      { key: 'a', x: 0, y: 0 }, { key: 'b', x: 0, y: 0 },
      { key: 'pc', type: 'precomp', comp: { duration: 2 }, children: [{ key: 'inner', type: 'ellipse', x: 10, y: 10, w: 50, h: 50 }] },
      { key: 'icon', shape: 'lucide:rocket', x: 0, y: 0, w: 96, h: 96, stroke: '#fff' },
    ] });
    const pc = s.layer(r.ids.pc)!;
    expect(pc.type).toBe('precomp');
    expect(s.project.comps[pc.compRef!].root).toEqual([r.ids.inner]);
    expect(s.project.comps[pc.compRef!].duration).toBe(2);
    const icon = s.layer(r.ids.icon)!;
    expect(icon.geometry![0].cmds.length).toBeGreaterThan(5);
    expect(icon.props.strokeWidth!.v[0]).toBeCloseTo(8);
    await run('build_scene', { layers: [{ key: 'b' }, { key: 'a' }] });
    expect(s.comp.root.indexOf(r.ids.b)).toBeLessThan(s.comp.root.indexOf(r.ids.a));
  });

  it('fits a path box around absolute d and gives helpful errors', async () => {
    const s = editor.store;
    const r = await json('build_scene', { layers: [{ key: 'p', d: 'M100 200 L300 200 L200 400 Z' }] });
    const p = s.layer(r.ids.p)!;
    expect(p.props.size!.v).toEqual([200, 200]);
    expect(valueAt(p, 'position', 0)).toEqual([200, 300]);
    await expect(run('build_scene', { layers: [{ type: 'rect' }] })).rejects.toThrow(/needs a "key"/);
    await expect(run('build_scene', { layers: [{ key: 'x', shape: 'nope' }] })).rejects.toThrow(/unknown shape/);
    await expect(run('build_scene', { layers: [{ key: 'x', shape: 'lucide:definitely-not-an-icon' }] })).rejects.toThrow(/no Lucide icon/);
    await expect(run('build_scene', { layers: [{ key: 'x', expr: { rotation: 'foo(' } }] })).rejects.toThrow(/expression/);
    await expect(run('build_scene', { layers: [{ key: 'x', animate: { opacity: [{ t: 0, v: 0, ease: 'Bogus' }] } }] })).rejects.toThrow(/unknown ease/);
    expect(Object.keys(s.project.layers)).toHaveLength(1); // failed calls changed nothing
  });
});
