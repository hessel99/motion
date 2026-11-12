import { describe, it, expect, beforeEach } from 'vitest';
import { TOOLS } from '../src/agent/tools';
import { toolLabel } from '../src/agent/labels';
import { findGuide } from '../src/agent/guides';
import { editor } from '../src/app/editor';
import { createProject } from '../src/core/model';
import { resolvedLayers } from '../src/core/motion-components';

const run = async (name: string, args: any) => {
  const t = TOOLS.find(x => x.name === name);
  if (!t) throw new Error('no tool ' + name);
  const c = await t.run(args);
  return c[0].type === 'text' ? c[0].text : '';
};
const json = async (name: string, args: any) => JSON.parse(await run(name, args));

beforeEach(() => { editor.store.load(createProject()); });

async function titleCard() {
  const r = await json('build_scene', {
    layers: [
      { key: 'bg', type: 'rect', x: 0, y: 0, w: 1920, h: 1080, fill: '#111111' },
      { key: 'title', type: 'text', x: 360, y: 480, w: 1200, h: 120, text: { content: 'Title', fontSize: 96 }, animate: { opacity: [{ t: 0, v: 0 }, { t: 0.5, v: 100 }, { t: 2.5, v: 100 }, { t: 3, v: 0 }] } },
      { key: 'bar', type: 'rect', x: 860, y: 620, w: 200, h: 8, fill: '#ff5533' },
    ],
  });
  return r.ids as Record<string, string>;
}

describe('component tools', () => {
  it('make, expose, variants, instances and a showreel sequence', async () => {
    const s = editor.store;
    const ids = await titleCard();
    await run('set_composition', { duration: 3 });
    const made = await json('make_component', { ids: [ids.bg, ids.title, ids.bar], name: 'Title' });
    expect(made.component.parts ?? made.component.ranges).toBeTruthy();
    expect(made.component.ranges.map((r: any) => r.name)).toEqual(['in', 'hold', 'out']);
    await json('expose_property', { component: 'Title', name: 'Title', layer: ids.title, field: 'text' });
    await json('expose_property', { component: 'Title', name: 'Accent', layer: ids.bar, field: 'fill' });
    const v = await json('add_variant', { component: 'Title', formats: ['9:16', '1:1'] });
    expect(v.variants.map((x: any) => x.name)).toEqual(['9:16', '1:1']);
    const list = await json('list_components', {});
    expect(list[0].properties.map((p: any) => p.name)).toEqual(['Title', 'Accent']);

    const seq = await json('build_sequence', {
      component: 'Title', into: 'Reel', overlap: 0.25,
      items: [{ values: { Title: 'One', Accent: '#3388ff' }, duration: 2 }, { values: { Title: 'Two' }, duration: 2 }, { values: { Title: 'Three' }, play: { range: 'in', hold: 'last' }, duration: 1 }],
    });
    expect(seq.instances.map((i: any) => i.start)).toEqual([0, 1.75, 3.5]);
    expect(s.comp.name).toBe('Reel');
    const inst = s.layer(seq.instances[0].id)!;
    const texts = [...resolvedLayers(s.project, inst).values()].filter(l => l.type === 'text').map(l => l.text!.content);
    expect(texts).toEqual(['One']);

    const vert = await json('build_sequence', { component: 'Title', into: 'Reel 9:16', variants: { Format: '9:16' }, items: [{ values: { Title: 'Vertical' } }] });
    expect([s.comp.width, s.comp.height]).toEqual([1080, 1920]);
    expect(s.layer(vert.instances[0].id)!.props.size!.v).toEqual([1080, 1920]);

    const upd = await json('set_instance', { ids: [inst.id], values: { Title: null }, variants: { Format: '1:1' }, play: { speed: 2, duration: null } });
    expect(upd[0].values.Title).toBe('Title');
    expect(upd[0].variants).toEqual(['Format=1:1']);
    expect(upd[0].plays.rate).toBe(2);

    await expect(run('add_component_instance', { component: 'Nope' })).rejects.toThrow(/no component/);
    await expect(run('set_instance', { ids: [inst.id], values: { Missing: 1 } })).rejects.toThrow(/no property/);
  });

  it('edit_variant shows a variant and records its edits', async () => {
    const s = editor.store;
    const ids = await titleCard();
    await run('make_component', { ids: [ids.bg, ids.title, ids.bar], name: 'Card' });
    await run('add_variant', { component: 'Card', group: 'Theme', name: 'Light' });
    await run('open_composition', { name: 'Card' }).catch(() => {});
    await run('edit_variant', { component: 'Card', variant: 'Light' });
    await run('update_layer', { id: ids.bg, props: { fill: '#ffffff' } });
    await run('edit_variant', { component: 'Card', variant: null });
    const c = Object.values(s.project.comps).find(x => x.name === 'Card')!;
    expect(c.component!.variants![0].ov[ids.bg].props!.fill).toEqual([1, 1, 1, 1]);
    expect(s.layer(ids.bg)!.props.fill!.v).not.toEqual([1, 1, 1, 1]);
  });

  it('labels and the guide', () => {
    expect(toolLabel('build_sequence', { component: 'Title', items: [1, 2, 3] }, () => undefined)).toContain('3');
    expect(toolLabel('make_component', { name: 'Logo sting' }, () => undefined)).toContain('Logo sting');
    expect(findGuide('components')!.text).toMatch(/build_sequence/);
  });
});
