// lottie shape modifiers and paints found in real files (lottie-android sample set):
// repeaters, round corners, merge paths (path booleans), gradient strokes, stacked paints.
import { describe, it, expect } from 'vitest';
import { lottieToProject, roundCmds, rectCmds } from '../src/import/lottie';
import { flattenCmds, ringsArea } from '../src/import/pathops';
import { evalProp } from '../src/core/evaluate';
import type { Layer, Project } from '../src/core/model';

const all = (p: Project) => Object.values(p.layers);
const kids = (p: Project, l: Layer) => l.children.map(id => p.layers[id]);
const doc = (layers: any[]) => ({ v: '5.7.0', fr: 30, ip: 0, op: 60, w: 200, h: 200, layers });
const shapeLayer = (shapes: any[]) => ({ ty: 4, ind: 1, nm: 'S', ip: 0, op: 60, st: 0, ks: {}, shapes });
const rc = (x: number, y: number, s: number, extra: any = {}) => ({ ty: 'rc', s: { k: [s, s] }, p: { k: [x, y] }, r: { k: 0 }, ...extra });
const el = (x: number, y: number, s: number) => ({ ty: 'el', s: { k: [s, s] }, p: { k: [x, y] } });
const fl = (c = [1, 0, 0, 1], o = 100) => ({ ty: 'fl', c: { k: c }, o: { k: o } });
const tr = (p = [0, 0], extra: any = {}) => ({ ty: 'tr', p: { k: p }, a: { k: [0, 0] }, s: { k: [100, 100] }, r: { k: 0 }, o: { k: 100 }, ...extra });
const sq = (x: number, y: number, s: number) => ({ c: true, v: [[x, y], [x + s, y], [x + s, y + s], [x, y + s]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]] });
/** filled area of a path layer's geometry (in geometry units) */
const area = (l: Layer) => Math.abs(ringsArea(l.geometry!.flatMap(g => flattenCmds(g.cmds, 0.01))));

describe('lottie repeater', () => {
  it('copies everything above it with the transform applied index times, opacity from start to end', () => {
    const p = lottieToProject(doc([shapeLayer([{ ty: 'gr', nm: 'G', it: [
      rc(0, 0, 10), fl(),
      { ty: 'rp', nm: 'Rep', c: { k: 3 }, o: { k: 0 }, m: 1, tr: { p: { k: [20, 0] }, a: { k: [0, 0] }, s: { k: [100, 100] }, r: { k: 10 }, so: { k: 100 }, eo: { k: 40 } } },
      tr(),
    ] }])]));
    const copies = all(p).filter(l => /^Rep \d$/.test(l.name)).sort((a, b) => a.name.localeCompare(b.name));
    expect(copies.map(c => c.name)).toEqual(['Rep 1', 'Rep 2', 'Rep 3']);
    expect(copies.map(c => c.props.position!.v[0])).toEqual([0, 20, 40]);
    expect(copies.map(c => c.props.rotation!.v[0])).toEqual([0, 10, 20]);
    expect(copies.map(c => c.props.opacity!.v[0])).toEqual([100, 70, 40]);
    // every copy draws the rect; composite "above": the last copy is on top (last child)
    for (const c of copies) expect(kids(p, c).some(k => k.type === 'rect')).toBe(true);
    const parent = p.layers[copies[0].parent!];
    expect(kids(p, parent).map(k => k.name)).toEqual(['Rep 1', 'Rep 2', 'Rep 3']);
    // copies do not share prop objects (editing one keyframe must not move the others)
    const rects = copies.map(c => kids(p, c).find(k => k.type === 'rect')!);
    expect(rects[0].props.size).not.toBe(rects[1].props.size);
  });

  it('animated offset moves every copy', () => {
    const p = lottieToProject(doc([shapeLayer([rc(0, 0, 10), fl(),
      { ty: 'rp', nm: 'Rep', c: { k: 2 }, o: { a: 1, k: [{ t: 0, s: [0], o: { x: [0], y: [0] }, i: { x: [1], y: [1] } }, { t: 30, s: [1] }] }, m: 1, tr: { p: { k: [20, 0] }, a: { k: [0, 0] }, s: { k: [50, 50] }, r: { k: 0 } } },
    ])]));
    const c2 = all(p).find(l => l.name === 'Rep 2')!;
    expect(evalProp(c2.props.position!, 0, 2, [0, 0])[0]).toBeCloseTo(20);
    expect(evalProp(c2.props.position!, 1, 2, [0, 0])[0]).toBeCloseTo(40);
    expect(evalProp(c2.props.scale!, 1, 2, [0, 0])[0]).toBeCloseTo(25);
  });
});

describe('lottie round corners', () => {
  it('rounds sharp path vertices like lottie-web and leaves smooth ones', () => {
    const r = roundCmds(rectCmds(0, 0, 100, 40), 10);
    // 4 corners -> 8 vertices: M + 8 segments + Z
    expect(r.length).toBe(10);
    expect(r[0]).toEqual(['M', 0, 10]); // first vertex: the point toward the previous corner
    // the radius is capped at half of the adjacent edge
    const r2 = roundCmds(rectCmds(0, 0, 100, 40), 50);
    expect(r2[0]).toEqual(['M', 0, 20]); // half of the 40 high side
    expect(r2[1].slice(-2)).toEqual([50, 0]); // half of the 100 wide side
    // a rounded rect has no sharp corners: unchanged
    const smooth = rectCmds(0, 0, 100, 40, 8);
    expect(roundCmds(smooth, 10).length).toBe(smooth.length);
  });

  it('applies to rects (as corner radius) and paths above it, also in nested groups', () => {
    const p = lottieToProject(doc([shapeLayer([
      { ty: 'gr', nm: 'Inner', it: [rc(50, 50, 40), fl(), tr()] },
      { ty: 'sh', nm: 'Tri', ks: { k: { c: true, v: [[0, 0], [60, 0], [0, 60]], i: [[0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0]] } } },
      fl([0, 1, 0, 1]),
      { ty: 'rd', nm: 'RC', r: { k: 12 } },
    ])]));
    const rect = all(p).find(l => l.type === 'rect')!;
    expect(rect.props.radius!.v).toEqual([12, 12, 12, 12]);
    const tri = all(p).find(l => l.type === 'path')!;
    expect(tri.geometry![0].cmds.filter(c => c[0] === 'C').length).toBe(6);
  });

  it('animated radius keeps the same path structure in every key (morphs instead of jumping)', () => {
    const p = lottieToProject(doc([shapeLayer([
      { ty: 'sh', ks: { k: sq(0, 0, 100) } },
      { ty: 'rd', r: { a: 1, k: [{ t: 0, s: [0], o: { x: [0.3], y: [0] }, i: { x: [0.7], y: [1] } }, { t: 30, s: [40] }] } },
      { ty: 'st', c: { k: [1, 1, 1, 1] }, o: { k: 100 }, w: { k: 4 } },
    ])]));
    const l = all(p).find(x => x.type === 'path')!;
    expect(l.pathKf!.length).toBe(2);
    expect(l.pathKf![0].geometry[0].cmds.length).toBe(l.pathKf![1].geometry[0].cmds.length);
  });
});

describe('lottie merge paths', () => {
  it('subtract: the top path minus the ones below, one path filled by the paint after the merge', () => {
    const p = lottieToProject(doc([shapeLayer([{ ty: 'gr', nm: 'Ring', it: [
      el(0, 0, 100), el(0, 0, 60), { ty: 'mm', mm: 3 }, fl(), tr([100, 100]),
    ] }])]));
    const paths = all(p).filter(l => l.type === 'path');
    expect(paths.length).toBe(1);
    expect(all(p).filter(l => l.type === 'ellipse').length).toBe(0);
    expect(area(paths[0]) / (Math.PI * (50 * 50 - 30 * 30))).toBeCloseTo(1, 2);
  });

  it('intersect and add, through nested group transforms', () => {
    const shapes = (mode: number) => [{ ty: 'gr', it: [
      rc(0, 0, 20), { ty: 'gr', it: [rc(0, 0, 20), tr([10, 10])] }, { ty: 'mm', mm: mode }, fl(), tr([50, 50]),
    ] }];
    const inter = all(lottieToProject(doc([shapeLayer(shapes(4))]))).find(l => l.type === 'path')!;
    expect(area(inter)).toBeCloseTo(100, 3);
    const add = all(lottieToProject(doc([shapeLayer(shapes(2))]))).find(l => l.type === 'path')!;
    expect(area(add)).toBeCloseTo(700, 3);
    const xor = all(lottieToProject(doc([shapeLayer(shapes(5))]))).find(l => l.type === 'path')!;
    expect(area(xor)).toBeCloseTo(600, 3);
  });

  it('a single path or merge mode stays a curve compound path (no flattening)', () => {
    const p = lottieToProject(doc([shapeLayer([{ ty: 'gr', it: [el(0, 0, 50), el(100, 0, 50), { ty: 'mm', mm: 1 }, fl(), tr()] }])]));
    const l = all(p).find(x => x.type === 'path')!;
    expect(l.geometry!.length).toBe(1);
    expect(l.geometry![0].cmds.filter(c => c[0] === 'M').length).toBe(2);
    expect(l.geometry![0].cmds.some(c => c[0] === 'C')).toBe(true);
    const one = lottieToProject(doc([shapeLayer([{ ty: 'gr', it: [el(0, 0, 50), { ty: 'mm', mm: 4 }, fl(), tr()] }])]));
    expect(all(one).find(x => x.type === 'path')!.geometry![0].cmds.some(c => c[0] === 'C')).toBe(true);
  });

  it('paints above the merge still draw the original paths; paints below only the merged one', () => {
    const p = lottieToProject(doc([shapeLayer([{ ty: 'gr', it: [
      rc(0, 0, 20), fl([0, 0, 1, 1]), rc(10, 0, 20), { ty: 'mm', mm: 2 }, fl([1, 0, 0, 1]), tr(),
    ] }])]));
    const blue = all(p).filter(l => l.props.fill?.v[2] === 1 && l.props.fill?.v[0] === 0 && (l.type === 'rect' || l.type === 'path'));
    const red = all(p).filter(l => l.props.fill?.v[0] === 1 && l.props.fill?.v[2] === 0 && (l.type === 'rect' || l.type === 'path'));
    expect(blue.length).toBe(1); // only the first rect
    expect(red.length).toBe(1); // the union
    expect(area(red[0])).toBeCloseTo(600, 3);
  });

  it('animated operands are sampled per frame', () => {
    const p = lottieToProject(doc([shapeLayer([{ ty: 'gr', it: [
      { ty: 'el', s: { a: 1, k: [{ t: 0, s: [0, 0], o: { x: [0.3], y: [0] }, i: { x: [0.7], y: [1] } }, { t: 15, s: [100, 100] }] }, p: { k: [0, 0] } },
      el(0, 0, 40), { ty: 'mm', mm: 3 }, fl(), tr(),
    ] }])]));
    const l = all(p).find(x => x.type === 'path')!;
    expect(l.pathKf!.length).toBe(16);
  });
});

describe('lottie gradient strokes and stacked paints', () => {
  it('a gradient stroke is a stroke mask under a gradient box', () => {
    const p = lottieToProject(doc([shapeLayer([{ ty: 'gr', it: [
      el(0, 0, 100),
      { ty: 'gs', nm: 'GS', t: 1, s: { k: [-50, 0] }, e: { k: [50, 0] }, g: { p: 2, k: { k: [0, 1, 0, 0, 1, 0, 0, 1] } }, o: { k: 100 }, w: { k: 8 } },
      tr([100, 100]),
    ] }])]));
    const unit = all(p).find(l => l.name === 'GS' && l.type === 'group')!;
    const [m, g] = kids(p, unit);
    expect(m.mask).toBe(true);
    expect(m.props.strokeWidth!.v[0]).toBe(8);
    expect(m.props.fill!.v[3]).toBe(0);
    expect(g.paints?.[0].type).toBe('linear');
    expect(g.paints![0].stops!.map(s => s.color[0])).toEqual([1, 0]);
  });

  it('a translucent fill lets the next fill below it show (each paint is drawn)', () => {
    const p = lottieToProject(doc([shapeLayer([rc(0, 0, 20), fl([1, 0, 0, 1], 50), fl([0, 0, 1, 1], 50)])]));
    const rects = all(p).filter(l => l.type === 'rect');
    expect(rects.length).toBe(2);
    // an opaque fill hides the ones below: no extra layer
    const q = lottieToProject(doc([shapeLayer([rc(0, 0, 20), fl([1, 0, 0, 1]), fl([0, 0, 1, 1], 50)])]));
    expect(all(q).filter(l => l.type === 'rect').length).toBe(1);
  });
});

describe('lottie expressions that read another property', () => {
  const kf = (a: number, b: number) => ({ a: 1, k: [{ t: 0, s: [a], o: { x: [0.3], y: [0] }, i: { x: [0.7], y: [1] } }, { t: 30, s: [b] }] });
  it('an effect slider on another layer drives a trim end', () => {
    const ctrl = { ty: 3, ind: 1, nm: 'counter', ip: 0, op: 60, st: 0, ks: {}, ef: [{ ty: 5, nm: 'Slider Control', ef: [{ ty: 0, nm: 'Slider', v: kf(0, 80) }] }] };
    const p = lottieToProject(doc([ctrl, { ...shapeLayer([
      el(0, 0, 100), { ty: 'st', c: { k: [1, 1, 1, 1] }, o: { k: 100 }, w: { k: 4 } },
      { ty: 'tm', s: { k: 0 }, e: { k: 100, x: "var $bm_rt;\n$bm_rt = thisComp.layer('counter').effect('Slider Control')('Slider');" }, o: { k: 0 } },
    ]), ind: 2 }]));
    const l = all(p).find(x => x.trimOn)!;
    expect(l.props.trimEnd!.kf!.map(k => k.v[0])).toEqual([0, 80]);
  });

  it("a path linked to another layer's path, and a transform linked to another layer", () => {
    const src = { ...shapeLayer([{ ty: 'gr', nm: 'G', it: [{ ty: 'sh', nm: 'P', ks: { k: sq(0, 0, 30) } }, tr()] }]), nm: 'Src', ks: { r: kf(0, 90) } };
    const p = lottieToProject(doc([src, { ...shapeLayer([
      { ty: 'sh', ks: { k: sq(0, 0, 5), x: "var $bm_rt;\n$bm_rt = thisComp.layer('Src').content('G').content('P').path;" } }, fl(),
    ]), ind: 2, nm: 'Dst', ks: { r: { k: 0, x: "var $bm_rt;\n$bm_rt = thisComp.layer('Src').transform.rotation;" } } }]));
    const dst = all(p).find(l => l.name === 'Dst')!;
    expect(dst.props.size!.v).toEqual([30, 30]);
    expect(dst.props.rotation!.kf!.map(k => k.v[0])).toEqual([0, 90]);
  });

  it('unresolvable references keep the property as it is', () => {
    const p = lottieToProject(doc([{ ...shapeLayer([rc(0, 0, 10), fl()]), ks: { r: { k: 15, x: "var $bm_rt;\n$bm_rt = thisComp.layer('Nope').transform.rotation;" } } }]));
    expect(all(p)[0].props.rotation!.v[0]).toBe(15);
  });
});

describe('import safety', () => {
  it('nested repeaters share one copy budget (a tiny file cannot ask for 500^3 shapes)', async () => {
    const { lottieToProject } = await import('../src/import/lottie');
    const tr = { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } };
    const rp = (c: number) => ({ ty: 'rp', nm: 'R', c: { a: 0, k: c }, o: { a: 0, k: 0 }, m: 1, tr: { ty: 'tr', p: { a: 0, k: [1, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, so: { a: 0, k: 100 }, eo: { a: 0, k: 100 } } });
    const inner = { ty: 'gr', it: [{ ty: 'rc', s: { a: 0, k: [2, 2] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } }, { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 } }, rp(500), tr] };
    const outer = { ty: 'gr', it: [inner, rp(500), tr] };
    const top = { ty: 'gr', it: [outer, rp(500), tr] };
    const json = { v: '5.7', fr: 30, ip: 0, op: 30, w: 100, h: 100, layers: [{ ty: 4, nm: 'S', ip: 0, op: 30, st: 0, ks: {}, shapes: [top] }] };
    const t0 = performance.now();
    const p = lottieToProject(json);
    expect(performance.now() - t0).toBeLessThan(10000);
    expect(Object.keys(p.layers).length).toBeLessThan(60000);
  });
  it('path booleans ignore rings with non-finite points', async () => {
    const { booleanRings } = await import('../src/import/pathops');
    const sq = (x: number) => [x, 0, x + 10, 0, x + 10, 10, x, 10];
    expect(() => booleanRings([sq(0), [NaN, 0, 5, 5, 0, 5]], [sq(5)], 'union')).not.toThrow();
  });
});
