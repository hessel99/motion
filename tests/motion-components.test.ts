import { describe, it, expect } from 'vitest';
import { Store } from '../src/core/store';
import { addLayer, setProp, addKeyframe, valueAt } from '../src/core/commands';
import {
  makeComponent, addMotionInstance, setPlay, setInstanceProps, exposeProperty, removeProperty, addVariant, editVariant,
  setInstanceVariant, instanceTime, playRange, instanceSpan, resolvedLayers, InstanceResolver, instancePlan, setRanges,
  describeInstance, swapComponent, motionInstancesOf, effectivePlay, addFormatVariants, guessRanges,
} from '../src/core/motion-components';
import { exportLibrary, planLibrary, applyLibrary, componentRev } from '../src/core/component-library';
import type { Composition, Layer } from '../src/core/model';

/** a 4s title card: background, title (fades in 0..0.5, holds, out 3.5..4), accent bar */
function titleCard() {
  const s = new Store();
  s.comp.duration = 4;
  const bg = addLayer(s, 'rect', { name: 'bg', x: 0, y: 0, w: 1920, h: 1080, color: [0.1, 0.1, 0.12, 1] });
  const title = addLayer(s, 'text', { name: 'title', x: 260, y: 480, w: 1400, h: 120, text: { content: 'Hello', fontFamily: 'Inter', fontSize: 96, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'center' } });
  const bar = addLayer(s, 'rect', { name: 'bar', x: 860, y: 620, w: 200, h: 8, color: [1, 0.3, 0.2, 1] });
  s.setTime(0); setProp(s, title.id, 'opacity', [0]); addKeyframe(s, [title.id], 'opacity');
  s.setTime(0.5); setProp(s, title.id, 'opacity', [100]);
  s.setTime(3.5); addKeyframe(s, [title.id], 'opacity');
  s.setTime(4); setProp(s, title.id, 'opacity', [0]);
  s.setTime(0);
  const main = s.comp;
  const { comp, layer } = makeComponent(s, [bg.id, title.id, bar.id], { name: 'Title' });
  return { s, main, comp, inst: layer, bg, title, bar };
}
const L = (s: Store, id: string) => s.project.layers[id];

describe('motion components: time', () => {
  const comp = { duration: 4, fps: 60, component: { ranges: [{ name: 'in', from: 0, to: 0.5 }, { name: 'hold', from: 0.5, to: 3.5 }, { name: 'out', from: 3.5, to: 4 }] } } as unknown as Composition;
  it('plays once at 1x by default and hides after the end', () => {
    expect(instanceTime(comp, {}, 1)).toBe(1);
    expect(instanceTime(comp, {}, -0.1)).toBeNaN();
    expect(instanceTime(comp, {}, 4.2)).toBeNaN();
  });
  it('speed and stretch to a duration', () => {
    expect(instanceTime(comp, { speed: 2 }, 1)).toBe(2);
    expect(instanceTime(comp, { duration: 8 }, 2)).toBe(1);
    expect(instanceSpan(comp, { duration: 8 })).toBe(8);
  });
  it('named ranges, reverse, loop, ping-pong, hold', () => {
    expect(playRange(comp, { range: 'hold' })).toEqual([0.5, 3.5]);
    expect(playRange(comp, { from: 'in', to: 'hold' })).toEqual([0, 3.5]);
    expect(instanceTime(comp, { range: 'out' }, 0.25)).toBeCloseTo(3.75);
    expect(instanceTime(comp, { range: 'in', reverse: true }, 0)).toBeCloseTo(0.5, 4);
    expect(instanceTime(comp, { range: 'in', loop: 'loop' }, 1.1)).toBeCloseTo(0.1);
    expect(instanceTime(comp, { range: 'in', loop: 'pingpong' }, 0.6)).toBeCloseTo(0.4);
    expect(instanceTime(comp, { range: 'in', loop: 'loop', loops: 2 }, 1.2)).toBeNaN();
    expect(instanceTime(comp, { range: 'in', hold: 'last' }, 9)).toBeCloseTo(0.5, 4);
    expect(instanceTime(comp, { hold: 'first' }, -2)).toBe(0);
    expect(instanceSpan(comp, { loop: 'loop' })).toBe(Infinity);
  });
});

describe('motion components: model', () => {
  it('make component: a component composition with guessed in / hold / out ranges, shown by one instance', () => {
    const { s, main, comp, inst } = titleCard();
    expect(comp.component).toBeTruthy();
    expect(main.root).toEqual([inst.id]);
    expect(inst.compRef).toBe(comp.id);
    expect(comp.component!.ranges!.map(r => r.name)).toEqual(['in', 'hold', 'out']);
    expect(comp.component!.ranges![1]).toMatchObject({ from: 0.5, to: 3.5 });
    // one undo step
    s.undo();
    expect(s.project.comps[comp.id]).toBeUndefined();
  });

  it('exposed properties: text, color, toggle, number; instances store only their values', () => {
    const { s, comp, inst, title, bar } = titleCard();
    exposeProperty(s, comp.id, { name: 'Title', targets: [{ layer: title.id, field: 'text' }] });
    exposeProperty(s, comp.id, { name: 'Accent', targets: [{ layer: bar.id, field: 'fill' }] });
    exposeProperty(s, comp.id, { name: 'Show bar', targets: [{ layer: bar.id, field: 'visible' }] });
    exposeProperty(s, comp.id, { name: 'Delay', targets: [{ layer: title.id, field: 'delay' }] });
    setInstanceProps(s, [inst.id], { Title: 'Episode 4', Accent: [0, 0.5, 1, 1], 'Show bar': false, Delay: 0.25 });
    const r = resolvedLayers(s.project, L(s, inst.id));
    expect(r.get(title.id)!.text!.content).toBe('Episode 4');
    expect(r.get(bar.id)!.props.fill!.v).toEqual([0, 0.5, 1, 1]);
    expect(r.get(bar.id)!.visible).toBe(false);
    expect(r.get(title.id)!.props.opacity!.kf![0].t).toBeCloseTo(0.25);
    // the main is untouched; untouched props are shared, not copied
    expect(L(s, title.id).text!.content).toBe('Hello');
    expect(r.get(title.id)!.props.position).toBe(L(s, title.id).props.position);
    expect(r.get(comp.root[0])).toBe(L(s, comp.root[0]));
    // null resets to the main's value
    setInstanceProps(s, [inst.id], { Title: null });
    expect(resolvedLayers(s.project, L(s, inst.id)).get(title.id)!.text!.content).toBe('Hello');
    expect(describeInstance(s.project, L(s, inst.id))!.values).toMatchObject({ Title: 'Hello', 'Show bar': false });
    removeProperty(s, comp.id, comp.component!.props!.find(p => p.name === 'Show bar')!.id);
    expect(Object.keys(L(s, inst.id).inst!.props!)).toHaveLength(2);
  });

  it('a number property scales an animated swing (intensity)', () => {
    const { s, comp, inst, title } = titleCard();
    exposeProperty(s, comp.id, { name: 'Fade', targets: [{ layer: title.id, field: 'opacity' }] });
    setInstanceProps(s, [inst.id], { Fade: 50 });
    const t = resolvedLayers(s.project, L(s, inst.id)).get(title.id)!;
    expect(t.props.opacity!.kf!.map(k => k.v[0])).toEqual([0, 50, 50, 0]);
  });

  it('timing per instance, and variant defaults (a short cut)', () => {
    const { s, comp, inst } = titleCard();
    setPlay(s, [inst.id], { range: 'in', hold: 'last' });
    expect(L(s, inst.id).play).toEqual({ range: 'in', hold: 'last' });
    setPlay(s, [inst.id], { hold: 'none', range: null });
    expect(L(s, inst.id).play).toBeUndefined();
    const short = addVariant(s, comp.id, { name: 'Short', group: 'Cut', play: { duration: 2 } });
    setInstanceVariant(s, [inst.id], 'Cut', short.id);
    expect(effectivePlay(s.project, L(s, inst.id))).toEqual({ duration: 2 });
    setPlay(s, [inst.id], { speed: 2 });
    expect(effectivePlay(s.project, L(s, inst.id))).toEqual({ duration: 2, speed: 2 });
  });

  it('format variants: responsive layout from the base, instance resized, combined with a theme', () => {
    const { s, comp, inst, bg, title, bar } = titleCard();
    const v = addVariant(s, comp.id, { name: '9:16' });
    expect([v.width, v.height]).toEqual([1080, 1920]);
    expect(v.group).toBe('Format');
    // the background stretches to the new frame, content keeps its place around the center and fits
    expect(v.ov[bg.id].props!.size).toEqual([1080 - 1920, 1920 - 1080]);
    expect(v.ov[title.id].props!.scale![0]).toBeCloseTo(0.9 * 1080 / 1400, 5); // the title box fits 90% of the width
    const dark = addVariant(s, comp.id, { name: 'Dark', group: 'Theme' });
    editVariant(s, comp.id, dark.id);
    setProp(s, bar.id, 'fill', [1, 1, 1, 1]);
    editVariant(s, comp.id, null);
    expect(L(s, bar.id).props.fill!.v).toEqual([1, 0.3, 0.2, 1]); // the base is back
    expect(comp.component!.variants!.find(x => x.id === dark.id)!.ov[bar.id].props!.fill).toEqual([1, 1, 1, 1]);
    setInstanceVariant(s, [inst.id], 'Format', '9:16');
    setInstanceVariant(s, [inst.id], 'Theme', 'Dark');
    expect(L(s, inst.id).props.size!.v).toEqual([1080, 1920]);
    const r = resolvedLayers(s.project, L(s, inst.id));
    expect(r.get(bg.id)!.props.size!.v).toEqual([1080, 1920]);
    expect(r.get(bar.id)!.props.fill!.v).toEqual([1, 1, 1, 1]);
    expect(r.get(title.id)!.props.scale!.v[0]).toBeCloseTo(90 * 1080 / 1400, 4);
  });

  it('editing a variant: layout edits stay in it, timing edits reach every variant', () => {
    const { s, comp, inst, title } = titleCard();
    const v = addVariant(s, comp.id, { name: '1:1' });
    editVariant(s, comp.id, v.id);
    expect([comp.width, comp.height]).toEqual([1080, 1080]);
    const p0 = valueAt(L(s, title.id), 'position', 0);
    setProp(s, title.id, 'position', [p0[0], p0[1] - 100]);
    // the base instance (no variant) still shows the base while the comp shows 1:1
    const plan = instancePlan(s.project, L(s, inst.id), comp)!;
    expect(plan.patches.get(title.id)!.inv).toBeTruthy();
    // a new key while in the variant
    s.setTime(2);
    addKeyframe(s, [title.id], 'opacity');
    editVariant(s, comp.id, null);
    expect([comp.width, comp.height]).toEqual([1920, 1080]);
    expect(L(s, title.id).props.opacity!.kf!.length).toBe(5);
    expect(valueAt(L(s, title.id), 'position', 0)).toEqual([960, 540]);
    const ov = comp.component!.variants![0].ov[title.id].props!.position!;
    expect(ov[1]).toBeLessThan(-99);
    // undo the leave, then the edit
    s.undo();
    expect(comp.component!.editing).toBeTruthy();
  });

  it('format variants for all social sizes at once, skipping the base format', () => {
    const { s, comp } = titleCard();
    const vs = addFormatVariants(s, comp.id);
    expect(vs.map(v => v.name)).toEqual(['9:16', '1:1', '4:5']);
  });

  it('nested components: an outer property drives an inner instance property', () => {
    const { s, comp, inst, title } = titleCard();
    exposeProperty(s, comp.id, { name: 'Title', targets: [{ layer: title.id, field: 'text' }] });
    // a reel component containing a Title instance
    const t2 = addMotionInstance(s, comp.id, {});
    const { comp: reel, layer: reelInst } = makeComponent(s, [t2.id], { name: 'Reel' });
    const p = comp.component!.props![0];
    exposeProperty(s, reel.id, { name: 'Headline', targets: [{ layer: t2.id, field: 'prop:' + p.id }] });
    setInstanceProps(s, [reelInst.id], { Headline: 'Nested!' });
    const outer = resolvedLayers(s.project, L(s, reelInst.id)).get(t2.id)!;
    expect(outer.inst!.props![p.id]).toBe('Nested!');
    const inner = resolvedLayers(s.project, outer);
    expect(inner.get(title.id)!.text!.content).toBe('Nested!');
    expect(motionInstancesOf(s.project, comp.id).length).toBe(2);
    void inst;
  });

  it('swap keeps values by property name', () => {
    const { s, comp, inst, title } = titleCard();
    exposeProperty(s, comp.id, { name: 'Title', targets: [{ layer: title.id, field: 'text' }] });
    setInstanceProps(s, [inst.id], { Title: 'Keep me' });
    // a second component with a Title property
    const t = addLayer(s, 'text', { name: 'big', x: 0, y: 0, w: 400, h: 100, text: { content: 'X', fontFamily: 'Inter', fontSize: 64, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'left' } });
    const { comp: c2 } = makeComponent(s, [t.id], { name: 'Big title' });
    exposeProperty(s, c2.id, { name: 'title', targets: [{ layer: t.id, field: 'text' }] });
    swapComponent(s, [inst.id], 'Big title');
    expect(L(s, inst.id).compRef).toBe(c2.id);
    expect(resolvedLayers(s.project, L(s, inst.id)).get(t.id)!.text!.content).toBe('Keep me');
  });

  it('the resolver hands out the same objects while nothing changes (incremental compiles)', () => {
    const { s, comp, inst, title } = titleCard();
    exposeProperty(s, comp.id, { name: 'Title', targets: [{ layer: title.id, field: 'text' }] });
    setInstanceProps(s, [inst.id], { Title: 'A' });
    const R = new InstanceResolver();
    const plan = () => instancePlan(s.project, L(s, inst.id), comp);
    R.begin();
    const a = R.resolve('>' + inst.id, L(s, title.id), plan());
    R.end();
    R.begin();
    const b = R.resolve('>' + inst.id, L(s, title.id), plan());
    R.end();
    expect(b).toBe(a);
    setProp(s, title.id, 'rotation', [5]); // the main changed: a fresh copy
    R.begin();
    const c = R.resolve('>' + inst.id, L(s, title.id), plan());
    expect(c).not.toBe(a);
    expect(c.props.rotation!.v).toEqual([5]);
  });

  it('guessRanges finds no ranges in an animation that never rests', () => {
    const s = new Store();
    const r = addLayer(s, 'rect', { x: 0, y: 0, w: 10, h: 10 });
    s.setTime(0); addKeyframe(s, [r.id], 'rotation');
    s.setTime(5); setProp(s, r.id, 'rotation', [360]);
    expect(guessRanges(s.project, s.comp)).toEqual([]);
    setRanges; // (exported for the inspector)
  });
});

describe('component library', () => {
  it('publish, import into another project, update with a review, instances keep their values', () => {
    const a = titleCard();
    exposeProperty(a.s, a.comp.id, { name: 'Title', targets: [{ layer: a.title.id, field: 'text' }] });
    const lib = exportLibrary(a.s.project, { name: 'Brand kit' });
    expect(lib.components.map(c => c.comp.name)).toEqual(['Title']);

    const b = new Store();
    const plan = planLibrary(b.project, lib);
    expect(plan.map(c => c.status)).toEqual(['new']);
    applyLibrary(b, lib, plan);
    const local = Object.values(b.project.comps).find(c => c.component)!;
    expect(local.component!.lib!.name).toBe('Brand kit');
    const inst = addMotionInstance(b, local.id, { props: { Title: 'Ours' } });
    expect(planLibrary(b.project, lib).map(c => c.status)).toEqual(['same']);

    // the library changes: new property, bar recolored
    setProp(a.s, a.bar.id, 'fill', [0, 1, 0, 1]);
    exposeProperty(a.s, a.comp.id, { name: 'Accent', targets: [{ layer: a.bar.id, field: 'fill' }] });
    const lib2 = exportLibrary(a.s.project, { name: 'Brand kit' });
    expect(componentRev(a.s.project, a.comp)).toBe(lib2.components[0].rev);
    const plan2 = planLibrary(b.project, lib2);
    expect(plan2[0]).toMatchObject({ status: 'changed', instances: 1 });
    expect(plan2[0].notes).toContain('new property Accent');
    applyLibrary(b, lib2, plan2);
    expect(b.project.comps[local.id].component!.props!.map(p => p.name)).toEqual(['Title', 'Accent']);
    const r = resolvedLayers(b.project, b.project.layers[inst.id]);
    const texts = [...r.values()].filter((l: Layer) => l.type === 'text');
    expect(texts[0].text!.content).toBe('Ours');
    // one undo step
    b.undo();
    expect(b.project.comps[local.id].component!.props!.map(p => p.name)).toEqual(['Title']);
  });
});
