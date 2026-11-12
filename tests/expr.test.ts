import { describe, it, expect } from 'vitest';
import { parseExpr, evalExpr, compileExpr, type ExprContext } from '../src/core/expr';

const ctx = (over: Partial<ExprContext> = {}): ExprContext => ({
  time: 1, value: [100, 50], index: 1, fps: 30, duration: 5, inPoint: 0, seed: 7,
  valueAt: t => [t * 10, 0], keyTimes: [0, 2], ...over,
});
const run = (src: string, c = ctx()) => evalExpr(parseExpr(src), c);

describe('expressions', () => {
  it('math, precedence, vectors', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('2 ^ 3 ^ 2')).toBe(512);
    expect(run('-(3 - 5)')).toBe(2);
    expect(run('value + [10, 20]')).toEqual([110, 70]);
    expect(run('value * 2')).toEqual([200, 100]);
    expect(run('[time * 360, 0][0]')).toBe(360);
    expect(run('time > 0.5 ? 1 : 0')).toBe(1);
    expect(run('Math.sin(0) + Math.max(1, 3, 2)')).toBe(3);
  });
  it('linear / ease / clamp', () => {
    expect(run('linear(time, 0, 2, 0, 100)')).toBe(50);
    expect(run('ease(time, 0, 2, 0, 100)')).toBe(50);
    expect(run('linear(5, 0, 2, 0, 100)')).toBe(100);
    expect(run('clamp(150, 0, 100)')).toBe(100);
  });
  it('wiggle is deterministic and bounded', () => {
    const a = run('wiggle(2, 30)', ctx({ time: 1.37 })) as number[];
    const b = run('wiggle(2, 30)', ctx({ time: 1.37 })) as number[];
    expect(a).toEqual(b);
    for (let t = 0; t < 5; t += 0.1) {
      const v = run('wiggle(3, 30)', ctx({ time: t })) as number[];
      expect(Math.abs(v[0] - 100)).toBeLessThanOrEqual(30.001);
    }
  });
  it('loopOut cycle / pingpong / offset', () => {
    // keys at 0 and 2, value(t) = 10t
    expect(run("loopOut('cycle')", ctx({ time: 2.5 }))).toEqual([5, 0]);
    expect(run("loopOut('pingpong')", ctx({ time: 2.5 }))).toEqual([15, 0]);
    expect(run("loopOut('offset')", ctx({ time: 2.5 }))).toEqual([25, 0]);
    expect(run("loopOut()", ctx({ time: 1 }))).toEqual([100, 50]);
  });
  it('rejects code, never evaluates js', () => {
    expect(compileExpr('alert(1)').error).toBeNull(); // parses as a call ...
    expect(() => run('alert(1)')).toThrow(/unknown function/); // ... but is not a known function
    expect(compileExpr('window.location = 1').error).not.toBeNull();
    expect(compileExpr('this.constructor.constructor("x")()').error).not.toBeNull();
    expect(() => run('document')).toThrow(/unknown name/);
  });
});
