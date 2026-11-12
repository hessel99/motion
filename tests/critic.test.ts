import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TOOLS } from '../src/agent/tools';
import { editor } from '../src/app/editor';
import { createProject } from '../src/core/model';
import { critique, formatCritique, RULES } from '../src/agent/critic';
import { polishPlan, setTaste } from '../src/agent/taste';
import { EXAMPLES, exampleCalls, replayExample, resolveKeys } from '../src/agent/examples';
import { findExamples } from '../src/agent/guides';
import { describeLayerAnimation } from '../src/agent/describe';

const run = async (name: string, args: any) => {
  const t = TOOLS.find(x => x.name === name);
  if (!t) throw new Error('no tool ' + name);
  try { const c = await t.run(args); return c[0]?.type === 'text' ? c[0].text : ''; } catch (e: any) { if (/no audio layer/.test(e.message)) return ''; throw e; }
};
const json = async (name: string, args: any) => JSON.parse(await run(name, args));
const rules = () => critique(editor.store, { max: 40 }).issues.map(i => i.rule);

beforeEach(() => { (globalThis as any).__motionTaste = true; editor.store.load(createProject()); });
afterEach(() => { delete (globalThis as any).__motionTaste; });

/** a deliberately amateur piece: linear stops, everything at once, colliding text, a bar growing from
 *  its middle, a draw-on on a rect, a clipped label and 4 s of nothing at the end */
async function amateur() {
  const lin = 'Linear';
  return json('build_scene', {
    comp: { duration: 8, background: '#111111' },
    layers: [
      { key: 'a', type: 'rect', x: 200, y: 400, w: 160, h: 160, fill: '#ff0000', animate: { position: [{ t: 0, v: [-200, 480], ease: lin }, { t: 1, v: [280, 480] }] } },
      { key: 'b', type: 'rect', x: 500, y: 400, w: 160, h: 160, fill: '#00ff00', animate: { position: [{ t: 0, v: [580, 1300], ease: lin }, { t: 1, v: [580, 480] }] } },
      { key: 'c', type: 'ellipse', x: 800, y: 400, w: 160, h: 160, fill: '#0000ff', animate: { position: [{ t: 0, v: [880, -300], ease: lin }, { t: 1, v: [880, 480] }] } },
      { key: 'd', type: 'rect', x: 1100, y: 400, w: 160, h: 160, fill: '#ffff00', animate: { position: [{ t: 0, v: [2200, 480], ease: lin }, { t: 1, v: [1180, 480] }] } },
      { key: 'bar', type: 'rect', x: 1400, y: 300, w: 80, h: 400, fill: '#ff00ff', animate: { scale: [{ t: 0, v: [100, 0], ease: 'Easy Ease' }, { t: 1, v: [100, 100] }] } },
      { key: 'ring', type: 'rect', x: 1600, y: 300, w: 100, h: 100, fill: '#ffffff', animate: { trimEnd: [{ t: 0, v: 0 }, { t: 1, v: 100 }] } },
      { key: 't1', text: 'Hello there world', fontSize: 90, x: 300, y: 700, fill: '#ffffff', animate: { opacity: [{ t: 0, v: 0, ease: lin }, { t: 0.3, v: 100 }, { t: 0.8, v: 100, ease: lin }, { t: 1, v: 0 }] } },
      { key: 't2', text: 'Second phrase here', fontSize: 90, x: 320, y: 720, fill: '#ffffff', animate: { opacity: [{ t: 0.6, v: 0, ease: lin }, { t: 0.9, v: 100 }] } },
      { key: 'edge', text: 'CLIPPED LABEL', fontSize: 60, x: 1700, y: 950, fill: '#ffffff' },
    ],
  });
}

describe('motion critic', () => {
  it('finds the classic amateur mistakes and names the fixing tool calls', async () => {
    await amateur();
    const c = critique(editor.store, { max: 40 });
    const found = new Set(c.issues.map(i => i.rule));
    for (const r of ['hard-stop', 'all-at-once', 'grow-middle', 'dead-trim', 'text-collision', 'read-hold', 'off-canvas', 'end-hold']) expect(found, r).toContain(r);
    expect(c.score).toBeLessThan(40);
    // every issue is categorised, ranked high → low, and fixable ones carry real tool names with args
    const sev = { high: 3, medium: 2, low: 1 };
    for (let i = 1; i < c.issues.length; i++) expect(sev[c.issues[i - 1].severity]).toBeGreaterThanOrEqual(sev[c.issues[i].severity]);
    for (const i of c.issues) {
      expect(RULES[i.rule]).toBeTruthy();
      for (const f of i.fix) expect(TOOLS.some(t => t.name === f.tool), f.tool).toBe(true);
    }
    const txt = formatCritique(c);
    expect(txt).toMatch(/^score \d+\/100/);
    expect(txt).toMatch(/→ (set_easing|choreograph|set_pivot|draw_on|retime|set_keyframes|update_layer|animate)/);
  });

  it('its fixes work: applying the suggested tool calls raises the score', async () => {
    await amateur();
    const before = critique(editor.store, { max: 40 });
    for (let round = 0; round < 3; round++) {
      const c = critique(editor.store, { max: 40 });
      for (const i of c.issues) for (const f of i.fix) { try { await run(f.tool, f.args); } catch { /* a fix can be superseded by an earlier one */ } }
    }
    const after = critique(editor.store, { max: 40 });
    expect(after.score).toBeGreaterThan(before.score + 25);
    const left = new Set(after.issues.map(i => i.rule));
    for (const r of ['grow-middle', 'dead-trim', 'all-at-once']) expect(left.has(r), r).toBe(false);
  });

  it('is fast on a typical document (< 50 ms) and handles empty docs', async () => {
    expect(critique(editor.store).score).toBe(0);
    const layers = Array.from({ length: 40 }, (_, i) => ({ key: 'k' + i, type: i % 3 ? 'rect' : 'ellipse', x: 100 + (i % 10) * 170, y: 150 + Math.floor(i / 10) * 200, w: 120, h: 120, fill: '#3355ff', enter: { t: 0.2 + i * 0.03, from: { opacity: 0, dy: 60 } }, ...(i % 7 === 0 ? { expr: { rotation: 'wiggle(2, 10)' } } : {}) }));
    await json('build_scene', { comp: { duration: 6 }, layers: [...layers, { key: 'title', text: 'A title for the piece', fontSize: 96, x: 200, y: 900, fill: '#ffffff', enter: { from: { opacity: 0, dy: 40 } } }] });
    critique(editor.store);
    // best of 5: the machine running the tests may be busy (the budget is the critic's own cost)
    let best = Infinity;
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); critique(editor.store); best = Math.min(best, performance.now() - t0); }
    expect(best).toBeLessThan(50);
  });

  it('range limits the issues to a beat, and the critique tool is read-only text', async () => {
    await amateur();
    const all = critique(editor.store, { max: 40 }).issues.length;
    const beat = critique(editor.store, { range: [6, 8], max: 40 }).issues;
    expect(beat.length).toBeLessThan(all);
    expect(beat.every(i => !i.t || i.t[1] >= 5.95)).toBe(true);
    const tool = TOOLS.find(t => t.name === 'critique')!;
    expect(tool.readOnly).toBe(true);
    expect(await run('critique', { from: 0, to: 2 })).toMatch(/score \d+\/100/);
  });

  it('does not flag deliberate craft: gravity drops, idle wobble, kinetic word flashes', async () => {
    await json('build_scene', {
      comp: { duration: 3, background: '#ffffff' },
      layers: [
        { key: 'ball', type: 'ellipse', x: 900, y: 600, w: 120, h: 120, fill: '#ff6600', anchor: 'bottom',
          animate: { position: [{ t: 0, v: [960, -100], ease: 'Quad In' }, { t: 0.5, v: [960, 720], ease: 'Cubic Out' }, { t: 0.75, v: [960, 650], ease: 'Cubic In' }, { t: 0.95, v: [960, 720] }],
            scale: [{ t: 0, v: [90, 110], ease: 'Quad In' }, { t: 0.5, v: [125, 80], ease: 'spring Bouncy' }, { t: 1.2, v: [100, 100] }] } },
        { key: 'w', text: 'GO', fontSize: 200, x: 1100, y: 500, fill: '#111111', enter: { t: 0.6, from: { opacity: 0, scale: 140 } }, expr: { rotation: 'value + 3*Math.sin(time*2*Math.PI/1.5)' } },
      ],
    });
    const r = rules();
    expect(r).not.toContain('hard-stop');
    expect(r).not.toContain('entrance-ease');
    expect(r).not.toContain('loop-seam');
  });
});

describe('gold examples', () => {
  it(`ship ${EXAMPLES.length} examples (10-22) that replay cleanly and score high`, async () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(10);
    expect(EXAMPLES.length).toBeLessThanOrEqual(22);
    for (const g of EXAMPLES) {
      expect(g.summary, g.name).toMatch(/^tags: /);
      expect(g.text, g.name).toMatch(/## Brief[\s\S]*## Tool calls[\s\S]*## Why it works/);
      for (const c of exampleCalls(g)) expect(TOOLS.some(t => t.name === c.tool), `${g.name}: ${c.tool}`).toBe(true);
      editor.store.load(createProject());
      await replayExample(g, run);
      const c = critique(editor.store);
      expect(c.score, `${g.name}\n${formatCritique(c)}`).toBeGreaterThanOrEqual(85);
      expect(c.issues.filter(i => i.severity === 'high'), g.name).toEqual([]);
    }
  });

  it('get_guide examples returns the closest examples for a brief', async () => {
    const top = (b: string) => findExamples(b, 1)[0].name;
    expect(top('make my logo move')).toMatch(/logo/);
    expect(top('bar chart of revenue per quarter')).toBe('examples/bar-chart');
    expect(top('a seamless looping background')).toBe('examples/seamless-loop');
    expect(top('instagram story ad for a product launch')).toBe('examples/social-promo-vertical');
    expect(top('toggle switch micro interaction')).toBe('examples/ui-toggle');
    expect(top('kinetic typography to the beat of our song')).toBe('examples/music-kinetic-type');
    const txt = await run('get_guide', { name: 'examples', brief: 'animate a bar chart' });
    expect(txt).toMatch(/## Tool calls/);
    expect(await run('get_guide', { name: 'examples' })).toMatch(/examples\/bar-chart/);
    expect(resolveKeys({ ids: ['<a>'], x: '<b>' }, { a: 'l_1', b: 'l_2' })).toEqual({ ids: ['l_1'], x: 'l_2' });
  });
});

describe('taste layer', () => {
  it('plans a polishing follow-up for weak work and stays quiet for good work', async () => {
    await amateur();
    const p = polishPlan(editor.store, 1)!;
    expect(p).toBeTruthy();
    expect(p.count).toBeGreaterThan(0);
    expect(p.count).toBeLessThanOrEqual(3);
    expect(p.message).toMatch(/polishing round 1 of 2/);
    expect(p.message).toMatch(/→ \w+ \{/);
    expect(polishPlan(editor.store, 3)).toBeNull();
    editor.store.load(createProject());
    await replayExample(EXAMPLES.find(e => e.name.endsWith('bar-chart'))!, run);
    expect(polishPlan(editor.store, 1)).toBeNull();
  });

  it('quality-first defaults: unspecified eases follow the move, durations follow size, entrances overlap', async () => {
    const r = await json('build_scene', { layers: [
      { key: 'hero', type: 'rect', x: 600, y: 300, w: 700, h: 400, fill: '#2255ff', enter: { from: { opacity: 0, dy: 600 } } },
      { key: 's1', type: 'ellipse', x: 100, y: 100, w: 60, h: 60, fill: '#ff5500', enter: { from: { scale: 0 } } },
      { key: 's2', type: 'ellipse', x: 200, y: 100, w: 60, h: 60, fill: '#ff5500', enter: { from: { scale: 0 } } },
    ] });
    const s = editor.store;
    const hero = s.layer(r.ids.hero)!, s1 = s.layer(r.ids.s1)!, s2 = s.layer(r.ids.s2)!;
    // the hero leads, the small ones follow, staggered
    expect(hero.props.position!.kf![0].t).toBe(0);
    expect(s1.props.scale!.kf![0].t).toBeGreaterThan(0);
    expect(s2.props.scale!.kf![0].t).toBeGreaterThan(s1.props.scale!.kf![0].t);
    // a big 600 px move takes longer than a small pop
    const dHero = hero.props.position!.kf![1].t - hero.props.position!.kf![0].t, dS = s1.props.scale!.kf![1].t - s1.props.scale!.kf![0].t;
    expect(dHero).toBeGreaterThan(dS);
    expect(r.notes.join(' ')).toMatch(/taste layer/);
    // animate without eases: entrance decelerates, exit accelerates (not Easy Ease)
    await run('animate', { tracks: [{ id: r.ids.s1, prop: 'opacity', keyframes: [{ t: 2, v: 100 }, { t: 2.3, v: 0 }] }, { id: r.ids.s2, prop: 'scale', keyframes: [{ t: 1, v: 0 }, { t: 1.4, v: 100 }] }] });
    expect(describeLayerAnimation(s.layer(r.ids.s1)!)).toMatch(/Ease In→/);
    expect(describeLayerAnimation(s.layer(r.ids.s2)!)).not.toMatch(/Easy Ease/);
    // off: the old defaults
    setTaste(false);
    (globalThis as any).__motionTaste = false;
    editor.store.load(createProject());
    const r2 = await json('build_scene', { layers: [{ key: 'x', type: 'rect', x: 0, y: 0, w: 100, h: 100, enter: { from: { opacity: 0 } } }, { key: 'y', type: 'rect', x: 0, y: 0, w: 100, h: 100, enter: { from: { opacity: 0 } } }, { key: 'z', type: 'rect', x: 0, y: 0, w: 100, h: 100, enter: { from: { opacity: 0 } } }] });
    expect(editor.store.layer(r2.ids.z)!.props.opacity!.kf![0].t).toBe(0);
    setTaste(true);
  });
});
