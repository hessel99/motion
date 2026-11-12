import { describe, it, expect, beforeEach } from 'vitest';
import { TOOLS } from '../src/agent/tools';
import { editor } from '../src/app/editor';
import { createProject } from '../src/core/model';
import { addLayer, valueAt } from '../src/core/commands';

const run = async (name: string, args: any) => {
  const c = await TOOLS.find(t => t.name === name)!.run(args);
  return c[0].type === 'text' ? c[0].text : '';
};
const json = async (name: string, args: any) => JSON.parse(await run(name, args));

beforeEach(() => { editor.store.load(createProject()); });

describe('typography tools', () => {
  it('type_layout stacks roles, fits the headline and updates in place', async () => {
    const s = editor.store;
    const r = await json('type_layout', { key: 'hero', blocks: [{ text: 'New season', role: 'eyebrow' }, { text: 'A very very long headline that cannot fit', role: 'headline' }, { text: 'Subline here', role: 'subline' }], w: 800, x: 100, align: 'center' });
    expect(r.blocks).toHaveLength(3);
    expect(r.blocks[1].shrunkToFit).toBe(true);
    const eyebrow = s.layer(r.ids['hero/0'])!;
    expect(eyebrow.text!.content).toBe('NEW SEASON');
    expect(eyebrow.text!.align).toBe('center');
    const y0 = valueAt(eyebrow, 'position', 0)[1], y1 = valueAt(s.layer(r.ids['hero/1'])!, 'position', 0)[1];
    expect(y1).toBeGreaterThan(y0);
    const n = Object.keys(s.project.layers).length;
    await run('type_layout', { key: 'hero', blocks: [{ text: 'Changed', role: 'eyebrow' }, { text: 'Short', role: 'headline' }, { text: 'Subline', role: 'subline' }] });
    expect(Object.keys(s.project.layers)).toHaveLength(n);
    expect(eyebrow.text!.content).toBe('CHANGED');
    await expect(run('type_layout', { blocks: [{ text: 'x', role: 'giant' }] })).rejects.toThrow(/role/);
  });

  it('split_text makes per-letter layers in a group that keeps the transform, with a staggered preset', async () => {
    const s = editor.store;
    const t = addLayer(s, 'text', { x: 100, y: 100, w: 0, h: 0, name: 'Title', text: { content: 'Hi you', fontFamily: 'Inter', fontSize: 50, fontWeight: 600, lineHeight: 1.2, letterSpacing: 0, align: 'left' } as any });
    const h = s.historyLength;
    const r = await json('split_text', { id: t.id, by: 'char', preset: 'Pop', t: 0, stagger: 0.05 });
    expect(s.historyLength).toBe(h + 1);
    expect(r.pieces).toBe(5);
    expect(s.layer(t.id)).toBeUndefined();
    const g = s.layer(r.group)!;
    expect(g.name).toBe('Title');
    expect(g.children).toHaveLength(5);
    expect(s.layer(r.ids[1])!.props.scale!.kf![0].t).toBeCloseTo(0.05);
    s.undo();
    expect(s.layer(t.id)).toBeDefined();
    await expect(run('split_text', { id: addLayer(s, 'rect', {}).id })).rejects.toThrow(/text layer/);
  });

  it('text_on_path places rotated letters along the curve', async () => {
    const s = editor.store;
    const r = await json('text_on_path', { text: 'ARC', fontSize: 40, d: 'M100 500 A 400 400 0 0 1 900 500', align: 'center' });
    expect(r.letters).toBe(3);
    const rots = r.ids.map((id: string) => valueAt(s.layer(id)!, 'rotation', 0)[0]);
    expect(rots[0]).toBeLessThan(rots[2]); // the tangent turns along the arc
    await expect(run('text_on_path', { text: 'way too long for this path', fontSize: 80, d: 'M0 0 L100 0' })).rejects.toThrow(/longer path/);
  });

  it('set_text_animation validates eases and layer types', async () => {
    const s = editor.store;
    const t = addLayer(s, 'text', { text: { content: 'Hello', fontFamily: 'Inter', fontSize: 50, fontWeight: 600, lineHeight: 1.2, letterSpacing: 0, align: 'left' } as any });
    const out = await run('set_text_animation', { ids: [t.id], preset: 'Pop letters', from: { dy: 30 }, ease: 'Back Out', order: 'center' });
    expect(out).toMatch(/in by char/);
    expect(t.textAnim!.from.dy).toBe(30);
    await expect(run('set_text_animation', { ids: [t.id], ease: 'Wobbly' })).rejects.toThrow(/ease/);
    await expect(run('set_text_animation', { ids: [addLayer(s, 'rect', {}).id] })).rejects.toThrow(/not text/);
  });
});
