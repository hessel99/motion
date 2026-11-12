// after effects .aep parser -> raw project tree.
//
// byte layouts follow the py-aep (forticheprod/aep_parser) format spec, docs/file_format.md.
// verification status per structure (see also the report in tests/aep.test.ts):
//   verified on real files (boltframe/aftereffects-aep-parser data/*.aep, matching that
//   project's own test expectations): RIFX walk, LIST:Fold/Item/Sfdr tree, idta (type, id),
//   item names, cdta (size, frame rate, duration, bg colour), sspc size, opti solid record,
//   ldta flag bits / quality / layer type, tdgp/tdmn/tdbs/tdb4/cdat static values, btdk text.
//   from the spec only (no keyframed sample available offline): lhd3/ldat keyframe items,
//   shape path (om-s/shap/shph) vertex lists, ldta parent id / timing fields, GCst gradients.
//
// values are kept in ae's *stored* units here (opacity/scale as fractions, colours as
// A,R,G,B 0..255, anchor of source-backed layers possibly as a fraction of the source).
// conversion to our units happens in convert.ts.

import { readRifx, find, findList, lists, tdgpEntries, utf8, type Chunk, type Reader } from './riff';
import { textDocs, type AepTextDoc } from './cos';

// ---------------------------------------------------------------- types

export const INTERP_LINEAR = 1, INTERP_BEZIER = 2, INTERP_HOLD = 3;

export interface AepKeyframe {
  /** layer time in seconds (time units / tdb4 time base) */
  time: number;
  /** raw time units */
  units: number;
  /** 1 linear, 2 bezier, 3 hold */
  inInterp: number;
  outInterp: number;
  /** key flags: bit3 temporal continuous, bit4 temporal auto-bezier, bit5 roving */
  flags: number;
  /** spatial flags (single-ease layout only): bit0 continuous, bit1 auto-bezier */
  spatialFlags: number;
  /** value (stored units); empty for valueless streams (paths, text, gradients) */
  value: number[];
  /** temporal ease, per dimension (or a single entry for single-ease streams). influences are fractions 0..1 */
  inSpeed: number[];
  inInfluence: number[];
  outSpeed: number[];
  outInfluence: number[];
  /** spatial tangents relative to the value (spatial streams only) */
  inTangent?: number[];
  outTangent?: number[];
}

export interface AepStream {
  kind: 'stream';
  matchName: string;
  name?: string;
  enabled: boolean;
  /** tdsb bit 11: separated dimensions leader (ADBE Position) */
  separated: boolean;
  /** tdsb bit 1: hidden in the timeline (e.g. unused half of a separable position) */
  hidden: boolean;
  dims: number;
  /** tdb4 stream flags bit 1: one temporal ease for the whole value */
  singleEase: boolean;
  /** tdb4 stream flags bit 3: motion path stream */
  spatial: boolean;
  color: boolean;
  valueless: boolean;
  timeBase: number;
  arcAccuracy: number;
  /** static value (stored units); null when keyframed or valueless */
  value: number[] | null;
  keyframes: AepKeyframe[] | null;
  expression?: string;
  /** tdb4 0x77 bit 0: the expression is switched off (kept, not evaluated) */
  expressionDisabled?: boolean;
}

export interface AepPathValue {
  closed: boolean;
  /** absolute vertex positions */
  vertices: number[][];
  /** absolute out control point of vertex i (towards i+1) */
  outPoints: number[][];
  /** absolute in control point of vertex i (from i-1) */
  inPoints: number[][];
}

export interface AepPathProp { kind: 'path'; matchName: string; name?: string; enabled: boolean; stream: AepStream | null; values: AepPathValue[] }
export interface AepTextProp { kind: 'text'; matchName: string; stream: AepStream | null; docs: AepTextDoc[] }
export interface AepGradientProp { kind: 'gradient'; matchName: string; stream: AepStream | null; stops: { pos: number; color: [number, number, number, number] }[] }
export interface AepOther { kind: 'other'; matchName: string; name?: string; tag: string }

export interface AepGroup {
  kind: 'group';
  matchName: string;
  name?: string;
  enabled: boolean;
  children: AepNode[];
  /** mask settings (mkif) when this group is an 'ADBE Mask Atom' */
  mask?: AepMaskInfo;
}

/** mkif: mode 0 none, 1 add, 2 subtract, 3 intersect, 4 lighten, 5 darken, 6 difference */
export interface AepMaskInfo { inverted: boolean; mode: number }

export type AepNode = AepGroup | AepStream | AepPathProp | AepTextProp | AepGradientProp | AepOther;

export type AepLayerKind = 'av' | 'light' | 'camera' | 'text' | 'shape' | 'model' | 'mesh' | 'unknown';

export interface AepLayer {
  id: number;
  /** 0 = top of the timeline */
  index: number;
  name: string;
  kind: AepLayerKind;
  rawType: number;
  sourceId: number;
  parentId: number;
  matteLayerId: number;
  quality: number;
  label: number;
  /** ldta 0x63, the AE SDK PF_Xfer value: 2 normal, 4 add, 5 multiply, 6 screen, 10 darken, 11 lighten, ... */
  blendMode: number;
  /** 0 none, 1 alpha, 2 alpha inverted, 3 luma, 4 luma inverted */
  trackMatte: number;
  /** composition seconds */
  startTime: number;
  /** 1 = 100 % */
  stretch: number;
  /** layer time seconds (from start time, unstretched) */
  inPoint: number;
  outPoint: number;
  /** composition seconds */
  compIn: number;
  compOut: number;
  flags: {
    guide: boolean; adjustment: boolean; threeD: boolean; solo: boolean; null: boolean;
    video: boolean; audio: boolean; effects: boolean; motionBlur: boolean; frameBlend: boolean;
    locked: boolean; shy: boolean; collapse: boolean; frameBlendPixelMotion: boolean; bicubic: boolean;
  };
  root: AepGroup | null;
  /** convenience: root child 'ADBE Transform Group' */
  transform: AepGroup | null;
  /** parse error of this layer (layer kept with defaults) */
  error?: string;
}

export interface AepFolder { type: 'folder'; id: number; name: string; label: number; children: AepItem[] }
export interface AepComp {
  type: 'comp'; id: number; name: string; label: number;
  width: number; height: number; fps: number; duration: number; timeBase: number;
  pixelAspect: number; bgColor: [number, number, number];
  workAreaStart: number; workAreaEnd: number | null; displayStart: number;
  layers: AepLayer[];
}
export interface AepFootage {
  type: 'footage'; id: number; name: string; label: number;
  source: 'solid' | 'file' | 'placeholder' | 'unknown';
  format: string;
  width: number; height: number; duration: number; fps: number;
  /** solid colour rgb 0..1 */
  color?: [number, number, number];
  path?: string;
}
export type AepItem = AepFolder | AepComp | AepFootage;

export interface AepProject {
  /** first u2 of 'head' (file format major, e.g. 93..97) */
  fileVersion: number;
  bitsPerChannel: 8 | 16 | 32;
  expressionEngine?: string;
  root: AepFolder;
  items: Map<number, AepItem>;
  comps: AepComp[];
  /** non-fatal problems found while parsing */
  warnings: string[];
}

// ---------------------------------------------------------------- parser

const ratio = (a: number, b: number) => (b ? a / b : 0);

class P {
  warnings: string[] = [];
  items = new Map<number, AepItem>();
  comps: AepComp[] = [];
  constructor(readonly r: Reader) {}

  // ------------- items -------------

  folderChildren(list: Chunk, depth: number): AepItem[] {
    const out: AepItem[] = [];
    if (depth > 64) return out;
    for (const k of list.kids ?? []) {
      if (k.tag !== 'LIST' || k.list !== 'Item') continue;
      try {
        const it = this.item(k, depth);
        if (it) { out.push(it); this.items.set(it.id, it); }
      } catch (e) {
        this.warnings.push(`item: ${(e as Error).message}`);
      }
    }
    return out;
  }

  item(c: Chunk, depth: number): AepItem | null {
    const r = this.r;
    const idta = find(c, 'idta');
    if (!idta) return null;
    const type = r.u2(idta.off);
    const id = r.u4(idta.off + 0x10);
    const label = idta.len > 0x3a ? r.u1(idta.off + 0x3a) : 0;
    // name: the first Utf8 after idta
    const kids = c.kids!;
    let name = '';
    const ii = kids.indexOf(idta);
    for (let j = ii + 1; j < kids.length; j++) if (kids[j].tag === 'Utf8') { name = utf8(r, kids[j]); break; }
    if (type === 1) {
      const sf = findList(c, 'Sfdr');
      return { type: 'folder', id, name, label, children: sf ? this.folderChildren(sf, depth + 1) : [] };
    }
    if (type === 4) return this.comp(c, id, name, label);
    if (type === 7) return this.footage(c, id, name, label);
    return null;
  }

  comp(c: Chunk, id: number, name: string, label: number): AepComp {
    const r = this.r;
    const cd = find(c, 'cdta');
    const o = cd ? cd.off : -1;
    const g = (off: number) => (o >= 0 && off + 4 <= cd!.len ? r.u4(o + off) : 0);
    const gs = (off: number) => (o >= 0 && off + 4 <= cd!.len ? r.s4(o + off) : 0);
    const timeScale256 = g(0x04);
    const timeBase = g(0x08);
    let fps = timeScale256 ? timeBase / timeScale256 : 0;
    const fixed = g(0x9c) / 65536;
    if (!(fps > 0 && fps < 10000)) fps = fixed;
    if (!(fps > 0)) fps = 30;
    const waEnd = g(0x24);
    const comp: AepComp = {
      type: 'comp', id, name, label,
      width: o >= 0 ? r.u2(o + 0x8c) : 0,
      height: o >= 0 ? r.u2(o + 0x8e) : 0,
      fps, timeBase,
      duration: ratio(g(0x2c), g(0x30)),
      pixelAspect: ratio(g(0x90), g(0x94)) || 1,
      bgColor: o >= 0 ? [r.u1(o + 0x34), r.u1(o + 0x35), r.u1(o + 0x36)] : [0, 0, 0],
      workAreaStart: ratio(gs(0x1c), g(0x20)),
      workAreaEnd: waEnd === 0xffffffff ? null : ratio(waEnd, g(0x28)),
      displayStart: ratio(gs(0xa4), g(0xa8)),
      layers: [],
    };
    let index = 0;
    for (const k of c.kids ?? []) {
      if (k.tag !== 'LIST' || k.list !== 'Layr') continue;
      comp.layers.push(this.layer(k, index++, timeBase));
    }
    this.comps.push(comp);
    return comp;
  }

  footage(c: Chunk, id: number, name: string, label: number): AepFootage {
    const r = this.r;
    const pin = findList(c, 'Pin ');
    const f: AepFootage = { type: 'footage', id, name, label, source: 'unknown', format: '', width: 0, height: 0, duration: 0, fps: 0 };
    if (!pin) return f;
    const sspc = find(pin, 'sspc');
    if (sspc && sspc.len >= 0x3e) {
      const o = sspc.off;
      f.format = r.fourcc(o + 0x16).replace(/\0/g, '');
      f.width = r.u4(o + 0x1e);
      f.height = r.u4(o + 0x22);
      f.duration = ratio(r.u4(o + 0x26), r.u4(o + 0x2a));
      f.fps = r.u4(o + 0x3a) / 65536;
    }
    const opti = find(pin, 'opti');
    if (opti && opti.len >= 10) {
      const o = opti.off;
      const kind = r.fourcc(o);
      if (kind === 'Soli' && opti.len >= 0x1a) {
        f.source = 'solid';
        f.color = [r.f4(o + 0x0e), r.f4(o + 0x12), r.f4(o + 0x16)];
        if (!f.name) f.name = r.str(o + 0x1a, Math.min(256, opti.len - 0x1a), true);
      } else if (kind === '\0\0\0\0') {
        f.source = 'placeholder';
        if (!f.name) f.name = r.str(o + 0x0a, Math.min(256, opti.len - 0x0a), true);
      } else f.source = 'file';
    } else if (f.format) f.source = 'file';
    const als = findList(pin, 'Als2');
    const alas = als ? find(als, 'alas') : undefined;
    if (alas) {
      try {
        const j = JSON.parse(r.str(alas.off, alas.len));
        if (typeof j.fullpath === 'string') f.path = j.fullpath;
      } catch { /* ignore */ }
    }
    if (!f.name && f.path) f.name = f.path.split(/[\\/]/).pop() ?? '';
    return f;
  }

  // ------------- layers -------------

  layer(c: Chunk, index: number, compTimeBase: number): AepLayer {
    const r = this.r;
    const ld = find(c, 'ldta');
    const o = ld ? ld.off : 0;
    const has = (off: number, n = 4) => !!ld && off + n <= ld.len;
    const u4 = (off: number) => (has(off) ? r.u4(o + off) : 0);
    const s4 = (off: number) => (has(off) ? r.s4(o + off) : 0);
    const u1 = (off: number) => (has(off, 1) ? r.u1(o + off) : 0);
    const a = u1(0x25), b = u1(0x26), cc = u1(0x27);
    const rawType = u1(0x83);
    const kinds: AepLayerKind[] = ['av', 'light', 'camera', 'text', 'shape', 'model', 'unknown', 'mesh'];
    const stretchDiv = u4(0x6c);
    const stretch = stretchDiv ? s4(0x08) / stretchDiv : 1;
    const startTime = ratio(s4(0x0c), u4(0x10));
    const inPoint = ratio(s4(0x14), u4(0x18));
    const outPoint = ratio(s4(0x1c), u4(0x20));
    const st = Math.abs(stretch) || 1;
    // name: Utf8 right after ldta
    let name = '';
    const kids = c.kids ?? [];
    const li = ld ? kids.indexOf(ld) : -1;
    if (li >= 0 && kids[li + 1]?.tag === 'Utf8') name = utf8(r, kids[li + 1]);
    else if (ld) name = r.str(o + 0x40, 32, true);
    const layer: AepLayer = {
      id: u4(0x00), index, name,
      kind: kinds[rawType] ?? 'unknown', rawType,
      sourceId: u4(0x28), parentId: u4(0x84), matteLayerId: has(0xa0) ? u4(0xa0) : 0,
      quality: has(0x04, 2) ? r.u2(o + 0x04) : 0, label: u1(0x3d), blendMode: u1(0x63), trackMatte: u1(0x6b),
      startTime, stretch, inPoint, outPoint,
      compIn: startTime + inPoint * st, compOut: startTime + outPoint * st,
      flags: {
        guide: !!(a & 0x02), frameBlendPixelMotion: !!(a & 0x04), bicubic: !!(a & 0x40),
        adjustment: !!(b & 0x02), threeD: !!(b & 0x04), solo: !!(b & 0x08), null: !!(b & 0x80),
        video: !!(cc & 0x01), audio: !!(cc & 0x02), effects: !!(cc & 0x04), motionBlur: !!(cc & 0x08),
        frameBlend: !!(cc & 0x10), locked: !!(cc & 0x20), shy: !!(cc & 0x40), collapse: !!(cc & 0x80),
      },
      root: null, transform: null,
    };
    if (layer.kind === 'unknown' && rawType === 0) layer.kind = 'av';
    try {
      const tdgp = findList(c, 'tdgp');
      if (tdgp) {
        layer.root = this.group(tdgp, 'root', compTimeBase, 0);
        layer.transform = (layer.root.children.find(n => n.matchName === 'ADBE Transform Group' && n.kind === 'group') as AepGroup) ?? null;
      }
    } catch (e) {
      layer.error = (e as Error).message;
      this.warnings.push(`layer ${layer.name || layer.id}: ${layer.error}`);
    }
    return layer;
  }

  // ------------- property tree -------------

  group(c: Chunk, matchName: string, tb: number, depth: number): AepGroup {
    const r = this.r;
    const tdsb = find(c, 'tdsb');
    const g: AepGroup = { kind: 'group', matchName, enabled: tdsb ? !!(r.u4(tdsb.off) & 1) : true, children: [] };
    const nm = find(c, 'tdsn');
    if (nm) { const s = utf8(r, nm); if (s && s !== '-_0_/-') g.name = s; }
    if (depth > 48) return g;
    for (const { mn, body } of tdgpEntries(r, c)) {
      try {
        const node = this.child(mn, body, tb, depth);
        if (node) g.children.push(node);
      } catch (e) {
        this.warnings.push(`${mn}: ${(e as Error).message}`);
      }
    }
    return g;
  }

  child(mn: string, body: Chunk[], tb: number, depth: number): AepNode | null {
    const first = body[0];
    if (!first) return null;
    if (first.tag === 'LIST') {
      switch (first.list) {
        case 'tdgp': return this.group(first, mn, tb, depth + 1);
        case 'tdbs': return this.stream(first, mn, tb);
        case 'om-s': return this.pathProp(first, mn, tb);
        case 'btds': return this.textProp(first, mn, tb);
        case 'GCst': return this.gradientProp(first, mn, tb);
        default: return { kind: 'other', matchName: mn, tag: `LIST:${first.list}` };
      }
    }
    // mask atom: mkif then LIST:tdgp
    const sub = body.find(k => k.tag === 'LIST' && k.list === 'tdgp');
    if (sub) {
      const g = this.group(sub, mn, tb, depth + 1);
      const mk = body.find(k => k.tag === 'mkif');
      if (mk && mk.len >= 8) g.mask = { inverted: this.r.u1(mk.off) === 1, mode: this.r.u4(mk.off + 4) };
      return g;
    }
    return { kind: 'other', matchName: mn, tag: first.tag };
  }

  stream(c: Chunk, mn: string, tb: number): AepStream {
    const r = this.r;
    const tdsb = find(c, 'tdsb');
    const sb = tdsb ? r.u4(tdsb.off) : 1;
    const s: AepStream = {
      kind: 'stream', matchName: mn, enabled: !!(sb & 1), separated: !!(sb & 0x800), hidden: !!(sb & 2),
      dims: 1, singleEase: false, spatial: false, color: false, valueless: false, timeBase: tb, arcAccuracy: 0,
      value: null, keyframes: null,
    };
    const nm = find(c, 'tdsn');
    if (nm) { const n = utf8(r, nm); if (n && n !== '-_0_/-') s.name = n; }
    const t4 = find(c, 'tdb4');
    if (t4 && t4.len >= 0x46) {
      const o = t4.off;
      s.dims = Math.max(1, Math.min(4, r.u2(o + 0x02)));
      const fl = r.u2(o + 0x04);
      s.singleEase = !!(fl & 2);
      s.spatial = !!(fl & 8);
      s.timeBase = r.u4(o + 0x0c) || tb;
      s.arcAccuracy = r.f8(o + 0x10);
      s.valueless = !!(r.u2(o + 0x38) & 1);
      s.color = !!(r.u1(o + 0x3b) & 1) || (s.dims === 4 && s.singleEase && !s.spatial && !s.valueless);
      if (t4.len >= 0x7c && r.u4(o + 0x78) && (r.u1(o + 0x77) & 1)) s.expressionDisabled = true;
    }
    const cdat = find(c, 'cdat');
    const kl = findList(c, 'list');
    if (kl) s.keyframes = this.keyframes(kl, s);
    else if (cdat && !s.valueless) {
      const v: number[] = [];
      for (let d = 0; d < s.dims && (d + 1) * 8 <= cdat.len; d++) v.push(r.f8(cdat.off + d * 8));
      s.value = v;
    }
    // expression: Utf8 right after the value
    const kids = c.kids ?? [];
    const vi = kids.indexOf((kl ?? cdat)!);
    if (vi >= 0) {
      const nx = kids[vi + 1];
      if (nx?.tag === 'Utf8') s.expression = utf8(r, nx);
      else if (nx?.tag === 'expr') s.expression = r.str(nx.off, nx.len, true);
    }
    return s;
  }

  keyframes(list: Chunk, s: AepStream): AepKeyframe[] {
    const r = this.r;
    const h = find(list, 'lhd3'), d = find(list, 'ldat');
    if (!h || !d || h.len < 0x18) return [];
    const count = r.u4(h.off + 0x08), size = r.u4(h.off + 0x10);
    if (!size || size > 4096) return [];
    const n = Math.min(count, Math.floor(d.len / size));
    const dims = s.dims, tb = s.timeBase || 1;
    const out: AepKeyframe[] = new Array(n);
    const f8s = (off: number, k: number, end: number) => {
      const a: number[] = new Array(k);
      for (let j = 0; j < k; j++) a[j] = off + 8 * (j + 1) <= end ? r.f8(off + 8 * j) : 0;
      return a;
    };
    for (let i = 0; i < n; i++) {
      const o = d.off + i * size, end = o + size;
      const units = r.s4(o);
      const k: AepKeyframe = {
        time: units / tb, units, inInterp: r.u1(o + 4), outInterp: r.u1(o + 5), flags: r.u2(o + 6), spatialFlags: 0,
        value: [], inSpeed: [0], inInfluence: [1 / 6], outSpeed: [0], outInfluence: [1 / 6],
      };
      if (s.singleEase) {
        k.spatialFlags = r.u4(o + 0x08);
        k.inSpeed = [r.f8(o + 0x18)];
        k.inInfluence = [r.f8(o + 0x20)];
        k.outSpeed = [r.f8(o + 0x28)];
        k.outInfluence = [r.f8(o + 0x30)];
        if (!s.valueless && size >= 0x38 + 8 * dims) {
          k.value = f8s(o + 0x38, dims, end);
          if (s.spatial) {
            k.inTangent = f8s(o + 0x38 + 8 * dims, dims, end);
            k.outTangent = f8s(o + 0x38 + 16 * dims, dims, end);
          }
        }
      } else if (!s.valueless && size >= 8 + 40 * dims) {
        const b = o + 8;
        k.value = f8s(b, dims, end);
        k.inSpeed = f8s(b + 8 * dims, dims, end);
        k.inInfluence = f8s(b + 16 * dims, dims, end);
        k.outSpeed = f8s(b + 24 * dims, dims, end);
        k.outInfluence = f8s(b + 32 * dims, dims, end);
      }
      out[i] = k;
    }
    return out;
  }

  pathProp(c: Chunk, mn: string, tb: number): AepPathProp {
    const r = this.r;
    const tdbs = findList(c, 'tdbs');
    const stream = tdbs ? this.stream(tdbs, mn, tb) : null;
    const p: AepPathProp = { kind: 'path', matchName: mn, enabled: stream?.enabled ?? true, stream, values: [] };
    const omks = findList(c, 'omks');
    for (const shap of lists(omks, 'shap')) {
      const shph = find(shap, 'shph');
      const pl = findList(shap, 'list');
      if (!shph || !pl) continue;
      const fl = r.u1(shph.off + 3);
      const normalized = !!(fl & 1);
      const x0 = r.f4(shph.off + 4), y0 = r.f4(shph.off + 8), x1 = r.f4(shph.off + 12), y1 = r.f4(shph.off + 16);
      const h = find(pl, 'lhd3'), d = find(pl, 'ldat');
      const pts: number[][] = [];
      if (h && d) {
        const size = r.u4(h.off + 0x10) || 8;
        const count = Math.min(r.u4(h.off + 0x08), Math.floor(d.len / size));
        for (let i = 0; i < count; i++) {
          const nx = r.f4(d.off + i * size), ny = r.f4(d.off + i * size + 4);
          pts.push(normalized ? [x0 + nx * (x1 - x0), y0 + ny * (y1 - y0)] : [nx, ny]);
        }
      }
      const n = Math.floor(pts.length / 3);
      const v: AepPathValue = { closed: !(fl & 8), vertices: [], outPoints: [], inPoints: [] };
      for (let i = 0; i < n; i++) {
        v.vertices.push(pts[3 * i]);
        v.outPoints.push(pts[3 * i + 1]);
        v.inPoints.push(pts[(3 * i - 1 + 3 * n) % (3 * n)]);
      }
      p.values.push(v);
    }
    return p;
  }

  textProp(c: Chunk, mn: string, tb: number): AepTextProp {
    const r = this.r;
    const tdbs = findList(c, 'tdbs');
    const btdk = findList(c, 'btdk');
    let docs: AepTextDoc[] = [];
    if (btdk) { try { docs = textDocs(r.bytes(btdk.off, btdk.len)); } catch { /* ignore */ } }
    return { kind: 'text', matchName: mn, stream: tdbs ? this.stream(tdbs, mn, tb) : null, docs };
  }

  gradientProp(c: Chunk, mn: string, tb: number): AepGradientProp {
    const r = this.r;
    const tdbs = findList(c, 'tdbs');
    const gcky = findList(c, 'GCky');
    const first = gcky?.kids?.find(k => k.tag === 'Utf8');
    return { kind: 'gradient', matchName: mn, stream: tdbs ? this.stream(tdbs, mn, tb) : null, stops: first ? parseGradientXml(utf8(r, first)) : [] };
  }
}

/**
 * reader for the gradient xml stored in GCky (layout from the py-aep spec "Gradient XML";
 * not verified on a real file). colour stops: "Stops Color" arrays = location, midpoint,
 * r, g, b (0..1), 1. alpha stops: "Stops Alpha" arrays = location, midpoint, alpha.
 */
export function parseGradientXml(xml: string): { pos: number; color: [number, number, number, number] }[] {
  const arrays = (key: string) => {
    const out: number[][] = [];
    const re = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`, 'g');
    for (const m of xml.matchAll(re)) out.push(Array.from(m[1].matchAll(/<float>\s*([^<\s]+)\s*<\/float>/g)).map(x => parseFloat(x[1])));
    return out;
  };
  const colors = arrays('Stops Color').filter(a => a.length >= 5).sort((a, b) => a[0] - b[0]);
  const alphas = arrays('Stops Alpha').filter(a => a.length >= 3).sort((a, b) => a[0] - b[0]);
  const alphaAt = (p: number) => {
    if (!alphas.length) return 1;
    if (p <= alphas[0][0]) return alphas[0][2];
    for (let i = 0; i + 1 < alphas.length; i++) {
      const a = alphas[i], b = alphas[i + 1];
      if (p <= b[0]) return a[2] + (b[2] - a[2]) * (b[0] > a[0] ? (p - a[0]) / (b[0] - a[0]) : 0);
    }
    return alphas[alphas.length - 1][2];
  };
  return colors
    .map(c => ({ pos: c[0], color: [c[2], c[3], c[4], alphaAt(c[0])] as [number, number, number, number] }))
    .filter(s => isFinite(s.pos) && s.color.every(isFinite));
}

/** parse an .aep file into the raw project tree. throws only when the data is not a RIFX file */
export function parseAep(buf: ArrayBuffer): AepProject {
  const rifx = readRifx(buf);
  if (!rifx || rifx.form !== 'Egg!') throw new Error('not an after effects project (missing RIFX/Egg! header)');
  const { reader: r, root } = rifx;
  const p = new P(r);
  const head = find(root, 'head');
  const nhed = find(root, 'nhed');
  const bpcByte = nhed && nhed.len > 15 ? r.u1(nhed.off + 15) : 0;
  const exen = findList(root, 'ExEn');
  const fold = findList(root, 'Fold');
  const rootFolder: AepFolder = { type: 'folder', id: 0, name: 'root', label: 0, children: [] };
  if (fold) rootFolder.children = p.folderChildren(fold, 0);
  else p.warnings.push('no LIST:Fold');
  return {
    fileVersion: head ? r.u2(head.off) : 0,
    bitsPerChannel: bpcByte === 2 ? 32 : bpcByte === 1 ? 16 : 8,
    expressionEngine: exen ? utf8(r, find(exen, 'Utf8')) : undefined,
    root: rootFolder,
    items: p.items,
    comps: p.comps,
    warnings: p.warnings,
  };
}

// ---------------------------------------------------------------- tree helpers

export function child(g: AepGroup | null | undefined, mn: string): AepNode | undefined {
  if (!g) return undefined;
  for (const c of g.children) if (c.matchName === mn) return c;
  return undefined;
}
export function childStream(g: AepGroup | null | undefined, mn: string): AepStream | undefined {
  const c = child(g, mn);
  return c && c.kind === 'stream' ? c : undefined;
}
export function childGroup(g: AepGroup | null | undefined, mn: string): AepGroup | undefined {
  const c = child(g, mn);
  return c && c.kind === 'group' ? c : undefined;
}
