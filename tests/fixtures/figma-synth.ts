// synthetic figma clipboard payloads, built programmatically (no real figma content, no figma code).
// the kiwi schema below is our own subset written with the field names of figma's clipboard format
// (the decoder reads whatever schema a payload ships, so only names matter, not numbering).
import { compileSchema, encodeBinarySchema, parseSchema } from 'kiwi-schema';
import { deflateSync } from 'fflate';
import { bytesToBase64 } from '../../src/import/figma/decode';

export const SYNTH_SCHEMA = `
package Figma;
enum MessageType { JOIN_START = 0; NODE_CHANGES = 1; }
enum NodeType { NONE = 0; DOCUMENT = 1; CANVAS = 2; GROUP = 3; FRAME = 4; BOOLEAN_OPERATION = 5; VECTOR = 6; STAR = 7; LINE = 8; ELLIPSE = 9; RECTANGLE = 10; REGULAR_POLYGON = 11; ROUNDED_RECTANGLE = 12; TEXT = 13; SLICE = 14; SYMBOL = 15; INSTANCE = 16; SECTION = 17; }
enum PaintType { SOLID = 0; GRADIENT_LINEAR = 1; GRADIENT_RADIAL = 2; GRADIENT_ANGULAR = 3; GRADIENT_DIAMOND = 4; IMAGE = 5; EMOJI = 6; VIDEO = 7; PATTERN = 8; NOISE = 9; SHADER = 10; }
enum BlendMode { PASS_THROUGH = 0; NORMAL = 1; DARKEN = 2; MULTIPLY = 3; LINEAR_BURN = 4; COLOR_BURN = 5; LIGHTEN = 6; SCREEN = 7; LINEAR_DODGE = 8; COLOR_DODGE = 9; OVERLAY = 10; SOFT_LIGHT = 11; HARD_LIGHT = 12; DIFFERENCE = 13; EXCLUSION = 14; HUE = 15; SATURATION = 16; COLOR = 17; LUMINOSITY = 18; }
enum ImageScaleMode { STRETCH = 0; FIT = 1; FILL = 2; TILE = 3; }
enum EffectType { INNER_SHADOW = 0; DROP_SHADOW = 1; FOREGROUND_BLUR = 2; BACKGROUND_BLUR = 3; REPEAT = 4; SYMMETRY = 5; GRAIN = 6; NOISE = 7; TEXTURE = 8; GLASS = 9; SHADER = 10; }
enum BlurOpType { NORMAL = 0; PROGRESSIVE = 1; }
enum NoiseType { MULTITONE = 0; MONOTONE = 1; DUOTONE = 2; }
enum WindingRule { NONZERO = 0; ODD = 1; }
enum StrokeAlign { CENTER = 0; INSIDE = 1; OUTSIDE = 2; }
enum StrokeCap { NONE = 0; ROUND = 1; SQUARE = 2; }
enum StrokeJoin { MITER = 0; BEVEL = 1; ROUND = 2; }
enum TextAlignHorizontal { LEFT = 0; CENTER = 1; RIGHT = 2; JUSTIFIED = 3; }
enum TextAlignVertical { TOP = 0; CENTER = 1; BOTTOM = 2; }
enum TextCase { ORIGINAL = 0; UPPER = 1; LOWER = 2; TITLE = 3; SMALL_CAPS = 4; SMALL_CAPS_FORCED = 5; }
enum TextDecoration { NONE = 0; UNDERLINE = 1; STRIKETHROUGH = 2; }
enum TextAutoResize { NONE = 0; WIDTH_AND_HEIGHT = 1; HEIGHT = 2; }
enum TextTruncation { DISABLED = 0; ENDING = 1; }
enum NumberUnits { RAW = 0; PIXELS = 1; PERCENT = 2; }
enum NodePhase { CREATED = 0; REMOVED = 1; }
enum MaskType { ALPHA = 0; OUTLINE = 1; LUMINANCE = 2; }
enum LineType { PLAIN = 0; ORDERED_LIST = 1; UNORDERED_LIST = 2; }
enum OpenTypeFeature { LIGA = 0; TNUM = 1; SS01 = 2; ZERO = 3; }
enum ComponentPropNodeField { VISIBLE = 0; TEXT_DATA = 1; OVERRIDDEN_SYMBOL_ID = 2; }
struct GUID { uint sessionID; uint localID; }
struct Color { float r; float g; float b; float a; }
struct Vector { float x; float y; }
struct Rect { float x; float y; float w; float h; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
struct ColorStop { Color color; float position; }
message ParentIndex { GUID guid = 1; string position = 2; }
message Image { byte[] hash = 1; string name = 2; uint dataBlob = 3; }
message PaintFilterMessage { float tint = 1; float shadows = 2; float highlights = 3; float exposure = 4; float temperature = 5; float vibrance = 6; float contrast = 7; }
message ShaderData { string source = 1; }
message Paint {
  PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; ColorStop[] stops = 5; Matrix transform = 6;
  BlendMode blendMode = 7; Image image = 8; ImageScaleMode imageScaleMode = 9; float rotation = 10; float scale = 11;
  PaintFilterMessage paintFilter = 12; uint originalImageWidth = 13; uint originalImageHeight = 14;
  NoiseType noiseType = 15; float density = 16; Vector noiseSize = 17; ShaderData shaderData = 18;
}
message Effect {
  EffectType type = 1; Vector offset = 2; float radius = 3; bool visible = 4; BlendMode blendMode = 5; float spread = 6; bool showShadowBehindNode = 7;
  BlurOpType blurOpType = 8; Vector startOffset = 9; Vector endOffset = 10; float startRadius = 11; Color color = 12; Color secondaryColor = 13;
  Vector noiseSize = 14; uint seed = 15; float density = 16; NoiseType noiseType = 17; float opacity = 18;
  float refraction = 19; float depth = 20; float lightIntensity = 21; float lightAngle = 22; float dispersion = 23; float frost = 24; ShaderData shaderData = 25;
}
message Path { WindingRule windingRule = 1; uint commandsBlob = 2; uint styleID = 3; }
message FontName { string family = 1; string style = 2; string postscript = 3; }
message Number { float value = 1; NumberUnits units = 2; }
message Glyph { uint commandsBlob = 1; Vector position = 2; uint styleID = 3; float fontSize = 4; uint firstCharacter = 5; float advance = 6; float rotation = 7; }
message Decoration { Rect[] rects = 1; uint styleID = 2; }
message TextLineData { LineType lineType = 1; }
message FontVariation { uint axisTag = 1; string axisName = 2; float value = 3; }
message TextData { string characters = 1; uint[] characterStyleIDs = 2; NodeChange[] styleOverrideTable = 3; Glyph[] glyphs = 4; Decoration[] decorations = 5; TextLineData[] lines = 6; }
message DerivedTextData { Glyph[] glyphs = 1; Decoration[] decorations = 2; }
message VectorData { uint vectorNetworkBlob = 1; Vector normalizedSize = 2; NodeChange[] styleOverrideTable = 3; }
message GUIDPath { GUID[] guids = 1; }
message SymbolData { GUID symbolID = 1; NodeChange[] symbolOverrides = 2; }
message ComponentPropRef { GUID defID = 1; ComponentPropNodeField componentPropNodeField = 2; }
message ComponentPropValue { bool boolValue = 1; TextData textValue = 2; GUID guidValue = 3; }
message ComponentPropAssignment { GUID defID = 1; ComponentPropValue value = 2; }
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
  BlendMode blendMode = 33; Effect[] effects = 34; bool mask = 35; MaskType maskType = 36; bool maskIsOutline = 37;
  float cornerSmoothing = 38; float[] dashPattern = 39; StrokeCap strokeCap = 40; StrokeJoin strokeJoin = 41; float miterLimit = 42;
  bool borderStrokeWeightsIndependent = 43; float borderTopWeight = 44; float borderRightWeight = 45; float borderBottomWeight = 46; float borderLeftWeight = 47;
  TextAlignVertical textAlignVertical = 48; TextCase textCase = 49; TextDecoration textDecoration = 50; float paragraphSpacing = 51; float paragraphIndent = 52;
  TextAutoResize textAutoResize = 53; TextTruncation textTruncation = 54; int maxLines = 55; OpenTypeFeature[] toggledOnOTFeatures = 56; OpenTypeFeature[] toggledOffOTFeatures = 57;
  FontVariation[] fontVariations = 58; DerivedTextData derivedTextData = 59; VectorData vectorData = 60; uint styleID = 61;
  ComponentPropRef[] componentPropRefs = 62; ComponentPropAssignment[] componentPropAssignments = 63; GUID overriddenSymbolID = 64;
  bool borderTopHidden = 65;
}
message Blob { byte[] bytes = 1; }
message Message { MessageType type = 1; NodeChange[] nodeChanges = 2; Blob[] blobs = 3; }
`;

export const g = (localID: number, sessionID = 1) => ({ sessionID, localID });
export const tr = (x: number, y: number, deg = 0) => {
  const r = (deg * Math.PI) / 180;
  return { m00: Math.cos(r), m01: -Math.sin(r), m02: x, m10: Math.sin(r), m11: Math.cos(r), m12: y };
};
export const rgba = (r: number, gg: number, b: number, a = 1) => ({ r, g: gg, b, a });
export const solid = (r: number, gg: number, b: number, a = 1, extra: any = {}) => ({ type: 'SOLID', color: rgba(r, gg, b, a), opacity: 1, visible: true, ...extra });
export const stops = (...cs: [number, number, number, number, number][]) => cs.map(([p, r, gg, b, a]) => ({ position: p, color: rgba(r, gg, b, a) }));

/** commandsBlob bytes: [cmd byte][float32 LE...], 0 close 1 move 2 line 3 quad 4 cubic */
export function pathBlob(cmds: [number, ...number[]][]): Uint8Array {
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

/** a tiny valid png (1x1 by default) with the given size in its header (enough for imageInfo) */
export function fakePng(w = 1, h = 1): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w); v.setUint32(20, h);
  return b;
}

const compiled = compileSchema(parseSchema(SYNTH_SCHEMA));

/** document + page + internal canvas, then `nodes` (parented to page 1:1 unless they say otherwise) */
export function synthMessage(nodes: any[], blobs: Uint8Array[] = []): any {
  const all: any[] = [
    { guid: g(0), type: 'DOCUMENT', name: 'Document' },
    { guid: g(1), type: 'CANVAS', name: 'Page 1', parentIndex: { guid: g(0), position: '!' } },
    { guid: g(2), type: 'CANVAS', name: 'Internal Only Canvas', internalOnly: true, parentIndex: { guid: g(0), position: '"' } },
    ...nodes.map((n, i) => ({ parentIndex: { guid: g(1), position: String.fromCharCode(40 + i) }, visible: true, opacity: 1, ...n })),
  ];
  // encode + decode: the result has exactly the shapes the real decoder produces
  const bytes = compiled.encodeMessage({ type: 'NODE_CHANGES', nodeChanges: all, blobs: blobs.map(b => ({ bytes: b })) });
  return compiled.decodeMessage(bytes);
}

/** a clipboard text/html payload as figma writes it, from nodes + blobs */
export function synthClipboardHtml(nodes: any[], blobs: Uint8Array[] = []): string {
  const msg = synthMessage(nodes, blobs);
  const schemaBytes = encodeBinarySchema(parseSchema(SYNTH_SCHEMA));
  const msgBytes = compiled.encodeMessage(msg);
  const c0 = deflateSync(schemaBytes), c1 = deflateSync(msgBytes);
  const buf = new Uint8Array(12 + 4 + c0.length + 4 + c1.length);
  buf.set(new TextEncoder().encode('fig-kiwi'), 0);
  const v = new DataView(buf.buffer);
  v.setUint32(8, 15, true);
  v.setUint32(12, c0.length, true); buf.set(c0, 16);
  v.setUint32(16 + c0.length, c1.length, true); buf.set(c1, 20 + c0.length);
  const meta = bytesToBase64(new TextEncoder().encode(JSON.stringify({ fileKey: 'synthetic', pasteID: 1, dataType: 'scene' })));
  return `<meta charset="utf-8"><span data-metadata="<!--(figmeta)${meta}(/figmeta)-->"></span><span data-buffer="<!--(figma)${bytesToBase64(buf)}(/figma)-->"></span>`;
}
