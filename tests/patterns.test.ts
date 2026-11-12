import { describe, it, expect } from 'vitest';
import { bezierToFeel, bezierY, curveExcursion, feelName, feelToBezier, type Bez } from '../src/ui/patterns/feel';
import { detectStagger, grooveShape, retime, snapTo, staggerOffsets, layerSpan } from '../src/ui/patterns/timing';
import { applyStagger, applyTempo, easedKeys, EasePreview, snapshotTiming } from '../src/ui/patterns/ops';
import { cubicBezier } from '../src/core/easing';
import { Store } from '../src/core/store';
import { addLayer, keyId, setEase } from '../src/core/commands';
import type { Keyframe } from '../src/core/model';

const close = (a: number[], b: number[], eps = 1e-3) => a.every((x, i) => Math.abs(x - b[i]) < eps);

describe('feel pad mapping', () => {
  it('corners are the known expo curves and the bottom edge is linear', () => {
    expect(close(feelToBezier({ attack: 0, smooth: 1, overshoot: 0 }), [0.7, 0, 0.84, 0])).toBe(true);
    expect(close(feelToBezier({ attack: 0.5, smooth: 1, overshoot: 0 }), [0.87, 0, 0.13, 1])).toBe(true);
    expect(close(feelToBezier({ attack: 1, smooth: 1, overshoot: 0 }), [0.16, 1, 0.3, 1])).toBe(true);
    for (const a of [0, 0.3, 0.7, 1]) {
      const v = feelToBezier({ attack: a, smooth: 0, overshoot: 0 });
      for (const x of [0.1, 0.5, 0.9]) expect(bezierY(v, x)).toBeCloseTo(x, 2);
    }
  });
  it('is continuous across the pad', () => {
    let prev = feelToBezier({ attack: 0, smooth: 0.8, overshoot: 0 });
    for (let i = 1; i <= 200; i++) {
      const v = feelToBezier({ attack: i / 200, smooth: 0.8, overshoot: 0 });
      for (let j = 0; j < 4; j++) expect(Math.abs(v[j] - prev[j])).toBeLessThan(0.02);
      prev = v;
    }
  });
  it('attack moves progress earlier (punchy = more progress at the midpoint)', () => {
    const y = (a: number) => bezierY(feelToBezier({ attack: a, smooth: 0.8, overshoot: 0 }), 0.3);
    expect(y(0)).toBeLessThan(y(0.5));
    expect(y(0.5)).toBeLessThan(y(1));
  });
  it('overshoot goes past 1 on punchy curves and below 0 on lazy ones', () => {
    const out = feelToBezier({ attack: 1, smooth: 0.8, overshoot: 1 });
    let max = 0;
    for (let i = 0; i <= 100; i++) max = Math.max(max, bezierY(out, i / 100));
    expect(max).toBeGreaterThan(1.05);
    const lazy = feelToBezier({ attack: 0, smooth: 0.8, overshoot: 1 });
    let min = 0;
    for (let i = 0; i <= 100; i++) min = Math.min(min, bezierY(lazy, i / 100));
    expect(min).toBeLessThan(-0.03);
  });
  it('inverse mapping round-trips the curve', () => {
    for (const a of [0, 0.2, 0.5, 0.65, 1]) for (const k of [0.3, 0.6, 1]) for (const o of [0, 0.4]) {
      const v = feelToBezier({ attack: a, smooth: k, overshoot: o });
      const back = feelToBezier(bezierToFeel(v));
      for (let i = 0; i <= 10; i++) expect(Math.abs(bezierY(back, i / 10) - bezierY(v, i / 10))).toBeLessThan(0.02);
    }
  });
  it('places standard presets in the expected regions', () => {
    const expoOut = bezierToFeel([0.16, 1, 0.3, 1]);
    expect(expoOut.attack).toBeGreaterThan(0.9); expect(expoOut.smooth).toBeGreaterThan(0.9);
    const easeIn = bezierToFeel([0.42, 0, 1, 1]);
    expect(easeIn.attack).toBeLessThan(0.45);
    const backOut = bezierToFeel([0.34, 1.56, 0.64, 1] as Bez);
    expect(backOut.attack).toBeGreaterThan(0.6);
    expect(backOut.overshoot).toBeGreaterThan(0.2);
    expect(bezierToFeel([0, 0, 1, 1]).smooth).toBe(0);
  });
  it('bezierY matches the cached solver', () => {
    for (const v of [[0.16, 1, 0.3, 1], [0.68, -0.6, 0.32, 1.6], [0.42, 0, 0.58, 1]] as Bez[]) {
      const f = cubicBezier(...v);
      for (let i = 0; i <= 20; i++) expect(bezierY(v, i / 20)).toBeCloseTo(f(i / 20), 3);
    }
  });
  it('names feels', () => {
    expect(feelName({ attack: 1, smooth: 1, overshoot: 0 })).toBe('Snappy');
    expect(feelName({ attack: 0.5, smooth: 0, overshoot: 0 })).toBe('Linear');
    expect(feelName({ attack: 0.9, smooth: 0.5, overshoot: 0.6 })).toBe('Overshoot');
  });
});

describe('rhythm timing', () => {
  it('groove shapes and offsets', () => {
    expect(staggerOffsets(5, 0.1)).toEqual([0, 0.1, 0.2, 0.30000000000000004, 0.4].map(x => expect.closeTo(x, 9)));
    expect(grooveShape(0.5, 1)).toBeGreaterThan(0.5);
    expect(grooveShape(0.5, -1)).toBeLessThan(0.5);
    const o = staggerOffsets(6, 0.2, 0.6);
    expect(o[0]).toBe(0); expect(o[5]).toBeCloseTo(1, 9);
  });
  it('detects stagger and groove back', () => {
    const offs = staggerOffsets(7, 0.15, -0.5).map(x => 2 + x);
    const d = detectStagger(offs);
    expect(d.stagger).toBeCloseTo(0.15, 6);
    expect(d.groove).toBeCloseTo(-0.5, 6);
  });
  it('snaps magnetically', () => {
    expect(snapTo(1.04, [0.5, 1, 1.5], 0.1)).toBe(1);
    expect(snapTo(1.2, [0.5, 1, 1.5], 0.1)).toBe(1.2);
  });
  it('retime keeps order and pivot', () => {
    const kf = [{ t: 1 }, { t: 2 }, { t: 3 }] as Keyframe[];
    expect(retime(kf, 1, 0.5).map(k => k.t)).toEqual([1, 1.5, 2]);
  });
});

function scene() {
  const store = new Store();
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const l = addLayer(store, 'rect', { x: i * 100 });
    store.transact('k', tx => {
      tx.set(l.props.position!, 'kf', [
        { t: 0.5, v: [0, 0], interp: 'bezier', out: [0.33, 0], in: [0.67, 1] },
        { t: 1.5, v: [100, 0], interp: 'bezier', out: [0.33, 0], in: [0.67, 1] },
      ]);
      tx.set(l.props.opacity!, 'kf', [
        { t: 0.5, v: [0], interp: 'bezier', out: [0.33, 0], in: [0.67, 1] },
        { t: 1, v: [100], interp: 'bezier', out: [0.33, 0], in: [0.67, 1] },
      ]);
    });
    ids.push(l.id);
  }
  return { store, ids };
}

describe('pattern operations on the document', () => {
  it('stagger drag is one undo step and cascades start times', () => {
    const { store, ids } = scene();
    const snap = snapshotTiming(store, ids)!;
    const before = store.historyLength;
    applyStagger(store, snap, 0.05, 0, { mergeKey: 'm' });
    applyStagger(store, snap, 0.1, 0, { mergeKey: 'm' });
    expect(store.historyLength).toBe(before + 1);
    const starts = ids.map(id => layerSpan(store.layer(id)!)![0]);
    expect(starts.map(s => Math.round(s * 100) / 100)).toEqual([0.5, 0.6, 0.7, 0.8]);
    // each layer keeps its internal timing
    const l3 = store.layer(ids[3])!;
    expect(l3.props.position!.kf![1].t - l3.props.position!.kf![0].t).toBeCloseTo(1, 9);
    store.undo();
    expect(ids.map(id => layerSpan(store.layer(id)!)![0])).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
  it('stagger snaps the cascade as a whole to markers (spacing / groove stay intact)', () => {
    const { store, ids } = scene();
    // 4 layers from 0.5, stagger 0.1: the last starts at 0.8, the marker at 0.9 pulls it there
    applyStagger(store, snapshotTiming(store, ids)!, 0.1, 0, { targets: [0.9], radius: 0.12, mergeKey: 's' });
    const starts = ids.map(id => layerSpan(store.layer(id)!)![0]);
    expect(starts[3]).toBeCloseTo(0.9, 9);
    const det = detectStagger(starts);
    expect(det.groove).toBe(0); // per-layer snapping used to bend the cascade into a "groove"
    expect(det.stagger).toBeCloseTo(0.4 / 3, 2);
  });
  it('with the magnet on, a stagger nudge changes stagger, not groove', () => {
    const { store, ids } = scene();
    const markers = [0.6, 0.75, 1.0];
    for (const st of [0.05, 0.07, 0.09, 0.11]) {
      applyStagger(store, snapshotTiming(store, ids)!, st, 0, { targets: markers, radius: 0.08, mergeKey: 'n' + st });
      expect(detectStagger(ids.map(id => layerSpan(store.layer(id)!)![0])).groove).toBe(0);
    }
  });
  it('tempo never pushes keys past the composition end', () => {
    const { store, ids } = scene();
    store.transact('dur', tx => tx.set(store.comp, 'duration', 4));
    const snap = snapshotTiming(store, ids)!;
    const got = applyTempo(store, snap, 6.23, { mergeKey: 't' });
    expect(got).toBeCloseTo(3.5, 9); // starts at 0.5, ends at the comp end
    for (const id of ids) expect(layerSpan(store.layer(id)!)![1]).toBeLessThanOrEqual(4 + 1e-9);
    // a marker past the end does not pull it out either
    applyTempo(store, snap, 3.4, { targets: [4.05], radius: 0.2, mergeKey: 't' });
    for (const id of ids) expect(layerSpan(store.layer(id)!)![1]).toBeLessThanOrEqual(4 + 1e-9);
  });
  it('tempo stretches around the first key and snaps the end', () => {
    const { store, ids } = scene();
    const snap = snapshotTiming(store, ids)!;
    expect(snap.span).toEqual([0.5, 1.5]);
    const got = applyTempo(store, snap, 2, { mergeKey: 't' });
    expect(got).toBeCloseTo(2, 9);
    const l = store.layer(ids[0])!;
    expect(l.props.position!.kf!.map(k => k.t)).toEqual([0.5, 2.5]);
    expect(l.props.opacity!.kf!.map(k => k.t)).toEqual([0.5, 1.5]);
    const snapped = applyTempo(store, snap, 1.47, { targets: [2], radius: 0.1, mergeKey: 't' });
    expect(snapped).toBeCloseTo(1.5, 9);
  });
  it('easedKeys mirrors setEase', () => {
    const { store, ids } = scene();
    const kf = store.layer(ids[0])!.props.position!.kf!;
    const mine = easedKeys(kf, [0], { kind: 'bezier', v: [0.16, 1, 0.3, 1] });
    setEase(store, [keyId(ids[0], 'position', 0)], [0.16, 1, 0.3, 1]);
    expect(mine).toEqual(store.layer(ids[0])!.props.position!.kf);
  });
  it('hover preview leaves no trace in the document or history', () => {
    const { store, ids } = scene();
    const prop = store.layer(ids[0])!.props.position!;
    const orig = prop.kf;
    const json = JSON.stringify(store.project);
    const h = store.historyLength;
    store.setTime(3);
    const pv = new EasePreview(store);
    pv.begin([keyId(ids[0], 'position', 0)], { kind: 'spring', bounce: 0.5 });
    // the renderer sees the previewed ease, the document (autosave, agent tools) never does
    expect(store.renderProp(store.layer(ids[0])!, 'position')!.kf![0].interp).toBe('spring');
    expect(prop.kf![0].interp).not.toBe('spring');
    expect(JSON.stringify(store.project)).toBe(json);
    pv.tick(500);
    expect(store.time).toBeGreaterThanOrEqual(0.5);
    pv.begin([keyId(ids[0], 'position', 0)], { kind: 'linear' });
    pv.end();
    expect(prop.kf).toBe(orig);
    expect(JSON.stringify(store.project)).toBe(json);
    expect(store.historyLength).toBe(h);
    expect(store.time).toBe(3);
    expect(store.previewProps.size).toBe(0);
  });
  it('a real edit or undo during a hover preview ends it (no stale override, no clobbered edit)', () => {
    const { store, ids } = scene();
    const pv = new EasePreview(store);
    let ended = 0;
    pv.onEnd = () => ended++;
    pv.begin([keyId(ids[0], 'position', 0)], { kind: 'spring', bounce: 0.5 });
    expect(store.previewProps.size).toBe(1);
    setEase(store, [keyId(ids[0], 'position', 0)], [0.16, 1, 0.3, 1]); // e.g. an agent tool call
    expect(pv.active).toBe(false);
    expect(ended).toBe(1);
    expect(store.previewProps.size).toBe(0);
    expect(store.layer(ids[0])!.props.position!.kf![0].out).toEqual([0.16, 1]); // the edit survives
    pv.begin([keyId(ids[0], 'position', 0)], { kind: 'linear' });
    store.undo();
    expect(pv.active).toBe(false);
    expect(store.previewProps.size).toBe(0);
  });
});

import { buildKeys, fitBezier, simplify, type Sample } from '../src/ui/patterns/perform-math';

describe('gesture recording', () => {
  const perform = (f: (u: number) => [number, number], dur = 1, hz = 120): Sample[] =>
    Array.from({ length: Math.round(dur * hz) + 1 }, (_, i) => { const t = i / hz; const [x, y] = f(t / dur); return { t, x, y }; });
  it('fits an ease to sampled progress', () => {
    const target = Float64Array.from({ length: 16 }, (_, i) => bezierY([0.16, 1, 0.3, 1], (i + 0.5) / 16));
    const v = fitBezier(target);
    for (let i = 0; i <= 10; i++) expect(Math.abs(bezierY(v, i / 10) - bezierY([0.16, 1, 0.3, 1], i / 10))).toBeLessThan(0.03);
  });
  it('a straight eased stroke becomes two keys with the right ease', () => {
    const s = perform(u => [bezierY([0.42, 0, 0.58, 1], u) * 500, 100]);
    const keys = buildKeys(s, { fps: 60 });
    expect(keys.length).toBe(2);
    expect(keys[1].t).toBeCloseTo(1, 6);
    const v = [keys[0].out[0], keys[0].out[1], keys[1].in[0], keys[1].in[1]];
    expect(bezierY(v, 0.25)).toBeLessThan(0.2); // slow start survives
    expect(bezierY(v, 0.5)).toBeCloseTo(0.5, 1);
  });
  it('a stop in the middle of a gesture keeps a key there, jitter does not add keys', () => {
    const s: Sample[] = [];
    for (let i = 0; i <= 240; i++) {
      const t = i / 120;
      const x = t < 0.8 ? t / 0.8 * 300 : t < 1.2 ? 300 : 300 + (t - 1.2) / 0.8 * 300;
      s.push({ t, x: x + Math.sin(i * 7.1) * 0.8, y: Math.cos(i * 5.3) * 0.8 });
    }
    const keys = buildKeys(s, { fps: 60 });
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(keys.length).toBeLessThanOrEqual(5);
    expect(keys.some(k => Math.abs(k.t - 0.8) < 0.1)).toBe(true);
    keys.forEach((k, i) => { if (i) expect(k.t).toBeGreaterThan(keys[i - 1].t); });
  });
  it('a circle gets smooth spatial tangents', () => {
    const s = perform(u => [Math.cos(u * Math.PI * 2) * 200, Math.sin(u * Math.PI * 2) * 200]);
    const keys = buildKeys(s, { fps: 60 });
    expect(keys.length).toBeGreaterThan(3);
    expect(keys.length).toBeLessThan(14);
    expect(keys.slice(1, -1).every(k => k.sOut && k.sIn)).toBe(true);
    expect(simplify(s, 6, 400)[0]).toBe(0);
  });
  it('pickup lag and the hold before release add no identical-value keys', () => {
    const lag = 0.25, hold = 0.4, hz = 120;
    const s: Sample[] = [];
    for (let i = 0; i <= (lag + 1 + hold) * hz; i++) {
      const t = i / hz, u = Math.min(1, Math.max(0, (t - lag) / 1));
      s.push({ t, x: 100 + bezierY([0.42, 0, 0.58, 1], u) * 400, y: 50 });
    }
    const keys = buildKeys(s, { fps: 60 });
    expect(keys.length).toBe(2);
    expect(keys[0].t).toBe(0); // re-based: the motion starts where the playhead was
    expect(keys[1].t).toBeCloseTo(1, 6);
    for (let k = 1; k < keys.length; k++) expect(keys[k].v).not.toEqual(keys[k - 1].v);
  });
});

describe('overshoot knob', () => {
  it('overshoot above a small amount always leaves the 0..1 band, anywhere on the pad', () => {
    for (let a = 0; a <= 1.0001; a += 0.1) for (let k = 0.1; k <= 1.0001; k += 0.15) for (const o of [0.15, 0.3, 0.5, 1]) {
      const [under, over] = curveExcursion(feelToBezier({ attack: a, smooth: k, overshoot: o }));
      expect(Math.max(under, over)).toBeGreaterThan(o >= 0.5 ? 0.02 : o >= 0.3 ? 0.01 : 0.0025);
    }
  });
  it('the reported case: mid attack/smoothness, overshoot 50% visibly overshoots and is named from the curve', () => {
    const f = { attack: 0.5, smooth: 0.5, overshoot: 0.5 };
    const [under, over] = curveExcursion(feelToBezier(f));
    expect(Math.max(under, over)).toBeGreaterThan(0.02);
    expect(feelName(f)).toBe(under > 0.02 && over > 0.02 ? 'Elastic' : under > 0.02 ? 'Wind-up' : 'Overshoot');
    // no overshoot -> never an overshoot name
    for (let a = 0; a <= 1.0001; a += 0.25) expect(['Wind-up', 'Overshoot', 'Elastic']).not.toContain(feelName({ attack: a, smooth: 0.6, overshoot: 0 }));
  });
  it('stays continuous at overshoot 0 (no jump when the knob leaves zero)', () => {
    const a = feelToBezier({ attack: 0.5, smooth: 0.5, overshoot: 0 });
    const b = feelToBezier({ attack: 0.5, smooth: 0.5, overshoot: 0.005 });
    for (let i = 0; i < 4; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(0.02);
  });
});
