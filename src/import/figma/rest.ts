// figma node json (plugin api dump or REST api) -> the decoded-kiwi message shape that
// figmaMessageToLayers (convert.ts) consumes, so the converter can be exercised without a real
// clipboard payload (scripts/figma-fidelity.mjs).
//
// two inputs:
//  - plugin dumps (scripts/figma-fidelity/build/90-dump.js): plugin api property names
//    (relativeTransform, fills, gradientTransform, fillGeometry[].data, dashPattern, ...)
//  - REST nodes (GET /v1/files/:key/nodes?ids=..&geometry=paths): normalized to the plugin shape
//    first (restToPluginNode), then converted the same way
//
// what a real paste has and this can't produce: derivedTextData (figma's glyph outlines), derived
// symbol data, vector network blobs, variable / style references. text therefore goes through the
// font fallback path, not the glyph path. field names follow figma's kiwi schema as read by
// convert.ts; effect / paint fields convert.ts doesn't know yet are still emitted with their kiwi
// names so newer converters pick them up.

import { base64ToBytes } from './decode';

export interface FigmaJsonNode { id?: string; type: string; name?: string; children?: FigmaJsonNode[]; [k: string]: any }
export interface KiwiLikeMessage { type: 'NODE_CHANGES'; nodeChanges: any[]; blobs: { bytes: Uint8Array }[] }

const MIXED = 'MIXED';
const num = (v: any, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ---------------- svg path data -> kiwi commandsBlob ----------------

/** parse svg path data (absolute and relative M L H V Q C S T Z; figma emits absolute M L Q C Z) */
export function parsePathData(d: string): [string, ...number[]][] {
  const out: [string, ...number[]][] = [];
  const re = /([MmLlHhVvQqCcSsTtZzAa])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  const toks: (string | number)[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) toks.push(m[1] ?? parseFloat(m[2]));
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, lq: [number, number] | null = null, lc: [number, number] | null = null;
  const n = () => { const v = toks[i++]; return typeof v === 'number' ? v : NaN; };
  while (i < toks.length) {
    if (typeof toks[i] === 'string') cmd = toks[i++] as string;
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === 'Z') { out.push(['Z']); x = sx; y = sy; lq = lc = null; if (i < toks.length && typeof toks[i] !== 'string') i++; /* stray number after Z */ continue; }
    if (C === 'M') { x = ox + n(); y = oy + n(); sx = x; sy = y; out.push(['M', x, y]); cmd = rel ? 'l' : 'L'; lq = lc = null; }
    else if (C === 'L') { x = ox + n(); y = oy + n(); out.push(['L', x, y]); lq = lc = null; }
    else if (C === 'H') { x = ox + n(); out.push(['L', x, y]); lq = lc = null; }
    else if (C === 'V') { y = oy + n(); out.push(['L', x, y]); lq = lc = null; }
    else if (C === 'Q' || C === 'T') {
      let qx: number, qy: number;
      if (C === 'Q') { qx = ox + n(); qy = oy + n(); } else { qx = lq ? 2 * x - lq[0] : x; qy = lq ? 2 * y - lq[1] : y; }
      x = ox + n(); y = oy + n(); out.push(['Q', qx, qy, x, y]); lq = [qx, qy]; lc = null;
    } else if (C === 'C' || C === 'S') {
      let ax: number, ay: number;
      if (C === 'C') { ax = ox + n(); ay = oy + n(); } else { ax = lc ? 2 * x - lc[0] : x; ay = lc ? 2 * y - lc[1] : y; }
      const bx = ox + n(), by = oy + n();
      x = ox + n(); y = oy + n(); out.push(['C', ax, ay, bx, by, x, y]); lc = [bx, by]; lq = null;
    } else if (C === 'A') {
      // arcs never come out of figma; keep the end point so the path stays closed
      n(); n(); n(); n(); n(); x = ox + n(); y = oy + n(); out.push(['L', x, y]); lq = lc = null;
    } else { i++; continue; }
    if (out.length && out[out.length - 1].slice(1).some(v => Number.isNaN(v as number))) { out.pop(); break; }
  }
  return out;
}

/** encode path commands as a kiwi commandsBlob: [cmd byte][float32 LE...] 0=Z 1=M 2=L 3=Q 4=C */
export function encodeCommandsBlob(cmds: [string, ...number[]][]): Uint8Array {
  let len = 0;
  for (const c of cmds) len += 1 + (c.length - 1) * 4;
  const out = new Uint8Array(len), v = new DataView(out.buffer);
  let o = 0;
  const code: Record<string, number> = { Z: 0, M: 1, L: 2, Q: 3, C: 4 };
  for (const c of cmds) {
    out[o++] = code[c[0]];
    for (let k = 1; k < c.length; k++) { v.setFloat32(o, c[k] as number, true); o += 4; }
  }
  return out;
}

// ---------------- plugin json -> kiwi node change ----------------

const matrix = (t: any) => (Array.isArray(t) && t.length === 2
  ? { m00: num(t[0][0], 1), m01: num(t[0][1], 0), m02: num(t[0][2], 0), m10: num(t[1][0], 0), m11: num(t[1][1], 1), m12: num(t[1][2], 0) }
  : { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 });
const color = (c: any, a?: number) => ({ r: num(c?.r, 0), g: num(c?.g, 0), b: num(c?.b, 0), a: a ?? num(c?.a, 1) });
const SCALE_MODE: Record<string, string> = { FILL: 'FILL', FIT: 'FIT', TILE: 'TILE', CROP: 'STRETCH', STRETCH: 'STRETCH' };
const WINDING: Record<string, string> = { NONZERO: 'NONZERO', EVENODD: 'ODD', ODD: 'ODD' };
const MASK_TYPE: Record<string, string> = { ALPHA: 'ALPHA', VECTOR: 'OUTLINE', LUMINANCE: 'LUMINANCE' };
const NODE_TYPE: Record<string, string> = { COMPONENT: 'SYMBOL', COMPONENT_SET: 'FRAME', POLYGON: 'REGULAR_POLYGON' };

class Builder {
  nodeChanges: any[] = [];
  blobs: { bytes: Uint8Array }[] = [];
  private imageBlobs = new Map<string, number>();
  private local = 1;
  constructor(private images: Record<string, Uint8Array | string>) {}

  blob(bytes: Uint8Array): number { this.blobs.push({ bytes }); return this.blobs.length - 1; }

  private imageBlob(hash: string): number | undefined {
    if (this.imageBlobs.has(hash)) return this.imageBlobs.get(hash);
    const src = this.images[hash];
    if (src == null) return undefined;
    const idx = this.blob(typeof src === 'string' ? base64ToBytes(src) : src);
    this.imageBlobs.set(hash, idx);
    return idx;
  }

  paint(p: any): any | null {
    if (!p || typeof p !== 'object') return null;
    const base: any = { type: p.type, visible: p.visible !== false, opacity: num(p.opacity, 1), blendMode: p.blendMode ?? 'NORMAL' };
    if (p.type === 'SOLID') base.color = color(p.color, 1);
    else if (typeof p.type === 'string' && p.type.startsWith('GRADIENT_')) {
      base.transform = matrix(p.gradientTransform);
      base.stops = (p.gradientStops ?? []).map((s: any) => ({ color: color(s.color), position: num(s.position, 0) }));
    } else if (p.type === 'IMAGE') {
      base.imageScaleMode = SCALE_MODE[p.scaleMode] ?? 'FILL';
      const idx = p.imageHash ? this.imageBlob(p.imageHash) : undefined;
      if (idx != null) base.image = { hash: hexBytes(p.imageHash), dataBlob: idx };
      if (p.imageTransform) base.transform = matrix(p.imageTransform);
      if (typeof p.scalingFactor === 'number') base.scale = p.scalingFactor;
      if (typeof p.rotation === 'number') base.rotation = p.rotation;
      if (p.filters) base.paintFilter = { ...p.filters };
    } else if (p.type === 'SHADER') {
      // figma shader paint: kept as-is (id + property values; never the shader source)
      Object.assign(base, { shaderId: p.id, properties: p.properties, propertyMetadata: p.propertyMetadata });
    } else if (p.type === 'VIDEO' || p.type === 'PATTERN') { /* type only */ }
    return base;
  }

  paints(list: any): any[] | undefined {
    if (!Array.isArray(list)) return undefined;
    return list.map(p => this.paint(p)).filter(Boolean);
  }

  effect(e: any): any | null {
    if (!e || typeof e !== 'object') return null;
    const out: any = { visible: e.visible !== false };
    switch (e.type) {
      case 'DROP_SHADOW': case 'INNER_SHADOW':
        Object.assign(out, { type: e.type, color: color(e.color), offset: { x: num(e.offset?.x, 0), y: num(e.offset?.y, 0) }, radius: num(e.radius, 0), spread: num(e.spread, 0), blendMode: e.blendMode ?? 'NORMAL', showShadowBehindNode: !!e.showShadowBehindNode });
        break;
      case 'LAYER_BLUR': case 'BACKGROUND_BLUR':
        Object.assign(out, { type: e.type === 'LAYER_BLUR' ? 'FOREGROUND_BLUR' : 'BACKGROUND_BLUR', radius: num(e.radius, 0) });
        if (e.blurType === 'PROGRESSIVE') Object.assign(out, { blurOpType: 'PROGRESSIVE', startRadius: num(e.startRadius, 0), startOffset: e.startOffset, endOffset: e.endOffset });
        break;
      case 'NOISE':
        Object.assign(out, { type: 'NOISE', noiseType: e.noiseType, noiseSize: num(e.noiseSize, 1), density: num(e.density, 0.5), color: e.color ? color(e.color) : undefined, secondaryColor: e.secondaryColor ? color(e.secondaryColor) : undefined, opacity: e.opacity, blendMode: e.blendMode ?? 'NORMAL' });
        break;
      case 'TEXTURE':
        Object.assign(out, { type: 'TEXTURE', noiseSize: num(e.noiseSize, 1), radius: num(e.radius, 0), clipToShape: !!e.clipToShape });
        break;
      case 'GLASS':
        Object.assign(out, { ...e, type: 'GLASS' });
        break;
      case 'SHADER':
        Object.assign(out, { type: 'SHADER', shaderId: e.id, properties: e.properties, propertyMetadata: e.propertyMetadata });
        break;
      default:
        Object.assign(out, { ...e });
    }
    return out;
  }

  geometry(list: any): any[] | undefined {
    if (!Array.isArray(list) || !list.length) return undefined;
    const out: any[] = [];
    for (const g of list) {
      const d = g?.data ?? g?.path;
      if (typeof d !== 'string') continue;
      const cmds = parsePathData(d);
      if (!cmds.length) continue;
      out.push({ windingRule: WINDING[g.windingRule] ?? 'NONZERO', commandsBlob: this.blob(encodeCommandsBlob(cmds)), styleID: 0 });
    }
    return out;
  }

  /** plugin api quirk: children of GROUP / BOOLEAN_OPERATION nodes report relativeTransform in the
   *  space of the nearest frame-like ancestor (groups are transparent); kiwi and convert.ts want it
   *  relative to the direct parent. `groupSpace` = the parent group's own (container-space) transform. */
  groupRelative = true;

  node(n: FigmaJsonNode, parent: { sessionID: number; localID: number } | null, index: number, isRoot: boolean, groupSpace: number[][] | null = null): void {
    const guid = { sessionID: 1, localID: this.local++ };
    const type = NODE_TYPE[n.type] ?? n.type;
    const w = num(n.width, num(n.size?.x, 0)), h = num(n.height, num(n.size?.y, 0));
    const nc: any = {
      guid, phase: 'CREATED', type, name: n.name ?? type,
      parentIndex: parent ? { guid: parent, position: String.fromCharCode(33 + Math.min(index, 90)) + index.toString(36).padStart(4, '0') } : { guid: { sessionID: 0, localID: 1 }, position: '!' },
      visible: n.visible !== false, opacity: num(n.opacity, 1), size: { x: w, y: h },
      transform: matrix(groupSpace && Array.isArray(n.relativeTransform) ? mul(inv(groupSpace), n.relativeTransform) : n.relativeTransform),
    };
    if (isRoot) { nc.transform.m02 = 0; nc.transform.m12 = 0; }
    if (typeof n.blendMode === 'string' && n.blendMode !== 'PASS_THROUGH') nc.blendMode = n.blendMode;
    if (n.isMask) { nc.mask = true; nc.isMask = true; nc.maskType = MASK_TYPE[n.maskType] ?? 'ALPHA'; }
    const fills = this.paints(n.fills);
    if (fills) nc.fillPaints = fills;
    const strokes = this.paints(n.strokes);
    if (strokes) nc.strokePaints = strokes;
    if (strokes?.length) {
      nc.strokeWeight = n.strokeWeight === MIXED ? Math.max(num(n.strokeTopWeight, 0), num(n.strokeRightWeight, 0), num(n.strokeBottomWeight, 0), num(n.strokeLeftWeight, 0)) : num(n.strokeWeight, 1);
      nc.strokeAlign = n.strokeAlign ?? 'CENTER';
      if (n.strokeJoin && n.strokeJoin !== MIXED) nc.strokeJoin = n.strokeJoin;
      if (n.strokeCap && n.strokeCap !== MIXED) nc.strokeCap = n.strokeCap;
      if (typeof n.strokeMiterLimit === 'number') nc.miterLimit = n.strokeMiterLimit;
      if (Array.isArray(n.dashPattern) && n.dashPattern.length) nc.dashPattern = n.dashPattern.slice();
      const sides = ['Top', 'Right', 'Bottom', 'Left'].map(s => n['stroke' + s + 'Weight']);
      if (sides.every(v => typeof v === 'number') && sides.some(v => v !== sides[0])) {
        nc.borderStrokeWeightsIndependent = true;
        ['Top', 'Right', 'Bottom', 'Left'].forEach((s, i) => { nc['border' + s + 'Weight'] = sides[i]; });
      }
    }
    // corners
    const corners = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
    if (n.cornerRadius === MIXED || (corners.every(v => typeof v === 'number') && corners.some(v => v !== corners[0]))) {
      nc.rectangleCornerRadiiIndependent = true;
      [nc.rectangleTopLeftCornerRadius, nc.rectangleTopRightCornerRadius, nc.rectangleBottomRightCornerRadius, nc.rectangleBottomLeftCornerRadius] = corners.map(v => num(v, 0));
    } else if (typeof n.cornerRadius === 'number' && n.cornerRadius > 0) nc.cornerRadius = n.cornerRadius;
    if (typeof n.cornerSmoothing === 'number' && n.cornerSmoothing > 0) nc.cornerSmoothing = n.cornerSmoothing;
    const effects = Array.isArray(n.effects) ? n.effects.map(e => this.effect(e)).filter(Boolean) : undefined;
    if (effects?.length) nc.effects = effects;
    if ('clipsContent' in n) nc.frameMaskDisabled = n.clipsContent === false;
    if (n.arcData) nc.arcData = { startingAngle: num(n.arcData.startingAngle, 0), endingAngle: num(n.arcData.endingAngle, Math.PI * 2), innerRadius: num(n.arcData.innerRadius, 0) };
    if (n.type === 'BOOLEAN_OPERATION' && n.booleanOperation) nc.booleanOperation = n.booleanOperation;
    if (n.type === 'STAR' || n.type === 'POLYGON' || n.type === 'REGULAR_POLYGON') { nc.count = n.pointCount; if (typeof n.innerRadius === 'number') nc.starInnerScale = n.innerRadius; }
    // geometry: frames/rects/ellipses/text are drawn from their properties; vectors, stars, polygons,
    // lines, booleans and partial ellipses carry figma's computed outlines
    const geomTypes = new Set(['VECTOR', 'STAR', 'POLYGON', 'REGULAR_POLYGON', 'LINE', 'BOOLEAN_OPERATION', 'ELLIPSE']);
    if (geomTypes.has(n.type)) {
      const fg = this.geometry(n.fillGeometry);
      if (fg) nc.fillGeometry = fg;
      const sg = this.geometry(n.strokeGeometry);
      if (sg) nc.strokeGeometry = sg;
      // per-region fills of a vector network: figma pastes them as vectorData.styleOverrideTable
      const regions = n.vectorNetwork?.regions;
      if (fg && Array.isArray(regions) && regions.length === fg.length && regions.some((r: any) => Array.isArray(r.fills))) {
        const table: any[] = [];
        regions.forEach((r: any, i: number) => {
          if (!Array.isArray(r.fills)) return;
          fg[i].styleID = i + 1;
          table.push({ styleID: i + 1, fillPaints: this.paints(r.fills) });
        });
        nc.vectorData = { ...(nc.vectorData ?? {}), styleOverrideTable: table, normalizedSize: { x: w, y: h } };
      }
    }
    if (n.type === 'TEXT') this.text(n, nc);
    this.nodeChanges.push(nc);
    // boolean operands are baked into fillGeometry (convert.ts skips them); still emitted for completeness
    const isGroup = n.type === 'GROUP' || n.type === 'BOOLEAN_OPERATION';
    // a group inside a group: its own transform is already container-space, so pass it down as is
    const childSpace = this.groupRelative && isGroup && Array.isArray(n.relativeTransform) ? n.relativeTransform : null;
    (n.children ?? []).forEach((c, i) => this.node(c, guid, i, false, childSpace));
  }

  text(n: any, nc: any) {
    const chars: string = typeof n.characters === 'string' ? n.characters : '';
    const segs: any[] = Array.isArray(n.segments) ? n.segments : [];
    const first = segs[0] ?? {};
    const fontName = n.fontName && n.fontName !== MIXED ? n.fontName : first.fontName;
    nc.fontName = { family: fontName?.family ?? 'Inter', style: fontName?.style ?? 'Regular', postscript: '' };
    nc.fontSize = n.fontSize !== MIXED ? num(n.fontSize, 12) : num(first.fontSize, 12);
    nc.textAlignHorizontal = n.textAlignHorizontal ?? 'LEFT';
    nc.textAlignVertical = n.textAlignVertical ?? 'TOP';
    nc.textAutoResize = n.textAutoResize ?? 'NONE';
    if (n.textTruncation === 'ENDING') { nc.textTruncation = 'ENDING'; if (typeof n.maxLines === 'number') nc.maxLines = n.maxLines; }
    const lh = n.lineHeight !== MIXED ? n.lineHeight : first.lineHeight;
    nc.lineHeight = lh?.unit === 'PIXELS' ? { value: lh.value, units: 'PIXELS' } : lh?.unit === 'PERCENT' ? { value: lh.value, units: 'PERCENT' } : { value: 100, units: 'PERCENT' };
    const ls = n.letterSpacing !== MIXED ? n.letterSpacing : first.letterSpacing;
    nc.letterSpacing = { value: num(ls?.value, 0), units: ls?.unit === 'PIXELS' ? 'PIXELS' : 'PERCENT' };
    const tc = n.textCase !== MIXED ? n.textCase : first.textCase;
    if (tc && tc !== 'ORIGINAL') nc.textCase = tc;
    const td = n.textDecoration !== MIXED ? n.textDecoration : first.textDecoration;
    if (td && td !== 'NONE') nc.textDecoration = td;
    if (typeof n.paragraphSpacing === 'number' && n.paragraphSpacing) nc.paragraphSpacing = n.paragraphSpacing;
    if (typeof n.paragraphIndent === 'number' && n.paragraphIndent) nc.paragraphIndent = n.paragraphIndent;
    // node-level paints when mixed: the first run's
    if (!nc.fillPaints?.length && Array.isArray(first.fills)) nc.fillPaints = this.paints(first.fills);
    nc.textData = { characters: chars };
    // styled runs -> characterStyleIDs + styleOverrideTable (only what differs from the node style)
    if (segs.length > 1) {
      const ids = new Array(chars.length).fill(0);
      const table: any[] = [];
      segs.forEach((s, k) => {
        const o: any = { styleID: k + 1 };
        if (s.fontName && (s.fontName.family !== nc.fontName.family || s.fontName.style !== nc.fontName.style)) o.fontName = { family: s.fontName.family, style: s.fontName.style, postscript: '' };
        if (typeof s.fontSize === 'number' && s.fontSize !== nc.fontSize) o.fontSize = s.fontSize;
        if (Array.isArray(s.fills)) o.fillPaints = this.paints(s.fills);
        if (s.textDecoration && s.textDecoration !== 'NONE') o.textDecoration = s.textDecoration;
        if (s.letterSpacing) o.letterSpacing = { value: num(s.letterSpacing.value, 0), units: s.letterSpacing.unit === 'PIXELS' ? 'PIXELS' : 'PERCENT' };
        if (Object.keys(o).length === 1) return;
        table.push(o);
        for (let i = num(s.start, 0); i < num(s.end, 0) && i < ids.length; i++) ids[i] = k + 1;
      });
      if (table.length) { nc.textData.characterStyleIDs = ids; nc.textData.styleOverrideTable = table; }
    }
    // lists: kiwi keeps them per line (textData.lines); emitted so list-aware converters can use them
    const lists = segs.filter(s => s.listOptions && s.listOptions.type && s.listOptions.type !== 'NONE');
    if (lists.length) {
      const lines: any[] = [];
      let start = 0;
      for (const line of chars.split('\n')) {
        const seg = segs.find(s => num(s.start, 0) <= start && start < num(s.end, 0));
        const t = seg?.listOptions?.type;
        lines.push({ lineType: t === 'ORDERED' ? 'ORDERED_LIST' : t === 'UNORDERED' ? 'UNORDERED_LIST' : 'PLAIN', indentationLevel: t && t !== 'NONE' ? 1 : 0 });
        start += line.length + 1;
      }
      nc.textData.lines = lines;
    }
  }
}

type M23 = number[][];
function inv(m: M23): M23 {
  const [[a, c, e], [b, d, f]] = m, det = a * d - b * c || 1e-12;
  return [[d / det, -c / det, (c * f - d * e) / det], [-b / det, a / det, (b * e - a * f) / det]];
}
function mul(p: M23, q: M23): M23 {
  return [
    [p[0][0] * q[0][0] + p[0][1] * q[1][0], p[0][0] * q[0][1] + p[0][1] * q[1][1], p[0][0] * q[0][2] + p[0][1] * q[1][2] + p[0][2]],
    [p[1][0] * q[0][0] + p[1][1] * q[1][0], p[1][0] * q[0][1] + p[1][1] * q[1][1], p[1][0] * q[0][2] + p[1][1] * q[1][2] + p[1][2]],
  ];
}

function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array(Math.floor(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16) || 0;
  return out;
}

/** plugin-api json roots (each becomes a root at 0,0) -> decoded-kiwi-like message */
export function pluginNodesToMessage(roots: FigmaJsonNode[], images: Record<string, Uint8Array | string> = {}, groupRelative = true): KiwiLikeMessage {
  const b = new Builder(images);
  b.groupRelative = groupRelative;
  // a document + canvas parent like a real paste
  b.nodeChanges.push({ guid: { sessionID: 0, localID: 0 }, phase: 'CREATED', type: 'DOCUMENT', name: 'Document' });
  b.nodeChanges.push({ guid: { sessionID: 0, localID: 1 }, phase: 'CREATED', type: 'CANVAS', name: 'Page 1', parentIndex: { guid: { sessionID: 0, localID: 0 }, position: '!' } });
  roots.forEach((r, i) => b.node(r, null, i, true));
  return { type: 'NODE_CHANGES', nodeChanges: b.nodeChanges, blobs: b.blobs };
}

// ---------------- REST -> plugin shape ----------------

/** REST gradient handles (box-normalized) -> plugin gradientTransform (box -> gradient space) */
export function handlesToGradientTransform(type: string, h: { x: number; y: number }[]): number[][] {
  const [p0, p1, p2] = h;
  // forward map F: unit gradient space -> box. linear runs (0,.5)->(1,.5); the others are centered at (.5,.5)
  let X: number[], Y: number[], O: number[];
  if (type === 'GRADIENT_LINEAR') {
    X = [p1.x - p0.x, p1.y - p0.y]; Y = [2 * (p2.x - p0.x), 2 * (p2.y - p0.y)];
    O = [p0.x - 0.5 * Y[0], p0.y - 0.5 * Y[1]];
  } else {
    X = [2 * (p1.x - p0.x), 2 * (p1.y - p0.y)]; Y = [2 * (p2.x - p0.x), 2 * (p2.y - p0.y)];
    O = [p0.x - 0.5 * X[0] - 0.5 * Y[0], p0.y - 0.5 * X[1] - 0.5 * Y[1]];
  }
  const a = X[0], b = X[1], c = Y[0], d = Y[1], e = O[0], f = O[1], det = a * d - b * c || 1e-12;
  // inverse of [[a c e][b d f]]
  return [[d / det, -c / det, (c * f - d * e) / det], [-b / det, a / det, (b * e - a * f) / det]];
}

const restPaint = (p: any): any => {
  const out: any = { ...p };
  if (p.type?.startsWith('GRADIENT_') && Array.isArray(p.gradientHandlePositions) && !p.gradientTransform) out.gradientTransform = handlesToGradientTransform(p.type, p.gradientHandlePositions);
  if (p.type === 'IMAGE' && p.imageRef && !p.imageHash) out.imageHash = p.imageRef;
  if (p.type === 'IMAGE' && Array.isArray(p.imageTransform) && !out.imageTransform) out.imageTransform = p.imageTransform;
  return out;
};

/** normalize a REST node (geometry=paths) to the plugin dump shape */
export function restToPluginNode(n: any): FigmaJsonNode {
  const o: any = { ...n };
  if (n.size) { o.width = n.size.x; o.height = n.size.y; } else if (n.absoluteBoundingBox && n.width == null) { o.width = n.absoluteBoundingBox.width; o.height = n.absoluteBoundingBox.height; }
  if (Array.isArray(n.fills)) o.fills = n.fills.map(restPaint);
  if (Array.isArray(n.strokes)) o.strokes = n.strokes.map(restPaint);
  if (Array.isArray(n.strokeDashes)) o.dashPattern = n.strokeDashes;
  if (n.individualStrokeWeights) { const s = n.individualStrokeWeights; o.strokeTopWeight = s.top; o.strokeRightWeight = s.right; o.strokeBottomWeight = s.bottom; o.strokeLeftWeight = s.left; }
  if (Array.isArray(n.rectangleCornerRadii)) [o.topLeftRadius, o.topRightRadius, o.bottomRightRadius, o.bottomLeftRadius] = n.rectangleCornerRadii;
  if (n.type === 'TEXT' && n.style) {
    const s = n.style;
    o.fontName = { family: s.fontFamily, style: s.fontStyle ?? (s.italic ? 'Italic' : 'Regular') };
    o.fontSize = s.fontSize;
    o.textAlignHorizontal = s.textAlignHorizontal; o.textAlignVertical = s.textAlignVertical; o.textAutoResize = s.textAutoResize;
    o.letterSpacing = { unit: 'PIXELS', value: s.letterSpacing ?? 0 };
    o.lineHeight = s.lineHeightUnit === 'INTRINSIC_%' ? { unit: 'AUTO' } : s.lineHeightUnit === 'FONT_SIZE_%' ? { unit: 'PERCENT', value: s.lineHeightPercentFontSize } : { unit: 'PIXELS', value: s.lineHeightPx };
    o.textCase = s.textCase; o.textDecoration = s.textDecoration; o.paragraphSpacing = s.paragraphSpacing;
    // style runs
    const ids: number[] = n.characterStyleOverrides ?? [];
    const table = n.styleOverrideTable ?? {};
    if (ids.length) {
      const segs: any[] = [];
      let i = 0;
      while (i < ids.length) {
        let j = i + 1;
        while (j < ids.length && ids[j] === ids[i]) j++;
        const st = { ...s, ...(table[ids[i]] ?? {}) };
        segs.push({ start: i, end: j, fontName: { family: st.fontFamily, style: st.fontStyle ?? 'Regular' }, fontSize: st.fontSize, fills: (st.fills ?? n.fills ?? []).map(restPaint), textDecoration: st.textDecoration, letterSpacing: { unit: 'PIXELS', value: st.letterSpacing ?? 0 } });
        i = j;
      }
      if ((n.characters?.length ?? 0) > ids.length) segs.push({ start: ids.length, end: n.characters.length, fontName: o.fontName, fontSize: s.fontSize, fills: o.fills });
      o.segments = segs;
    }
  }
  if (Array.isArray(n.children)) o.children = n.children.map(restToPluginNode);
  return o;
}

/** REST nodes -> decoded-kiwi-like message. images: imageRef -> bytes */
export function restNodesToMessage(roots: any[], images: Record<string, Uint8Array | string> = {}): KiwiLikeMessage {
  // REST relativeTransform is relative to the direct parent (groups included)
  return pluginNodesToMessage(roots.map(restToPluginNode), images, false);
}
