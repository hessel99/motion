// a synthetic figma paste with one of every rendering feature (visual check, stress harness input):
//   npx vite-node tests/fixtures/figma-fidelity-scene.ts -- out.html
//   URL=http://localhost:5173/ node scripts/figma-paste-shot.mjs out.html shot.png
import { writeFileSync } from 'node:fs';
import { g, tr, solid, stops, rgba, pathBlob, synthClipboardHtml } from './figma-synth';

const T = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const grad = (type: string, s = stops([0, 1, 0.3, 0.2, 1], [0.5, 1, 0.9, 0.2, 1], [1, 0.2, 0.4, 1, 1]), transform = T) => ({ type, visible: true, opacity: 1, stops: s, transform });

export function fidelityScene(): string {
  const star = pathBlob([[1, 50, 0], [2, 61, 35], [2, 98, 35], [2, 68, 57], [2, 79, 91], [2, 50, 70], [2, 21, 91], [2, 32, 57], [2, 2, 35], [2, 39, 35], [0]]);
  const glyph = pathBlob([[1, 0, 0], [2, 0.55, 0], [2, 0.55, 0.72], [2, 0, 0.72], [0], [1, 0.12, 0.12], [2, 0.12, 0.6], [2, 0.43, 0.6], [2, 0.43, 0.12], [0]]);
  const F = (id: number) => ({ guid: g(200 + id), parentIndex: { guid: g(100), position: String.fromCharCode(33 + id) } });
  const cell = (id: number, col: number, row: number, extra: any) => ({ ...F(id), type: 'RECTANGLE', name: `cell${id}`, size: { x: 160, y: 110 }, transform: tr(30 + col * 190, 30 + row * 150), fillPaints: [solid(0.95, 0.95, 0.97)], ...extra });
  const nodes: any[] = [
    { guid: g(100), type: 'FRAME', name: 'Fidelity', size: { x: 1000, y: 650 }, transform: tr(0, 0), fillPaints: [grad('GRADIENT_LINEAR', stops([0, 0.1, 0.1, 0.2, 1], [1, 0.2, 0.1, 0.35, 1]), { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 })],
      effects: [{ type: 'NOISE', visible: true, noiseType: 'MONOTONE', color: rgba(1, 1, 1, 0.12), density: 0.5, noiseSize: { x: 1, y: 1 } }] },
    cell(1, 0, 0, { name: 'angular', fillPaints: [grad('GRADIENT_ANGULAR')] }),
    cell(2, 1, 0, { name: 'diamond', fillPaints: [grad('GRADIENT_DIAMOND')] }),
    cell(3, 2, 0, { name: 'shadow', cornerRadius: 16, fillPaints: [solid(1, 1, 1)], effects: [
      { type: 'DROP_SHADOW', visible: true, color: rgba(0, 0, 0, 0.45), offset: { x: 0, y: 10 }, radius: 24, spread: 4 },
      { type: 'INNER_SHADOW', visible: true, color: rgba(0.2, 0.4, 1, 0.6), offset: { x: 0, y: -4 }, radius: 6, spread: 0 }] }),
    cell(4, 3, 0, { name: 'squircle', cornerRadius: 40, cornerSmoothing: 0.6, fillPaints: [solid(0.3, 0.8, 0.5)], strokeWeight: 3, strokePaints: [solid(0, 0, 0)], strokeAlign: 'INSIDE' }),
    cell(5, 4, 0, { name: 'dashed', fillPaints: [], strokeWeight: 3, strokePaints: [grad('GRADIENT_LINEAR')], dashPattern: [10, 6], strokeCap: 'ROUND', strokeAlign: 'CENTER', cornerRadius: 12 }),
    cell(6, 0, 1, { name: 'blur', fillPaints: [grad('GRADIENT_RADIAL')], effects: [{ type: 'FOREGROUND_BLUR', visible: true, radius: 12 }] }),
    cell(7, 1, 1, { name: 'progressive', fillPaints: [grad('GRADIENT_LINEAR')], effects: [{ type: 'FOREGROUND_BLUR', visible: true, radius: 24, blurOpType: 'PROGRESSIVE', startOffset: { x: 0.5, y: 0 }, endOffset: { x: 0.5, y: 1 }, startRadius: 0 }] }),
    { ...F(8), type: 'ELLIPSE', name: 'dot under glass', size: { x: 90, y: 90 }, transform: tr(420, 190), fillPaints: [solid(1, 0.5, 0)] },
    cell(9, 2, 1, { name: 'bg blur', cornerRadius: 20, fillPaints: [solid(1, 1, 1, 0.15)], effects: [{ type: 'BACKGROUND_BLUR', visible: true, radius: 16 }], strokeWeight: 1, strokePaints: [solid(1, 1, 1, 0.5)] }),
    cell(10, 3, 1, { name: 'sides', fillPaints: [solid(1, 1, 0.9)], strokeWeight: 1, strokePaints: [solid(0.8, 0.1, 0.1)], borderStrokeWeightsIndependent: true, borderTopWeight: 0, borderRightWeight: 2, borderBottomWeight: 8, borderLeftWeight: 2 }),
    cell(11, 4, 1, { name: 'noise duo', fillPaints: [solid(0.2, 0.2, 0.25)], effects: [{ type: 'NOISE', visible: true, noiseType: 'DUOTONE', color: rgba(1, 0.4, 0.2, 0.9), secondaryColor: rgba(0.1, 0.2, 0.9, 0.6), density: 0.35, noiseSize: { x: 3, y: 3 } }] }),
    cell(12, 0, 2, { name: 'overlay', fillPaints: [solid(1, 0.5, 0.2)], blendMode: 'OVERLAY' }),
    cell(13, 1, 2, { name: 'difference', fillPaints: [solid(1, 1, 1)], blendMode: 'DIFFERENCE' }),
    { ...F(14), type: 'VECTOR', name: 'mark', size: { x: 100, y: 100 }, transform: tr(420, 330), fillPaints: [grad('GRADIENT_ANGULAR')], fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: 0, styleID: 0 }],
      effects: [{ type: 'DROP_SHADOW', visible: true, color: rgba(1, 0.6, 0, 0.8), offset: { x: 0, y: 0 }, radius: 16, spread: 0 }] },
    cell(15, 3, 2, { name: 'noise fill', fillPaints: [solid(0.1, 0.5, 0.9), { type: 'NOISE', visible: true, opacity: 1, color: rgba(1, 1, 1, 0.5), noiseType: 'MONOTONE', density: 0.3, noiseSize: { x: 2, y: 2 } }] }),
    cell(16, 4, 2, { name: 'texture', fillPaints: [solid(0.9, 0.3, 0.5)], cornerRadius: 30, effects: [{ type: 'TEXTURE', visible: true, radius: 4, noiseSize: { x: 3, y: 3 } }] }),
    { ...F(17), type: 'TEXT', name: 'logotype', size: { x: 400, y: 60 }, transform: tr(30, 500), fillPaints: [solid(1, 1, 1)], fontSize: 48, fontName: { family: 'Not Installed Sans', style: 'Black', postscript: '' },
      textData: { characters: 'MOTION', characterStyleIDs: [0, 0, 0, 3, 3, 3], styleOverrideTable: [{ guid: g(900), styleID: 3, fillPaints: [solid(1, 0.6, 0.1)] }] },
      derivedTextData: { glyphs: [0, 1, 2, 3, 4, 5].map(i => ({ commandsBlob: 1, position: { x: i * 34, y: 50 }, fontSize: 48, firstCharacter: i, styleID: i >= 3 ? 3 : 0 })), decorations: [{ rects: [{ x: 0, y: 56, w: 200, h: 3 }], styleID: 0 }] } },
    { ...F(18), type: 'TEXT', name: 'live text', size: { x: 420, y: 90 }, transform: tr(450, 490), fillPaints: [grad('GRADIENT_LINEAR')], fontSize: 22, fontName: { family: 'Inter', style: 'Bold', postscript: '' },
      textData: { characters: 'gradient text with an underline run\nand a second paragraph that truncates after two lines of text for sure', characterStyleIDs: [], lines: [{ lineType: 'UNORDERED_LIST' }, { lineType: 'PLAIN' }] },
      textCase: 'TITLE', paragraphSpacing: 6, textTruncation: 'ENDING', maxLines: 3 },
  ];
  return synthClipboardHtml(nodes, [star, glyph]);
}

const out = process.argv.find(a => a.endsWith('.html'));
if (out) { writeFileSync(out, fidelityScene()); console.log('wrote', out); }
