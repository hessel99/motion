import { describe, it, expect } from 'vitest';
import { Store } from '../src/core/store';
import { addLayer, addKeyframe, deleteLayers, setProp, valueAt, cloneLayers, renameLayer } from '../src/core/commands';
import { createComponent, createInstance, detachInstance, instancesOf, resetOverrides, setInstanceDelay, instanceRootOf, removeComponent } from '../src/core/components';
import { addToken, linkProp, setTokenValue } from '../src/core/tokens';
import type { Layer } from '../src/core/model';

function button() {
  const s = new Store();
  const g = addLayer(s, 'group', { name: 'Button', x: 100, y: 100, w: 200, h: 60 });
  const bg = addLayer(s, 'rect', { name: 'bg', x: 0, y: 0, w: 200, h: 60 }, g.id);
  const label = addLayer(s, 'text', { name: 'label', x: 20, y: 10, w: 160, h: 40, text: { content: 'Buy', fontFamily: 'Inter', fontSize: 20, fontWeight: 600, lineHeight: 1.2, letterSpacing: 0, align: 'center' } }, g.id);
  createComponent(s, g.id);
  return { s, g, bg, label };
}
const L = (s: Store, id: string) => s.project.layers[id];
const child = (s: Store, inst: Layer, i: number) => L(s, inst.children[i]);

describe('components', () => {
  it('an instance is a linked copy, placed next to the main', () => {
    const { s, g } = button();
    const inst = createInstance(s, g.id);
    expect(inst.link!.main).toBe(g.id);
    expect(inst.children.length).toBe(2);
    expect(child(s, inst, 0).link!.main).toBe(g.children[0]);
    expect(valueAt(inst, 'position', 0)).toEqual([valueAt(g, 'position', 0)[0] + 40, valueAt(g, 'position', 0)[1] + 40]);
    expect(instancesOf(s.project, g.id)).toEqual([inst.id]);
  });

  it('changes to the main propagate to every instance in one undo step', () => {
    const { s, g, bg } = button();
    const a = createInstance(s, g.id), b = createInstance(s, g.id, { x: 600, y: 300 });
    const before = s.historyLength;
    setProp(s, bg.id, 'fill', [1, 0, 0, 1]);
    expect(s.historyLength).toBe(before + 1);
    expect(child(s, a, 0).props.fill!.v).toEqual([1, 0, 0, 1]);
    expect(child(s, b, 0).props.fill!.v).toEqual([1, 0, 0, 1]);
    s.undo();
    expect(child(s, a, 0).props.fill!.v).not.toEqual([1, 0, 0, 1]);
    s.redo();
    expect(child(s, b, 0).props.fill!.v).toEqual([1, 0, 0, 1]);
  });

  it('animation on the main plays in every instance, from its own place and with its own delay', () => {
    const { s, g } = button();
    const inst = createInstance(s, g.id, { x: 800, y: 500 });
    s.setTime(0); addKeyframe(s, [g.id], 'position');
    s.setTime(1); setProp(s, g.id, 'position', [300, 130]);
    const m0 = valueAt(g, 'position', 0), m1 = valueAt(g, 'position', 1);
    expect(valueAt(inst, 'position', 0)).toEqual([800, 500]);
    expect(valueAt(inst, 'position', 1)).toEqual([800 + m1[0] - m0[0], 500 + m1[1] - m0[1]]);
    setInstanceDelay(s, inst.id, 0.5);
    expect(inst.props.position!.kf!.map(k => k.t)).toEqual([0.5, 1.5]);
    expect(valueAt(inst, 'position', 1.5)[0]).toBeCloseTo(800 + m1[0] - m0[0]);
    // the main moves again: the instance follows, delay kept
    s.setTime(1); setProp(s, g.id, 'position', [400, 130]);
    expect(inst.props.position!.kf![1].t).toBe(1.5);
    expect(inst.props.position!.kf![1].v[0]).toBeCloseTo(800 + 400 - m0[0]);
  });

  it('moving an instance is not an override; editing a property is', () => {
    const { s, g, bg, label } = button();
    const inst = createInstance(s, g.id);
    setProp(s, inst.id, 'position', [900, 900]);
    expect(inst.link!.ov).toBeUndefined();
    expect(inst.link!.dx).toBe(900 - valueAt(g, 'position', 0)[0]);
    const ibg = child(s, inst, 0), ilabel = child(s, inst, 1);
    setProp(s, ibg.id, 'fill', [0, 1, 0, 1]);
    expect(ibg.link!.ov).toEqual(['fill']);
    // the main changes fill and radius: the instance keeps its fill, takes the radius
    setProp(s, bg.id, 'fill', [1, 0, 0, 1]);
    setProp(s, bg.id, 'radius', [8, 8, 8, 8]);
    expect(ibg.props.fill!.v).toEqual([0, 1, 0, 1]);
    expect(ibg.props.radius!.v).toEqual([8, 8, 8, 8]);
    // text override
    s.transact('text', tx => { tx.set(ilabel, 'text', { ...ilabel.text!, content: 'Sell' }); tx.touch(ilabel.id); });
    expect(ilabel.link!.ov).toEqual(['text']);
    s.transact('text', tx => { tx.set(label, 'text', { ...label.text!, fontSize: 30 }); tx.touch(label.id); });
    expect(ilabel.text!.content).toBe('Sell'); // overridden: kept
    // reset brings the main's values back
    resetOverrides(s, inst.id);
    expect(ibg.props.fill!.v).toEqual([1, 0, 0, 1]);
    expect(L(s, inst.children[1]).text!.content).toBe('Buy');
    expect(L(s, inst.children[1]).text!.fontSize).toBe(30);
  });

  it('setting an overridden value back to the main value clears the override', () => {
    const { s, g, bg } = button();
    const inst = createInstance(s, g.id);
    const ibg = child(s, inst, 0);
    const orig = bg.props.fill!.v.slice();
    setProp(s, ibg.id, 'fill', [0, 1, 0, 1]);
    setProp(s, ibg.id, 'fill', orig);
    expect(ibg.link!.ov).toBeUndefined();
  });

  it('layers added to or removed from the main appear in / disappear from instances', () => {
    const { s, g } = button();
    const inst = createInstance(s, g.id);
    const icon = addLayer(s, 'ellipse', { name: 'icon', x: 170, y: 20, w: 20, h: 20 }, g.id);
    expect(inst.children.length).toBe(3);
    const iicon = child(s, inst, 2);
    expect(iicon.link!.main).toBe(icon.id);
    expect(iicon.name).toBe('icon');
    s.undo();
    expect(L(s, inst.id).children.length).toBe(2);
    s.redo();
    deleteLayers(s, [icon.id]);
    expect(L(s, inst.id).children.length).toBe(2);
  });

  it('linked styles flow through components (sync updates main and instances)', () => {
    const { s, g, bg } = button();
    const brand = addToken(s, { name: 'Brand/Primary', type: 'color', value: [1, 0, 0, 1] });
    const inst = createInstance(s, g.id);
    linkProp(s, [bg.id], 'fill', brand.id);
    const ibg = child(s, inst, 0);
    expect(ibg.props.fill!.bind).toBe(brand.id);
    setTokenValue(s, brand.id, [0, 0, 1, 1]);
    expect(ibg.props.fill!.v).toEqual([0, 0, 1, 1]);
    expect(ibg.link!.ov).toBeUndefined();
  });

  it('duplicating an instance makes another instance; detach makes plain layers', () => {
    const { s, g, bg } = button();
    const inst = createInstance(s, g.id);
    const [dup] = cloneLayers(s, [inst.id]);
    expect(L(s, dup).link!.main).toBe(g.id);
    setProp(s, bg.id, 'fill', [1, 1, 0, 1]);
    expect(child(s, L(s, dup), 0).props.fill!.v).toEqual([1, 1, 0, 1]);
    detachInstance(s, dup);
    expect(L(s, dup).link).toBeUndefined();
    expect(child(s, L(s, dup), 0).link).toBeUndefined();
    setProp(s, bg.id, 'fill', [0, 1, 1, 1]);
    expect(child(s, L(s, dup), 0).props.fill!.v).toEqual([1, 1, 0, 1]);
    expect(instanceRootOf(s.project, inst.children[0])).toBe(inst.id);
  });

  it('deleting the main turns instances into plain layers (undo restores the link)', () => {
    const { s, g } = button();
    const inst = createInstance(s, g.id);
    deleteLayers(s, [g.id]);
    expect(s.project.components![g.id]).toBeUndefined();
    expect(L(s, inst.id).link).toBeUndefined();
    s.undo();
    expect(s.project.components![g.id]).toBeDefined();
    expect(L(s, inst.id).link!.main).toBe(g.id);
  });

  it('renaming an instance layer is not an override; removing the component unlinks', () => {
    const { s, g } = button();
    const inst = createInstance(s, g.id);
    renameLayer(s, inst.id, 'Buy button');
    expect(inst.link!.ov).toBeUndefined();
    removeComponent(s, g.id);
    expect(L(s, inst.id).link).toBeUndefined();
  });
});
