// export parity scenes: small, deterministic projects that exercise every layer type, paint,
// effect, mask, blend mode, text feature, expression and timing edge case. used by
// scripts/export-parity.mjs (rendered in the editor vs every export path) and by unit tests
// (lottie preflight / bake decisions). pure model code: runs in node and in the browser.

import { createComp, createLayer, createProject, uid, type Asset, type BlendMode, type Composition, type Keyframe, type Layer, type PathCmd, type Project } from '../../src/core/model';
import { BLEND_MODES } from '../../src/core/model';
import { TEXT_ANIM_PRESETS } from '../../src/core/presets';
import { makeShaderAsset, initialProps, shaderAssetKey } from '../../src/core/shaders';
import { TEST_EFFECT_FEATURES, TEST_EFFECT_MAIN, TEST_FILL_FEATURES, TEST_FILL_MAIN } from '../shader-fixtures';
import { zlibSync } from 'fflate';

export interface ParityScene {
  id: string;
  title: string;
  /** part of the quick (CI) subset */
  quick?: boolean;
  /** export frame rate when it differs from the comp (fps conversion) */
  exportFps?: number;
  /** what the scene is about (report grouping) */
  tags: string[];
  build: () => Project;
}

type C4 = [number, number, number, number];

function ctx(name: string, w = 240, h = 160, fps = 30, duration = 1.5, bg: C4 = [0.07, 0.07, 0.08, 1]) {
  const p = createProject(name);
  const comp = p.comps[p.activeComp];
  Object.assign(comp, { width: w, height: h, fps, duration, background: bg });
  const add = (l: Layer, parent: Layer | null = null, root?: string[]) => {
    p.layers[l.id] = l;
    if (parent) { l.parent = parent.id; parent.children.push(l.id); } else (root ?? comp.root).push(l.id);
    return l;
  };
  return { p, comp, add };
}

const kf = (t: number, v: number[], ease: Partial<Keyframe> = {}): Keyframe => ({ t, v, interp: 'bezier', out: [0.333, 0], in: [0.667, 1], ...ease });
const lin = (t: number, v: number[]): Keyframe => ({ t, v, interp: 'linear', out: [0, 0], in: [1, 1] });

function star(cx: number, cy: number, ro: number, ri: number, n: number): PathCmd[] {
  const cmds: PathCmd[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? ri : ro;
    cmds.push([i ? 'L' : 'M', cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  cmds.push(['Z']);
  return cmds;
}

function pathLayer(cmds: PathCmd[], w: number, h: number, init: Parameters<typeof createLayer>[1] = {}) {
  const l = createLayer('path', { w, h, ...init });
  l.geometry = [{ cmds, fillRule: 'nonzero' }];
  l.geomSize = [w, h];
  return l;
}

function text(content: string, init: Parameters<typeof createLayer>[1] & { font?: Partial<NonNullable<Layer['text']>> } = {}) {
  const { font, ...rest } = init;
  const l = createLayer('text', { w: 200, h: 40, color: [1, 1, 1, 1], ...rest });
  l.text = { content, fontFamily: 'Inter', fontSize: 20, fontWeight: 600, lineHeight: 1.2, letterSpacing: 0, align: 'left', ...font };
  return l;
}

// ---------------- generated assets (no binary fixtures) ----------------

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function b64(u: Uint8Array) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u).toString('base64');
  let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

/** rgba png (straight alpha) as a data url */
export function pngDataUrl(w: number, h: number, px: (x: number, y: number) => C4): string {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const c = px(x, y), o = y * (w * 4 + 1) + 1 + x * 4;
      for (let k = 0; k < 4; k++) raw[o + k] = Math.round(Math.max(0, Math.min(1, c[k])) * 255);
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0))];
  const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  return 'data:image/png;base64,' + b64(all);
}

function imageAsset(w = 64, h = 48): Asset {
  // a colour wheel quadrant pattern with a soft alpha edge: shows resampling, colour and alpha errors
  const data = pngDataUrl(w, h, (x, y) => {
    const u = x / (w - 1), v = y / (h - 1);
    const check = ((x >> 3) + (y >> 3)) & 1;
    const a = Math.min(1, Math.min(x, y, w - 1 - x, h - 1 - y) / 4);
    return [u, check ? 0.8 : 0.2, v, a];
  });
  return { id: uid('a'), kind: 'image', mime: 'image/png', data, width: w, height: h };
}

/** mono 16-bit wav with 2 ms clicks at the given times (seconds) */
export function clickWav(duration: number, clicks: number[], sr = 48000): string {
  const n = Math.round(duration * sr);
  const buf = new Uint8Array(44 + n * 2), dv = new DataView(buf.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (const c of clicks) {
    const s0 = Math.round(c * sr);
    for (let i = 0; i < sr * 0.002 && s0 + i < n; i++) dv.setInt16(44 + (s0 + i) * 2, Math.round(Math.sin(i / sr * 2 * Math.PI * 3000) * 28000), true);
  }
  return 'data:audio/wav;base64,' + b64(buf);
}

/** frame index barcode: 7 cells whose fill is hold-keyed per frame to the bits of the frame index
 *  (plus a parity cell): any decoded frame tells which editor frame it shows */
function barcode(add: (l: Layer) => Layer, comp: Composition, y = 0, cell = 0) {
  const fps = comp.fps, n = Math.round(comp.duration * fps), bits = 7;
  const cw = cell || Math.floor(comp.width / (bits + 1)), ch = Math.max(10, Math.floor(comp.height / 8));
  for (let b = 0; b <= bits; b++) {
    const l = add(createLayer('rect', { x: b * cw, y, w: cw, h: ch, color: [0, 0, 0, 1], name: b === bits ? 'parity' : `bit${b}` }));
    const keys: Keyframe[] = [];
    let prev = -1;
    for (let f = 0; f < n; f++) {
      const on = b === bits ? (popcount(f) & 1) : (f >> b) & 1;
      if (on === prev) continue;
      prev = on;
      keys.push({ t: f / fps, v: on ? [1, 1, 1, 1] : [0, 0, 0, 1], interp: 'hold', out: [0, 0], in: [1, 1] });
    }
    l.props.fill = { v: keys[0].v, kf: keys.length > 1 ? keys : undefined };
  }
  return { cw, ch, bits };
}
const popcount = (x: number) => { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; };
/** where the barcode cells are (for decoders) */
export function barcodeLayout(w: number, h: number) { const bits = 7; return { cw: Math.floor(w / (bits + 1)), ch: Math.max(10, Math.floor(h / 8)), bits }; }

// ---------------- scenes ----------------

export const SCENES: ParityScene[] = [
  {
    id: 'timing', title: 'Frame barcode (30 fps)', quick: true, tags: ['timing'],
    build: () => {
      const { p, comp, add } = ctx('timing', 240, 160, 30, 2);
      barcode(add, comp);
      const r = add(createLayer('rect', { x: 20, y: 60, w: 40, h: 40, color: [1, 0.5, 0.1, 1] }));
      r.props.position = { v: [40, 80], kf: [lin(0, [40, 80]), lin(2, [200, 80])] };
      return p;
    },
  },
  {
    id: 'timing-24to30', title: 'Frame barcode, 24 fps comp exported at 30 fps', tags: ['timing', 'fps'], exportFps: 30,
    build: () => { const { p, comp, add } = ctx('timing-24', 240, 160, 24, 2); barcode(add, comp); return p; },
  },
  {
    id: 'timing-60', title: 'Frame barcode (60 fps, odd size 211×117)', tags: ['timing', 'fps', 'size'],
    build: () => {
      const { p, comp, add } = ctx('timing-60', 211, 117, 60, 1);
      barcode(add, comp);
      const e = add(createLayer('ellipse', { x: 10, y: 40, w: 50, h: 50, color: [0.3, 0.8, 0.4, 1] }));
      e.props.rotation = { v: [0], kf: [kf(0, [0]), kf(1, [360])] };
      e.props.position = { v: [35, 65], kf: [kf(0, [35, 65]), kf(1, [180, 70])] };
      return p;
    },
  },
  {
    id: 'timing-12', title: 'Frame barcode (12 fps, 3 s)', tags: ['timing', 'fps'],
    build: () => { const { p, comp, add } = ctx('timing-12', 160, 96, 12, 3); barcode(add, comp); return p; },
  },
  {
    id: 'colour', title: 'Colour chart (flat patches)', quick: true, tags: ['colour'],
    build: () => {
      const { p, add } = ctx('colour', 256, 160, 30, 0.5, [0.5, 0.5, 0.5, 1]);
      const cols: C4[] = [
        [1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1], [1, 1, 0, 1], [0, 1, 1, 1], [1, 0, 1, 1], [1, 1, 1, 1], [0, 0, 0, 1],
        [0.8, 0.3, 0.2, 1], [0.2, 0.6, 0.9, 1], [0.95, 0.85, 0.7, 1], [0.1, 0.1, 0.12, 1], [0.25, 0.25, 0.25, 1], [0.5, 0.5, 0.5, 1], [0.75, 0.75, 0.75, 1], [0.42, 0.55, 1, 1],
      ];
      cols.forEach((c, i) => add(createLayer('rect', { x: (i % 8) * 32, y: Math.floor(i / 8) * 80, w: 32, h: 80, color: c, name: `patch${i}` })));
      return p;
    },
  },
  {
    id: 'shapes', title: 'Rect / ellipse / path / strokes, animated transforms', quick: true, tags: ['shapes', 'transform'],
    build: () => {
      const { p, add } = ctx('shapes');
      const r = add(createLayer('rect', { x: 20, y: 20, w: 70, h: 50, color: [0.42, 0.55, 1, 1] }));
      r.props.radius = { v: [12, 12, 12, 12] };
      r.props.strokeWidth = { v: [4] }; r.props.stroke = { v: [1, 1, 1, 1] };
      r.props.rotation = { v: [0], kf: [kf(0, [0]), kf(1.5, [90])] };
      r.props.scale = { v: [100, 100], kf: [kf(0, [100, 100]), kf(0.75, [140, 80]), kf(1.5, [100, 100])] };
      const e = add(createLayer('ellipse', { x: 140, y: 20, w: 70, h: 70, color: [1, 0.4, 0.3, 1] }));
      e.props.opacity = { v: [100], kf: [kf(0, [100]), kf(1.5, [20])] };
      e.props.position = { v: [175, 55], kf: [{ ...kf(0, [175, 55]), sOut: [0, 60] }, { ...kf(1.5, [175, 110]), sIn: [40, 0] }] };
      const s = add(pathLayer(star(40, 40, 38, 16, 5), 80, 80, { x: 80, y: 75, color: [1, 0.85, 0.2, 1] }));
      s.props.strokeWidth = { v: [3] }; s.props.stroke = { v: [0.1, 0.1, 0.1, 1] };
      s.strokeJoin = 'miter'; s.strokeCap = 'butt';
      const open = add(pathLayer([['M', 0, 30], ['C', 20, -10, 40, 70, 60, 30], ['L', 90, 30]], 90, 60, { x: 140, y: 95, color: [0, 0, 0, 0] }));
      open.props.strokeWidth = { v: [6] }; open.props.stroke = { v: [0.4, 1, 0.6, 1] }; open.strokeCap = 'round';
      open.dash = [10, 6];
      return p;
    },
  },
  {
    id: 'paints', title: 'Linear / radial / angular / diamond gradients, image fill, noise', quick: true, tags: ['paints'],
    build: () => {
      const { p, add } = ctx('paints');
      const stops = [{ pos: 0, color: [1, 0.2, 0.3, 1] as C4 }, { pos: 0.5, color: [0.2, 0.4, 1, 0.8] as C4 }, { pos: 1, color: [0.2, 1, 0.5, 1] as C4 }];
      const mk = (type: 'linear' | 'radial' | 'angular' | 'diamond', x: number, y: number, rot = 0) => {
        const l = add(createLayer('rect', { x, y, w: 70, h: 60, name: type }));
        const c = Math.cos(rot), s = Math.sin(rot);
        l.paints = [{ type, stops, transform: [c, s, -s, c, 0.5 - 0.5 * c + 0.5 * s, 0.5 - 0.5 * s - 0.5 * c] }];
        return l;
      };
      mk('linear', 5, 5, 0.4); mk('radial', 85, 5); mk('angular', 165, 5); mk('diamond', 5, 90);
      const img = imageAsset();
      p.assets[img.id] = img;
      const f = add(createLayer('ellipse', { x: 85, y: 90, w: 70, h: 60, name: 'image fill' }));
      f.paints = [{ type: 'image', imageRef: img.id, scaleMode: 'fill' }];
      const n = add(createLayer('rect', { x: 165, y: 90, w: 70, h: 60, color: [0.2, 0.2, 0.3, 1], name: 'noise' }));
      n.paints = [{ type: 'solid', color: [0.2, 0.2, 0.3, 1] }, { type: 'noise', noise: { mode: 'mono', size: 2, density: 0.5, color: [1, 1, 1, 0.6], seed: 3 } }];
      return p;
    },
  },
  {
    id: 'images', title: 'Image layer, scaled / rotated / faded', tags: ['image'],
    build: () => {
      const { p, add } = ctx('images');
      const img = imageAsset(96, 64);
      p.assets[img.id] = img;
      const l = add(createLayer('image', { x: 30, y: 30, w: 96, h: 64, imageRef: img.id }));
      l.props.rotation = { v: [0], kf: [kf(0, [-10]), kf(1.5, [25])] };
      l.props.scale = { v: [100, 100], kf: [kf(0, [100, 100]), kf(1.5, [150, 150])] };
      const l2 = add(createLayer('image', { x: 140, y: 80, w: 80, h: 53, imageRef: img.id }));
      l2.props.opacity = { v: [60] };
      return p;
    },
  },
  {
    id: 'effects', title: 'Drop / inner shadow, layer blur, background blur, noise effect', quick: true, tags: ['effects'],
    build: () => {
      const { p, add } = ctx('effects', 240, 160, 30, 1, [0.9, 0.9, 0.92, 1]);
      const stripes = add(createLayer('rect', { x: 0, y: 70, w: 240, h: 20, color: [0.1, 0.3, 0.9, 1] }));
      void stripes;
      const a = add(createLayer('rect', { x: 15, y: 20, w: 60, h: 50, color: [1, 0.5, 0.2, 1], name: 'drop shadow' }));
      a.effects = [{ type: 'dropShadow', color: [0, 0, 0, 0.5], offset: [4, 6], radius: 8, spread: 0 }];
      a.props.shadowOffset = { v: [4, 6], kf: [kf(0, [0, 0]), kf(1, [6, 10])] };
      const b = add(createLayer('ellipse', { x: 90, y: 20, w: 60, h: 60, color: [0.3, 0.8, 0.5, 1], name: 'inner shadow' }));
      b.effects = [{ type: 'innerShadow', color: [0, 0, 0, 0.6], offset: [3, 3], radius: 6, spread: 0 }];
      const c = add(createLayer('rect', { x: 165, y: 20, w: 60, h: 50, color: [0.6, 0.2, 0.8, 1], name: 'layer blur' }));
      c.effects = [{ type: 'layerBlur', radius: 6 }];
      const d = add(createLayer('rect', { x: 30, y: 95, w: 90, h: 50, color: [1, 1, 1, 0.3], name: 'background blur' }));
      d.effects = [{ type: 'backgroundBlur', radius: 10 }];
      const e = add(createLayer('rect', { x: 140, y: 95, w: 80, h: 50, color: [0.2, 0.5, 0.9, 1], name: 'noise effect' }));
      e.effects = [{ type: 'noise', noise: { mode: 'mono', size: 2, density: 0.6, color: [0, 0, 0, 0.5], seed: 1 } }];
      return p;
    },
  },
  {
    id: 'shaders', title: 'Shader fill (animated) + shader effect (test shaders)', quick: true, tags: ['shaders'],
    build: () => {
      const { p, add } = ctx('shaders', 240, 160, 30, 1);
      const fillA = makeShaderAsset({ id: 'test-stripes', kind: 'fill', files: { 'main.ts': TEST_FILL_MAIN, 'features.json': TEST_FILL_FEATURES } });
      const fxA = makeShaderAsset({ id: 'test-invert', kind: 'effect', files: { 'main.ts': TEST_EFFECT_MAIN, 'features.json': TEST_EFFECT_FEATURES } });
      const fk = shaderAssetKey(fillA), ek = shaderAssetKey(fxA);
      p.shaders = { [fk]: fillA, [ek]: fxA };
      const a = add(createLayer('rect', { x: 15, y: 20, w: 100, h: 120, name: 'shader fill' }));
      a.paints = [{ type: 'shader', shader: { slot: 'f0', shader: fk } }];
      Object.assign(a.props, initialProps(fillA, 'f0', { speed: 1, transform: { x: 50, y: 50, radius: 12, angle: 30 } }));
      const b = add(createLayer('ellipse', { x: 130, y: 30, w: 90, h: 90, color: [1, 0.8, 0.2, 1], name: 'shader effect' }));
      b.shaderEffects = [{ slot: 'e0', shader: ek }];
      Object.assign(b.props, initialProps(fxA, 'e0', { amount: 100 }));
      return p;
    },
  },
  {
    id: 'masks', title: 'Alpha / luminance / vector masks, clip group', quick: true, tags: ['masks'],
    build: () => {
      const { p, add } = ctx('masks');
      const mk = (x: number, type: 'alpha' | 'luminance' | 'vector') => {
        const g = add(createLayer('group', { x, y: 10, w: 70, h: 70, name: `mask ${type}` }));
        const m = add(createLayer('ellipse', { x: 5, y: 5, w: 60, h: 60, color: type === 'luminance' ? [0.5, 0.5, 0.5, 1] : [1, 1, 1, 0.6], name: 'mask' }), g);
        m.mask = true; m.maskType = type;
        const r = add(createLayer('rect', { x: 0, y: 0, w: 70, h: 70, color: [1, 0.3, 0.2, 1] }), g);
        r.props.position = { v: [35, 35], kf: [kf(0, [25, 35]), kf(1.5, [45, 35])] };
        add(createLayer('rect', { x: 30, y: 0, w: 15, h: 70, color: [0.2, 0.3, 1, 1] }), g);
      };
      mk(5, 'alpha'); mk(85, 'luminance'); mk(165, 'vector');
      const clip = add(createLayer('group', { x: 60, y: 90, w: 120, h: 60, name: 'clip group' }));
      clip.clip = true;
      clip.props.fill = { v: [0.2, 0.2, 0.25, 1] };
      const e = add(createLayer('ellipse', { x: -20, y: -10, w: 80, h: 80, color: [0.4, 1, 0.6, 1] }), clip);
      e.props.position = { v: [20, 30], kf: [kf(0, [20, 30]), kf(1.5, [110, 30])] };
      return p;
    },
  },
  {
    id: 'blend', title: 'All 18 blend modes over a gradient backdrop', quick: true, tags: ['blend'],
    build: () => {
      const { p, add } = ctx('blend', 288, 160, 30, 0.5);
      const bd = add(createLayer('rect', { x: 0, y: 0, w: 288, h: 160, name: 'backdrop' }));
      bd.paints = [{ type: 'linear', stops: [{ pos: 0, color: [0.1, 0.2, 0.8, 1] }, { pos: 0.5, color: [0.9, 0.9, 0.2, 1] }, { pos: 1, color: [0.8, 0.1, 0.3, 1] }], transform: [1, 0, 0, 1, 0, 0] }];
      BLEND_MODES.forEach((m: BlendMode, i) => {
        const l = add(createLayer('ellipse', { x: (i % 6) * 48 + 4, y: Math.floor(i / 6) * 52 + 6, w: 40, h: 40, color: [0.9, 0.4, 0.2, 0.85], name: m }));
        l.blend = m;
      });
      return p;
    },
  },
  {
    id: 'group-opacity', title: 'Group opacity (isolated), nested parents, precomp-free hierarchy', quick: true, tags: ['groups', 'transform'],
    build: () => {
      const { p, add } = ctx('groups');
      const g = add(createLayer('group', { x: 20, y: 20, w: 120, h: 120, name: 'faded group' }));
      g.props.opacity = { v: [50], kf: [kf(0, [100]), kf(1.5, [40])] };
      g.props.rotation = { v: [0], kf: [kf(0, [0]), kf(1.5, [20])] };
      add(createLayer('rect', { x: 10, y: 10, w: 70, h: 70, color: [1, 0.4, 0.2, 1] }), g);
      const inner = add(createLayer('group', { x: 40, y: 40, w: 70, h: 70, name: 'inner' }), g);
      inner.props.scale = { v: [100, 100], kf: [kf(0, [100, 100]), kf(1.5, [70, 70])] };
      add(createLayer('ellipse', { x: 0, y: 0, w: 70, h: 70, color: [0.2, 0.6, 1, 1] }), inner);
      const fg = add(createLayer('group', { x: 150, y: 30, w: 80, h: 100, name: 'filled group' }));
      fg.props.fill = { v: [0.9, 0.9, 0.9, 1] }; fg.props.radius = { v: [10, 10, 10, 10] };
      add(createLayer('rect', { x: 10, y: 10, w: 60, h: 30, color: [0.1, 0.7, 0.4, 1] }), fg);
      return p;
    },
  },
  {
    id: 'text', title: 'Text: weights, italic, alignment, wrapping, spacing, case, runs, decoration', quick: true, tags: ['text'],
    build: () => {
      const { p, add } = ctx('text', 320, 200, 30, 1);
      add(text('Regular 400 Inter', { x: 8, y: 6, w: 300, h: 24, font: { fontWeight: 400, fontSize: 18 } }));
      add(text('Black 900 · spaced', { x: 8, y: 30, w: 300, h: 24, font: { fontWeight: 900, fontSize: 18, letterSpacing: 2 } }));
      add(text('Centered text wraps onto a second line here', { x: 8, y: 56, w: 150, h: 50, font: { fontWeight: 500, fontSize: 14, align: 'center', autoResize: 'height', lineHeight: 1.4 } }));
      add(text('right · underline', { x: 170, y: 56, w: 140, h: 22, font: { fontWeight: 400, fontSize: 14, align: 'right', decoration: 'underline' } }));
      add(text('upper case', { x: 170, y: 80, w: 140, h: 22, font: { fontWeight: 700, fontSize: 14, textCase: 'upper' } }));
      const runs = add(text('Mixed runs bold red', { x: 8, y: 112, w: 300, h: 26, font: { fontWeight: 400, fontSize: 18 } }));
      runs.text!.runs = [{ start: 6, end: 10, fontWeight: 800 }, { start: 16, end: 19, fill: [1, 0.3, 0.3, 1] }];
      add(text('Italic serif fallback', { x: 8, y: 140, w: 300, h: 26, font: { fontFamily: 'serif', fontStyle: 'italic', fontWeight: 400, fontSize: 18 } }));
      const t = add(text('Fade me', { x: 200, y: 160, w: 110, h: 30, font: { fontWeight: 700, fontSize: 22 } }));
      t.props.opacity = { v: [100], kf: [kf(0, [0]), kf(1, [100])] };
      t.props.fill = { v: [1, 1, 1, 1], kf: [kf(0, [1, 0.8, 0.2, 1]), kf(1, [0.3, 0.9, 1, 1])] };
      return p;
    },
  },
  {
    id: 'text-anim', title: 'Text animators (per letter / word)', tags: ['text', 'textAnim'],
    build: () => {
      const { p, add } = ctx('text-anim', 320, 120, 30, 1.5);
      const a = add(text('Pop letters', { x: 10, y: 10, w: 300, h: 40, font: { fontSize: 30, fontWeight: 800 } }));
      a.textAnim = { ...TEXT_ANIM_PRESETS.find(x => x.name === 'Pop letters')!.anim, start: 0 };
      const b = add(text('Slide the words in', { x: 10, y: 65, w: 300, h: 40, font: { fontSize: 24, fontWeight: 600 } }));
      b.textAnim = { ...TEXT_ANIM_PRESETS.find(x => x.name === 'Slide words')!.anim, start: 0.2 };
      return p;
    },
  },
  {
    id: 'expressions', title: 'Expressions: wiggle (seeded), random, time, loopOut', quick: true, tags: ['expressions'],
    build: () => {
      const { p, add } = ctx('expr', 240, 160, 30, 2);
      const a = add(createLayer('rect', { x: 30, y: 30, w: 40, h: 40, color: [1, 0.5, 0.2, 1], name: 'wiggle' }));
      a.props.position = { v: [50, 50], expr: 'wiggle(3, 25)' };
      const b = add(createLayer('ellipse', { x: 140, y: 30, w: 40, h: 40, color: [0.2, 0.7, 1, 1], name: 'time' }));
      b.props.rotation = { v: [0], expr: 'time * 180' };
      b.props.scale = { v: [100, 100], expr: '[100 + Math.sin(time * 6) * 30, 100]' };
      const c = add(createLayer('rect', { x: 30, y: 100, w: 30, h: 30, color: [0.4, 1, 0.5, 1], name: 'loop' }));
      c.props.position = { v: [45, 115], kf: [kf(0, [45, 115]), kf(0.5, [120, 115])], expr: "loopOut('pingpong')" };
      const d = add(createLayer('rect', { x: 180, y: 100, w: 30, h: 30, color: [1, 1, 1, 1], name: 'random' }));
      d.props.opacity = { v: [100], expr: 'random(20, 100)' };
      return p;
    },
  },
  {
    id: 'springs', title: 'Springs (bounce) on position / scale / rotation', quick: true, tags: ['springs'],
    build: () => {
      const { p, add } = ctx('springs', 240, 160, 60, 1.5);
      const a = add(createLayer('rect', { x: 20, y: 50, w: 50, h: 50, color: [1, 0.5, 0.2, 1] }));
      a.props.position = { v: [45, 75], kf: [{ ...kf(0, [45, 75]), interp: 'spring', bounce: 0.6 }, kf(1, [190, 75])] };
      a.props.rotation = { v: [0], kf: [{ ...kf(0.2, [0]), interp: 'spring', bounce: 0.3 }, kf(1.2, [180])] };
      const b = add(createLayer('ellipse', { x: 100, y: 110, w: 40, h: 40, color: [0.3, 0.7, 1, 1] }));
      b.props.scale = { v: [100, 100], kf: [{ ...kf(0, [20, 20]), interp: 'spring', bounce: 0.8 }, kf(1.3, [100, 100])] };
      return p;
    },
  },
  {
    id: 'precomp', title: 'Precomp with start offset, nested twice', quick: true, tags: ['precomp'],
    build: () => {
      const { p, add } = ctx('precomp', 240, 160, 30, 2);
      const inner = createComp({ name: 'inner', width: 100, height: 100, fps: 30, duration: 2, background: [0, 0, 0, 0] });
      p.comps[inner.id] = inner;
      const r = add(createLayer('rect', { x: 10, y: 10, w: 40, h: 40, color: [1, 0.5, 0.2, 1] }), null, inner.root);
      r.props.position = { v: [30, 30], kf: [kf(0, [30, 30]), kf(1, [70, 70])] };
      r.props.rotation = { v: [0], kf: [kf(0, [0]), kf(1, [180])] };
      const a = add(createLayer('precomp', { x: 10, y: 30, w: 100, h: 100, compRef: inner.id, name: 'pc a' }));
      a.startTime = 0;
      const b = add(createLayer('precomp', { x: 130, y: 30, w: 100, h: 100, compRef: inner.id, name: 'pc b (offset 0.5s)' }));
      b.startTime = 0.5;
      b.props.opacity = { v: [70] };
      return p;
    },
  },
  {
    id: 'trim', title: 'Trim paths (animated) and path morph', quick: true, tags: ['trim', 'paths'],
    build: () => {
      const { p, add } = ctx('trim', 240, 160, 30, 1.5);
      const t = add(pathLayer([['M', 10, 60], ['C', 40, 0, 80, 120, 110, 60], ['C', 130, 20, 150, 20, 170, 60]], 180, 120, { x: 30, y: 10, color: [0, 0, 0, 0] }));
      t.props.strokeWidth = { v: [6] }; t.props.stroke = { v: [1, 0.6, 0.2, 1] }; t.strokeCap = 'round';
      t.trimOn = true;
      t.props.trimEnd = { v: [100], kf: [kf(0, [0]), kf(1.2, [100])] };
      t.props.trimStart = { v: [0], kf: [kf(0.3, [0]), kf(1.5, [40])] };
      const m = add(pathLayer(star(30, 30, 28, 12, 5), 60, 60, { x: 90, y: 95, color: [0.3, 0.8, 1, 1], name: 'morph' }));
      const g2 = star(30, 30, 28, 24, 5);
      m.pathKf = [
        { t: 0, geometry: [{ cmds: star(30, 30, 28, 12, 5), fillRule: 'nonzero' }], interp: 'bezier', out: [0.333, 0], in: [0.667, 1] },
        { t: 1.5, geometry: [{ cmds: g2, fillRule: 'nonzero' }], interp: 'bezier', out: [0.333, 0], in: [0.667, 1] },
      ];
      return p;
    },
  },
  {
    id: 'transparent', title: 'Transparent background, semi-transparent layers', quick: true, tags: ['alpha'],
    build: () => {
      const { p, add } = ctx('transparent', 240, 160, 30, 1, [0, 0, 0, 0]);
      add(createLayer('rect', { x: 20, y: 20, w: 100, h: 80, color: [1, 0.3, 0.2, 0.5] }));
      const e = add(createLayer('ellipse', { x: 90, y: 50, w: 100, h: 90, color: [0.2, 0.5, 1, 0.8] }));
      e.props.opacity = { v: [100], kf: [kf(0, [100]), kf(1, [30])] };
      add(createLayer('rect', { x: 170, y: 10, w: 60, h: 60, color: [1, 1, 1, 1] }));
      return p;
    },
  },
  {
    id: 'audio', title: 'Audio clicks (offset 0.25 s) + flash frames', quick: true, tags: ['audio', 'timing'],
    build: () => {
      const { p, comp, add } = ctx('audio', 160, 96, 30, 2);
      barcode(add, comp);
      const asset: Asset = { id: uid('a'), kind: 'audio', mime: 'audio/wav', data: clickWav(1.5, [0.25, 0.75, 1.25]), width: 0, height: 0 };
      p.assets[asset.id] = asset;
      const a = add(createLayer('audio', { w: 0, h: 0, name: 'clicks' }));
      a.imageRef = asset.id; a.startTime = 0.25; a.volume = 1;
      // audio-reactive: reads the comp's music analysis (0 when the clip is not detected as music)
      const r = add(createLayer('ellipse', { x: 60, y: 40, w: 40, h: 40, color: [1, 0.6, 0.2, 1], name: 'audio reactive' }));
      r.props.scale = { v: [100, 100], expr: "[100 + audio('amp') * 80, 100 + audio('beat') * 80]" };
      return p;
    },
  },
];

/** click times in comp time for the audio scene (startTime 0.25 + clicks at 0.25 / 0.75 / 1.25) */
export const AUDIO_CLICKS = [0.5, 1.0, 1.5];
