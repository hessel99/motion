import { describe, it, expect } from 'vitest';
import { cubicBezier, aeEaseToBezier, bezierToAeEase } from '../src/core/easing';
import { Track } from '../src/core/evaluate';
import { Store } from '../src/core/store';
import { addLayer, setProp, toggleAnimated, moveKeyframes, keyId, deleteLayers, groupLayers, valueAt, setEase, cloneLayers } from '../src/core/commands';

describe('easing', () => {
  it('linear is identity', () => {
    const f = cubicBezier(0, 0, 1, 1);
    for (const x of [0, 0.1, 0.5, 0.9, 1]) expect(f(x)).toBeCloseTo(x, 6);
  });
  it('matches css ease-in-out symmetry', () => {
    const f = cubicBezier(0.42, 0, 0.58, 1);
    expect(f(0.5)).toBeCloseTo(0.5, 5);
    expect(f(0.25) + f(0.75)).toBeCloseTo(1, 5);
  });
  it('is monotonic for standard curves', () => {
    const f = cubicBezier(0.16, 1, 0.3, 1);
    let prev = -1;
    for (let i = 0; i <= 1000; i++) { const y = f(i / 1000); expect(y).toBeGreaterThanOrEqual(prev - 1e-9); prev = y; }
  });
  it('overshoots for back curves', () => {
    const f = cubicBezier(0.34, 1.56, 0.64, 1);
    expect(Math.max(...Array.from({ length: 100 }, (_, i) => f(i / 100)))).toBeGreaterThan(1);
  });
  it('ae speed/influence round trip', () => {
    const b = aeEaseToBezier(0, 33.33, 0, 33.33, 100, 1);
    expect(b.x1).toBeCloseTo(0.3333, 3); expect(b.y1).toBe(0); expect(b.x2).toBeCloseTo(0.6667, 3); expect(b.y2).toBe(1);
    const ae = bezierToAeEase(0.25, 0.5, 0.75, 0.5, 100, 2);
    const back = aeEaseToBezier(ae.outSpeed, ae.outInfluence, ae.inSpeed, ae.inInfluence, 100, 2);
    expect(back.y1).toBeCloseTo(0.5, 6); expect(back.y2).toBeCloseTo(0.5, 6);
  });
});

describe('track', () => {
  const kf = (t: number, v: number[], interp: any = 'linear') => ({ t, v, interp, out: [0, 0] as [number, number], in: [1, 1] as [number, number] });
  it('evaluates linear and clamps', () => {
    const tr = new Track({ v: [0], kf: [kf(0, [0]), kf(1, [10]), kf(2, [0])] }, 1);
    expect(tr.eval1(-1)).toBe(0);
    expect(tr.eval1(0.5)).toBeCloseTo(5);
    expect(tr.eval1(1.5)).toBeCloseTo(5);
    expect(tr.eval1(3)).toBe(0);
  });
  it('random access matches sequential', () => {
    const keys = Array.from({ length: 50 }, (_, i) => kf(i * 0.1, [Math.sin(i)], 'bezier'));
    const a = new Track({ v: [0], kf: keys }, 1), b = new Track({ v: [0], kf: keys }, 1);
    const seq = Array.from({ length: 600 }, (_, i) => a.eval1(i / 100));
    for (let j = 0; j < 600; j++) { const i = Math.floor(Math.random() * 600); expect(b.eval1(i / 100)).toBeCloseTo(seq[i], 9); }
  });
  it('hold', () => {
    const tr = new Track({ v: [0], kf: [kf(0, [0], 'hold'), kf(1, [10])] }, 1);
    expect(tr.eval1(0.99)).toBe(0);
    expect(tr.eval1(1)).toBe(10);
  });
  it('spatial bezier stays on curve ends', () => {
    const k0 = { ...kf(0, [0, 0]), sOut: [50, 0] }, k1 = { ...kf(1, [100, 100]), sIn: [0, -50] };
    const tr = new Track({ v: [0, 0], kf: [k0, k1] }, 2, true);
    const o = [0, 0];
    tr.eval(0.5, o); expect(o[0]).toBeGreaterThan(50); expect(o[1]).toBeLessThan(50);
    tr.eval(1, o); expect(o).toEqual([100, 100]);
  });
});

describe('store + commands', () => {
  it('adds, animates, undoes', () => {
    const s = new Store();
    const l = addLayer(s, 'rect', { x: 0, y: 0, w: 100, h: 100 });
    expect(s.comp.root).toEqual([l.id]);
    toggleAnimated(s, [l.id], 'position');
    s.setTime(1);
    setProp(s, l.id, 'position', [500, 50]);
    expect(s.layer(l.id)!.props.position!.kf!.length).toBe(2);
    expect(valueAt(s.layer(l.id)!, 'position', 0.5)[0]).toBeGreaterThan(50);
    s.undo();
    expect(s.layer(l.id)!.props.position!.kf!.length).toBe(1);
    s.undo(); s.undo();
    expect(s.comp.root).toEqual([]);
    s.redo();
    expect(s.comp.root).toEqual([l.id]);
  });
  it('merges drag transactions', () => {
    const s = new Store();
    const l = addLayer(s, 'rect');
    for (let i = 0; i < 10; i++) setProp(s, l.id, 'rotation', [i], { mergeKey: 'drag' });
    s.undo();
    expect(s.layer(l.id)!.props.rotation!.v[0]).toBe(0);
  });
  it('moves keyframes and keeps order', () => {
    const s = new Store();
    const l = addLayer(s, 'rect');
    toggleAnimated(s, [l.id], 'opacity');
    s.setTime(2); setProp(s, l.id, 'opacity', [0]);
    moveKeyframes(s, [keyId(l.id, 'opacity', 0)], 3);
    const kf = s.layer(l.id)!.props.opacity!.kf!;
    expect(kf.map(k => k.t)).toEqual([2, 3]);
    setEase(s, [keyId(l.id, 'opacity', 0)], 'Expo Out');
    expect(s.layer(l.id)!.props.opacity!.kf![0].out).toEqual([0.16, 1]);
  });
  it('groups / deletes / duplicates', () => {
    const s = new Store();
    const a = addLayer(s, 'rect', { x: 100, y: 100, w: 50, h: 50 });
    const b = addLayer(s, 'ellipse', { x: 200, y: 100, w: 50, h: 50 });
    const g = groupLayers(s, [a.id, b.id], { x: 100, y: 100, w: 150, h: 50 })!;
    expect(s.comp.root).toEqual([g.id]);
    expect(s.layer(g.id)!.children).toEqual([a.id, b.id]);
    expect(s.layer(a.id)!.props.position!.v).toEqual([25, 25]);
    const [copy] = cloneLayers(s, [g.id]);
    expect(s.layer(copy)!.children.length).toBe(2);
    deleteLayers(s, [g.id]);
    expect(s.layer(a.id)).toBeUndefined();
    expect(Object.keys(s.project.layers).length).toBe(3);
  });
});

import { springAt } from '../src/core/easing';
describe('spring', () => {
  it('starts at 0, ends exactly at 1, overshoots when bouncy', () => {
    for (const b of [0, 0.2, 0.5, 0.8]) {
      expect(springAt(b, 0)).toBeCloseTo(0, 6);
      expect(springAt(b, 1)).toBeCloseTo(1, 6);
    }
    expect(Math.max(...Array.from({ length: 100 }, (_, i) => springAt(0.5, i / 100)))).toBeGreaterThan(1.05);
    expect(Math.max(...Array.from({ length: 100 }, (_, i) => springAt(0, i / 100)))).toBeLessThanOrEqual(1.0001);
  });
  it('track + pool agree for spring segments', async () => {
    const { TrackPool } = await import('../src/core/trackpool');
    const prop = { v: [0], kf: [{ t: 0, v: [0], interp: 'spring' as const, bounce: 0.4, out: [0, 0] as [number, number], in: [1, 1] as [number, number] }, { t: 1, v: [100], interp: 'linear' as const, out: [0, 0] as [number, number], in: [1, 1] as [number, number] }] };
    const tr = new Track(prop, 1); const pool = new TrackPool(); const h = pool.add(prop, 1, false);
    const o = new Float64Array(1);
    for (let t = 0; t <= 1; t += 0.05) { pool.eval(h, t, o, 0); expect(o[0]).toBeCloseTo(tr.eval1(t), 9); }
  });
});
