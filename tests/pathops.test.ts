// path booleans used by lottie merge paths (src/import/pathops.ts)
import { describe, it, expect } from 'vitest';
import { booleanRings, booleanMany, flattenCmds, ringsArea, type Ring } from '../src/import/pathops';
import { ellipseCmds } from '../src/import/lottie';

const sq = (x: number, y: number, s: number): Ring => [x, y, x + s, y, x + s, y + s, x, y + s];
const area = (r: Ring[]) => Math.abs(ringsArea(r));

describe('path booleans', () => {
  it('two overlapping squares', () => {
    const a = [sq(0, 0, 10)], b = [sq(5, 5, 10)];
    expect(area(booleanRings(a, b, 'union'))).toBeCloseTo(175, 3);
    expect(area(booleanRings(a, b, 'intersect'))).toBeCloseTo(25, 3);
    expect(area(booleanRings(a, b, 'difference'))).toBeCloseTo(75, 3);
    expect(area(booleanRings(a, b, 'xor'))).toBeCloseTo(150, 3);
  });

  it('output rings are consistently oriented (holes cancel with either fill rule)', () => {
    const r = booleanRings([sq(0, 0, 10)], [sq(3, 3, 4)], 'difference');
    expect(r.length).toBe(2);
    expect(Math.abs(ringsArea(r))).toBeCloseTo(84, 3); // signed sum = outer - hole
  });

  it('shared edges and touching squares', () => {
    expect(area(booleanRings([sq(0, 0, 10)], [sq(10, 0, 10)], 'union'))).toBeCloseTo(200, 3);
    const u = booleanRings([sq(0, 0, 10)], [sq(10, 0, 10)], 'union');
    expect(u.length).toBe(1); // the shared edge is gone
    expect(area(booleanRings([sq(0, 0, 10)], [sq(0, 0, 10)], 'intersect'))).toBeCloseTo(100, 3);
    expect(area(booleanRings([sq(0, 0, 10)], [sq(0, 0, 10)], 'difference'))).toBeCloseTo(0, 3);
    expect(area(booleanRings([sq(0, 0, 10)], [sq(0, 5, 10)], 'difference'))).toBeCloseTo(50, 3);
  });

  it('opposite winding and self-overlapping operands use the nonzero rule', () => {
    const rev = (r: Ring) => { const o: Ring = []; for (let i = r.length - 2; i >= 0; i -= 2) o.push(r[i], r[i + 1]); return o; };
    // a donut written as outer + reversed inner is a hole (nonzero)
    const donut = [sq(0, 0, 10), rev(sq(3, 3, 4))];
    expect(area(booleanRings(donut, [], 'union'))).toBeCloseTo(84, 3);
    // the same winding twice is still covered once
    expect(area(booleanRings([sq(0, 0, 10), sq(0, 0, 10)], [], 'union'))).toBeCloseTo(100, 3);
  });

  it('circles: intersection lens area', () => {
    const c1 = flattenCmds(ellipseCmds(0, 0, 10, 10), 0.001), c2 = flattenCmds(ellipseCmds(10, 0, 10, 10), 0.001);
    const r = 10, d = 10;
    const lens = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
    expect(area(booleanRings(c1, c2, 'intersect'))).toBeCloseTo(lens, 0);
    expect(area(booleanRings(c1, c2, 'union'))).toBeCloseTo(2 * Math.PI * 100 - lens, 0);
  });

  it('applies several operands in order (top first)', () => {
    const r = booleanMany([[sq(0, 0, 10)], [sq(5, 0, 10)], [sq(0, 5, 10)]], 'difference');
    expect(area(r)).toBeCloseTo(25, 3);
    expect(booleanMany([[sq(0, 0, 10)]], 'intersect')).toEqual([sq(0, 0, 10)]);
  });

  it('is fast enough for detailed shapes', () => {
    const a = flattenCmds(ellipseCmds(0, 0, 100, 60), 0.0005), b = flattenCmds(ellipseCmds(40, 10, 70, 90), 0.0005);
    // best single run of 20: robust against a busy machine (other processes), still catches real slowdowns
    let best = Infinity;
    for (let i = 0; i < 20; i++) { const t0 = performance.now(); booleanRings(a, b, 'xor'); best = Math.min(best, performance.now() - t0); }
    expect(best).toBeLessThan(30);
  });
});
