import { describe, it, expect, beforeEach } from 'vitest';
import { TOOLS } from '../src/agent/tools';
import { editor } from '../src/app/editor';
import { createProject } from '../src/core/model';
import { valueAt } from '../src/core/commands';
import { animRange } from '../src/agent/describe';

const run = async (name: string, args: any) => {
  const c = await TOOLS.find(t => t.name === name)!.run(args);
  return c[0].type === 'text' ? c[0].text : '';
};
const json = async (name: string, args: any) => JSON.parse(await run(name, args));

/** n boxes (100x100) built with build_scene, each with a 0.5s scale-in at t=0 */
async function boxes(n: number, animated = true) {
  const r = await json('build_scene', { layers: Array.from({ length: n }, (_, i) => ({ key: 'b' + i, x: i * 150, y: 100, w: 100, h: 100, ...(animated ? { animate: { scale: [{ t: 0, v: 0, ease: 'Expo Out' }, { t: 0.5, v: 100 }] } } : {}) })) });
  return Array.from({ length: n }, (_, i) => r.ids['b' + i] as string);
}

beforeEach(() => { editor.store.load(createProject()); });

describe('choreography tools', () => {
  it('arrange: grid, radial, path, scatter (animated positions move along) in one undo step', async () => {
    const s = editor.store;
    const ids = await boxes(4, false);
    const h = s.historyLength;
    await run('arrange', { ids, layout: 'grid', cols: 2, gap: 20, center: [500, 500] });
    expect(s.historyLength).toBe(h + 1);
    expect(valueAt(s.layer(ids[0])!, 'position', 0)).toEqual([440, 440]);
    expect(valueAt(s.layer(ids[3])!, 'position', 0)).toEqual([560, 560]);
    await run('arrange', { ids, layout: 'radial', center: [500, 500], radius: 200, rotate: true });
    expect(valueAt(s.layer(ids[0])!, 'position', 0).map(Math.round)).toEqual([500, 300]);
    expect(valueAt(s.layer(ids[1])!, 'rotation', 0)[0]).toBeCloseTo(90);
    await run('arrange', { ids, layout: 'path', d: 'M0 0 L300 0' });
    expect(valueAt(s.layer(ids[3])!, 'position', 0).map(Math.round)).toEqual([300, 0]);
    const sc = await json('arrange', { ids, layout: 'scatter', seed: 7 });
    const again = (await json('arrange', { ids, layout: 'scatter', seed: 7 })).centers;
    expect(again).toEqual(sc.centers); // seeded
    await run('arrange', { ids, layout: 'row', gap: 0, center: [200, 50], transition: { t: 1, duration: 0.5, stagger: 0.1 } });
    expect(s.layer(ids[1])!.props.position!.kf!.map(k => +k.t.toFixed(3))).toEqual([1.1, 1.6]);
    await expect(run('arrange', { ids, layout: 'path' })).rejects.toThrow(/needs d/);
  });

  it('choreograph: center-out, overlap and distance patterns shift whole animations', async () => {
    const s = editor.store;
    const ids = await boxes(5);
    await run('choreograph', { ids, pattern: 'center-out', step: 0.1 });
    expect(ids.map(id => +animRange(s.layer(id)!)![0].toFixed(3))).toEqual([0.2, 0.1, 0, 0.1, 0.2]);
    await run('choreograph', { ids, pattern: 'sequential', overlap: 0.5 });
    expect(ids.map(id => +animRange(s.layer(id)!)![0].toFixed(3))).toEqual([0, 0.25, 0.5, 0.75, 1]);
    const out = await run('choreograph', { ids, pattern: 'distance', point: [0, 150], spread: 0.4 });
    expect(out).toMatch(/distance: 5 layers/);
    expect(+animRange(s.layer(ids[4])!)![0].toFixed(3)).toBe(0.4);
    await expect(run('choreograph', { ids: [ids[0]] })).rejects.toThrow(/two animated/);
  });

  it('secondary_motion adds overshoot + settle and anticipation', async () => {
    const s = editor.store;
    const [id] = await boxes(1);
    await run('build_scene', { layers: [{ key: 'b0', animate: { position: [{ t: 0, v: [0, 0] }, { t: 1, v: [100, 0] }] } }] });
    await run('secondary_motion', { ids: [id], overshoot: 0.2, anticipation: 0.1, settle: 0.4 });
    const l = s.layer(id)!;
    const xs = l.props.position!.kf!.map(k => [+k.t.toFixed(3), +k.v[0].toFixed(3)]);
    expect(xs).toEqual([[0, 0], [0.25, -10], [1, 120], [1.2, 91], [1.4, 100]]);
    await expect(run('secondary_motion', { ids: [id], overshoot: 0, anticipation: 0 })).rejects.toThrow(/nothing to add/);
  });

  it('loop: cycle closes the loop and sets loopOut; fitComp makes whole loops', async () => {
    const s = editor.store;
    const [id] = await boxes(1);
    await run('build_scene', { layers: [{ key: 'b0', animate: { rotation: [{ t: 0, v: 0 }, { t: 0.5, v: 20 }, { t: 1, v: -20 }] } }] });
    const out = await run('loop', { ids: [id], mode: 'cycle', fitComp: true });
    const r = s.layer(id)!.props.rotation!;
    expect(r.expr).toBe("loopOut('cycle')");
    expect(r.kf!.map(k => k.t)).toEqual([0, 0.5, 1, 1.5]);
    expect(r.kf![3].v).toEqual([0]);
    expect(out).toMatch(/period 1.5s/);
    expect(s.comp.duration).toBeCloseTo(4.5);
    editor.store.load(createProject());
    await expect(run('loop', { ids: [(await boxes(2, false))[0]] })).rejects.toThrow(/nothing to loop/);
  });

  it('camera_rig groups layers by depth and keys a parallax move', async () => {
    const s = editor.store;
    const ids = await boxes(3, false);
    const r = await json('camera_rig', { layers: [{ id: ids[0], depth: 0.5 }, { id: ids[1], depth: 1 }, { id: ids[2], depth: 0 }], keys: [{ t: 0, x: 0 }, { t: 2, x: 400, zoom: 120 }] });
    const g = s.layer(r.groups['0.5'])!;
    expect(s.layer(ids[0])!.parent).toBe(g.id);
    expect(valueAt(g, 'position', 2)).toEqual([960 - 200, 540]);
    expect(valueAt(g, 'scale', 2).map(Math.round)).toEqual([110, 110]);
    expect(s.layer(r.groups['0'])!.props.position!.kf).toBeUndefined();
    // again: same groups
    const r2 = await json('camera_rig', { layers: [{ id: ids[0], depth: 0.5 }], keys: [{ t: 0, x: 0 }, { t: 1, x: 100 }] });
    expect(r2.groups['0.5']).toBe(g.id);
  });

  it('align_to_beats: start, sequence and keys modes', async () => {
    const s = editor.store;
    const ids = await boxes(3);
    await run('set_markers', { add: [{ t: 0.5, label: 'a' }, { t: 1, label: 'b' }, { t: 2, label: 'c' }] });
    await run('align_to_beats', { ids, mode: 'sequence' });
    expect(ids.map(id => animRange(s.layer(id)!)![0])).toEqual([0.5, 1, 2]);
    await run('align_to_beats', { ids: [ids[0]], mode: 'end', beats: [3] });
    expect(animRange(s.layer(ids[0])!)![1]).toBeCloseTo(3);
    const out = await run('align_to_beats', { ids: [ids[1]], mode: 'keys', bpm: 120, tolerance: 0.3 });
    expect(out).toMatch(/keys/);
    editor.store.load(createProject());
    const more = await boxes(2);
    await expect(run('align_to_beats', { ids: more })).rejects.toThrow(/no beats/);
  });
});
