// figma paste with variables, styles and components (field names as in figma's kiwi schema:
// Paint.colorVar.value.alias = VariableID {guid, assetRef{key}}, NodeChange.styleIdForFill = StyleId,
// VARIABLE / VARIABLE_SET nodes with variableDataValues / variableSetModes, SYMBOL.componentKey).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { figmaMessageToLayers } from '../src/import/figma/convert';
import { parseFigmaClipboard } from '../src/import/figma';
import { Store } from '../src/core/store';
import { insertLayer, setProp } from '../src/core/commands';
import { importFigmaDesign } from '../src/core/design-import';
import { instancesOf } from '../src/core/components';
import { setTokenMode } from '../src/core/tokens';
import type { Layer } from '../src/core/model';

const g = (localID: number, sessionID = 1) => ({ sessionID, localID });
const tr = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const solid = (r: number, gg: number, b: number, extra: any = {}) => ({ type: 'SOLID', color: { r, g: gg, b, a: 1 }, opacity: 1, visible: true, ...extra });
const alias = (key: string, localID: number) => ({ value: { alias: { guid: g(localID, 9), assetRef: { key, version: '1' } } }, dataType: 'ALIAS', resolvedDataType: 'COLOR' });

function message(primary = { r: 0.2, g: 0.4, b: 1 }) {
  const nodes: any[] = [
    { guid: g(0), type: 'DOCUMENT' },
    { guid: g(1), type: 'CANVAS', parentIndex: { guid: g(0), position: '!' } },
    { guid: g(2), type: 'CANVAS', internalOnly: true, parentIndex: { guid: g(0), position: '"' } },
    // variable collection with two modes + one color variable
    { guid: g(10, 9), type: 'VARIABLE_SET', name: 'Theme', key: 'SETKEY', variableSetModes: [{ id: g(1, 7), name: 'Light' }, { id: g(2, 7), name: 'Dark' }], parentIndex: { guid: g(2), position: '#' } },
    { guid: g(11, 9), type: 'VARIABLE', name: 'Brand/Primary', key: 'VARKEY', variableSetID: { guid: g(10, 9) }, variableResolvedType: 'COLOR', parentIndex: { guid: g(2), position: '$' },
      variableDataValues: { entries: [
        { modeID: g(1, 7), variableData: { value: { colorValue: { ...primary, a: 1 } }, dataType: 'COLOR' } },
        { modeID: g(2, 7), variableData: { value: { colorValue: { r: 0.9, g: 0.9, b: 1, a: 1 } }, dataType: 'COLOR' } },
      ] } },
    // a color style definition (hidden node on the internal canvas)
    { guid: g(12), type: 'ROUNDED_RECTANGLE', name: 'Text/Muted', key: 'STYLEKEY', styleType: 'FILL', visible: false, parentIndex: { guid: g(2), position: '%' }, size: { x: 100, y: 100 }, fillPaints: [solid(0.5, 0.5, 0.5)] },
    // component definition: Button (frame) with a background rect and a label
    { guid: g(20), type: 'SYMBOL', name: 'Button', componentKey: 'BTNKEY', parentIndex: { guid: g(2), position: '&' }, size: { x: 120, y: 40 }, transform: tr(0, 0), fillPaints: [] },
    { guid: g(21), type: 'ROUNDED_RECTANGLE', name: 'bg', parentIndex: { guid: g(20), position: '!' }, size: { x: 120, y: 40 }, transform: tr(0, 0), cornerRadius: 8,
      fillPaints: [solid(primary.r, primary.g, primary.b, { colorVar: alias('VARKEY', 11) })] },
    { guid: g(22), type: 'TEXT', name: 'label', parentIndex: { guid: g(20), position: '"' }, size: { x: 100, y: 20 }, transform: tr(10, 10), textData: { characters: 'Buy' }, fontSize: 14,
      fillPaints: [solid(0.5, 0.5, 0.5)], styleIdForFill: { assetRef: { key: 'STYLEKEY', version: '1' } } },
    // the selection: a frame with two instances (the second overrides the label text)
    { guid: g(30), type: 'FRAME', name: 'Screen', parentIndex: { guid: g(1), position: '!' }, size: { x: 400, y: 300 }, transform: tr(0, 0), fillPaints: [solid(1, 1, 1)] },
    { guid: g(31), type: 'INSTANCE', name: 'Button', parentIndex: { guid: g(30), position: '!' }, size: { x: 120, y: 40 }, transform: tr(20, 20), symbolData: { symbolID: g(20) } },
    { guid: g(32), type: 'INSTANCE', name: 'Button', parentIndex: { guid: g(30), position: '"' }, size: { x: 120, y: 40 }, transform: tr(20, 100),
      symbolData: { symbolID: g(20), symbolOverrides: [{ guidPath: { guids: [g(22)] }, textData: { characters: 'Sell' } }] } },
  ];
  return { nodeChanges: nodes, blobs: [] };
}

function paste(s: Store, msg: any) {
  const res = figmaMessageToLayers(msg);
  const byId = new Map(res.layers.map(l => [l.id, l]));
  let out: ReturnType<typeof importFigmaDesign> | null = null;
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
    out = importFigmaDesign(s, tx, all, res.design);
  });
  return { res, out: out! };
}

describe('figma paste: variables, styles, components', () => {
  it('reads variable and style references with names and modes', () => {
    const r = figmaMessageToLayers(message());
    const names = r.design.tokens.map(t => t.name).sort();
    expect(names).toEqual(['Brand/Primary', 'Text/Muted']);
    const brand = r.design.tokens.find(t => t.name === 'Brand/Primary')!;
    expect(Object.keys(brand.values)).toEqual(['Light', 'Dark']);
    expect(r.design.mode).toBe('Light');
    expect(r.design.refs.filter(x => x.prop === 'fill').length).toBeGreaterThanOrEqual(4); // bg + label in 2 instances (+ definition)
    expect(r.design.instances.map(i => i.key)).toEqual(['BTNKEY', 'BTNKEY']);
    expect(r.design.defs.map(d => d.name)).toEqual(['Button']);
    // the style definition node and variables are not layers
    expect(r.layers.some(l => l.name === 'Text/Muted' || l.name === 'Brand/Primary')).toBe(false);
  });

  it('links pasted layers, creates the main component and instances with overrides (one undo step)', () => {
    const s = new Store();
    const { res, out } = paste(s, message());
    expect(out.linked).toBeGreaterThan(0);
    expect(out.components).toBe(1);
    expect(out.instances).toBe(2);
    const P = s.project;
    const mainId = Object.keys(P.components!)[0];
    expect(P.components![mainId]).toMatchObject({ name: 'Button', figmaKey: 'BTNKEY' });
    expect(Object.values(P.comps).some(c => c.name === 'Components' && c.root.includes(mainId))).toBe(true);
    const insts = instancesOf(P, mainId);
    expect(insts.length).toBe(2);
    const second = P.layers[res.design.instances[1].layer];
    const label2 = P.layers[second.children[1]];
    expect(label2.link!.ov).toEqual(['text']);
    const brand = Object.values(P.tokens!.items).find(t => t.name === 'Brand/Primary')!;
    const bg = P.layers[second.children[0]];
    expect(bg.props.fill!.bind).toBe(brand.id);
    expect(P.tokens!.modes).toEqual(['Light', 'Dark']);

    // the main changes: both instances follow, the overridden text stays
    const mainBg = P.layers[P.layers[mainId].children[0]];
    setProp(s, mainBg.id, 'radius', [20, 20, 20, 20]);
    for (const id of insts) expect(P.layers[P.layers[id].children[0]].props.radius!.v).toEqual([20, 20, 20, 20]);
    // switching to dark updates everything linked
    setTokenMode(s, 'Dark');
    expect(bg.props.fill!.v.slice(0, 3).map(x => Math.round(x * 10) / 10)).toEqual([0.9, 0.9, 1]);

    s.undo(); s.undo(); s.undo();
    expect(Object.keys(P.layers).length).toBe(0);
    expect(P.components?.[mainId]).toBeUndefined();
  });

  it('pasting again links to the same component and syncs changed library colors', () => {
    const s = new Store();
    paste(s, message());
    const { out } = paste(s, message({ r: 1, g: 0, b: 0 }));
    expect(out.components).toBe(0); // reuses the main
    expect(out.instances).toBe(2);
    expect(out.synced).toBe('1 color changed');
    const brand = Object.values(s.project.tokens!.items).find(t => t.name === 'Brand/Primary')!;
    expect(brand.values.Light).toEqual([1, 0, 0, 1]);
    // the layers from the FIRST paste follow the new library value
    for (const l of Object.values(s.project.layers)) if (l.props.fill?.bind === brand.id) expect(l.props.fill.v).toEqual([1, 0, 0, 1]);
    expect(instancesOf(s.project, Object.keys(s.project.components!)[0]).length).toBe(4);
  });

  const real = '/tmp/figma-format-parse/packages/fig-kiwi/data/2025.html';
  it.skipIf(!existsSync(real))('real clipboard (2025 format): color styles and components come through', () => {
    const r = parseFigmaClipboard(readFileSync(real, 'utf8'))!;
    expect(r.design.tokens.some(t => t.name === 'Heading' && t.kind === 'figma-style')).toBe(true);
    expect(r.design.refs.length).toBeGreaterThan(0);
    expect(r.design.defs.length).toBeGreaterThan(0);
    const s = new Store();
    const byId = new Map(r.layers.map(l => [l.id, l]));
    s.transact('paste', tx => {
      for (const id of r.roots) {
        const extra: Layer[] = [];
        const walk = (ids: string[]) => { for (const c of ids) { const k = byId.get(c)!; extra.push(k); walk(k.children); } };
        walk(byId.get(id)!.children);
        insertLayer(s, tx, byId.get(id)!, null, undefined, extra);
      }
      const all = new Map(byId);
      for (const l of r.design.defLayers) all.set(l.id, l);
      const o = importFigmaDesign(s, tx, all, r.design);
      expect(o.instances).toBeGreaterThan(0);
    });
  });
});
