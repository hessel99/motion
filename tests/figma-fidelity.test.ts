// figma paste fidelity: every paint / effect / stroke / text / vector feature, from synthetic node
// trees (tests/fixtures/figma-synth.ts builds them; no real figma content).
import { describe, it, expect } from 'vitest';
import { figmaMessageToLayers } from '../src/import/figma/convert';
import { parseFigmaClipboard, setFigmaShaderHooks, lastPaste, buildCaptureFiles } from '../src/import/figma';
import { EffectEval, effectList, hasEffects } from '../src/render/effects';
import { applyImageFilters, cellHash, displayText } from '../src/render/raster';
import { textSig, type Layer } from '../src/core/model';
import { g, tr, solid, stops, rgba, pathBlob, fakePng, synthMessage, synthClipboardHtml } from './fixtures/figma-synth';

const conv = (nodes: any[], blobs: Uint8Array[] = [], opts = {}) => figmaMessageToLayers(synthMessage(nodes, blobs), opts);
const byName = (ls: Layer[], n: string) => { const l = ls.find(x => x.name === n); if (!l) throw new Error('no layer ' + n); return l; };
const rect = (id: number, name: string, extra: any = {}) => ({ guid: g(id), type: 'RECTANGLE', name, size: { x: 100, y: 50 }, transform: tr(0, 0), fillPaints: [solid(1, 0, 0)], ...extra });
const apply = (m: number[], x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

describe('figma fidelity: paints', () => {
  it('angular and diamond gradients keep their type and transform', () => {
    const t = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
    const r = conv([
      rect(10, 'Ang', { fillPaints: [{ type: 'GRADIENT_ANGULAR', visible: true, opacity: 1, stops: stops([0, 1, 0, 0, 1], [1, 0, 0, 1, 1]), transform: t }] }),
      rect(11, 'Dia', { fillPaints: [{ type: 'GRADIENT_DIAMOND', visible: true, opacity: 0.5, stops: stops([0, 1, 1, 1, 1], [1, 0, 0, 0, 1]), transform: { ...t, m02: 0.25 } }] }),
    ]);
    const a = byName(r.layers, 'Ang').paints![0], d = byName(r.layers, 'Dia').paints![0];
    expect(a.type).toBe('angular');
    expect(a.stops!.length).toBe(2);
    expect(d.type).toBe('diamond');
    expect(d.opacity).toBe(0.5);
    // inverse of figma's matrix: gradient center (.5,.5) -> box (.25,.5)
    const c = apply(d.transform!, 0.5, 0.5);
    expect(c[0]).toBeCloseTo(0.25, 5);
    expect(c[1]).toBeCloseTo(0.5, 5);
  });

  it('stacked normal solids flatten into one animatable color; blended ones stay paints', () => {
    const r = conv([
      rect(10, 'Flat', { fillPaints: [solid(1, 0, 0), solid(0, 0, 1, 0.5)] }),
      rect(11, 'Blend', { fillPaints: [solid(1, 0, 0), solid(0, 0, 1, 1, { blendMode: 'MULTIPLY' })] }),
    ]);
    const f = byName(r.layers, 'Flat');
    expect(f.paints).toBeUndefined();
    expect(f.props.fill!.v[0]).toBeCloseTo(0.5, 5);
    expect(f.props.fill!.v[2]).toBeCloseTo(0.5, 5);
    expect(f.props.fill!.v[3]).toBeCloseTo(1, 5);
    const b = byName(r.layers, 'Blend');
    expect(b.paints!.map(p => p.type)).toEqual(['solid', 'solid']);
    expect(b.paints![1].blend).toBe('multiply');
  });

  it('image fills: scale modes, crop, rotation, tile scale, filters; plain images stay image layers', () => {
    const img = (extra: any) => ({ type: 'IMAGE', visible: true, opacity: 1, image: { dataBlob: 0, hash: new Uint8Array([1, 2]) }, ...extra });
    const r = conv([
      rect(10, 'Cover', { size: { x: 100, y: 50 }, fillPaints: [img({ imageScaleMode: 'FILL' })] }), // 40x40 image, 2:1 box: crops
      rect(11, 'Plain', { size: { x: 40, y: 40 }, fillPaints: [img({ imageScaleMode: 'FILL' })] }),
      rect(12, 'Fit', { fillPaints: [img({ imageScaleMode: 'FIT', rotation: 90 })] }),
      rect(13, 'Tile', { fillPaints: [img({ imageScaleMode: 'TILE', scale: 0.5 })] }),
      rect(14, 'Crop', { fillPaints: [img({ imageScaleMode: 'STRETCH', transform: { m00: 0.5, m01: 0, m02: 0.25, m10: 0, m11: 0.5, m12: 0.25 } })] }),
      { guid: g(15), type: 'ELLIPSE', name: 'Avatar', size: { x: 40, y: 40 }, transform: tr(0, 0), fillPaints: [img({ imageScaleMode: 'FILL', paintFilter: { exposure: 0.5, vibrance: -1, contrast: 0.2, temperature: 0.3, tint: -0.1, highlights: 0.4, shadows: -0.4 } })] },
    ], [fakePng(40, 40)]);
    expect(r.assets.length).toBe(1); // deduplicated by hash
    const cover = byName(r.layers, 'Cover');
    expect(cover.type).toBe('rect');
    expect(cover.paints![0]).toMatchObject({ type: 'image', scaleMode: 'fill', imageRef: r.assets[0].id });
    expect(byName(r.layers, 'Plain').type).toBe('image');
    expect(byName(r.layers, 'Fit').paints![0]).toMatchObject({ scaleMode: 'fit', rotation: 90 });
    expect(byName(r.layers, 'Tile').paints![0]).toMatchObject({ scaleMode: 'tile', tileScale: 0.5 });
    const crop = byName(r.layers, 'Crop').paints![0];
    expect(crop.scaleMode).toBe('stretch');
    // inverse: the unit image square lands on the box with a 2x zoom around the center
    expect(apply(crop.transform!, 0.25, 0.25)).toEqual([0, 0]);
    const av = byName(r.layers, 'Avatar');
    expect(av.type).toBe('ellipse');
    expect(av.paints![0].filters).toEqual({ exposure: 0.5, saturation: -1, contrast: expect.closeTo(0.2, 5), temperature: expect.closeTo(0.3, 5), tint: expect.closeTo(-0.1, 5), highlights: expect.closeTo(0.4, 5), shadows: expect.closeTo(-0.4, 5) });
  });

  it('image without bytes in the clipboard: grey placeholder + warning', () => {
    const r = conv([rect(10, 'Missing', { fillPaints: [{ type: 'IMAGE', visible: true, opacity: 1, image: { hash: new Uint8Array([9]) } }] })]);
    expect(byName(r.layers, 'Missing').props.fill!.v).toEqual([0.8, 0.8, 0.8, 1]);
    expect(r.design.warnings!.some(w => w.includes('image fill'))).toBe(true);
  });

  it('noise fill', () => {
    const r = conv([rect(10, 'Grain', { fillPaints: [solid(0, 0, 0), { type: 'NOISE', visible: true, opacity: 1, color: rgba(1, 1, 1, 0.3), noiseType: 'MONOTONE', density: 0.4, noiseSize: { x: 2, y: 2 } }] })]);
    const p = byName(r.layers, 'Grain').paints!;
    expect(p[1]).toMatchObject({ type: 'noise', noise: { mode: 'mono', size: 2, density: expect.closeTo(0.4, 5) } });
    expect(p[1].noise!.color![3]).toBeCloseTo(0.3, 5);
  });

  it('shader paints go to the shader hook (and are skipped with a warning without it)', () => {
    const node = rect(10, 'Shaded', { fillPaints: [{ type: 'SHADER', visible: true, opacity: 1, shaderData: { source: 'x' } }] });
    const none = conv([node]);
    expect(none.design.warnings!.some(w => w.includes('shader paint'))).toBe(true);
    const seen: any[] = [];
    const withHook = conv([node], [], { shaders: { convertShaderPaint: (p: any) => { seen.push(p); return { type: 'solid', color: [0, 1, 0, 1] }; } } });
    expect(seen.length).toBe(1);
    expect(seen[0].shaderData.source).toBe('x');
    expect(byName(withHook.layers, 'Shaded').props.fill!.v).toEqual([0, 1, 0, 1]);
  });

  it('gradient strokes become stroke paints', () => {
    const r = conv([rect(10, 'GS', { strokeWeight: 3, strokePaints: [{ type: 'GRADIENT_LINEAR', visible: true, opacity: 1, stops: stops([0, 1, 0, 0, 1], [1, 0, 1, 0, 1]), transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } }] })]);
    const l = byName(r.layers, 'GS');
    expect(l.strokePaints![0].type).toBe('linear');
    expect(l.props.strokeWidth!.v).toEqual([3]);
    expect(l.props.stroke!.v).toEqual([1, 0, 0, 1]);
  });

  it('vector regions with their own fills keep per-geometry paints', () => {
    const sq = pathBlob([[1, 0, 0], [2, 10, 0], [2, 10, 10], [0]]);
    const r = conv([{
      guid: g(10), type: 'VECTOR', name: 'Mark', size: { x: 20, y: 10 }, transform: tr(0, 0), fillPaints: [solid(0, 0, 0)],
      fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: 0, styleID: 0 }, { windingRule: 'NONZERO', commandsBlob: 0, styleID: 3 }],
      vectorData: { styleOverrideTable: [{ guid: g(99), styleID: 3, fillPaints: [solid(0, 0.5, 1)] }] },
    }], [sq]);
    const l = byName(r.layers, 'Mark');
    expect(l.geometry![0].paints).toBeUndefined();
    expect(l.geometry![1].paints![0].color).toEqual([0, 0.5, 1, 1]);
  });
});

describe('figma fidelity: effects', () => {
  const shadow = (extra: any = {}) => ({ type: 'DROP_SHADOW', visible: true, color: rgba(0, 0, 0, 0.3), offset: { x: 2, y: 6 }, radius: 12, spread: 4, ...extra });
  const r = conv([
    rect(10, 'Card', { effects: [shadow(), shadow({ offset: { x: 0, y: 1 }, radius: 2, spread: 0, showShadowBehindNode: true }), { type: 'INNER_SHADOW', visible: true, color: rgba(1, 1, 1, 0.5), offset: { x: 0, y: -2 }, radius: 3, spread: 1 }] }),
    rect(11, 'Blurry', { effects: [{ type: 'FOREGROUND_BLUR', visible: true, radius: 16, blurOpType: 'PROGRESSIVE', startOffset: { x: 0.5, y: 0 }, endOffset: { x: 0.5, y: 1 }, startRadius: 0 }] }),
    rect(12, 'Glassy', { fillPaints: [solid(1, 1, 1, 0.1)], effects: [{ type: 'BACKGROUND_BLUR', visible: true, radius: 20 }] }),
    rect(13, 'Noisy', { effects: [{ type: 'NOISE', visible: true, noiseType: 'DUOTONE', color: rgba(1, 0, 0, 1), secondaryColor: rgba(0, 0, 1, 1), density: 0.3, noiseSize: { x: 1.5, y: 1.5 }, seed: 4 }] }),
    rect(14, 'Hidden', { effects: [shadow({ visible: false })] }),
    rect(15, 'Glass', { effects: [{ type: 'GLASS', visible: true, refraction: 0.6, depth: 20, lightIntensity: 0.8, lightAngle: 30, dispersion: 0.2, frost: 8 }] }),
    rect(16, 'Rough', { effects: [{ type: 'TEXTURE', visible: true, radius: 3, noiseSize: { x: 4, y: 4 } }] }),
  ]);

  it('first drop shadow is animatable through layer props, further ones are static', () => {
    const l = byName(r.layers, 'Card');
    expect(l.props.shadowColor!.v[3]).toBeCloseTo(0.3, 5);
    expect(l.props.shadowOffset!.v).toEqual([2, 6]);
    expect(l.props.shadowBlur!.v).toEqual([12]);
    expect(l.props.shadowSpread!.v).toEqual([4]);
    expect(l.effects!.map(e => e.type)).toEqual(['dropShadow', 'dropShadow', 'innerShadow']);
    expect(l.effects![1]).toMatchObject({ offset: [0, 1], radius: 2, spread: 0, showBehind: true });
    expect(l.props.innerShadowOffset!.v).toEqual([0, -2]);
  });

  it('blurs (progressive, background), noise, glass, texture', () => {
    const b = byName(r.layers, 'Blurry');
    expect(b.props.blur!.v).toEqual([16]);
    expect(b.effects![0].progressive).toEqual({ start: [0.5, 0], end: [0.5, 1], startRadius: 0 });
    expect(byName(r.layers, 'Glassy').props.backgroundBlur!.v).toEqual([20]);
    const n = byName(r.layers, 'Noisy');
    expect(n.effects![0].noise).toMatchObject({ mode: 'duo', size: 1.5, seed: 4 });
    expect(n.props.noiseDensity!.v[0]).toBeCloseTo(30, 4);
    expect(n.props.noiseColor!.v).toEqual([1, 0, 0, 1]);
    const gl = byName(r.layers, 'Glass').effects![0];
    expect(gl.type).toBe('glass');
    expect(gl.params!.refraction).toBeCloseTo(0.6, 5);
    expect(gl.params!.frost).toBe(8);
    expect(byName(r.layers, 'Rough').effects![0]).toMatchObject({ type: 'texture', radius: 3 });
    expect(r.design.warnings!.some(w => w.startsWith('glass effect'))).toBe(true);
  });

  it('hidden effects are kept but not live', () => {
    const l = byName(r.layers, 'Hidden');
    expect(l.effects![0].visible).toBe(false);
    expect(l.props.shadowColor).toBeUndefined();
    expect(hasEffects(l)).toBe(false);
  });

  it('effect evaluation: keyframed props, static extras, implicit effects, padding', () => {
    const l = structuredClone(byName(r.layers, 'Card'));
    l.props.shadowBlur = { v: [0], kf: [
      { t: 0, v: [0], interp: 'linear', out: [0, 0], in: [1, 1] },
      { t: 1, v: [20], interp: 'linear', out: [0, 0], in: [1, 1] },
    ] };
    const ev = new EffectEval(l, k => l.props[k]);
    expect(ev.animated).toBe(true);
    const at = ev.at(0.5);
    expect(at[0].radius).toBeCloseTo(10, 5);
    expect(at[0].offset).toEqual([2, 6]);
    expect(at[1].radius).toBe(2); // second shadow: its own static value
    expect(at[2].type).toBe('innerShadow');
    expect(ev.padding(at)).toBeGreaterThan(10 * 1.5);
    // an agent can add a shadow by setting props only
    const plain = byName(r.layers, 'Hidden');
    const p2 = { ...plain, effects: undefined, props: { ...plain.props, shadowColor: { v: [0, 0, 0, 0.5] }, shadowBlur: { v: [8] } } };
    expect(hasEffects(p2)).toBe(true);
    expect(effectList(p2).map(e => e.type)).toEqual(['dropShadow']);
    const e2 = new EffectEval(p2, k => p2.props[k]).at(0)[0];
    expect(e2.radius).toBe(8);
    expect(e2.color[3]).toBe(0.5);
  });

  it('shader effects go to the hook', () => {
    const seen: any[] = [];
    const res = conv([rect(10, 'S', { effects: [{ type: 'SHADER', visible: true, shaderData: { source: 'y' } }] })], [], { shaders: { convertShaderEffect: (e: any) => { seen.push(e); return { type: 'layerBlur', radius: 3 }; } } });
    expect(seen.length).toBe(1);
    expect(byName(res.layers, 'S').effects).toEqual([{ type: 'layerBlur', radius: 3 }]);
  });
});

describe('figma fidelity: strokes, corners, blend, masks', () => {
  const r = conv([
    rect(10, 'Dashed', { strokeWeight: 2, strokePaints: [solid(0, 0, 0)], strokeAlign: 'OUTSIDE', dashPattern: [6, 3], strokeCap: 'ROUND', strokeJoin: 'BEVEL', miterLimit: 8 }),
    rect(11, 'Sides', { strokeWeight: 1, strokePaints: [solid(0, 0, 0)], borderStrokeWeightsIndependent: true, borderTopWeight: 0, borderRightWeight: 2, borderBottomWeight: 4, borderLeftWeight: 2 }),
    rect(12, 'Squircle', { cornerRadius: 20, cornerSmoothing: 0.6 }),
    rect(13, 'Over', { blendMode: 'OVERLAY' }),
    rect(14, 'Mul', { blendMode: 'MULTIPLY' }),
    rect(15, 'Pass', { blendMode: 'PASS_THROUGH' }),
    rect(16, 'LumMask', { mask: true, maskType: 'LUMINANCE' }),
    rect(17, 'VecMask', { mask: true, maskType: 'OUTLINE' }),
  ]);
  it('dashes, caps, joins, miter, align', () => {
    expect(byName(r.layers, 'Dashed')).toMatchObject({ dash: [6, 3], strokeCap: 'round', strokeJoin: 'bevel', miterLimit: 8, strokeAlign: 'outside' });
  });
  it('per-side stroke weights', () => {
    expect(byName(r.layers, 'Sides').strokeSides).toEqual([0, 2, 4, 2]);
  });
  it('corner smoothing', () => {
    const l = byName(r.layers, 'Squircle');
    expect(l.smoothing).toBeCloseTo(0.6, 5);
    expect(l.props.radius!.v).toEqual([20, 20, 20, 20]);
  });
  it('every figma blend mode maps (pass-through = none)', () => {
    expect(byName(r.layers, 'Over').blend).toBe('overlay');
    expect(byName(r.layers, 'Mul').blend).toBe('multiply');
    expect(byName(r.layers, 'Pass').blend).toBeUndefined();
  });
  it('mask types', () => {
    expect(byName(r.layers, 'LumMask')).toMatchObject({ mask: true, maskType: 'luminance' });
    expect(byName(r.layers, 'VecMask')).toMatchObject({ mask: true, maskType: 'vector' });
  });
});

describe('figma fidelity: text', () => {
  // glyph "outlines": a 1em square per glyph (em units, y up)
  const glyph = pathBlob([[1, 0, 0], [2, 0.5, 0], [2, 0.5, 0.7], [2, 0, 0.7], [0]]);
  const text = (extra: any) => ({
    guid: g(10), type: 'TEXT', name: 'T', size: { x: 200, y: 40 }, transform: tr(0, 0), fillPaints: [solid(0, 0, 0)],
    fontSize: 20, fontName: { family: 'Brand Sans', style: 'Bold', postscript: '' }, ...extra,
  });

  it('style runs, decoration, spacing, case, alignment, truncation, lists, features, axes', () => {
    const r = conv([text({
      textData: {
        characters: 'Hello world\nsecond', characterStyleIDs: [0, 0, 0, 0, 0, 0, 5, 5, 5, 5, 5],
        styleOverrideTable: [{ guid: g(90), styleID: 5, fontName: { family: 'Brand Sans', style: 'Regular Italic', postscript: '' }, fillPaints: [solid(1, 0, 0)], textDecoration: 'UNDERLINE' }],
        lines: [{ lineType: 'UNORDERED_LIST' }, { lineType: 'PLAIN' }],
      },
      textAlignHorizontal: 'JUSTIFIED', textAlignVertical: 'CENTER', textCase: 'TITLE', textDecoration: 'STRIKETHROUGH',
      paragraphSpacing: 8, paragraphIndent: 4, textAutoResize: 'HEIGHT', textTruncation: 'ENDING', maxLines: 2,
      toggledOnOTFeatures: ['SS01', 'TNUM'], toggledOffOTFeatures: ['LIGA'],
      fontVariations: [{ axisTag: 0x77676874, axisName: 'Weight', value: 650 }],
    })]);
    const t = byName(r.layers, 'T').text!;
    expect(t.runs).toEqual([{ start: 6, end: 11, fontWeight: 400, fontStyle: 'italic', fill: [1, 0, 0, 1], decoration: 'underline' }]);
    expect(t).toMatchObject({ align: 'justify', valign: 'center', textCase: 'title', decoration: 'strike', paragraphSpacing: 8, paragraphIndent: 4, autoResize: 'height', truncate: true, maxLines: 2 });
    expect(t.features).toEqual(['ss01', 'tnum', '-liga']);
    expect(t.variations).toEqual({ wght: 650 });
    expect(t.lists).toEqual(['ul', null]);
    expect(t.content).toBe('Hello world\nsecond'); // case is applied when drawn
    expect(displayText(t)).toBe('Hello World\nSecond');
  });

  it("keeps figma's glyph outlines (per style fill, decorations) while the text is unchanged", () => {
    const r = conv([text({
      textData: { characters: 'Hi', characterStyleIDs: [0, 7], styleOverrideTable: [{ guid: g(90), styleID: 7, fillPaints: [solid(0, 0, 1)] }] },
      derivedTextData: {
        glyphs: [
          { commandsBlob: 0, position: { x: 0, y: 20 }, fontSize: 20, firstCharacter: 0, styleID: 0 },
          { commandsBlob: 0, position: { x: 12, y: 20 }, fontSize: 20, firstCharacter: 1, styleID: 7 },
        ],
        decorations: [{ rects: [{ x: 0, y: 22, w: 24, h: 1 }], styleID: 0 }],
      },
    })], [glyph]);
    const l = byName(r.layers, 'T');
    const ol = l.text!.outline!;
    expect(ol.sig).toBe(textSig(l.text!, l.props.size!.v));
    expect(ol.groups.map(gr => gr.fill)).toEqual([null, [0, 0, 1, 1]]);
    // glyph 1: (0,0)-(0.5,0.7) em at size 20, y up, baseline at 20
    const cmds = ol.groups[0].geometry[0].cmds;
    expect(cmds[0]).toEqual(['M', 0, 20]);
    expect(cmds[2][1]).toBeCloseTo(10, 4);
    expect(cmds[2][2]).toBeCloseTo(6, 4);
    // the underline rect is part of the base style's geometry
    expect(cmds.filter(c => c[0] === 'M').length).toBe(2);
    // editing the text invalidates the outline (live layout takes over)
    expect(textSig({ ...l.text!, content: 'Ho' }, l.props.size!.v)).not.toBe(ol.sig);
  });

  it('ignores stale glyphs (instance text overridden without new layout)', () => {
    const r = conv([text({
      textData: { characters: 'A much longer override' },
      derivedTextData: { glyphs: [{ commandsBlob: 0, position: { x: 0, y: 20 }, fontSize: 20, firstCharacter: 0 }] },
    })], [glyph]);
    expect(byName(r.layers, 'T').text!.outline).toBeUndefined();
  });

  it('gradient text fills become paints', () => {
    const r = conv([text({ textData: { characters: 'Grad' }, fillPaints: [{ type: 'GRADIENT_LINEAR', visible: true, opacity: 1, stops: stops([0, 1, 0, 0, 1], [1, 0, 0, 1, 1]), transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } }] })]);
    const l = byName(r.layers, 'T');
    expect(l.paints![0].type).toBe('linear');
    expect(l.props.fill!.v).toEqual([1, 0, 0, 1]);
  });
});

describe('figma fidelity: components', () => {
  it('component properties (text, visibility) resolve on instances', () => {
    const r = conv([
      { guid: g(20), type: 'SYMBOL', name: 'Btn', parentIndex: { guid: g(2), position: '!' }, size: { x: 80, y: 20 }, transform: tr(0, 0) },
      { guid: g(21), type: 'TEXT', name: 'Label', parentIndex: { guid: g(20), position: '!' }, size: { x: 80, y: 20 }, transform: tr(0, 0), textData: { characters: 'Default' }, fontSize: 12, componentPropRefs: [{ defID: g(500), componentPropNodeField: 'TEXT_DATA' }] },
      { guid: g(22), type: 'RECTANGLE', name: 'Icon', parentIndex: { guid: g(20), position: '"' }, size: { x: 10, y: 10 }, transform: tr(0, 0), componentPropRefs: [{ defID: g(501), componentPropNodeField: 'VISIBLE' }] },
      { guid: g(30), type: 'INSTANCE', name: 'Btn 1', size: { x: 80, y: 20 }, transform: tr(0, 0), symbolData: { symbolID: g(20), symbolOverrides: [] },
        componentPropAssignments: [{ defID: g(500), value: { textValue: { characters: 'Buy now' } } }, { defID: g(501), value: { boolValue: false } }] },
    ]);
    const inst = byName(r.layers, 'Btn 1');
    const kids = inst.children.map(id => r.layers.find(l => l.id === id)!);
    expect(kids[0].text!.content).toBe('Buy now');
    expect(kids[1].visible).toBe(false);
  });
});

describe('figma fidelity: helpers', () => {
  it('image filters move pixels the expected way', () => {
    const px = () => new Uint8ClampedArray([128, 128, 128, 255, 200, 60, 40, 255]);
    const ex = px(); applyImageFilters(ex, { exposure: 0.5 });
    expect(ex[0]).toBeGreaterThan(128);
    const de = px(); applyImageFilters(de, { saturation: -1 });
    expect(Math.abs(de[4] - de[5])).toBeLessThan(2); // grey
    const warm = px(); applyImageFilters(warm, { temperature: 1 });
    expect(warm[0]).toBeGreaterThan(warm[2]);
    const ct = px(); applyImageFilters(ct, { contrast: 1 });
    expect(ct[4]).toBeGreaterThan(200);
  });
  it('grain hash is deterministic and uniform-ish', () => {
    let sum = 0;
    for (let i = 0; i < 1000; i++) { const v = cellHash(i % 37, (i / 37) | 0, 3); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); sum += v; }
    expect(sum / 1000).toBeGreaterThan(0.4);
    expect(sum / 1000).toBeLessThan(0.6);
    expect(cellHash(5, 6, 1)).toBe(cellHash(5, 6, 1));
  });
});

describe('figma paste capture', () => {
  it('remembers the last paste and builds a capture file that pastes the same again', () => {
    const html = synthClipboardHtml([rect(10, 'Captured', { effects: [{ type: 'DROP_SHADOW', visible: true, color: rgba(0, 0, 0, 0.2), offset: { x: 0, y: 2 }, radius: 4 }] })]);
    const a = parseFigmaClipboard(html)!;
    expect(lastPaste()!.html).toBe(html);
    const f = buildCaptureFiles()!;
    expect(f.name).toMatch(/^figma-paste-\d{8}-\d{6}\.figcapture\.json$/);
    const cap = JSON.parse(f.text);
    expect(cap.format).toBe('motion-figma-capture');
    expect(cap.decoded.nodeChanges.some((n: any) => n.name === 'Captured')).toBe(true);
    const b = parseFigmaClipboard(cap.html)!;
    expect(b.layers.map(l => l.name)).toEqual(a.layers.map(l => l.name));
    expect(byName(b.layers, 'Captured').props.shadowBlur!.v).toEqual([4]);
  });
  it('shader hooks can be swapped at runtime', () => {
    let n = 0;
    setFigmaShaderHooks({ convertShaderPaint: () => { n++; return null; } });
    parseFigmaClipboard(synthClipboardHtml([rect(10, 'S', { fillPaints: [{ type: 'SHADER', visible: true, opacity: 1, shaderData: { source: 'z' } }] })]));
    setFigmaShaderHooks(undefined);
    expect(n).toBe(1);
  });
});
