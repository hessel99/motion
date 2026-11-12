// .aep importer tests built on a synthetic RIFX writer. byte layouts follow the py-aep
// format spec (forticheprod/aep_parser docs/file_format.md); the container walk, item /
// comp / footage / layer-flag / static-value / text decoding were also checked against the
// real sample projects of boltframe/aftereffects-aep-parser (see src/import/aep/parse.ts).
import { describe, it, expect } from 'vitest';
import { parseAep, aepToProject, childStream, type AepStream } from '../src/import/aep';
import { readRifx } from '../src/import/aep/riff';
import { textDocs } from '../src/import/aep/cos';
import { evalProp } from '../src/core/evaluate';
import type { Layer, Project } from '../src/core/model';

// ------------------------------------------------------------------ writer

class W {
  b: number[] = [];
  u1(v: number) { this.b.push(v & 255); return this; }
  u2(v: number) { this.b.push((v >> 8) & 255, v & 255); return this; }
  u4(v: number) { this.b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); return this; }
  s4(v: number) { return this.u4(v >>> 0); }
  f4(v: number) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v); this.b.push(...new Uint8Array(d.buffer)); return this; }
  f8(v: number) { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v); this.b.push(...new Uint8Array(d.buffer)); return this; }
  str(s: string, len?: number) { const e = new TextEncoder().encode(s); const n = len ?? e.length; for (let i = 0; i < n; i++) this.b.push(e[i] ?? 0); return this; }
  zero(n: number) { for (let i = 0; i < n; i++) this.b.push(0); return this; }
  at(off: number, f: (w: W) => void) { const w = new W(); f(w); for (let i = 0; i < w.b.length; i++) this.b[off + i] = w.b[i]; return this; }
  bytes() { return Uint8Array.from(this.b); }
}

const fourcc = (s: string) => new W().str(s, 4).bytes();
function chunk(tag: string, body: Uint8Array): Uint8Array {
  const pad = body.length & 1;
  const out = new Uint8Array(8 + body.length + pad);
  out.set(fourcc(tag), 0);
  new DataView(out.buffer).setUint32(4, body.length);
  out.set(body, 8);
  return out;
}
const cat = (...parts: Uint8Array[]) => { const n = parts.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const list = (type: string, ...kids: Uint8Array[]) => chunk('LIST', cat(fourcc(type), ...kids));
const utf8 = (s: string) => chunk('Utf8', new TextEncoder().encode(s));
const tdmn = (mn: string) => chunk('tdmn', new W().str(mn, 40).bytes());
const tdsb = (v: number) => chunk('tdsb', new W().u4(v).bytes());
const tdsn = (s: string) => chunk('tdsn', utf8(s));
function file(...rootKids: Uint8Array[]): ArrayBuffer {
  const body = cat(fourcc('Egg!'), ...rootKids);
  const out = cat(fourcc('RIFX'), new W().u4(body.length).bytes(), body, new TextEncoder().encode('<?xpacket?>'));
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

const TB = 24576; // 24 fps time base

/** tdb4 (124 bytes) */
function tdb4(dims: number, flags: number, opts: { valueless?: boolean; color?: boolean; animated?: boolean; arc?: number } = {}) {
  const w = new W().zero(124);
  w.at(0, x => x.u2(0xdb99).u2(dims).u2(flags));
  w.at(0x0c, x => x.u4(TB).f8(opts.arc ?? 0.0001).f8(1).f8(1).f8(1).f8(1));
  w.at(0x38, x => x.u2(opts.valueless ? 1 : 0).u1(0).u1(opts.color ? 1 : 8));
  w.at(0x44, x => x.u1(opts.animated ? 1 : 0));
  return chunk('tdb4', w.bytes());
}
function cdat(vals: number[], per: number) {
  const w = new W();
  for (const v of vals) w.f8(v);
  w.zero((per - 1) * vals.length * 8);
  return chunk('cdat', w.bytes());
}
function kflist(itemSize: number, items: Uint8Array[]) {
  const h = new W().u4(0x00d00bee).u4(0).u4(items.length).u4(Math.max(1, Math.ceil(items.length / 4))).u4(itemSize).u4(4).u4(1).u4(Math.max(1, Math.ceil(items.length / 4)) * 4).zero(20);
  return list('list', chunk('lhd3', h.bytes()), chunk('ldat', cat(...items)));
}
/** non-single-ease keyframe item: header + value[d], inSpeed[d], inInf[d], outSpeed[d], outInf[d] */
function kfN(t: number, inI: number, outI: number, v: number[], inS: number[], inInf: number[], outS: number[], outInf: number[], flags = 0) {
  const w = new W().s4(Math.round(t * TB)).u1(inI).u1(outI).u2(flags);
  for (const a of [v, inS, inInf, outS, outInf]) for (const x of a) w.f8(x);
  return w.bytes();
}
/** single-ease spatial keyframe item (3D: 128 bytes) */
function kfS(t: number, inI: number, outI: number, v: number[], inS: number, inInf: number, outS: number, outInf: number, inTan: number[], outTan: number[], spatialFlags = 0) {
  const w = new W().s4(Math.round(t * TB)).u1(inI).u1(outI).u2(7).u4(spatialFlags).u4(0).f8(0).f8(inS).f8(inInf).f8(outS).f8(outInf);
  for (const a of [v, inTan, outTan]) for (const x of a) w.f8(x);
  return w.bytes();
}
const stream = (mn: string, ...kids: Uint8Array[]) => cat(tdmn(mn), list('tdbs', tdsb(1), tdsn('-_0_/-'), ...kids));
const group = (mn: string, name: string, ...entries: Uint8Array[]) => cat(tdmn(mn), list('tdgp', tdsb(1), tdsn(name), ...entries, tdmn('ADBE Group End')));

function idta(type: number, id: number) {
  return chunk('idta', new W().zero(84).at(0, x => x.u2(type)).at(0x10, x => x.u4(id)).bytes());
}
function cdta(w: number, h: number, durSec: number, bg: number[]) {
  const x = new W().zero(204);
  x.at(0x04, y => y.u4(1024 * 1).u4(TB)); // time scale x256 = 1024 -> frame = 1024 units -> 24 fps
  x.at(0x2c, y => y.u4(durSec * TB).u4(TB).u1(bg[0]).u1(bg[1]).u1(bg[2]));
  x.at(0x8c, y => y.u2(w).u2(h).u4(1).u4(1).u4(0).u4(24 * 65536));
  return chunk('cdta', x.bytes());
}
function ldta(o: { id: number; type: number; source?: number; parent?: number; start?: number; inP?: number; outP?: number; flagsB?: number; flagsC?: number }) {
  const x = new W().zero(164);
  x.at(0, y => y.u4(o.id).u2(2));
  x.at(0x08, y => y.s4(1).s4(Math.round((o.start ?? 0) * TB)).u4(TB).s4(Math.round((o.inP ?? 0) * TB)).u4(TB).s4(Math.round((o.outP ?? 4) * TB)).u4(TB));
  x.at(0x25, y => y.u1(0).u1(o.flagsB ?? 0).u1(o.flagsC ?? 0x07).u4(o.source ?? 0));
  x.at(0x6c, y => y.u4(1));
  x.at(0x83, y => y.u1(o.type).u4(o.parent ?? 0));
  return chunk('ldta', x.bytes());
}
function solidItem(id: number, name: string, w: number, h: number, rgb: number[]) {
  const sspc = new W().zero(222).at(0x16, y => y.str('Soli', 4).zero(4).u4(w).u4(h)).bytes();
  const opti = new W().str('Soli', 4).u2(9).u4(282).f4(1).f4(rgb[0]).f4(rgb[1]).f4(rgb[2]).str(name, 256).bytes();
  return list('Item', idta(7, id), utf8(''), list('Pin ', chunk('sspc', sspc), utf8(''), chunk('opti', opti)));
}

// ------------------------------------------------------------------ sample project

function sampleFile(): ArrayBuffer {
  const transformAnimated = group('ADBE Transform Group', '-_0_/-',
    stream('ADBE Anchor Point', tdb4(3, 0x0f, { arc: 6.25e-12 }), cdat([0.5, 0.25, 0], 3)),
    stream('ADBE Position', tdb4(3, 0x0e, { animated: true }), kflist(128, [
      kfS(0, 2, 2, [100, 100, 0], 0, 0.5, 100, 0.5, [0, 0, 0], [50, 0, 0]),
      kfS(2, 2, 3, [300, 100, 0], 0, 0.25, 0, 0.3, [-50, 0, 0], [0, 0, 0]),
      kfS(3, 3, 1, [0, 0, 0], 0, 0.3, 0, 0.3, [0, 0, 0], [0, 0, 0]),
    ])),
    stream('ADBE Scale', tdb4(3, 0x00, { animated: true }), kflist(128, [
      kfN(0, 1, 1, [1, 1, 1], [0, 0, 0], [1 / 6, 1 / 6, 1 / 6], [0, 0, 0], [1 / 6, 1 / 6, 1 / 6]),
      kfN(1, 1, 1, [2, 0.5, 1], [0, 0, 0], [1 / 6, 1 / 6, 1 / 6], [0, 0, 0], [1 / 6, 1 / 6, 1 / 6]),
    ])),
    stream('ADBE Rotate Z', tdb4(1, 0x01), cdat([45], 5)),
    stream('ADBE Opacity', tdb4(1, 0x00, { animated: true }), kflist(48, [
      kfN(0, 2, 2, [0], [0], [0.3333], [2], [0.5]),
      kfN(1, 2, 2, [1], [0], [0.75], [0], [0.3333]),
    ])),
  );
  const solidLayer = list('Layr', ldta({ id: 10, type: 0, source: 5, start: 0.5, outP: 4 }), utf8('Solid A'),
    list('tdgp', tdsb(1), tdsn(''), transformAnimated, tdmn('ADBE Group End')));
  const nullLayer = list('Layr', ldta({ id: 11, type: 0, source: 6, flagsB: 0x80 }), utf8('Ctrl'),
    list('tdgp', tdsb(1), tdsn(''), group('ADBE Transform Group', '-_0_/-',
      stream('ADBE Position', tdb4(3, 0x0f), cdat([400, 300, 0], 3)),
      stream('ADBE Opacity', tdb4(1, 0x01), cdat([0], 5)),
    ), tdmn('ADBE Group End')));
  const color = (argb: number[]) => stream('ADBE Vector Fill Color', tdb4(4, 0x07, { color: true }), cdat(argb, 3));
  const rectGroup = group('ADBE Vector Group', 'Box',
    group('ADBE Vectors Group', '-_0_/-',
      group('ADBE Vector Shape - Rect', 'Rectangle Path 1',
        stream('ADBE Vector Rect Size', tdb4(2, 0x01), cdat([80, 40], 5)),
        stream('ADBE Vector Rect Position', tdb4(2, 0x0f), cdat([0, 0], 3)),
      ),
      group('ADBE Vector Graphic - Fill', 'Fill 1', color([255, 255, 0, 0])),
    ),
    group('ADBE Vector Transform Group', '-_0_/-'),
  );
  const shapeLayer = list('Layr', ldta({ id: 12, type: 4, parent: 11, flagsC: 0x87 }), utf8('Shape'),
    list('tdgp', tdsb(1), tdsn(''), group('ADBE Root Vectors Group', '-_0_/-', rectGroup), group('ADBE Transform Group', '-_0_/-'), tdmn('ADBE Group End')));
  // complex shape: a path (om-s) + stroke in one group, an ellipse in another
  const shph = new W().u2(0xb3de).u1(2).u1(0x01).f4(0).f4(0).f4(100).f4(50).u4(0x01000000).bytes();
  const pts = [[0, 0], [0, 0], [1, 0], [1, 0], [1, 0], [1, 1], [1, 1], [1, 1], [0, 0]]; // 3 vertices, straight segments
  const ptsW = new W(); for (const [x, y] of pts) ptsW.f4(x).f4(y);
  const pathHeader = new W().u4(0x00d00bee).u4(0).u4(9).u4(3).u4(8).u4(4).u4(1).u4(12).zero(20).bytes();
  const omS = cat(tdmn('ADBE Vector Shape'), list('om-s', list('tdbs', tdsb(1), tdsn('-_0_/-'), tdb4(1, 0x07, { valueless: true }), chunk('cdat', new Uint8Array(4))),
    list('omks', list('shap', chunk('shph', shph), list('list', chunk('lhd3', pathHeader), chunk('ldat', ptsW.bytes())), chunk('omtn', new Uint8Array(0))))));
  const complex = list('Layr', ldta({ id: 13, type: 4, flagsC: 0x87 }), utf8('Complex'),
    list('tdgp', tdsb(1), tdsn(''), group('ADBE Root Vectors Group', '-_0_/-',
      group('ADBE Vector Group', 'Tri', group('ADBE Vectors Group', '-_0_/-',
        group('ADBE Vector Shape - Group', 'Path 1', omS),
        group('ADBE Vector Graphic - Stroke', 'Stroke 1', stream('ADBE Vector Stroke Color', tdb4(4, 0x07, { color: true }), cdat([255, 0, 255, 0], 3)), stream('ADBE Vector Stroke Width', tdb4(1, 0x01), cdat([4], 5))),
      ), group('ADBE Vector Transform Group', '-_0_/-', stream('ADBE Vector Position', tdb4(2, 0x0f), cdat([10, 20], 3)))),
      group('ADBE Vector Group', 'Dot', group('ADBE Vectors Group', '-_0_/-',
        group('ADBE Vector Shape - Ellipse', 'Ellipse Path 1', stream('ADBE Vector Ellipse Size', tdb4(2, 0x01), cdat([30, 30], 5))),
        group('ADBE Vector Graphic - Fill', 'Fill 1', color([255, 0, 0, 255])),
      ), group('ADBE Vector Transform Group', '-_0_/-', stream('ADBE Vector Scale', tdb4(2, 0x01), cdat([200, 200], 5)))),
    ), tdmn('ADBE Group End')));
  // a layer with garbage inside its property tree must not break the others
  const broken = list('Layr', ldta({ id: 14, type: 0, source: 5 }), utf8('Broken'),
    list('tdgp', tdsb(1), tdmn('ADBE Transform Group'), chunk('LIST', new Uint8Array([0x74, 0x64, 0x67]))));
  const camera = list('Layr', ldta({ id: 15, type: 2, flagsC: 0x01 }), utf8('Camera 1'), list('tdgp', tdsb(1), tdmn('ADBE Group End')));
  const comp = list('Item', idta(4, 2), utf8('Main'), list('dats'), cdta(640, 360, 6, [10, 20, 30]), chunk('cdrp', new Uint8Array(1)),
    chunk('zzzz', new Uint8Array([1, 2, 3])), // unknown chunk
    camera, list('Ewst'), shapeLayer, list('Ewst'), nullLayer, complex, solidLayer, broken);
  const folder = list('Item', idta(1, 3), utf8('Solids'), chunk('sfdt', new Uint8Array(4)), list('Sfdr', solidItem(5, 'Blue Solid', 200, 100, [0, 0, 1]), solidItem(6, 'Null 1', 100, 100, [1, 1, 1])));
  return file(
    chunk('head', new W().u2(97).zero(18).bytes()),
    chunk('nhed', new W().zero(32).at(15, x => x.u1(1)).bytes()),
    list('ExEn', utf8('javascript-1.0')),
    list('Fold', chunk('fdta', new Uint8Array(14)), comp, folder),
  );
}

function byName(p: Project) { const m: Record<string, Layer> = {}; for (const l of Object.values(p.layers)) m[l.name] = l; return m; }

// ------------------------------------------------------------------ tests

describe('rifx walker', () => {
  it('walks nested lists, pads odd chunks and tolerates unknown tags', () => {
    const buf = file(chunk('abc1', new Uint8Array([1, 2, 3])), list('Fold', chunk('fdta', new Uint8Array(14)), chunk('odd!', new Uint8Array(5))), chunk('tail', new Uint8Array(2)));
    const r = readRifx(buf)!;
    expect(r.form).toBe('Egg!');
    expect(r.root.kids!.map(k => k.tag)).toEqual(['abc1', 'LIST', 'tail']);
    expect(r.root.kids![1].list).toBe('Fold');
    expect(r.root.kids![1].kids!.map(k => k.tag + k.len)).toEqual(['fdta14', 'odd!5']);
  });

  it('never throws on truncated or random data', () => {
    const good = new Uint8Array(sampleFile());
    for (const cut of [13, 40, 200, 777, good.length - 9]) {
      const b = good.slice(0, cut).buffer;
      expect(() => parseAep(b)).not.toThrow();
      expect(() => aepToProject(b)).not.toThrow();
    }
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 30; n++) {
      const b = good.slice();
      for (let i = 0; i < 40; i++) b[12 + Math.floor(rnd() * (b.length - 12))] = Math.floor(rnd() * 256);
      expect(() => aepToProject(b.buffer)).not.toThrow();
    }
    expect(() => parseAep(new Uint8Array([1, 2, 3]).buffer)).toThrow(/RIFX/);
  });
});

describe('aep parse', () => {
  const p = parseAep(sampleFile());
  it('reads project header, folders and items', () => {
    expect(p.bitsPerChannel).toBe(16);
    expect(p.expressionEngine).toBe('javascript-1.0');
    expect(p.fileVersion).toBe(97);
    expect(p.root.children.map(i => i.name)).toEqual(['Main', 'Solids']);
    const solid = p.items.get(5)!;
    expect(solid.type).toBe('footage');
    if (solid.type === 'footage') {
      expect(solid.source).toBe('solid');
      expect(solid.name).toBe('Blue Solid');
      expect([solid.width, solid.height]).toEqual([200, 100]);
      expect(solid.color).toEqual([0, 0, 1]);
    }
  });

  it('reads comp settings', () => {
    const c = p.comps[0];
    expect(c.name).toBe('Main');
    expect([c.width, c.height]).toEqual([640, 360]);
    expect(c.fps).toBe(24);
    expect(c.duration).toBe(6);
    expect(c.bgColor).toEqual([10, 20, 30]);
    expect(c.layers.map(l => l.name)).toEqual(['Camera 1', 'Shape', 'Ctrl', 'Complex', 'Solid A', 'Broken']);
    expect(c.layers.map(l => l.kind)).toEqual(['camera', 'shape', 'av', 'shape', 'av', 'av']);
  });

  it('reads layer records', () => {
    const [, shape, ctrl, , solid] = p.comps[0].layers;
    expect(shape.parentId).toBe(11);
    expect(ctrl.flags.null).toBe(true);
    expect(solid.sourceId).toBe(5);
    expect(solid.startTime).toBe(0.5);
    expect(solid.compIn).toBe(0.5);
    expect(solid.compOut).toBe(4.5);
  });

  it('decodes keyframes (per-dimension and single-ease spatial)', () => {
    const solid = p.comps[0].layers[4];
    const op = childStream(solid.transform, 'ADBE Opacity') as AepStream;
    expect(op.keyframes!.length).toBe(2);
    expect(op.keyframes![1].time).toBe(1);
    expect(op.keyframes![0].outSpeed).toEqual([2]);
    expect(op.keyframes![1].inInfluence).toEqual([0.75]);
    const pos = childStream(solid.transform, 'ADBE Position')!;
    expect(pos.spatial).toBe(true);
    expect(pos.singleEase).toBe(true);
    expect(pos.keyframes![0].value).toEqual([100, 100, 0]);
    expect(pos.keyframes![0].outTangent).toEqual([50, 0, 0]);
    expect(pos.keyframes![1].inTangent).toEqual([-50, 0, 0]);
    expect(pos.keyframes![1].outInterp).toBe(3);
    const sc = childStream(solid.transform, 'ADBE Scale')!;
    expect(sc.keyframes![1].value).toEqual([2, 0.5, 1]);
  });

  it('keeps parsing after a broken layer', () => {
    const broken = p.comps[0].layers[5];
    expect(broken.name).toBe('Broken');
    expect(p.comps[0].layers[4].transform).not.toBeNull();
  });
});

describe('aep -> project', () => {
  const proj = aepToProject(sampleFile());
  const comp = proj.comps[proj.activeComp];
  const L = byName(proj);

  it('converts the comp', () => {
    expect(comp.width).toBe(640);
    expect(comp.fps).toBe(24);
    expect(comp.duration).toBe(6);
    expect(comp.background).toEqual([10 / 255, 20 / 255, 30 / 255, 1]);
    expect(L['Camera 1']).toBeUndefined();
  });

  it('converts transform keyframes with ae ease -> bezier', () => {
    const s = L['Solid A'];
    expect(s.type).toBe('rect');
    expect(s.props.size!.v).toEqual([200, 100]);
    expect(s.props.fill!.v).toEqual([0, 0, 1, 1]);
    // anchor stored as fraction of the source (tdb4 arc accuracy 6.25e-12)
    expect(s.props.anchor!.v).toEqual([100, 25]);
    expect(s.props.rotation!.v).toEqual([45]);
    const op = s.props.opacity!.kf!;
    // layer start time 0.5 s shifts keys
    expect(op.map(k => k.t)).toEqual([0.5, 1.5]);
    expect(op.map(k => k.v[0])).toEqual([0, 100]);
    expect(op[0].interp).toBe('bezier');
    // out: influence 0.5, speed 2/s over avg 1/s -> y1 = 2 * 0.5 = 1
    expect(op[0].out[0]).toBeCloseTo(0.5, 9);
    expect(op[0].out[1]).toBeCloseTo(1, 9);
    expect(op[1].in[0]).toBeCloseTo(0.25, 9);
    expect(op[1].in[1]).toBeCloseTo(1, 9);
    const sc = s.props.scale!.kf!;
    expect(sc[1].v).toEqual([200, 50]);
    expect(sc[0].interp).toBe('linear');
    const pos = s.props.position!.kf!;
    expect(pos.map(k => k.t)).toEqual([0.5, 2.5, 3.5]);
    expect(pos[0].v).toEqual([100, 100]);
    expect(pos[0].sOut).toEqual([50, 0]);
    expect(pos[1].sIn).toEqual([-50, 0]);
    // arc length 200 over 2 s -> avg 100 px/s; out speed 100 @ 50 % -> y1 = 0.5
    expect(pos[0].out[0]).toBeCloseTo(0.5, 6);
    expect(pos[0].out[1]).toBeCloseTo(0.5, 3);
    expect(pos[1].in[0]).toBeCloseTo(0.75, 9);
    expect(pos[1].in[1]).toBeCloseTo(1, 9);
    expect(pos[1].interp).toBe('hold');
    expect(evalProp(s.props.position, 3, 2, [0, 0])).toEqual([300, 100]);
    expect(s.inPoint).toBe(0.5);
    expect(s.outPoint).toBe(4.5);
  });

  it('maps parenting and shape layers', () => {
    const ctrl = L['Ctrl'];
    expect(ctrl.type).toBe('group');
    expect(ctrl.props.position!.v).toEqual([400, 300]);
    expect(ctrl.props.opacity!.v).toEqual([100]);
    const sh = L['Shape'];
    expect(sh.type).toBe('rect');
    expect(sh.parent).toBe(ctrl.id);
    expect(sh.props.size!.v).toEqual([80, 40]);
    expect(sh.props.fill!.v).toEqual([1, 0, 0, 1]);
    expect(sh.props.anchor!.v).toEqual([40, 20]);
    expect(sh.props.position!.v).toEqual([320, 180]); // default: comp centre
    const cx = L['Complex'];
    expect(cx.type).toBe('group');
    const kids = cx.children.map(id => proj.layers[id]);
    expect(kids.map(k => k.name)).toEqual(['Dot', 'Tri']);
    expect(kids[0].props.scale!.v).toEqual([200, 200]);
    const tri = proj.layers[kids[1].children[0]];
    expect(tri.type).toBe('path');
    expect(tri.geomSize).toEqual([100, 50]);
    expect(tri.props.strokeWidth!.v).toEqual([4]);
    expect(tri.props.stroke!.v).toEqual([0, 1, 0, 1]);
    expect(tri.geometry![0].cmds[0]).toEqual(['M', 0, 0]);
    expect(kids[1].props.position!.v).toEqual([10, 20]);
    const dot = proj.layers[kids[0].children[0]];
    expect(dot.type).toBe('ellipse');
    expect(dot.props.fill!.v).toEqual([0, 0, 1, 1]);
    // root order bottom -> top
    expect(comp.root.map(id => proj.layers[id].name)).toEqual(['Broken', 'Solid A', 'Complex', 'Ctrl']);
  });

  it('decodes text documents (COS)', () => {
    const enc = (s: string) => { const u = [0xfe, 0xff]; for (const ch of s) { const c = ch.charCodeAt(0); u.push(c >> 8, c & 255); } return u; };
    const parts: number[] = [];
    const push = (s: string) => { for (const ch of s) parts.push(ch.charCodeAt(0)); };
    push(' /98 << /0 9 >> /0 << /1 << /0 [ << /0 << /99 /CoolTypeFont /0 << /0 (');
    parts.push(...enc('Roboto-BoldItalic'));
    push(') /2 1 >> >> >> ] >> >> /1 << /1 [ << /0 << /0 (');
    parts.push(...enc('Hi\r(there)\r').flatMap(b => (b === 0x28 || b === 0x29 ? [0x5c, b] : [b])));
    push(') /5 << /0 [ << /0 << /0 << /0 () /5 << /0 2 >> /6 0 >> >> /1 3 >> ] >> /6 << /0 [ << /0 << /0 << /0 () /5 0 /6 << /0 0 /1 48.0 /4 true /5 .01 /53 << /99 /SimplePaint /0 << /0 1 /1 [ 1.0 .5 .25 0.0 ] >> >> >> >> >> /1 3 >> ] >> >> >> ] >> >>');
    const docs = textDocs(Uint8Array.from(parts));
    expect(docs.length).toBe(1);
    expect(docs[0].text).toBe('Hi\n(there)');
    expect(docs[0].font).toBe('Roboto-BoldItalic');
    expect(docs[0].fontSize).toBe(48);
    expect(docs[0].justification).toBe(2);
    expect(docs[0].fill).toEqual([0.5, 0.25, 0, 1]);
  });

  it('is fast on big files (linear)', () => {
    const layers: Uint8Array[] = [];
    for (let i = 0; i < 3000; i++) {
      layers.push(list('Layr', ldta({ id: 100 + i, type: 0, source: 5, parent: i > 0 ? 99 + i : 0 }), utf8(`L${i}`),
        list('tdgp', tdsb(1), tdsn(''), group('ADBE Transform Group', '-_0_/-',
          stream('ADBE Opacity', tdb4(1, 0x00, { animated: true }), kflist(48, Array.from({ length: 20 }, (_, k) => kfN(k * 0.1, 2, 2, [k % 2], [0], [0.3], [0], [0.3])))),
        ), tdmn('ADBE Group End'))));
    }
    const buf = file(list('Fold', chunk('fdta', new Uint8Array(14)),
      list('Item', idta(4, 2), utf8('Big'), cdta(1920, 1080, 10, [0, 0, 0]), ...layers),
      solidItem(5, 'S', 10, 10, [1, 0, 0])));
    const t0 = performance.now();
    const p = aepToProject(buf);
    const ms = performance.now() - t0;
    expect(Object.keys(p.layers).length).toBeGreaterThanOrEqual(3000);
    expect(ms).toBeLessThan(1500);
  });
});
