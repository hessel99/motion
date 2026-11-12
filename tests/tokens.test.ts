import { describe, it, expect } from 'vitest';
import { Store } from '../src/core/store';
import { addLayer, setProp, toggleAnimated, valueAt } from '../src/core/commands';
import { addToken, linkProp, setTokenMode, setTokenValue, tokenUsage, deleteToken, linkOf } from '../src/core/tokens';
import { applySync, planSync, summarizePlan, parseColorValue, type IncomingToken } from '../src/core/token-sync';

const hex = (h: string) => parseColorValue(h)!;
const color = (name: string, values: Record<string, string>, key = name): IncomingToken => ({ key, name, type: 'color', kind: 'figma-variable', values: Object.fromEntries(Object.entries(values).map(([m, v]) => [m, hex(v)])) });
const num = (name: string, v: number): IncomingToken => ({ key: name, name, type: 'number', kind: 'figma-variable', values: { Default: [v] } });

const near = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-3);

function setup() {
  const s = new Store();
  const a = addLayer(s, 'rect', { name: 'A' });
  const b = addLayer(s, 'ellipse', { name: 'B' });
  const brand = addToken(s, { name: 'Brand/Primary', type: 'color', value: [1, 0, 0, 1] });
  return { s, a, b, brand };
}

describe('styles: linking', () => {
  it('a linked property holds the resolved value (renderer reads plain numbers)', () => {
    const { s, a, b, brand } = setup();
    linkProp(s, [a.id, b.id], 'fill', brand.id);
    expect(a.props.fill!.bind).toBe(brand.id);
    expect(a.props.fill!.v).toEqual([1, 0, 0, 1]);
    expect(tokenUsage(s.project).get(brand.id)!.layers.size).toBe(2);
  });

  it('changing the style updates every linked layer in one undo step', () => {
    const { s, a, b, brand } = setup();
    linkProp(s, [a.id, b.id], 'fill', brand.id);
    setTokenValue(s, brand.id, [0, 0, 1, 1]);
    expect(a.props.fill!.v).toEqual([0, 0, 1, 1]);
    expect(b.props.fill!.v).toEqual([0, 0, 1, 1]);
    s.undo();
    expect(a.props.fill!.v).toEqual([1, 0, 0, 1]);
    expect(b.props.fill!.v).toEqual([1, 0, 0, 1]);
    expect(brand.values.Default).toEqual([1, 0, 0, 1]);
  });

  it('a hand edit of a linked value unlinks it (figma behavior), undo relinks', () => {
    const { s, a, brand } = setup();
    linkProp(s, [a.id], 'fill', brand.id);
    setProp(s, a.id, 'fill', [0, 1, 0, 1]);
    expect(a.props.fill!.bind).toBeUndefined();
    s.undo();
    expect(a.props.fill!.bind).toBe(brand.id);
  });

  it('detach keeps the current value', () => {
    const { s, a, brand } = setup();
    linkProp(s, [a.id], 'fill', brand.id);
    linkProp(s, [a.id], 'fill', null);
    expect(a.props.fill!.bind).toBeUndefined();
    expect(a.props.fill!.v).toEqual([1, 0, 0, 1]);
  });

  it('number styles fill every component (radius corners) and refuse color props', () => {
    const { s, a } = setup();
    const r = addToken(s, { name: 'Radius/M', type: 'number', value: [12] });
    linkProp(s, [a.id], 'radius', r.id);
    expect(a.props.radius!.v).toEqual([12, 12, 12, 12]);
    expect(() => linkProp(s, [a.id], 'fill', r.id)).toThrow();
  });

  it('keyframes linked to a style keep working when the style changes', () => {
    const { s, a, brand } = setup();
    const accent = addToken(s, { name: 'Brand/Accent', type: 'color', value: [0, 1, 0, 1] });
    s.setTime(0);
    linkProp(s, [a.id], 'fill', brand.id);
    toggleAnimated(s, [a.id], 'fill'); // key at 0 = brand value -> the link moves to that key
    expect(a.props.fill!.bind).toBeUndefined();
    expect(a.props.fill!.kf![0].tok).toBe(brand.id);
    linkProp(s, [a.id], 'fill', accent.id, 1); // key at 1s linked to accent
    expect(a.props.fill!.kf!.length).toBe(2);
    setTokenValue(s, brand.id, [0, 0, 0, 1]);
    setTokenValue(s, accent.id, [1, 1, 1, 1]);
    expect(valueAt(a, 'fill', 0)).toEqual([0, 0, 0, 1]);
    expect(valueAt(a, 'fill', 1)).toEqual([1, 1, 1, 1]);
    expect(linkOf(a, 'fill', 1)).toBe(accent.id);
    // editing one keyframe's value by hand unlinks only that key
    setProp(s, a.id, 'fill', [0.5, 0.5, 0.5, 1], { time: 1 });
    expect(a.props.fill!.kf![1].tok).toBeUndefined();
    expect(a.props.fill!.kf![0].tok).toBe(brand.id);
  });

  it('light / dark modes switch every linked value in one step', () => {
    const { s, a } = setup();
    const plan = planSync(s.project, [color('bg', { Light: '#ffffff', Dark: '#000000' })]);
    applySync(s, plan);
    expect(s.project.tokens!.modes).toEqual(['Light', 'Dark']);
    const bg = Object.values(s.project.tokens!.items).find(t => t.name === 'bg')!;
    linkProp(s, [a.id], 'fill', bg.id);
    expect(a.props.fill!.v).toEqual([1, 1, 1, 1]);
    setTokenMode(s, 'Dark');
    expect(a.props.fill!.v).toEqual([0, 0, 0, 1]);
    expect(a.props.fill!.bind).toBe(bg.id); // still linked
    s.undo();
    expect(a.props.fill!.v).toEqual([1, 1, 1, 1]);
  });

  it('deleting a style keeps the layer values and unlinks them', () => {
    const { s, a, brand } = setup();
    linkProp(s, [a.id], 'fill', brand.id);
    deleteToken(s, brand.id);
    expect(a.props.fill!.bind).toBeUndefined();
    expect(a.props.fill!.v).toEqual([1, 0, 0, 1]);
  });
});

describe('styles: sync', () => {
  const v1 = [color('Brand/Primary', { Default: '#ff0000' }), color('Brand/Accent', { Default: '#00ff00' }), color('Brand/Old', { Default: '#123456' }), num('Radius/M', 8)];
  const v2 = [color('Brand/Primary', { Default: '#0000ff' }), color('Brand/Accent', { Default: '#00ff00' }), color('Brand/New', { Default: '#ffffff' }), num('Radius/M', 12)];

  it('plans a readable diff, applies it as one undo step and rewrites linked values', () => {
    const s = new Store();
    const a = addLayer(s, 'rect', { name: 'A' });
    applySync(s, planSync(s.project, v1, { from: 'figma' }));
    const items = () => Object.values(s.project.tokens!.items);
    expect(items().map(t => t.name).sort()).toEqual(['Brand/Accent', 'Brand/Old', 'Brand/Primary', 'Radius/M']);
    const primary = items().find(t => t.name === 'Brand/Primary')!;
    const radius = items().find(t => t.name === 'Radius/M')!;
    linkProp(s, [a.id], 'fill', primary.id);
    linkProp(s, [a.id], 'radius', radius.id);

    const plan = planSync(s.project, v2, { from: 'figma', removeMissing: true });
    expect(plan.changed.map(c => c.name).sort()).toEqual(['Brand/Primary', 'Radius/M']);
    expect(plan.added.map(t => t.name)).toEqual(['Brand/New']);
    expect(plan.removed.map(t => t.name)).toEqual(['Brand/Old']);
    expect(plan.unchanged).toBe(1);
    expect(summarizePlan(plan)).toBe('2 styles changed, 1 color new, 1 style removed');

    const before = s.historyLength;
    applySync(s, plan);
    expect(s.historyLength).toBe(before + 1);
    expect(near(a.props.fill!.v, [0, 0, 1, 1])).toBe(true);
    expect(a.props.radius!.v).toEqual([12, 12, 12, 12]);
    expect(a.props.fill!.bind).toBe(primary.id);
    expect(items().some(t => t.name === 'Brand/Old')).toBe(false);
    s.undo();
    expect(near(a.props.fill!.v, [1, 0, 0, 1])).toBe(true);
    expect(items().some(t => t.name === 'Brand/Old')).toBe(true);
  });

  it('a removed style that is still used is kept and marked missing', () => {
    const s = new Store();
    const a = addLayer(s, 'rect');
    applySync(s, planSync(s.project, v1, { from: 'f' }));
    const old = Object.values(s.project.tokens!.items).find(t => t.name === 'Brand/Old')!;
    linkProp(s, [a.id], 'fill', old.id);
    const plan = planSync(s.project, v2, { from: 'f', removeMissing: true });
    expect(plan.removed[0].used).toBe(1);
    applySync(s, plan);
    expect(s.project.tokens!.items[old.id].missing).toBe(true);
    expect(a.props.fill!.bind).toBe(old.id);
  });

  it('a renamed variable (same key) is a rename, not remove + add', () => {
    const s = new Store();
    const api = (name: string) => [color(name, { Light: '#ff0000', Dark: '#000000' }, 'KEY1')];
    applySync(s, planSync(s.project, api('Brand/Primary')));
    expect(s.project.tokens!.modes).toEqual(['Light', 'Dark']);
    const plan = planSync(s.project, api('Brand/Main'));
    expect(plan.added.length).toBe(0);
    expect(plan.changed[0].rename).toBe('Brand/Main');
    applySync(s, plan);
    expect(Object.values(s.project.tokens!.items).map(t => t.name)).toEqual(['Brand/Main']);
  });
});

describe('styles: colors', () => {
  it('parses colors in every common form', () => {
    expect(parseColorValue('#f00')).toEqual([1, 0, 0, 1]);
    expect(parseColorValue('#ff000080')![3]).toBeCloseTo(0.5, 2);
    expect(parseColorValue('rgb(255, 0, 0)')).toEqual([1, 0, 0, 1]);
    expect(parseColorValue('rgba(0 0 255 / 50%)')).toEqual([0, 0, 1, 0.5]);
    expect(near(parseColorValue('hsl(120, 100%, 50%)')!, [0, 1, 0, 1])).toBe(true);
    expect(parseColorValue({ colorSpace: 'srgb', components: [0, 0.5, 1], alpha: 1 })).toEqual([0, 0.5, 1, 1]);
  });

});
