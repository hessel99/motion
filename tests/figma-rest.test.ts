import { describe, it, expect } from 'vitest';
import { parsePathData, encodeCommandsBlob, pluginNodesToMessage, restNodesToMessage, handlesToGradientTransform } from '../src/import/figma/rest';
import { decodeCommandsBlob, figmaMessageToLayers } from '../src/import/figma/convert';

const solid = (r: number, g: number, b: number, opacity = 1) => ({ type: 'SOLID', visible: true, opacity, blendMode: 'NORMAL', color: { r, g, b } });

describe('figma json (plugin / REST) -> kiwi-like message', () => {
  it('parses path data and round-trips through a commandsBlob', () => {
    const cmds = parsePathData('M0 0 L400 0 Q 10 20 30 40 C1 2 3 4 5 6 Z');
    expect(cmds.map(c => c[0]).join('')).toBe('MLQCZ');
    expect(decodeCommandsBlob(encodeCommandsBlob(cmds))).toEqual([['M', 0, 0], ['L', 400, 0], ['Q', 10, 20, 30, 40], ['C', 1, 2, 3, 4, 5, 6], ['Z']]);
    // relative + shorthand commands become absolute
    expect(parsePathData('m10 10 h5 v5 l-5 0 z')).toEqual([['M', 10, 10], ['L', 15, 10], ['L', 15, 15], ['L', 10, 15], ['Z']]);
  });

  it('converts a plugin dump frame with children, gradient, stroke and effects', () => {
    const frame = {
      id: '1:1', type: 'FRAME', name: 'paint/test', width: 400, height: 300, relativeTransform: [[1, 0, 1360], [0, 1, 80]], clipsContent: true,
      fills: [solid(1, 1, 1)], strokes: [], effects: [],
      children: [
        { id: '1:2', type: 'RECTANGLE', name: 'r', width: 300, height: 220, relativeTransform: [[1, 0, 50], [0, 1, 40]], cornerRadius: 12,
          fills: [{ type: 'GRADIENT_LINEAR', visible: true, opacity: 1, gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] }],
          strokes: [solid(0, 0, 0)], strokeWeight: 4, strokeAlign: 'INSIDE', dashPattern: [4, 2],
          effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0 }, { type: 'LAYER_BLUR', blurType: 'PROGRESSIVE', visible: true, radius: 10, startRadius: 0, startOffset: { x: 0.5, y: 0 }, endOffset: { x: 0.5, y: 1 } }] },
        { id: '1:3', type: 'VECTOR', name: 'v', width: 80, height: 70, relativeTransform: [[1, 0, 10], [0, 1, 10]], fills: [solid(0, 1, 0)], strokes: [],
          fillGeometry: [{ windingRule: 'EVENODD', data: 'M 40 0 L 80 70 L 0 70 Z' }] },
        { id: '1:4', type: 'TEXT', name: 't', width: 200, height: 40, relativeTransform: [[1, 0, 0], [0, 1, 200]], characters: 'Hello world', fontSize: 'MIXED', fontName: 'MIXED', fills: 'MIXED', lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PERCENT', value: 0 },
          segments: [{ start: 0, end: 5, fontName: { family: 'Inter', style: 'Bold' }, fontSize: 30, fills: [solid(1, 0, 0)] }, { start: 5, end: 11, fontName: { family: 'Inter', style: 'Regular' }, fontSize: 20, fills: [solid(0, 0, 0)] }] },
      ],
    };
    const msg = pluginNodesToMessage([frame]);
    const kids = msg.nodeChanges.filter(n => n.type === 'RECTANGLE');
    expect(kids[0].effects.map((e: any) => e.type)).toEqual(['DROP_SHADOW', 'FOREGROUND_BLUR']);
    expect(kids[0].effects[1].blurOpType).toBe('PROGRESSIVE');
    expect(kids[0].dashPattern).toEqual([4, 2]);
    const text = msg.nodeChanges.find(n => n.type === 'TEXT');
    expect(text.textData.characterStyleIDs.slice(0, 6)).toEqual([1, 1, 1, 1, 1, 2]);
    const res = figmaMessageToLayers(msg);
    expect(res.roots.length).toBe(1);
    const root = res.layers.find(l => l.id === res.roots[0])!;
    expect(root.props.position!.v).toEqual([200, 150]); // root moved to the origin
    expect(res.layers.map(l => l.type).sort()).toEqual(['group', 'path', 'rect', 'text']);
    const path = res.layers.find(l => l.type === 'path')!;
    expect(path.geometry?.[0].fillRule).toBe('evenodd');
    expect(res.layers.find(l => l.type === 'rect')!.paints?.[0].type).toBe('linear');
  });

  it('REST gradient handles map to the same transform as the plugin api', () => {
    // a left -> right linear gradient across the box: handles (0,.5) (1,.5) (0,1)
    const t = handlesToGradientTransform('GRADIENT_LINEAR', [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }]);
    expect(t[0].map(v => Math.round(v * 1e6) / 1e6 + 0)).toEqual([1, 0, 0]);
    expect(t[1].map(v => Math.round(v * 1e6) / 1e6 + 0)).toEqual([0, 1, 0]);
    const msg = restNodesToMessage([{ type: 'FRAME', name: 'f', size: { x: 100, y: 50 }, relativeTransform: [[1, 0, 5], [0, 1, 5]], fills: [], children: [
      { type: 'TEXT', name: 't', size: { x: 90, y: 20 }, relativeTransform: [[1, 0, 0], [0, 1, 0]], characters: 'Hi', fills: [solid(0, 0, 0)], style: { fontFamily: 'Inter', fontStyle: 'Bold', fontSize: 16, textAlignHorizontal: 'LEFT', letterSpacing: 0, lineHeightUnit: 'INTRINSIC_%' } },
    ] }]);
    const res = figmaMessageToLayers(msg);
    const t2 = res.layers.find(l => l.type === 'text')!;
    expect(t2.text!.fontWeight).toBe(700);
    expect(t2.text!.content).toBe('Hi');
  });
});
