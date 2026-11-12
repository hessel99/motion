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

import { decodeVectorNetwork } from './vectornet';
import { createLayer, uid, type Asset, type Layer, type LayerType, type Paint, type PathCmd, type PathGeometry, type TextData } from '../../core/model';
import { bytesToBase64 } from './decode';
import type { IncomingToken } from '../../core/token-sync';

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

// ---------------- converter ----------------

interface OverrideLevel {
  /** overrides of one instance, keyed by guidPath ("s:l/s:l") relative to that instance */
  map: Map<string, any[]>;
  /** path of the current node relative to that instance */
  path: string;
  /** same path using the node's overrideKey for the last segment (newer files) */
  alt?: string;
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

  constructor(private message: any) {
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
    const n = applyOverrides(raw, levels);
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
        childLevels = [...levels, { map, path: '' }];
        // keep the instance's own paints if it has none (instances inherit the component's look)
        if (!n.fillPaints && sym.fillPaints && layer.type === 'group') this.applyFrameFill(layer, sym);
      }
    }
    if (isInstance) this.instanceDepth++;
    if (kids) {
      for (const k of kids) {
        const seg = gkey(k.guid);
        const altSeg = k.overrideKey ? gkey(k.overrideKey) : '';
        const lv: OverrideLevel[] = childLevels.map(l => ({ map: l.map, path: l.path ? `${l.path}/${seg}` : seg, alt: altSeg ? (l.path ? `${l.path}/${altSeg}` : altSeg) : '' }));
        const cid = this.emit(k, layer.id, lv, depth + (childLevels !== levels ? 1 : 0));
        if (cid) layer.children.push(cid);
      }
    }
    if (isInstance) this.instanceDepth--;
    return layer.id;
  }

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
    else lt = hasGeom ? 'path' : 'group';

    // image fill with embedded bytes on a plain rectangle -> image layer
    const imgAsset = lt === 'rect' ? this.topImageAsset(n.fillPaints) : null;
    if (imgAsset) lt = 'image';

    const layer = createLayer(lt, { w, h });
    layer.name = typeof n.name === 'string' && n.name ? n.name : layer.name;
    layer.visible = n.visible !== false;
    setTransform(layer, n.transform, w, h);
    layer.props.opacity!.v = [Math.max(0, Math.min(100, num(n.opacity, 1) * 100))];
    if (n.isMask || n.mask) layer.mask = true; // masks the siblings above it
    const bm: Record<string, Layer['blend']> = { MULTIPLY: 'multiply', SCREEN: 'screen', LINEAR_DODGE: 'add', DARKEN: 'darken', LIGHTEN: 'lighten' };
    if (typeof n.blendMode === 'string' && bm[n.blendMode]) layer.blend = bm[n.blendMode];

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
        this.applyFrameFill(layer, n);
        layer.clip = n.frameMaskDisabled !== true && n.clipsContent !== false;
        layer.props.radius!.v = cornerRadii(n, w, h);
      }
      this.applyStroke(layer, n, false);
      return layer;
    }

    if (lt === 'text') {
      layer.text = textData(n);
      layer.props.fill!.v = topSolid(n.fillPaints) ?? firstGradientColor(n.fillPaints) ?? [0, 0, 0, 1];
      return layer;
    }

    this.applyFills(layer, n.fillPaints);
    if (lt === 'rect') layer.props.radius!.v = cornerRadii(n, w, h);
    if (lt === 'path') {
      layer.geometry = this.geoms(n.fillGeometry);
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
          }
        }
      }
    }
    this.applyStroke(layer, n, lt === 'path');
    return layer;
  }

  private applyFrameFill(layer: Layer, n: any) {
    this.applyFills(layer, n.fillPaints);
  }

  /** solid -> props.fill; any gradient -> layer.paints (all visible paints, bottom -> top) */
  private applyFills(layer: Layer, paints: any[] | undefined) {
    const vis = (paints ?? []).filter(visiblePaint);
    const solid = topSolid(vis);
    layer.props.fill!.v = solid ?? [0, 0, 0, 0];
    const hasGradient = vis.some(p => p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND');
    if (!hasGradient) {
      if (!solid && vis.some(p => p.type === 'IMAGE' || p.type === 'VIDEO')) layer.props.fill!.v = [0.8, 0.8, 0.8, 1]; // placeholder
      return;
    }
    const out: Paint[] = [];
    for (const p of vis) {
      const op = num(p.opacity, 1);
      if (p.type === 'SOLID') out.push({ type: 'solid', color: colorOf(p.color), opacity: op });
      else if (p.type && p.type.startsWith('GRADIENT_')) {
        const m = p.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
        const fig = [num(m.m00, 1), num(m.m10, 0), num(m.m01, 0), num(m.m11, 1), num(m.m02, 0), num(m.m12, 0)];
        const stops = (p.stops ?? []).map((s: any) => ({ pos: num(s.position, 0), color: colorOf(s.color) })).sort((a: any, b: any) => a.pos - b.pos);
        // angular / diamond have no renderer equivalent: approximate with radial
        out.push({ type: p.type === 'GRADIENT_LINEAR' ? 'linear' : 'radial', stops, transform: invert6(fig), opacity: op });
      } else if (p.type === 'IMAGE' || p.type === 'VIDEO') {
        out.push({ type: 'solid', color: [0.8, 0.8, 0.8, 1], opacity: op });
      }
    }
    layer.paints = out;
  }

  private applyStroke(layer: Layer, n: any, isPath: boolean) {
    const color = topSolid(n.strokePaints) ?? firstGradientColor(n.strokePaints);
    const weight = num(n.strokeWeight, 0);
    if (!color || weight <= 0) {
      if (layer.props.stroke) layer.props.stroke.v = [0, 0, 0, 0];
      if (layer.props.strokeWidth) layer.props.strokeWidth.v = [0];
      return;
    }
    if (layer.props.stroke) layer.props.stroke.v = color;
    if (layer.props.strokeWidth) layer.props.strokeWidth.v = [weight];
    const a = n.strokeAlign;
    layer.strokeAlign = a === 'INSIDE' ? 'inside' : a === 'OUTSIDE' ? 'outside' : 'center';
    if (isPath && n.strokeGeometry?.length) layer.strokeGeometry = this.geoms(n.strokeGeometry);
  }

  private geoms(list: any[] | undefined): PathGeometry[] {
    const out: PathGeometry[] = [];
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
      if (cmds.length) out.push({ cmds, fillRule: g.windingRule === 'NONZERO' || g.windingRule == null ? 'nonzero' : 'evenodd' });
    }
    return out;
  }

  private topImageAsset(paints: any[] | undefined): Asset | null {
    if (!paints) return null;
    for (let i = paints.length - 1; i >= 0; i--) {
      const p = paints[i];
      if (!visiblePaint(p)) continue;
      if (p.type !== 'IMAGE') return null; // something else is on top
      const blobIdx = p.image?.dataBlob;
      const bytes = typeof blobIdx === 'number' ? blobBytes(this.blobs[blobIdx]) : null;
      if (!bytes || bytes.length < 8) return null;
      const hash = p.image?.hash ? Array.from(blobBytes(p.image.hash) ?? []).join(',') : `blob${blobIdx}`;
      let asset = this.assetByHash.get(hash);
      if (!asset) {
        const info = imageInfo(bytes);
        asset = { id: uid('a'), kind: 'image', mime: info.mime, data: `data:${info.mime};base64,${bytesToBase64(bytes)}`, width: info.width, height: info.height };
        this.assetByHash.set(hash, asset);
        this.assets.push(asset);
      }
      return asset;
    }
    return null;
  }
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
  let content: string = n.textData?.characters ?? '';
  if (n.textCase === 'UPPER') content = content.toUpperCase();
  else if (n.textCase === 'LOWER') content = content.toLowerCase();
  return {
    content,
    fontFamily: n.fontName?.family ?? 'Inter',
    fontSize,
    fontWeight: weightFromStyle(style),
    fontStyle: /italic|oblique/i.test(style) ? 'italic' : 'normal',
    lineHeight: lineHeight > 0 ? lineHeight : 1.2,
    letterSpacing,
    align: ah === 'CENTER' ? 'center' : ah === 'RIGHT' ? 'right' : 'left',
  };
}

export function figmaMessageToLayers(message: any): { layers: Layer[]; roots: string[]; assets: Asset[]; design: FigmaDesignData } {
  const c = new Converter(message);
  const roots = c.run();
  const design: FigmaDesignData = {
    tokens: [...c.tokens.values()],
    refs: c.refs,
    // an instance nested in another pasted instance follows its outer instance (one link per layer)
    instances: c.instances.filter(i => !i.inInstance).map(i => ({ layer: i.layer, key: i.key, name: i.name })),
    defs: [...c.defs.values()],
    defLayers: c.defLayers,
    ...(c.mode ? { mode: c.mode } : {}),
  };
  return { layers: c.layers, roots, assets: c.assets, design };
}
