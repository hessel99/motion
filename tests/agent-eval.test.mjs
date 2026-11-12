// scripts/agent-eval-lib.mjs: metrics, checklist checks and judge parsing on a synthetic document
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { computeMetrics, runChecklist, parseJudge, segEase } from '../scripts/agent-eval-lib.mjs';

const k = (t, v, extra = {}) => ({ t, v, interp: 'bezier', out: [0.16, 1], in: [0.3, 1], ...extra });
const layer = (id, type, props, extra = {}) => ({ id, name: id, type, parent: null, children: [], visible: true, locked: false, inPoint: 0, outPoint: 1e9, props, ...extra });
const doc = {
  comps: { c: { id: 'c', width: 1000, height: 500, fps: 30, duration: 2, root: ['a', 'b', 't'], markers: [] } },
  layers: {
    a: layer('a', 'rect', { fill: { v: [1, 0, 0, 1] }, size: { v: [100, 100] }, scale: { v: [100, 100], kf: [k(0, [0, 0], { interp: 'spring', bounce: 0.4 }), k(0.5, [100, 100])] } }),
    b: layer('b', 'ellipse', { fill: { v: [0, 0, 1, 1] }, size: { v: [100, 100] }, position: { v: [0, 0], kf: [k(1, [0, 0]), k(1.5, [10, 0])] } }),
    t: layer('t', 'text', { fill: { v: [1, 1, 1, 1] } }, { text: { content: 'Hello NOVA', fontFamily: 'Inter', fontSize: 64, fontWeight: 600 }, textAnim: { by: 'char', start: 0, duration: 0.5, stagger: 0.03, ease: 'Expo Out', mode: 'in', from: { opacity: 0, dx: 0, dy: 0, scale: 100, rotation: 0 } } }),
  },
};
const samples = [];
for (let i = 0; i <= 20; i++) {
  const t = i / 10;
  samples.push({ t, items: [['a', 100, 100, 200, 200, t < 0.5 ? t * 2 : 1], ['b', 950 + (t > 1 ? (t - 1) * 20 : 0), 100, 1050 + (t > 1 ? (t - 1) * 20 : 0), 200, 1], ['t', 150, 150, 400, 220, 1]] });
}
const probe = { comp: { width: 1000, height: 500, fps: 30, duration: 2, background: [0, 0, 0, 1] }, samples, vals: {}, loopDiff: 0.2, midLuma: 0.05 };

describe('agent eval metrics', () => {
  it('computes eases, palette, off-canvas and activity', () => {
    const { metrics: m } = computeMetrics(doc, probe);
    expect(m.keys).toBe(4);
    expect(m.easesUsed).toEqual({ 'Spring 0.4': 1, 'Expo Out': 1 });
    expect(m.overshootSegments).toBe(1);
    expect(m.textAnimators).toBe(1);
    expect(m.paletteSize).toBe(4); // red, blue, white, black bg
    expect(m.offCanvasTime).toBeGreaterThan(1.5); // b hangs half off the right edge the whole time
    expect(m.lastMotion).toBeCloseTo(2, 1);
  });
  it('runs checklist checks', () => {
    const { metrics, derived } = computeMetrics(doc, probe);
    const brief = { checklist: [
      { text: 'NOVA', check: { type: 'textContains', text: 'nova' } },
      { text: 'overshoot', check: { type: 'overshoot' } },
      { text: 'per letter', check: { type: 'perLetter' } },
      { text: 'loops', check: { type: 'loops' } },
      { text: 'dark', check: { type: 'darkBackground' } },
      { text: 'judge only', check: null },
    ] };
    const r = runChecklist(brief, metrics, derived);
    expect(r.items.map((i) => i.pass)).toEqual([true, true, true, false, true, null]);
    expect([r.hits, r.checkable, r.total]).toEqual([4, 5, 6]);
  });
  it('names eases', () => {
    expect(segEase(k(0, [0], { out: [0.34, 1.56] }), k(1, [1], { in: [0.64, 1] }))).toBe('Back Out');
    expect(segEase(k(0, [0], { interp: 'hold' }), k(1, [1]))).toBe('Hold');
  });
  it('parses judge answers', () => {
    const j = parseJudge('blah\n```json\n{"brief_fit":6,"style_match":5,"timing_easing":4,"composition":7,"richness":3,"polish":5,"critique":["a","b"]}\n```');
    expect(j.overall).toBe(5);
    expect(j.critique).toEqual(['a', 'b']);
    expect(parseJudge('{"brief_fit": 11}')).toBeNull();
  });
  it('every brief is well formed', () => {
    const dir = new URL('../evals/briefs/', import.meta.url);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const f of files) {
      const b = JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'));
      expect(b.id + '.json').toBe(f);
      expect(b.prompt.length).toBeGreaterThan(80);
      expect(b.comp.width * b.comp.height * b.comp.duration * b.comp.fps).toBeGreaterThan(0);
      expect(b.style.length).toBeGreaterThan(0);
      expect(b.checklist.length).toBeGreaterThanOrEqual(5);
    }
  });
});
