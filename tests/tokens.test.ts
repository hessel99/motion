import { describe, it, expect } from 'vitest';
import { Store } from '../src/core/store';
import { addLayer, setProp, toggleAnimated, valueAt } from '../src/core/commands';
import { addToken, linkProp, setTokenMode, setTokenValue, tokenUsage, deleteToken, linkOf } from '../src/core/tokens';
import { applySync, parseTokenFile, planSync, summarizePlan, parseColorValue, exportTokenFile, parseFigmaVariablesApi } from '../src/core/token-sync';

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
    const plan = planSync(s.project, parseTokenFile({ light: { bg: { $type: 'color', $value: '#ffffff' } }, dark: { bg: { $type: 'color', $value: '#000000' } } }));
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
  const v1 = { Brand: { $type: 'color', Primary: { $value: '#ff0000' }, Accent: { $value: '#00ff00' }, Old: { $value: '#123456' } }, Radius: { M: { $type: 'dimension', $value: '8px' } } };
  const v2 = { Brand: { $type: 'color', Primary: { $value: '#0000ff' }, Accent: { $value: '#00ff00' }, New: { $value: '#ffffff' } }, Radius: { M: { $type: 'dimension', $value: '12px' } } };

  it('plans a readable diff, applies it as one undo step and rewrites linked values', () => {
    const s = new Store();
    const a = addLayer(s, 'rect', { name: 'A' });
    applySync(s, planSync(s.project, parseTokenFile(v1), { from: 'file:brand.json' }), { kind: 'file', label: 'brand.json', location: 'brand.json' });
    const items = () => Object.values(s.project.tokens!.items);
    expect(items().map(t => t.name).sort()).toEqual(['Brand/Accent', 'Brand/Old', 'Brand/Primary', 'Radius/M']);
    const primary = items().find(t => t.name === 'Brand/Primary')!;
    const radius = items().find(t => t.name === 'Radius/M')!;
    linkProp(s, [a.id], 'fill', primary.id);
    linkProp(s, [a.id], 'radius', radius.id);

    const plan = planSync(s.project, parseTokenFile(v2), { from: 'file:brand.json', removeMissing: true });
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
    applySync(s, planSync(s.project, parseTokenFile(v1), { from: 'f' }));
    const old = Object.values(s.project.tokens!.items).find(t => t.name === 'Brand/Old')!;
    linkProp(s, [a.id], 'fill', old.id);
    const plan = planSync(s.project, parseTokenFile(v2), { from: 'f', removeMissing: true });
    expect(plan.removed[0].used).toBe(1);
    applySync(s, plan);
    expect(s.project.tokens!.items[old.id].missing).toBe(true);
    expect(a.props.fill!.bind).toBe(old.id);
  });

  it('a renamed variable (same key) is a rename, not remove + add', () => {
    const s = new Store();
    const api = (name: string, hex: { r: number; g: number; b: number }) => ({ meta: { variableCollections: { c1: { modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }] } }, variables: { v1: { id: 'v1', key: 'KEY1', name, resolvedType: 'COLOR', variableCollectionId: 'c1', valuesByMode: { m1: { ...hex, a: 1 }, m2: { r: 0, g: 0, b: 0, a: 1 } } } } } });
    applySync(s, planSync(s.project, parseFigmaVariablesApi(api('Brand/Primary', { r: 1, g: 0, b: 0 }))));
    expect(s.project.tokens!.modes).toEqual(['Light', 'Dark']);
    const plan = planSync(s.project, parseFigmaVariablesApi(api('Brand/Main', { r: 1, g: 0, b: 0 })));
    expect(plan.added.length).toBe(0);
    expect(plan.changed[0].rename).toBe('Brand/Main');
    applySync(s, plan);
    expect(Object.values(s.project.tokens!.items).map(t => t.name)).toEqual(['Brand/Main']);
  });
});

describe('styles: token files', () => {
  it('parses colors in every common form', () => {
    expect(parseColorValue('#f00')).toEqual([1, 0, 0, 1]);
    expect(parseColorValue('#ff000080')![3]).toBeCloseTo(0.5, 2);
    expect(parseColorValue('rgb(255, 0, 0)')).toEqual([1, 0, 0, 1]);
    expect(parseColorValue('rgba(0 0 255 / 50%)')).toEqual([0, 0, 1, 0.5]);
    expect(near(parseColorValue('hsl(120, 100%, 50%)')!, [0, 1, 0, 1])).toBe(true);
    expect(parseColorValue({ colorSpace: 'srgb', components: [0, 0.5, 1], alpha: 1 })).toEqual([0, 0.5, 1, 1]);
  });

  it('resolves aliases and inherits group types (W3C DTCG)', () => {
    const t = parseTokenFile({ base: { $type: 'color', blue: { $value: '#0000ff' } }, brand: { primary: { $type: 'color', $value: '{base.blue}' } } });
    const p = t.find(x => x.name === 'brand/primary')!;
    expect(p.values.Default).toEqual([0, 0, 1, 1]);
  });

  it('reads Tokens Studio multi-set files (light / dark sets become modes)', () => {
    const t = parseTokenFile({
      global: { blue: { value: '#0000ff', type: 'color' }, radius: { value: '4', type: 'borderRadius' } },
      light: { bg: { value: '#ffffff', type: 'color' }, accent: { value: '{blue}', type: 'color' } },
      dark: { bg: { value: '#000000', type: 'color' }, accent: { value: '{blue}', type: 'color' } },
      $metadata: { tokenSetOrder: ['global', 'light', 'dark'] },
    });
    const bg = t.find(x => x.name === 'bg')!;
    expect(bg.values).toEqual({ Light: [1, 1, 1, 1], Dark: [0, 0, 0, 1] });
    expect(t.find(x => x.name === 'accent')!.values.Dark).toEqual([0, 0, 1, 1]);
    expect(t.find(x => x.name === 'radius')!.type).toBe('number');
  });

  it('exports the library as DTCG and reads it back', () => {
    const s = new Store();
    addToken(s, { name: 'Brand/Primary', type: 'color', value: [1, 0, 0, 1] });
    addToken(s, { name: 'Space/S', type: 'number', value: [4] });
    const back = parseTokenFile(exportTokenFile(s.project.tokens!));
    expect(back.map(t => t.name).sort()).toEqual(['Brand/Primary', 'Space/S']);
    expect(planSync(s.project, back).changed.length).toBe(0);
  });
});
