// second fidelity round (measured against figma / chromium renders with scripts/figma-fidelity.mjs):
// svg clip / mask / css / spread / patterns / dashes / filters, figma auto line height, normal-group
// isolation, image filter curves
import { describe, it, expect } from 'vitest';
import { svgToLayers } from '../src/import/svg';
import { figmaMessageToLayers } from '../src/import/figma/convert';
import { applyImageFilters } from '../src/render/raster';
import { g, tr, solid, synthMessage } from './fixtures/figma-synth';
import type { Layer } from '../src/core/model';

const svg = (body: string) => svgToLayers(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">${body}</svg>`);
const named = (ls: Layer[], n: string) => ls.find(l => l.name === n)!;

describe('svg import, round 2', () => {
  it('clip-path and mask become vector / luminance mask layers', () => {
    const r = svg('<defs><clipPath id="c"><circle cx="50" cy="50" r="40"/></clipPath><mask id="m"><rect width="100" height="100" fill="#fff"/></mask></defs><rect id="a" width="100" height="100" fill="red" clip-path="url(#c)"/><rect id="b" width="10" height="10" mask="url(#m)"/>');
    const masks = r.layers.filter(l => l.mask);
    expect(masks.map(m => m.maskType).sort()).toEqual(['luminance', 'vector']);
    const a = named(r.layers, 'a');
    const host = r.layers.find(l => l.id === a.parent)!;
    expect(host.children[0]).toBe(masks.find(m => m.maskType === 'vector')!.id); // mask below the content
  });
  it('css: id, compound, child selectors, specificity and !important', () => {
    const r = svg('<style>#x { fill: #00ff00 } rect.c { fill: #0000ff } g.k > circle { fill: #ff00ff } .d { fill: red !important }</style><rect id="x" width="1" height="1" fill="black"/><rect id="y" class="c" width="1" height="1"/><g class="k"><circle id="z" r="1"/></g><rect id="w" class="d" width="1" height="1" style="fill:blue"/>');
    expect(named(r.layers, 'x').props.fill!.v).toEqual([0, 1, 0, 1]);
    expect(named(r.layers, 'y').props.fill!.v).toEqual([0, 0, 1, 1]);
    expect(named(r.layers, 'z').props.fill!.v).toEqual([1, 0, 1, 1]);
    expect(named(r.layers, 'w').props.fill!.v).toEqual([1, 0, 0, 1]);
  });
  it('spreadMethod repeat expands the stops over the covered periods', () => {
    const r = svg('<defs><linearGradient id="g" x2="0.25" spreadMethod="repeat"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect id="r" width="100" height="100" fill="url(#g)"/>');
    expect(named(r.layers, 'r').paints![0].stops!.length).toBe(8);
  });
  it('patterns become tiled svg image paints', () => {
    const r = svg('<defs><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="10" fill="#f00"/></pattern></defs><rect id="r" width="100" height="100" fill="url(#p)"/>');
    const p = named(r.layers, 'r').paints![0];
    expect(p).toMatchObject({ type: 'image', scaleMode: 'tile' });
    expect(r.assets[0].mime).toBe('image/svg+xml');
  });
  it('dashes, caps, joins, filters, named colors', () => {
    const r = svg('<defs><filter id="f"><feDropShadow dx="2" dy="3" stdDeviation="4" flood-opacity=".5"/></filter></defs><path id="p" d="M0 0 L50 0" stroke="rebeccapurple" stroke-width="2" stroke-dasharray="4 2" stroke-linecap="round" filter="url(#f)"/>');
    const l = named(r.layers, 'p');
    expect(l.dash).toEqual([4, 2]);
    expect(l.strokeCap).toBe('round');
    expect(l.props.stroke!.v[0]).toBeCloseTo(0x66 / 255, 3);
    expect(l.props.shadowBlur!.v).toEqual([8]);
    expect(l.props.shadowOffset!.v).toEqual([2, 3]);
  });
});

describe('figma round 2', () => {
  it('auto line height is flagged (font metrics decide it when drawn)', () => {
    const r = figmaMessageToLayers(synthMessage([{ guid: g(10), type: 'TEXT', name: 'T', size: { x: 100, y: 20 }, transform: tr(0, 0), fillPaints: [solid(0, 0, 0)], textData: { characters: 'x' }, fontSize: 20, lineHeight: { value: 100, units: 'PERCENT' } }]));
    expect(r.layers[0].text!.lineHeightAuto).toBe(true);
  });
  it('a NORMAL group with blending children isolates them', () => {
    const r = figmaMessageToLayers(synthMessage([
      { guid: g(10), type: 'GROUP', name: 'G', size: { x: 10, y: 10 }, transform: tr(0, 0), blendMode: 'NORMAL' },
      { guid: g(11), type: 'RECTANGLE', name: 'R', parentIndex: { guid: g(10), position: '!' }, size: { x: 10, y: 10 }, transform: tr(0, 0), fillPaints: [solid(1, 0, 0)], blendMode: 'MULTIPLY' },
    ]));
    expect(named(r.layers, 'G').isolate).toBe(true);
  });
  it('image filters: brighter, flatter and less saturated like figma for its test values', () => {
    const px = new Uint8ClampedArray([200, 60, 40, 255, 40, 80, 160, 255]);
    applyImageFilters(px, { exposure: 0.3, contrast: 0.4, saturation: -0.6, temperature: 0.5, tint: 0.3, highlights: -0.4, shadows: 0.5 });
    const lum = (o: number) => 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
    expect(lum(0)).toBeGreaterThan(110);
    expect(lum(4)).toBeGreaterThan(110);
    expect(Math.max(px[0], px[1], px[2]) - Math.min(px[0], px[1], px[2])).toBeLessThan(110);
  });
});
