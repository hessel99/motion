// the logo study's knowledge in the app: the critic's logo mode (rubric of a study of 249 professional logo
// animations), the logo gold examples, the frame-detail / color-cuts rigs and the logo-recipes guide
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TOOLS } from '../src/agent/tools';
import { editor } from '../src/app/editor';
import { createProject } from '../src/core/model';
import { valueAt } from '../src/core/commands';
import { critique, formatCritique } from '../src/agent/critic';
import { EXAMPLES, exampleCalls, replayExample } from '../src/agent/examples';
import { findExamples, findGuide, guideSection, guideSections } from '../src/agent/guides';
import { POP_LOGO, FADE_LOGO, ZOOM_LOGO } from './logo-fixtures';

const run = async (name: string, args: any) => {
  const t = TOOLS.find(x => x.name === name);
  if (!t) throw new Error('no tool ' + name);
  const c = await t.run(args);
  return c[0]?.type === 'text' ? c[0].text : '';
};
const json = async (name: string, args: any) => JSON.parse(await run(name, args));
const build = (spec: any) => json('build_scene', spec);
const rules = () => critique(editor.store, { max: 40 }).issues.map(i => i.rule);

beforeEach(() => { (globalThis as any).__motionTaste = true; editor.store.load(createProject()); });
afterEach(() => { delete (globalThis as any).__motionTaste; });

const LOGO_EXAMPLES = () => EXAMPLES.filter(g => g.name.startsWith('examples/logo-'));

describe('critic logo mode', () => {
  it('scores the logo gold examples high and generic pop / fade logos clearly lower', async () => {
    const gold: number[] = [];
    for (const g of LOGO_EXAMPLES()) {
      editor.store.load(createProject());
      await replayExample(g, run);
      const c = critique(editor.store);
      expect(c.stats.logo, `${g.name} is detected as a logo sting`).toBe(true);
      expect(c.score, `${g.name}\n${formatCritique(c)}`).toBeGreaterThanOrEqual(90);
      expect(c.issues.filter(i => i.rule.startsWith('logo-') && i.severity !== 'low'), g.name).toEqual([]);
      gold.push(c.score);
    }
    expect(gold.length).toBeGreaterThanOrEqual(10);
    for (const [name, spec] of Object.entries({ POP_LOGO, FADE_LOGO, ZOOM_LOGO })) {
      editor.store.load(createProject());
      await build(spec);
      const c = critique(editor.store, { max: 40 });
      expect(c.stats.logo, name).toBe(true);
      expect(c.issues.map(i => i.rule), name).toContain('logo-generic');
      expect(c.score, `${name}\n${formatCritique(c)}`).toBeLessThan(Math.min(...gold) - 25);
    }
  });

  it('a generic pop logo at the right length still loses on the idea and the wordmark entry', async () => {
    await build({ ...POP_LOGO, comp: { duration: 3.6, background: '#0F172A' } });
    const c = critique(editor.store, { max: 40 });
    const r = c.issues.map(i => i.rule);
    expect(r).toContain('logo-generic');
    expect(r).toContain('logo-wordmark-entry');
    expect(r).not.toContain('end-hold');
    expect(c.score).toBeLessThan(80);
    // the fix it names loads the recipes
    expect(c.issues.find(i => i.rule === 'logo-generic')!.fix[0]).toEqual({ tool: 'get_guide', args: { name: 'logo-recipes' } });
  });

  it('measures lead-in, lock time, hold and wordmark timing', async () => {
    // starts on frame 0, the wordmark arrives with the mark, the build drags to 4.6 s, no hold
    await build({
      comp: { duration: 5, background: '#111111' },
      layers: [
        { key: 'a', type: 'ellipse', x: 700, y: 440, w: 200, h: 200, fill: '#F97316', animate: { position: [{ t: 0, v: [400, 540], ease: 'Ease In Out' }, { t: 4.6, v: [800, 540] }] } },
        { key: 'w', text: 'Brandly', fontSize: 130, fontWeight: 800, x: 940, y: 460, fill: '#FFFFFF', enter: { t: 0, duration: 0.6, from: { opacity: 0, dx: -60 }, ease: 'Expo Out' } },
      ],
    });
    const r = rules();
    for (const x of ['logo-lead-in', 'logo-lock', 'logo-hold', 'logo-wordmark-timing']) expect(r, x).toContain(x);
  });

  it('a held lockup before a mirrored exit counts as the hold', async () => {
    const g = EXAMPLES.find(e => e.name === 'examples/logo-mirror-loop')!;
    await replayExample(g, run);
    const r = rules();
    expect(r).not.toContain('logo-hold');
    expect(r).not.toContain('end-hold');
  });

  it('stays off for pieces that are not logo stings, and can be forced', async () => {
    for (const name of ['lower-third', 'ui-toggle', 'explainer-beat', 'kinetic-quote', 'bar-chart', 'list-stagger-brand']) {
      editor.store.load(createProject());
      await replayExample(EXAMPLES.find(e => e.name === 'examples/' + name)!, run);
      expect(critique(editor.store).stats.logo, name).toBe(false);
    }
    await build(POP_LOGO);
    expect(critique(editor.store, { logo: false }).issues.some(i => i.rule.startsWith('logo-'))).toBe(false);
  });

  it('pace changes the length range', async () => {
    await build({ ...POP_LOGO, comp: { duration: 8.5, background: '#0F172A' } });
    expect(critique(editor.store, { max: 40, pace: 'fast' }).issues.map(i => i.rule)).toContain('logo-length');
    expect(critique(editor.store, { max: 40, pace: 'calm' }).issues.map(i => i.rule)).not.toContain('logo-length');
  });
});

describe('logo rigs', () => {
  it('frame-detail pulls back from a detail: starts at the zoom around that point, rests at the original scale', async () => {
    const ids = (await build({ comp: { duration: 4 }, layers: [{ key: 'm', children: [{ key: 'a', type: 'rect', x: 800, y: 440, w: 200, h: 200, fill: '#ffffff' }, { key: 'd', type: 'ellipse', center: [980, 460], w: 40, h: 40, fill: '#ff0000' }] }] })).ids;
    const out = JSON.parse(await run('rig', { kind: 'frame-detail', ids: [ids.m], t0: 0.25, duration: 1.2, options: { at: ids.d, zoom: 8 } }));
    expect(out.notes[0]).toMatch(/8x around \[980, 460\]/);
    const m = editor.store.layer(ids.m)!;
    expect(valueAt(m, 'scale', 0.25)).toEqual([800, 800]);
    expect(valueAt(m, 'scale', 1.45)).toEqual([100, 100]);
    expect(valueAt(m, 'rotation', 0.25)[0]).toBe(4);
    // the detail stays where it is on screen while the zoom changes (it is the pivot)
    const { worldBox } = await import('../src/agent/motion-math');
    const c = (t: number) => { const b = worldBox(editor.store, editor.store.layer(ids.d)!, t); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; };
    expect(Math.hypot(c(0.25)[0] - 980, c(0.25)[1] - 460)).toBeLessThan(1);
    expect(Math.hypot(c(0.8)[0] - 980, c(0.8)[1] - 460)).toBeLessThan(1);
    // out = push into the detail
    await run('rig', { kind: 'frame-detail', ids: [ids.m], t0: 3, duration: 0.6, mode: 'out', options: { at: ids.d, zoom: 8 } });
    expect(valueAt(editor.store.layer(ids.m)!, 'scale', 3.6)).toEqual([800, 800]);
  });

  it('color-cuts steps a fill through the palette with hold keys, settles on the base colour, flips ink', async () => {
    const ids = (await build({ comp: { duration: 4, background: '#101010' }, layers: [{ key: 'w', text: 'Mark', fontSize: 120, x: 700, y: 460, fill: '#FFFFFF' }] })).ids;
    const out = JSON.parse(await run('rig', { kind: 'color-cuts', t0: 0.5, options: { colors: ['#FFFFFF', '#F43F5E'], every: 0.4, count: 3, ink: [ids.w] } }));
    const bg = editor.store.layer(out.layers.find((l: any) => l.name === 'Background').id)!;
    expect(editor.store.comp.root[0]).toBe(bg.id); // at the bottom
    const near = (a: number[], b: number[]) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) < 0.01);
    expect(near(valueAt(bg, 'fill', 0.2), [0.063, 0.063, 0.063])).toBe(true);
    expect(near(valueAt(bg, 'fill', 0.6), [1, 1, 1])).toBe(true);
    expect(near(valueAt(bg, 'fill', 1.0), [0.957, 0.247, 0.369])).toBe(true);
    expect(near(valueAt(bg, 'fill', 2.0), [0.063, 0.063, 0.063])).toBe(true);
    expect(bg.props.fill!.kf!.every((k, i, a) => i === a.length - 1 || k.interp === 'hold')).toBe(true);
    // the white wordmark goes dark on the white cut, back to white at the end
    const w = editor.store.layer(ids.w)!;
    expect(valueAt(w, 'fill', 0.6)[0]).toBeLessThan(0.2);
    expect(valueAt(w, 'fill', 2.0)[0]).toBeGreaterThan(0.9);
  });

  it('a thick draw-on stroke used as a mask is motion to the critic (path-following reveal)', async () => {
    await build({
      comp: { duration: 4, background: '#111111' },
      layers: [{ key: 'g', children: [
        { key: 'm', type: 'path', d: 'M560 540 C760 440 1160 640 1360 540', stroke: '#ffffff', strokeWidth: 220, fill: '#00000000', mask: true, drawOn: { t: 0.3, duration: 1.2, ease: 'Sine In Out' } },
        { key: 'w', text: 'SWEEP', fontSize: 200, fontWeight: 900, x: 600, y: 430, fill: '#F97316' },
      ] }],
    });
    const c = critique(editor.store, { max: 40 });
    // the masked text itself has no keys: the mask's draw-on is its motion
    expect(c.stats.animated).toBeGreaterThan(0);
    expect(c.stats.lastMotion).toBeGreaterThan(1.4);
  });
});

describe('logo knowledge', () => {
  it('ships the logo-recipes guide: concept families, 25 recipes with real tool names, timing and easing', async () => {
    const g = findGuide('logo-recipes')!;
    expect(g).toBeTruthy();
    const secs = guideSections(g).join(' | ');
    expect(secs).toMatch(/Timing/);
    expect(secs).toMatch(/Easing/);
    expect(secs).toMatch(/Recipes/);
    const recipes = guideSection(g, 'Recipes')!.match(/^\d+\. \*\*/gm) ?? [];
    expect(recipes.length).toBe(25);
    // every `tool` named in a recipe line exists; every rig kind and ease name used is real
    const names = new Set(TOOLS.map(t => t.name));
    for (const m of g.text.matchAll(/`([a-z_]+) \{/g)) expect(names.has(m[1]), m[1]).toBe(true);
    const rig = TOOLS.find(t => t.name === 'rig')!.inputSchema.properties.kind.enum as string[];
    for (const m of g.text.matchAll(/kind: "([a-z-]+)"/g)) expect(rig, m[1]).toContain(m[1]);
    const { EASE_PRESETS, SPRING_PRESETS } = await import('../src/core/easing');
    const eases = new Set([...EASE_PRESETS.map(p => p.name), ...SPRING_PRESETS.map(p => 'spring ' + p.name)]);
    for (const m of g.text.matchAll(/ease: "([^"]+)"/g)) if (!/^spring:/.test(m[1])) expect(eases.has(m[1]), m[1]).toBe(true);
    expect(await run('get_guide', { name: 'logo-recipes', section: 'Timing' })).toMatch(/lead-in/i);
    expect(await run('get_guide', {})).toMatch(/logo-recipes/);
  });

  it('every logo example uses only real tools, and logo briefs retrieve logo examples', async () => {
    for (const g of LOGO_EXAMPLES()) for (const c of exampleCalls(g)) expect(TOOLS.some(t => t.name === c.tool), `${g.name}: ${c.tool}`).toBe(true);
    const top = (b: string) => findExamples(b, 2).map(g => g.name);
    expect(top('logo sting: dots of a network converge, wordmark slides out')).toContain('examples/logo-dots-converge');
    expect(top('a script monoline wordmark that writes itself')).toContain('examples/logo-monoline-write');
    expect(top('blocks morph into the letters of our wordmark')).toContain('examples/logo-blocks-morph');
    expect(top('pull back from a giant crop of the logo')).toContain('examples/logo-giant-crop');
    expect(top('a loopable logo bumper that plays back out')).toContain('examples/logo-mirror-loop');
  });
});
