import { describe, it, expect } from 'vitest';
import { lottieToProject } from '../src/import/lottie';
import { projectToLottie } from '../src/export/lottie';
import { createProject, createLayer, type Project, type Layer } from '../src/core/model';
import { evalProp } from '../src/core/evaluate';

const ease = (ox: number, oy: number, ix: number, iy: number) => ({ o: { x: [ox], y: [oy] }, i: { x: [ix], y: [iy] } });

function layersByName(p: Project) {
  const m: Record<string, Layer> = {};
  for (const l of Object.values(p.layers)) m[l.name] = l;
  return m;
}

const sample = {
  v: '5.7.4', fr: 30, ip: 0, op: 90, w: 400, h: 300, nm: 'Test', ddd: 0,
  fonts: { list: [{ fName: 'Roboto-Bold', fFamily: 'Roboto', fStyle: 'Bold', ascent: 75 }] },
  assets: [
    { id: 'img_0', w: 10, h: 20, u: '', p: 'data:image/png;base64,iVBORw0KGgo=', e: 1 },
    { id: 'comp_0', layers: [
      { ddd: 0, ind: 1, ty: 1, nm: 'InnerSolid', sw: 50, sh: 40, sc: '#ff0000', ip: 0, op: 60, st: 0, ks: { p: { a: 1, k: [{ t: 0, s: [0, 0], ...ease(0.333, 0, 0.667, 1) }, { t: 30, s: [100, 0] }] } } },
    ] },
  ],
  layers: [
    // top-most: text
    { ddd: 0, ind: 1, ty: 5, nm: 'Title', ip: 0, op: 90, st: 0, ks: { p: { a: 0, k: [200, 100] } },
      t: { d: { k: [{ t: 0, s: { s: 40, f: 'Roboto-Bold', t: 'Hello\rWorld', j: 2, tr: 0, lh: 48, fc: [1, 1, 1] } }] } } },
    // simple shape: one rect + fill, animated size and colour
    { ddd: 0, ind: 2, ty: 4, nm: 'Box', parent: 4, ip: 0, op: 90, st: 0,
      ks: { a: { a: 0, k: [0, 0] }, p: { a: 1, k: [{ t: 0, s: [10, 20], to: [5, 0], ti: [-5, 0], ...ease(0.25, 0.1, 0.75, 0.9) }, { t: 30, s: [110, 20], h: 1 }, { t: 60, s: [10, 20] }] },
        s: { a: 0, k: [100, 100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      shapes: [{ ty: 'gr', nm: 'G', it: [
        { ty: 'rc', s: { a: 1, k: [{ t: 0, s: [20, 10], ...ease(0.4, 0, 0.6, 1) }, { t: 15, s: [40, 30] }] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 4 } },
        { ty: 'fl', c: { a: 1, k: [{ t: 0, s: [1, 0, 0, 1], ...ease(0, 0, 1, 1) }, { t: 30, s: [0, 0, 1, 1] }] }, o: { a: 0, k: 50 } },
        { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      ] }] },
    // complex shape: two groups
    { ddd: 0, ind: 3, ty: 4, nm: 'Complex', ip: 0, op: 90, st: 0, ks: {},
      shapes: [
        { ty: 'gr', nm: 'A', it: [{ ty: 'el', s: { a: 0, k: [30, 30] }, p: { a: 0, k: [0, 0] } }, { ty: 'st', c: { a: 0, k: [0, 1, 0, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 3 } }, { ty: 'tr', p: { a: 0, k: [50, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [200, 200] }, r: { a: 0, k: 45 }, o: { a: 0, k: 100 } }] },
        { ty: 'gr', nm: 'B', it: [{ ty: 'sh', ks: { a: 0, k: { c: true, v: [[0, 0], [10, 0], [10, 10]], i: [[0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0]] } } }, { ty: 'fl', c: { a: 0, k: [0, 0, 0, 1] }, o: { a: 0, k: 100 }, r: 2 }, { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }] },
      ] },
    // null parent (with split position)
    { ddd: 0, ind: 4, ty: 3, nm: 'Ctrl', ip: 0, op: 90, st: 0, ks: { p: { s: true, x: { a: 0, k: 100 }, y: { a: 0, k: 50 } }, o: { a: 0, k: 0 } } },
    { ddd: 0, ind: 5, ty: 2, nm: 'Pic', refId: 'img_0', ip: 0, op: 90, st: 0, ks: {} },
    { ddd: 0, ind: 6, ty: 0, nm: 'Pre', refId: 'comp_0', w: 200, h: 100, ip: 15, op: 90, st: 15, ks: {} },
  ],
};

describe('lottie import', () => {
  const p = lottieToProject(sample);
  const comp = p.comps[p.activeComp];
  const by = layersByName(p);

  it('reads comp settings', () => {
    expect(comp.width).toBe(400);
    expect(comp.height).toBe(300);
    expect(comp.fps).toBe(30);
    expect(comp.duration).toBe(3);
  });

  it('collapses a simple rect shape layer into a rect layer with animated size + fill', () => {
    const box = by['Box'];
    expect(box.type).toBe('rect');
    expect(box.props.size!.kf!.map(k => k.t)).toEqual([0, 0.5]);
    expect(box.props.size!.kf![0].out).toEqual([0.4, 0]);
    expect(box.props.size!.kf![1].in).toEqual([0.6, 1]);
    expect(box.props.radius!.v).toEqual([4, 4, 4, 4]);
    const f = box.props.fill!;
    expect(f.kf!.length).toBe(2);
    expect(f.kf![0].v).toEqual([1, 0, 0, 0.5]);
    expect(f.kf![0].interp).toBe('linear');
    // rect centred on the layer origin: anchor follows size/2
    expect(box.props.anchor!.kf![0].v).toEqual([10, 5]);
    expect(box.props.anchor!.kf![1].v).toEqual([20, 15]);
  });

  it('converts position keyframes with easing, hold and spatial tangents', () => {
    const pos = by['Box'].props.position!;
    expect(pos.kf!.map(k => k.t)).toEqual([0, 1, 2]);
    expect(pos.kf![0].out).toEqual([0.25, 0.1]);
    expect(pos.kf![1].in).toEqual([0.75, 0.9]);
    expect(pos.kf![0].sOut).toEqual([5, 0]);
    expect(pos.kf![1].sIn).toEqual([-5, 0]);
    expect(pos.kf![1].interp).toBe('hold');
  });

  it('maps parenting into the tree and keeps stacking order', () => {
    const ctrl = by['Ctrl'];
    expect(ctrl.type).toBe('group');
    expect(ctrl.children).toContain(by['Box'].id);
    expect(by['Box'].parent).toBe(ctrl.id);
    expect(ctrl.props.position!.v).toEqual([100, 50]);
    expect(ctrl.props.opacity!.v).toEqual([100]); // null opacity never hides children
    // root order bottom -> top: Pre, Pic, Ctrl, Complex, Title
    const names = comp.root.map(id => p.layers[id].name);
    expect(names).toEqual(['Pre', 'Pic', 'Ctrl', 'Complex', 'Title']);
  });

  it('builds complex shape layers as groups', () => {
    const c = by['Complex'];
    expect(c.type).toBe('group');
    expect(c.children.length).toBe(2);
    const [b, a] = c.children.map(id => p.layers[id]); // bottom first: B then A
    expect(a.name).toBe('A');
    expect(a.props.scale!.v).toEqual([200, 200]);
    expect(a.props.rotation!.v).toEqual([45]);
    const el = p.layers[a.children[0]];
    expect(el.type).toBe('ellipse');
    expect(el.props.strokeWidth!.v).toEqual([3]);
    expect(el.props.fill!.v[3]).toBe(0);
    const path = p.layers[b.children[0]];
    expect(path.type).toBe('path');
    expect(path.geometry![0].fillRule).toBe('evenodd');
    expect(path.geomSize).toEqual([10, 10]);
  });

  it('imports text, images and precomps', () => {
    const t = by['Title'];
    expect(t.type).toBe('text');
    expect(t.text!.content).toBe('Hello\nWorld');
    expect(t.text!.fontFamily).toBe('Roboto');
    expect(t.text!.fontWeight).toBe(700);
    expect(t.text!.align).toBe('center');
    const pic = by['Pic'];
    expect(pic.type).toBe('image');
    expect(p.assets[pic.imageRef!].data.startsWith('data:image/png')).toBe(true);
    const pre = by['Pre'];
    expect(pre.type).toBe('group');
    expect(pre.clip).toBe(true);
    expect(pre.inPoint).toBe(0.5);
    const inner = by['InnerSolid'];
    expect(inner.parent).toBe(pre.id);
    expect(inner.type).toBe('rect');
    expect(inner.props.fill!.v).toEqual([1, 0, 0, 1]);
    // st offset 15 frames applies to inner times
    expect(inner.props.position!.kf!.map(k => k.t)).toEqual([0.5, 1.5]);
    expect(inner.inPoint).toBe(0.5);
  });

  it('survives parent cycles and missing parents', () => {
    const p = lottieToProject({ w: 10, h: 10, fr: 30, ip: 0, op: 30, layers: [
      { ty: 3, ind: 1, parent: 2, nm: 'a', ks: {} }, { ty: 3, ind: 2, parent: 1, nm: 'b', ks: {} },
      { ty: 3, ind: 3, parent: 1, nm: 'c', ks: {} }, { ty: 3, ind: 4, parent: 99, nm: 'd', ks: {} },
    ] });
    const by = layersByName(p);
    expect(by['c'].parent).toBe(by['a'].id);
    expect(by['d'].parent).toBeNull();
    expect(Object.keys(p.layers).length).toBe(4);
  });

  it('never throws on junk', () => {
    expect(() => lottieToProject({ layers: [null, { ty: 4, shapes: [{ ty: 'zz' }, null] }, { ty: 99 }] })).not.toThrow();
  });
});

describe('lottie round trip', () => {
  function build(): Project {
    const p = createProject('rt');
    const comp = p.comps[p.activeComp];
    comp.width = 640; comp.height = 360; comp.fps = 25; comp.duration = 4;
    const add = (l: Layer, parent?: Layer) => {
      p.layers[l.id] = l;
      if (parent) { l.parent = parent.id; parent.children.push(l.id); } else comp.root.push(l.id);
      return l;
    };
    const g = add(createLayer('group', { name: 'G', x: 10, y: 10, w: 100, h: 100, color: [1, 1, 1, 0] }));
    const r = add(createLayer('rect', { name: 'R', x: 0, y: 0, w: 80, h: 40 }), g);
    r.props.position = { v: [40, 20], kf: [
      { t: 0, v: [40, 20], interp: 'bezier', out: [0.3, 0.1], in: [0.6, 1], sOut: [10, 0] },
      { t: 1, v: [200, 120], interp: 'hold', out: [0.2, 0], in: [0.7, 0.9], sIn: [-10, 5] },
      { t: 2, v: [300, 100], interp: 'linear', out: [0, 0], in: [0.5, 0.5] },
    ] };
    r.props.size = { v: [80, 40], kf: [
      { t: 0.4, v: [80, 40], interp: 'bezier', out: [0.42, 0], in: [0, 0] },
      { t: 1.6, v: [120, 60], interp: 'bezier', out: [0, 0], in: [0.58, 1] },
    ] };
    r.props.fill = { v: [1, 0, 0, 1], kf: [
      { t: 0, v: [1, 0, 0, 1], interp: 'bezier', out: [0.333, 0], in: [0, 0] },
      { t: 2, v: [0, 0.5, 1, 0.5], interp: 'bezier', out: [0, 0], in: [0.667, 1] },
    ] };
    r.props.rotation = { v: [0], kf: [
      { t: 0, v: [0], interp: 'linear', out: [0, 0], in: [0, 0] },
      { t: 3, v: [90], interp: 'linear', out: [0, 0], in: [1, 1] },
    ] };
    const e = add(createLayer('ellipse', { name: 'E', x: 50, y: 50, w: 30, h: 30 }));
    e.props.opacity = { v: [100], kf: [
      { t: 0, v: [0], interp: 'bezier', out: [0.1, 0.9], in: [0, 0] },
      { t: 1.2, v: [100], interp: 'bezier', out: [0, 0], in: [0.2, 1.3] },
    ] };
    const t = add(createLayer('text', { name: 'T', x: 5, y: 6, w: 300, h: 50 }));
    t.text = { content: 'Hi\nthere', fontFamily: 'Inter', fontSize: 32, fontWeight: 700, lineHeight: 1.25, letterSpacing: 0, align: 'center' };
    const pa = add(createLayer('path', { name: 'P', x: 0, y: 0, w: 20, h: 20 }));
    pa.geometry = [{ cmds: [['M', 0, 0], ['L', 20, 0], ['C', 20, 10, 10, 20, 0, 20], ['Z']], fillRule: 'nonzero' }];
    pa.geomSize = [20, 20];
    return p;
  }

  it('preserves keyframe times, values and easing', () => {
    const src = build();
    const json = projectToLottie(src);
    const back = lottieToProject(JSON.parse(JSON.stringify(json)));
    const a = layersByName(src), b = layersByName(back);
    const cmpKf = (pa: any, pb: any, spatial = false) => {
      expect(pb.kf.length).toBe(pa.kf.length);
      for (let i = 0; i < pa.kf.length; i++) {
        const x = pa.kf[i], y = pb.kf[i];
        expect(y.t).toBeCloseTo(x.t, 6);
        y.v.forEach((v: number, d: number) => expect(v).toBeCloseTo(x.v[d], 6));
        expect(y.interp).toBe(x.interp);
        if (i < pa.kf.length - 1 && x.interp === 'bezier') {
          expect(y.out[0]).toBeCloseTo(x.out[0], 6); expect(y.out[1]).toBeCloseTo(x.out[1], 6);
          expect(pb.kf[i + 1].in[0]).toBeCloseTo(pa.kf[i + 1].in[0], 6);
          expect(pb.kf[i + 1].in[1]).toBeCloseTo(pa.kf[i + 1].in[1], 6);
        }
        if (spatial && i < pa.kf.length - 1) {
          expect(y.sOut ?? [0, 0]).toEqual(x.sOut ?? [0, 0]);
          expect(pb.kf[i + 1].sIn ?? [0, 0]).toEqual(pa.kf[i + 1].sIn ?? [0, 0]);
        }
      }
    };
    expect(b['R'].type).toBe('rect');
    cmpKf(a['R'].props.position, b['R'].props.position, true);
    cmpKf(a['R'].props.size, b['R'].props.size);
    cmpKf(a['R'].props.fill, b['R'].props.fill);
    cmpKf(a['R'].props.rotation, b['R'].props.rotation);
    expect(b['R'].props.anchor!.v).toEqual(a['R'].props.anchor!.v);
    expect(b['R'].props.anchor!.kf).toBeUndefined();
    expect(b['E'].type).toBe('ellipse');
    cmpKf(a['E'].props.opacity, b['E'].props.opacity);
    expect(b['R'].parent).toBe(b['G'].id);
    expect(b['T'].type).toBe('text');
    expect(b['T'].text!.content).toBe('Hi\nthere');
    expect(b['T'].text!.align).toBe('center');
    expect(b['T'].props.size!.v).toEqual(a['T'].props.size!.v);
    expect(b['T'].props.anchor!.v).toEqual(a['T'].props.anchor!.v);
    expect(b['P'].type).toBe('path');
    // evaluated values agree over time
    for (let t = 0; t <= 3; t += 0.1) {
      const va = evalProp(a['R'].props.position, t, 2, [0, 0]), vb = evalProp(b['R'].props.position, t, 2, [0, 0]);
      expect(vb[0]).toBeCloseTo(va[0], 4); expect(vb[1]).toBeCloseTo(va[1], 4);
    }
    const back2 = back.comps[back.activeComp];
    expect(back2.fps).toBe(25);
    expect(back2.duration).toBe(4);
  });
});
