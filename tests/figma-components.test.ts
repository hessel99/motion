// figma component sets + component properties -> an animated component (core/figma-components.ts).
// field names as in figma's kiwi schema: SYMBOL.componentPropDefs {id, name, type, initialValue},
// node.componentPropRefs {defID, componentPropNodeField}, INSTANCE.componentPropAssignments {defID, value},
// a component set is a FRAME with isStateGroup whose SYMBOL children are named "Theme=Dark".
import { describe, it, expect } from 'vitest';
import { figmaMessageToLayers } from '../src/import/figma/convert';
import { Store } from '../src/core/store';
import { insertLayer } from '../src/core/commands';
import { importFigmaDesign } from '../src/core/design-import';
import { promoteToMotionComponent } from '../src/core/figma-components';
import { resolvedLayers, instanceComp } from '../src/core/motion-components';
import type { Layer } from '../src/core/model';

const g = (localID: number, sessionID = 1) => ({ sessionID, localID });
const tr = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const solid = (r: number, gg: number, b: number) => ({ type: 'SOLID', color: { r, g: gg, b, a: 1 }, opacity: 1, visible: true });
const defs = [{ id: g(1, 50), name: 'Label#1:0', type: 'TEXT', initialValue: { textValue: { characters: 'Hello' } } }, { id: g(2, 50), name: 'Show icon#1:1', type: 'BOOL', initialValue: { boolValue: true } }];

function symbol(id: number, name: string, key: string, bg: number[], pos: string) {
  return [
    { guid: g(id), type: 'SYMBOL', name, componentKey: key, parentIndex: { guid: g(5), position: pos }, size: { x: 200, y: 60 }, transform: tr(0, 0), fillPaints: [], componentPropDefs: defs },
    { guid: g(id + 1), type: 'ROUNDED_RECTANGLE', name: 'bg', parentIndex: { guid: g(id), position: '!' }, size: { x: 200, y: 60 }, transform: tr(0, 0), fillPaints: [solid(bg[0], bg[1], bg[2])] },
    { guid: g(id + 2), type: 'TEXT', name: 'label', parentIndex: { guid: g(id), position: '"' }, size: { x: 150, y: 24 }, transform: tr(40, 18), textData: { characters: 'Hello' }, fontSize: 16, fillPaints: [solid(1, 1, 1)],
      componentPropRefs: [{ defID: g(1, 50), componentPropNodeField: 'TEXT_DATA' }] },
    { guid: g(id + 3), type: 'ELLIPSE', name: 'icon', parentIndex: { guid: g(id), position: '#' }, size: { x: 20, y: 20 }, transform: tr(12, 20), fillPaints: [solid(1, 0.5, 0)],
      componentPropRefs: [{ defID: g(2, 50), componentPropNodeField: 'VISIBLE' }] },
  ];
}

function message() {
  return {
    blobs: [],
    nodeChanges: [
      { guid: g(0), type: 'DOCUMENT' },
      { guid: g(1), type: 'CANVAS', parentIndex: { guid: g(0), position: '!' } },
      { guid: g(2), type: 'CANVAS', internalOnly: true, parentIndex: { guid: g(0), position: '"' } },
      { guid: g(5), type: 'FRAME', name: 'Chip', isStateGroup: true, key: 'SETKEY', parentIndex: { guid: g(2), position: '!' }, size: { x: 500, y: 200 }, transform: tr(0, 0) },
      ...symbol(20, 'Theme=Light', 'LIGHT', [0.9, 0.9, 0.9], '!'),
      ...symbol(30, 'Theme=Dark', 'DARK', [0.1, 0.1, 0.1], '"'),
      { guid: g(40), type: 'FRAME', name: 'Screen', parentIndex: { guid: g(1), position: '!' }, size: { x: 600, y: 400 }, transform: tr(0, 0), fillPaints: [solid(1, 1, 1)] },
      { guid: g(41), type: 'INSTANCE', name: 'Chip', parentIndex: { guid: g(40), position: '!' }, size: { x: 200, y: 60 }, transform: tr(20, 20), symbolData: { symbolID: g(20) },
        componentPropAssignments: [{ defID: g(1, 50), value: { textValue: { characters: 'Design' } } }] },
      { guid: g(42), type: 'INSTANCE', name: 'Chip', parentIndex: { guid: g(40), position: '"' }, size: { x: 200, y: 60 }, transform: tr(20, 120), symbolData: { symbolID: g(30) },
        componentPropAssignments: [{ defID: g(1, 50), value: { textValue: { characters: 'Motion' } } }, { defID: g(2, 50), value: { boolValue: false } }] },
    ],
  };
}

function paste(s: Store, msg: any) {
  const res = figmaMessageToLayers(msg);
  const byId = new Map(res.layers.map(l => [l.id, l]));
  s.transact('Paste from Figma', tx => {
    for (const id of res.roots) {
      const l = byId.get(id)!;
      const extra: Layer[] = [];
      const walk = (ids: string[]) => { for (const c of ids) { const k = byId.get(c)!; extra.push(k); walk(k.children); } };
      walk(l.children);
      insertLayer(s, tx, l, null, undefined, extra);
    }
    const all = new Map(byId);
    for (const l of res.design.defLayers) all.set(l.id, l);
    importFigmaDesign(s, tx, all, res.design);
  });
  return res;
}

describe('figma components -> animated components', () => {
  it('reads component properties, bound layers, set variant values and instance values', () => {
    const r = figmaMessageToLayers(message());
    const light = r.design.defs.find(d => d.key === 'LIGHT')!;
    expect(light.meta!.props.map(p => [p.name, p.type, p.targets.map(t => t.field)])).toEqual([['Label#1:0', 'TEXT', ['text']], ['Show icon#1:1', 'BOOL', ['visible']]]);
    expect(light.meta!.set).toEqual({ key: 'SETKEY', name: 'Chip', values: { Theme: 'Light' } });
    expect(Object.values(r.design.instances[1].values!)).toEqual(['Motion', false]);
  });

  it('promote: properties, the set as variants, instances keep their values; later pastes arrive as instances', () => {
    const s = new Store();
    paste(s, message());
    const mains = Object.entries(s.project.components!);
    expect(mains.map(([, c]) => c.figmaSet?.values.Theme).sort()).toEqual(['Dark', 'Light']);
    const lightMain = mains.find(([, c]) => c.figmaKey === 'LIGHT')![0];
    const comp = promoteToMotionComponent(s, lightMain);
    expect(comp.name).toBe('Chip');
    expect(comp.component!.props!.map(p => [p.name, p.kind])).toEqual([['Label', 'text'], ['Show icon', 'toggle']]);
    expect(comp.component!.variants!.map(v => `${v.group}=${v.name}`)).toEqual(['Theme=Dark']);
    // both legacy components are gone, the instances are precomp instances now
    expect(Object.keys(s.project.components!)).toHaveLength(0);
    const insts = Object.values(s.project.layers).filter(l => instanceComp(s.project, l));
    expect(insts).toHaveLength(2);
    const dark = insts.find(l => l.inst?.variants)!;
    const rl = [...resolvedLayers(s.project, dark).values()];
    expect(rl.find(l => l.name === 'label')!.text!.content).toBe('Motion');
    expect(rl.find(l => l.name === 'icon')!.visible).toBe(false);
    expect(rl.find(l => l.name === 'bg')!.props.fill!.v[0]).toBeCloseTo(0.1); // the dark variant's background
    const light = insts.find(l => !l.inst?.variants)!;
    expect([...resolvedLayers(s.project, light).values()].find(l => l.name === 'label')!.text!.content).toBe('Design');
    // paste again: the light instance arrives as an instance of the animated component
    paste(s, message());
    const after = Object.values(s.project.layers).filter(l => instanceComp(s.project, l));
    expect(after.length).toBe(3);
    // one undo step for the promote
    s.undo(); s.undo();
    expect(Object.keys(s.project.components!)).toHaveLength(2);
  });
});
