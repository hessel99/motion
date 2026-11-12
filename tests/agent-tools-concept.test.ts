import { describe, it, expect, beforeEach } from 'vitest';
import { TOOLS } from '../src/agent/tools';
import { editor } from '../src/app/editor';
import { createLayer, createProject, type Layer, type PathCmd } from '../src/core/model';
import { addLayer, insertLayer, valueAt } from '../src/core/commands';
import { worldMatrix, apply, mul, layerSize } from '../src/agent/motion-math';
import { pathComponents } from '../src/agent/tools-concept';

const tool = (name: string) => TOOLS.find(t => t.name === name)!;
const run = async (name: string, args: any) => { const c = await tool(name).run(args); return c[0].type === 'text' ? c[0].text : ''; };
const json = async (name: string, args: any) => JSON.parse(await run(name, args));
const s = () => editor.store;

beforeEach(() => { editor.store.load(createProject()); });

// house outline (pentagon) with a door-shaped hole, and the door itself sitting in the hole: ONE path
const HOUSE: PathCmd[] = [['M', 0, 200], ['L', 200, 0], ['L', 400, 200], ['L', 400, 500], ['L', 0, 500], ['Z']];
const HOLE: PathCmd[] = [['M', 150, 280], ['L', 150, 460], ['L', 250, 460], ['L', 250, 280], ['Z']]; // opposite winding
const DOOR: PathCmd[] = [['M', 162, 292], ['L', 238, 292], ['L', 238, 448], ['L', 162, 448], ['Z']];

/** the logo inside a rotated, scaled group (like an imported Figma frame) */
function houseLogo(rule: 'nonzero' | 'evenodd' = 'nonzero') {
  const st = s();
  const frame = createLayer('group', { x: 300, y: 100, w: 800, h: 800, name: 'Frame' });
  frame.props.scale!.v = [120, 120];
  frame.props.rotation!.v = [8];
  const logo = createLayer('path', { x: 100, y: 80, w: 400, h: 500, name: 'Logo', color: [0.1, 0.4, 0.9, 1] });
  logo.geometry = [{ cmds: [...HOUSE, ...HOLE, ...DOOR], fillRule: rule }];
  logo.geomSize = [400, 500];
  st.transact('build', tx => { insertLayer(st, tx, frame, null); insertLayer(st, tx, logo, frame.id); });
  return { frame, logo };
}

const toComp = (l: Layer, cmds: PathCmd[]) => {
  const st = s();
  const [w, h] = layerSize(st, l, 0), g = l.geomSize!;
  const m = mul(worldMatrix(st, l.id, 0), [w / g[0], 0, 0, h / g[1], 0, 0]);
  const pts: number[][] = [];
  for (const c of cmds) for (let i = 1; i + 1 < c.length; i += 2) pts.push(apply(m, c[i] as number, c[i + 1] as number));
  return pts;
};
const close = (a: number[][], b: number[][], eps = 1e-6) => a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i][0]) < eps && Math.abs(p[1] - b[i][1]) < eps);
const cornersOf = (l: Layer, t = 0) => { const st = s(); const [w, h] = layerSize(st, l, t); const m = worldMatrix(st, l.id, t); return [apply(m, 0, 0), apply(m, w, 0), apply(m, w, h), apply(m, 0, h)]; };

describe('geometry', () => {
  it('pathComponents keeps holes with their outer contour and makes the door its own part', () => {
    for (const rule of ['nonzero', 'evenodd'] as const) {
      const r = pathComponents([...HOUSE, ...HOLE, ...DOOR], rule);
      expect(r.parts).toHaveLength(2);
      const house = r.parts.find(p => p.holes === 1)!, door = r.parts.find(p => p.holes === 0)!;
      expect(house.subs).toEqual([0, 1]);
      expect(door.subs).toEqual([2]);
      expect(house.area).toBeCloseTo(400 * 300 + 200 * 200 - 100 * 180, 0);
    }
    // even-odd with all contours wound the same way: the middle contour is still a hole
    const same: PathCmd[] = [['M', 150, 280], ['L', 250, 280], ['L', 250, 460], ['L', 150, 460], ['Z']];
    expect(pathComponents([...HOUSE, ...same, ...DOOR], 'evenodd').parts).toHaveLength(2);
    // nonzero with the same winding: the "hole" is filled (an overlap), so the outer shape is one solid part
    const one = pathComponents([...HOUSE, ...same], 'nonzero').parts;
    expect(one).toHaveLength(1);
    expect(one[0].subs).toEqual([0, 1]);
    expect(one[0].holes).toBe(0);
  });
});

describe('inspect_artwork', () => {
  it('lists components of a compound path with relations and hints (headless: JSON only)', async () => {
    const { logo } = houseLogo();
    const out = await tool('inspect_artwork').run({ id: logo.id });
    expect(out).toHaveLength(1); // no image without a canvas
    const r = JSON.parse((out[0] as any).text);
    const whole = r.parts.find((p: any) => p.n === '1');
    expect(whole.components).toBe(2);
    expect(whole.subpaths).toBe(3);
    expect(whole.hint).toMatch(/split_shape/);
    const house = r.parts.find((p: any) => p.n === '1.1'), door = r.parts.find((p: any) => p.n === '1.2');
    expect(house.hint).toMatch(/house-like/);
    expect(house.holes).toBe(1);
    expect(door.inHoleOf).toBe('1.1');
    expect(door.hint).toMatch(/tall rectangle.*hole of #1\.1/);
    expect(house.colors).toBeUndefined();
    expect(whole.colors[0]).toBe('#1a66e6');
  });

  it('finds letter-like parts in a row and containment', async () => {
    const st = s();
    const g = addLayer(st, 'group', { x: 0, y: 0, w: 1000, h: 400, name: 'Logo' });
    const ids = [0, 1, 2, 3].map(i => addLayer(st, 'rect', { x: 100 + i * 70, y: 100, w: 50, h: 80, name: 'L' + i }, g.id).id);
    const dot = addLayer(st, 'ellipse', { x: 600, y: 100, w: 200, h: 200, name: 'Dot' }, g.id);
    addLayer(st, 'ellipse', { x: 680, y: 180, w: 40, h: 40, name: 'Pupil' }, g.id);
    const r = await json('inspect_artwork', { id: g.id });
    const l1 = r.parts.find((p: any) => p.id === ids[1]);
    expect(l1.row).toMatch(/2\/4 in text row A/);
    const pupil = r.parts.find((p: any) => p.name === 'Pupil');
    expect(pupil.inside).toBe(r.parts.find((p: any) => p.id === dot.id).n);
    expect(pupil.hint).toMatch(/small circle, on top of/);
  });

  it('errors helpfully', async () => {
    await expect(run('inspect_artwork', {})).rejects.toThrow(/nothing to inspect/);
    await expect(run('inspect_artwork', { id: 'nope' })).rejects.toThrow(/no layer/);
  });
});

describe('split_shape', () => {
  it('splits the house logo into parts at exactly the same place (one undo step)', async () => {
    const { frame, logo } = houseLogo();
    const st = s();
    const doorBefore = toComp(logo, DOOR), houseBefore = toComp(logo, [...HOUSE, ...HOLE]);
    const h0 = st.historyLength;
    const r = await json('split_shape', { id: logo.id });
    expect(st.historyLength).toBe(h0 + 1);
    expect(st.layer(logo.id)).toBeUndefined();
    const grp = st.layer(r.group)!;
    expect(grp.name).toBe('Logo');
    expect(grp.parent).toBe(frame.id);
    expect(r.parts).toHaveLength(2);
    const parts = r.parts.map((p: any) => st.layer(p.id)!);
    const house = parts.find((p: Layer) => p.geometry![0].cmds.filter(c => c[0] === 'M').length === 2)!;
    const door = parts.find((p: Layer) => p !== house)!;
    expect(house.name).toMatch(/Part 1 \(largest\)/);
    expect(door.name).toMatch(/Part 2 \(smallest\)/);
    expect(close(toComp(door, door.geometry![0].cmds), doorBefore)).toBe(true);
    expect(close(toComp(house, house.geometry![0].cmds), houseBefore)).toBe(true);
    expect(valueAt(door, 'fill', 0)).toEqual([0.1, 0.4, 0.9, 1]);
    // the door's box is its own: 76 x 156 local px, so its pivot names mean the door's edges
    expect(layerSize(st, door, 0).map(Math.round)).toEqual([76, 156]);
    st.undo();
    expect(st.layer(logo.id)).toBeTruthy();
    expect(st.layer(r.group)).toBeUndefined();
  });

  it('keeps animation (group takes the transform keys), gradients, and splits subpaths on request', async () => {
    const { logo } = houseLogo('evenodd');
    const st = s();
    st.transact('anim', tx => {
      tx.set(logo.props.position!, 'kf', [{ t: 0, v: [300, 330], interp: 'linear', out: [0, 0], in: [1, 1] }, { t: 1, v: [400, 330], interp: 'linear', out: [0, 0], in: [1, 1] }]);
      tx.set(logo, 'paints', [{ type: 'linear', stops: [{ pos: 0, color: [1, 0, 0, 1] }, { pos: 1, color: [0, 0, 1, 1] }], transform: [1, 0, 0, 1, 0, 0] }]);
    });
    const r = await json('split_shape', { id: logo.id, mode: 'subpaths' });
    expect(r.parts).toHaveLength(3);
    const g = st.layer(r.group)!;
    expect(g.props.position!.kf).toHaveLength(2);
    const door = st.layer(r.parts.find((p: any) => p.bounds[2] < 120 && p.name.includes('smallest')).id)!;
    // gradient mapped: a door-space point maps to the same gradient coordinate as before
    const m = door.paints![0].transform!;
    const G = door.geomSize!;
    // gradient unit u=(0,0) lands at geometry (162-ox, 292-oy)*... check via inverse: old origin (0,0) -> new (-162, -292)
    expect(G[0] * m[4]).toBeCloseTo(-162, 6);
    expect(G[1] * m[5]).toBeCloseTo(-292, 6);
  });

  it('refuses no-op splits and odd inputs', async () => {
    const st = s();
    const p = createLayer('path', { x: 0, y: 0, w: 100, h: 100, name: 'Solo' });
    p.geometry = [{ cmds: [['M', 0, 0], ['L', 100, 0], ['L', 100, 100], ['Z']], fillRule: 'nonzero' }];
    p.geomSize = [100, 100];
    st.transact('x', tx => insertLayer(st, tx, p, null));
    await expect(run('split_shape', { id: p.id })).rejects.toThrow(/one connected shape/);
    const r = addLayer(st, 'rect', {});
    await expect(run('split_shape', { id: r.id })).rejects.toThrow(/path, text and group/);
    await expect(run('split_shape', { id: p.id, mode: 'pieces' })).rejects.toThrow(/mode must be/);
  });

  it('splits a text layer into letters and a group into its compound paths', async () => {
    const st = s();
    const t = addLayer(st, 'text', { w: 0, h: 0, text: { content: 'Door', fontFamily: 'Inter', fontSize: 40, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'left' } as any });
    const r = await json('split_shape', { id: t.id });
    expect(r.parts).toBe(4);
    const { frame } = houseLogo();
    const g = await json('split_shape', { id: frame.id });
    expect(g.parts).toHaveLength(2);
  });
});

describe('set_pivot', () => {
  it('moves the anchor to the door\'s left edge without moving it (parented, keyframed)', async () => {
    const { logo } = houseLogo();
    const st = s();
    const r = await json('split_shape', { id: logo.id });
    const door = st.layer(r.parts[1].id)!;
    st.transact('anim', tx => tx.set(door.props.position!, 'kf', [{ t: 0, v: valueAt(door, 'position', 0), interp: 'linear', out: [0, 0], in: [1, 1] }, { t: 1, v: [valueAt(door, 'position', 0)[0] + 50, 300], interp: 'linear', out: [0, 0], in: [1, 1] }]));
    const before = [0, 0.5, 1].map(t => cornersOf(door, t));
    const h0 = st.historyLength;
    const p = await json('set_pivot', { id: door.id, at: 'left' });
    expect(st.historyLength).toBe(h0 + 1);
    expect(p.anchor).toEqual([0, 78]);
    const after = [0, 0.5, 1].map(t => cornersOf(door, t));
    after.forEach((c, i) => expect(close(c, before[i], 1e-6)).toBe(true));
    // comp point and another layer's edge
    const house = st.layer(r.parts[0].id)!;
    const q = await json('set_pivot', { id: door.id, at: { layerEdgeOf: house.id, edge: 'bottom' } });
    expect(close([0, 0.5, 1].map(t => cornersOf(door, t)).flat(), before.flat(), 1e-6)).toBe(true);
    expect(q.pivotInComp[1]).toBeGreaterThan(0);
    await json('set_pivot', { id: door.id, at: [500, 500] });
    expect(close(cornersOf(door, 0), before[0], 1e-6)).toBe(true);
    await expect(run('set_pivot', { id: door.id, at: 'middle-ish' })).rejects.toThrow(/unknown pivot/);
  });

  it('with animated rotation keeps position keys exact and says so', async () => {
    const st = s();
    const l = addLayer(st, 'rect', { x: 100, y: 100, w: 200, h: 100 });
    st.transact('r', tx => tx.set(l.props.rotation!, 'kf', [{ t: 0, v: [0], interp: 'linear', out: [0, 0], in: [1, 1] }, { t: 1, v: [90], interp: 'linear', out: [0, 0], in: [1, 1] }]));
    const b = cornersOf(l, 0);
    const p = await json('set_pivot', { id: l.id, at: 'top-left', t: 0 });
    expect(p.note).toMatch(/turn around the new pivot/);
    expect(close(cornersOf(l, 0), b, 1e-6)).toBe(true);
  });
});

describe('rig', () => {
  it('hinge: door opens around its left edge with foreshortening, taper, shade and a light', async () => {
    const { logo } = houseLogo();
    const st = s();
    const r = await json('split_shape', { id: logo.id });
    const door = st.layer(r.parts[1].id)!;
    const before = cornersOf(door, 0);
    const h0 = st.historyLength;
    const out = await json('rig', { ids: [door.id], kind: 'hinge', t0: 0.5, duration: 1, options: { edge: 'left', light: true } });
    expect(st.historyLength).toBe(h0 + 1);
    expect(out.kind).toBe('hinge');
    expect(out.end).toBeCloseTo(1.5, 5);
    const d = out.layers.find((x: any) => x.id === door.id);
    expect(d.keys.scale).toBe(3);
    expect(d.keys.pathShape).toBe(3);
    expect(d.keys.fill).toBe(3);
    expect(out.created[0].role).toMatch(/light/);
    expect(valueAt(door, 'anchor', 0)).toEqual([0, 78]);
    // closed at t0: nothing moved
    expect(close(cornersOf(door, 0.5), before, 1e-6)).toBe(true);
    const sEnd = valueAt(door, 'scale', 1.5);
    expect(sEnd[0]).toBeGreaterThan(5);
    expect(sEnd[0]).toBeLessThan(60);
    expect(sEnd[1]).toBeCloseTo(100, 6);
    // the hinge edge stays put while the door opens
    const hingeTop = (t: number) => apply(worldMatrix(st, door.id, t), 0, 0);
    expect(close([hingeTop(1.2)], [hingeTop(0.5)], 1e-6)).toBe(true);
    // the free edge (away from the viewer) is shorter in the last path key
    const last = door.pathKf![door.pathKf!.length - 1].geometry[0].cmds;
    const ys = (x: number) => last.filter(c => c[0] !== 'Z' && Math.abs((c[1] as number) - x) < 1e-6).map(c => c[2] as number);
    const left = ys(0), right = ys(76);
    expect(Math.max(...right) - Math.min(...right)).toBeLessThan(Math.max(...left) - Math.min(...left));
    const light = st.layer(out.created[0].id)!;
    // the light fills the doorway (the hole in the house), not just the door's outline
    expect(layerSize(st, light, 0).map(Math.round)).toEqual([100, 180]);
    expect(valueAt(light, 'opacity', 0.5)[0]).toBeCloseTo(0, 5);
    expect(valueAt(light, 'opacity', 1.5)[0]).toBeCloseTo(100, 5);
    expect(st.layer(door.parent!)!.children.indexOf(light.id)).toBeLessThan(st.layer(door.parent!)!.children.indexOf(door.id));
    // open-close and validation
    const oc = await json('rig', { ids: [door.id], kind: 'hinge', t0: 2, mode: 'open-close', duration: 0.8 });
    expect(oc.layers[0].keys.scale).toBeGreaterThan(5);
    await expect(run('rig', { ids: [door.id], kind: 'hinge', options: { edge: 'diagonal' } })).rejects.toThrow(/hinge edge/);
    await expect(run('rig', { ids: [door.id], kind: 'flap' })).rejects.toThrow(/unknown rig kind/);
    await expect(run('rig', { ids: [door.id], kind: 'swing', mode: 'out' })).rejects.toThrow(/no "out" mode/);
  });

  it('every kind runs as one undo step and creates keys', async () => {
    const st = s();
    const mk = (n: string, x: number) => addLayer(st, 'rect', { x, y: 400, w: 100, h: 160, name: n });
    const text = addLayer(st, 'text', { x: 200, y: 800, w: 0, h: 0, name: 'Word', text: { content: 'Hello', fontFamily: 'Inter', fontSize: 48, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'left' } as any });
    const cases: [string, any][] = [
      ['grow', { from: 'bottom' }], ['swing', {}], ['swing', { loop: true }], ['unfold', {}], ['orbit', { options: { center: [960, 540], orient: true, loop: true } }],
      ['blink', { loop: true }], ['pulse', {}], ['beat', {}], ['liquid-fill', {}], ['draw-then-fill', {}], ['launch', { direction: 'up' }],
      ['land', { options: { from: 'left' } }], ['assemble', {}], ['grow', { mode: 'out' }],
    ];
    for (const [kind, extra] of cases) {
      st.load(createProject());
      const a = mk('A', 300), b = mk('B', 500), c = mk('C', 700);
      const h0 = st.historyLength;
      const out = await json('rig', { ids: [a.id, b.id, c.id], kind, t0: 0.2, ...extra });
      expect(st.historyLength, kind).toBe(h0 + 1);
      const keyCount = out.layers.reduce((n: number, l: any) => n + Object.values(l.keys).reduce((x: number, y: any) => x + y, 0), 0);
      expect(keyCount, kind).toBeGreaterThan(2);
      expect(out.end, kind).toBeGreaterThan(0.2);
      st.undo();
      expect(st.layer(a.id)!.props.scale!.kf, kind).toBeUndefined();
      expect(st.comp.root, kind).toHaveLength(3);
    }
    // grow keeps a pivot set on another layer's edge
    st.load(createProject());
    const body = addLayer(st, 'rect', { x: 100, y: 100, w: 300, h: 160, name: 'Body' });
    const tail = addLayer(st, 'rect', { x: 140, y: 260, w: 40, h: 50, name: 'Tail' });
    await json('set_pivot', { id: tail.id, at: { layerEdgeOf: body.id } });
    const anchor = valueAt(st.layer(tail.id)!, 'anchor', 0);
    await json('rig', { ids: [tail.id], kind: 'grow', t0: 0, options: { from: 'top', pivot: 'keep' } });
    expect(valueAt(st.layer(tail.id)!, 'anchor', 0)).toEqual(anchor);
    expect(anchor[1]).toBeCloseTo(0, 6);
    // type-on with cursor
    st.load(createProject());
    const t2 = addLayer(st, 'text', { x: 200, y: 800, w: 0, h: 0, name: 'Word', text: { ...text.text! } });
    const ty = await json('rig', { ids: [t2.id], kind: 'type-on', t0: 0.5, options: { cursor: true } });
    expect(st.layer(t2.id)!.textAnim!.start).toBe(0.5);
    expect(ty.created[0].role).toMatch(/cursor/);
    // reveal-from: wordmark slides out from behind the mark under a mask
    st.load(createProject());
    const mark = addLayer(st, 'ellipse', { x: 100, y: 100, w: 200, h: 200, name: 'Mark' });
    const word = addLayer(st, 'rect', { x: 340, y: 160, w: 400, h: 80, name: 'Wordmark' });
    const rv = await json('rig', { ids: [word.id], kind: 'reveal-from', t0: 0, duration: 1, options: { from: mark.id } });
    const W = st.layer(word.id)!;
    expect(st.layer(W.parent!)!.name).toBe('Reveal');
    expect(valueAt(W, 'position', 0)[0]).toBeCloseTo(540 - (740 - 300) - 2, 4);
    expect(valueAt(W, 'position', 1)[0]).toBeCloseTo(540, 4);
    expect(rv.created.find((x: any) => /mask/.test(x.role))).toBeTruthy();
    expect(rv.layers.find((x: any) => x.id === mark.id).keys.position).toBe(3);
    await expect(run('rig', { ids: [word.id], kind: 'reveal-from' })).rejects.toThrow(/needs from/);
    await expect(run('rig', { ids: [mark.id], kind: 'orbit' })).rejects.toThrow(/orbit needs center/);
  });
});
