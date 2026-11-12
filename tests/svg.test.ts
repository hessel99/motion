import { describe, it, expect } from 'vitest';
import { parsePathD, cmdsBounds, parseTransform, parseColor, svgToLayers, numList } from '../src/import/svg';
import type { Layer, PathCmd } from '../src/core/model';

const close = (a: PathCmd[], b: PathCmd[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((c, i) => {
    expect(c[0]).toBe(b[i][0]);
    for (let k = 1; k < c.length; k++) expect(c[k] as number).toBeCloseTo(b[i][k] as number, 5);
  });
};

describe('svg path parser', () => {
  it('absolute + relative + implicit lineto', () => {
    close(parsePathD('M10 20 L30 40 l10 10 h5 v-5 H0 V0 z'), [
      ['M', 10, 20], ['L', 30, 40], ['L', 40, 50], ['L', 45, 50], ['L', 45, 45], ['L', 0, 45], ['L', 0, 0], ['Z'],
    ]);
    close(parsePathD('m1 1 2 2 3 3'), [['M', 1, 1], ['L', 3, 3], ['L', 6, 6]]);
    close(parsePathD('M0,0L1,1M5 5l1 1'), [['M', 0, 0], ['L', 1, 1], ['M', 5, 5], ['L', 6, 6]]);
  });

  it('compact numbers', () => {
    close(parsePathD('M.5.5L-1-2l1e1-1.5.5.5'), [['M', 0.5, 0.5], ['L', -1, -2], ['L', 9, -3.5], ['L', 9.5, -3]]);
    expect(numList('1,2 3-4.5.5e1')).toEqual([1, 2, 3, -4.5, 5]);
  });

  it('S / T reflect control points', () => {
    close(parsePathD('M0 0 C0 10 10 10 10 0 S20 -10 20 0'), [['M', 0, 0], ['C', 0, 10, 10, 10, 10, 0], ['C', 10, -10, 20, -10, 20, 0]]);
    close(parsePathD('M0 0 Q5 10 10 0 T20 0 t10 0'), [['M', 0, 0], ['Q', 5, 10, 10, 0], ['Q', 15, -10, 20, 0], ['Q', 25, 10, 30, 0]]);
    close(parsePathD('M0 0 s5 5 10 0'), [['M', 0, 0], ['C', 0, 0, 5, 5, 10, 0]]);
  });

  it('closepath resets current point for relative commands', () => {
    close(parsePathD('M10 10 l5 0 z l1 1'), [['M', 10, 10], ['L', 15, 10], ['Z'], ['L', 11, 11]]);
  });

  it('arcs -> cubics', () => {
    // half circle radius 10 from (0,0) to (20,0), sweep=1 goes through y<0? (clockwise in y-down = above)
    const c = parsePathD('M0 0 A10 10 0 0 1 20 0');
    expect(c[0]).toEqual(['M', 0, 0]);
    expect(c.length).toBe(3);
    expect(c.every((x, i) => i === 0 || x[0] === 'C')).toBe(true);
    const last = c[c.length - 1] as number[];
    expect(last[5]).toBeCloseTo(20, 6); expect(last[6]).toBeCloseTo(0, 6);
    const [x, y, w, h] = cmdsBounds(c);
    expect(x).toBeCloseTo(0, 3); expect(w).toBeCloseTo(20, 3);
    expect(h).toBeCloseTo(10, 2);
    expect(y).toBeCloseTo(-10, 2);
    // compact flags + relative + radius scale-up
    const d = parsePathD('M0 0a5 5 0 1020 0');
    expect((d[d.length - 1] as number[])[5]).toBeCloseTo(20, 6);
    const [, y2, , h2] = cmdsBounds(d);
    expect(y2).toBeCloseTo(0, 2); expect(h2).toBeCloseTo(10, 2); // sweep=0 -> below
    // full circle from two arcs
    const circ = parsePathD('M10 0 A10 10 0 1 1 -10 0 A10 10 0 1 1 10 0Z');
    const b = cmdsBounds(circ);
    b.forEach((v, i) => expect(v).toBeCloseTo([-10, -10, 20, 20][i], 3));
    // zero radius -> line
    close(parsePathD('M0 0 A0 5 0 0 1 10 10'), [['M', 0, 0], ['L', 10, 10]]);
  });

  it('stops at garbage but keeps prior commands', () => {
    close(parsePathD('M0 0 L10 10 L5 # 7'), [['M', 0, 0], ['L', 10, 10]]);
  });

  it('bounds use curve extrema', () => {
    const b = cmdsBounds([['M', 0, 0], ['C', 0, 10, 10, 10, 10, 0]]);
    expect(b[3]).toBeCloseTo(7.5, 6);
  });
});

describe('svg helpers', () => {
  it('transforms', () => {
    expect(parseTransform('translate(10 20) scale(2)')).toEqual([2, 0, 0, 2, 10, 20]);
    const r = parseTransform('rotate(90 10 10)');
    const p = [r[0] * 20 + r[2] * 10 + r[4], r[1] * 20 + r[3] * 10 + r[5]];
    expect(p[0]).toBeCloseTo(10, 6); expect(p[1]).toBeCloseTo(20, 6);
  });
  it('colors', () => {
    expect(parseColor('#f00')).toEqual([1, 0, 0, 1]);
    expect(parseColor('#00ff0080')![3]).toBeCloseTo(128 / 255, 5);
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual([1, 0, 0, 0.5]);
    expect(parseColor('white')).toEqual([1, 1, 1, 1]);
    expect(parseColor('none')).toBeNull();
    const h = parseColor('hsl(120, 100%, 50%)')!;
    expect(h[1]).toBeCloseTo(1, 5); expect(h[0]).toBeCloseTo(0, 5);
  });
});

describe('svgToLayers', () => {
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 50" fill="none">
  <style>.blue{fill:#0000ff}</style>
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="0" y2="20" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff" stop-opacity="0.5"/>
    </linearGradient>
  </defs>
  <rect id="bg" x="10" y="5" width="20" height="10" rx="2" fill="#ff0000" stroke="black" stroke-width="2"/>
  <g transform="translate(50 0)" opacity="0.5">
    <circle class="blue" cx="10" cy="10" r="5"/>
    <path d="M0 0 L10 0 L10 20 Z" fill="url(#lg)" transform="rotate(45)"/>
  </g>
  <rect x="0" y="0" width="10" height="10" fill="green" transform="skewX(30)"/>
  <text x="5" y="40" font-size="8" font-family="'Helvetica Neue', Arial" font-weight="bold" text-anchor="middle" style="fill: #333">Hi &amp; bye</text>
  <rect width="5" height="5" display="none"/>
</svg>`;
  const { layers, roots } = svgToLayers(svg);
  const ids = new Map(layers.map(l => [l.id, l]));
  const kids = (l: Layer) => l.children.map(id => ids.get(id)!);

  it('root group sized to the svg', () => {
    expect(roots.length).toBe(1);
    const root = ids.get(roots[0])!;
    expect(root.type).toBe('group');
    expect(root.props.size!.v).toEqual([200, 100]);
    expect(kids(root).map(l => l.type)).toEqual(['rect', 'group', 'path', 'text']);
  });

  it('rect with viewBox scaling', () => {
    const r = layers.find(l => l.name === 'bg')!;
    expect(r.props.size!.v).toEqual([20, 10]);
    expect(r.props.scale!.v).toEqual([200, 200]);
    expect(r.props.position!.v).toEqual([40, 20]); // (10+10, 5+5) * 2
    expect(r.props.fill!.v).toEqual([1, 0, 0, 1]);
    expect(r.props.radius!.v).toEqual([2, 2, 2, 2]);
    expect(r.props.strokeWidth!.v).toEqual([2]);
  });

  it('group, class fill, gradient path', () => {
    const root = ids.get(roots[0])!;
    const g = kids(root)[1];
    expect(g.props.position!.v).toEqual([100, 0]);
    expect(g.props.scale!.v).toEqual([200, 200]);
    expect(g.props.opacity!.v).toEqual([50]);
    const [circle, path] = kids(g);
    expect(circle.type).toBe('ellipse');
    expect(circle.props.fill!.v).toEqual([0, 0, 1, 1]);
    expect(circle.props.position!.v).toEqual([10, 10]);
    expect(path.type).toBe('path');
    expect(path.paints![0].type).toBe('linear');
    expect(path.paints![0].stops![1].color[3]).toBeCloseTo(0.5, 5);
    // gradient endpoints map back into user space through the rotation
    const m = path.paints![0].transform!;
    const [w, h] = path.geomSize!;
    const b = layers.find(l => l === path)!;
    const pos = b.props.position!.v, anc = b.props.anchor!.v;
    const toUser = (u: number, v: number) => {
      const nx = (m[0] * u + m[2] * v + m[4]) * w, ny = (m[1] * u + m[3] * v + m[5]) * h;
      return [nx - anc[0] + pos[0], ny - anc[1] + pos[1]]; // path layers are unrotated
    };
    const s = toUser(0, 0.5), e = toUser(1, 0.5);
    // (0,0) and (0,20) rotated 45deg
    expect(s[0]).toBeCloseTo(0, 4); expect(s[1]).toBeCloseTo(0, 4);
    expect(e[0]).toBeCloseTo(-20 * Math.SQRT1_2, 4); expect(e[1]).toBeCloseTo(20 * Math.SQRT1_2, 4);
  });

  it('skewed rect becomes a baked path', () => {
    const root = ids.get(roots[0])!;
    const p = kids(root)[2];
    expect(p.type).toBe('path');
    expect(p.geomSize![0]).toBeCloseTo(20 * (1 + Math.tan(Math.PI / 6)), 4);
    expect(p.props.fill!.v).toEqual([0, 128 / 255, 0, 1]);
  });

  it('text', () => {
    const t = layers.find(l => l.type === 'text')!;
    expect(t.text!.content).toBe('Hi & bye');
    expect(t.text!.fontFamily).toBe('Helvetica Neue');
    expect(t.text!.fontWeight).toBe(700);
    expect(t.text!.align).toBe('center');
    expect(t.props.fill!.v[0]).toBeCloseTo(0x33 / 255, 5);
    expect(t.props.position!.v[0]).toBeCloseTo(10, 5); // centered on x=5 * 2
  });
});
