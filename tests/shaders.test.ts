import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/core/store';
import { addLayer, addKeyframe, valueAt, deleteKeyframes, keyId, setExpr } from '../src/core/commands';
import type { PropKey } from '../src/core/model';
import {
  flattenValue, makeShaderAsset, parseShaderPropKey, parseShaderSchema, shaderPropInfo, shaderPropKey, shaderPropKeys, shaderRefs,
  unflattenValue, activeShaderFill, activeShaderEffects, hashFloats, type ShaderParamDef,
} from '../src/core/shaders';
import { addShader, moveShaderEffect, removeShader, setShaderEnabled, setShaderParam, setShaderParamKeys } from '../src/core/shader-commands';
import { SlotRT, ShaderHost } from '../src/render/shader-host';
import { TEST_EFFECT_FEATURES, TEST_EFFECT_MAIN, TEST_FILL_FEATURES, TEST_FILL_MAIN } from './shader-fixtures';
import { TOOLS } from '../src/agent/tools';
import { editor } from '../src/app/editor';
import { createProject } from '../src/core/model';

const fillAsset = () => makeShaderAsset({ id: 'test-stripes', kind: 'fill', files: { 'main.ts': TEST_FILL_MAIN, 'features.json': TEST_FILL_FEATURES } });
const fxAsset = () => makeShaderAsset({ id: 'test-invert', kind: 'effect', version: 'abcdef0123456789', files: { 'main.ts': TEST_EFFECT_MAIN, 'features.json': TEST_EFFECT_FEATURES } });

describe('shader schema', () => {
  it('parses defineProperties without running the module', () => {
    const s = parseShaderSchema(TEST_FILL_MAIN)!;
    expect(s.map(p => [p.key, p.type])).toEqual([['color', 'color'], ['speed', 'number'], ['transform', 'point-angle-radius']]);
    expect(s[1]).toMatchObject({ control: 'slider', min: 0, max: 4, step: 0.01 });
    const e = parseShaderSchema(TEST_EFFECT_MAIN)!;
    expect(e.find(p => p.key === 'mode')!.options!.map(o => o.value)).toEqual(['all', 'green']);
    expect(e.find(p => p.key === 'amount')!.unit).toBe('%');
  });

  it('tolerates comments, trailing commas, single quotes, unitLabel and rejects code', () => {
    const src = `defineProperties(Effect, {
      // a comment
      a: { type: 'number', label: "A", defaultValue: -1.5e1, unitLabel: '%', }, /* block */
      'b-c': { type: "boolean", defaultValue: true },
    })`;
    const s = parseShaderSchema(src)!;
    expect(s.map(p => p.key)).toEqual(['a', 'b-c']);
    expect(s[0]).toMatchObject({ defaultValue: -15, unit: '%' });
    expect(parseShaderSchema('defineProperties(Effect, { a: makeIt() })')).toBeNull();
    expect(parseShaderSchema('no schema here')).toBeNull();
  });

  it('features and asset metadata', () => {
    const a = fillAsset();
    expect(a.name).toBe('Test stripes');
    expect(a.features.isAnimated).toBe(true);
    expect(a.params.length).toBe(3);
  });
});

describe('param values <-> numbers', () => {
  const d = (type: string, extra: Partial<ShaderParamDef> = {}): ShaderParamDef => ({ key: 'k', label: 'K', type, defaultValue: undefined, ...extra });
  it('round-trips every param type', () => {
    const cases: [ShaderParamDef, unknown][] = [
      [d('number'), 12.5],
      [d('boolean'), true],
      [d('string', { control: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }), 'b'],
      [d('number', { control: 'select', options: [{ value: 0, label: 'X' }, { value: 3, label: 'Y' }] }), 3],
      [d('color'), { r: 0.1, g: 0.2, b: 0.3, a: 0.4 }],
      [d('point'), { x: 10, y: 20 }],
      [d('point-radius'), { x: 10, y: 20, radius: 5 }],
      [d('point-angle-radius'), { x: 10, y: 20, radius: 5, angle: 45 }],
      [d('point-point-line'), { x: 1, y: 2, x2: 3, y2: 4 }],
      [d('color-point'), { x: 1, y: 2, color: { r: 1, g: 0, b: 0, a: 1 } }],
      [d('gradient'), { stops: [{ position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 0, a: 0.5 } }] }],
    ];
    for (const [def, v] of cases) expect(unflattenValue(def, flattenValue(def, v))).toEqual(v);
    // figma passes string selects as { characters }
    expect(flattenValue(cases[2][0], { characters: 'b' })).toEqual([1]);
  });

  it('snaps interpolated selects to an option', () => {
    const def = d('number', { control: 'select', options: [{ value: 0, label: 'X' }, { value: 3, label: 'Y' }] });
    expect(unflattenValue(def, [1.2])).toBe(0);
    expect(unflattenValue(def, [2.2])).toBe(3);
  });

  it('prop keys', () => {
    expect(shaderPropKey('f0', 'dotSize')).toBe('sh:f0:dotSize');
    expect(parseShaderPropKey('sh:e1:a:b')).toEqual({ slot: 'e1', param: 'a:b' });
    expect(parseShaderPropKey('position')).toBeNull();
  });

  it('float hashing detects changes', () => {
    const a = new Float64Array([1, 2.5, -3]);
    const h = hashFloats(1, a);
    expect(hashFloats(1, a)).toBe(h);
    a[1] = 2.500001;
    expect(hashFloats(1, a)).not.toBe(h);
  });
});

describe('shader commands', () => {
  let s: Store;
  beforeEach(() => { s = new Store(); });

  it('adds a fill + effect, params are props, undo / redo restore everything', () => {
    const l = addLayer(s, 'rect', { w: 100, h: 50 });
    const f = addShader(s, [l.id], fillAsset())[l.id];
    const e = addShader(s, [l.id], fxAsset(), { values: { amount: 40 } })[l.id];
    expect(f).toBe('f0');
    expect(e).toBe('e0');
    expect(Object.keys(s.project.shaders!)).toEqual(['test-stripes', 'test-invert@abcdef012345']);
    expect(activeShaderFill(l)!.ref.slot).toBe('f0');
    expect(activeShaderEffects(l).map(r => r.slot)).toEqual(['e0']);
    expect(valueAt(l, 'sh:f0:color' as PropKey, 0)).toEqual([1, 0.4, 0.1, 1]);
    expect(valueAt(l, 'sh:e0:amount' as PropKey, 0)).toEqual([40]);
    expect(shaderPropKeys(s.project, l)).toEqual(['sh:f0:color', 'sh:f0:speed', 'sh:f0:transform', 'sh:e0:amount', 'sh:e0:mode', 'sh:e0:enabledFlag']);
    expect(shaderPropInfo(s.project, l, 'sh:f0:transform')!.label).toBe('Test stripes · Stripes');
    s.undo();
    expect(l.shaderEffects).toBeUndefined();
    expect(l.props['sh:e0:amount' as PropKey]).toBeUndefined();
    s.redo();
    expect(valueAt(l, 'sh:e0:amount' as PropKey, 0)).toEqual([40]);
    removeShader(s, l.id, 'f0');
    expect(shaderRefs(l).map(r => r.ref.slot)).toEqual(['e0']);
    expect(Object.keys(l.props).some(k => k.startsWith('sh:f0:'))).toBe(false);
    s.undo();
    expect(shaderRefs(l).map(r => r.ref.slot)).toEqual(['f0', 'e0']);
  });

  it('keyframes, eases, discrete holds, expressions on params', () => {
    const l = addLayer(s, 'rect', { w: 100, h: 50 });
    addShader(s, [l.id], fxAsset());
    setShaderParamKeys(s, l.id, 'e0', 'Amount', [{ t: 0, v: 0 }, { t: 1, v: 100 }], () => ({ interp: 'linear', out: [0, 0], in: [1, 1] }));
    expect(valueAt(l, 'sh:e0:amount' as PropKey, 0.5)[0]).toBeCloseTo(50);
    setShaderParamKeys(s, l.id, 'e0', 'mode', [{ t: 0, v: 'All channels' }, { t: 1, v: 'green' }]);
    const kf = l.props['sh:e0:mode' as PropKey]!.kf!;
    expect(kf.map(k => k.interp)).toEqual(['hold', 'hold']);
    expect(valueAt(l, 'sh:e0:mode' as PropKey, 0.99)).toEqual([0]);
    expect(valueAt(l, 'sh:e0:mode' as PropKey, 1)).toEqual([1]);
    // value edits on an animated param add keys (like any prop)
    s.setTime(0.5);
    setShaderParam(s, l.id, 'e0', 'amount', 10);
    expect(l.props['sh:e0:amount' as PropKey]!.kf!.length).toBe(3);
    // the generic keyframe commands work on shader keys
    addKeyframe(s, [l.id], 'sh:e0:amount' as PropKey, 0.75);
    expect(l.props['sh:e0:amount' as PropKey]!.kf!.length).toBe(4);
    deleteKeyframes(s, [keyId(l.id, 'sh:e0:amount' as PropKey, 3)]);
    expect(l.props['sh:e0:amount' as PropKey]!.kf!.length).toBe(3);
    setExpr(s, [l.id], 'sh:e0:amount' as PropKey, 'time * 10');
    expect(l.props['sh:e0:amount' as PropKey]!.expr).toBe('time * 10');
    expect(() => setShaderParam(s, l.id, 'e0', 'mode', 'nope')).toThrow(/not an option/);
    setShaderEnabled(s, l.id, 'e0', false);
    expect(activeShaderEffects(l)).toEqual([]);
  });

  it('effect chain order', () => {
    const l = addLayer(s, 'rect', { w: 100, h: 50 });
    addShader(s, [l.id], fxAsset());
    addShader(s, [l.id], fxAsset());
    expect(l.shaderEffects!.map(r => r.slot)).toEqual(['e0', 'e1']);
    moveShaderEffect(s, l.id, 'e1', -1);
    expect(l.shaderEffects!.map(r => r.slot)).toEqual(['e1', 'e0']);
  });

  it('a fill shader can not be an effect', () => {
    const l = addLayer(s, 'rect', { w: 100, h: 50 });
    expect(() => addShader(s, [l.id], fillAsset(), { kind: 'effect' })).toThrow(/fill shader/);
  });
});

describe('shader runtime (main thread)', () => {
  it('evaluates keyframed params into frame.params without allocating per eval', () => {
    const s = new Store();
    const l = addLayer(s, 'rect', { w: 100, h: 50 });
    addShader(s, [l.id], fillAsset());
    setShaderParamKeys(s, l.id, 'f0', 'transform', [{ t: 0, v: { x: 0, y: 50, radius: 10, angle: 0 } }, { t: 2, v: { x: 100, y: 50, radius: 30, angle: 90 } }], () => ({ interp: 'linear', out: [0, 0], in: [1, 1] }));
    const a = s.project.shaders!['test-stripes'];
    const rt = new SlotRT(l.paints![0].shader!, a, l, 'x', 1);
    rt.eval(1, 30, 5, 0);
    expect(rt.toParams()).toEqual({ color: { r: 1, g: 0.4, b: 0.1, a: 1 }, speed: 0, transform: { x: 50, y: 50, radius: 20, angle: 45 } });
    expect(rt.animated).toBe(true);
  });

  it('render budget: quantized and capped', () => {
    expect(ShaderHost.budget(100, 100, 1)).toBe(1);
    expect(ShaderHost.budget(100, 100, 1.1)).toBeCloseTo(Math.pow(2, 0.25));
    expect(ShaderHost.budget(4000, 4000, 2) * 4000).toBeLessThanOrEqual(2048 + 1e-6);
  });
});

describe('shader agent tools', () => {
  const tool = (n: string) => TOOLS.find(t => t.name === n)!;
  const run = async (n: string, a: any) => JSON.parse(((await tool(n).run(a))[0] as any).text.replace(/^[^{[]*/, '') || 'null');
  beforeEach(() => { editor.store.load(createProject()); });

  it('list / add / set / remove', async () => {
    const st = editor.store;
    const l = addLayer(st, 'rect', { w: 200, h: 100 });
    // library entries come with pastes; put one in directly
    addShader(st, [l.id], fxAsset());
    removeShader(st, l.id, 'e0');
    const add = await run('add_shader', { ids: [l.id], shader: 'Test invert', values: { Amount: 25, mode: 'Green only' } });
    expect(add.slots[l.id]).toBe('e0');
    const list = await run('list_shader_params', { ids: [l.id] });
    const sh = list.layers[0].shaders[0];
    expect(sh.name).toBe('Test invert');
    expect(sh.params.find((p: any) => p.key === 'amount').value).toBe(25);
    expect(sh.params.find((p: any) => p.key === 'mode').value).toBe('green');
    expect(list.library.map((x: any) => x.name)).toEqual(['Test invert']);
    const out = (await tool('set_shader_param').run({ id: l.id, slot: 'e0', param: 'amount', keyframes: [{ t: 0, v: 0, ease: 'Expo Out' }, { t: 1, v: 100, ease: 'spring:0.4' }] }))[0];
    expect((out as any).text).toMatch(/2 keyframes/);
    const kf = l.props['sh:e0:amount' as PropKey]!.kf!;
    expect(kf.map(k => k.v[0])).toEqual([0, 100]);
    expect(kf[1].interp).toBe('spring');
    await expect(Promise.resolve().then(() => tool('set_shader_param').run({ id: l.id, slot: 'e0', param: 'nope', value: 1 }))).rejects.toThrow(/params: amount/);
    await tool('remove_shader').run({ id: l.id, slot: 'e0' });
    expect(shaderRefs(l)).toEqual([]);
  });
});

// figma's own shaders: only from the local, gitignored cache (fetched with the figma mcp)
const cache = join(__dirname, '..', '.figma-cache');
const cached = existsSync(cache) ? readdirSync(cache).filter(d => existsSync(join(cache, d, 'main.ts'))) : [];
describe.skipIf(!cached.length)('figma shader library (local cache)', () => {
  it('every cached shader has a parseable schema with defaults that round-trip', () => {
    for (const d of cached) {
      const code = readFileSync(join(cache, d, 'main.ts'), 'utf8');
      const schema = parseShaderSchema(code);
      expect(schema, d).not.toBeNull();
      for (const def of schema!) {
        const f = flattenValue(def, undefined);
        expect(f.every(Number.isFinite), `${d} ${def.key}`).toBe(true);
        expect(flattenValue(def, unflattenValue(def, f))).toEqual(f);
      }
    }
  });
});
