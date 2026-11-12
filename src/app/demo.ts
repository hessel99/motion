// demo + stress scenes. the stress scene creates N independently animated layers to measure
// playback performance ("a ton of nodes where it all moves").

import { createComp, createLayer, createProject, type Keyframe, type Layer, type Project } from '../core/model';
import { EASE_PRESETS } from '../core/easing';

function rnd(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const kf = (t: number, v: number[], e: [number, number, number, number] = [0.333, 0, 0.667, 1]): Keyframe => ({ t, v, interp: 'bezier', out: [e[0], e[1]], in: [e[2], e[3]] });

/** fix the "in" handle of each key to match the previous key's ease (we build eases per segment) */
function chain(keys: Keyframe[], eases: [number, number, number, number][]) {
  for (let i = 0; i < keys.length - 1; i++) {
    const e = eases[i % eases.length];
    keys[i].out = [e[0], e[1]];
    keys[i + 1].in = [e[2], e[3]];
  }
  return keys;
}

export interface StressOptions { count: number; kinds?: ('rect' | 'ellipse' | 'text' | 'path')[]; nested?: boolean; seed?: number }

export function stressProject(opts: StressOptions): Project {
  const p = createProject(`Stress ${opts.count}`);
  const comp = p.comps[p.activeComp];
  comp.width = 1920; comp.height = 1080; comp.duration = 6; comp.fps = 60;
  const r = rnd(opts.seed ?? 7);
  const kinds = opts.kinds ?? ['rect', 'ellipse'];
  const eases = EASE_PRESETS.filter(e => e.group !== 'basic').map(e => e.v);
  let parent: Layer | null = null;
  for (let i = 0; i < opts.count; i++) {
    const kind = kinds[i % kinds.length];
    const s = 6 + r() * 40;
    const x = r() * comp.width, y = r() * comp.height;
    const hue = r();
    const color = hsl(hue, 0.7, 0.6);
    let l: Layer;
    if (kind === 'text') {
      l = createLayer('text', { x, y, w: 0, h: 0, color, name: `Text ${i}`, text: { content: 'motion', fontFamily: 'Inter', fontSize: 14 + r() * 30, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'left' } } as any);
    } else if (kind === 'path') {
      l = createLayer('path', { x, y, w: s, h: s, color, name: `Star ${i}` });
      l.geometry = [{ cmds: star(s / 2, s / 2, s / 2, s / 4.5, 5), fillRule: 'nonzero' }];
      l.geomSize = [s, s];
    } else {
      l = createLayer(kind, { x, y, w: s, h: s, color, name: `${kind} ${i}` });
      if (kind === 'rect') l.props.radius = { v: [s * 0.2, s * 0.2, s * 0.2, s * 0.2] };
    }
    const n = 3 + Math.floor(r() * 3);
    const times = Array.from({ length: n }, (_, k) => (k / (n - 1)) * comp.duration);
    const pos = times.map(t => kf(t, [x + (r() - 0.5) * 300, y + (r() - 0.5) * 300]));
    l.props.position = { v: pos[0].v, kf: chain(pos, [eases[Math.floor(r() * eases.length)]]) };
    l.props.rotation = { v: [0], kf: chain(times.map(t => kf(t, [(r() - 0.5) * 360])), [eases[Math.floor(r() * eases.length)]]) };
    l.props.scale = { v: [100, 100], kf: chain(times.map(t => { const sc = 50 + r() * 100; return kf(t, [sc, sc]); }), [eases[Math.floor(r() * eases.length)]]) };
    l.props.opacity = { v: [100], kf: chain(times.map(t => kf(t, [30 + r() * 70])), [[0.42, 0, 0.58, 1]]) };
    l.props.fill = { v: color, kf: chain(times.map(t => kf(t, hsl((hue + t * 0.1) % 1, 0.7, 0.6))), [[0.42, 0, 0.58, 1]]) };
    p.layers[l.id] = l;
    if (opts.nested && i % 10 === 0) {
      // every 10 layers start a rotating group to stress the hierarchy
      const g: Layer = createLayer('group', { x: 0, y: 0, w: comp.width, h: comp.height, name: `Group ${i / 10}` });
      g.props.rotation = { v: [0], kf: [kf(0, [-3]), kf(comp.duration, [3])] };
      p.layers[g.id] = g;
      comp.root.push(g.id);
      parent = g;
    }
    if (parent) { l.parent = parent.id; parent.children.push(l.id); }
    else comp.root.push(l.id);
  }
  return p;
}

function hsl(h: number, s: number, l: number): [number, number, number, number] {
  const f = (n: number) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4), 1];
}

function star(cx: number, cy: number, ro: number, ri: number, n: number) {
  const cmds: any[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? ri : ro;
    cmds.push([i ? 'L' : 'M', cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  cmds.push(['Z']);
  return cmds;
}

/** a small hand-made demo animation (logo reveal) */
export function demoProject(): Project {
  const p = createProject('Demo');
  const comp = createComp({ name: 'Logo reveal', width: 1920, height: 1080, duration: 4, fps: 60, background: [0.06, 0.06, 0.08, 1] });
  p.comps = { [comp.id]: comp };
  p.activeComp = comp.id;
  const add = (l: Layer) => { p.layers[l.id] = l; comp.root.push(l.id); return l; };
  const cx = 960, cy = 540;
  const colors: [number, number, number, number][] = [[0.3, 0.55, 1, 1], [1, 0.36, 0.42, 1], [1, 0.78, 0.25, 1]];
  const expoOut: [number, number, number, number] = [0.16, 1, 0.3, 1];
  const backOut: [number, number, number, number] = [0.34, 1.56, 0.64, 1];
  colors.forEach((c, i) => {
    const l = createLayer(i === 1 ? 'ellipse' : 'rect', { x: cx - 90 + (i - 1) * 220, y: cy - 90 - 60, w: 180, h: 180, color: c, name: ['Square', 'Circle', 'Pill'][i] });
    if (i === 2) l.props.radius = { v: [90, 90, 90, 90] };
    if (i === 0) l.props.radius = { v: [36, 36, 36, 36] };
    const t0 = 0.2 + i * 0.12;
    const px = cx + (i - 1) * 220, py = cy - 60;
    l.props.position = { v: [px, py], kf: chain([kf(t0, [px, py + 260]), kf(t0 + 0.9, [px, py])], [expoOut]) };
    l.props.scale = { v: [100, 100], kf: chain([kf(t0, [0, 0]), kf(t0 + 0.7, [100, 100])], [backOut]) };
    l.props.rotation = { v: [0], kf: chain([kf(t0, [i === 1 ? 0 : -90]), kf(t0 + 1, [0])], [expoOut]) };
    l.props.opacity = { v: [100], kf: chain([kf(t0, [0]), kf(t0 + 0.3, [100])], [[0, 0, 0.58, 1]]) };
    add(l);
  });
  const title = createLayer('text', {
    x: cx - 400, y: cy + 120, w: 800, h: 100, color: [1, 1, 1, 1], name: 'Title',
    text: { content: 'Motion', fontFamily: 'Inter', fontSize: 96, fontWeight: 800, lineHeight: 1.1, letterSpacing: -2, align: 'center' },
  } as any);
  title.props.position = { v: [cx, cy + 170], kf: chain([kf(0.9, [cx, cy + 230]), kf(1.8, [cx, cy + 170])], [expoOut]) };
  title.props.opacity = { v: [100], kf: chain([kf(0.9, [0]), kf(1.5, [100])], [[0.42, 0, 0.58, 1]]) };
  add(title);
  return p;
}
