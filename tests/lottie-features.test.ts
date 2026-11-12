// regression tests for lottie features found in real bodymovin exports (lottie-web test animations):
// track mattes, layer masks, animated paths, trim paths, precomp time stretch / remap, stacking
// with parenting, expressions, blend modes.
import { describe, it, expect } from 'vitest';
import { lottieToProject, lottieExpr, type LottieImportStats } from '../src/import/lottie';
import type { Layer, Project } from '../src/core/model';

const byName = (p: Project) => {
  const m: Record<string, Layer> = {};
  for (const l of Object.values(p.layers)) if (!m[l.name]) m[l.name] = l;
  return m;
};
const kids = (p: Project, l: Layer) => l.children.map(id => p.layers[id]);
const rootNames = (p: Project) => p.comps[p.activeComp].root.map(id => p.layers[id].name);
const sq = (x: number, y: number, s: number, c = true) => ({ c, v: [[x, y], [x + s, y], [x + s, y + s], [x, y + s]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]] });
const solid = (ind: number, nm: string, extra: any = {}) => ({ ty: 1, ind, nm, sw: 100, sh: 100, sc: '#ff0000', ip: 0, op: 60, st: 0, ks: {}, ...extra });
const doc = (layers: any[], extra: any = {}) => ({ v: '5.7.0', fr: 30, ip: 0, op: 60, w: 200, h: 200, layers, ...extra });
const stats = (): LottieImportStats => ({ mattes: 0, invertedMattes: 0, invertedApprox: 0, lumaMattes: 0, masks: 0, maskRegions: 0, animatedPaths: 0, trims: 0, expressions: 0, timeRemaps: 0, unsupported: {} });

describe('lottie track mattes', () => {
  it('alpha matte: matte source is a mask below the content, never rendered on its own', () => {
    const st = stats();
    const p = lottieToProject(doc([
      solid(1, 'Matte', { td: 1, masksProperties: [{ mode: 'a', pt: { k: sq(10, 10, 50) }, o: { k: 100 } }], hasMask: true }),
      solid(2, 'Content', { tt: 1, sc: '#00ff00' }),
      solid(3, 'Below', { sc: '#0000ff' }),
    ]), 'm', st);
    expect(rootNames(p)).toEqual(['Below', 'Content (matte)']);
    const unit = byName(p)['Content (matte)'];
    const [mw, content] = kids(p, unit);
    expect(mw.mask).toBe(true);
    expect(mw.visible).toBe(true);
    expect(mw.outPoint).toBeGreaterThan(1e8); // the wrapper is always there: a matte out of range hides the content
    const matte = kids(p, mw)[0];
    expect(matte.name).toBe('Matte');
    expect(matte.type).toBe('path'); // solid + single add mask -> the masked path itself
    expect(matte.outPoint).toBe(2);
    expect(content.name).toBe('Content');
    expect(st.mattes).toBe(1);
  });

  it('inverted alpha matte of a path inverts the geometry (box + path, even-odd)', () => {
    const st = stats();
    const p = lottieToProject(doc([
      { ty: 4, ind: 1, nm: 'M', td: 1, ip: 0, op: 60, st: 0, ks: {}, shapes: [{ ty: 'sh', ks: { k: sq(50, 50, 20) } }, { ty: 'fl', c: { k: [1, 1, 1, 1] }, o: { k: 100 } }] },
      solid(2, 'C', { tt: 2 }),
    ]), 'm', st);
    const unit = byName(p)['C (matte)'];
    const m = kids(p, kids(p, unit)[0])[0];
    expect(m.geometry!.length).toBe(2);
    expect(m.geometry!.every(g => g.fillRule === 'evenodd')).toBe(true);
    expect(st.invertedMattes).toBe(1);
    expect(st.invertedApprox).toBe(0);
  });

  it('a matte source with multi-region masks is split into successive mask levels', () => {
    const p = lottieToProject(doc([
      solid(1, 'Matte', { td: 1, hasMask: true, masksProperties: [{ mode: 'a', pt: { k: sq(0, 0, 80) } }, { mode: 's', pt: { k: sq(20, 20, 20) } }] }),
      solid(2, 'Content', { tt: 1 }),
    ]));
    // levels: add region, subtract region, the solid itself; content innermost
    let cur = byName(p)['Content (matte)'];
    const wrappers: Layer[] = [];
    for (;;) {
      const [mw, next] = kids(p, cur);
      expect(mw.mask).toBe(true);
      wrappers.push(mw);
      if (next.name === 'Content') break;
      cur = next;
    }
    expect(wrappers.length).toBe(3);
    // nothing inside a mask subtree is itself a mask (the renderer would ignore it)
    const anyMask = (l: Layer): boolean => kids(p, l).some(k => k.mask || anyMask(k));
    expect(wrappers.some(anyMask)).toBe(false);
  });
});

describe('lottie layer masks', () => {
  it('solid with one add mask becomes a path layer in the solid colour', () => {
    const p = lottieToProject(doc([solid(1, 'S', { hasMask: true, masksProperties: [{ mode: 'a', pt: { k: sq(10, 20, 30) }, o: { k: 50 } }] })]));
    const s = byName(p)['S'];
    expect(s.type).toBe('path');
    expect(s.props.fill!.v).toEqual([1, 0, 0, 0.5]);
    expect(s.geomSize).toEqual([30, 30]);
    expect(s.props.anchor!.v).toEqual([-10, -20]); // geometry origin sits at (10, 20) in layer space
  });

  it('separate add masks stay separate fills (union), subtract makes an inverted nested region', () => {
    const p = lottieToProject(doc([{ ty: 4, ind: 1, nm: 'Shape', ip: 0, op: 60, st: 0, ks: {}, hasMask: true,
      masksProperties: [{ mode: 'a', pt: { k: sq(0, 0, 50) } }, { mode: 'a', pt: { k: sq(10, 10, 10) } }, { mode: 's', pt: { k: sq(5, 5, 5) } }],
      shapes: [{ ty: 'rc', s: { k: [100, 100] }, p: { k: [50, 50] }, r: { k: 0 } }, { ty: 'fl', c: { k: [0, 0, 1, 1] }, o: { k: 100 } }] }]));
    const g = byName(p)['Shape'];
    expect(g.type).toBe('group');
    const [m1, inner] = kids(p, g);
    expect(m1.mask).toBe(true);
    expect(m1.geometry!.length).toBe(2); // two adds = two separately filled paths (a union)
    const [m2, content] = kids(p, inner);
    expect(m2.mask).toBe(true);
    expect(m2.geometry!.length).toBe(1);
    expect(m2.geometry![0].fillRule).toBe('evenodd'); // layer box + subtracted path
    expect(content.type).toBe('rect');
  });

  it('old exports: shape items carry `closed`, masks are always closed', () => {
    const open = sq(0, 0, 10, false) as any;
    delete open.c;
    const p = lottieToProject(doc([{ ty: 4, ind: 1, nm: 'P', ip: 0, op: 60, st: 0, ks: {}, shapes: [{ ty: 'sh', closed: true, ks: { k: open } }, { ty: 'st', c: { k: [1, 1, 1, 1] }, o: { k: 100 }, w: { k: 2 } }] }]));
    const cmds = byName(p)['P'].geometry![0].cmds;
    expect(cmds[cmds.length - 1][0]).toBe('Z');
  });
});

describe('lottie shapes', () => {
  it('animated sh paths become pathKf in one geometry space', () => {
    const p = lottieToProject(doc([{ ty: 4, ind: 1, nm: 'Morph', ip: 0, op: 60, st: 0, ks: {}, shapes: [
      { ty: 'sh', ks: { a: 1, k: [{ t: 0, s: [sq(0, 0, 10)], o: { x: [0.4], y: [0] }, i: { x: [0.6], y: [1] } }, { t: 30, s: [sq(0, 0, 40)], h: 1 }, { t: 45, s: [sq(0, 0, 20)] }] } },
      { ty: 'fl', c: { k: [1, 1, 1, 1] }, o: { k: 100 } },
    ] }]));
    const l = byName(p)['Morph'];
    expect(l.type).toBe('path');
    expect(l.pathKf!.map(k => k.t)).toEqual([0, 1, 1.5]);
    expect(l.pathKf![0].out).toEqual([0.4, 0]);
    expect(l.pathKf![1].in).toEqual([0.6, 1]);
    expect(l.pathKf![1].interp).toBe('hold');
    expect(l.geomSize).toEqual([40, 40]); // union bounds over all keys
    expect(l.geometry).toEqual(l.pathKf![0].geometry);
  });

  it('trim paths map to trimOn + trimStart / trimEnd / trimOffset', () => {
    const st = stats();
    const p = lottieToProject(doc([{ ty: 4, ind: 1, nm: 'Line', ip: 0, op: 60, st: 0, ks: {}, shapes: [{ ty: 'gr', it: [
      { ty: 'sh', ks: { k: sq(0, 0, 50, false) } },
      { ty: 'tm', s: { k: 10 }, e: { a: 1, k: [{ t: 0, s: [0], o: { x: [0], y: [0] }, i: { x: [1], y: [1] } }, { t: 30, s: [100] }] }, o: { k: 90 }, m: 1 },
      { ty: 'st', c: { k: [1, 1, 1, 1] }, o: { k: 100 }, w: { k: 4 } },
      { ty: 'tr', p: { k: [0, 0] }, a: { k: [0, 0] }, s: { k: [100, 100] }, r: { k: 0 }, o: { k: 100 } },
    ] }] }]), 'x', st);
    const l = byName(p)['Line'];
    expect(l.type).toBe('path');
    expect(l.trimOn).toBe(true);
    expect(l.props.trimStart!.v).toEqual([10]);
    expect(l.props.trimEnd!.kf!.map(k => k.t)).toEqual([0, 1]);
    expect(l.props.trimOffset!.v).toEqual([90]);
    expect(st.trims).toBe(1);
  });

  it('trim converts an animated rect into keyed path geometry', () => {
    const p = lottieToProject(doc([{ ty: 4, ind: 1, nm: 'R', ip: 0, op: 60, st: 0, ks: {}, shapes: [
      { ty: 'rc', s: { a: 1, k: [{ t: 0, s: [10, 10] }, { t: 30, s: [50, 20] }] }, p: { k: [0, 0] }, r: { k: 0 } },
      { ty: 'tm', s: { k: 0 }, e: { k: 50 }, o: { k: 0 } },
      { ty: 'st', c: { k: [1, 1, 1, 1] }, o: { k: 100 }, w: { k: 1 } },
    ] }]));
    const l = byName(p)['R'];
    expect(l.type).toBe('path');
    expect(l.pathKf!.length).toBe(2);
    expect(l.geomSize).toEqual([50, 20]);
  });
});

describe('lottie layer order, time and expressions', () => {
  it('keeps the exact stacking order when a parent is below other layers', () => {
    const p = lottieToProject(doc([
      solid(1, 'Child', { parent: 3 }),
      solid(2, 'Middle'),
      { ty: 3, ind: 3, nm: 'Null', ip: 0, op: 60, st: 0, ks: { p: { k: [50, 0] } } },
    ]));
    // child is above Middle even though its parent null is below Middle
    expect(rootNames(p)).toEqual(['Middle', 'Null']);
    const wrapper = byName(p)['Null'];
    expect(wrapper.props.position!.v).toEqual([50, 0]);
    expect(kids(p, wrapper).map(l => l.name)).toEqual(['Child']);
  });

  it('precomp stretch (sr) and start time (st) map inner key times', () => {
    const p = lottieToProject(doc([{ ty: 0, ind: 1, nm: 'Pre', refId: 'c', w: 200, h: 200, ip: 0, op: 60, st: 6, sr: 2, ks: {} }], {
      assets: [{ id: 'c', layers: [solid(1, 'Inner', { ks: { o: { a: 1, k: [{ t: 0, s: [0] }, { t: 12, s: [100] }] } } })] }],
    }));
    const inner = byName(p)['Inner'];
    // parent frame = st + k * sr: k=0 -> 6 (0.2s), k=12 -> 30 (1s)
    expect(inner.props.opacity!.kf!.map(k => +k.t.toFixed(6))).toEqual([0.2, 1]);
  });

  it('linear time remap (tm) is inverted onto inner key times', () => {
    const st = stats();
    const p = lottieToProject(doc([{ ty: 0, ind: 1, nm: 'Pre', refId: 'c', w: 200, h: 200, ip: 0, op: 60, st: 0, ks: {},
      tm: { a: 1, k: [{ t: 0, s: [0], o: { x: [0], y: [0] }, i: { x: [1], y: [1] } }, { t: 60, s: [1] }] } }], { // 1s of the precomp over 2s
      assets: [{ id: 'c', layers: [solid(1, 'Inner', { ks: { o: { a: 1, k: [{ t: 0, s: [0] }, { t: 15, s: [100] }] } } })] }],
    }), 'x', st);
    const inner = byName(p)['Inner'];
    const ts = inner.props.opacity!.kf!.map(k => k.t);
    expect(ts[0]).toBeCloseTo(0, 3);
    expect(ts[1]).toBeCloseTo(1, 2); // inner frame 15 (0.5s) is reached at parent 1s
    expect(st.timeRemaps).toBe(1);
  });

  it('maps simple expressions and drops ones that need other layers', () => {
    expect(lottieExpr("var $bm_rt;\n$bm_rt = loopOut('cycle');")).toBe("loopOut('cycle')");
    expect(lottieExpr('var $bm_rt;\n$bm_rt = clamp(value, 0, 100);')).toBe('clamp(value, 0, 100)');
    expect(lottieExpr("var $bm_rt;\n$bm_rt = thisComp.layer('traceNull').transform.position;")).toBeUndefined();
    expect(lottieExpr('var $bm_rt;\nvar a = 1;\n$bm_rt = a;')).toBeUndefined();
    const p = lottieToProject(doc([solid(1, 'S', { ks: { r: { a: 1, k: [{ t: 0, s: [0] }, { t: 30, s: [90] }], x: "var $bm_rt;\n$bm_rt = loopOut('pingpong');" } } })]));
    expect(byName(p)['S'].props.rotation!.expr).toBe("loopOut('pingpong')");
  });

  it('maps layer blend modes', () => {
    const p = lottieToProject(doc([solid(1, 'A', { bm: 1 }), solid(2, 'B', { bm: 2 }), solid(3, 'C', { bm: 3 })]));
    const by = byName(p);
    expect(by['A'].blend).toBe('multiply');
    expect(by['B'].blend).toBe('screen');
    expect(by['C'].blend).toBeUndefined(); // overlay: unsupported, renders normal
  });
});
