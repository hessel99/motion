// stress-lab scene builders: brutal, deterministic workloads for scripts/stress-lab.mjs.
// every builder returns a plain Project (same model the app saves), seeded so runs are comparable.

import { createComp, createLayer, createProject, uid, type Asset, type Keyframe, type Layer, type PathCmd, type Project } from '../core/model';
import { EASE_PRESETS } from '../core/easing';
import { TEXT_ANIM_PRESETS } from '../core/presets';

export function rnd(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

type E4 = [number, number, number, number];
const EASES: E4[] = EASE_PRESETS.filter(e => e.group !== 'basic').map(e => e.v);

/** keys at times with a random ease per segment; every `springEvery`-th segment is a spring */
function keys(r: () => number, times: number[], val: (k: number) => number[], springEvery = 0): Keyframe[] {
  const out: Keyframe[] = times.map((t, k) => ({ t, v: val(k), interp: 'bezier', out: [0.333, 0], in: [0.667, 1] }));
  for (let i = 0; i < out.length - 1; i++) {
    if (springEvery && i % springEvery === 0) { out[i].interp = 'spring'; out[i].bounce = 0.1 + r() * 0.6; continue; }
    const e = EASES[Math.floor(r() * EASES.length)];
    out[i].out = [e[0], e[1]];
    out[i + 1].in = [e[2], e[3]];
  }
  return out;
}

function hsl(h: number, s: number, l: number): E4 {
  const f = (n: number) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4), 1];
}

function starCmds(cx: number, cy: number, ro: number, ri: number, n: number, rot = 0): PathCmd[] {
  const cmds: PathCmd[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2 + rot;
    const rr = i % 2 ? ri : ro;
    cmds.push([i ? 'L' : 'M', cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  cmds.push(['Z']);
  return cmds;
}

/** blob-ish closed cubic path with a fixed structure (so shapes with the same n morph pairwise) */
function blobCmds(r: () => number, s: number, n = 6): PathCmd[] {
  const cmds: PathCmd[] = [];
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2, rr = s / 2 * (0.55 + r() * 0.45);
    return [s / 2 + Math.cos(a) * rr, s / 2 + Math.sin(a) * rr];
  });
  cmds.push(['M', pts[0][0], pts[0][1]]);
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    cmds.push(['C', p[0] + (q[1] - p[1]) * 0.3, p[1] - (q[0] - p[0]) * 0.3, q[0] - (q[1] - p[1]) * 0.3, q[1] + (q[0] - p[0]) * 0.3, q[0], q[1]]);
  }
  cmds.push(['Z']);
  return cmds;
}

interface Ctx { p: Project; r: () => number; W: number; H: number; D: number }

function base(name: string, seed = 7, duration = 6): Ctx {
  const p = createProject(name);
  const comp = p.comps[p.activeComp];
  comp.width = 1920; comp.height = 1080; comp.duration = duration; comp.fps = 60;
  return { p, r: rnd(seed), W: 1920, H: 1080, D: duration };
}

function add(c: Ctx, l: Layer, parent: Layer | null = null, compRoot?: string[]) {
  c.p.layers[l.id] = l;
  if (parent) { l.parent = parent.id; parent.children.push(l.id); }
  else (compRoot ?? c.p.comps[c.p.activeComp].root).push(l.id);
  return l;
}

/** a shape (rect/ellipse) animated on position/rotation/scale/opacity/fill, springs mixed with beziers */
function movingShape(c: Ctx, kind: 'rect' | 'ellipse', x: number, y: number, s: number, springEvery = 2, nKeys?: number): Layer {
  const r = c.r;
  const hue = r();
  const color = hsl(hue, 0.7, 0.6);
  const l = createLayer(kind, { x, y, w: s, h: s, color, name: `${kind} ${x | 0}` });
  if (kind === 'rect') l.props.radius = { v: [s * 0.2, s * 0.2, s * 0.2, s * 0.2] };
  const n = nKeys ?? 3 + Math.floor(r() * 3);
  const times = Array.from({ length: n }, (_, k) => (k / (n - 1)) * c.D);
  const pos = keys(r, times, () => [x + (r() - 0.5) * 300, y + (r() - 0.5) * 300], springEvery);
  l.props.position = { v: pos[0].v, kf: pos };
  l.props.rotation = { v: [0], kf: keys(r, times, () => [(r() - 0.5) * 360]) };
  l.props.scale = { v: [100, 100], kf: keys(r, times, () => { const sc = 50 + r() * 100; return [sc, sc]; }, springEvery ? springEvery + 1 : 0) };
  l.props.opacity = { v: [100], kf: keys(r, times, () => [30 + r() * 70]) };
  l.props.fill = { v: color, kf: keys(r, times, k => hsl((hue + k * 0.1) % 1, 0.7, 0.6)) };
  return l;
}

// ---------------------------------------------------------------- scenes

/** N rects/ellipses, everything animated with springs + bezier easing */
export function springs(o: { n?: number; seed?: number } = {}): Project {
  const c = base(`springs ${o.n}`, o.seed);
  const n = o.n ?? 10000;
  for (let i = 0; i < n; i++) add(c, movingShape(c, i % 2 ? 'ellipse' : 'rect', c.r() * c.W, c.r() * c.H, 6 + c.r() * 40));
  return c.p;
}

/** groups nested `depth` levels (fanout per level), every group rotating/scaling, leaves animated.
 *  iso: groups get animated opacity < 1, which forces an offscreen isolation layer (fbo) per group */
export function nested(o: { n?: number; depth?: number; fanout?: number; iso?: boolean; seed?: number } = {}): Project {
  const c = base('nested', o.seed);
  const depth = o.depth ?? 8, fan = o.fanout ?? 2, n = o.n ?? 5000;
  const leafGroups = Math.pow(fan, depth - 1);
  const perLeaf = Math.max(1, Math.round(n / leafGroups));
  const mk = (parent: Layer | null, level: number) => {
    const g = createLayer('group', { x: 0, y: 0, w: c.W, h: c.H, name: `G${level}` });
    g.props.anchor = { v: [c.W / 2, c.H / 2] };
    g.props.position = { v: [c.W / 2, c.H / 2] };
    g.props.rotation = { v: [0], kf: keys(c.r, [0, c.D / 2, c.D], () => [(c.r() - 0.5) * 6]) };
    g.props.scale = { v: [100, 100], kf: keys(c.r, [0, c.D], () => { const s = 96 + c.r() * 8; return [s, s]; }, 1) };
    if (o.iso) g.props.opacity = { v: [90], kf: keys(c.r, [0, c.D / 2, c.D], () => [70 + c.r() * 29]) };
    add(c, g, parent);
    if (level === depth - 1) {
      for (let i = 0; i < perLeaf; i++) add(c, movingShape(c, i % 2 ? 'ellipse' : 'rect', c.r() * c.W, c.r() * c.H, 6 + c.r() * 30), g);
    } else for (let f = 0; f < fan; f++) mk(g, level + 1);
  };
  mk(null, 0);
  return c.p;
}

/** `comps` precomps, each instanced `inst` times in the main comp (comps*inst precomp layers) */
export function precomps(o: { comps?: number; inst?: number; inner?: number; seed?: number; offsets?: number } = {}): Project {
  const c = base('precomps', o.seed);
  const nComps = o.comps ?? 200, inst = o.inst ?? 50, inner = o.inner ?? 4;
  const compIds: string[] = [];
  for (let k = 0; k < nComps; k++) {
    const pc = createComp({ name: `pc ${k}`, width: 160, height: 160, duration: c.D, fps: 60, background: [0, 0, 0, 0] });
    c.p.comps[pc.id] = pc;
    compIds.push(pc.id);
    const saved = { W: c.W, H: c.H };
    c.W = 160; c.H = 160;
    for (let i = 0; i < inner; i++) add(c, movingShape(c, i % 2 ? 'ellipse' : 'rect', 20 + c.r() * 100, 20 + c.r() * 100, 10 + c.r() * 30), null, pc.root);
    Object.assign(c, saved);
  }
  for (let j = 0; j < nComps * inst; j++) {
    const ref = compIds[j % nComps];
    const x = c.r() * (c.W - 160), y = c.r() * (c.H - 160);
    const l = createLayer('precomp', { name: `inst ${j}`, w: 160, h: 160, x, y });
    l.compRef = ref;
    l.startTime = -c.r() * 2;
    // offsets = k: instances start at one of k times (instances of a comp then share evaluations)
    if (o.offsets) l.startTime = -(Math.floor(j / nComps) % o.offsets) * (2 / o.offsets);
    const times = [0, c.D / 2, c.D];
    l.props.position = { v: [x + 80, y + 80], kf: keys(c.r, times, () => [x + 80 + (c.r() - 0.5) * 200, y + 80 + (c.r() - 0.5) * 200], 2) };
    l.props.scale = { v: [100, 100], kf: keys(c.r, times, () => { const s = 40 + c.r() * 80; return [s, s]; }) };
    add(c, l);
  }
  return c.p;
}

const WORDS = ['Motion', 'design', 'springs', 'Bezier', 'keyframe', 'render', 'atlas', 'glyph', 'easing', 'timeline', 'Layer', 'precomp'];

/** N text layers with per-letter/word text animators (text reveal presets), moving */
export function textAnim(o: { n?: number; seed?: number } = {}): Project {
  const c = base('text animators', o.seed);
  const n = o.n ?? 2000;
  const presets = TEXT_ANIM_PRESETS.filter(p => p.anim.mode === 'in');
  for (let i = 0; i < n; i++) {
    const r = c.r;
    const content = `${WORDS[Math.floor(r() * WORDS.length)]} ${WORDS[Math.floor(r() * WORDS.length)]}`;
    const x = r() * c.W, y = r() * c.H;
    const l = createLayer('text', { x, y, w: 0, h: 0, color: hsl(r(), 0.6, 0.65), name: `Text ${i}`, text: { content, fontFamily: 'Inter', fontSize: [14, 18, 24, 32, 48][i % 5], fontWeight: [400, 700][i % 2], lineHeight: 1.2, letterSpacing: 0, align: 'left' } } as any);
    const pr = presets[i % presets.length].anim;
    l.textAnim = { ...pr, by: i % 3 === 0 ? 'word' : 'char', start: r() * 2, order: (['forward', 'backward', 'center', 'random'] as const)[i % 4], from: { ...pr.from } };
    const times = [0, c.D];
    l.props.position = { v: [x, y], kf: keys(r, times, () => [x + (r() - 0.5) * 200, y + (r() - 0.5) * 100]) };
    l.props.rotation = { v: [0], kf: keys(r, times, () => [(r() - 0.5) * 20]) };
    add(c, l);
  }
  return c.p;
}

/** N path layers morphing between shapes (pathKf) with animated trim paths on the stroke */
export function pathMorph(o: { n?: number; trim?: boolean; seed?: number } = {}): Project {
  const c = base('path morph', o.seed);
  const n = o.n ?? 1000;
  for (let i = 0; i < n; i++) {
    const r = c.r;
    const s = 30 + r() * 60;
    const x = r() * c.W, y = r() * c.H;
    const l = createLayer('path', { x, y, w: s, h: s, color: hsl(r(), 0.7, 0.6), name: `Morph ${i}` });
    const seg = 5 + (i % 4);
    const g0 = blobCmds(r, s, seg), g1 = blobCmds(r, s, seg), g2 = blobCmds(r, s, seg);
    l.geometry = [{ cmds: g0, fillRule: 'nonzero' }];
    l.geomSize = [s, s];
    const e = EASES[i % EASES.length];
    l.pathKf = [0, c.D / 2, c.D].map((t, k) => ({ t, geometry: [{ cmds: [g0, g1, g2][k], fillRule: 'nonzero' as const }], interp: 'bezier' as const, out: [e[0], e[1]] as [number, number], in: [e[2], e[3]] as [number, number] }));
    l.props.stroke = { v: hsl(r(), 0.8, 0.4) };
    l.props.strokeWidth = { v: [3] };
    if (o.trim !== false) {
      l.trimOn = true;
      l.props.trimStart = { v: [0], kf: keys(r, [0, c.D], () => [r() * 30]) };
      l.props.trimEnd = { v: [100], kf: keys(r, [0, c.D * 0.6, c.D], k => [k === 1 ? 100 : 20 + r() * 40]) };
      l.props.trimOffset = { v: [0], kf: keys(r, [0, c.D], k => [k * 360]) };
    }
    l.props.rotation = { v: [0], kf: keys(r, [0, c.D], () => [(r() - 0.5) * 180]) };
    add(c, l);
  }
  return c.p;
}

/** N layers driven by expressions: wiggle, loopOut, time math */
export function expressions(o: { n?: number; seed?: number } = {}): Project {
  const c = base('expressions', o.seed);
  const n = o.n ?? 3000;
  const rotExprs = ["loopOut('pingpong')", "loopOut('cycle')", 'time * 90', "loopOut('offset')"];
  for (let i = 0; i < n; i++) {
    const r = c.r;
    const s = 8 + r() * 30, x = r() * c.W, y = r() * c.H;
    const l = createLayer(i % 2 ? 'ellipse' : 'rect', { x, y, w: s, h: s, color: hsl(r(), 0.7, 0.6) });
    l.props.position = { v: [x, y], expr: `wiggle(${(1 + r() * 4).toFixed(1)}, ${(10 + r() * 40) | 0})` };
    l.props.rotation = { v: [0], kf: keys(r, [0, 1, 2], () => [(r() - 0.5) * 180]), expr: rotExprs[i % rotExprs.length] };
    l.props.scale = { v: [100, 100], expr: 'value + [sin(time * 3 + index) * 20, cos(time * 2 + index) * 20]' };
    l.props.opacity = { v: [100], expr: 'clamp(50 + 50 * sin(time * 2 + index * 0.1), 10, 100)' };
    add(c, l);
  }
  return c.p;
}

/** synthetic image assets (data urls), generated once per page */
let imageCache: Asset[] | null = null;
function images(count: number, size = 512): Asset[] {
  if (imageCache && imageCache.length >= count) return imageCache.slice(0, count);
  const out: Asset[] = [];
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const g = cv.getContext('2d')!;
  for (let k = 0; k < count; k++) {
    const gr = g.createLinearGradient(0, 0, size, size);
    gr.addColorStop(0, `hsl(${k * 47 % 360} 80% 55%)`); gr.addColorStop(1, `hsl(${(k * 47 + 140) % 360} 80% 35%)`);
    g.fillStyle = gr; g.fillRect(0, 0, size, size);
    for (let i = 0; i < 40; i++) { g.fillStyle = `hsla(${(i * 31 + k * 13) % 360} 90% 70% / 0.5)`; g.beginPath(); g.arc((i * 97 + k * 31) % size, (i * 57 + k * 71) % size, 10 + (i * 13) % 60, 0, 7); g.fill(); }
    out.push({ id: uid('a'), kind: 'image', mime: 'image/png', data: cv.toDataURL('image/png'), width: size, height: size });
  }
  imageCache = out;
  return out;
}

/** N large gradient rects/ellipses + image layers scaling 20%..300% (raster + atlas pressure) */
export function rasters(o: { n?: number; images?: number; seed?: number } = {}): Project {
  const c = base('rasters', o.seed);
  const n = o.n ?? 500;
  const assets = images(o.images ?? 16);
  for (const a of assets) c.p.assets[a.id] = a;
  for (let i = 0; i < n; i++) {
    const r = c.r;
    const w = 300 + r() * 600, h = 200 + r() * 500, x = r() * c.W - w / 2, y = r() * c.H - h / 2;
    let l: Layer;
    if (i % 3 === 2) {
      l = createLayer('image', { x, y, w, h, name: `Image ${i}` });
      l.imageRef = assets[i % assets.length].id;
    } else {
      l = createLayer(i % 3 ? 'ellipse' : 'rect', { x, y, w, h, name: `Gradient ${i}` });
      l.paints = [{ type: i % 2 ? 'radial' : 'linear', stops: [{ pos: 0, color: hsl(r(), 0.8, 0.6) }, { pos: 0.5 + r() * 0.3, color: hsl(r(), 0.8, 0.4) }, { pos: 1, color: [...hsl(r(), 0.9, 0.5).slice(0, 3), 0.4] as E4 }], transform: [1, 0, 0, 1, 0, 0] }];
      if (l.type === 'rect') l.props.radius = { v: [24, 24, 24, 24] };
    }
    const times = [0, c.D / 2, c.D];
    l.props.scale = { v: [100, 100], kf: keys(r, times, k => { const s = k === 1 ? 200 + r() * 100 : 20 + r() * 40; return [s, s]; }) };
    l.props.rotation = { v: [0], kf: keys(r, times, () => [(r() - 0.5) * 40]) };
    l.props.opacity = { v: [70] };
    add(c, l);
  }
  return c.p;
}

/** groups that each hold an animated mask shape + children using blend modes */
export function masksBlend(o: { groups?: number; kids?: number; seed?: number } = {}): Project {
  const c = base('masks + blend modes', o.seed);
  const nG = o.groups ?? 300, kids = o.kids ?? 8;
  const modes = ['multiply', 'screen', 'add', 'darken', 'lighten', 'normal'] as const;
  for (let gi = 0; gi < nG; gi++) {
    const r = c.r;
    const gw = 120 + r() * 160, x = r() * (c.W - gw), y = r() * (c.H - gw);
    const g = createLayer('group', { x, y, w: gw, h: gw, name: `Masked ${gi}` });
    g.props.fill = { v: [1, 1, 1, 0] };
    g.props.rotation = { v: [0], kf: keys(r, [0, c.D], () => [(r() - 0.5) * 90]) };
    add(c, g);
    const m = createLayer('ellipse', { x: 0, y: 0, w: gw, h: gw, name: 'mask' });
    m.mask = true;
    m.props.scale = { v: [100, 100], kf: keys(r, [0, c.D / 2, c.D], k => (k === 1 ? [100, 100] : [40, 40]), 1) };
    add(c, m, g);
    for (let k = 0; k < kids; k++) {
      const s = 30 + r() * gw * 0.6;
      const kid = movingShape({ ...c, W: gw, H: gw }, k % 2 ? 'ellipse' : 'rect', r() * gw - s / 2, r() * gw - s / 2, s, 0, 3);
      kid.blend = modes[(gi + k) % modes.length];
      add(c, kid, g);
    }
  }
  return c.p;
}

/** many huge overlapping semi-transparent layers (fill-rate / overdraw) */
export function overdraw(o: { n?: number; seed?: number } = {}): Project {
  const c = base('overdraw', o.seed);
  const n = o.n ?? 1500;
  for (let i = 0; i < n; i++) {
    const r = c.r;
    const w = c.W * (0.6 + r() * 0.6), h = c.H * (0.6 + r() * 0.6);
    const l = createLayer(i % 4 === 0 ? 'ellipse' : 'rect', { x: (c.W - w) / 2, y: (c.H - h) / 2, w, h, color: hsl(r(), 0.7, 0.5) });
    if (l.type === 'rect') l.props.radius = { v: [40, 40, 40, 40] };
    l.props.opacity = { v: [6], kf: keys(r, [0, c.D], () => [3 + r() * 8]) };
    l.props.position = { v: [c.W / 2, c.H / 2], kf: keys(r, [0, c.D], () => [c.W / 2 + (r() - 0.5) * 200, c.H / 2 + (r() - 0.5) * 120]) };
    l.props.rotation = { v: [0], kf: keys(r, [0, c.D], () => [(r() - 0.5) * 30]) };
    add(c, l);
  }
  return c.p;
}

/** a realistic heavy production comp: a bit of everything (used for camera moves, motion blur and the soak) */
export function mixed(o: { n?: number; seed?: number } = {}): Project {
  const n = o.n ?? 4000;
  const c = base('mixed', o.seed);
  const merge = (q: Project, wrapName?: string) => {
    Object.assign(c.p.layers, q.layers);
    Object.assign(c.p.assets, q.assets);
    const qc = q.comps[q.activeComp];
    for (const [id, comp] of Object.entries(q.comps)) if (id !== q.activeComp) c.p.comps[id] = comp;
    const root = c.p.comps[c.p.activeComp].root;
    if (wrapName) {
      const g = createLayer('group', { x: 0, y: 0, w: c.W, h: c.H, name: wrapName });
      g.props.fill = { v: [1, 1, 1, 0] };
      c.p.layers[g.id] = g;
      for (const id of qc.root) { q.layers[id].parent = g.id; g.children.push(id); }
      root.push(g.id);
    } else root.push(...qc.root);
  };
  merge(springs({ n: Math.round(n * 0.6), seed: 11 }), 'Shapes');
  merge(nested({ n: Math.round(n * 0.1), depth: 5, fanout: 2, seed: 12 }));
  merge(precomps({ comps: 10, inst: 10, inner: 4, seed: 13 }), 'Precomps');
  merge(expressions({ n: Math.round(n * 0.1), seed: 14 }), 'Expressions');
  merge(textAnim({ n: Math.round(n * 0.04), seed: 15 }), 'Titles');
  merge(pathMorph({ n: Math.round(n * 0.02), seed: 16 }), 'Morphs');
  merge(rasters({ n: Math.round(n * 0.01), images: 4, seed: 17 }), 'Rasters');
  merge(masksBlend({ groups: Math.round(n * 0.005), kids: 6, seed: 18 }), 'Masks');
  return c.p;
}

// ---------------------------------------------------------------- synthetic import payloads

/** lottie (bodymovin) json: N shape layers (rect/ellipse/path groups with fill+stroke), keyframed transforms, precomp assets */
export function syntheticLottie(o: { n?: number; precomps?: number; seed?: number } = {}): any {
  const r = rnd(o.seed ?? 5);
  const n = o.n ?? 3000, fr = 60, op = 360;
  const kfs = (vals: number[][], hold = false) => ({
    a: 1, k: vals.map((v, i) => ({ t: Math.round((i / (vals.length - 1)) * op), s: v, ...(i < vals.length - 1 ? { o: { x: [0.33], y: [0] }, i: { x: [0.67], y: [1] }, h: hold ? 1 : 0 } : {}) })),
  });
  const shapeItems = (i: number) => {
    const fill = { ty: 'fl', c: { a: 0, k: [r(), r(), r(), 1] }, o: { a: 0, k: 100 }, r: 1 };
    const stroke = { ty: 'st', c: { a: 0, k: [0, 0, 0, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 2 }, lc: 2, lj: 2 };
    const tr = { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } };
    let geo: any;
    if (i % 3 === 0) geo = { ty: 'rc', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [20 + r() * 60, 20 + r() * 60] }, r: { a: 0, k: 6 } };
    else if (i % 3 === 1) geo = { ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [20 + r() * 60, 20 + r() * 60] } };
    else {
      const pts = 6, v: number[][] = [], ti: number[][] = [], to: number[][] = [];
      for (let k = 0; k < pts; k++) { const a = k / pts * Math.PI * 2, rr = 20 + r() * 20; v.push([Math.cos(a) * rr, Math.sin(a) * rr]); ti.push([-5, 5]); to.push([5, -5]); }
      const shape = (s: number) => ({ c: true, v: v.map(p => [p[0] * s, p[1] * s]), i: ti, o: to });
      geo = i % 6 === 2 ? { ty: 'sh', ks: { a: 1, k: [{ t: 0, s: [shape(1)], o: { x: [0.33], y: [0] }, i: { x: [0.67], y: [1] } }, { t: op, s: [shape(1.6)] }] } } : { ty: 'sh', ks: { a: 0, k: shape(1) } };
    }
    return [{ ty: 'gr', it: [geo, fill, stroke, tr] }];
  };
  const layer = (i: number, ind: number) => {
    const x = r() * 1920, y = r() * 1080;
    return {
      ddd: 0, ind, ty: 4, nm: `Shape ${i}`, sr: 1, ip: 0, op, st: 0,
      ks: {
        o: kfs([[r() * 100], [100], [r() * 100]]),
        r: kfs([[0], [(r() - 0.5) * 360]]),
        p: kfs([[x, y, 0], [x + (r() - 0.5) * 300, y + (r() - 0.5) * 300, 0], [x, y, 0]]),
        a: { a: 0, k: [0, 0, 0] },
        s: kfs([[50, 50, 100], [100 + r() * 50, 100 + r() * 50, 100]]),
      },
      shapes: shapeItems(i),
    };
  };
  const assets: any[] = [];
  const nPre = o.precomps ?? 20;
  for (let k = 0; k < nPre; k++) assets.push({ id: `comp_${k}`, layers: Array.from({ length: 10 }, (_, j) => layer(j, j + 1)) });
  const layers: any[] = [];
  for (let i = 0; i < n; i++) layers.push(layer(i, i + 1));
  for (let k = 0; k < nPre * 5; k++) layers.push({ ddd: 0, ind: n + k + 1, ty: 0, nm: `pre ${k}`, refId: `comp_${k % nPre}`, w: 1920, h: 1080, ip: 0, op, st: -(k % 30), ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [960, 540, 0] }, a: { a: 0, k: [960, 540, 0] }, s: { a: 0, k: [100, 100, 100] } } });
  return { v: '5.7.4', fr, ip: 0, op, w: 1920, h: 1080, nm: 'synthetic', ddd: 0, assets, layers };
}

/** figma kiwi message (already decoded): frames with nested auto-layout-ish children, text, vectors and instances */
export function syntheticFigma(o: { frames?: number; perFrame?: number; seed?: number } = {}): any {
  const r = rnd(o.seed ?? 9);
  const frames = o.frames ?? 50, per = o.perFrame ?? 100;
  let id = 100;
  const g = (localID: number) => ({ sessionID: 1, localID });
  const tr = (x: number, y: number, deg = 0) => { const a = deg * Math.PI / 180; return { m00: Math.cos(a), m01: -Math.sin(a), m02: x, m10: Math.sin(a), m11: Math.cos(a), m12: y }; };
  const solid = () => ({ type: 'SOLID', color: { r: r(), g: r(), b: r(), a: 1 }, opacity: 1, visible: true });
  const blobs: { bytes: Uint8Array }[] = [];
  const pathBlob = () => {
    const cmds: [number, ...number[]][] = [[1, 0, 0]];
    for (let k = 0; k < 8; k++) cmds.push([4, r() * 40, r() * 40, r() * 40, r() * 40, r() * 40, r() * 40]);
    cmds.push([0]);
    let len = 0; for (const c of cmds) len += 1 + (c.length - 1) * 4;
    const out = new Uint8Array(len); const v = new DataView(out.buffer); let off = 0;
    for (const c of cmds) { out[off++] = c[0]; for (let i = 1; i < c.length; i++) { v.setFloat32(off, c[i], true); off += 4; } }
    blobs.push({ bytes: out });
    return blobs.length - 1;
  };
  const pos = (i: number) => String.fromCharCode(33 + (i % 90)) + String.fromCharCode(33 + Math.floor(i / 90));
  const nodes: any[] = [
    { guid: g(0), type: 'DOCUMENT', name: 'Document' },
    { guid: g(1), type: 'CANVAS', name: 'Page 1', parentIndex: { guid: g(0), position: '!' } },
    { guid: g(2), type: 'CANVAS', name: 'Internal Only Canvas', internalOnly: true, parentIndex: { guid: g(0), position: '"' } },
    { guid: g(3), type: 'SYMBOL', name: 'Chip', parentIndex: { guid: g(2), position: '!' }, size: { x: 80, y: 24 }, transform: tr(0, 0), fillPaints: [solid()], cornerRadius: 12 },
    { guid: g(4), type: 'TEXT', name: 'Label', parentIndex: { guid: g(3), position: '!' }, size: { x: 80, y: 24 }, transform: tr(0, 0), fillPaints: [solid()], textData: { characters: 'Chip' }, fontSize: 12, fontName: { family: 'Inter', style: 'Medium', postscript: '' } },
  ];
  for (let f = 0; f < frames; f++) {
    const fid = id++;
    nodes.push({ guid: g(fid), type: 'FRAME', name: `Screen ${f}`, parentIndex: { guid: g(1), position: pos(f) }, size: { x: 390, y: 844 }, transform: tr((f % 10) * 420, Math.floor(f / 10) * 900), fillPaints: [solid()], cornerRadius: 24, visible: true, opacity: 1 });
    let sub = fid;
    for (let i = 0; i < per; i++) {
      const nid = id++;
      const kind = i % 10;
      const parent = i % 20 === 0 ? fid : sub;
      const base = { guid: g(nid), parentIndex: { guid: g(parent), position: pos(i) }, transform: tr(r() * 300, r() * 700, kind === 7 ? (r() - 0.5) * 30 : 0), visible: true, opacity: 0.5 + r() * 0.5 };
      if (kind === 0) { nodes.push({ ...base, type: 'FRAME', name: `Row ${i}`, size: { x: 350, y: 60 }, fillPaints: [solid()], cornerRadius: 8 }); sub = nid; }
      else if (kind === 1 || kind === 2) nodes.push({ ...base, type: 'RECTANGLE', name: `Rect ${i}`, size: { x: 20 + r() * 200, y: 10 + r() * 60 }, fillPaints: [solid()], cornerRadius: r() * 10 });
      else if (kind === 3) nodes.push({ ...base, type: 'ELLIPSE', name: `Avatar ${i}`, size: { x: 40, y: 40 }, fillPaints: [{ type: 'GRADIENT_LINEAR', opacity: 1, visible: true, stops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 }], transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 } }] });
      else if (kind === 4 || kind === 5) nodes.push({ ...base, type: 'TEXT', name: `Text ${i}`, size: { x: 200, y: 20 }, fillPaints: [solid()], textData: { characters: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${i}` }, fontSize: 12 + (i % 4) * 4, fontName: { family: 'Inter', style: i % 2 ? 'Bold' : 'Regular', postscript: '' } });
      else if (kind === 6 || kind === 7) nodes.push({ ...base, type: 'VECTOR', name: `Icon ${i}`, size: { x: 40, y: 40 }, fillPaints: [solid()], strokePaints: [solid()], strokeWeight: 1.5, fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: pathBlob(), styleID: 0 }] });
      else nodes.push({ ...base, type: 'INSTANCE', name: `Chip ${i}`, size: { x: 80, y: 24 }, symbolData: { symbolID: g(3), symbolOverrides: [] } });
    }
  }
  return { type: 'NODE_CHANGES', nodeChanges: nodes, blobs };
}

export const SCENES = { springs, nested, precomps, textAnim, pathMorph, expressions, rasters, masksBlend, overdraw, mixed };
export type SceneName = keyof typeof SCENES;
