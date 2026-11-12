// export parity: the pure parts (colour conversion, timing, lottie preflight / mapping). the pixel
// comparisons against real decoders run in scripts/export-parity.mjs (`npm run parity`).
import { describe, it, expect } from 'vitest';
import { rgbaToI420, i420Size } from '../src/export/yuv';
import { gifDelayCs, gifFrameCount } from '../src/export/gif-timing';
import { unpremultiply, flatten, frameTime, coverView } from '../src/export/frames';
import { lottiePreflight, projectToLottie } from '../src/export/lottie';
import { frameCount, frameTimestampUs } from '../src/export/video';
import { SCENES } from './parity/scenes';
import { createLayer, createProject } from '../src/core/model';

const scene = (id: string) => SCENES.find(s => s.id === id)!.build();

describe('video colour: BT.709 limited range', () => {
  const conv = (r: number, g: number, b: number) => {
    const px = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < 4; i++) px.set([r, g, b, 255], i * 4);
    const o = rgbaToI420(px, 2, 2);
    return [o[0], o[4], o[5]];
  };
  it('white, black, grey and primaries land on the BT.709 code values', () => {
    expect(conv(255, 255, 255)).toEqual([235, 128, 128]);
    expect(conv(0, 0, 0)).toEqual([16, 128, 128]);
    expect(conv(128, 128, 128)).toEqual([126, 128, 128]);
    // BT.709 red: Y = 16 + 219 * 0.2126, Cr = 128 + 112
    expect(conv(255, 0, 0)).toEqual([63, 102, 240]);
    expect(conv(0, 0, 255)).toEqual([32, 240, 118]);
  });
  it('averages chroma over 2x2 blocks', () => {
    const px = new Uint8Array(4 * 2 * 4);
    for (let i = 0; i < 8; i++) px.set(i % 4 < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
    const o = rgbaToI420(px, 4, 2);
    expect(o.length).toBe(i420Size(4, 2));
    expect(o[8]).toBe(102); expect(o[9]).toBe(240); // cb of the red block, then the blue block
    expect(o[10]).toBe(240); expect(o[11]).toBe(118); // cr
  });
});

describe('timing', () => {
  it('video frame count and timestamps never drift', () => {
    expect(frameCount(2, 30)).toBe(60);
    expect(frameCount(1.51, 30)).toBe(46);
    expect(frameTimestampUs(59, 30)).toBe(1966667);
    expect(frameTime(60, 30, 0, 2)).toBe(2);
  });
  it('gif delays are whole centiseconds that add up to the exact duration', () => {
    for (const fps of [12, 24, 25, 30, 50]) {
      const n = gifFrameCount(3, fps);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = gifDelayCs(i, fps);
        expect(d).toBeGreaterThanOrEqual(2); // browsers stretch < 2 cs to 10 cs
        // every frame starts within half a centisecond of i / fps
        expect(Math.abs(sum - (i * 100) / fps)).toBeLessThanOrEqual(0.5 + 1e-9);
        sum += d;
      }
      expect(sum).toBe(300);
    }
  });
});

describe('pixels', () => {
  it('unpremultiply / flatten', () => {
    expect([...unpremultiply(new Uint8Array([64, 32, 0, 128, 9, 9, 9, 0]))]).toEqual([128, 64, 0, 128, 0, 0, 0, 0]);
    expect([...flatten(new Uint8Array([64, 32, 0, 128]), new Uint8Array(4), [255, 255, 255])]).toEqual([191, 159, 127, 255]);
  });
  it('cover view: even-rounded video sizes cover the comp, centered', () => {
    const v = coverView(211, 117, 212, 118);
    expect(v.zoom).toBeCloseTo(118 / 117, 9);
    expect(v.panY).toBeCloseTo(0, 9);
    expect(211 * v.zoom + 2 * v.panX).toBeCloseTo(212, 9);
  });
});

describe('lottie preflight', () => {
  it('lists what lottie cannot draw, before exporting', () => {
    const feats = (id: string) => lottiePreflight(scene(id)).map(i => `${i.layer}:${i.feature}`).sort();
    expect(feats('shapes')).toEqual([]);
    // a radial gradient in a non-square box is an ellipse: lottie radials are circles
    expect(feats('paints')).toEqual(['angular:paint', 'diamond:paint', 'image fill:paint', 'noise:paint', 'radial:paint']);
    expect(feats('effects')).toEqual(['background blur:background-blur', 'drop shadow:effects', 'inner shadow:effects', 'layer blur:effects', 'noise effect:effects']);
    expect(feats('shaders')).toEqual(['shader effect:shader', 'shader fill:shader']);
    expect(feats('blend').filter(f => !f.endsWith(':blend') || f.startsWith('add') || f.startsWith('linearBurn'))).toEqual(['add:blend', 'linearBurn:blend']);
    expect(feats('audio')).toEqual(['clicks:audio']);
    const bb = lottiePreflight(scene('effects')).find(i => i.feature === 'background-blur')!;
    expect(bb.bakeable).toBe(false);
  });
  it('simple Inter text is native, styled text is flagged', () => {
    const t = lottiePreflight(scene('text'));
    expect(t.find(i => i.layer === 'Text' && i.message.includes('underline'))).toBeTruthy();
    expect(t.some(i => i.message.includes('"serif" is not embedded'))).toBe(true);
  });
});

describe('lottie mapping', () => {
  it('comp background becomes a solid layer at the bottom', () => {
    const lot = projectToLottie(scene('shapes'));
    const bottom = lot.layers[lot.layers.length - 1];
    expect(bottom.ty).toBe(1);
    expect(bottom.sc).toBe('#121214');
    const tr = projectToLottie(scene('transparent'));
    expect(tr.layers.some((l: any) => l.ty === 1)).toBe(false);
  });
  it('a group with opacity becomes a precomp (lottie parenting does not pass opacity on)', () => {
    const lot = projectToLottie(scene('group-opacity'));
    const g = lot.layers.find((l: any) => l.nm === 'faded group');
    expect(g.ty).toBe(0);
    const asset = lot.assets.find((a: any) => a.id === g.refId);
    expect(asset.layers.length).toBeGreaterThan(2);
    expect(g.ks.o.a).toBe(1);
    // a group without opacity / clip / blend stays a parent
    expect(lot.layers.find((l: any) => l.nm === 'filled group').ty).toBe(4);
  });
  it('masks become track mattes over a precomp of the masked siblings', () => {
    const lot = projectToLottie(scene('masks'));
    const all = [lot.layers, ...lot.assets.map((a: any) => a.layers ?? [])].flat();
    const mattes = all.filter((l: any) => l.td === 1);
    expect(mattes.length).toBe(3);
    const matted = all.filter((l: any) => l.tt);
    expect(matted.map((l: any) => l.tt).sort()).toEqual([1, 1, 3]);
    for (const list of [lot.layers, ...lot.assets.map((a: any) => a.layers ?? [])]) list.forEach((l: any, i: number) => { if (l.td) expect(list[i + 1].tt).toBeTruthy(); });
  });
  it('linear gradients keep their isolines on non-square boxes', () => {
    const p = createProject('g');
    const l = createLayer('rect', { x: 0, y: 0, w: 200, h: 50 });
    const r = 0.7, c = Math.cos(r), s = Math.sin(r);
    l.paints = [{ type: 'linear', stops: [{ pos: 0, color: [0, 0, 0, 1] }, { pos: 1, color: [1, 1, 1, 1] }], transform: [c, s, -s, c, 0.2, 0.1] }];
    p.layers[l.id] = l; p.comps[p.activeComp].root.push(l.id);
    const gf = projectToLottie(p).layers[0].shapes[0].it.find((x: any) => x.ty === 'gf');
    const [sx, sy] = gf.s.k, [ex, ey] = gf.e.k;
    // our gradient coordinate at a pixel vs lottie's projection onto s -> e
    const det = c * c + s * s;
    const ours = (x: number, y: number) => { const u = x / 200 - 0.2, v = y / 50 - 0.1; return (c * u + s * v) / det; };
    const theirs = (x: number, y: number) => ((x - sx) * (ex - sx) + (y - sy) * (ey - sy)) / ((ex - sx) ** 2 + (ey - sy) ** 2);
    for (const [x, y] of [[0, 0], [200, 50], [37, 12], [150, 3]]) expect(theirs(x, y)).toBeCloseTo(ours(x, y), 6);
  });
  it('stroke caps / joins / dashes follow the renderer defaults', () => {
    const lot = projectToLottie(scene('shapes'));
    const st = (nm: string) => lot.layers.find((l: any) => l.nm === nm).shapes[0].it.find((x: any) => x.ty === 'st');
    expect([st('Rect').lc, st('Rect').lj]).toEqual([1, 1]); // butt / miter
    const open = lot.layers.filter((l: any) => l.nm === 'Path').map((l: any) => l.shapes[0].it.find((x: any) => x.ty === 'st'));
    expect(open.some((x: any) => x.d?.length === 3)).toBe(true);
  });
});
