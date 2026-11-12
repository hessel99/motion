// regressions from the motion-designer QA (docs/next-up.md, MD-xx)
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GIFEncoder } from 'gifenc';
import { Store } from '../src/core/store';
import { addLayer, setProp, toggleAnimated, toggleKeyAtTime, removeEffect, setEffectVisible, effectVisible, groupLayers, precompose, valueAt } from '../src/core/commands';
import { EffectEval } from '../src/render/effects';
import { gifDelaysCs } from '../src/export/gif';

// the exporters read the live editor; these tests only need their pure helpers
vi.mock('../src/app/editor', () => ({ editor: {} }));

describe('MD-13: property shortcuts never wipe an animation', () => {
  it('Alt+Shift+<prop> toggles one key at the playhead, keeps the others', () => {
    const s = new Store();
    const l = addLayer(s, 'rect', { x: 0, y: 0, w: 100, h: 100 });
    toggleAnimated(s, [l.id], 'position');
    s.setTime(1); setProp(s, l.id, 'position', [300, 0]);
    s.setTime(2); setProp(s, l.id, 'position', [600, 0]);
    const kf = () => s.layer(l.id)!.props.position!.kf ?? [];
    expect(kf().length).toBe(3);
    // on a key: only that key goes
    s.setTime(1); toggleKeyAtTime(s, [l.id], 'position');
    expect(kf().map(k => k.t)).toEqual([0, 2]);
    // between keys: a key with the current value is added
    s.setTime(0.5); toggleKeyAtTime(s, [l.id], 'position');
    expect(kf().map(k => k.t)).toEqual([0, 0.5, 2]);
    s.undo(); s.undo();
    expect(kf().length).toBe(3);
    // a static property: starts animating with one key
    toggleKeyAtTime(s, [l.id], 'opacity');
    expect(s.layer(l.id)!.props.opacity!.kf!.length).toBe(1);
  });
  it('the stopwatch (toggleAnimated) is one named, undoable step', () => {
    const s = new Store();
    const l = addLayer(s, 'rect');
    toggleAnimated(s, [l.id], 'rotation');
    s.setTime(1); setProp(s, l.id, 'rotation', [90]);
    toggleAnimated(s, [l.id], 'rotation');
    expect(s.layer(l.id)!.props.rotation!.kf).toBeUndefined();
    s.undo();
    expect(s.layer(l.id)!.props.rotation!.kf!.length).toBe(2);
  });
});

describe('MD-43: GIF frame delays add up to the comp duration', () => {
  it('spreads the centisecond rounding (30 fps: 3,4,3 …), exact total for every fps', () => {
    expect(gifDelaysCs(6, 30)).toEqual([3, 4, 3, 3, 4, 3]);
    for (const fps of [10, 12, 15, 24, 25, 30, 50]) {
      for (const sec of [1, 2, 3.5]) {
        const n = Math.round(sec * fps);
        const d = gifDelaysCs(n, fps);
        expect(d.reduce((a, b) => a + b, 0)).toBe(Math.round((n * 100) / fps));
        expect(Math.max(...d) - Math.min(...d)).toBeLessThanOrEqual(1);
      }
    }
  });
  it('a 2 s, 30 fps GIF decodes to 2.0 s (graphic control blocks + ffprobe)', () => {
    const gif = GIFEncoder();
    const delays = gifDelaysCs(60, 30);
    const pal = [[0, 0, 0], [255, 255, 255]];
    for (let i = 0; i < 60; i++) gif.writeFrame(new Uint8Array(16).fill(i & 1), 4, 4, { palette: i === 0 ? pal : undefined, delay: delays[i] * 10 });
    gif.finish();
    const bytes = gif.bytes();
    // graphic control extensions: 21 F9 04 flags delayLo delayHi …
    let cs = 0;
    for (let i = 0; i < bytes.length - 6; i++) if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 4) cs += bytes[i + 4] | (bytes[i + 5] << 8);
    expect(cs).toBe(200);
    try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); } catch { return; } // ffprobe not installed
    const f = join(mkdtempSync(join(tmpdir(), 'gif-')), 't.gif');
    writeFileSync(f, bytes);
    const dur = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim();
    expect(dur).toBeCloseTo(2, 2);
  });
});

describe('MD-10: effects can be hidden and removed', () => {
  const live = (l: any) => new EffectEval(l, k => l.props[k]).list.map(e => e.type);
  it('hide keeps the values, the renderer skips it; show brings it back', () => {
    const s = new Store();
    const l = addLayer(s, 'rect');
    setProp(s, l.id, 'shadowColor', [0, 0, 0, 0.5]);
    setProp(s, l.id, 'blur', [6]);
    expect(live(s.layer(l.id))).toEqual(['dropShadow', 'layerBlur']);
    setEffectVisible(s, [l.id], 'dropShadow', false);
    expect(effectVisible(s.layer(l.id)!, 'dropShadow')).toBe(false);
    expect(s.layer(l.id)!.props.shadowColor).toBeTruthy();
    expect(live(s.layer(l.id))).toEqual(['layerBlur']);
    setEffectVisible(s, [l.id], 'dropShadow', true);
    expect(live(s.layer(l.id))).toEqual(['dropShadow', 'layerBlur']);
  });
  it('remove drops the effect, its props and keyframes in one undo step', () => {
    const s = new Store();
    const l = addLayer(s, 'rect');
    s.setTime(0); setProp(s, l.id, 'blur', [0], { forceKey: true });
    s.setTime(1); setProp(s, l.id, 'blur', [10]);
    s.layer(l.id)!.effects = [{ type: 'layerBlur', radius: 10 }, { type: 'dropShadow', radius: 4 }];
    removeEffect(s, [l.id], 'layerBlur');
    expect(s.layer(l.id)!.props.blur).toBeUndefined();
    expect(s.layer(l.id)!.effects!.map(e => e.type)).toEqual(['dropShadow']);
    s.undo();
    expect(s.layer(l.id)!.props.blur!.kf!.length).toBe(2);
    expect(s.layer(l.id)!.effects!.length).toBe(2);
  });
});

describe('MD-08: pre-compose layers inside a group / frame', () => {
  const scene = () => {
    const s = new Store();
    const a = addLayer(s, 'rect', { x: 100, y: 100, w: 50, h: 50 });
    const b = addLayer(s, 'rect', { x: 300, y: 120, w: 50, h: 50 });
    const c = addLayer(s, 'rect', { x: 500, y: 140, w: 50, h: 50 });
    const gr: any = groupLayers(s, [a.id, b.id, c.id], { x: 80, y: 60, w: 600, h: 400 });
    return { s, a, b, c, g: gr?.id ?? gr };
  };
  it('the precomp replaces the siblings in their parent and takes the parent box', () => {
    const { s, a, b, c, g } = scene();
    const before = [a.id, b.id].map(id => valueAt(s.layer(id)!, 'position', 0));
    const { comp, layer } = precompose(s, [b.id, a.id]);
    expect(s.layer(g)!.children).toEqual([layer.id, c.id]);
    expect(layer.parent).toBe(g);
    expect(s.project.comps[comp.id].root).toEqual([a.id, b.id]);
    expect([comp.width, comp.height]).toEqual([600, 400]);
    expect(s.layer(a.id)!.parent).toBeNull();
    // the layers keep their values (comp space = the parent's local space) ...
    expect([a.id, b.id].map(id => valueAt(s.layer(id)!, 'position', 0))).toEqual(before);
    // ... and the precomp layer maps that space 1:1 onto the parent's box
    const pl = s.layer(layer.id)!;
    expect(valueAt(pl, 'position', 0)).toEqual(valueAt(pl, 'anchor', 0));
    expect(valueAt(pl, 'size', 0)).toEqual([600, 400]);
    expect(valueAt(pl, 'scale', 0)).toEqual([100, 100]);
    s.undo();
    expect(s.layer(g)!.children).toEqual([a.id, b.id, c.id]);
    expect(s.layer(a.id)!.parent).toBe(g);
  });
  it('refuses layers with different parents; a selected child goes along with its parent', () => {
    const { s, a, g } = scene();
    const d = addLayer(s, 'rect', { x: 0, y: 0, w: 10, h: 10 });
    expect(() => precompose(s, [a.id, d.id])).toThrow(/same parent/);
    const { comp } = precompose(s, [g, a.id, d.id]);
    expect(s.project.comps[comp.id].root).toEqual([g, d.id]);
  });
});
