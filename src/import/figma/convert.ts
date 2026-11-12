// figma kiwi message -> motion layers.
//
// coordinate mapping: figma's node.transform is the relativeTransform (parent box space, top-left
// origin, y down) and node.size the local box. our layers are after-effects style:
//   anchor = (w/2, h/2), position = M·(w/2, h/2), rotation = atan2(m10, m00) (deg, clockwise on screen),
//   scale = column lengths (y scale signed by det, so flips become negative scale). skew is dropped.
//
// gradients: figma's paint.transform maps box-normalized space (0..1 over the node box) to gradient
// space, where a linear gradient runs (0,.5)->(1,.5) and a radial one is the circle c=(.5,.5) r=.5.
// our renderer expects paint.transform to map that same unit gradient space onto the normalized box,
// i.e. the inverse of figma's matrix. we store [a,b,c,d,e,f] (canvas order: x' = a x + c y + e).

//
// fidelity notes (docs/figma-fidelity.md has the full table):
//  - paints: every visible paint is kept in order with its blend mode (solid, linear / radial /
//    angular / diamond gradients, images with scale mode / rotation / filters, noise). shader paints
//    and effects go to the shader hooks (index.ts loads ./shaders.ts when it exists).
//  - effects: drop / inner shadows, layer + background blur (also progressive), noise, texture and
//    glass become Layer.effects; the first of each type is animatable through layer props.
//  - text: style runs, decoration, paragraph spacing, case, truncation, lists, features, variable
//    axes are stored; figma's own glyph outlines (derivedTextData.glyphs) are kept so the text looks
//    exactly as in figma until it is edited.

import { decodeVectorNetwork } from './vectornet';
import { createLayer, prop, textSig, uid, type Asset, type BlendMode, type Effect, type ImageFilters, type Layer, type LayerType, type NoiseParams, type Paint, type PathCmd, type PathGeometry, type TextData, type TextRun } from '../../core/model';
import { bytesToBase64 } from './decode';
import type { IncomingToken } from '../../core/token-sync';

/** what a shader hook gets: the raw figma node and paint / effect, plus the layer being built */
export interface ShaderHookContext { node: any; layer: Layer; message: any; blobs: any[]; warn(msg: string): void }
/** shader paints / effects are converted by the shader runtime (src/import/figma/shaders.ts, loaded
 *  by index.ts when present). returning null / undefined drops the paint / effect. */
export interface FigmaShaderHooks {
  convertShaderPaint?(paint: any, ctx: ShaderHookContext): Paint | null | undefined;
  convertShaderEffect?(effect: any, ctx: ShaderHookContext): Effect | null | undefined;
}
export interface FigmaConvertOptions { shaders?: FigmaShaderHooks }

/** a paint / effect is a shader one when its type says so or it carries shader data */
export function isShaderThing(x: any): boolean {
  if (!x || typeof x !== 'object') return false;
  if (typeof x.type === 'string' && /SHADER/i.test(x.type)) return true;
  for (const k in x) if (/shader/i.test(k) && x[k] != null) return true;
  return false;
}

/** a layer property that was linked to a figma variable or style */
export interface FigmaRef { layer: string; prop: 'fill' | 'stroke' | 'opacity' | 'radius' | 'strokeWidth'; key: string }
/** a pasted component instance (root layer) and the component it came from */
export interface FigmaInstance { layer: string; key: string; name: string }
export interface FigmaDesignData {
  tokens: IncomingToken[];
  refs: FigmaRef[];
  instances: FigmaInstance[];
  /** component definitions (main components) by key: root layer id; their layers are in `defLayers` */
  defs: { key: string; name: string; root: string }[];
  defLayers: Layer[];
  /** the variable mode the pasted layers were showing (e.g. "Dark") */
  mode?: string;
  /** what could not be imported faithfully (deduplicated, with counts) */
  warnings?: string[];
}

type Guid = { sessionID: number; localID: number };
type Color = [number, number, number, number];

const gkey = (g: Guid | undefined | null) => (g ? `${g.sessionID}:${g.localID}` : '');

const FRAME_LIKE = new Set(['FRAME', 'SECTION', 'SYMBOL', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET', 'SLIDE', 'SLIDE_GRID', 'SLIDE_ROW', 'TABLE']);
const PATH_TYPES = new Set(['VECTOR', 'STAR', 'REGULAR_POLYGON', 'LINE', 'BOOLEAN_OPERATION', 'SHAPE_WITH_TEXT', 'CONNECTOR', 'STICKY', 'WASHI_TAPE', 'HIGHLIGHT']);
const SKIP_TYPES = new Set(['DOCUMENT', 'CANVAS', 'VARIABLE', 'VARIABLE_SET', 'VARIABLE_OVERRIDE']);
const MAX_INSTANCE_DEPTH = 32;

// ---------------- path blobs ----------------

/** decode a figma commandsBlob: [cmd byte][float32 LE...]. 0=close 1=move 2=line 3=quad 4=cubic */
export function decodeCommandsBlob(bytes: Uint8Array): PathCmd[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: PathCmd[] = [];
  let o = 0;
  const n = bytes.length;
  const f = () => { const v = view.getFloat32(o, true); o += 4; return v; };
  while (o < n) {
    const cmd = bytes[o++];
    if (cmd === 0) out.push(['Z']);
    else if (cmd === 1) { if (o + 8 > n) break; out.push(['M', f(), f()]); }
    else if (cmd === 2) { if (o + 8 > n) break; out.push(['L', f(), f()]); }
    else if (cmd === 3) { if (o + 16 > n) break; out.push(['Q', f(), f(), f(), f()]); }
    else if (cmd === 4) { if (o + 24 > n) break; out.push(['C', f(), f(), f(), f(), f(), f()]); }
    else break; // unknown command: stop rather than misread floats
  }
  return out;
}

// ---------------- small helpers ----------------

function colorOf(c: any, opacity = 1): Color {
  if (!c) return [0, 0, 0, opacity];
  return [num(c.r, 0), num(c.g, 0), num(c.b, 0), num(c.a, 1) * opacity];
}
function num(v: any, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
const visiblePaint = (p: any) => p && p.visible !== false && num(p.opacity, 1) > 0;

function topSolid(paints: any[] | undefined): Color | null {
  if (!paints) return null;
  for (let i = paints.length - 1; i >= 0; i--) {
    const p = paints[i];
    if (visiblePaint(p) && (p.type === 'SOLID' || p.type == null)) return colorOf(p.color, num(p.opacity, 1));
  }
  return null;
}

function invert6(m: number[]): number[] {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 1, 0, 0];
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function weightFromStyle(style: string): number {
  const s = style.toLowerCase().replace(/[\s_-]/g, '');
  if (/thin|hairline/.test(s)) return 100;
  if (/(extra|ultra)light/.test(s)) return 200;
  if (/(extra|ultra)bold/.test(s)) return 800;
  if (/(semi|demi)bold/.test(s)) return 600;
  if (/black|heavy/.test(s)) return 900;
  if (/bold/.test(s)) return 700;
  if (/medium/.test(s)) return 500;
  if (/light/.test(s)) return 300;
  const m = /(\d{3})/.exec(s);
  if (m) return +m[1];
  return 400;
}

function imageInfo(bytes: Uint8Array): { mime: string; width: number; height: number } {
  const b = bytes;
  // png
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { mime: 'image/png', width: v.getUint32(16), height: v.getUint32(20) };
  }
  // jpeg: walk markers to SOFn
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const marker = b[o + 1];
      const len = (b[o + 2] << 8) | b[o + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', height: (b[o + 5] << 8) | b[o + 6], width: (b[o + 7] << 8) | b[o + 8] };
      }
      o += 2 + len;
    }
    return { mime: 'image/jpeg', width: 0, height: 0 };
  }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { mime: 'image/gif', width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    // webp VP8X canvas size (other variants: leave 0, the app can measure on load)
    if (b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x58) {
      return { mime: 'image/webp', width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    return { mime: 'image/webp', width: 0, height: 0 };
  }
  return { mime: 'application/octet-stream', width: 0, height: 0 };
}

// ---------------- paints / effects / strokes ----------------

const BLEND: Record<string, BlendMode> = {
  DARKEN: 'darken', MULTIPLY: 'multiply', LINEAR_BURN: 'linearBurn', COLOR_BURN: 'colorBurn', LIGHTEN: 'lighten', SCREEN: 'screen',
  LINEAR_DODGE: 'add', COLOR_DODGE: 'colorDodge', OVERLAY: 'overlay', SOFT_LIGHT: 'softLight', HARD_LIGHT: 'hardLight',
  DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue', SATURATION: 'saturation', COLOR: 'color', LUMINOSITY: 'luminosity',
};
/** figma blend mode -> ours (NORMAL / PASS_THROUGH / unknown -> undefined) */
export function blendOf(m: any): BlendMode | undefined {
  return typeof m === 'string' ? BLEND[m] : undefined;
}

function figMatrix(m: any): number[] {
  const t = m ?? {};
  return [num(t.m00, 1), num(t.m10, 0), num(t.m01, 0), num(t.m11, 1), num(t.m02, 0), num(t.m12, 0)];
}

const NOISE_MODE: Record<string, NoiseParams['mode']> = { MONOTONE: 'mono', DUOTONE: 'duo', MULTITONE: 'multi' };
function noiseParams(x: any, fallbackColor?: number[]): NoiseParams {
  const mode = NOISE_MODE[x?.noiseType] ?? 'mono';
  const size = num(x?.noiseSize?.x, num(x?.noiseSize, 1));
  const out: NoiseParams = { mode, size: size > 0 ? size : 1, density: Math.max(0, Math.min(1, num(x?.density, 0.5))) };
  if (x?.color) out.color = colorOf(x.color);
  else if (fallbackColor) out.color = fallbackColor;
  if (x?.secondaryColor) out.secondary = colorOf(x.secondaryColor);
  if (typeof x?.opacity === 'number') out.opacity = x.opacity;
  if (typeof x?.seed === 'number') out.seed = x.seed;
  return out;
}

function imageFilters(p: any): ImageFilters | undefined {
  const f = p.paintFilter ?? p.filterColorAdjust;
  if (!f) return undefined;
  const out: ImageFilters = {};
  const set = (k: keyof ImageFilters, v: any) => { if (typeof v === 'number' && Math.abs(v) > 1e-4) out[k] = v; };
  set('exposure', f.exposure); set('contrast', f.contrast); set('saturation', f.saturation ?? f.vibrance); set('temperature', f.temperature);
  set('tint', f.tint); set('highlights', f.highlights); set('shadows', f.shadows);
  return Object.keys(out).length ? out : undefined;
}

const sameColor = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - (b[i] ?? 0)) < 1e-6);

/** src-over of solid colors (non-premultiplied rgba): a stack of normal solid paints is one color */
function overColor(dst: number[], src: number[]): Color {
  const sa = src[3], da = dst[3] * (1 - sa), a = sa + da;
  if (a <= 0) return [0, 0, 0, 0];
  return [(src[0] * sa + dst[0] * da) / a, (src[1] * sa + dst[1] * da) / a, (src[2] * sa + dst[2] * da) / a, a];
}

/** decoded stroke style of a node */
function strokeStyle(layer: Layer, n: any) {
  if (Array.isArray(n.dashPattern) && n.dashPattern.length && n.dashPattern.some((d: number) => d > 0)) {
    layer.dash = n.dashPattern.map((d: any) => Math.max(0, num(d, 0)));
  }
  const cap = n.strokeCap;
  if (cap === 'ROUND') layer.strokeCap = 'round';
  else if (cap === 'SQUARE') layer.strokeCap = 'square';
  else if (cap === 'NONE') layer.strokeCap = 'butt';
  const join = n.strokeJoin;
  if (join === 'ROUND') layer.strokeJoin = 'round';
  else if (join === 'BEVEL') layer.strokeJoin = 'bevel';
  else if (join === 'MITER') layer.strokeJoin = 'miter';
  if (typeof n.miterLimit === 'number' && n.miterLimit > 0) layer.miterLimit = n.miterLimit;
  if (n.borderStrokeWeightsIndependent === true) {
    const w = num(n.strokeWeight, 0);
    const side = (k: string, hidden: string) => (n[hidden] ? 0 : Math.max(0, num(n[k], w)));
    const s: [number, number, number, number] = [side('borderTopWeight', 'borderTopHidden'), side('borderRightWeight', 'borderRightHidden'), side('borderBottomWeight', 'borderBottomHidden'), side('borderLeftWeight', 'borderLeftHidden')];
    if (!s.every(x => x === s[0])) layer.strokeSides = s;
  }
}

/** glyph / decoration geometry of a text node from figma's derived layout (exact look) */
function textOutline(n: any, blobs: any[], cache: Map<number, PathCmd[]>, fills: Map<number, number[] | null>): { groups: Map<number, PathCmd[]> } | null {
  const d = n.derivedTextData ?? n.textData;
  const glyphs: any[] | undefined = d?.glyphs;
  const chars: string = n.textData?.characters ?? '';
  if (!Array.isArray(glyphs) || !glyphs.length || !chars) return null;
  // stale derived data (instance text overridden without new layout): the glyphs must reach the end
  let last = 0;
  for (const g of glyphs) { if (g.emojiCodePoints?.length) return null; last = Math.max(last, num(g.firstCharacter, 0)); }
  const trimmed = chars.replace(/\s+$/, '').length;
  if (last >= chars.length || last < trimmed - 4) return null;
  const groups = new Map<number, PathCmd[]>();
  const add = (style: number) => { let a = groups.get(style); if (!a) groups.set(style, (a = [])); return a; };
  for (const g of glyphs) {
    if (typeof g.commandsBlob !== 'number') continue;
    let cmds = cache.get(g.commandsBlob);
    if (!cmds) {
      const b = blobBytes(blobs[g.commandsBlob]);
      if (!b) continue;
      cmds = decodeCommandsBlob(b);
      cache.set(g.commandsBlob, cmds);
    }
    if (!cmds.length) continue;
    const size = num(g.fontSize, num(n.fontSize, 12)), rot = num(g.rotation, 0);
    const cs = Math.cos(rot), sn = Math.sin(rot), px = num(g.position?.x, 0), py = num(g.position?.y, 0);
    // translate(pos) rotate(rot) scale(size, -size): glyph outlines are in em units, y up
    const X = (x: number, y: number) => px + cs * x * size + sn * y * size;
    const Y = (x: number, y: number) => py + sn * x * size - cs * y * size;
    const out = add(num(g.styleID, 0));
    for (const c of cmds) {
      switch (c[0]) {
        case 'M': case 'L': out.push([c[0], X(c[1], c[2]), Y(c[1], c[2])]); break;
        case 'Q': out.push(['Q', X(c[1], c[2]), Y(c[1], c[2]), X(c[3], c[4]), Y(c[3], c[4])]); break;
        case 'C': out.push(['C', X(c[1], c[2]), Y(c[1], c[2]), X(c[3], c[4]), Y(c[3], c[4]), X(c[5], c[6]), Y(c[5], c[6])]); break;
        case 'Z': out.push(['Z']); break;
      }
    }
  }
  for (const dec of d.decorations ?? []) {
    const out = add(num(dec.styleID, 0));
    for (const r of dec.rects ?? []) {
      const x = num(r.x, 0), y = num(r.y, 0), w = num(r.w, 0), h = num(r.h, 0);
      if (w > 0 && h > 0) out.push(['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']);
    }
  }
  if (!groups.size) return null;
  void fills;
  return { groups };
}

const TEXT_CASE: Record<string, TextData['textCase']> = { UPPER: 'upper', LOWER: 'lower', TITLE: 'title', SMALL_CAPS: 'smallCaps', SMALL_CAPS_FORCED: 'smallCaps' };

function axisTag(v: any): string {
  if (typeof v === 'string') return v;
  const n = num(v, 0) >>> 0;
  return String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

// ---------------- converter ----------------

interface OverrideLevel {
  /** overrides of one instance, keyed by guidPath ("s:l/s:l") relative to that instance */
  map: Map<string, any[]>;
  /** path of the current node relative to that instance */
  path: string;
  /** same path using the node's overrideKey for the last segment (newer files) */
  alt?: string;
  /** component property values assigned on that instance (defID -> value) */
  props?: Map<string, any>;
}

class Converter {
  layers: Layer[] = [];
  assets: Asset[] = [];
  private nodes = new Map<string, any>();
  private children = new Map<string, any[]>();
  private blobs: any[];
  private geomCache = new Map<number, PathCmd[]>();
  private assetByHash = new Map<string, Asset>();
  // design system data (variables, styles, components)
  refs: FigmaRef[] = [];
  tokens = new Map<string, IncomingToken>();
  instances: (FigmaInstance & { inInstance: boolean; sym: any })[] = [];
  defs = new Map<string, { key: string; name: string; root: string }>();
  defLayers: Layer[] = [];
  mode?: string;
  private byKey = new Map<string, any>();
  private setModes = new Map<string, { id: string; name: string }[]>();
  private instanceDepth = 0;
  private defStack: string[] = [];
  warnings = new Map<string, number>();

  constructor(private message: any, private opts: FigmaConvertOptions = {}) {
    this.blobs = Array.isArray(message?.blobs) ? message.blobs : [];
    const list: any[] = Array.isArray(message?.nodeChanges) ? message.nodeChanges : [];
    for (const n of list) {
      if (!n || !n.guid || n.phase === 'REMOVED') continue;
      this.nodes.set(gkey(n.guid), n);
    }
    for (const n of this.nodes.values()) {
      if (typeof n.key === 'string' && n.key) this.byKey.set(n.key, n);
      if (n.type === 'VARIABLE_SET' && Array.isArray(n.variableSetModes)) {
        const modes = n.variableSetModes.map((m: any) => ({ id: gkey(m.id), name: String(m.name ?? 'Mode') }));
        this.setModes.set(gkey(n.guid), modes);
        if (n.key) this.setModes.set('k:' + n.key, modes);
      }
    }
    for (const n of this.nodes.values()) {
      const p = gkey(n.parentIndex?.guid);
      if (!p) continue;
      let arr = this.children.get(p);
      if (!arr) this.children.set(p, (arr = []));
      arr.push(n);
    }
    // fractional-index strings compare bytewise; ascending = bottom -> top (figma children[0] is bottom)
    for (const arr of this.children.values()) {
      if (arr.length > 1) arr.sort((a, b) => cmpStr(a.parentIndex?.position ?? '', b.parentIndex?.position ?? ''));
    }
  }

  run(): string[] {
    const roots: string[] = [];
    const rootNodes: any[] = [];
    const internal: any[] = [];
    for (const n of this.nodes.values()) {
      if (SKIP_TYPES.has(n.type)) continue;
      const parent = this.nodes.get(gkey(n.parentIndex?.guid));
      if (parent && !SKIP_TYPES.has(parent.type)) continue; // converted as a child
      // nodes on figma's hidden "internal only" canvas are component definitions used by
      // instances in the paste; they are not part of the selection.
      if (n.styleType) continue; // a style definition (name + value), read through styleIdFor*
      if (parent && parent.type === 'CANVAS' && parent.internalOnly) internal.push(n);
      else rootNodes.push(n);
    }
    const src = rootNodes.length ? rootNodes : internal;
    // roots keep their relative order when they share a parent
    src.sort((a, b) => cmpStr(a.parentIndex?.position ?? '', b.parentIndex?.position ?? ''));
    for (const n of src) {
      const id = this.emit(n, null, [], 0);
      if (id) roots.push(id);
    }
    // definitions of the components the pasted instances use (and of the ones those use)
    const main = this.layers;
    this.layers = this.defLayers;
    for (let i = 0; i < this.instances.length; i++) {
      const inst = this.instances[i];
      if (inst.inInstance || this.defs.has(inst.key) || !inst.sym) continue;
      this.defStack.push(inst.key);
      const root = this.emit(inst.sym, null, [], 0);
      this.defStack.pop();
      if (root) this.defs.set(inst.key, { key: inst.key, name: inst.name, root });
    }
    this.layers = main;
    return roots;
  }

  // ---------------- variables / styles ----------------

  /** token for a figma variable alias (VariableID), registered once per key */
  private variableToken(alias: any, resolved: number[], type: 'color' | 'number', scale = 1): string | null {
    if (!alias) return null;
    const key = alias.assetRef?.key || gkey(alias.guid);
    if (!key) return null;
    if (this.tokens.has(key)) return key;
    const node = (alias.assetRef?.key && this.byKey.get(alias.assetRef.key)) || this.nodes.get(gkey(alias.guid));
    const values: Record<string, number[]> = {};
    if (node && Array.isArray(node.variableDataValues?.entries)) {
      const set = node.variableSetID;
      const modes = this.setModes.get(gkey(set?.guid)) ?? (set?.assetRef?.key ? this.setModes.get('k:' + set.assetRef.key) : undefined) ?? [];
      for (const e of node.variableDataValues.entries) {
        const name = modes.find(m => m.id === gkey(e.modeID))?.name ?? (modes.length ? undefined : 'Default');
        const v = e.variableData?.value;
        if (!name || !v) continue;
        if (type === 'color' && v.colorValue) values[name] = colorOf(v.colorValue);
        else if (type === 'number' && typeof v.floatValue === 'number') values[name] = [v.floatValue * scale];
      }
      // the mode the pasted layers show
      if (!this.mode && Object.keys(values).length > 1) {
        for (const [m, v] of Object.entries(values)) if (v.every((x, i) => Math.abs(x - (resolved[i] ?? 0)) < 1e-3)) { this.mode = m; break; }
      }
    }
    if (!Object.keys(values).length) values.Default = resolved.slice();
    const name = typeof node?.name === 'string' && node.name ? node.name : `Figma/${type === 'color' ? 'Color' : 'Number'} ${this.tokens.size + 1}`;
    this.tokens.set(key, { key, name, type, values, kind: 'figma-variable', ...(node?.description ? { description: node.description } : {}) });
    return key;
  }

  /** token for a figma color style reference (StyleId) */
  private styleToken(ref: any): string | null {
    if (!ref) return null;
    const key = ref.assetRef?.key || gkey(ref.guid);
    if (!key) return null;
    if (this.tokens.has(key)) return key;
    const node = (ref.assetRef?.key && this.byKey.get(ref.assetRef.key)) || this.nodes.get(gkey(ref.guid));
    if (!node || typeof node.name !== 'string') return null;
    const vis = (node.fillPaints ?? []).filter(visiblePaint);
    if (vis.length !== 1 || vis[0].type !== 'SOLID') return null; // gradient / multi-paint styles are not one color
    this.tokens.set(key, { key, name: node.name, type: 'color', values: { Default: colorOf(vis[0].color, num(vis[0].opacity, 1)) }, kind: 'figma-style', ...(node.styleDescription ? { description: node.styleDescription } : {}) });
    return key;
  }

  /** record which properties of `layer` are linked to variables / styles in figma */
  private collectRefs(layer: Layer, n: any) {
    const solidRef = (paints: any[] | undefined, style: any, prop: 'fill' | 'stroke') => {
      const vis = (paints ?? []).filter(visiblePaint);
      const top = vis[vis.length - 1];
      if (!top || top.type !== 'SOLID' || vis.length > 1 || !layer.props[prop]) return;
      const resolved = layer.props[prop]!.v;
      const alias = top.colorVar?.value?.alias;
      let key: string | null = null;
      if (alias && num(top.opacity, 1) === 1) key = this.variableToken(alias, resolved, 'color');
      if (!key && style) key = this.styleToken(style);
      if (key) this.refs.push({ layer: layer.id, prop, key });
    };
    if (!layer.paints && layer.type !== 'image') solidRef(n.fillPaints, n.styleIdForFill, 'fill');
    if (layer.strokePaints) return;
    if (num(n.strokeWeight, 0) > 0) solidRef(n.strokePaints, n.styleIdForStrokeFill, 'stroke');
    const entries = n.variableConsumptionMap?.entries;
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      const alias = e?.variableData?.value?.alias;
      if (!alias) continue;
      const f = e.variableField;
      if (f === 'OPACITY' && layer.props.opacity) {
        // figma opacity variables are 0..1 (shown as %): ours are percent
        const key = this.variableToken(alias, layer.props.opacity.v, 'number', 100);
        if (key) this.refs.push({ layer: layer.id, prop: 'opacity', key });
      } else if (f === 'CORNER_RADIUS' && layer.props.radius) {
        const key = this.variableToken(alias, [layer.props.radius.v[0]], 'number');
        if (key) this.refs.push({ layer: layer.id, prop: 'radius', key });
      } else if (f === 'STROKE_WEIGHT' && layer.props.strokeWidth && layer.props.strokeWidth.v[0] > 0) {
        const key = this.variableToken(alias, layer.props.strokeWidth.v, 'number');
        if (key) this.refs.push({ layer: layer.id, prop: 'strokeWidth', key });
      }
    }
  }

  private emit(raw: any, parentId: string | null, levels: OverrideLevel[], depth: number): string | null {
    const n = applyPropRefs(applyOverrides(raw, levels), levels);
    if (!n || SKIP_TYPES.has(n.type)) return null;
    const layer = this.convertNode(n);
    if (!layer) return null;
    layer.parent = parentId;
    this.layers.push(layer);

    if (n.type === 'BOOLEAN_OPERATION') return layer.id; // operands are baked into fillGeometry

    this.collectRefs(layer, n);
    let kids = this.children.get(gkey(raw.guid));
    let childLevels = levels;
    let isInstance = false;
    if (n.type === 'INSTANCE' && (!kids || kids.length === 0) && depth < MAX_INSTANCE_DEPTH) {
      // instance sublayers are not real nodes: clone the component's subtree with overrides
      const symId = gkey(n.overriddenSymbolID) || gkey(n.symbolData?.symbolID);
      const sym = symId ? this.nodes.get(symId) : undefined;
      if (sym) {
        const key = (typeof sym.componentKey === 'string' && sym.componentKey) || n.sharedSymbolReference?.componentKey || `figma:${symId}`;
        if (!this.defStack.includes(key)) this.instances.push({ layer: layer.id, key, name: typeof sym.name === 'string' && sym.name ? sym.name : layer.name, inInstance: this.instanceDepth > 0, sym });
        isInstance = true;
        kids = this.children.get(symId);
        const map = new Map<string, any[]>();
        // derived data (resized geometry etc.) first, explicit overrides win
        addOverrides(map, n.derivedSymbolData);
        addOverrides(map, n.symbolData?.symbolOverrides);
        // component property values (text, visibility, instance swaps) of this instance
        let props: Map<string, any> | undefined;
        for (const a of n.componentPropAssignments ?? []) {
          if (!a?.defID || !a.value) continue;
          (props ??= new Map()).set(gkey(a.defID), a.value);
        }
        childLevels = [...levels, { map, path: '', props }];
        // keep the instance's own paints if it has none (instances inherit the component's look)
        if (!n.fillPaints && sym.fillPaints && layer.type === 'group') this.applyFills(layer, sym.fillPaints, sym);
      }
    }
    if (isInstance) this.instanceDepth++;
    if (kids) {
      for (const k of kids) {
        const seg = gkey(k.guid);
        const altSeg = k.overrideKey ? gkey(k.overrideKey) : '';
        const lv: OverrideLevel[] = childLevels.map(l => ({ map: l.map, props: l.props, path: l.path ? `${l.path}/${seg}` : seg, alt: altSeg ? (l.path ? `${l.path}/${altSeg}` : altSeg) : '' }));
        const cid = this.emit(k, layer.id, lv, depth + (childLevels !== levels ? 1 : 0));
        if (cid) layer.children.push(cid);
      }
    }
    if (isInstance) this.instanceDepth--;
    return layer.id;
  }

  warn(msg: string) { this.warnings.set(msg, (this.warnings.get(msg) ?? 0) + 1); }

  private convertNode(n: any): Layer | null {
    const type: string = n.type ?? 'FRAME';
    const w = Math.max(0, num(n.size?.x, 0)), h = Math.max(0, num(n.size?.y, 0));
    const hasGeom = (n.fillGeometry?.length ?? 0) > 0 || (n.strokeGeometry?.length ?? 0) > 0 || typeof n.vectorData?.vectorNetworkBlob === 'number';

    let lt: LayerType;
    if (type === 'TEXT') lt = n.textData?.characters != null || !hasGeom ? 'text' : 'path';
    else if (type === 'RECTANGLE' || type === 'ROUNDED_RECTANGLE') lt = 'rect';
    else if (type === 'ELLIPSE') lt = isFullEllipse(n.arcData) || !hasGeom ? 'ellipse' : 'path';
    else if (type === 'GROUP' || FRAME_LIKE.has(type)) lt = 'group';
    else if (PATH_TYPES.has(type)) lt = 'path';
    else {
      if (!hasGeom && type !== 'NONE' && !KNOWN_CONTAINERS.has(type)) this.warn(`node type ${type}: imported as a group`);
      lt = hasGeom ? 'path' : 'group';
    }

    // a plain rectangle showing exactly one image (stretched, or cover without crop) -> image layer
    const imgAsset = lt === 'rect' ? this.plainImage(n, w, h) : null;
    if (imgAsset) lt = 'image';

    const layer = createLayer(lt, { w, h });
    layer.name = typeof n.name === 'string' && n.name ? n.name : layer.name;
    layer.visible = n.visible !== false;
    setTransform(layer, n.transform, w, h);
    layer.props.opacity!.v = [Math.max(0, Math.min(100, num(n.opacity, 1) * 100))];
    if (n.isMask || n.mask) {
      layer.mask = true; // masks the siblings above it
      if (n.maskType === 'LUMINANCE') layer.maskType = 'luminance';
      else if (n.maskType === 'OUTLINE' || n.maskIsOutline === true) layer.maskType = 'vector';
    }
    const blend = blendOf(n.blendMode);
    if (blend) layer.blend = blend;
    if (typeof n.cornerSmoothing === 'number' && n.cornerSmoothing > 1e-3 && (lt === 'rect' || lt === 'group')) layer.smoothing = Math.min(1, n.cornerSmoothing);
    this.applyEffects(layer, n);

    if (lt === 'image') {
      layer.imageRef = imgAsset!.id;
      return layer;
    }

    if (lt === 'group') {
      const isGroup = type === 'GROUP' || (type === 'FRAME' && n.resizeToFit === true);
      if (isGroup) {
        layer.props.fill!.v = [0, 0, 0, 0];
        layer.clip = false;
      } else {
        this.applyFills(layer, n.fillPaints, n);
        layer.clip = n.frameMaskDisabled !== true && n.clipsContent !== false;
        layer.props.radius!.v = cornerRadii(n, w, h);
      }
      this.applyStroke(layer, n, false);
      return layer;
    }

    if (lt === 'text') {
      layer.text = this.textData(n, layer);
      this.applyFills(layer, n.fillPaints, n);
      this.applyStroke(layer, n, false);
      return layer;
    }

    this.applyFills(layer, n.fillPaints, n);
    if (lt === 'rect') layer.props.radius!.v = cornerRadii(n, w, h);
    if (lt === 'path') {
      layer.geometry = this.geoms(n.fillGeometry, n);
      layer.geomSize = [w, h];
      // newer clipboards: no cached geometry, only the vector network
      if (!layer.geometry.length && typeof n.vectorData?.vectorNetworkBlob === 'number') {
        const bytes = blobBytes(this.blobs[n.vectorData.vectorNetworkBlob]);
        const ns = n.vectorData.normalizedSize;
        const net = bytes ? decodeVectorNetwork(bytes, ns?.x ? w / ns.x : 1, ns?.y ? h / ns.y : 1) : null;
        if (net) {
          if (net.fills.length) layer.geometry = net.fills;
          else if (net.stroke) {
            // open network (lines) has no regions: draw it as a stroked path without fill
            layer.geometry = [net.stroke];
            layer.props.fill!.v = [0, 0, 0, 0];
            delete layer.paints;
          }
        }
      }
    }
    this.applyStroke(layer, n, lt === 'path');
    return layer;
  }

  /** a figma paint -> ours (null: not drawable / dropped) */
  private paint(p: any, n: any, layer: Layer | null): Paint | null {
    const op = num(p.opacity, 1);
    const blend = blendOf(p.blendMode);
    const base = (x: Paint): Paint => { if (op !== 1) x.opacity = op; if (blend) x.blend = blend; return x; };
    if (isShaderThing(p)) {
      const hook = this.opts.shaders?.convertShaderPaint;
      if (!hook || !layer) { this.warn('shader paint: needs the shader runtime (skipped)'); return null; }
      try { return hook(p, this.hookCtx(n, layer)) ?? null; } catch (e) { this.warn(`shader paint failed: ${String(e)}`); return null; }
    }
    switch (p.type) {
      case 'SOLID': case undefined: case null:
        return base({ type: 'solid', color: colorOf(p.color) });
      case 'GRADIENT_LINEAR': case 'GRADIENT_RADIAL': case 'GRADIENT_ANGULAR': case 'GRADIENT_DIAMOND': {
        const stops = (p.stops ?? []).map((s: any) => ({ pos: num(s.position, 0), color: colorOf(s.color) })).sort((a: any, b: any) => a.pos - b.pos);
        if (!stops.length) return null;
        const t = p.type === 'GRADIENT_LINEAR' ? 'linear' : p.type === 'GRADIENT_RADIAL' ? 'radial' : p.type === 'GRADIENT_ANGULAR' ? 'angular' : 'diamond';
        return base({ type: t, stops, transform: invert6(figMatrix(p.transform)) });
      }
      case 'IMAGE': case 'VIDEO': {
        const asset = this.imageAsset(p);
        if (!asset) {
          this.warn(p.type === 'VIDEO' ? 'video fill: no frame in the clipboard (grey placeholder)' : 'image fill: image bytes not in the clipboard (grey placeholder)');
          return base({ type: 'solid', color: [0.8, 0.8, 0.8, 1] });
        }
        if (p.type === 'VIDEO') this.warn('video fill: imported as its still frame');
        const mode = p.imageScaleMode === 'FIT' ? 'fit' : p.imageScaleMode === 'TILE' ? 'tile' : p.imageScaleMode === 'STRETCH' ? 'stretch' : 'fill';
        const out = base({ type: 'image', imageRef: asset.id, scaleMode: mode });
        if (mode === 'stretch' && p.transform) out.transform = invert6(figMatrix(p.transform));
        const rot = num(p.rotation, 0);
        if (rot) out.rotation = rot;
        if (mode === 'tile') out.tileScale = num(p.scale, 1) || 1;
        const f = imageFilters(p);
        if (f) out.filters = f;
        return out;
      }
      case 'NOISE':
        return base({ type: 'noise', noise: noiseParams(p, colorOf(p.color)) });
      case 'PATTERN':
        this.warn('pattern fill: not supported yet (skipped)');
        return null;
      case 'EMOJI':
        return null;
      default:
        this.warn(`paint type ${p.type}: not supported (skipped)`);
        return null;
    }
  }

  private hookCtx(n: any, layer: Layer): ShaderHookContext {
    return { node: n, layer, message: this.message, blobs: this.blobs, warn: (m: string) => this.warn(m) };
  }

  /** fills: a stack of normal solids -> props.fill (animatable, sdf / tinted mask); anything else ->
   *  layer.paints (all visible paints, bottom -> top, with blend modes) */
  private applyFills(layer: Layer, raw: any[] | undefined, n: any) {
    const vis = (raw ?? []).filter(visiblePaint);
    const paints: Paint[] = [];
    for (const p of vis) { const x = this.paint(p, n, layer); if (x) paints.push(x); }
    let color: Color = [0, 0, 0, 0];
    let simple = true;
    for (const p of paints) {
      if (p.type !== 'solid' || (p.blend && p.blend !== 'normal')) { simple = false; break; }
      const c = p.color!.slice() as Color;
      c[3] *= p.opacity ?? 1;
      color = overColor(color, c);
    }
    delete layer.paints;
    if (simple) { layer.props.fill!.v = color; return; }
    // keep an animatable color too: the top solid (what the inspector shows)
    const top = [...paints].reverse().find(p => p.type === 'solid');
    const grad = paints.find(p => p.stops?.length);
    layer.props.fill!.v = top ? (top.color!.slice(0, 3).concat([top.color![3] * (top.opacity ?? 1)]) as Color) : grad ? (grad.stops![0].color.slice() as Color) : [0.8, 0.8, 0.8, 1];
    layer.paints = paints;
  }

  private applyStroke(layer: Layer, n: any, isPath: boolean) {
    const weight = num(n.strokeWeight, 0);
    if (layer.type === 'text') {
      if (weight > 0 && (n.strokePaints ?? []).some(visiblePaint)) this.warn('text stroke: not drawn yet');
      return;
    }
    const vis = (n.strokePaints ?? []).filter(visiblePaint);
    const paints: Paint[] = [];
    for (const p of vis) { const x = this.paint(p, n, layer); if (x) paints.push(x); }
    if (!paints.length || weight <= 0) {
      if (layer.props.stroke) layer.props.stroke.v = [0, 0, 0, 0];
      if (layer.props.strokeWidth) layer.props.strokeWidth.v = [0];
      return;
    }
    let color: Color = [0, 0, 0, 0];
    let simple = true;
    for (const p of paints) {
      if (p.type !== 'solid' || (p.blend && p.blend !== 'normal')) { simple = false; continue; }
      const c = p.color!.slice() as Color;
      c[3] *= p.opacity ?? 1;
      color = overColor(color, c);
    }
    if (!simple) {
      layer.strokePaints = paints;
      // the color the inspector shows (and the fallback where paints can't be drawn)
      const g = paints.find(p => p.stops?.length);
      if (color[3] === 0) color = g ? (g.stops![0].color.slice() as Color) : [0.8, 0.8, 0.8, 1];
    }
    if (!layer.props.stroke) layer.props.stroke = prop(color);
    else layer.props.stroke.v = color;
    if (!layer.props.strokeWidth) layer.props.strokeWidth = prop([weight]);
    else layer.props.strokeWidth.v = [weight];
    const a = n.strokeAlign;
    layer.strokeAlign = a === 'INSIDE' ? 'inside' : a === 'OUTSIDE' ? 'outside' : 'center';
    strokeStyle(layer, n);
    if (isPath && n.strokeGeometry?.length) layer.strokeGeometry = this.geoms(n.strokeGeometry, null);
  }

  private applyEffects(layer: Layer, n: any) {
    const list: any[] = Array.isArray(n.effects) ? n.effects : [];
    const out: Effect[] = [];
    const first = new Set<string>();
    const P = (k: keyof Layer['props'], v: number[]) => { layer.props[k] = prop(v); };
    for (const e of list) {
      if (!e) continue;
      const visible = e.visible !== false;
      if (isShaderThing(e)) {
        const hook = this.opts.shaders?.convertShaderEffect;
        if (!hook) { this.warn('shader effect: needs the shader runtime (skipped)'); continue; }
        try { const x = hook(e, this.hookCtx(n, layer)); if (x) out.push(x); } catch (err) { this.warn(`shader effect failed: ${String(err)}`); }
        continue;
      }
      const blend = blendOf(e.blendMode);
      const offset: [number, number] = [num(e.offset?.x, 0), num(e.offset?.y, 0)];
      const radius = Math.max(0, num(e.radius, 0));
      let fx: Effect | null = null;
      switch (e.type) {
        case 'DROP_SHADOW': case 'INNER_SHADOW': {
          const inner = e.type === 'INNER_SHADOW';
          fx = { type: inner ? 'innerShadow' : 'dropShadow' };
          if (!inner && e.showShadowBehindNode) fx.showBehind = true;
          const color = colorOf(e.color), spread = num(e.spread, 0);
          if (!first.has(fx.type) && visible) {
            first.add(fx.type);
            if (inner) { P('innerShadowColor', color); P('innerShadowOffset', offset); P('innerShadowBlur', [radius]); P('innerShadowSpread', [spread]); }
            else { P('shadowColor', color); P('shadowOffset', offset); P('shadowBlur', [radius]); P('shadowSpread', [spread]); }
          } else { fx.color = color; fx.offset = offset; fx.radius = radius; fx.spread = spread; }
          break;
        }
        case 'FOREGROUND_BLUR': case 'BACKGROUND_BLUR': {
          const bg = e.type === 'BACKGROUND_BLUR';
          fx = { type: bg ? 'backgroundBlur' : 'layerBlur' };
          if (e.blurOpType === 'PROGRESSIVE') {
            fx.progressive = { start: [num(e.startOffset?.x, 0.5), num(e.startOffset?.y, 0)], end: [num(e.endOffset?.x, 0.5), num(e.endOffset?.y, 1)], startRadius: Math.max(0, num(e.startRadius, 0)) };
          }
          if (!first.has(fx.type) && visible) { first.add(fx.type); P(bg ? 'backgroundBlur' : 'blur', [radius]); }
          else fx.radius = radius;
          break;
        }
        case 'NOISE': case 'GRAIN': {
          fx = { type: 'noise', noise: noiseParams(e) };
          if (e.type === 'GRAIN' && !e.noiseSize) fx.noise!.size = Math.max(1, radius || 1);
          if (!first.has('noise') && visible) {
            first.add('noise');
            const np = fx.noise!;
            P('noiseColor', np.color ?? [0, 0, 0, np.opacity ?? 0.25]);
            P('noiseSize', [np.size]);
            P('noiseDensity', [np.density * 100]);
          }
          break;
        }
        case 'TEXTURE': {
          fx = { type: 'texture', noise: noiseParams(e), radius, params: numericFields(e) };
          this.warn('texture effect: approximated');
          break;
        }
        case 'GLASS': {
          fx = { type: 'glass', radius, params: numericFields(e) };
          this.warn('glass effect: approximated');
          break;
        }
        default:
          this.warn(`effect ${e.type}: not supported (skipped)`);
      }
      if (!fx) continue;
      if (!visible) fx.visible = false;
      if (blend) fx.blend = blend;
      out.push(fx);
    }
    if (out.length) layer.effects = out;
  }

  private geoms(list: any[] | undefined, n: any): PathGeometry[] {
    const out: PathGeometry[] = [];
    // vectors with regions of different fills: per-geometry paints from the style override table
    const table = new Map<number, any>();
    if (n) for (const s of n.vectorData?.styleOverrideTable ?? []) if (typeof s?.styleID === 'number') table.set(s.styleID, s);
    for (const g of list ?? []) {
      const idx = g?.commandsBlob;
      if (typeof idx !== 'number') continue;
      let cmds = this.geomCache.get(idx);
      if (!cmds) {
        const bytes = blobBytes(this.blobs[idx]);
        if (!bytes) continue;
        cmds = decodeCommandsBlob(bytes);
        this.geomCache.set(idx, cmds);
      }
      if (!cmds.length) continue;
      const geo: PathGeometry = { cmds, fillRule: g.windingRule === 'NONZERO' || g.windingRule == null ? 'nonzero' : 'evenodd' };
      const st = table.get(num(g.styleID, 0));
      if (st && Array.isArray(st.fillPaints)) {
        const ps: Paint[] = [];
        for (const p of st.fillPaints.filter(visiblePaint)) { const x = this.paint(p, n, null); if (x) ps.push(x); }
        geo.paints = ps;
      }
      out.push(geo);
    }
    return out;
  }

  private textData(n: any, layer: Layer): TextData {
    const t = textData(n);
    // style runs from the per-character style ids + override table
    const ids: number[] | undefined = n.textData?.characterStyleIDs;
    const table = new Map<number, any>();
    for (const s of n.textData?.styleOverrideTable ?? []) if (typeof s?.styleID === 'number') table.set(s.styleID, s);
    const fills = new Map<number, number[] | null>();
    const styleFill = (sid: number): number[] | null => {
      if (fills.has(sid)) return fills.get(sid)!;
      const s = table.get(sid);
      const ps = s?.fillPaints;
      let c: number[] | null = null;
      if (Array.isArray(ps)) {
        const vis = ps.filter(visiblePaint);
        if (vis.length && vis.every((p: any) => p.type === 'SOLID' || p.type == null)) c = topSolid(vis);
        else if (vis.length) this.warn('text: gradient / image fill on part of a text (base fill used)');
      }
      fills.set(sid, c);
      return c;
    };
    if (Array.isArray(ids) && ids.length && table.size) {
      const runs: TextRun[] = [];
      let i = 0;
      const len = t.content.length;
      while (i < len) {
        const sid = ids[i] ?? 0;
        let j = i + 1;
        while (j < len && (ids[j] ?? 0) === sid) j++;
        const s = sid ? table.get(sid) : null;
        if (s) {
          const r: TextRun = { start: i, end: j };
          if (s.fontName?.family && s.fontName.family !== t.fontFamily) r.fontFamily = s.fontName.family;
          if (s.fontName?.style) { const wgt = weightFromStyle(s.fontName.style); if (wgt !== t.fontWeight) r.fontWeight = wgt; const it = /italic|oblique/i.test(s.fontName.style) ? 'italic' : 'normal'; if (it !== (t.fontStyle ?? 'normal')) r.fontStyle = it; }
          if (typeof s.fontSize === 'number' && s.fontSize !== t.fontSize) r.fontSize = s.fontSize;
          const f = styleFill(sid);
          if (f) r.fill = f;
          if (s.textDecoration === 'UNDERLINE') r.decoration = 'underline';
          else if (s.textDecoration === 'STRIKETHROUGH') r.decoration = 'strike';
          if (s.letterSpacing && typeof s.letterSpacing.value === 'number') r.letterSpacing = s.letterSpacing.units === 'PIXELS' ? s.letterSpacing.value : (s.letterSpacing.value / 100) * (r.fontSize ?? t.fontSize);
          if (Object.keys(r).length > 2) runs.push(r);
        }
        i = j;
      }
      if (runs.length) t.runs = runs;
    }
    // figma's glyph outlines: the exact look (fonts we may not have, features, axes, wrapping)
    const ol = textOutline(n, this.blobs, this.geomCache, fills);
    if (ol) {
      const groups: { geometry: PathGeometry[]; fill: number[] | null }[] = [];
      for (const [sid, cmds] of ol.groups) groups.push({ geometry: [{ cmds, fillRule: 'nonzero' }], fill: sid ? styleFill(sid) : null });
      t.outline = { sig: textSig(t, layer.props.size?.v), groups };
    } else if (n.derivedTextData?.glyphs?.some((g: any) => g.emojiCodePoints?.length)) {
      this.warn('text with emoji: drawn with the system emoji font');
    }
    return t;
  }

  /** an image paint that a plain image layer shows exactly (one image, stretched or covering the box
   *  at the image's own aspect, no filters / rotation, normal blend) */
  private plainImage(n: any, w: number, h: number): Asset | null {
    const vis = (n.fillPaints ?? []).filter(visiblePaint);
    if (vis.length !== 1) return null;
    const p = vis[0];
    if (p.type !== 'IMAGE' || num(p.opacity, 1) !== 1 || blendOf(p.blendMode) || imageFilters(p) || num(p.rotation, 0)) return null;
    if (num(n.strokeWeight, 0) > 0 && (n.strokePaints ?? []).some(visiblePaint)) return null;
    if (n.cornerRadius || n.rectangleTopLeftCornerRadius || n.rectangleTopRightCornerRadius || n.rectangleBottomLeftCornerRadius || n.rectangleBottomRightCornerRadius) return null;
    const asset = this.imageAsset(p);
    if (!asset) return null;
    const mode = p.imageScaleMode ?? 'FILL';
    if (mode === 'STRETCH') {
      const m = figMatrix(p.transform);
      return sameColor(m, [1, 0, 0, 1, 0, 0]) ? asset : null;
    }
    if (mode !== 'FILL' && mode !== 'FIT') return null;
    // cover / contain equal stretch only at the same aspect ratio
    const iw = asset.width || num(p.originalImageWidth, 0), ih = asset.height || num(p.originalImageHeight, 0);
    if (!iw || !ih || !w || !h) return null;
    return Math.abs(iw / ih - w / h) < 0.01 ? asset : null;
  }

  private imageAsset(p: any): Asset | null {
    const img = p.image?.dataBlob != null ? p.image : p.imageThumbnail?.dataBlob != null ? p.imageThumbnail : p.animatedImage?.dataBlob != null ? p.animatedImage : null;
    const blobIdx = img?.dataBlob;
    const bytes = typeof blobIdx === 'number' ? blobBytes(this.blobs[blobIdx]) : null;
    if (!bytes || bytes.length < 8) return null;
    const hash = img.hash ? Array.from(blobBytes(img.hash) ?? []).join(',') : `blob${blobIdx}`;
    let asset = this.assetByHash.get(hash);
    if (!asset) {
      const info = imageInfo(bytes);
      asset = { id: uid('a'), kind: 'image', mime: info.mime, data: `data:${info.mime};base64,${bytesToBase64(bytes)}`, width: info.width || num(p.originalImageWidth, 0), height: info.height || num(p.originalImageHeight, 0) };
      this.assetByHash.set(hash, asset);
      this.assets.push(asset);
    }
    return asset;
  }
}

const KNOWN_CONTAINERS = new Set(['GROUP', 'FRAME', 'SECTION', 'SYMBOL', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET', 'SLIDE', 'SLIDE_GRID', 'SLIDE_ROW', 'TABLE', 'TABLE_CELL', 'SLICE', 'WIDGET', 'STAMP', 'MEDIA', 'CODE_BLOCK', 'RESPONSIVE_SET', 'MODULE', 'REPEATER', 'TRANSFORM']);

function numericFields(e: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k in e) {
    const v = e[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (v && typeof v === 'object' && typeof v.x === 'number' && typeof v.y === 'number' && Object.keys(v).length === 2) { out[k + 'X'] = v.x; out[k + 'Y'] = v.y; }
  }
  return out;
}

/** component properties: a node bound to a property of the instance it is in takes its value */
function applyPropRefs(n: any, levels: OverrideLevel[]): any {
  const refs: any[] | undefined = n?.componentPropRefs;
  if (!Array.isArray(refs) || !refs.length || !levels.length) return n;
  let out = n;
  for (const r of refs) {
    if (!r?.defID || r.isDeleted) continue;
    const id = gkey(r.defID);
    let v: any;
    for (let i = levels.length - 1; i >= 0 && v === undefined; i--) v = levels[i].props?.get(id);
    if (v === undefined) continue;
    if (out === n) out = { ...n };
    switch (r.componentPropNodeField) {
      case 'VISIBLE': if (typeof v.boolValue === 'boolean') out.visible = v.boolValue; break;
      case 'TEXT_DATA': if (v.textValue?.characters != null) { out.textData = { ...(out.textData ?? {}), ...v.textValue }; if (out.derivedTextData && v.textValue.characters !== n.textData?.characters) out.derivedTextData = undefined; } break;
      case 'OVERRIDDEN_SYMBOL_ID': if (v.guidValue) out.overriddenSymbolID = v.guidValue; break;
    }
  }
  return out;
}

function cmpStr(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function blobBytes(b: any): Uint8Array | null {
  if (!b) return null;
  if (b instanceof Uint8Array) return b;
  const v = b.bytes ?? b;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v);
  return null;
}

function addOverrides(map: Map<string, any[]>, list: any[] | undefined) {
  if (!Array.isArray(list)) return;
  for (const o of list) {
    const guids: Guid[] | undefined = o?.guidPath?.guids;
    if (!guids?.length) continue;
    const k = guids.map(gkey).join('/');
    let arr = map.get(k);
    if (!arr) map.set(k, (arr = []));
    arr.push(o);
  }
}

/** shallow-merge instance overrides onto a component sublayer (outer instances win) */
function applyOverrides(n: any, levels: OverrideLevel[]): any {
  if (!levels.length) return n;
  let out = n;
  for (let i = levels.length - 1; i >= 0; i--) {
    const l = levels[i];
    const ovs = l.map.get(l.path) ?? (l.alt ? l.map.get(l.alt) : undefined);
    if (!ovs) continue;
    if (out === n) out = { ...n };
    for (const o of ovs) {
      for (const k in o) {
        if (k === 'guidPath' || k === 'guid' || k === 'parentIndex' || o[k] == null) continue;
        out[k] = o[k];
      }
    }
  }
  return out;
}

function isFullEllipse(arc: any): boolean {
  if (!arc) return true;
  const start = num(arc.startingAngle, 0), end = num(arc.endingAngle, Math.PI * 2), inner = num(arc.innerRadius, 0);
  return inner <= 1e-6 && Math.abs(Math.abs(end - start) - Math.PI * 2) < 1e-4;
}

function setTransform(layer: Layer, t: any, w: number, h: number) {
  const m00 = num(t?.m00, 1), m01 = num(t?.m01, 0), m02 = num(t?.m02, 0);
  const m10 = num(t?.m10, 0), m11 = num(t?.m11, 1), m12 = num(t?.m12, 0);
  const sx = Math.hypot(m00, m10) || 1;
  const det = m00 * m11 - m01 * m10;
  const sy = det / sx;
  const rot = (Math.atan2(m10, m00) * 180) / Math.PI;
  layer.props.anchor!.v = [w / 2, h / 2];
  layer.props.position!.v = [m00 * (w / 2) + m01 * (h / 2) + m02, m10 * (w / 2) + m11 * (h / 2) + m12];
  layer.props.rotation!.v = [Math.abs(rot) < 1e-9 ? 0 : rot];
  layer.props.scale!.v = [round6(sx * 100), round6((sy || 1) * 100)];
}
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

function cornerRadii(n: any, w: number, h: number): number[] {
  const all = num(n.cornerRadius, 0);
  const has = (k: string) => typeof n[k] === 'number';
  const independent = n.rectangleCornerRadiiIndependent === true || (n.rectangleCornerRadiiIndependent == null && n.cornerRadius == null && has('rectangleTopLeftCornerRadius'));
  const r = independent
    ? [num(n.rectangleTopLeftCornerRadius, all), num(n.rectangleTopRightCornerRadius, all), num(n.rectangleBottomRightCornerRadius, all), num(n.rectangleBottomLeftCornerRadius, all)]
    : [all, all, all, all];
  const max = Math.min(w, h) / 2;
  return r.map(v => Math.max(0, Math.min(v, max)));
}

function firstGradientColor(paints: any[] | undefined): Color | null {
  for (const p of paints ?? []) {
    if (visiblePaint(p) && p.stops?.length) return colorOf(p.stops[0].color, num(p.opacity, 1));
  }
  return null;
}

function textData(n: any): TextData {
  const fontSize = num(n.fontSize, 12);
  const style: string = n.fontName?.style ?? 'Regular';
  let lineHeight = 1.2;
  const lh = n.lineHeight;
  if (lh && typeof lh.value === 'number') {
    // units: PIXELS (px), PERCENT (100 = figma "auto"), RAW (multiplier). unverified: we treat
    // PERCENT 100 as auto (~1.2 for typical fonts).
    if (lh.units === 'PIXELS') lineHeight = fontSize > 0 ? lh.value / fontSize : 1.2;
    else if (lh.units === 'RAW') lineHeight = lh.value;
    else if (lh.units === 'PERCENT') lineHeight = lh.value === 100 ? 1.2 : lh.value / 100;
  }
  let letterSpacing = 0;
  const ls = n.letterSpacing;
  if (ls && typeof ls.value === 'number') letterSpacing = ls.units === 'PIXELS' ? ls.value : (ls.value / 100) * fontSize;
  const ah = n.textAlignHorizontal;
  const content: string = n.textData?.characters ?? '';
  const t: TextData = {
    content,
    fontFamily: n.fontName?.family ?? 'Inter',
    fontSize,
    fontWeight: weightFromStyle(style),
    fontStyle: /italic|oblique/i.test(style) ? 'italic' : 'normal',
    lineHeight: lineHeight > 0 ? lineHeight : 1.2,
    letterSpacing,
    align: ah === 'CENTER' ? 'center' : ah === 'RIGHT' ? 'right' : ah === 'JUSTIFIED' ? 'justify' : 'left',
  };
  const tc = TEXT_CASE[n.textCase];
  if (tc) t.textCase = tc;
  if (n.textAlignVertical === 'CENTER') t.valign = 'center';
  else if (n.textAlignVertical === 'BOTTOM') t.valign = 'bottom';
  if (n.textDecoration === 'UNDERLINE') t.decoration = 'underline';
  else if (n.textDecoration === 'STRIKETHROUGH') t.decoration = 'strike';
  if (num(n.paragraphSpacing, 0) > 0) t.paragraphSpacing = n.paragraphSpacing;
  if (num(n.paragraphIndent, 0) > 0) t.paragraphIndent = n.paragraphIndent;
  if (n.textAutoResize === 'WIDTH_AND_HEIGHT') t.autoResize = 'width';
  else if (n.textAutoResize === 'HEIGHT') t.autoResize = 'height';
  if (n.textTruncation === 'ENDING') { t.truncate = true; if (num(n.maxLines, 0) > 0) t.maxLines = n.maxLines; }
  const feats: string[] = [];
  for (const f of n.toggledOnOTFeatures ?? []) if (typeof f === 'string') feats.push(f.toLowerCase());
  for (const f of n.toggledOffOTFeatures ?? []) if (typeof f === 'string') feats.push('-' + f.toLowerCase());
  if (n.fontVariantCaps === 'SMALL' || n.fontVariantCaps === 'ALL_SMALL') feats.push('smcp');
  if (n.fontVariantNumericFigure === 'LINING') feats.push('lnum'); else if (n.fontVariantNumericFigure === 'OLDSTYLE') feats.push('onum');
  if (n.fontVariantNumericSpacing === 'TABULAR') feats.push('tnum'); else if (n.fontVariantNumericSpacing === 'PROPORTIONAL') feats.push('pnum');
  if (n.fontVariantSlashedZero) feats.push('zero');
  if (n.fontVariantCommonLigatures === false) feats.push('-liga');
  if (feats.length) t.features = feats;
  if (Array.isArray(n.fontVariations) && n.fontVariations.length) {
    const v: Record<string, number> = {};
    for (const a of n.fontVariations) if (a && typeof a.value === 'number') v[axisTag(a.axisTag ?? a.axisName)] = a.value;
    if (Object.keys(v).length) t.variations = v;
  }
  const lines: any[] | undefined = n.textData?.lines;
  if (Array.isArray(lines) && lines.some(l => l?.lineType === 'ORDERED_LIST' || l?.lineType === 'UNORDERED_LIST')) {
    t.lists = lines.map(l => (l?.lineType === 'ORDERED_LIST' ? 'ol' : l?.lineType === 'UNORDERED_LIST' ? 'ul' : null));
  }
  return t;
}

export function figmaMessageToLayers(message: any, opts: FigmaConvertOptions = {}): { layers: Layer[]; roots: string[]; assets: Asset[]; design: FigmaDesignData } {
  const c = new Converter(message, opts);
  const roots = c.run();
  const design: FigmaDesignData = {
    tokens: [...c.tokens.values()],
    refs: c.refs,
    // an instance nested in another pasted instance follows its outer instance (one link per layer)
    instances: c.instances.filter(i => !i.inInstance).map(i => ({ layer: i.layer, key: i.key, name: i.name })),
    defs: [...c.defs.values()],
    defLayers: c.defLayers,
    ...(c.mode ? { mode: c.mode } : {}),
    ...(c.warnings.size ? { warnings: [...c.warnings].map(([m, k]) => (k > 1 ? `${m} (${k}x)` : m)) } : {}),
  };
  return { layers: c.layers, roots, assets: c.assets, design };
}
