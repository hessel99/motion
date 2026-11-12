import { parseSchema, compileSchema, encodeBinarySchema } from 'kiwi-schema';
import { deflateSync } from 'fflate';
import { parseFigmaClipboard } from '../src/import/figma';
import { extractFigmaBuffer, decodeFigKiwi, bytesToBase64, base64ToBytes } from '../src/import/figma/decode';
import { decodeCommandsBlob, figmaMessageToLayers } from '../src/import/figma/convert';
import type { Layer } from '../src/core/model';

// subset of figma's kiwi schema, using figma's field names (numbering is ours: real clipboards
// ship their own schema in chunk 0, so only names matter to the decoder).
const SCHEMA = `
package Figma;
enum MessageType { JOIN_START = 0; NODE_CHANGES = 1; }
enum NodeType { NONE = 0; DOCUMENT = 1; CANVAS = 2; GROUP = 3; FRAME = 4; BOOLEAN_OPERATION = 5; VECTOR = 6; STAR = 7; LINE = 8; ELLIPSE = 9; RECTANGLE = 10; REGULAR_POLYGON = 11; ROUNDED_RECTANGLE = 12; TEXT = 13; SLICE = 14; SYMBOL = 15; INSTANCE = 16; SECTION = 17; }
enum PaintType { SOLID = 0; GRADIENT_LINEAR = 1; GRADIENT_RADIAL = 2; GRADIENT_ANGULAR = 3; GRADIENT_DIAMOND = 4; IMAGE = 5; }
enum WindingRule { NONZERO = 0; ODD = 1; }
enum StrokeAlign { CENTER = 0; INSIDE = 1; OUTSIDE = 2; }
enum TextAlignHorizontal { LEFT = 0; CENTER = 1; RIGHT = 2; JUSTIFIED = 3; }
enum NumberUnits { RAW = 0; PIXELS = 1; PERCENT = 2; }
enum NodePhase { CREATED = 0; REMOVED = 1; }
struct GUID { uint sessionID; uint localID; }
struct Color { float r; float g; float b; float a; }
struct Vector { float x; float y; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
struct ColorStop { Color color; float position; }
message ParentIndex { GUID guid = 1; string position = 2; }
message Paint { PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; ColorStop[] stops = 5; Matrix transform = 6; }
message Path { WindingRule windingRule = 1; uint commandsBlob = 2; uint styleID = 3; }
message FontName { string family = 1; string style = 2; string postscript = 3; }
message TextData { string characters = 1; }
message Number { float value = 1; NumberUnits units = 2; }
message GUIDPath { GUID[] guids = 1; }
message SymbolData { GUID symbolID = 1; NodeChange[] symbolOverrides = 2; }
message NodeChange {
  GUID guid = 1; NodePhase phase = 2; ParentIndex parentIndex = 3; NodeType type = 4; string name = 5;
  bool visible = 6; float opacity = 7; Vector size = 8; Matrix transform = 9;
  Paint[] fillPaints = 10; Paint[] strokePaints = 11; float strokeWeight = 12; StrokeAlign strokeAlign = 13;
  float cornerRadius = 14; bool rectangleCornerRadiiIndependent = 15;
  float rectangleTopLeftCornerRadius = 16; float rectangleTopRightCornerRadius = 17;
  float rectangleBottomLeftCornerRadius = 18; float rectangleBottomRightCornerRadius = 19;
  TextData textData = 20; float fontSize = 21; FontName fontName = 22; TextAlignHorizontal textAlignHorizontal = 23;
  Number lineHeight = 24; Number letterSpacing = 25;
  Path[] fillGeometry = 26; Path[] strokeGeometry = 27; bool frameMaskDisabled = 28;
  SymbolData symbolData = 29; GUIDPath guidPath = 30; bool internalOnly = 31; bool resizeToFit = 32;
}
message Blob { byte[] bytes = 1; }
message Message { MessageType type = 1; NodeChange[] nodeChanges = 2; Blob[] blobs = 3; }
`;

const g = (localID: number) => ({ sessionID: 1, localID });
const tr = (x: number, y: number, deg = 0) => {
  const r = (deg * Math.PI) / 180;
  return { m00: Math.cos(r), m01: -Math.sin(r), m02: x, m10: Math.sin(r), m11: Math.cos(r), m12: y };
};
const solid = (r: number, gg: number, b: number, a = 1) => ({ type: 'SOLID', color: { r, g: gg, b, a }, opacity: 1, visible: true });

function pathBlob(cmds: [number, ...number[]][]): Uint8Array {
  let len = 0;
  for (const c of cmds) len += 1 + (c.length - 1) * 4;
  const out = new Uint8Array(len);
  const v = new DataView(out.buffer);
  let o = 0;
  for (const c of cmds) {
    out[o++] = c[0];
    for (let i = 1; i < c.length; i++) { v.setFloat32(o, c[i], true); o += 4; }
  }
  return out;
}

function buildMessage() {
  const tri = pathBlob([[1, 0, 0], [2, 40, 0], [4, 40, 10, 30, 30, 20, 30], [3, 10, 30, 0, 0], [0]]);
  const triStroke = pathBlob([[1, 0, 0], [2, 1, 0], [2, 1, 1], [0]]);
  const nodes: any[] = [
    { guid: g(0), type: 'DOCUMENT', name: 'Document' },
    { guid: g(1), type: 'CANVAS', name: 'Page 1', parentIndex: { guid: g(0), position: '!' } },
    { guid: g(2), type: 'CANVAS', name: 'Internal Only Canvas', internalOnly: true, parentIndex: { guid: g(0), position: '"' } },
    {
      guid: g(10), type: 'FRAME', name: 'Card', parentIndex: { guid: g(1), position: '!' },
      size: { x: 400, y: 300 }, transform: tr(100, 50), fillPaints: [solid(1, 1, 1)], cornerRadius: 12,
      strokePaints: [solid(0, 0, 0)], strokeWeight: 2, strokeAlign: 'INSIDE', visible: true, opacity: 1,
    },
    // children intentionally out of order: sorting by position must fix it
    {
      guid: g(13), type: 'TEXT', name: 'Title', parentIndex: { guid: g(10), position: '~' },
      size: { x: 200, y: 30 }, transform: tr(20, 20), fillPaints: [solid(0.1, 0.1, 0.1)],
      textData: { characters: 'Hello Figma' }, fontSize: 24, fontName: { family: 'Inter', style: 'Semi Bold Italic', postscript: '' },
      textAlignHorizontal: 'CENTER', lineHeight: { value: 36, units: 'PIXELS' }, letterSpacing: { value: 10, units: 'PERCENT' },
    },
    {
      guid: g(11), type: 'RECTANGLE', name: 'Box', parentIndex: { guid: g(10), position: 'a' },
      size: { x: 100, y: 50 }, transform: tr(10, 20, 90), opacity: 0.5,
      fillPaints: [solid(1, 0, 0), solid(0, 0, 1, 1), { ...solid(0, 1, 0), visible: false }],
      rectangleCornerRadiiIndependent: true, rectangleTopLeftCornerRadius: 1, rectangleTopRightCornerRadius: 2,
      rectangleBottomRightCornerRadius: 3, rectangleBottomLeftCornerRadius: 4,
    },
    {
      guid: g(12), type: 'ELLIPSE', name: 'Dot', parentIndex: { guid: g(10), position: 'b' },
      size: { x: 60, y: 60 }, transform: { m00: -1, m01: 0, m02: 260, m10: 0, m11: 1, m12: 100 },
      fillPaints: [{
        type: 'GRADIENT_LINEAR', opacity: 1, visible: true,
        stops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 }],
        // figma: box-normalized -> gradient space. here: a vertical gradient (top -> bottom)
        transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 },
      }],
    },
    {
      guid: g(14), type: 'VECTOR', name: 'Tri', parentIndex: { guid: g(10), position: 'c' }, visible: false,
      size: { x: 40, y: 30 }, transform: tr(300, 200), fillPaints: [solid(0, 1, 0)],
      strokePaints: [solid(0, 0, 0)], strokeWeight: 1, strokeAlign: 'CENTER',
      fillGeometry: [{ windingRule: 'ODD', commandsBlob: 0, styleID: 0 }],
      strokeGeometry: [{ windingRule: 'NONZERO', commandsBlob: 1, styleID: 0 }],
    },
    // component on the internal canvas + an instance of it on the page
    { guid: g(20), type: 'SYMBOL', name: 'Button', parentIndex: { guid: g(2), position: '!' }, size: { x: 80, y: 20 }, transform: tr(0, 0) },
    {
      guid: g(21), type: 'TEXT', name: 'Label', parentIndex: { guid: g(20), position: '!' }, size: { x: 80, y: 20 }, transform: tr(0, 0),
      textData: { characters: 'Default' }, fontSize: 12, fontName: { family: 'Roboto', style: 'Bold', postscript: '' },
    },
    {
      guid: g(30), type: 'INSTANCE', name: 'Button instance', parentIndex: { guid: g(1), position: '"' },
      size: { x: 80, y: 20 }, transform: tr(0, 500),
      symbolData: { symbolID: g(20), symbolOverrides: [{ guidPath: { guids: [g(21)] }, textData: { characters: 'Overridden' } }] },
    },
  ];
  return { type: 'NODE_CHANGES', nodeChanges: nodes, blobs: [{ bytes: tri }, { bytes: triStroke }] };
}

function buildClipboardHtml(opts: { escape?: boolean } = {}) {
  const schema = parseSchema(SCHEMA);
  const compiled = compileSchema(schema);
  const schemaBytes = deflateSync(encodeBinarySchema(schema));
  const msgBytes = deflateSync(compiled.encodeMessage(buildMessage()));
  const total = 12 + 4 + schemaBytes.length + 4 + msgBytes.length;
  const buf = new Uint8Array(total);
  buf.set(new TextEncoder().encode('fig-kiwi'), 0);
  const v = new DataView(buf.buffer);
  v.setUint32(8, 15, true);
  let o = 12;
  v.setUint32(o, schemaBytes.length, true); o += 4; buf.set(schemaBytes, o); o += schemaBytes.length;
  v.setUint32(o, msgBytes.length, true); o += 4; buf.set(msgBytes, o);
  const meta = bytesToBase64(new TextEncoder().encode(JSON.stringify({ fileKey: 'abc', pasteID: 1, dataType: 'scene' })));
  const b64 = bytesToBase64(buf);
  if (opts.escape) {
    return `<meta charset='utf-8'><span data-metadata="&lt;!--&#40;figmeta&#41;${meta}&#40;/figmeta&#41;--&gt;"></span><span data-buffer="&lt;!--&#40;figma&#41;${b64.replace(/=/g, '&#61;')}&#40;/figma&#41;--&gt;"></span>`;
  }
  return `<meta charset='utf-8'><span data-metadata="<!--(figmeta)${meta}(/figmeta)-->"></span><span data-buffer="<!--(figma)${b64}(/figma)-->"></span>`;
}

const byName = (layers: Layer[], name: string) => layers.find(l => l.name === name)!;


import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], buildClipboardHtml());
