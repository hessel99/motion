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

import { precompose, addPrecompLayer, newComposition } from '../src/core/commands';
describe('precomps', () => {
  it('precompose moves layers into a new comp and back with undo', () => {
    const s = new Store();
    const a = addLayer(s, 'rect', { x: 0, y: 0, w: 10, h: 10 });
    const b = addLayer(s, 'rect', { x: 20, y: 0, w: 10, h: 10 });
    const c = addLayer(s, 'rect', { x: 40, y: 0, w: 10, h: 10 });
    const { comp, layer } = precompose(s, [a.id, b.id]);
    expect(s.comp.root).toEqual([layer.id, c.id]);
    expect(s.project.comps[comp.id].root).toEqual([a.id, b.id]);
    s.undo();
    expect(s.comp.root).toEqual([a.id, b.id, c.id]);
    expect(s.project.comps[comp.id]).toBeUndefined();
  });
  it('refuses cycles', () => {
    const s = new Store();
    const main = s.comp.id;
    const inner = newComposition(s, { name: 'inner' });
    addPrecompLayer(s, inner.id);
    s.openComp(inner.id);
    expect(() => addPrecompLayer(s, main)).toThrow();
  });
});

import { applyPreset, alignLayers } from '../src/core/presets';
describe('presets + align', () => {
  it('slide up with stagger ends at the original position, offset per layer', () => {
    const s = new Store();
    const ls = [0, 1, 2].map(i => addLayer(s, 'rect', { x: i * 100, y: 100, w: 50, h: 50 }));
    s.setTime(1);
    applyPreset(s, ls.map(l => l.id), 'Slide up', { duration: 0.5, stagger: 0.1 });
    ls.forEach((l, i) => {
      const kf = s.layer(l.id)!.props.position!.kf!;
      expect(kf[0].t).toBeCloseTo(1 + i * 0.1, 9);
      expect(kf[1].t).toBeCloseTo(1.5 + i * 0.1, 9);
      expect(kf[1].v).toEqual([i * 100 + 25, 125]);
      expect(kf[0].v[1]).toBe(205);
    });
    s.undo();
    expect(s.layer(ls[0].id)!.props.position!.kf).toBeUndefined();
  });
  it('align left to the composition', () => {
    const s = new Store();
    const l = addLayer(s, 'rect', { x: 300, y: 100, w: 50, h: 50 });
    alignLayers(s, [l.id], 'left', () => [300, 100, 350, 150], () => [1, 0, 0, 1, 0, 0]);
    expect(valueAt(s.layer(l.id)!, 'position', 0)).toEqual([25, 125]);
  });
});

import { snapshotKeys, moveKeysFrom, setPropTx as _setPropTx, setSpring as _setSpring } from '../src/core/commands';
describe('review regressions', () => {
  const keyed = (s: Store, times: number[]) => {
    const l = addLayer(s, 'rect');
    s.setTime(times[0]);
    toggleAnimated(s, [l.id], 'rotation');
    times.forEach((t, i) => { s.setTime(t); setProp(s, l.id, 'rotation', [i * 90]); });
    return l;
  };
  it('group is a single undo step', () => {
    const s = new Store();
    const a = addLayer(s, 'rect', { x: 100, y: 100, w: 50, h: 50 });
    groupLayers(s, [a.id], { x: 100, y: 100, w: 50, h: 50 });
    s.undo();
    expect(s.comp.root).toEqual([a.id]);
    expect(s.layer(a.id)!.props.position!.v).toEqual([125, 125]);
    expect(Object.keys(s.project.layers)).toEqual([a.id]);
  });
  it('dragging a key across another key does not delete it', () => {
    const s = new Store();
    const l = keyed(s, [0, 1, 2]);
    const snap = snapshotKeys(s, [keyId(l.id, 'rotation', 0)]);
    moveKeysFrom(s, snap, 1.5);
    moveKeysFrom(s, snap, 0.5);
    expect(s.layer(l.id)!.props.rotation!.kf!.map(k => k.t)).toEqual([0.5, 1, 2]);
  });
  it('a merged drag keeps one undo/redo op per slot and undoes/redoes exactly', () => {
    const s = new Store();
    const a = keyed(s, [0, 1, 2]);
    const b = keyed(s, [0.5, 1.5]);
    const before = [a, b].map(l => JSON.stringify(s.layer(l.id)!.props.rotation));
    const keys = [keyId(a.id, 'rotation', 0), keyId(a.id, 'rotation', 1), keyId(a.id, 'rotation', 2), keyId(b.id, 'rotation', 0)];
    s.keySelection = new Set(keys);
    s.beginGesture('keys');
    const snap = snapshotKeys(s, s.keySelection);
    for (let i = 1; i <= 50; i++) moveKeysFrom(s, snap, i * 0.05); // b's key crosses 1.5 and replaces nothing mid-drag
    s.endGesture();
    const after = [a, b].map(l => JSON.stringify(s.layer(l.id)!.props.rotation));
    expect(s.layer(a.id)!.props.rotation!.kf!.map(k => +k.t.toFixed(6))).toEqual([2.5, 3.5, 4.5]);
    expect(s.layer(b.id)!.props.rotation!.kf!.map(k => +k.t.toFixed(6))).toEqual([1.5, 3]);
    expect([...s.keySelection].sort()).toEqual([keyId(a.id, 'rotation', 0), keyId(a.id, 'rotation', 1), keyId(a.id, 'rotation', 2), keyId(b.id, 'rotation', 1)].sort());
    expect(s.historyLabels.at(-1)).toBe('Move keyframes');
    const entry = (s as any).undoStack.at(-1);
    expect(entry.undo.length).toBe(2);
    expect(entry.redo.length).toBe(2);
    const n = s.historyLength;
    s.undo();
    expect([a, b].map(l => JSON.stringify(s.layer(l.id)!.props.rotation))).toEqual(before);
    s.redo();
    expect([a, b].map(l => JSON.stringify(s.layer(l.id)!.props.rotation))).toEqual(after);
    expect(s.historyLength).toBe(n);
  });
  it('merged steps that create then edit a slot undo to the original state', () => {
    const s = new Store();
    const l = addLayer(s, 'rect');
    const had = 'rotation' in s.layer(l.id)!.props;
    for (let i = 0; i < 5; i++) s.transact('Edit', tx => { const L = s.layer(l.id)!; tx.set(L.props, 'rotation', { v: [i] }); tx.set(L.props.rotation!, 'v', [i * 10]); tx.set(L, 'name', 'n' + i); tx.touch(l.id); }, 'm');
    expect(s.layer(l.id)!.props.rotation!.v).toEqual([40]);
    s.undo();
    expect('rotation' in s.layer(l.id)!.props).toBe(had);
    expect(s.layer(l.id)!.name).not.toBe('n0');
    s.redo();
    expect(s.layer(l.id)!.props.rotation!.v).toEqual([40]);
    expect(s.layer(l.id)!.name).toBe('n4');
  });
  it('multi-key drag toward 0 keeps spacing', () => {
    const s = new Store();
    s.setTime(0.2);
    const l = keyed(s, [0.2, 0.5, 2]);
    const snap = snapshotKeys(s, [keyId(l.id, 'rotation', 0), keyId(l.id, 'rotation', 1)]);
    moveKeysFrom(s, snap, -0.4);
    moveKeysFrom(s, snap, 0);
    expect(s.layer(l.id)!.props.rotation!.kf!.map(k => +k.t.toFixed(6))).toEqual([0.2, 0.5, 2]);
  });
  it('transactions are atomic', () => {
    const s = new Store();
    const l = addLayer(s, 'rect');
    const before = s.layer(l.id)!.props.position!.v.slice();
    expect(() => s.transact('bad', tx => { _setPropTx(tx, s.layer(l.id)!, 'position', [999, 999], 0); throw new Error('boom'); })).toThrow();
    expect(s.layer(l.id)!.props.position!.v).toEqual(before);
  });
  it('key selection is cleared when keys are inserted', () => {
    const s = new Store();
    const l = keyed(s, [0, 2]);
    s.keySelection = new Set([keyId(l.id, 'rotation', 1)]);
    s.setTime(1); setProp(s, l.id, 'rotation', [45]);
    expect(s.keySelection.size).toBe(0);
  });
  it('inserting into a spring segment keeps the bounce', () => {
    const s = new Store();
    const l = keyed(s, [0, 2]);
    _setSpring(s, [keyId(l.id, 'rotation', 0)], 0.8);
    s.setTime(1); setProp(s, l.id, 'rotation', [10]);
    expect(s.layer(l.id)!.props.rotation!.kf![1].bounce).toBe(0.8);
  });
  it('duplicating a group with its child copies the child once', () => {
    const s = new Store();
    const a = addLayer(s, 'rect');
    const g = groupLayers(s, [a.id], { x: 0, y: 0, w: 200, h: 200 })!;
    cloneLayers(s, [g.id, a.id]);
    expect(Object.keys(s.project.layers).length).toBe(4);
  });
});

import { ownerRoot, setCompSettings as _setComp } from '../src/core/commands';
describe('review 2 regressions', () => {
  it('undoing "new composition" while it is open falls back to an existing comp', () => {
    const s = new Store();
    const main = s.comp.id;
    const c = newComposition(s, { name: 'x' });
    s.openComp(c.id);
    s.undo();
    expect(s.comp).toBeDefined();
    expect(s.project.activeComp).toBe(main);
  });
  it('deleting a top-level layer of a non-active comp cleans that comp root', () => {
    const s = new Store();
    const a = addLayer(s, 'rect');
    const { comp } = precompose(s, [a.id]);
    expect(ownerRoot(s, a.id)?.comp.id).toBe(comp.id);
    deleteLayers(s, [a.id]);
    expect(s.project.comps[comp.id].root).toEqual([]);
  });
  it('precomp layers follow their source comp size', () => {
    const s = new Store();
    const a = addLayer(s, 'rect');
    const { comp, layer } = precompose(s, [a.id]);
    s.openComp(comp.id);
    _setComp(s, { width: 3000 });
    expect(s.layer(layer.id)!.props.size!.v[0]).toBe(3000);
  });
  it('"out" presets at time 0 keep distinct keyframes', () => {
    const s = new Store();
    const a = addLayer(s, 'rect');
    s.setTime(0);
    applyPreset(s, [a.id], 'Fade out', { duration: 0.5 });
    const kf = s.layer(a.id)!.props.opacity!.kf!;
    expect(kf.map(k => k.t)).toEqual([0, 0.5]);
    expect(kf.map(k => k.v[0])).toEqual([100, 0]);
  });
});

import { interpPathKeys } from '../src/render/renderer';
describe('path morphing', () => {
  it('interpolates matching command structures and holds otherwise', () => {
    const k = (t: number, x: number) => ({ t, geometry: [{ cmds: [['M', 0, 0], ['L', x, 0], ['Z']] as any, fillRule: 'nonzero' as const }], interp: 'linear' as const, out: [0, 0] as [number, number], in: [1, 1] as [number, number] });
    const kf = [k(0, 100), k(1, 200)];
    const lin = (p: number) => p;
    expect(interpPathKeys(kf, [lin, lin], 0.5)[0].cmds[1]).toEqual(['L', 150, 0]);
    expect(interpPathKeys(kf, [lin, lin], 2)[0].cmds[1]).toEqual(['L', 200, 0]);
  });
});

describe('markers', () => {
  it('add (frame snapped, deduped), move with merge, rename, delete, undo', async () => {
    const { addMarker, updateMarker, deleteMarker } = await import('../src/core/commands');
    const { projectToLottie } = await import('../src/export/lottie');
    const s = new Store();
    const fps = s.comp.fps;
    const a = addMarker(s, 1.004);
    expect(a.t).toBeCloseTo(Math.round(1.004 * fps) / fps, 9);
    expect(addMarker(s, a.t).id).toBe(a.id); // same frame: no duplicate
    const b = addMarker(s, 0.5, 'start');
    expect(s.comp.markers!.map(m => m.id)).toEqual([b.id, a.id]); // sorted
    updateMarker(s, a.id, { t: 0.2 }, 'drag');
    updateMarker(s, a.id, { t: 0.3 }, 'drag');
    expect(s.comp.markers!.map(m => m.id)).toEqual([a.id, b.id]);
    s.undo(); // both moves are one step
    expect(s.comp.markers!.find(m => m.id === a.id)!.t).toBeCloseTo(a.t, 9);
    updateMarker(s, a.id, { label: 'hit' });
    expect(projectToLottie(s.project).markers).toEqual([{ tm: 30, cm: 'start', dr: 0 }, { tm: Math.round(a.t * fps * 1e6) / 1e6, cm: 'hit', dr: 0 }]);
    deleteMarker(s, b.id);
    expect(s.comp.markers!.length).toBe(1);
    s.undo();
    expect(s.comp.markers!.length).toBe(2);
  });
});

describe('smart animate', () => {
  it('matches by name path, keys differences, fades unmatched, removes the end root', async () => {
    const { smartAnimate } = await import('../src/core/smart');
    const s = new Store();
    const A = addLayer(s, 'group', { x: 0, y: 0, w: 400, h: 300, name: 'Card' } as any);
    const a1 = addLayer(s, 'rect', { x: 10, y: 10, w: 50, h: 50, color: [1, 0, 0, 1], name: 'Box' } as any, A.id);
    const a2 = addLayer(s, 'rect', { x: 100, y: 10, w: 50, h: 50, name: 'Gone' } as any, A.id);
    const B = addLayer(s, 'group', { x: 800, y: 0, w: 400, h: 500, name: 'Card' } as any);
    addLayer(s, 'rect', { x: 200, y: 40, w: 80, h: 50, color: [0, 0, 1, 1], name: 'Box' } as any, B.id);
    const b2 = addLayer(s, 'rect', { x: 5, y: 200, w: 20, h: 20, name: 'New' } as any, B.id);
    const before = s.historyLength;
    s.setTime(1);
    const r = smartAnimate(s, A.id, B.id, { duration: 0.5 });
    expect(r).toMatchObject({ matched: 1, fadedIn: 1, fadedOut: 1 });
    expect(s.layer(B.id)).toBeUndefined();
    const box = s.layer(a1.id)!;
    expect(box.props.position!.kf!.map(k => [k.t, ...k.v])).toEqual([[1, 35, 35], [1.5, 240, 65]]); // anchor is centered
    expect(valueAt(box, 'fill', 1.5)).toEqual([0, 0, 1, 1]);
    expect(valueAt(box, 'size', 1.5)).toEqual([80, 50]);
    // root keeps its position, animates its size
    expect(s.layer(A.id)!.props.position?.kf).toBeUndefined();
    expect(valueAt(s.layer(A.id)!, 'size', 1.5)).toEqual([400, 500]);
    // fades
    expect(valueAt(s.layer(a2.id)!, 'opacity', 1.5)).toEqual([0]);
    const nb = s.layer(b2.id)!;
    expect(nb.parent).toBe(A.id);
    expect(valueAt(nb, 'opacity', 1)).toEqual([0]);
    expect(valueAt(nb, 'opacity', 1.5)).toEqual([100]);
    // one undo step restores everything
    expect(s.historyLength).toBe(before + 1);
    s.undo();
    expect(s.layer(B.id)).toBeDefined();
    expect(s.layer(b2.id)!.parent).toBe(B.id);
    expect(s.layer(a1.id)!.props.position?.kf).toBeUndefined();
  });
});

describe('parent changes keep the on-screen transform', () => {
  const world = async (s: Store, id: string, x: number, y: number) => {
    const { layerWorldMatrix } = await import('../src/core/commands');
    const m = layerWorldMatrix(s, id, s.time);
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]].map(v => Math.round(v * 1000) / 1000);
  };
  it('ungroup folds the group rotation/scale/opacity into the children', async () => {
    const { ungroup } = await import('../src/core/commands');
    const s = new Store();
    const a = addLayer(s, 'rect', { x: 100, y: 100, w: 50, h: 50 } as any);
    const b = addLayer(s, 'rect', { x: 300, y: 150, w: 40, h: 20 } as any);
    const g = groupLayers(s, [a.id, b.id], { x: 100, y: 100, w: 240, h: 70 })!;
    setProp(s, g.id, 'rotation', [30]);
    setProp(s, g.id, 'scale', [150, 150]);
    setProp(s, g.id, 'opacity', [50]);
    const before = [await world(s, a.id, 0, 0), await world(s, a.id, 50, 50), await world(s, b.id, 40, 20)];
    ungroup(s, g.id);
    expect(s.layer(g.id)).toBeUndefined();
    expect([await world(s, a.id, 0, 0), await world(s, a.id, 50, 50), await world(s, b.id, 40, 20)]).toEqual(before);
    expect(valueAt(s.layer(a.id)!, 'opacity', 0)).toEqual([50]);
  });
  it('moving into a transformed group keeps the world position (keepWorld)', async () => {
    const { moveLayers } = await import('../src/core/commands');
    const s = new Store();
    const a = addLayer(s, 'rect', { x: 0, y: 0, w: 50, h: 50 } as any);
    const g = groupLayers(s, [a.id], { x: 0, y: 0, w: 50, h: 50 })!;
    setProp(s, g.id, 'position', [400, 300]);
    setProp(s, g.id, 'rotation', [90]);
    const r = addLayer(s, 'rect', { x: 1000, y: 500, w: 60, h: 40 } as any);
    const before = [await world(s, r.id, 0, 0), await world(s, r.id, 60, 40)];
    moveLayers(s, [r.id], g.id, 0, { keepWorld: true });
    expect(s.layer(r.id)!.parent).toBe(g.id);
    expect([await world(s, r.id, 0, 0), await world(s, r.id, 60, 40)]).toEqual(before);
  });
});

describe('undo invalidation', () => {
  it('undo/redo report what the step changed, not every layer', () => {
    const s = new Store();
    const a = addLayer(s, 'rect', {});
    const b = addLayer(s, 'rect', {});
    setProp(s, a.id, 'opacity', [50]);
    const seen: any[] = [];
    s.onChange(c => seen.push(c));
    s.undo();
    expect(seen[0].structure).toBe(false);
    expect([...seen[0].layers]).toEqual([a.id]);
    s.redo();
    expect([...seen[1].layers]).toEqual([a.id]);
    s.undo(); s.undo(); // removes layer b: a structural step
    expect(seen[3].structure).toBe(true);
    expect(s.layer(b.id)).toBeUndefined();
  });
});
