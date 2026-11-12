// music in the editor: sync-to-music retime (landings on beats, key order, one undo step), snapping,
// the audio() expression, the agent audio tools, sound effects (deterministic synthesis, motion events,
// placement, family swap, re-follow after a retime), and the playback gain of fades / volume keys.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { editor } from '../src/app/editor';
import { createLayer, createProject, defaultEase, type Keyframe, type Layer } from '../src/core/model';
import { insertLayer } from '../src/core/commands';
import { synthTrack, MUSIC_120 } from '../src/audio/synth-track';
import { wavDataUrl } from '../src/audio/wav';
import { addAudioLayer } from '../src/audio/import';
import { ensureAnalysis } from '../src/audio/analysis-store';
import { music, beats, bars, refreshAudioEnv, snapToMusic } from '../src/audio/timing';
import { syncToMusic, motionEvents, makeWarp, patternTimes } from '../src/audio/sync';
import { compileExpr, compileProgram, runProgram, checkExpr, type ExprFrame } from '../src/core/expr';
import { TOOLS } from '../src/agent/tools';
import { renderSfx, findFamily, SFX_FAMILIES, SFX_TYPES } from '../src/audio/sfx';
import { layerEvents, addSoundEffects, setSfxFamily, sfxLayers, pickSfx, motionSfxEvents } from '../src/audio/sfx-place';
import { clipGain, collectAudioClips } from '../src/audio/engine';
import { editorContext } from '../src/agent/context';

const st = () => editor.store;
const FRAME = 1 / 30;
const run = async (name: string, args: any) => { const c = await TOOLS.find(t => t.name === name)!.run(args); return c[0].type === 'text' ? c[0].text : ''; };

let trackUrl = '';
beforeAll(() => { const tr = synthTrack(MUSIC_120); trackUrl = wavDataUrl([tr.samples], tr.sr); });

async function withMusic(): Promise<Layer> {
  st().load(createProject());
  st().transact('comp', tx => { tx.set(st().comp, 'fps', 30); tx.set(st().comp, 'duration', 24); tx.comp(); });
  const l = addAudioLayer('Track', trackUrl, 'audio/wav', { at: 0 });
  await ensureAnalysis(st().project.assets[l.imageRef!]);
  refreshAudioEnv(st());
  return st().layer(l.id)!;
}

const key = (t: number, v: number[]): Keyframe => ({ t, v, ...defaultEase() });
function box(name: string, tracks: Partial<Record<'position' | 'scale' | 'opacity' | 'trimEnd', Keyframe[]>>, extra: Partial<Layer> = {}): string {
  const l = createLayer(extra.type ?? 'rect', { name, x: 100, y: 100, w: 120, h: 120, ...extra } as any);
  for (const [k, kf] of Object.entries(tracks)) l.props[k as 'position'] = { v: kf![0].v.slice(), kf };
  st().transact('add', tx => insertLayer(st(), tx, l, null));
  return l.id;
}
const onGrid = (t: number, grid: number[], tol = 0.5 / 30) => grid.some(b => Math.abs(b - t) <= tol);

beforeEach(() => { st().load(createProject()); });

describe('sync to music', () => {
  it('moves landings and starts onto beats in one undo step, keeping key order and eases', async () => {
    await withMusic();
    // off-beat animation: three entrances landing at 1.13, 2.37, 3.6 (beats are every 0.5 s)
    const a = box('A', { position: [key(0.62, [100, 600]), key(1.13, [400, 600])], scale: [key(0.62, [0, 0]), key(0.9, [110, 110]), key(1.13, [100, 100])] });
    const b = box('B', { position: [key(1.9, [100, 300]), key(2.37, [500, 300])] });
    const c = box('C', { opacity: [key(3.2, [0]), key(3.6, [100])] });
    const before = JSON.stringify(st().project);
    const hist = st().historyLength;
    const r = syncToMusic(st(), { mode: 'beats' })!;
    expect(st().historyLength).toBe(hist + 1);
    expect(r.anchors.length).toBeGreaterThanOrEqual(3);
    const m = music(st())!, bt = beats(m);
    const A = st().layer(a)!, B = st().layer(b)!, C = st().layer(c)!;
    // the landings sit exactly on beats
    expect(onGrid(A.props.position!.kf![1].t, bt)).toBe(true);
    expect(onGrid(B.props.position!.kf![1].t, bt)).toBe(true);
    expect(onGrid(C.props.opacity!.kf![1].t, bt)).toBe(true);
    // key order kept on every track, eases untouched
    for (const l of [A, B, C]) for (const p of Object.values(l.props)) if (p?.kf) for (let i = 1; i < p.kf.length; i++) expect(p.kf[i].t).toBeGreaterThan(p.kf[i - 1].t);
    expect(A.props.scale!.kf![1].out).toEqual(defaultEase().out);
    // layers keep their order in time
    expect(A.props.position!.kf![1].t).toBeLessThan(B.props.position!.kf![1].t);
    // one undo restores everything
    st().undo();
    expect(JSON.stringify(st().project)).toBe(before);
  });

  it('bars mode puts the big landing on a downbeat; sections mode can reach the drop', async () => {
    await withMusic();
    const a = box('Hero', { position: [key(3.0, [100, 500]), key(3.7, [900, 500])] });
    syncToMusic(st(), { mode: 'bars' });
    const m = music(st())!;
    expect(onGrid(st().layer(a)!.props.position!.kf![1].t, bars(m))).toBe(true);
    // a reveal starting 1.2 s before the drop moves onto it
    st().undo();
    const d = box('Logo', { scale: [key(14.9, [0, 0]), key(15.5, [100, 100])] });
    syncToMusic(st(), { ids: [d], mode: 'sections' });
    const kf = st().layer(d)!.props.scale!.kf!;
    expect(Math.abs(kf[0].t - 16) < 0.5 / 30 || Math.abs(kf[1].t - 16) < 0.5 / 30).toBe(true);
  });

  it('motion events and the warp', () => {
    box('A', { position: [key(0, [0, 0]), key(1, [500, 0]), key(1.5, [450, 0]), key(2, [450, 0])] });
    const ev = motionEvents(st(), Object.values(st().project.layers));
    expect(ev.map(e => e.kind)).toEqual(['start', 'peak', 'land']);
    const w = makeWarp([{ from: 1, to: 1.2 }, { from: 2, to: 2 }]);
    expect(w(0.5)).toBeCloseTo(0.7); expect(w(1.5)).toBeCloseTo(1.6); expect(w(3)).toBeCloseTo(3);
    // never below zero: compresses instead
    const w2 = makeWarp([{ from: 0.4, to: 0 }]);
    expect(w2(0.2)).toBeGreaterThanOrEqual(0); expect(w2(0.4)).toBe(0);
  });

  it('build pattern accelerates into the drop', async () => {
    await withMusic();
    const t = patternTimes(music(st())!, 'build', 0, Infinity, 12);
    expect(t[t.length - 1]).toBeCloseTo(15.75, 2);
    const gaps = t.slice(1).map((x, i) => x - t[i]);
    expect(gaps[0]).toBeGreaterThan(gaps[gaps.length - 1]);
  });
});

describe('snapping to the music', () => {
  it('snaps to bars, beats and onsets within the distance', async () => {
    await withMusic();
    expect(snapToMusic(st(), 2.02, 0.05)).toBeCloseTo(2, 2);
    expect(snapToMusic(st(), 2.53, 0.05)).toBeCloseTo(2.5, 2);
    expect(snapToMusic(st(), 2.25, 0.01)).toBeNull();
    // the grid follows the layer's start time and the grid nudge
    st().transact('move', tx => { const l = st().layer(st().comp.root[0])!; tx.set(l, 'startTime', 0.1); tx.set(l, 'audio', { gridOffset: 0.02 }); tx.touch(l.id); });
    expect(snapToMusic(st(), 2.1, 0.05, { beats: true, bars: true })).toBeCloseTo(2.12, 2);
    // onsets are the audio itself: they move with the clip, not with the grid nudge
    expect(snapToMusic(st(), 2.1, 0.05)).toBeCloseTo(2.1, 2);
  });
});

describe('audio() expression', () => {
  const frame = (t: number, tOff = 0): ExprFrame => ({ time: t, index: 0, fps: 30, duration: 24, inPoint: 0, seed: 1, keyTimes: [], value: new Float64Array(4), valueAt: (_t, o) => { o[0] = 10; }, calls: 0, tOff });
  const val = (src: string, t: number, tOff = 0) => { const p = compileProgram(compileExpr(src).node!, 1); const o = new Float64Array(1); runProgram(p, frame(t, tOff), o, 0); return o[0]; };

  it('reads the envelopes of the comp music, live', async () => {
    expect(checkExpr("value + 20 * audio('low', 0.1, 0.2)", 1)).toBeNull();
    expect(checkExpr('audio(3)', 1)).toMatch(/audio\(/);
    await withMusic();
    const drop = [16.02, 16.52, 17.02].map(t => val("audio('low')", t)), build = [2.02, 2.52, 3.02].map(t => val("audio('low')", t));
    expect(Math.max(...drop)).toBeGreaterThan(Math.max(...build));
    // the beat pulse: high right after a beat, low just before the next
    expect(val("audio('beat')", 4.01)).toBeGreaterThan(0.8);
    expect(val("audio('beat')", 4.45)).toBeLessThan(0.3);
    expect(val("audio('accent')", 16.02)).toBeGreaterThan(0.8);
    // value + gain * level
    expect(val("value + 10 * audio('beat')", 4.01)).toBeGreaterThan(18);
    // precomp layers read the music at their root comp time
    expect(val("audio('beat')", 0.01, 4)).toBeGreaterThan(0.8);
    // smoothing gives a slower decay
    expect(val("audio('beat', 0.4)", 4.3)).toBeGreaterThan(val("audio('beat')", 4.3));
  });
});

describe('agent audio tools', () => {
  it('get_audio_analysis, place_on_beats, audio_reactive, sync_to_audio and the editor context', async () => {
    await withMusic();
    const s = await run('get_audio_analysis', {});
    expect(s).toMatch(/120 BPM, 4\/4/);
    expect(s).toMatch(/drop 16\.00/);
    expect(s).toMatch(/energy per bar/);
    const z = await run('get_audio_analysis', { from: 15, to: 17 });
    expect(z).toMatch(/16\.00\(9\.1\)/);
    expect(editorContext(st())).toMatch(/music: "Track" .*120 BPM 4\/4/);
    const ids = [box('W1', { opacity: [key(0, [0]), key(0.3, [100])] }), box('W2', { opacity: [key(0, [0]), key(0.3, [100])] }), box('W3', { opacity: [key(0, [0]), key(0.3, [100])] })];
    expect(await run('place_on_beats', { what: 'entrances', pattern: 'bar', ids, from: 4, anchor: 'land' })).toMatch(/3 entrances/);
    expect(st().layer(ids[2])!.props.opacity!.kf![1].t).toBeCloseTo(8, 2);
    expect(await run('place_on_beats', { what: 'markers', pattern: 'bar', to: 8 })).toMatch(/^5 markers/);
    expect(st().comp.markers!.length).toBe(5);
    await run('audio_reactive', { ids: [ids[0]], prop: 'scale', band: 'low', amount: 8 });
    expect(st().layer(ids[0])!.props.scale!.expr).toBe("value + [8, 8] * audio('low', 0.12, 0)");
    await run('audio_reactive', { ids: [ids[1]], prop: 'rotation', band: 'beat', amount: 5, bake: true, from: 0, to: 1 });
    expect(st().layer(ids[1])!.props.rotation!.kf!.length).toBe(31);
    expect(await run('sync_to_audio', { mode: 'beats' })).toMatch(/moments moved|nothing to sync/);
  });

  it('tools explain when there is no music', async () => {
    await expect(run('get_audio_analysis', {})).rejects.toThrow(/no audio layer/);
  });
});

describe('sound effects', () => {
  it('synthesis is deterministic, bounded and differs by family', () => {
    for (const t of SFX_TYPES) {
      const a = renderSfx(t, findFamily('crisp-ui'), 0.5, 22050), b = renderSfx(t, findFamily('crisp-ui'), 0.5, 22050);
      expect(a.L).toEqual(b.L);
      let pk = 0;
      for (const v of a.L) { expect(Number.isFinite(v)).toBe(true); pk = Math.max(pk, Math.abs(v)); }
      expect(pk).toBeGreaterThan(0.05); expect(pk).toBeLessThanOrEqual(1);
    }
    const x = renderSfx('whoosh', findFamily('cinematic'), 0.5, 22050), y = renderSfx('whoosh', findFamily('crisp-ui'), 0.5, 22050);
    expect(x.duration).toBeGreaterThan(y.duration);
    expect(SFX_FAMILIES.length).toBeGreaterThanOrEqual(7);
    expect(findFamily('Glitchy tech').id).toBe('glitchy-tech');
  });

  it('finds motion events: moves, landings, pops, draw-ons, type-ons, exits', () => {
    const mv = box('Card', { position: [key(0.2, [-300, 500]), key(0.8, [900, 500])], opacity: [key(3, [100]), key(3.3, [0])] }, { w: 400, h: 300 } as any);
    const pop = box('Dot', { scale: [key(1, [0, 0]), key(1.3, [100, 100])] });
    const line = box('Line', { trimEnd: [key(1.5, [0]), key(2.3, [100])] }, { type: 'path' } as any);
    const txt = createLayer('text', { name: 'Title', text: { content: 'Hello', fontFamily: 'Inter', fontSize: 40, fontWeight: 400, lineHeight: 1.2, letterSpacing: 0, align: 'left' }, textAnim: { by: 'char', start: 2, duration: 0.2, stagger: 0.05, ease: 'Expo Out', mode: 'in', from: { opacity: 0, dx: 0, dy: 0, scale: 1, rotation: 0 } } } as any);
    st().transact('t', tx => insertLayer(st(), tx, txt, null));
    const kinds = (id: string) => layerEvents(st(), st().layer(id)!).map(e => e.kind);
    expect(kinds(mv)).toEqual(expect.arrayContaining(['move', 'land', 'exit']));
    expect(kinds(pop)).toEqual(['pop']);
    expect(kinds(line)).toEqual(['drawon']);
    expect(kinds(txt.id).filter(k => k === 'type').length).toBe(5);
    // density: sparse keeps fewer sounds; near-simultaneous events are grouped
    const ev = motionSfxEvents(st());
    const fam = findFamily('crisp-ui');
    expect(pickSfx(ev, { density: 0.1, fam }).length).toBeLessThan(pickSfx(ev, { density: 0.9, fam }).length);
  });

  it('adds linked sfx layers in one step, swaps the family, snaps to beats and re-follows a retime', async () => {
    await withMusic();
    const a = box('Card', { position: [key(0.62, [-300, 500]), key(1.04, [900, 500])] }, { w: 400, h: 300 } as any);
    const hist = st().historyLength;
    const r = addSoundEffects(st(), { family: 'soft-warm', density: 0.6 });
    expect(st().historyLength).toBe(hist + 1);
    expect(r.ducked).toBe(true);
    const sfx = sfxLayers(st());
    expect(sfx.length).toBeGreaterThan(0);
    expect(sfx.every(l => l.sfx!.family === 'soft-warm' && l.sfx!.src === a)).toBe(true);
    // landing sound snapped to the beat at 1.0 (within 60 ms)
    const land = sfx.find(l => l.sfx!.event?.startsWith('land'))!;
    expect(land.startTime).toBeCloseTo(1.0, 2);
    // family swap keeps timing, changes the audio
    const before = sfx.map(l => [l.startTime, l.imageRef]);
    setSfxFamily(st(), 'crisp-ui');
    const after = sfxLayers(st());
    expect(after.every((l, i) => l.imageRef !== before[i][1])).toBe(true);
    const li = after.findIndex(l => l.sfx!.event?.startsWith('land'));
    expect(after[li].startTime).toBeCloseTo(before[li][0] as number, 6);
    // retime: the landing sound follows its layer
    syncToMusic(st(), { mode: 'bars' });
    const landT = st().layer(a)!.props.position!.kf![1].t;
    expect(sfxLayers(st()).find(l => l.sfx!.event?.startsWith('land'))!.startTime).toBeCloseTo(landT, 6);
    // the mix includes them
    expect(collectAudioClips(st().project, st().comp.root).length).toBe(1 + sfxLayers(st()).length);
  });
});

describe('audio layer gain (volume keys, fades, mute)', () => {
  it('multiplies static volume, volume keys and fades; mute drops the clip', async () => {
    const l = await withMusic();
    st().transact('v', tx => { tx.set(l, 'audio', { fadeIn: 1, fadeOut: 2 }); tx.set(l.props, 'volume', { v: [100], kf: [key(4, [100]), key(6, [50])] }); tx.touch(l.id); });
    const [c] = collectAudioClips(st().project, st().comp.root);
    expect(clipGain(c, 0, 25.5)).toBeCloseTo(0);
    expect(clipGain(c, 0.5, 25.5)).toBeCloseTo(0.5);
    expect(clipGain(c, 3, 25.5)).toBeCloseTo(1);
    expect(clipGain(c, 8, 25.5)).toBeCloseTo(0.5);
    expect(clipGain(c, 24.5, 25.5)).toBeCloseTo(0.25);
    st().transact('m', tx => { tx.set(l, 'audio', { mute: true }); tx.touch(l.id); });
    expect(collectAudioClips(st().project, st().comp.root).length).toBe(0);
  });
});
