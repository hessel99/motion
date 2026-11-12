// export our model to lottie / bodymovin json (v5 schema), built for parity with the editor
// (measured against lottie-web by scripts/export-parity.mjs).
//
// mapping:
//  - comp background  -> a solid layer (ty 1) at the bottom (when not transparent)
//  - rect / ellipse   -> shape layer (ty 4) with one group: rc / el + fl / gf (+ st)
//  - path             -> shape layer with one sh per subpath (animated when the shape is keyframed)
//  - group            -> null layer (ty 3) used as parent (a group with a fill: a shape layer). a group
//                        that composites as a unit (opacity, clip, blend mode) becomes a precomp, like
//                        in after effects: lottie's parenting does not pass opacity on
//  - mask             -> track matte: the masked siblings go into a precomp, the mask is its matte
//  - text             -> text layer (ty 5), box text (glyph outlines added by lottie-glyphs.ts)
//  - image            -> image layer (ty 2) stretched to the layer box
//  - precomp          -> precomp layer (ty 0) with its start offset
//  - expressions      -> baked to keys at every frame from the renderer's own evaluation (no player
//                        runs our expression language, and random seeds differ between players)
//  - springs          -> baked to keys at every frame
//  - anything lottie can't draw (effects, angular / diamond / image / noise gradients, shader
//    paints and effects, inner / outside strokes, text animators, smooth corners …) is reported by
//    lottiePreflight() BEFORE export; by default such a layer is BAKED: rendered by the editor's own
//    renderer into images (one, or one per frame when its content animates) placed in a precomp
//    that keeps the layer's real transform, so it moves exactly like the original
//    (see lottie-bake.ts). an issue the user chose to ignore exports natively, approximated.
//
// a preflight item has a stable id (`${feature}:${layerId}`): the export dialog lists them with
// [Bake] [Ignore], and passes the ignored ids back here.

import { effectivePlay, instancePlan, instanceSpan, resolvedLayers, timeRemapKeys } from '../core/motion-components';
import { springAt } from '../core/easing';
import { evalProp } from '../core/evaluate';
import { BLEND_MODES, type BlendMode, type Composition, type Keyframe, type Layer, type Paint, type PathCmd, type PathGeometry, type Project, type Prop, type PropKey, PROP_DEFS } from '../core/model';

const R = (x: number) => Math.round(x * 1e6) / 1e6;
const WEIGHT_STYLE: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

// ---------------- preflight ----------------

export type LottieFeature =
  | 'effects' | 'background-blur' | 'paint' | 'stroke' | 'shape' | 'text' | 'text-animation' | 'shader'
  | 'path-morph' | 'blend' | 'audio' | 'precomp-size';

export interface LottieIssue {
  /** stable id: `${feature}:${layerId}` */
  id: string;
  layerId: string;
  layer: string;
  feature: LottieFeature;
  /** what will look different */
  message: string;
  /** can it be baked into images (exact) */
  bakeable: boolean;
}

const FEATURE_LABEL: Record<LottieFeature, string> = {
  effects: 'Effects', 'background-blur': 'Background blur', paint: 'Fill', stroke: 'Stroke', shape: 'Shape', text: 'Text',
  'text-animation': 'Text animation', shader: 'Shader', 'path-morph': 'Shape morph', blend: 'Blend mode', audio: 'Audio', 'precomp-size': 'Precomp',
};
export const lottieFeatureLabel = (f: LottieFeature) => FEATURE_LABEL[f];

/** lottie (lottie-web) blend modes: bm index */
const BM: Partial<Record<BlendMode, number>> = {
  normal: 0, multiply: 1, screen: 2, overlay: 3, darken: 4, lighten: 5, colorDodge: 6, colorBurn: 7, hardLight: 8, softLight: 9,
  difference: 10, exclusion: 11, hue: 12, saturation: 13, color: 14, luminosity: 15,
};
void BLEND_MODES;

const visibleEffects = (l: Layer) => (l.effects ?? []).filter(e => e.visible !== false);
const hasEffectProps = (l: Layer, prefix: string) => Object.keys(l.props).some(k => k.startsWith(prefix));

function isUniform(v: number[] | undefined) { return !v || v.every(x => Math.abs(x - v[0]) < 1e-6); }

/** a radial gradient lottie can draw: circular in layer pixels */
function radialCircle(p: Paint, w: number, h: number): boolean {
  const m = p.transform ?? [1, 0, 0, 1, 0, 0];
  const ax = m[0] * w, ay = m[1] * h, bx = m[2] * w, by = m[3] * h;
  return Math.abs(ax * bx + ay * by) < 1e-6 * (w * h + 1) && Math.abs(Math.hypot(ax, ay) - Math.hypot(bx, by)) < 1e-6 * (w + h + 1);
}

/** the single gradient / solid paint of a layer lottie can draw natively, or why not */
function paintSupport(l: Layer): { ok: true; grad: Paint | null } | { ok: false; why: string } {
  const ps = (l.paints ?? []).filter(p => (p.opacity ?? 1) > 0 || p.type === 'shader');
  if (!ps.length) return { ok: true, grad: null };
  if (ps.some(p => p.type === 'shader')) return { ok: false, why: 'shader fill' };
  if (ps.length > 1) return { ok: false, why: `${ps.length} stacked fills` };
  const p = ps[0];
  if (p.blend && p.blend !== 'normal') return { ok: false, why: 'fill blend mode' };
  if (p.type === 'solid') return { ok: true, grad: null };
  if (p.type === 'linear') return { ok: true, grad: p };
  if (p.type === 'radial') {
    const s = l.geomSize ?? l.props.size?.v ?? [100, 100];
    return radialCircle(p, s[0], s[1]) ? { ok: true, grad: p } : { ok: false, why: 'elliptical radial gradient' };
  }
  return { ok: false, why: `${p.type} fill` };
}

function textNeedsBake(l: Layer): string | null {
  const t = l.text;
  if (!t) return null;
  if (t.outline) return null;
  const extra: string[] = [];
  if (t.runs?.length) extra.push('mixed styles');
  if (t.decoration) extra.push(t.decoration === 'underline' ? 'underline' : 'strikethrough');
  if (t.textCase) extra.push('text case');
  if (t.lists?.some(Boolean)) extra.push('lists');
  if (t.maxLines || t.truncate) extra.push('truncation');
  if (t.features?.length || (t.variations && Object.keys(t.variations).length)) extra.push('font features');
  if (t.paragraphSpacing || t.paragraphIndent) extra.push('paragraph spacing');
  if (t.align === 'justify') extra.push('justified');
  if (t.fontFamily !== 'Inter') extra.push(`font "${t.fontFamily}" is not embedded`);
  if (t.fontStyle === 'italic') extra.push('italic');
  return 'Lottie players lay text out themselves (no kerning, their own line breaks)' + (extra.length ? ': ' + extra.join(', ') : '');
}

/** what lottie can't express in one layer (its own features; children are checked on their own) */
export function layerIssues(project: Project, l: Layer): LottieIssue[] {
  const out: LottieIssue[] = [];
  const add = (feature: LottieFeature, message: string, bakeable = true) => out.push({ id: `${feature}:${l.id}`, layerId: l.id, layer: l.name, feature, message, bakeable });
  if (l.type === 'audio') { add('audio', 'Lottie has no audio: this layer is left out', false); return out; }
  const fx = visibleEffects(l);
  const bb = fx.some(e => e.type === 'backgroundBlur') || (l.props.backgroundBlur?.v[0] ?? 0) > 0;
  const other = fx.filter(e => e.type !== 'backgroundBlur');
  const implicit = (['shadowColor', 'innerShadowColor', 'noiseColor'] as const).filter(k => l.props[k] && !fx.some(e => e.type === (k === 'shadowColor' ? 'dropShadow' : k === 'innerShadowColor' ? 'innerShadow' : 'noise')));
  if (other.length || implicit.length || (l.props.blur?.v[0] ?? 0) > 0 || l.props.blur?.kf?.length) add('effects', `${[...new Set(other.map(e => e.type))].join(', ') || 'effects'}: Lottie has no layer effects`);
  if (bb) add('background-blur', 'Background blur needs what is behind the layer: Lottie can\'t show it (baking would freeze the backdrop)', false);
  if (l.shaderEffects?.some(r => r.enabled !== false)) add('shader', 'Shader effects only run in Motion');
  if (l.type !== 'image' && l.type !== 'precomp' && l.type !== 'text') {
    const ps = paintSupport(l);
    if (!ps.ok) add(ps.why === 'shader fill' ? 'shader' : 'paint', `${ps.why}: Lottie can only draw one solid, linear or circular radial fill`);
    const sw = Math.max(l.props.strokeWidth?.v[0] ?? 0, ...(l.props.strokeWidth?.kf ?? []).map(k => k.v[0]));
    const st = l.props.stroke;
    const stroked = sw > 0 && !!st && ((st.v[3] ?? 1) > 0 || !!st.kf?.length);
    if (stroked || l.strokePaints?.length) {
      const why: string[] = [];
      if (l.strokeAlign && l.strokeAlign !== 'center') why.push(`${l.strokeAlign} stroke`);
      if (l.strokePaints?.length) why.push('gradient / image stroke');
      if (l.strokeSides) why.push('individual stroke sides');
      if (l.strokeGeometry && !l.trimOn) why.push('outlined stroke geometry');
      if (why.length) add('stroke', `${why.join(', ')}: Lottie strokes are centered and solid`);
    }
    const shape: string[] = [];
    if ((l.smoothing ?? 0) > 0) shape.push('smooth corners');
    const rad = l.props.radius;
    if ((l.type === 'rect' || l.type === 'group') && rad && (!isUniform(rad.v) || rad.kf?.some(k => !isUniform(k.v)))) shape.push('different corner radii');
    if (l.geometry?.some(g => g.paints)) shape.push('differently filled regions');
    if (shape.length) add('shape', `${shape.join(', ')}: not expressible in Lottie shapes`);
    if (l.type === 'path' && l.pathKf && l.pathKf.length >= 2 && !pathKfCompatible(l)) add('path-morph', 'the shape keys have different point counts: Lottie can only morph matching paths');
  }
  if (l.type === 'text') {
    const why = textNeedsBake(l);
    if (why) add('text', why);
    if (l.textAnim) add('text-animation', 'per letter / word animation is not exported to Lottie text');
  }
  if (l.blend && BM[l.blend] === undefined) add('blend', `blend mode "${l.blend}" doesn't exist in Lottie (exported as normal)`, false);
  if (l.type === 'precomp') {
    const c = l.compRef ? project.comps[l.compRef] : undefined;
    const sz = l.props.size?.v;
    if (c && sz && (Math.abs(sz[0] - c.width) > 0.5 || Math.abs(sz[1] - c.height) > 0.5) && l.props.size?.kf?.length) add('precomp-size', 'animated precomp size: Lottie clips precomps to a fixed box', false);
  }
  return out;
}

/** every layer reachable from the active comp (through groups and precomps) */
function reachable(project: Project): Layer[] {
  const comp = project.comps[project.activeComp] ?? Object.values(project.comps)[0];
  const out: Layer[] = [];
  const seen = new Set<string>();
  const walk = (ids: string[], stack: string[]) => {
    for (const id of ids) {
      const l = project.layers[id];
      if (!l || seen.has(id)) continue;
      seen.add(id);
      out.push(l);
      walk(l.children, stack);
      if (l.type === 'precomp' && l.compRef && !stack.includes(l.compRef) && project.comps[l.compRef]) walk(project.comps[l.compRef].root, [...stack, l.compRef]);
    }
  };
  if (comp) walk(comp.root, [comp.id]);
  return out;
}

/** everything that will look different in Lottie, before exporting (layers inside a layer that
 *  gets baked anyway are not listed) */
export function lottiePreflight(project: Project): LottieIssue[] {
  const all = reachable(project).map(l => ({ l, issues: layerIssues(project, l) }));
  const baked = new Set(all.filter(x => x.issues.some(i => i.bakeable)).map(x => x.l.id));
  const out: LottieIssue[] = [];
  for (const { l, issues } of all) {
    let covered = false;
    for (let p = l.parent ? project.layers[l.parent] : undefined; p; p = p.parent ? project.layers[p.parent] : undefined) if (baked.has(p.id)) { covered = true; break; }
    if (!covered) out.push(...issues);
  }
  return out;
}

// ---------------- bake hooks ----------------

/** evaluated local values of a layer at a comp time (the renderer's own evaluation) */
export interface LayerSample { anchor: number[]; position: number[]; scale: number[]; rotation: number; opacity: number; size: number[]; radius: number[]; fill: number[]; stroke: number[]; strokeWidth: number }

/** a layer to render into images: its subtree, in its own local space, box [x, y, w, h] (layer px),
 *  at `scale` px per layer px, at local times `times` of the comp `compId` it lives in */
export interface BakeRequest { layerId: string; compId: string; box: [number, number, number, number]; scale: number; times: number[]; /** the layers as seen there (component instance values), when they differ from the project's */ layers?: Record<string, Layer> }
/** one image index per requested time + the (deduplicated) png data urls */
export interface BakeResult { frames: number[]; images: string[] }

export interface LottieOptions {
  /** issue ids to export natively (approximated) instead of baking */
  ignore?: Iterable<string>;
  /** renders bake requests (browser: lottie-bake.ts). without it nothing is baked */
  bake?: (req: BakeRequest) => Promise<BakeResult>;
  /** exact evaluation of a layer (expressions). without it expressions export as their keyframed value */
  sample?: (layerId: string, compTime: number) => LayerSample | null;
}

// ---------------- keyframes ----------------

function firstV(p: Prop | undefined, def: number[]): number[] {
  if (!p) return def;
  return p.kf && p.kf.length ? p.kf[0].v : p.v;
}

/** lottie has no springs: bake spring segments into linear keys sampled every frame */
function bakeSprings(kf: Keyframe[], fr: number): Keyframe[] {
  if (!kf.some((k, i) => k.interp === 'spring' && i < kf.length - 1)) return kf;
  const out: Keyframe[] = [];
  for (let i = 0; i < kf.length; i++) {
    const k = kf[i], nx = kf[i + 1];
    if (k.interp !== 'spring' || !nx) { out.push(k); continue; }
    const steps = Math.max(2, Math.round((nx.t - k.t) * fr));
    for (let s2 = 0; s2 < steps; s2++) {
      const p = s2 / steps;
      const e = springAt(k.bounce ?? 0.3, p);
      out.push({ t: k.t + (nx.t - k.t) * p, v: k.v.map((v, d) => v + ((nx.v[d] ?? v) - v) * e), interp: 'linear', out: [0, 0], in: [1, 1] });
    }
  }
  return out;
}

function exportProp(p: Prop | undefined, def: number[], fr: number, conv: (v: number[]) => number[] = v => v, spatial = false): any {
  if (!p) return { a: 0, k: conv(def).map(R) };
  const kf = p.kf ? bakeSprings(p.kf, fr) : p.kf;
  if (!kf || kf.length < 2) {
    const v = conv(kf && kf.length ? kf[0].v : p.v).map(R);
    return { a: 0, k: v.length === 1 ? v[0] : v };
  }
  const k = kf.map((key: Keyframe, i: number) => {
    const nx = kf[i + 1];
    const o: any = { t: R(key.t * fr), s: conv(key.v).map(R) };
    if (key.interp === 'hold') o.h = 1;
    if (key.interp === 'linear') {
      o.o = { x: [0], y: [0] };
      o.i = { x: [1], y: [1] };
    } else {
      o.o = { x: [R(key.out[0])], y: [R(key.out[1])] };
      o.i = nx ? { x: [R(nx.in[0])], y: [R(nx.in[1])] } : { x: [0.667], y: [1] };
    }
    if (spatial && nx && (key.sOut || nx.sIn)) {
      o.to = (key.sOut ?? [0, 0]).slice(0, 2).map(R);
      o.ti = (nx.sIn ?? [0, 0]).slice(0, 2).map(R);
    }
    return o;
  });
  return { a: 1, k };
}

function mapPropValues(p: Prop | undefined, fn: (v: number[]) => number[]): Prop | undefined {
  if (!p) return p;
  return { v: fn(p.v), kf: p.kf?.map(k => ({ ...k, v: fn(k.v) })), expr: p.expr };
}

const IDENTITY_TR = {
  ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 }, nm: 'Transform',
};

// ---------------- paints ----------------

/** our linear / radial paint -> lottie gradient fill (gf) in layer px. linear: the start / end points
 *  are chosen so lottie's (perpendicular) isolines are exactly ours, also for skewed gradients on
 *  non-square boxes */
function gradientItem(l: Layer, p: Paint, box: number[]): any {
  const [W, H] = box;
  const m = p.transform ?? [1, 0, 0, 1, 0, 0];
  const stops = (p.stops ?? []).slice().sort((a, b) => a.pos - b.pos);
  const k: number[] = [];
  for (const st of stops) k.push(R(st.pos), R(st.color[0]), R(st.color[1]), R(st.color[2]));
  for (const st of stops) k.push(R(st.pos), R(st.color[3] ?? 1));
  let s0: number[], e0: number[];
  if (p.type === 'linear') {
    // gradient coordinate g(px) = first row of inverse(m), applied to (px / W, py / H)
    const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
    const ia = m[3] / det, ic = -m[2] / det, ie = (m[2] * m[5] - m[3] * m[4]) / det;
    const gx = ia / W, gy = ic / H, n2 = gx * gx + gy * gy || 1e-12;
    s0 = [-ie * gx / n2, -ie * gy / n2];
    e0 = [s0[0] + gx / n2, s0[1] + gy / n2];
  } else {
    const map = (x: number, y: number) => [(m[0] * x + m[2] * y + m[4]) * W, (m[1] * x + m[3] * y + m[5]) * H];
    s0 = map(0.5, 0.5); e0 = map(1, 0.5);
  }
  return { ty: 'gf', nm: 'Gradient Fill', t: p.type === 'linear' ? 1 : 2, r: l.geometry?.[0]?.fillRule === 'evenodd' ? 2 : 1, o: { a: 0, k: R((p.opacity ?? 1) * 100) }, s: { a: 0, k: s0.map(R) }, e: { a: 0, k: e0.map(R) }, g: { p: stops.length, k: { a: 0, k } }, h: { a: 0, k: 0 }, a: { a: 0, k: 0 } };
}

/** defaults the raster / sdf renderer uses (raster.ts setStrokeStyle) */
const capOf = (l: Layer) => l.strokeCap ?? (l.type === 'path' ? 'round' : 'butt');
const joinOf = (l: Layer) => l.strokeJoin ?? (l.type === 'path' ? 'round' : 'miter');
const LC = { butt: 1, round: 2, square: 3 } as const;
const LJ = { miter: 1, round: 2, bevel: 3 } as const;

function paintItems(l: Layer, fr: number, props: Layer['props']): any[] {
  const out: any[] = [];
  const ps = paintSupport(l);
  const grad = ps.ok ? ps.grad : null;
  const box = l.type === 'path' ? (l.props.size?.v ?? l.geomSize ?? [100, 100]) : firstV(l.props.size, [100, 100]);
  if (grad) out.push(gradientItem(l, grad, box));
  const fill = props.fill;
  const solid = l.paints?.length === 1 && l.paints[0].type === 'solid' ? l.paints[0] : null;
  const fv = firstV(fill, [0, 0, 0, 0]);
  if (!grad && fill && (fill.kf?.length || fv[3] > 0)) {
    const po = solid?.opacity ?? 1;
    out.push({
      ty: 'fl', nm: 'Fill', r: l.geometry?.[0]?.fillRule === 'evenodd' ? 2 : 1,
      c: exportProp(mapPropValues(fill, v => [v[0], v[1], v[2], 1]), [0, 0, 0, 1], fr),
      o: exportProp(mapPropValues(fill, v => [(v[3] ?? 1) * 100 * po]), [100], fr),
    });
  }
  const sw = firstV(props.strokeWidth, [0])[0];
  const st = props.stroke;
  if (st && (sw > 0 || props.strokeWidth?.kf?.length)) {
    const item: any = {
      ty: 'st', nm: 'Stroke', lc: LC[capOf(l)], lj: LJ[joinOf(l)], ml: l.miterLimit ?? 4,
      c: exportProp(mapPropValues(st, v => [v[0], v[1], v[2], 1]), [0, 0, 0, 1], fr),
      o: exportProp(mapPropValues(st, v => [(v[3] ?? 1) * 100]), [100], fr),
      w: exportProp(props.strokeWidth, [0], fr),
    };
    if (l.dash?.length) {
      const d = l.dash.length % 2 ? [...l.dash, ...l.dash] : l.dash;
      item.d = d.map((v, i) => ({ n: i % 2 ? 'g' : 'd', nm: i % 2 ? 'gap' : 'dash', v: { a: 0, k: R(v) } }));
      item.d.push({ n: 'o', nm: 'offset', v: { a: 0, k: 0 } });
    }
    out.push(item);
  }
  // lottie draws the items of a group bottom-up from the END of the list: the stroke goes first so
  // it lies on top of the fill, as in the editor (it used to sit under it: half of it hidden)
  return out.reverse();
}

// ---------------- paths ----------------

/** our path commands -> lottie shape objects (one per subpath) */
export function cmdsToLottieShapes(cmds: PathCmd[], sx = 1, sy = 1): { v: number[][]; i: number[][]; o: number[][]; c: boolean }[] {
  const out: { v: number[][]; i: number[][]; o: number[][]; c: boolean }[] = [];
  let cur: { v: number[][]; i: number[][]; o: number[][]; c: boolean } | null = null;
  let px = 0, py = 0;
  const flush = () => {
    if (!cur || !cur.v.length) return;
    // closed path whose last vertex duplicates the first: merge
    const n = cur.v.length;
    if (cur.c && n > 1) {
      const a = cur.v[0], b = cur.v[n - 1];
      if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) {
        cur.i[0] = cur.i[n - 1];
        cur.v.pop(); cur.i.pop(); cur.o.pop();
      }
    }
    out.push(cur);
  };
  const vtx = (x: number, y: number) => { cur!.v.push([R(x * sx), R(y * sy)]); cur!.i.push([0, 0]); cur!.o.push([0, 0]); };
  for (const c of cmds) {
    switch (c[0]) {
      case 'M':
        flush();
        cur = { v: [], i: [], o: [], c: false };
        vtx(c[1], c[2]); px = c[1]; py = c[2];
        break;
      case 'L':
        if (!cur) { cur = { v: [], i: [], o: [], c: false }; vtx(px, py); }
        vtx(c[1], c[2]); px = c[1]; py = c[2];
        break;
      case 'C': {
        if (!cur) { cur = { v: [], i: [], o: [], c: false }; vtx(px, py); }
        const last = cur.v.length - 1;
        cur.o[last] = [R((c[1] - px) * sx), R((c[2] - py) * sy)];
        vtx(c[5], c[6]);
        cur.i[cur.v.length - 1] = [R((c[3] - c[5]) * sx), R((c[4] - c[6]) * sy)];
        px = c[5]; py = c[6];
        break;
      }
      case 'Q': {
        if (!cur) { cur = { v: [], i: [], o: [], c: false }; vtx(px, py); }
        const c1x = px + (2 / 3) * (c[1] - px), c1y = py + (2 / 3) * (c[2] - py);
        const c2x = c[3] + (2 / 3) * (c[1] - c[3]), c2y = c[4] + (2 / 3) * (c[2] - c[4]);
        const last = cur.v.length - 1;
        cur.o[last] = [R((c1x - px) * sx), R((c1y - py) * sy)];
        vtx(c[3], c[4]);
        cur.i[cur.v.length - 1] = [R((c2x - c[3]) * sx), R((c2y - c[4]) * sy)];
        px = c[3]; py = c[4];
        break;
      }
      case 'Z':
        if (cur) { cur.c = true; px = cur.v[0][0] / sx; py = cur.v[0][1] / sy; flush(); cur = null; }
        break;
    }
  }
  flush();
  return out;
}

const shapesOf = (gs: PathGeometry[], sx: number, sy: number) => gs.flatMap(g => cmdsToLottieShapes(g.cmds, sx, sy));

function pathKfCompatible(l: Layer): boolean {
  const kf = l.pathKf ?? [];
  const sig = (gs: PathGeometry[]) => shapesOf(gs, 1, 1).map(s => `${s.v.length}${s.c ? 'c' : 'o'}`).join(',');
  const s0 = sig(kf[0].geometry);
  // interpolation pairs commands; matching command structure is what morphs smoothly
  const cs = (gs: PathGeometry[]) => gs.map(g => g.cmds.map(c => c[0]).join('')).join('|');
  const c0 = cs(kf[0].geometry);
  return kf.every(k => sig(k.geometry) === s0 && cs(k.geometry) === c0);
}

function hex(c: number[]) {
  const h = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
  return `#${h(c[0] ?? 0)}${h(c[1] ?? 0)}${h(c[2] ?? 0)}`;
}

// ---------------- geometry helpers (bounds for precomps / bakes) ----------------

type Mat = number[];
const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
function localMat(s: { anchor: number[]; position: number[]; scale: number[]; rotation: number }): Mat {
  const r = s.rotation * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
  const A = cs * s.scale[0] / 100, B = sn * s.scale[0] / 100, C = -sn * s.scale[1] / 100, D = cs * s.scale[1] / 100;
  return [A, B, C, D, s.position[0] - (A * s.anchor[0] + C * s.anchor[1]), s.position[1] - (B * s.anchor[0] + D * s.anchor[1])];
}

/** extra px around a layer's box for strokes, effects, text overflow */
function layerPad(l: Layer): number {
  const kfMax = (k: PropKey, i = 0) => { const p = l.props[k]; return p ? Math.max(Math.abs(p.v[i] ?? 0), ...(p.kf ?? []).map(f => Math.abs(f.v[i] ?? 0))) : 0; };
  let pad = 2 + kfMax('strokeWidth') * ((l.strokeAlign ?? 'center') === 'outside' ? 1 : 0.5) * ((l.miterLimit ?? 4) > 1 ? 2 : 1);
  for (const e of visibleEffects(l)) {
    const r = e.radius ?? 0;
    if (e.type === 'dropShadow') pad = Math.max(pad, Math.max(Math.abs(e.offset?.[0] ?? 0), Math.abs(e.offset?.[1] ?? 0), kfMax('shadowOffset', 0), kfMax('shadowOffset', 1)) + Math.max(r, kfMax('shadowBlur')) * 1.6 + Math.max(e.spread ?? 0, kfMax('shadowSpread')) + 2);
    if (e.type === 'layerBlur') pad = Math.max(pad, Math.max(r, kfMax('blur')) * 1.6 + 2);
  }
  if (hasEffectProps(l, 'shadow')) pad = Math.max(pad, kfMax('shadowOffset', 0) + kfMax('shadowOffset', 1) + kfMax('shadowBlur') * 1.6 + kfMax('shadowSpread') + 2);
  if (l.props.blur) pad = Math.max(pad, kfMax('blur') * 1.6 + 2);
  if (l.type === 'text' && l.text) pad = Math.max(pad, l.text.fontSize * (l.textAnim ? 3 : 1) + Math.abs(l.textAnim?.from.dx ?? 0) + Math.abs(l.textAnim?.from.dy ?? 0));
  return Math.ceil(pad);
}

// ---------------- export ----------------

interface Ctx {
  project: Project;
  /** layers as seen in the comp being built (a component instance's own values / variants applied) */
  L: Record<string, Layer>;
  fr: number;
  ignore: Set<string>;
  issues: Map<string, LottieIssue[]>;
  sample?: LottieOptions['sample'];
  assets: any[];
  fonts: Map<string, any>;
  bakes: { req: BakeRequest; assetId: string }[];
  imageIds: Map<string, string>;
  seq: number;
}

/** layer values over local time (renderer samples when available) */
function sampler(c: Ctx, l: Layer, tOff: number) {
  return (t: number): LayerSample => {
    const s = c.sample?.(l.id, t + tOff);
    if (s) return s;
    const v = (k: PropKey) => evalProp(l.props[k], t, PROP_DEFS[k].dim, PROP_DEFS[k].default as unknown as number[]);
    return { anchor: v('anchor'), position: v('position'), scale: v('scale'), rotation: v('rotation')[0], opacity: v('opacity')[0], size: v('size'), radius: v('radius'), fill: v('fill'), stroke: v('stroke'), strokeWidth: v('strokeWidth')[0] };
  };
}

/** frame times of a comp (local), one per frame, inclusive of the last frame */
function frameTimes(comp: Composition, fr: number) {
  const n = Math.max(1, Math.ceil(comp.duration * fr - 1e-6));
  return Array.from({ length: n + 1 }, (_, i) => Math.min(i / fr, comp.duration));
}

/** layer subtree bounds in the parent's space (or the layer's own space with own=true) over time */
function subtreeBounds(c: Ctx, ids: string[], comp: Composition, tOff: number, base: (t: number) => Mat = () => [1, 0, 0, 1, 0, 0]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const times = frameTimes(comp, c.fr);
  const step = Math.max(1, Math.floor(times.length / 48));
  const walk = (id: string, t: number, M: Mat) => {
    const l = c.L[id];
    if (!l || l.type === 'audio') return;
    const s = sampler(c, l, tOff)(t);
    const W = mul(M, localMat(s));
    const pad = layerPad(l);
    const sz = l.type === 'precomp' && l.compRef && c.project.comps[l.compRef] ? [c.project.comps[l.compRef].width, c.project.comps[l.compRef].height] : s.size;
    for (const [px, py] of [[-pad, -pad], [sz[0] + pad, -pad], [-pad, sz[1] + pad], [sz[0] + pad, sz[1] + pad]]) {
      const X = W[0] * px + W[2] * py + W[4], Y = W[1] * px + W[3] * py + W[5];
      if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    }
    if (!l.clip) for (const ch of l.children) walk(ch, t, W);
  };
  for (let k = 0; k < times.length; k += step) for (const id of ids) walk(id, times[k], base(times[k]));
  if (!isFinite(x0)) return [0, 0, 1, 1];
  return [Math.floor(x0), Math.floor(y0), Math.ceil(x1) - Math.floor(x0), Math.ceil(y1) - Math.floor(y0)];
}

const bakeableIssue = (c: Ctx, l: Layer) => (c.issues.get(l.id) ?? []).some(i => i.bakeable && !c.ignore.has(i.id));

/** does the content of a layer (anything but its own transform) change over time */
function contentAnimated(c: Ctx, l: Layer, root = true): boolean {
  for (const [k, p] of Object.entries(l.props)) {
    if (!p) continue;
    if (root && (k === 'anchor' || k === 'position' || k === 'scale' || k === 'rotation' || k === 'opacity')) continue;
    if ((p.kf && p.kf.length > 1) || p.expr) return true;
  }
  if (l.textAnim || (l.pathKf && l.pathKf.length > 1)) return true;
  for (const r of [...(l.shaderEffects ?? []), ...(l.paints ?? []).filter(p => p.shader).map(p => p.shader!)]) {
    const a = c.project.shaders?.[r.shader] ?? r.asset;
    if (a?.features.isAnimated) return true;
  }
  if (l.children.some(id => c.L[id] && contentAnimated(c, c.L[id], false))) return true;
  if (l.type === 'precomp' && l.compRef && c.project.comps[l.compRef]) return true;
  return false;
}

/** transform of a lottie layer, expressions baked from the renderer's evaluation */
function transformOf(c: Ctx, l: Layer, tOff: number, comp: Composition, anchorShift: [number, number] = [0, 0]): any {
  const fr = c.fr;
  const exprKeys = (['anchor', 'position', 'scale', 'rotation', 'opacity'] as const).filter(k => l.props[k]?.expr?.trim());
  let props: Layer['props'] = l.props;
  if (exprKeys.length && !c.sample) {
    // no evaluator (node, the after effects script): pass the expression on (our syntax is a subset
    // of after effects javascript for the common cases)
    const tr = transformOf(c, { ...l, props: Object.fromEntries(Object.entries(l.props).map(([k, p]) => [k, p && { ...p, expr: undefined }])) as Layer['props'] }, tOff, comp, anchorShift);
    const X: Record<string, string> = { anchor: 'a', position: 'p', scale: 's', rotation: 'r', opacity: 'o' };
    for (const k of exprKeys) { const e = l.props[k]!.expr!; tr[X[k]].x = e.startsWith('var ') ? e : `var $bm_rt = ${e};`; }
    return tr;
  }
  if (exprKeys.length) {
    props = { ...l.props };
    const smp = sampler(c, l, tOff);
    const times = frameTimes(comp, fr);
    const vals = times.map(t => smp(t));
    for (const k of exprKeys) {
      const get = (s: LayerSample) => (k === 'rotation' ? [s.rotation] : k === 'opacity' ? [s.opacity] : s[k]);
      props[k] = { v: get(vals[0]), kf: times.map((t, i) => ({ t, v: get(vals[i]).slice(), interp: 'linear' as const, out: [0, 0] as [number, number], in: [1, 1] as [number, number] })) };
    }
  }
  const sh = anchorShift[0] || anchorShift[1];
  return {
    a: exportProp(sh ? mapPropValues(props.anchor ?? { v: [0, 0] }, v => [v[0] + anchorShift[0], v[1] + anchorShift[1]]) : props.anchor, [0, 0], fr),
    p: exportProp(props.position, [0, 0], fr, v => v, !props.position?.expr),
    s: exportProp(props.scale, [100, 100], fr),
    r: exportProp(props.rotation, [0], fr),
    o: exportProp(props.opacity, [100], fr, v => [Math.min(100, Math.max(0, v[0]))]),
  };
}

/** style props with expressions baked (size, fill, stroke, radius, stroke width) */
function styleProps(c: Ctx, l: Layer, tOff: number, comp: Composition): Layer['props'] {
  const keys = (['size', 'radius', 'fill', 'stroke', 'strokeWidth'] as const).filter(k => l.props[k]?.expr?.trim());
  if (!keys.length || !c.sample) return l.props;
  const props = { ...l.props };
  const smp = sampler(c, l, tOff);
  const times = frameTimes(comp, c.fr);
  const vals = times.map(t => smp(t));
  for (const k of keys) {
    const get = (s: LayerSample) => (k === 'strokeWidth' ? [s.strokeWidth] : s[k]);
    props[k] = { v: get(vals[0]), kf: times.map((t, i) => ({ t, v: get(vals[i]).slice(), interp: 'linear' as const, out: [0, 0] as [number, number], in: [1, 1] as [number, number] })) };
  }
  return props;
}

const groupIsolates = (l: Layer) => {
  const o = l.props.opacity;
  const op = !!o && (o.v[0] < 100 || !!o.kf?.some(k => k.v[0] < 100) || !!o.expr);
  return op || !!l.clip || (!!l.blend && l.blend !== 'normal');
};

function buildList(c: Ctx, ids: string[], comp: Composition, tOff: number, stack: string[], parentInd: number | undefined, out: any[], ind: { n: number }) {
  // masks: a mask layer masks the siblings above it (until the next mask)
  let i = 0;
  while (i < ids.length) {
    const l = c.L[ids[i]];
    if (!l) { i++; continue; }
    if (l.mask && i + 1 < ids.length) {
      let j = i + 1;
      while (j < ids.length && !c.L[ids[j]]?.mask) j++;
      const masked = ids.slice(i + 1, j);
      // the masked siblings, as one precomp (in the parent's space, shifted to fit), under the matte
      const [bx, by, bw, bh] = subtreeBounds(c, masked, comp, tOff);
      const id = `mask_${c.seq++}`;
      const inner: any[] = [];
      const nul = { n: 0 };
      const nullInd = ++nul.n;
      inner.push({ ddd: 0, ind: nullInd, ty: 3, nm: 'offset', sr: 1, st: 0, bm: 0, ip: 0, op: Math.ceil(comp.duration * c.fr - 1e-6), ks: { a: { a: 0, k: [0, 0] }, p: { a: 0, k: [-bx, -by] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } } });
      buildList(c, masked, comp, tOff, stack, nullInd, inner, nul);
      c.assets.push({ id, nm: `${l.name} (masked)`, fr: c.fr, layers: inner.reverse() });
      const matte = emitLayer(c, l, comp, tOff, stack, parentInd, ind, true);
      const tt = l.maskType === 'luminance' ? 3 : 1;
      const pre: any = { ddd: 0, ind: ++ind.n, ty: 0, nm: `${l.name} (masked)`, refId: id, sr: 1, st: 0, bm: 0, ip: 0, op: Math.ceil(comp.duration * c.fr - 1e-6), w: bw, h: bh, tt, ks: { a: { a: 0, k: [-bx, -by] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } } };
      if (parentInd !== undefined) pre.parent = parentInd;
      out.push(pre);
      for (const m of matte) { if (m.ind === matte[matte.length - 1].ind) m.td = 1; out.push(m); }
      i = j;
      continue;
    }
    if (l.mask) { i++; continue; } // a mask with nothing above it shows nothing
    for (const x of emitLayer(c, l, comp, tOff, stack, parentInd, ind, false)) out.push(x);
    i++;
  }
}

/** lottie layers for one of our layers (and its children), bottom -> top */
function emitLayer(c: Ctx, l: Layer, comp: Composition, tOff: number, stack: string[], parentInd: number | undefined, ind: { n: number }, asMatte: boolean): any[] {
  const fr = c.fr;
  const nFrames = Math.ceil(comp.duration * fr - 1e-6);
  if (l.type === 'audio') return [];
  const base: any = {
    ddd: 0, ind: ++ind.n, nm: l.name, sr: 1, st: 0, bm: BM[l.blend ?? 'normal'] ?? 0,
    ip: Math.max(0, R(l.inPoint * fr)), op: R(Math.min(l.outPoint, comp.duration) * fr),
  };
  if (!(base.op > base.ip)) base.op = Math.max(nFrames, base.ip + 1);
  if (parentInd !== undefined) base.parent = parentInd;
  if (!l.visible) base.hd = true;
  const out: any[] = [];

  // ---- baked: the editor renders the layer's content, lottie moves it ----
  if (bakeableIssue(c, l)) {
    const [bx, by, bw, bh] = bakeBox(c, l, comp, tOff);
    const id = `bake_${c.seq++}`;
    const smp = sampler(c, l, tOff);
    const times = frameTimes(comp, fr);
    let maxS = 1;
    for (let k = 0; k < times.length; k += Math.max(1, Math.floor(times.length / 24))) { const s = smp(times[k]); maxS = Math.max(maxS, Math.abs(s.scale[0]) / 100, Math.abs(s.scale[1]) / 100); }
    for (let p = l.parent ? c.L[l.parent] : undefined; p; p = p.parent ? c.L[p.parent] : undefined) {
      const ps = p.props.scale; if (ps) maxS *= Math.max(1, ...[ps.v, ...(ps.kf ?? []).map(k => k.v)].map(v => Math.max(Math.abs(v[0]), Math.abs(v[1])) / 100));
    }
    const scale = Math.min(4, Math.ceil(maxS * 4) / 4);
    const animated = contentAnimated(c, l);
    const req: BakeRequest = { layerId: l.id, compId: comp.id, box: [bx, by, bw, bh], scale, times: animated ? times.slice(0, nFrames) : [Math.max(0, Math.min(l.inPoint, comp.duration))], layers: c.L !== c.project.layers ? c.L : undefined };
    c.bakes.push({ req, assetId: id });
    c.assets.push({ id, nm: `${l.name} (baked)`, fr, w: bw, h: bh, layers: [] });
    out.push({ ...base, ty: 0, refId: id, w: bw, h: bh, ks: transformOf(c, l, tOff, comp, [-bx, -by]) });
    return out;
  }

  const props = styleProps(c, l, tOff, comp);
  const ks = transformOf(c, l, tOff, comp);
  const size = firstV(props.size, [100, 100]);
  // matte copies of vector masks: the outline, whatever the fill opacity
  const mattePaints = (items: any[]) => {
    if (!asMatte || l.maskType !== 'vector') return items;
    return items.map(it => (it.ty === 'fl' || it.ty === 'gf' ? { ...it, o: { a: 0, k: 100 } } : it));
  };
  switch (l.type) {
    case 'rect':
    case 'ellipse': {
      const prim: any = l.type === 'rect'
        ? { ty: 'rc', nm: 'Rectangle Path', d: 1, s: exportProp(props.size, [100, 100], fr), p: exportProp(mapPropValues(props.size, v => [v[0] / 2, v[1] / 2]), [50, 50], fr), r: exportProp(mapPropValues(props.radius, v => [v[0] ?? 0]), [0], fr) }
        : { ty: 'el', nm: 'Ellipse Path', d: 1, s: exportProp(props.size, [100, 100], fr), p: exportProp(mapPropValues(props.size, v => [v[0] / 2, v[1] / 2]), [50, 50], fr) };
      out.push({ ...base, ty: 4, ks, shapes: [{ ty: 'gr', nm: l.type === 'rect' ? 'Rectangle' : 'Ellipse', it: [prim, ...mattePaints(paintItems(l, fr, props)), IDENTITY_TR] }] });
      break;
    }
    case 'path': {
      const gs = l.geomSize ?? (size as [number, number]);
      const sx = gs[0] ? size[0] / gs[0] : 1, sy = gs[1] ? size[1] / gs[1] : 1;
      const it: any[] = [];
      if (l.pathKf && l.pathKf.length >= 2 && pathKfCompatible(l)) {
        const per = l.pathKf.map(k => shapesOf(k.geometry, sx, sy));
        for (let s = 0; s < per[0].length; s++) {
          const keys = l.pathKf.map((k, i) => {
            const nx = l.pathKf![i + 1];
            const o: any = { t: R(k.t * fr), s: [per[i][s]] };
            if (k.interp === 'hold') o.h = 1;
            else if (k.interp === 'linear') { o.o = { x: [0], y: [0] }; o.i = { x: [1], y: [1] }; }
            else { o.o = { x: [R(k.out[0])], y: [R(k.out[1])] }; o.i = nx ? { x: [R(nx.in[0])], y: [R(nx.in[1])] } : { x: [0.667], y: [1] }; }
            return o;
          });
          it.push({ ty: 'sh', nm: 'Path', ks: { a: 1, k: keys } });
        }
      } else for (const s of shapesOf(l.geometry ?? [], sx, sy)) it.push({ ty: 'sh', nm: 'Path', ks: { a: 0, k: s } });
      const paints = mattePaints(paintItems(l, fr, props));
      if (l.trimOn) {
        // trim applies to the stroke only (our fill stays whole): fill group below, trimmed stroke group above
        const fills = paints.filter(p => p.ty !== 'st'), strokes = paints.filter(p => p.ty === 'st');
        const tm = { ty: 'tm', nm: 'Trim', s: exportProp(props.trimStart, [0], fr), e: exportProp(props.trimEnd, [100], fr), o: exportProp(props.trimOffset, [0], fr), m: 1 };
        const shapes: any[] = [];
        if (strokes.length) shapes.push({ ty: 'gr', nm: 'Stroke', it: [...it, tm, ...strokes, IDENTITY_TR] });
        if (fills.length) shapes.push({ ty: 'gr', nm: 'Fill', it: [...it, ...fills, IDENTITY_TR] });
        out.push({ ...base, ty: 4, ks, shapes });
      } else out.push({ ...base, ty: 4, ks, shapes: [{ ty: 'gr', nm: 'Path', it: [...it, ...paints, IDENTITY_TR] }] });
      break;
    }
    case 'group': {
      const fv = firstV(props.fill, [0, 0, 0, 0]);
      const filled = fv[3] > 0 || !!props.fill?.kf?.length || (l.paints ?? []).some(p => p.type === 'linear' || p.type === 'radial');
      const own = filled ? [{ ty: 'gr', nm: 'Rectangle', it: [{ ty: 'rc', nm: 'Rectangle Path', d: 1, s: exportProp(props.size, [100, 100], fr), p: exportProp(mapPropValues(props.size, v => [v[0] / 2, v[1] / 2]), [50, 50], fr), r: exportProp(mapPropValues(props.radius, v => [v[0] ?? 0]), [0], fr) }, ...paintItems(l, fr, props), IDENTITY_TR] }] : null;
      if (groupIsolates(l) && l.children.length) {
        // composites as a unit: a precomp (clip = the group box; else the children's bounds)
        const [bx, by, bw, bh] = l.clip ? [0, 0, Math.ceil(size[0]), Math.ceil(size[1])] : (() => {
          const b = subtreeBounds(c, l.children, comp, tOff);
          const x0 = Math.min(0, b[0]), y0 = Math.min(0, b[1]);
          return [x0, y0, Math.max(b[0] + b[2], size[0]) - x0, Math.max(b[1] + b[3], size[1]) - y0].map(Math.ceil) as [number, number, number, number];
        })();
        const id = `group_${c.seq++}`;
        const inner: any[] = [];
        const nul = { n: 0 };
        const nullInd = ++nul.n;
        inner.push({ ddd: 0, ind: nullInd, ty: 3, nm: 'offset', sr: 1, st: 0, bm: 0, ip: 0, op: nFrames, ks: { a: { a: 0, k: [0, 0] }, p: { a: 0, k: [-bx, -by] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } } });
        if (own) inner.push({ ddd: 0, ind: ++nul.n, ty: 4, nm: `${l.name} fill`, sr: 1, st: 0, bm: 0, ip: 0, op: nFrames, parent: nullInd, ks: { a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }, shapes: own });
        buildList(c, l.children, comp, tOff, stack, nullInd, inner, nul);
        c.assets.push({ id, nm: l.name, fr, layers: inner.reverse() });
        out.push({ ...base, ty: 0, refId: id, w: bw, h: bh, ks: transformOf(c, l, tOff, comp, [-bx, -by]) });
        return out;
      }
      const me = own ? { ...base, ty: 4, ks, shapes: own } : { ...base, ty: 3, ks };
      // a null's opacity does nothing in lottie (and ours is 100 here: groupIsolates)
      out.push(me);
      buildList(c, l.children, comp, tOff, stack, me.ind, out, ind);
      return out;
    }
    case 'text': {
      const t = l.text!;
      const fill = firstV(props.fill, [1, 1, 1, 1]);
      const wStyle = WEIGHT_STYLE[Math.min(900, Math.max(100, Math.round((t.fontWeight || 400) / 100) * 100))];
      const fStyle = `${wStyle}${t.fontStyle === 'italic' ? ' Italic' : ''}`;
      const fName = (t.fontFamily || 'Inter').replace(/\s+/g, '') + '-' + fStyle.replace(/\s+/g, '');
      c.fonts.set(fName, { fName, fFamily: t.fontFamily || 'Inter', fStyle, ascent: 75, origin: 0, fPath: '', fWeight: '' });
      const doc = {
        s: t.fontSize, f: fName, t: t.content.replace(/\n/g, '\r'), j: t.align === 'right' ? 1 : t.align === 'center' ? 2 : 0,
        tr: t.fontSize ? R((t.letterSpacing / t.fontSize) * 1000) : 0, lh: R(t.fontSize * t.lineHeight), ls: 0,
        fc: [R(fill[0]), R(fill[1]), R(fill[2])], sz: size.slice(0, 2).map(R), ps: [0, 0],
      };
      const txt: any = { ...base, ty: 5, ks, t: { d: { k: [{ t: 0, s: doc }] }, p: {}, m: { g: 1, a: { a: 0, k: [0, 0] } }, a: [] } };
      // fill opacity: lottie text documents carry rgb only
      if ((fill[3] ?? 1) < 1) txt.ks = { ...ks, o: exportProp(mapPropValues(l.props.opacity ?? { v: [100] }, v => [v[0] * (fill[3] ?? 1)]), [100], fr) };
      out.push(txt);
      break;
    }
    case 'precomp': {
      const inner = l.compRef ? c.project.comps[l.compRef] : undefined;
      if (inner && !stack.includes(inner.id)) {
        // component instances that change something get their own asset; timing becomes a time remap
        const plan = inner.component ? instancePlan(c.project, l, inner) : null;
        const refId = 'comp_' + inner.id + (plan ? '_' + l.id : '');
        if (!c.assets.some(a => a.id === refId)) {
          const sub: any[] = [];
          const prevL = c.L;
          if (plan) c.L = { ...c.L, ...Object.fromEntries(resolvedLayers(c.project, l)) };
          try { buildList(c, inner.root, inner, tOff + (l.startTime ?? 0), [...stack, inner.id], undefined, sub, { n: 0 }); } finally { c.L = prevL; }
          c.assets.push({ id: refId, nm: inner.name, fr, layers: sub.reverse() });
        }
        // we clip a precomp to its layer box (like after effects to its comp size)
        const pl: any = { ...base, ty: 0, ks, refId, w: R(size[0]), h: R(size[1]), st: R((l.startTime ?? 0) * fr) };
        const play = inner.component ? effectivePlay(c.project, l) : l.play;
        if (play) {
          const st0 = l.startTime ?? 0, span = instanceSpan(inner, play);
          const keys = timeRemapKeys(inner, play, Math.min(span, comp.duration - st0 + 1));
          pl.tm = { a: 1, k: keys.map(([t, v], i) => (i < keys.length - 1 ? { t: R((st0 + t) * fr), s: [v], i: { x: [1], y: [1] }, o: { x: [0], y: [0] } } : { t: R((st0 + t) * fr), s: [v] })) };
          if (play.hold !== 'first' && play.hold !== 'both') pl.ip = Math.max(pl.ip, R(st0 * fr));
          if (Number.isFinite(span)) pl.op = Math.min(pl.op, Math.max(pl.ip + 1, R((st0 + span) * fr)));
        }
        out.push(pl);
      } else out.push({ ...base, ty: 3, ks });
      break;
    }
    case 'image': {
      const a = l.imageRef ? c.project.assets[l.imageRef] : undefined;
      if (a) {
        // the image stretches to the layer box (as in the editor): one asset per drawn size
        const key = `${a.id}@${R(size[0])}x${R(size[1])}`;
        let id = c.imageIds.get(key);
        if (!id) {
          id = `image_${c.imageIds.size}`;
          c.imageIds.set(key, id);
          c.assets.push({ id, w: R(size[0]), h: R(size[1]), u: '', p: a.data, e: a.data.startsWith('data:') ? 1 : 0, pr: 'none' });
        }
        out.push({ ...base, ty: 2, ks, refId: id });
      } else out.push({ ...base, ty: 3, ks });
      break;
    }
  }
  return out;
}

/** box of a baked layer in its own space: its box (and its children's) plus effect / stroke padding */
function bakeBox(c: Ctx, l: Layer, comp: Composition, tOff: number): [number, number, number, number] {
  const smp = sampler(c, l, tOff);
  const times = frameTimes(comp, c.fr);
  let w = 0, h = 0;
  for (let k = 0; k < times.length; k += Math.max(1, Math.floor(times.length / 24))) { const s = smp(times[k]); w = Math.max(w, s.size[0]); h = Math.max(h, s.size[1]); }
  const pad = layerPad(l);
  let x0 = -pad, y0 = -pad, x1 = w + pad, y1 = h + pad;
  if (l.children.length && !l.clip) {
    const b = subtreeBounds(c, l.children, comp, tOff);
    x0 = Math.min(x0, b[0] - pad); y0 = Math.min(y0, b[1] - pad); x1 = Math.max(x1, b[0] + b[2] + pad); y1 = Math.max(y1, b[1] + b[3] + pad);
  }
  return [Math.floor(x0), Math.floor(y0), Math.ceil(x1) - Math.floor(x0), Math.ceil(y1) - Math.floor(y0)];
}

function build(project: Project, opts: LottieOptions) {
  const comp = project.comps[project.activeComp] ?? Object.values(project.comps)[0];
  if (!comp) throw new Error('project has no composition');
  const fr = comp.fps || 30;
  const op = Math.max(1, Math.ceil(comp.duration * fr - 1e-6));
  const issues = new Map<string, LottieIssue[]>();
  for (const l of reachable(project)) { const x = layerIssues(project, l); if (x.length) issues.set(l.id, x); }
  const c: Ctx = { project, L: project.layers, fr, ignore: new Set(opts.ignore ?? []), issues, sample: opts.sample, assets: [], fonts: new Map(), bakes: [], imageIds: new Map(), seq: 0 };
  // without a baker nothing can be baked: export natively
  if (!opts.bake) for (const list of issues.values()) for (const i of list) c.ignore.add(i.id);
  const layers: any[] = [];
  const ind = { n: 0 };
  const bg = comp.background;
  if (bg[3] > 0) {
    layers.push({ ddd: 0, ind: ++ind.n, ty: 1, nm: 'Background', sr: 1, st: 0, bm: 0, ip: 0, op, sc: hex(bg), sw: comp.width, sh: comp.height, ks: { a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: R(bg[3] * 100) } } });
  }
  buildList(c, comp.root, comp, 0, [comp.id], undefined, layers, ind);
  const out: any = {
    v: '5.7.4', fr, ip: 0, op, w: comp.width, h: comp.height, nm: comp.name, ddd: 0, assets: c.assets, layers: layers.reverse(),
  };
  if (c.fonts.size) out.fonts = { list: Array.from(c.fonts.values()) };
  return { lottie: out, ctx: c };
}

/** native export only (nothing baked, expressions as their keyframed value unless `sample` is given) */
export function projectToLottie(project: Project, opts: Omit<LottieOptions, 'bake'> = {}): any {
  return build(project, opts).lottie;
}

/** full export: preflight, bakes (opts.bake), baked expressions (opts.sample) */
export async function exportLottieDoc(project: Project, opts: LottieOptions = {}): Promise<{ lottie: any; preflight: LottieIssue[] }> {
  const preflight = lottiePreflight(project);
  const { lottie, ctx } = build(project, opts);
  if (opts.bake) {
    for (const b of ctx.bakes) {
      const res = await opts.bake(b.req);
      const asset = ctx.assets.find(a => a.id === b.assetId);
      const [, , bw, bh] = b.req.box;
      const ids = res.images.map((data, i) => {
        const id = `${b.assetId}_img${i}`;
        ctx.assets.push({ id, w: Math.round(bw * b.req.scale), h: Math.round(bh * b.req.scale), u: '', p: data, e: 1, pr: 'none' });
        return id;
      });
      // one image layer per run of equal frames (static: one for the whole comp)
      const runs: { img: number; from: number; to: number }[] = [];
      const n = Math.ceil(ctx.project.comps[b.req.compId].duration * ctx.fr - 1e-6);
      if (b.req.times.length === 1) runs.push({ img: res.frames[0], from: 0, to: n });
      else res.frames.forEach((img, f) => { const last = runs[runs.length - 1]; if (last && last.img === img && last.to === f) last.to = f + 1; else runs.push({ img, from: f, to: f + 1 }); });
      const k = 100 / b.req.scale;
      asset.layers = runs.map((r, i) => ({ ddd: 0, ind: i + 1, ty: 2, nm: `frame ${r.from}`, refId: ids[r.img], sr: 1, st: 0, bm: 0, ip: r.from, op: r.to === n ? n + 1 : r.to, ks: { a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [R(k), R(k)] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } } })).reverse();
    }
  }
  return { lottie, preflight };
}

export { hex as _hex };
