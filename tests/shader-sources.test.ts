// editor side of figma shader sources (src/app/shader-sources.ts): a pasted shader without code is a
// placeholder whose figma values wait in ref.init; the fetched / imported source fills the library
// entry and rebuilds the params, outside the undo history. plus the mouse prop of mouse-driven shaders.
import { describe, it, expect } from 'vitest';
import { Store } from '../src/core/store';
import { addLayer } from '../src/core/commands';
import type { PropKey } from '../src/core/model';
import { makeShaderAsset, MOUSE_PARAM, shaderRefs, type ShaderParamDef } from '../src/core/shaders';
import { addShader } from '../src/core/shader-commands';
import { applySource, shaderSources, sourceRequest } from '../src/app/shader-sources';
import { SlotRT } from '../src/render/shader-host';
import { TEST_FILL_FEATURES, TEST_FILL_MAIN, TEST_MOUSE_FEATURES, TEST_MOUSE_MAIN } from './shader-fixtures';

const SHA = 'b'.repeat(40);
// what a figma paste without source knows: names and types from propertyMetadata
const metaParams: ShaderParamDef[] = [
  { key: 'speed', type: 'number', label: 'speed', defaultValue: 0 },
  { key: 'transform', type: 'point-angle-radius', label: 'transform', defaultValue: { x: 50, y: 50, radius: 20, angle: 0 } },
];

function pastedPlaceholder() {
  const s = new Store();
  const l = addLayer(s, 'rect', { x: 0, y: 0, w: 100, h: 50 });
  const ph = makeShaderAsset({ id: '9f3c2a', name: 'Test stripes', kind: 'fill', version: SHA, files: {}, params: metaParams });
  const slot = addShader(s, [l.id], ph)[l.id];
  const ref = shaderRefs(s.project.layers[l.id]).find(r => r.ref.slot === slot)!.ref;
  ref.init = { speed: 2, transform: { x: 10, y: 20, radius: 5, angle: 30 } };
  return { s, l: s.project.layers[l.id], slot, key: ref.shader };
}

describe('figma shader sources (editor)', () => {
  it('asks the bridge by hash + build version, kind, name and params', () => {
    const { s, key } = pastedPlaceholder();
    expect(sourceRequest(s.project.shaders![key])).toEqual({ hash: '9f3c2a', version: SHA, kind: 'fill', name: 'Test stripes', params: ['speed', 'transform'] });
    const uuid = makeShaderAsset({ id: '78022e92-625e-4131-af68-e527f73488a5', kind: 'effect', files: {} });
    expect(sourceRequest(uuid)).toMatchObject({ id: uuid.id, name: undefined });
    expect(shaderSources.missing(s).map(m => m.key)).toEqual([key]);
  });

  it('a fetched source fills the entry and the params, keeps figma values, adds no undo step', () => {
    const { s, l, slot, key } = pastedPlaceholder();
    const steps = s.historyLength;
    const touched = applySource(s, key, { id: 'uuid-x', name: 'Test stripes', kind: 'fill', version: SHA, files: { 'main.ts': TEST_FILL_MAIN, 'features.json': TEST_FILL_FEATURES } });
    expect(touched).toEqual([l.id]);
    const a = s.project.shaders![key];
    expect(a.files['main.ts']).toBe(TEST_FILL_MAIN);
    expect(a.id).toBe('9f3c2a'); // the id the document's refs know stays
    expect(a.params.map(p => p.key)).toEqual(['color', 'speed', 'transform']);
    expect(l.props[`sh:${slot}:speed` as PropKey]!.v).toEqual([2]);
    expect(l.props[`sh:${slot}:transform` as PropKey]!.v).toEqual([10, 20, 5, 30]);
    expect(l.props[`sh:${slot}:color` as PropKey]!.v.length).toBe(4);
    expect(shaderRefs(l)[0].ref.init).toBeUndefined();
    expect(s.historyLength).toBe(steps);
    expect(shaderSources.missing(s)).toEqual([]);
  });

  it('keeps keyframes the user added meanwhile', () => {
    const { s, l, slot, key } = pastedPlaceholder();
    l.props[`sh:${slot}:speed` as PropKey] = { v: [1], kf: [{ t: 0, v: [1] }, { t: 1, v: [3] }] } as never;
    applySource(s, key, { files: { 'main.ts': TEST_FILL_MAIN, 'features.json': TEST_FILL_FEATURES } });
    expect(l.props[`sh:${slot}:speed` as PropKey]!.kf!.length).toBe(2);
  });

  it('"Import shader…" fills the matching placeholder (by name / params)', () => {
    const { s, l, key } = pastedPlaceholder();
    const got = shaderSources.importFiles(s, { 'main.ts': TEST_FILL_MAIN, 'features.json': TEST_FILL_FEATURES });
    expect(got).toBe(key);
    expect(s.project.shaders![key].files['main.ts']).toBe(TEST_FILL_MAIN);
    expect(shaderSources.states.get(key)).toMatchObject({ state: 'done', via: 'import' });
    expect(shaderRefs(l)[0].ref.shader).toBe(key);
    // nothing to match: a new library entry
    const other = shaderSources.importFiles(s, { 'main.ts': TEST_FILL_MAIN.replace('Test stripes', 'X'), 'features.json': JSON.stringify({ name: 'Other' }) });
    expect(other).not.toBe(key);
    expect(s.project.shaders![other].name).toBe('Other');
  });
});

describe('mouse-driven shaders', () => {
  const mouse = () => makeShaderAsset({ id: 'test-mouse', kind: 'fill', files: { 'main.ts': TEST_MOUSE_MAIN, 'features.json': TEST_MOUSE_FEATURES } });
  it('get a keyframable mouse param (% of the layer) that never reaches the module', () => {
    const a = mouse();
    expect(a.params.map(p => p.key)).toEqual(['size', MOUSE_PARAM]);
    const s = new Store();
    const l = addLayer(s, 'rect', { x: 0, y: 0, w: 100, h: 100 });
    const slot = addShader(s, [l.id], a)[l.id];
    const L = s.project.layers[l.id];
    expect(L.props[`sh:${slot}:${MOUSE_PARAM}` as PropKey]!.v).toEqual([50, 50]);
    const ref = shaderRefs(L)[0].ref;
    const rt = new SlotRT(ref, s.project.shaders![ref.shader], L, 'i', 1);
    rt.eval(0, 30, 5, 0);
    expect(rt.mouseOff).toBe(1);
    expect(Object.keys(rt.toParams())).toEqual(['size']);
    expect(sourceRequest(a).params).toEqual(['size']);
    // shaders without usesMouse have none
    expect(makeShaderAsset({ id: 'x', kind: 'fill', files: { 'main.ts': TEST_FILL_MAIN, 'features.json': TEST_FILL_FEATURES } }).params.some(p => p.key === MOUSE_PARAM)).toBe(false);
  });
});
