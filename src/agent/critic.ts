// motion quality critic: deterministic "taste" checks over the document (no model, no renderer).
// it scores a piece 0-100 with sub-scores per category and returns a PRIORITISED list of concrete
// fixes, each naming the layers, the times and the exact tool call(s) that would fix it. the same
// code runs in the editor (the `critique` tool, the automatic polishing loop) and over saved eval
// documents (calibration), so the quality bar comes from the app, not from whichever model runs it.
//
// numbers come from src/agent/guides/handbook.md (timing tables, stagger ranges, reading speed,
// safe areas, contrast). docs: docs/taste-layer.md. add a rule: write a check below that pushes an
// Issue, give it an entry in RULES (category + weight), and a test in tests/critic.test.ts.

import type { Store } from '../core/store';
import { PROP_KEYS, type Keyframe, type Layer, type PropKey } from '../core/model';
import { EXPR_PROPS } from '../core/expr';
import { valueAt } from '../core/commands';
import { EASE_PRESETS } from '../core/easing';
import { propAt, layerSize, contrast, over, inv } from './motion-math';
import { music, beats } from '../audio/timing';
import { linkOf, tokenValue } from '../core/tokens';

export type Severity = 'high' | 'medium' | 'low';
export type Category = 'timing' | 'easing' | 'choreography' | 'composition' | 'readability' | 'polish' | 'richness' | 'technical' | 'brand' | 'music' | 'logo';
export const CATEGORIES: Category[] = ['timing', 'easing', 'choreography', 'composition', 'readability', 'polish', 'richness', 'technical', 'brand', 'music', 'logo'];
export interface ToolCall { tool: string; args: Record<string, any> }
export interface Issue {
  rule: string;
  severity: Severity;
  category: Category;
  message: string;
  /** layer ids involved (first = the one to change) */
  layers: string[];
  t?: [number, number];
  /** the exact tool call(s) that fix it, in order (may be empty when the fix is a judgement call) */
  fix: ToolCall[];
  /** points this issue costs its category */
  penalty: number;
}
export interface Critique {
  score: number;
  sub: Record<Category, number>;
  /** raw penalty points per category (before CAT_WEIGHTS) */
  penalties: Record<Category, number>;
  issues: Issue[];
  stats: { layers: number; animated: number; segments: number; samples: number; lastMotion: number; ms: number; logo: boolean; lockup?: { lock: number; hold: number; wordmark?: number } };
}
export interface CriticOptions {
  /** only report issues touching this time range (a storyboard beat); the score still covers the whole piece */
  range?: [number, number];
  /** the piece is meant to loop (default: detected from expressions / keys) */
  loop?: boolean;
  /** does this font family render? (default: canvas measurement in the browser, else Inter + generic families) */
  fontOk?: (family: string) => boolean;
  /** max issues returned (default 12) */
  max?: number;
  /** logo mode (the logo-sting rubric): default auto (one mark + a short wordmark, ≤ 10 s); false = off */
  logo?: boolean;
  /** the piece's pace for the logo timing ranges (default medium; from the style's feel in the app) */
  pace?: 'fast' | 'medium' | 'calm';
}

/** rule table: category and how much one occurrence weighs (x severity points). calibrated against the
 *  eval judge (docs/taste-layer.md, "Calibration"); edit here, rerun scripts/critic-calibrate.mjs */
export const RULES: Record<string, { cat: Category; w: number; title: string }> = {
  'hard-stop': { cat: 'easing', w: 0.6, title: 'hard stop / no settle' },
  'monotone-ease': { cat: 'easing', w: 1.2, title: 'one ease everywhere' },
  'entrance-ease': { cat: 'easing', w: 1, title: 'entrances do not ease out' },
  'exit-ease': { cat: 'easing', w: 0.5, title: 'exits decelerate' },
  'all-at-once': { cat: 'choreography', w: 1.2, title: 'everything moves at once' },
  'lead-late': { cat: 'choreography', w: 0.6, title: 'lead element enters after the details' },
  'slow-stagger': { cat: 'choreography', w: 0.8, title: 'stagger too slow' },
  'uniform-stagger': { cat: 'choreography', w: 0.4, title: 'stagger too uniform' },
  'timing-range': { cat: 'timing', w: 0.6, title: 'duration out of range for the distance/size' },
  'end-hold': { cat: 'timing', w: 1.2, title: 'long static ending' },
  'dead-time': { cat: 'timing', w: 0.8, title: 'dead time in the middle' },
  'late-start': { cat: 'timing', w: 0.6, title: 'slow hook' },
  'read-hold': { cat: 'readability', w: 1.2, title: 'text not on screen long enough to read' },
  'text-collision': { cat: 'readability', w: 1.2, title: 'text overlaps text' },
  'covers-text': { cat: 'readability', w: 0.8, title: 'shape covers text' },
  'contrast': { cat: 'readability', w: 1, title: 'low text contrast' },
  'off-canvas': { cat: 'composition', w: 1.2, title: 'clipped by the frame at rest' },
  'safe-area': { cat: 'composition', w: 0.5, title: 'outside the title-safe area' },
  'grow-middle': { cat: 'composition', w: 1.2, title: 'grows from the middle (anchor)' },
  'no-secondary': { cat: 'polish', w: 1, title: 'no secondary motion / follow-through' },
  'fade-only': { cat: 'polish', w: 1, title: 'only fades' },
  'loop-seam': { cat: 'polish', w: 1, title: 'loop seam' },
  'thin': { cat: 'richness', w: 1, title: 'too few elements / moves for the length' },
  'one-move': { cat: 'richness', w: 1, title: 'every element moves once and stops' },
  'copy-paste': { cat: 'polish', w: 1, title: 'identical motion copy-pasted across layers' },
  'default-fill': { cat: 'polish', w: 1, title: 'leftover default colour' },
  'invisible': { cat: 'technical', w: 1, title: 'layer never visible' },
  'dead-trim': { cat: 'technical', w: 1.4, title: 'draw-on that does not render' },
  'font-fallback': { cat: 'technical', w: 1.2, title: 'font falls back' },
  'past-end': { cat: 'technical', w: 0.8, title: 'animation runs past the comp end' },
  'palette-drift': { cat: 'brand', w: 0.6, title: 'palette drift' },
  'off-brand': { cat: 'brand', w: 0.8, title: 'colors not from the brand styles' },
  'font-drift': { cat: 'brand', w: 0.6, title: 'too many font families' },
  'off-beat': { cat: 'music', w: 1, title: 'big moves miss the beat' },
  'every-beat': { cat: 'music', w: 0.6, title: 'something lands on every beat' },
  'logo-generic': { cat: 'logo', w: 1.6, title: 'logo: no idea from the mark (pops / fades)' },
  'logo-lead-in': { cat: 'logo', w: 0.5, title: 'logo: no lead-in' },
  'logo-lock': { cat: 'logo', w: 0.8, title: 'logo: lockup completes late' },
  'logo-hold': { cat: 'logo', w: 1, title: 'logo: final lockup not held' },
  'logo-length': { cat: 'logo', w: 0.6, title: 'logo: length vs pace' },
  'logo-wordmark-timing': { cat: 'logo', w: 0.8, title: 'logo: wordmark not its own beat' },
  'logo-wordmark-entry': { cat: 'logo', w: 0.8, title: 'logo: wordmark does not come from the mark' },
  'logo-snap': { cat: 'logo', w: 0.5, title: 'logo: moves drift instead of snapping' },
  'logo-final-move': { cat: 'logo', w: 0.4, title: 'logo: ends on a big move' },
  'logo-ease-family': { cat: 'logo', w: 0.5, title: 'logo: mixed easing families' },
};
const SEV: Record<Severity, number> = { high: 30, medium: 16, low: 7 };
/** category weights of the overall score (calibrated) */
export const CAT_WEIGHTS: Record<Category, number> = { timing: 0.3, easing: 0.9, choreography: 1.8, composition: 0.4, readability: 0.8, polish: 0.4, richness: 0.6, technical: 1.4, brand: 0.2, music: 0.8, logo: 1 };
/** penalty points (after category weights) that halve the score's distance to 0: score = 100·0.5^(P/HALF) */
export const HALF = 110;

// ---------------------------------------------------------------- helpers

const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;
const ft = (t: number) => `${r2(t)}s`;
const PHYS: PropKey[] = ['position', 'scale', 'rotation', 'size'];
const LEAF = new Set(['rect', 'ellipse', 'path', 'text', 'image', 'precomp']);
const hex = (c: number[]) => '#' + c.slice(0, 3).map(x => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');

/** normalized start / end velocity of a bezier segment (1 = linear) */
function slopes(a: Keyframe, b: Keyframe): [number, number] {
  if (a.interp === 'linear') return [1, 1];
  if (a.interp === 'spring') return [3, 0];
  const x1 = a.out[0], y1 = a.out[1], x2 = b.in[0], y2 = b.in[1];
  const s0 = x1 > 1e-3 ? y1 / x1 : (y1 > 1e-3 ? 9 : (x2 > 1e-3 ? y2 / x2 : 1));
  const s1 = 1 - x2 > 1e-3 ? (1 - y2) / (1 - x2) : (1 - y2 > 1e-3 ? 9 : (1 - x1 > 1e-3 ? (1 - y1) / (1 - x1) : 1));
  return [Math.abs(s0), Math.abs(s1)];
}
const overshootSeg = (a: Keyframe, b: Keyframe) => a.interp === 'spring' || (a.interp !== 'hold' && a.interp !== 'linear' && (a.out[1] > 1.02 || a.out[1] < -0.02 || b.in[1] > 1.02 || b.in[1] < -0.02));

function easeLabel(a: Keyframe, b: Keyframe): string {
  if (a.interp === 'hold') return 'Hold';
  if (a.interp === 'linear') return 'Linear';
  if (a.interp === 'spring') return 'Spring';
  const v = [a.out[0], a.out[1], b.in[0], b.in[1]];
  const p = EASE_PRESETS.find(p => p.v.every((x, i) => Math.abs(x - v[i]) < 0.02));
  return p ? p.name : `Custom`;
}

/** keys in the tool format (set_keyframes): exact eases as names or bezier arrays */
export function toolKeys(kf: Keyframe[], map: (v: number[], k: Keyframe, i: number) => number[] = v => v, time: (t: number) => number = t => t): any[] {
  return kf.map((k, i) => {
    const o: any = { t: r2(time(k.t)), v: map(k.v, k, i).map(x => Math.round(x * 100) / 100) };
    if (o.v.length === 1) o.v = o.v[0];
    const n = kf[i + 1];
    if (n) {
      if (k.interp === 'hold') o.interp = 'hold';
      else if (k.interp === 'spring') o.ease = `spring:${r2(k.bounce ?? 0.3)}`;
      else if (k.interp === 'linear') o.ease = 'Linear';
      else { const name = easeLabel(k, n); o.ease = name !== 'Custom' ? name : [k.out[0], k.out[1], n.in[0], n.in[1]].map(r2); }
    }
    if (k.sOut) o.sOut = k.sOut.map(r1);
    if (k.sIn) o.sIn = k.sIn.map(r1);
    return o;
  });
}

function defaultFontOk(): (f: string) => boolean {
  const doc = (globalThis as any).document;
  const cache = new Map<string, boolean>();
  let g: any = null;
  try { g = doc?.createElement('canvas').getContext('2d'); } catch { g = null; }
  return (f: string) => {
    const fam = f.trim().replace(/^["']|["']$/g, '');
    if (!fam || /^(inter|serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-monospace|ui-sans-serif|ui-serif)$/i.test(fam)) return true;
    if (cache.has(fam)) return cache.get(fam)!;
    let ok = false;
    if (g) {
      const w = (x: string) => { g.font = `40px ${x}`; return g.measureText('Hamburgefonstiv 0123 ÉÀ').width; };
      ok = w(`"${fam}", monospace`) !== w('monospace') || w(`"${fam}", serif`) !== w('serif');
    }
    cache.set(fam, ok);
    return ok;
  };
}

interface Seg { l: Layer; key: PropKey; i: number; a: Keyframe; b: Keyframe; t0: number; t1: number; mag: number; s0: number; s1: number; ease: string; kind: 'enter' | 'exit' | 'move' }
interface Info {
  l: Layer; idx: number; group: boolean; text: boolean; piece: boolean; area: number; restBox: number[];
  segs: Seg[]; expr: boolean; first: number; last: number; enterT: number; exitT: number; fill: number[];
}

// ---------------------------------------------------------------- the critic

export function critique(store: Store, opts: CriticOptions = {}): Critique {
  const t0 = (globalThis.performance ?? Date).now();
  const comp = store.comp, W = comp.width, H = comp.height, D = Math.max(0.01, comp.duration), fps = comp.fps || 30;
  const S = Math.min(W, H) / 1080;
  const fontOk = opts.fontOk ?? defaultFontOk();
  const issues: Issue[] = [];
  const push = (rule: string, severity: Severity, message: string, layers: string[], t: [number, number] | undefined, fix: ToolCall[] = []) => {
    const R = RULES[rule];
    issues.push({ rule, severity, category: R.cat, message, layers, t: t ? [r2(t[0]), r2(t[1])] : undefined, fix, penalty: SEV[severity] * R.w });
  };
  const L = store.project.layers;
  const order = store.drawOrder();
  const nm = (l: Layer) => JSON.stringify(l.name);

  // ---- per-layer geometry over time (one pass per sample, parents before children)
  const N = Math.max(24, Math.min(120, Math.round(D * 12)));
  const times = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) times[i] = (D * i) / N - (i === N ? 1e-4 : 0);
  const nL = order.length;
  const index = new Map<string, number>();
  order.forEach((id, i) => index.set(id, i));
  // box [x0,y0,x1,y1] + opacity per (sample, layer)
  const geo = new Float64Array((N + 1) * nL * 5);
  const mats = new Float64Array(nL * 6);
  const opa = new Float64Array(nL);
  const sizeCache = new Map<string, [number, number]>();
  const sizeOf = (l: Layer, t: number): [number, number] => {
    if (l.type === 'text' && !(l.props.size?.kf?.length)) { let s = sizeCache.get(l.id); if (!s) { s = layerSize(store, l, 0); sizeCache.set(l.id, s); } return s; }
    return layerSize(store, l, t);
  };
  for (let si = 0; si <= N; si++) {
    const t = times[si];
    for (let i = 0; i < nL; i++) {
      const l = L[order[i]];
      if (!l) continue;
      const pi = l.parent ? index.get(l.parent) ?? -1 : -1;
      // local matrix
      const a = propAt(store, l, 'anchor', t), p = propAt(store, l, 'position', t), sc = propAt(store, l, 'scale', t), rr = propAt(store, l, 'rotation', t)[0] * Math.PI / 180;
      const cs = Math.cos(rr), sn = Math.sin(rr);
      const A = cs * sc[0] / 100, B = sn * sc[0] / 100, C = -sn * sc[1] / 100, Dd = cs * sc[1] / 100;
      const E = p[0] - (A * a[0] + C * a[1]), F = p[1] - (B * a[0] + Dd * a[1]);
      let o = (!l.visible || t < l.inPoint || t >= l.outPoint) ? 0 : Math.max(0, Math.min(100, propAt(store, l, 'opacity', t)[0])) / 100;
      const m = i * 6;
      if (pi >= 0) {
        const q = pi * 6;
        mats[m] = mats[q] * A + mats[q + 2] * B; mats[m + 1] = mats[q + 1] * A + mats[q + 3] * B;
        mats[m + 2] = mats[q] * C + mats[q + 2] * Dd; mats[m + 3] = mats[q + 1] * C + mats[q + 3] * Dd;
        mats[m + 4] = mats[q] * E + mats[q + 2] * F + mats[q + 4]; mats[m + 5] = mats[q + 1] * E + mats[q + 3] * F + mats[q + 5];
        o *= opa[pi];
      } else { mats[m] = A; mats[m + 1] = B; mats[m + 2] = C; mats[m + 3] = Dd; mats[m + 4] = E; mats[m + 5] = F; }
      opa[i] = o;
      const g = (si * nL + i) * 5;
      if (!LEAF.has(l.type) || l.mask) { geo[g + 4] = 0; continue; }
      // text animators fade units, not the layer: hidden before an "in" reveal starts, after an "out" ends
      const ta = l.textAnim;
      if (ta && ta.from.opacity < 50 && o > 0) {
        const s0 = l.inPoint + ta.start, s1 = s0 + ta.duration + ta.stagger * Math.max(0, unitsOf(l) - 1);
        const f = s1 > s0 ? Math.max(0, Math.min(1, (t - s0) / (s1 - s0))) : t >= s0 ? 1 : 0;
        o *= ta.mode === 'out' ? 1 - f : f;
      }
      const [w, h] = sizeOf(l, t);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let c = 0; c < 4; c++) {
        const lx = c === 1 || c === 2 ? w : 0, ly = c >= 2 ? h : 0;
        const X = mats[m] * lx + mats[m + 2] * ly + mats[m + 4], Y = mats[m + 1] * lx + mats[m + 3] * ly + mats[m + 5];
        if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
      }
      geo[g] = x0; geo[g + 1] = y0; geo[g + 2] = x1; geo[g + 3] = y1; geo[g + 4] = (x1 - x0) * (y1 - y0) > 0.5 ? o : 0;
    }
    // groups: the union of their visible children (children come after their parent in draw order)
    for (let i = nL - 1; i >= 0; i--) {
      const l = L[order[i]];
      if (!l || l.type !== 'group') continue;
      const g = (si * nL + i) * 5;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, o = 0;
      for (const c of l.children) {
        const ci = index.get(c);
        if (ci === undefined) continue;
        const q = (si * nL + ci) * 5;
        if (geo[q + 4] <= 0) continue;
        if (geo[q] < x0) x0 = geo[q]; if (geo[q + 1] < y0) y0 = geo[q + 1]; if (geo[q + 2] > x1) x1 = geo[q + 2]; if (geo[q + 3] > y1) y1 = geo[q + 3];
        if (geo[q + 4] > o) o = geo[q + 4];
      }
      if (o > 0) { geo[g] = x0; geo[g + 1] = y0; geo[g + 2] = x1; geo[g + 3] = y1; geo[g + 4] = o; } else geo[g + 4] = 0;
    }
  }
  const G = (si: number, li: number, k: number) => geo[(si * nL + li) * 5 + k];
  const outside = (si: number, li: number) => {
    const x0 = G(si, li, 0), y0 = G(si, li, 1), x1 = G(si, li, 2), y1 = G(si, li, 3), a = (x1 - x0) * (y1 - y0);
    if (a <= 0) return 0;
    const ix = Math.max(0, Math.min(x1, W) - Math.max(x0, 0)), iy = Math.max(0, Math.min(y1, H) - Math.max(y0, 0));
    return 1 - (ix * iy) / a;
  };
  const sampleAt = (t: number) => Math.max(0, Math.min(N, Math.round((t / D) * N)));
  const visibleAt = (li: number, si: number) => G(si, li, 4) > 0.05 && outside(si, li) < 0.97;

  // ---- leaves, segments
  const infos: Info[] = [];
  const all: Seg[] = [];
  let exprLayers = 0;
  const masked = new Set<string>();
  // animated masks (draw-on strokes, moving wipes) are motion too
  let maskMoves = 0;
  for (const id of order) { const l = L[id]; if (l?.mask) for (const k of PROP_KEYS) { const kf = l.props[k]?.kf; if (kf && kf.length > 1) maskMoves += kf.length - 1; } }
  for (let i = 0; i < nL; i++) {
    const l = L[order[i]];
    if (!l || !(LEAF.has(l.type) || l.type === 'group') || l.mask) continue;
    const segs: Seg[] = [];
    let expr = false, first = Infinity, last = -Infinity;
    // segments of this layer and its ancestors (a group's move moves its children), and of the masks
    // below them (a mask that draws on / moves is a reveal of what it masks)
    const chain: Layer[] = [];
    for (let cur: Layer | undefined = l; cur; cur = cur.parent ? L[cur.parent] : undefined) {
      chain.push(cur);
      const sib = cur.parent ? L[cur.parent]?.children ?? [] : comp.root;
      for (const id of sib.slice(0, Math.max(0, sib.indexOf(cur.id)))) { const m = L[id]; if (m?.mask) { chain.push(m); if (cur === l) masked.add(l.id); } }
    }
    for (const cur of chain) {
      for (const key of PROP_KEYS) {
        const pr = cur.props[key];
        if (!pr) continue;
        if (pr.expr?.trim() && EXPR_PROPS.includes(key) && key !== 'fill') { expr = true; first = Math.min(first, l.inPoint); last = Math.max(last, Math.min(D, l.outPoint)); }
        const kf = pr.kf;
        if (!kf || kf.length < 2) continue;
        for (let k = 0; k < kf.length - 1; k++) {
          const a = kf[k], b = kf[k + 1];
          let mag = 0;
          for (let j = 0; j < a.v.length; j++) mag += (b.v[j] - a.v[j]) ** 2;
          mag = Math.sqrt(mag);
          if (key === 'scale') mag /= Math.SQRT2;
          if (mag < 1e-6) continue;
          first = Math.min(first, a.interp === 'hold' ? b.t : a.t); last = Math.max(last, b.t);
          if (cur !== l) continue; // ancestors only shape the activity span
          const [s0, s1] = slopes(a, b);
          // a hold segment changes at its end: it is an instant cut there
          const sg: Seg = { l, key, i: k, a, b, t0: a.interp === 'hold' ? b.t : a.t, t1: b.t, mag, s0, s1, ease: easeLabel(a, b), kind: 'move' };
          segs.push(sg);
        }
      }
    }
    if (l.textAnim) { const ta = l.textAnim; first = Math.min(first, l.inPoint + ta.start); last = Math.max(last, l.inPoint + ta.start + ta.duration + ta.stagger * Math.min(40, unitsOf(l))); }
    if (l.pathKf && l.pathKf.length > 1) { first = Math.min(first, l.pathKf[0].t); last = Math.max(last, l.pathKf[l.pathKf.length - 1].t); }
    if (expr) exprLayers++;
    // rest box: where it sits when its motion is done (or mid-comp)
    const restT = isFinite(last) ? Math.min(D, Math.max(last, isFinite(first) ? first : 0)) : D / 2;
    let rs = sampleAt(restT);
    // if it has exited by then, use the middle of its visible span
    if (G(rs, i, 4) <= 0.05) { const vis: number[] = []; for (let s = 0; s <= N; s++) if (G(s, i, 4) > 0.05) vis.push(s); if (vis.length) rs = vis[Math.floor(vis.length / 2)]; }
    const restBox = [G(rs, i, 0), G(rs, i, 1), G(rs, i, 2), G(rs, i, 3)];
    const area = Math.max(0, restBox[2] - restBox[0]) * Math.max(0, restBox[3] - restBox[1]);
    const parent = l.parent ? L[l.parent] : undefined;
    // split text: one letter / glyph per layer (kerned neighbours overlap by design)
    const piece = l.type === 'text' && !!l.text && (l.text.content.trim().length <= 2 || (!!parent && parent.children.filter(c => L[c]?.type === 'text').length > 3 && l.text.content.trim().length <= 3));
    // entrance / exit times from visibility
    let enterT = -1, exitT = -1;
    let seen = false;
    for (let s = 0; s <= N; s++) { const v = visibleAt(i, s); if (v && !seen) { seen = true; if (s > 0) enterT = times[s]; } if (!v && seen && exitT < 0 && s > 0) exitT = times[s]; if (v && exitT >= 0) exitT = -1; }
    if (!seen) enterT = Infinity;
    for (const sg of segs) {
      const sa = sampleAt(sg.t0 + 1e-3), sb = sampleAt(sg.t1 + 0.02);
      const va = G(sa, i, 4) > 0.05 && outside(sa, i) < 0.9, vb = G(sb, i, 4) > 0.05 && outside(sb, i) < 0.9;
      const vEnd = G(sampleAt(sg.t1 - 1e-3), i, 4) > 0.05 && outside(sampleAt(sg.t1 - 1e-3), i) < 0.9;
      const gone = (t: number) => { for (let c: Layer | undefined = l; c; c = c.parent ? L[c.parent] : undefined) { if (propAt(store, c, 'opacity', t)[0] < 3) return true; const sc = propAt(store, c, 'scale', t); if (Math.max(Math.abs(sc[0]), Math.abs(sc[1])) < 4) return true; } return false; };
      if (sg.key === 'opacity') sg.kind = sg.b.v[0] > sg.a.v[0] ? 'enter' : 'exit';
      else if (!gone(sg.t0) && gone(sg.t1)) sg.kind = 'exit';
      else if (!va && vb) sg.kind = 'enter';
      else if (va && (!vb || !vEnd)) sg.kind = 'exit';
      else if (sg.key === 'scale' && Math.max(sg.a.v[0], sg.a.v[1]) < 40 && Math.max(sg.b.v[0], sg.b.v[1]) > 60) sg.kind = 'enter';
      else if (sg.key === 'scale' && Math.max(sg.b.v[0], sg.b.v[1]) < 40 && Math.max(sg.a.v[0], sg.a.v[1]) > 60) sg.kind = 'exit';
      else if (enterT >= 0 && isFinite(enterT) && sg.t0 <= enterT + 0.05 && sg.t1 > enterT) sg.kind = 'enter';
    }
    const fillV = l.props.fill ? valueAt(l, 'fill', restT) : [0, 0, 0, 0];
    const info: Info = { l, idx: i, group: l.type === 'group', text: l.type === 'text' && !!l.text, piece, area, restBox, segs, expr, first, last, enterT, exitT, fill: fillV };
    infos.push(info);
    all.push(...segs);
  }
  const infoById = new Map(infos.map(x => [x.l.id, x]));
  const frame = W * H;
  const isBg = (x: Info) => x.area > 0.6 * frame || (x.restBox[2] - x.restBox[0]) >= 0.95 * W && (x.restBox[3] - x.restBox[1]) >= 0.5 * H;
  const animated = infos.filter(x => isFinite(x.first) || x.expr || x.l.textAnim);
  const lastMotion = Math.max(0, ...animated.map(x => Math.min(D, isFinite(x.last) ? x.last : 0)), ...infos.filter(x => x.expr).map(x => Math.min(D, x.l.outPoint)));
  const firstMotion = animated.length ? Math.min(...animated.map(x => (isFinite(x.first) ? x.first : D))) : 0;
  const loopy = opts.loop ?? detectLoop(store, infos, D);
  const primary = pickPrimary(infos.filter(x => !isBg(x) && !x.piece && x.area > 0 && !(x.group && x.l.children.length > 6)));
  const logo = detectLogo(store, infos, isBg, D, W, H, S, opts.logo);
  let lockup: Critique['stats']['lockup'];

  /** a deliberate impact (gravity): another property starts changing at the landing (a squash), or the
   *  move falls back after a hop (the previous segment went the other way) */
  const impact = (sg: Seg): boolean => {
    if (PHYS.some(k => (sg.l.props[k]?.kf ?? []).some((q, qi, arr) => Math.abs(q.t - sg.t1) < 0.05 && arr[qi + 1] && k !== sg.key && arr[qi + 1].v.some((v, j) => Math.abs(v - q.v[j]) > 1e-6)))) return true;
    const kf = sg.l.props[sg.key]!.kf!, p = kf[sg.i - 1];
    if (p) {
      const d0 = sg.a.v.map((v, j) => v - p.v[j]), d1 = sg.b.v.map((v, j) => v - sg.a.v[j]);
      if (d0.reduce((x, v, j) => x + v * d1[j], 0) < 0 && sg.a.t - p.t < 0.6) return true;
    }
    return false;
  };

  // ================================================================ easing
  // hard stops: a physical move arriving at full speed (linear / ease-in arrival) and not continuing
  {
    const hits: Seg[] = [];
    for (const sg of all) {
      if (!PHYS.includes(sg.key) || sg.kind === 'exit' || sg.a.interp === 'hold') continue;
      const big = sg.key === 'position' || sg.key === 'size' ? sg.mag >= 24 * S : sg.key === 'scale' ? sg.mag >= 8 : sg.mag >= 10;
      if (!big || sg.s1 < 0.6) continue;
      if (sg.t1 - sg.t0 < 0.1) continue; // a snap / blink shut: deliberate
      if (sg.a.interp === 'linear' && (sg.t1 - sg.t0 > 2.5 || (sg.key === 'rotation' && sg.mag >= 180))) continue; // drifts, spins
      const kf = sg.l.props[sg.key]!.kf!;
      const n = kf[sg.i + 2];
      if (n && n.t - sg.b.t < 0.06 && n.v.some((x, j) => Math.abs(x - sg.b.v[j]) > 1e-6)) continue; // continues / turns into an overshoot
      if (!kf[sg.i + 2] && sg.s0 < sg.s1 && (masked.has(sg.l.id) || ancestors(store, sg.l).some(a => a.clip))) continue; // accelerates behind a mask: an exit
      if (impact(sg)) continue;
      hits.push(sg);
    }
    hits.sort((a, b) => b.mag * (b.key === 'position' ? 1 : 4) - a.mag * (a.key === 'position' ? 1 : 4));
    const phys = all.filter(sg => PHYS.includes(sg.key) && sg.kind !== 'exit').length;
    const share = hits.length / Math.max(1, phys);
    for (const sg of hits.slice(0, 4)) {
      const ease = sg.kind === 'enter' ? 'Expo Out' : 'Cubic In Out';
      push('hard-stop', share >= 0.3 && hits.length >= 3 ? 'medium' : 'low', `${nm(sg.l)}.${sg.key} arrives at full speed at ${ft(sg.t1)} (${sg.ease}): ease the landing (${ease}) or add a settle`, [sg.l.id], [sg.t0, sg.t1],
        [{ tool: 'set_easing', args: { id: sg.l.id, prop: sg.key, indices: [sg.i], ease } }]);
    }
    if (hits.length > 4) push('hard-stop', share >= 0.3 ? 'medium' : 'low', `${hits.length - 4} more moves stop abruptly (${[...new Set(hits.slice(4).map(h => h.l.name))].slice(0, 4).join(', ')})`, hits.slice(4).map(h => h.l.id), undefined, []);
  }
  // one ease everywhere
  {
    const moving = all.filter(s => s.a.interp !== 'hold');
    if (moving.length >= 6) {
      const count = new Map<string, number>();
      for (const s of moving) count.set(s.ease, (count.get(s.ease) ?? 0) + 1);
      const [top, n] = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
      const share = n / moving.length;
      const generic = /^(Easy Ease|Linear|Ease In Out)$/.test(top);
      if (share >= 0.85 && (generic || moving.length >= 10)) {
        const ent = moving.filter(s => s.ease === top && s.kind === 'enter' && s.key !== 'opacity').slice(0, 3);
        push('monotone-ease', generic && share >= 0.9 ? 'high' : 'medium', `${Math.round(share * 100)}% of ${moving.length} moves use ${top}${generic ? ' (the default)' : ''}: give entrances a decelerating ease, exits an accelerating one, accents a spring/overshoot`, [...new Set(moving.filter(s => s.ease === top).map(s => s.l.id))].slice(0, 8), undefined,
          ent.map(s => ({ tool: 'set_easing', args: { id: s.l.id, prop: s.key, indices: [s.i], ease: 'Expo Out' } })));
      }
    }
  }
  // entrances should decelerate, exits accelerate
  {
    const ent = all.filter(s => s.kind === 'enter' && s.key !== 'opacity' && s.a.interp !== 'hold' && s.a.interp !== 'spring' && !overshootSeg(s.a, s.b) && !impact(s));
    const bad = ent.filter(s => !(s.s0 > s.s1 * 1.8 && s.s1 < 0.35));
    if (ent.length >= 2 && bad.length / ent.length >= 0.5) {
      push('entrance-ease', bad.length / ent.length >= 0.8 ? 'medium' : 'low', `${bad.length} of ${ent.length} entrances don't decelerate (${[...new Set(bad.map(s => s.ease))].join(', ')}): entrances ease out (Expo/Quart/Cubic Out) or spring`, [...new Set(bad.map(s => s.l.id))].slice(0, 8), undefined,
        bad.slice(0, 4).map(s => ({ tool: 'set_easing', args: { id: s.l.id, prop: s.key, indices: [s.i], ease: 'Quart Out' } })));
    }
    const ex = all.filter(s => s.kind === 'exit' && s.key !== 'opacity' && s.a.interp !== 'hold');
    const badEx = ex.filter(s => s.s0 > 1.6 && s.s1 < 0.4);
    if (ex.length >= 2 && badEx.length / ex.length >= 0.6) push('exit-ease', 'low', `${badEx.length} exits decelerate away (${[...new Set(badEx.map(s => s.ease))].join(', ')}): exits accelerate (Expo In / Cubic In) and are shorter than entrances`, [...new Set(badEx.map(s => s.l.id))].slice(0, 8), undefined,
      badEx.slice(0, 3).map(s => ({ tool: 'set_easing', args: { id: s.l.id, prop: s.key, indices: [s.i], ease: 'Cubic In' } })));
  }

  // ================================================================ choreography
  const entering = infos.filter(x => !isBg(x) && !x.piece && x.area > 0 && x.segs.some(s => s.kind === 'enter'));
  const enterStart = (x: Info) => Math.min(...x.segs.filter(s => s.kind === 'enter').map(s => s.t0));
  const enterEnd = (x: Info) => Math.max(...x.segs.filter(s => s.kind === 'enter').map(s => s.t1));
  {
    // groups of entrances starting within 40 ms of each other with similar durations
    const es = entering.map(x => ({ x, t: enterStart(x), d: enterEnd(x) - enterStart(x) })).sort((a, b) => a.t - b.t);
    const clusters: typeof es[] = [];
    for (const e of es) { const c = clusters[clusters.length - 1]; if (c && e.t - c[0].t <= 0.04) c.push(e); else clusters.push([e]); }
    const big = clusters.filter(c => c.length >= 4 || (c.length >= 3 && c.length === es.length && es.length >= 3));
    for (const c0 of big.slice(0, 2)) {
      const c = c0.filter(e => !(e.x.group && c0.some(f => f !== e && store.isAncestor(e.x.l.id, f.x.l.id))));
      if (c.length < 3) continue;
      // siblings that share a parent which is itself not animated, e.g. one decoration set, still count
      const ids = readingOrder(c.map(e => e.x), primary);
      push('all-at-once', c.length >= 5 || c.length === es.length ? 'high' : 'medium', `${c.length} elements start together at ${ft(c[0].t)} (${c.slice(0, 4).map(e => e.x.l.name).join(', ')}${c.length > 4 ? '…' : ''}): lead with the hero, overlap the rest 0.06-0.12 s apart`, ids, [c[0].t, c[0].t + Math.max(...c.map(e => e.d))],
        [{ tool: 'choreograph', args: { ids, pattern: 'sequential', step: c.length > 8 ? r2(Math.max(0.03, 0.5 / (c.length - 1))) : 0.08 } }]);
    }
    // the lead element enters after several smaller details
    if (primary && entering.includes(primary) && es.length >= 4) {
      const pt = enterStart(primary);
      const before = es.filter(e => e.x !== primary && e.t < pt - 0.3 && e.t < firstMotion + 1.5 && !e.x.text);
      if (before.length >= 3 && pt < D * 0.6) push('lead-late', 'low', `the hero ${nm(primary.l)} enters at ${ft(pt)}, after ${before.length} smaller elements: the lead should move first (or at least early)`, [primary.l.id, ...before.map(e => e.x.l.id)], [before[0].t, pt],
        [{ tool: 'retime', args: { ids: [primary.l.id], offset: r2(before[0].t - pt) } }]);
    }
    // cascades: runs of >= 3 same-type elements with near-equal gaps
    const runs: typeof es[] = [];
    let cur: typeof es = [];
    for (const e of es) {
      const p = cur[cur.length - 1], q = cur[cur.length - 2];
      if (p && e.x.l.type === p.x.l.type && e.t - p.t > 0.015 && e.t - p.t < 1.5 && (!q || Math.abs((e.t - p.t) - (p.t - q.t)) < 0.03) && Math.abs(e.d - p.d) < 0.25) cur.push(e);
      else { if (cur.length >= 3) runs.push(cur); cur = p && e.x.l.type === p.x.l.type && e.t - p.t > 0.015 && e.t - p.t < 1.5 ? [p, e] : [e]; }
    }
    if (cur.length >= 3) runs.push(cur);
    for (const run of runs.slice(0, 2)) {
      const n = run.length, step = (run[n - 1].t - run[0].t) / (n - 1);
      const small = run.every(e => Math.max(e.x.restBox[2] - e.x.restBox[0], e.x.restBox[3] - e.x.restBox[1]) < 500 * S);
      const rec = n > 8 ? Math.max(0.03, 0.5 / (n - 1)) : small ? 0.08 : 0.15;
      const ids = run.map(e => e.x.l.id);
      if ((small && step > 0.22) || step * (n - 1) > 1.2 + (small ? 0 : 0.6)) {
        push('slow-stagger', step * (n - 1) > 2 ? 'medium' : 'low', `${n} ${run[0].x.l.type} layers cascade ${r2(step)} s apart (${r2(step * (n - 1))} s in total): items overlap, 0.05-0.12 s apart, the whole cascade ≤ 0.6 s`, ids, [run[0].t, run[n - 1].t + run[n - 1].d],
          [{ tool: 'choreograph', args: { ids, pattern: 'sequential', step: r2(rec) } }]);
      } else if (n >= 6 && run.every(e => Math.abs(e.d - run[0].d) < 0.01)) {
        push('uniform-stagger', 'low', `${n} ${run[0].x.l.type} layers enter on an even ${r2(step)} s metronome with identical moves: vary the rhythm (wave / center-out) or the distances`, ids, [run[0].t, run[n - 1].t + run[n - 1].d],
          [{ tool: 'choreograph', args: { ids, pattern: 'wave', spread: r2(Math.min(0.6, step * (n - 1))) } }]);
      }
    }
    // per-letter text animators that crawl
    for (const x of infos) {
      const ta = x.l.textAnim;
      if (!ta || ta.mode === 'out') continue;
      const lim = ta.by === 'char' ? 0.08 : ta.by === 'word' ? 0.2 : 0.3;
      const units = unitsOf(x.l), total = ta.stagger * Math.max(0, units - 1);
      if (ta.stagger > lim || (total > 2.2 && ta.by !== 'line')) push('slow-stagger', total > 3 ? 'medium' : 'low', `${nm(x.l)} reveals ${units} ${ta.by}s ${r2(ta.stagger)} s apart (${r2(total)} s): ${ta.by === 'char' ? 'letters 0.02-0.05 s' : ta.by === 'word' ? 'words 0.06-0.12 s' : 'lines 0.1-0.2 s'}`, [x.l.id], [x.l.inPoint + ta.start, x.l.inPoint + ta.start + total + ta.duration],
        [{ tool: 'set_text_animation', args: { ids: [x.l.id], by: ta.by, start: r2(ta.start), duration: r2(ta.duration), stagger: r2(Math.min(lim * 0.6, 1.4 / Math.max(1, units - 1))), ease: ta.ease } }]);
    }
  }

  // ================================================================ timing
  {
    const bad: { sg: Seg; exp: number; d: number }[] = [];
    for (const sg of all) {
      if (sg.a.interp === 'hold') continue;
      const d = sg.t1 - sg.t0;
      if (d < 2 / fps - 1e-6 && sg.key !== 'opacity' && sg.key !== 'fill') { bad.push({ sg, exp: 0.15, d }); continue; }
      let exp = 0;
      if (sg.key === 'position' && sg.mag >= (sg.kind === 'move' ? 80 : 16) * S) exp = Math.min(1, 0.25 + sg.mag / S / 2000);
      else if (sg.key === 'scale' && (sg.kind === 'enter' || sg.kind === 'exit') && sg.mag >= 30) {
        const x = infoById.get(sg.l.id)!; const sz = Math.max(x.restBox[2] - x.restBox[0], x.restBox[3] - x.restBox[1]) / S;
        exp = sz <= 120 ? 0.32 : sz <= 400 ? 0.55 : 0.8;
      } else continue;
      if (sg.kind === 'exit') exp *= 0.75;
      if (d > 2.5 && sg.kind === 'move') continue; // camera drifts / ambient
      // slow is a style choice (luxury, calm) far more often than fast: only flag clearly sluggish moves
      const hi = exp * (sg.a.interp === 'spring' || overshootSeg(sg.a, sg.b) ? 4 : 3) + 0.2, lo = exp * 0.4;
      if (d > hi || d < lo) bad.push({ sg, exp, d });
    }
    bad.sort((a, b) => Math.abs(Math.log(b.d / b.exp)) - Math.abs(Math.log(a.d / a.exp)));
    const seen = new Set<string>();
    for (const { sg, exp, d } of bad) {
      if (seen.has(sg.l.id) || seen.size >= 3) continue;
      seen.add(sg.l.id);
      const slow = d > exp;
      push('timing-range', bad.length >= 4 || d < 2 / fps ? 'medium' : 'low', `${nm(sg.l)}.${sg.key} ${sg.kind === 'move' ? 'move' : sg.kind} takes ${r2(d)} s for ${sg.key === 'position' ? `${Math.round(sg.mag)} px` : `scale Δ${Math.round(sg.mag)}%`}: ${slow ? 'sluggish' : 'too abrupt'}, ~${r2(exp)} s fits (handbook timing table)`, [sg.l.id], [sg.t0, sg.t1],
        [{ tool: 'retime', args: { ids: [sg.l.id], pivot: r2(sg.t0), scale: r2(Math.max(0.2, Math.min(5, exp / Math.max(d, 1e-3)))) } }]);
    }
    if (bad.length > 3) push('timing-range', 'low', `${bad.length - 3} more moves are outside the timing table ranges`, [...new Set(bad.slice(3).map(b => b.sg.l.id))].slice(0, 8), undefined, []);
  }
  // long static endings and dead time (holds for reading are fine; long nothing is not)
  if (animated.length && !loopy) {
    const endHold = D - lastMotion;
    // logo stings hold the finished lockup still on purpose (1.5-2.5 s): only a long static ending counts
    if (endHold > (logo ? (opts.pace === 'calm' ? 3.5 : 3) : Math.max(2, 0.3 * D))) {
      const hero = primary ?? animated[0];
      const sc = valueAt(hero.l, 'scale', lastMotion);
      push('end-hold', endHold > Math.max(3, 0.45 * D) ? 'high' : 'medium', `nothing moves for the last ${r2(endHold)} s (motion ends ${ft(lastMotion)} of ${ft(D)}): keep the brief's length and carry the hold with a slow push / idle motion, or extend the build`, [hero.l.id], [lastMotion, D],
        [{ tool: 'animate', args: { tracks: [{ id: hero.l.id, prop: 'scale', merge: true, keyframes: [{ t: r2(lastMotion), v: sc.map(r1), ease: 'Sine In Out' }, { t: r2(D), v: sc.map(v => r1(v * 1.04)) }] }] } }]);
    }
    // gaps inside the piece
    const iv: [number, number][] = [];
    for (const x of animated) {
      for (const s of x.segs) iv.push([s.t0, s.t1]);
      if (x.expr) iv.push([x.l.inPoint, Math.min(D, x.l.outPoint)]);
      if (x.l.textAnim) iv.push([x.first, x.last]);
      if (x.l.pathKf && x.l.pathKf.length > 1) iv.push([x.l.pathKf[0].t, x.l.pathKf[x.l.pathKf.length - 1].t]);
    }
    // ancestors' keys count too
    for (const l of Object.values(L)) if (l.type === 'group') for (const k of PROP_KEYS) { const kf = l.props[k]?.kf; if (kf && kf.length > 1) iv.push([kf[0].t, kf[kf.length - 1].t]); }
    iv.sort((a, b) => a[0] - b[0]);
    let end = iv.length ? iv[0][1] : 0, worst: [number, number] | null = null;
    for (const [a, b] of iv) { if (a - end > 2.5 && (!worst || a - end > worst[1] - worst[0])) worst = [end, a]; end = Math.max(end, b); }
    if (worst) push('dead-time', worst[1] - worst[0] > 4 ? 'medium' : 'low', `nothing moves between ${ft(worst[0])} and ${ft(worst[1])} (${r2(worst[1] - worst[0])} s): hold ≤ 2 s, then the next beat (or keep a secondary move alive)`, [], worst,
      [{ tool: 'retime', args: { from: r2(worst[1] - 0.01), offset: r2(-(worst[1] - worst[0] - 1.8)) } }]);
    if (firstMotion > 0.6 && firstMotion < D * 0.5) push('late-start', firstMotion > 1.2 ? 'medium' : 'low', `the first thing moves at ${ft(firstMotion)}: hook within 0.5 s`, [], [0, firstMotion],
      [{ tool: 'retime', args: { offset: r2(-(firstMotion - 0.15)) } }]);
  }
  // keys past the comp end
  {
    const past = infos.filter(x => isFinite(x.last) && x.last > D + 0.05);
    if (past.length) push('past-end', 'medium', `animation runs to ${ft(Math.max(...past.map(x => x.last)))}, past the comp end ${ft(D)} (${past.slice(0, 3).map(x => x.l.name).join(', ')})`, past.map(x => x.l.id), [D, Math.max(...past.map(x => x.last))],
      [{ tool: 'retime', args: { ids: past.map(x => x.l.id), offset: r2(-(Math.max(...past.map(x => x.last)) - D + 0.3)) } }]);
  }

  // ================================================================ readability
  {
    const texts = infos.filter(x => x.text && !x.piece && x.l.text!.content.trim());
    const allTexts = infos.filter(x => x.text && x.l.text!.content.trim());
    for (const x of texts) {
      const words = x.l.text!.content.trim().split(/\s+/).length;
      // ~3.5 words/s plus a beat to notice it (kinetic word flashes may be short, sentences may not)
      const need = Math.max(0.6, Math.min(6, 0.3 + words / 3.5));
      const ta = x.l.textAnim;
      const revealAt = ta && ta.mode !== 'out' && ta.from.opacity < 60 ? x.l.inPoint + ta.start + ta.duration + ta.stagger * Math.max(0, unitsOf(x.l) - 1) : -1;
      const hideAt = ta && ta.mode === 'out' ? x.l.inPoint + ta.start : Infinity;
      let readable = 0, firstR = -1, lastR = -1;
      const dt = D / N;
      for (let s = 0; s <= N; s++) {
        const t = times[s];
        if (t < revealAt || t > hideAt) continue;
        if (G(s, x.idx, 4) >= 0.8 && outside(s, x.idx) < 0.1) { readable += dt; if (firstR < 0) firstR = t; lastR = t; }
      }
      if (readable >= need - 0.05 || readable <= 0) continue;
      const exits = lastR < D - 0.15;
      const short = need - readable;
      const sev: Severity = readable < need * 0.5 ? 'high' : 'medium';
      const fix: ToolCall[] = exits
        ? [{ tool: 'retime', args: { ids: [x.l.id], from: r2(lastR), offset: r2(short + 0.1) } }]
        : firstR > short + 0.2 ? [{ tool: 'retime', args: { ids: [x.l.id], offset: r2(-(short + 0.1)) } }] : [];
      push('read-hold', sev, `${nm(x.l)} (${words} word${words > 1 ? 's' : ''}) is readable for ${r2(readable)} s, needs ~${r2(need)} s${exits ? `: exit later` : ': it appears too late for the comp end'}`, [x.l.id], [Math.max(0, firstR), Math.max(0, lastR)], fix);
    }
    // text over text while phrases hand over
    const pairs = new Map<string, { a: Info; b: Info; n: number; t0: number; t1: number }>();
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.l.text!.content === b.l.text!.content) continue;
      for (let s = 0; s <= N; s++) {
        if (G(s, a.idx, 4) < 0.15 || G(s, b.idx, 4) < 0.15) continue;
        const ix = Math.max(0, Math.min(G(s, a.idx, 2), G(s, b.idx, 2)) - Math.max(G(s, a.idx, 0), G(s, b.idx, 0)));
        const iy = Math.max(0, Math.min(G(s, a.idx, 3), G(s, b.idx, 3)) - Math.max(G(s, a.idx, 1), G(s, b.idx, 1)));
        const aa = (G(s, a.idx, 2) - G(s, a.idx, 0)) * (G(s, a.idx, 3) - G(s, a.idx, 1)), ab = (G(s, b.idx, 2) - G(s, b.idx, 0)) * (G(s, b.idx, 3) - G(s, b.idx, 1));
        const frac = (ix * iy) / Math.max(1, Math.min(aa, ab));
        if (frac < 0.12) continue;
        const k = a.l.id + '|' + b.l.id;
        const e = pairs.get(k) ?? { a, b, n: 0, t0: times[s], t1: times[s] };
        e.n++; e.t1 = times[s];
        pairs.set(k, e);
      }
    }
    const coll = [...pairs.values()].filter(p => (p.n * D) / N >= 0.1).sort((p, q) => q.n - p.n);
    for (const p of coll.slice(0, 3)) {
      const dur = (p.n * D) / N;
      const late = (p.a.enterT > p.b.enterT ? p.a : p.b);
      push('text-collision', dur > 0.3 ? 'high' : 'medium', `${nm(p.a.l)} and ${nm(p.b.l)} overlap for ${r2(dur)} s (${ft(p.t0)}–${ft(p.t1)}): let the outgoing text clear (or move apart) before the next arrives`, [late.l.id, (late === p.a ? p.b : p.a).l.id], [p.t0, p.t1],
        [{ tool: 'retime', args: { ids: [late.l.id], offset: r2(dur + 0.05) } }]);
    }
    // an opaque shape drawn above text, covering it
    let covers = 0;
    for (const x of texts) {
      if (covers >= 2) break;
      for (const y of infos) {
        if (y.idx <= x.idx || y.text || y.group || isBg(y) || y.fill[3] < 0.5) continue;
        if (x.l.parent && (y.l.id === x.l.parent)) continue;
        let n = 0, tA = -1, tB = -1;
        for (let s = 0; s <= N; s++) {
          if (G(s, x.idx, 4) < 0.3 || G(s, y.idx, 4) < 0.5) continue;
          const ix = Math.max(0, Math.min(G(s, x.idx, 2), G(s, y.idx, 2)) - Math.max(G(s, x.idx, 0), G(s, y.idx, 0)));
          const iy = Math.max(0, Math.min(G(s, x.idx, 3), G(s, y.idx, 3)) - Math.max(G(s, x.idx, 1), G(s, y.idx, 1)));
          const ta = (G(s, x.idx, 2) - G(s, x.idx, 0)) * (G(s, x.idx, 3) - G(s, x.idx, 1));
          if ((ix * iy) / Math.max(1, ta) > 0.3) { n++; if (tA < 0) tA = times[s]; tB = times[s]; }
        }
        if ((n * D) / N >= 0.25) { push('covers-text', 'medium', `${nm(y.l)} is drawn over ${nm(x.l)} for ${r2((n * D) / N)} s`, [y.l.id, x.l.id], [tA, tB], []); covers++; break; }
      }
    }
    // contrast of text at rest against what is behind it
    let low = 0;
    for (const x of allTexts) {
      if (low >= 3 || x.l.props.fill?.kf?.length) continue;
      const t = isFinite(x.last) ? Math.min(D, Math.max(x.last, 0)) : D / 2;
      const s = sampleAt(t);
      if (G(s, x.idx, 4) < 0.5) continue;
      const cx = (G(s, x.idx, 0) + G(s, x.idx, 2)) / 2, cy = (G(s, x.idx, 1) + G(s, x.idx, 3)) / 2;
      const bg = colorBehind(store, infos, x, s, cx, cy, G, comp.background);
      const fg = x.fill;
      const c = contrast(over([fg[0], fg[1], fg[2], (fg[3] ?? 1) * G(s, x.idx, 4)], bg), bg);
      const large = (x.l.text!.fontSize ?? 0) >= 24;
      const needC = large ? 3 : 4.5;
      if (c >= needC) continue;
      low++;
      const pick = bestInk(infos.filter(i => !i.group).map(i => i.fill).filter(f => (f[3] ?? 1) > 0.5), bg, needC);
      push('contrast', c < 1.5 || (c < 2.2 && !large) ? 'high' : x.piece || (x.l.text!.fontSize ?? 0) >= 72 ? 'low' : 'medium', `${nm(x.l)} has ${r2(c)}:1 contrast against ${hex(bg)} behind it (needs ${needC}:1)`, [x.l.id], [t, t],
        [{ tool: 'update_layer', args: { id: x.l.id, props: { fill: pick } } }]);
    }
  }

  // ================================================================ composition
  {
    let n = 0;
    for (const x of infos) {
      if (n >= 3 || x.group || isBg(x) || x.area <= 1) continue;
      const w = x.restBox[2] - x.restBox[0], h = x.restBox[3] - x.restBox[1];
      if (w >= 0.95 * W || h >= 0.95 * H || x.area > 0.6 * frame) continue;
      // at rest = not moving between consecutive samples
      let still = 0, end = false;
      for (let s = 1; s <= N; s++) {
        const o = outside(s, x.idx);
        if (G(s, x.idx, 4) < 0.1 || o < 0.12 || o > 0.97) continue;
        const moved = [0, 1, 2, 3].some(k => Math.abs(G(s, x.idx, k) - G(s - 1, x.idx, k)) > 0.5);
        if (!moved) still += D / N;
        if (s === N) end = true;
      }
      if (still < 0.4 && !end) continue;
      // a camera crop (the layer or a parent keyed ≥ 150%: a pull-back, a push-in) clips on purpose until it lands
      if (!end && [x.l, ...ancestors(store, x.l)].some(a => a.props.scale?.kf?.some(k => Math.max(...k.v) >= 150))) continue;
      n++;
      const [dx, dy] = intoFrame(x.restBox, W, H, 0.04);
      push('off-canvas', x.text || end ? 'high' : 'medium', `${nm(x.l)} sits ${Math.round(outsideBox(x.restBox, W, H) * 100)}% outside the frame ${end ? 'at the end' : `for ${r2(still)} s at rest`}`, [x.l.id], undefined, moveFix(store, x.l, dx, dy));
    }
    // title-safe: text within 5% of the edges (handbook: 90% title-safe)
    let m = 0;
    for (const x of infos) {
      if (m >= 2 || !x.text || x.piece || x.area <= 1) continue;
      const b = x.restBox, mx = W * 0.05, my = H * 0.05;
      if (outsideBox(b, W, H) > 0.12) continue;
      if (b[0] >= mx - 1 && b[1] >= my - 1 && b[2] <= W - mx + 1 && b[3] <= H - my + 1) continue;
      if (b[2] - b[0] > W * 0.9) continue;
      m++;
      const [dx, dy] = intoFrame(b, W, H, 0.055);
      push('safe-area', 'low', `${nm(x.l)} is outside the title-safe area (5% margin)`, [x.l.id], undefined, moveFix(store, x.l, dx, dy));
    }
    // one-axis growth that is anchored in the middle (bars should grow from the baseline)
    let g = 0;
    for (const x of infos) {
      if (g >= 3 || x.text || x.group) continue;
      const sz = x.l.props.size?.kf, sc = x.l.props.scale?.kf;
      const yGrow = (sc && sc.some(k => Math.abs(k.v[0] - k.v[1]) > 20) && edgeKey(sc, 1)) || (sz && sz.length >= 2 && Math.abs(sz[0].v[1] - sz[sz.length - 1].v[1]) > 30 && Math.abs(sz[0].v[0] - sz[sz.length - 1].v[0]) < 2);
      const xGrow = !yGrow && ((sc && sc.some(k => Math.abs(k.v[0] - k.v[1]) > 20) && edgeKey(sc, 0)) || (sz && sz.length >= 2 && Math.abs(sz[0].v[0] - sz[sz.length - 1].v[0]) > 30 && Math.abs(sz[0].v[1] - sz[sz.length - 1].v[1]) < 2));
      if (!yGrow && !xGrow) continue;
      const lo = yGrow ? 1 : 0, hi = yGrow ? 3 : 2;
      let minLo = Infinity, maxLo = -Infinity, minHi = Infinity, maxHi = -Infinity, ext = 0;
      // only while it grows / shrinks itself (a parent's nudge moves both edges and is not a growth)
      const spans = [sc, sz].flatMap(kf => (kf ?? []).slice(1).map((k, i) => [kf![i].t, k.t, +k.v.some((v, j) => Math.abs(v - kf![i].v[j]) > 1e-6)]).filter(q => q[2]));
      for (let s = 0; s <= N; s++) {
        if (G(s, x.idx, 4) < 0.05 || !spans.some(([a, b]) => times[s] >= a - 1e-6 && times[s] <= b + 1e-6)) continue;
        const a = G(s, x.idx, lo), b = G(s, x.idx, hi);
        if (b - a < 2) continue;
        minLo = Math.min(minLo, a); maxLo = Math.max(maxLo, a); minHi = Math.min(minHi, b); maxHi = Math.max(maxHi, b); ext = Math.max(ext, b - a);
      }
      if (!isFinite(minLo) || ext < 20) continue;
      const tol = Math.max(3, ext * 0.04);
      if (maxLo - minLo <= tol || maxHi - minHi <= tol) continue;
      g++;
      const edge = yGrow ? 'bottom' : 'left';
      const fix: ToolCall[] = sz && sz.length >= 2 && !(sc && sc.some(k => Math.abs(k.v[0] - k.v[1]) > 20))
        ? growFix(x.l, !!yGrow)
        : [{ tool: 'set_pivot', args: { id: x.l.id, at: edge } }];
      push('grow-middle', 'medium', `${nm(x.l)} grows ${yGrow ? 'up and down' : 'left and right'} from its middle: pin it to the ${edge} edge so it grows from the baseline`, [x.l.id], undefined, fix);
    }
  }

  // ================================================================ polish
  if (animated.length) {
    // secondary motion / follow-through
    const signals = all.filter(s => overshootSeg(s.a, s.b)).length + exprLayers
      + infos.filter(x => PHYS.some(k => (x.l.props[k]?.kf?.length ?? 0) >= 4)).length
      + Object.values(L).filter(l => l.type === 'group' && PHYS.some(k => (l.props[k]?.kf?.length ?? 0) >= 2) && l.children.some(c => infoById.get(c)?.segs.length)).length;
    const keyedOvershoot = all.some(s => { const kf = s.l.props[s.key]!.kf!; const n = kf[s.i + 2]; return !!n && n.t - s.b.t < 0.6 && s.b.v.some((v, j) => (v - s.a.v[j]) * (n.v[j] - v) < -1e-6); });
    if (D >= 3.5 && signals === 0 && !keyedOvershoot) {
      const ids = [primary, ...entering.filter(x => x !== primary)].filter(Boolean).slice(0, 3).map(x => x!.l.id).filter(id => infoById.get(id)?.segs.some(s => PHYS.includes(s.key)));
      push('no-secondary', D >= 6 ? 'high' : 'medium', `no follow-through, overshoot, settle or idle motion anywhere in ${ft(D)}: everything stops dead`, ids, undefined,
        ids.length ? [{ tool: 'secondary_motion', args: { ids, overshoot: 0.08, segments: 'first' } }] : []);
    }
    // fade-only pieces
    const movers = infos.filter(x => x.segs.length || x.expr || x.l.textAnim);
    const fadeOnly = movers.filter(x => !x.expr && !x.l.textAnim && x.segs.every(s => s.key === 'opacity'));
    if (movers.length >= 2 && fadeOnly.length / movers.length >= 0.6) {
      const ids = fadeOnly.slice(0, 6).map(x => x.l.id);
      const t = Math.min(...fadeOnly.map(x => x.first));
      push('fade-only', fadeOnly.length / movers.length >= 0.85 ? 'high' : 'medium', `${fadeOnly.length} of ${movers.length} animated layers only fade: give them a direction (rise 40-80 px, scale from 90%, a mask reveal)`, ids, undefined,
        [{ tool: 'apply_preset', args: { ids, preset: 'Slide up', t: r2(t), duration: 0.6, stagger: 0.08 } }]);
    }
    // loop seams
    if (loopy) {
      let n = 0;
      for (const x of animated) {
        if (n >= 3) break;
        for (const k of ['position', 'scale', 'rotation', 'opacity'] as PropKey[]) {
          const p = x.l.props[k];
          if (!p || (!(p.kf && p.kf.length > 1) && !p.expr)) continue;
          const a = propAt(store, x.l, k, 0), b = propAt(store, x.l, k, D);
          let d = 0; for (let j = 0; j < a.length; j++) d = Math.max(d, Math.abs(a[j] - b[j]));
          if (k === 'rotation') d = Math.min(d % 360, 360 - (d % 360));
          const tol = k === 'position' ? 2 : k === 'scale' ? 1 : k === 'rotation' ? 1 : 2;
          if (d <= tol) continue;
          n++;
          push('loop-seam', 'medium', `${nm(x.l)}.${k} jumps at the loop point (Δ${r1(d)} between 0 s and ${ft(D)})`, [x.l.id], [D, D],
            p.kf && p.kf.length > 1 && p.kf[p.kf.length - 1].t <= D + 1e-6 ? [{ tool: 'loop', args: { ids: [x.l.id], mode: 'cycle', duration: r2(D - p.kf[0].t) } }] : []);
          break;
        }
      }
    }
  }

  // richness: a piece needs enough going on for its length
  {
    const drawn = infos.filter(x => !x.group && !x.piece && x.area > 1 && !isBg(x));
    const pieces = infos.filter(x => x.piece).length;
    const elems = drawn.length + Math.min(3, Math.ceil(pieces / 3));
    const moves = all.filter(s => s.key !== 'opacity').length + exprLayers * 2 + infos.filter(x => x.l.textAnim).length * 2 + maskMoves;
    // a logo sting builds in ~2.5 s and then holds still on purpose: judge the build, not the hold
    const Dm = logo ? Math.min(D, 4) : D;
    const want = logo ? (D <= 2.5 ? 2 : 3) : D <= 2.5 ? 2 : D <= 6.5 ? 4 : D <= 12 ? 6 : 8;
    if (D >= 2 && (elems < want || moves < Dm * 1.2)) {
      const sev: Severity = elems <= want / 2 || moves < Dm * 0.6 ? 'high' : 'medium';
      push('thin', sev, `${elems} element${elems === 1 ? '' : 's'} and ${moves} moves for ${ft(D)}: add supporting elements (shapes, lines, a secondary label) and secondary motion so every beat has something to watch`, primary ? [primary.l.id] : [], undefined,
        primary && primary.segs.some(s => PHYS.includes(s.key)) ? [{ tool: 'secondary_motion', args: { ids: [primary.l.id], overshoot: 0.1, segments: 'all' } }] : []);
    }
  }

  // every element gets exactly one move (an entrance) and then sits still: "a checklist build"
  {
    const moversL = infos.filter(x => !x.group && !x.piece && !isBg(x) && (x.segs.length || x.expr || x.l.textAnim));
    const once = moversL.filter(x => !x.expr && !x.l.textAnim && new Set(x.segs.filter(sg => sg.key !== 'opacity' || x.segs.every(q => q.key === 'opacity')).map(sg => Math.round(sg.t0 * 10))).size <= 1 && x.segs.every(sg => sg.kind !== 'exit'));
    if (D >= 4 && moversL.length >= 3 && once.length / moversL.length >= 0.75 && !all.some(sg => overshootSeg(sg.a, sg.b))) {
      const ids = [primary, ...once.filter(x => x !== primary)].filter(Boolean).slice(0, 3).map(x => x!.l.id).filter(id => infoById.get(id)?.segs.some(sg => PHYS.includes(sg.key)));
      push('one-move', once.length / moversL.length >= 0.9 ? 'high' : 'medium', `${once.length} of ${moversL.length} elements move once and stop: give the hero a second beat (an accent, a settle, a transition) and overlap follow-through on the others`, ids, undefined,
        ids.length ? [{ tool: 'secondary_motion', args: { ids, overshoot: 0.1, segments: 'all' } }] : []);
    }
  }

  // ================================================================ polish (more)
  {
    // identical motion copy-pasted on several layers (same props, durations, eases, distances; only offset in time)
    const sig = new Map<string, Info[]>();
    for (const x of infos) {
      if (x.group || x.piece || (!x.segs.length && !x.expr)) continue;
      const t0 = x.segs.length ? Math.min(...x.segs.map(sg => sg.t0)) : 0;
      const parts = x.segs.map(sg => `${sg.key}:${r1(sg.t0 - t0)}:${r1(sg.t1 - sg.t0)}:${sg.ease}:${Math.round(sg.mag / 5)}`).sort();
      for (const k of PROP_KEYS) { const e = x.l.props[k]?.expr; if (e && EXPR_PROPS.includes(k) && !/index|seed|random/.test(e)) parts.push(`${k}~${e}`); }
      if (!parts.length) continue;
      // the same keys on elements of different sizes look different (bars of a chart): size is part of the signature
      const key = `${Math.round(Math.sqrt(x.area) / 25)}#` + parts.join('|');
      sig.set(key, [...(sig.get(key) ?? []), x]);
    }
    const movers = infos.filter(x => !x.group && !x.piece && (x.segs.length || x.expr)).length;
    const groups = [...sig.values()].filter(g => g.length >= 3 && g.length >= movers * 0.4).sort((a, b) => b.length - a.length);
    for (const g of groups.slice(0, 1)) {
      const alt = g.filter((_, i) => i % 2 === 1).map(x => x.l.id);
      const t0 = Math.min(...g.flatMap(x => x.segs.map(sg => sg.t0)), 0);
      push('copy-paste', g.length >= 5 ? 'high' : 'medium', `${g.length} layers run the exact same animation (${g.slice(0, 4).map(x => x.l.name).join(', ')}${g.length > 4 ? '…' : ''}): vary distance, timing or overshoot per element (hero bigger, followers smaller), offset phases`, g.map(x => x.l.id), undefined,
        alt.length ? [{ tool: 'retime', args: { ids: alt, scale: 1.25, pivot: r2(t0) } }] : []);
    }
    // the editor's default blue on a finished piece
    let n = 0;
    for (const x of infos) {
      if (n >= 2 || x.group || x.text || !['rect', 'ellipse', 'path'].includes(x.l.type) || x.l.paints?.some(pp => pp.stops)) continue;
      const f = x.l.props.fill?.v;
      if (!f || x.l.props.fill?.kf?.length || Math.abs(f[0] - 0.42) > 0.005 || Math.abs(f[1] - 0.55) > 0.005 || Math.abs(f[2] - 1) > 0.005 || (f[3] ?? 1) < 0.05) continue;
      let seen = false; for (let si = 0; si <= N && !seen; si++) seen = G(si, x.idx, 4) > 0.05;
      if (!seen) continue;
      n++;
      const stroked = valueAt(x.l, 'strokeWidth', 0)[0] > 0;
      push('default-fill', 'medium', `${nm(x.l)} still has the editor's default blue fill (#6b8cff)${stroked ? ' behind its stroke' : ''}`, [x.l.id], undefined,
        [{ tool: 'update_layer', args: { id: x.l.id, props: { fill: stroked ? '#00000000' : hex(primary && primary.l.id !== x.l.id && primary.fill[3] > 0.05 ? primary.fill : [0.07, 0.07, 0.07, 1]) } } }]);
    }
  }

  // ================================================================ technical
  {
    for (const x of infos) {
      const tr = (['trimStart', 'trimEnd', 'trimOffset'] as PropKey[]).filter(k => (x.l.props[k]?.kf?.length ?? 0) >= 2);
      if (!tr.length) continue;
      const kf = x.l.props[tr[0]]!.kf!;
      const strokeW = valueAt(x.l, 'strokeWidth', D)[0], strokeA = valueAt(x.l, 'stroke', D)[3] ?? 0;
      if (x.l.type !== 'path' || !x.l.trimOn) push('dead-trim', 'high', `${nm(x.l)} has draw-on (trim) keys that don't render on a ${x.l.type}${x.l.type === 'path' ? ' without Trim paths' : ''}`, [x.l.id], [kf[0].t, kf[kf.length - 1].t],
        [{ tool: 'draw_on', args: { ids: [x.l.id], t: r2(kf[0].t), duration: r2(kf[kf.length - 1].t - kf[0].t) } }]);
      else if (!(strokeW > 0) || strokeA < 0.05) push('dead-trim', 'high', `${nm(x.l)} draws on an invisible stroke (width ${r2(strokeW)})`, [x.l.id], [kf[0].t, kf[kf.length - 1].t],
        [{ tool: 'update_layer', args: { id: x.l.id, props: { strokeWidth: 4, stroke: hex(x.fill[3] > 0.05 ? x.fill : [1, 1, 1, 1]) } } }]);
    }
    let inv0 = 0;
    for (const x of infos) {
      if (inv0 >= 3 || x.group || !x.l.visible) continue;
      let peak = 0; for (let si = 0; si <= N; si++) if (outside(si, x.idx) < 0.97) peak = Math.max(peak, G(si, x.idx, 4));
      if (peak > 0.01) continue;
      if (x.l.type === 'text' && !x.l.text?.content.trim()) continue;
      inv0++;
      push('invisible', 'medium', `${nm(x.l)} is never visible (opacity/scale 0 or off-frame the whole time)`, [x.l.id], undefined, [{ tool: 'delete_layers', args: { ids: [x.l.id] } }]);
    }
    const seenF = new Set<string>();
    for (const x of infos) {
      if (!x.text) continue;
      const fams = String(x.l.text!.fontFamily ?? '').split(',').map(f => f.trim()).filter(Boolean);
      const first = fams[0];
      if (!first || seenF.has(first)) continue;
      if (fontOk(first)) continue;
      seenF.add(first);
      const serif = /serif|garamond|playfair|didot|bodoni|times|georgia|cormorant|baskerville|lora|merriweather/i.test(first) && !/sans/i.test(first);
      const ids = infos.filter(y => y.text && String(y.l.text!.fontFamily).startsWith(first)).map(y => y.l.id);
      push('font-fallback', 'high', `font "${first}" is not available: ${ids.length} text layer(s) render in a fallback`, ids, undefined,
        ids.slice(0, 4).map(id => ({ tool: 'update_layer', args: { id, text: { fontFamily: serif ? 'serif' : 'Inter' } } })));
    }
  }

  // ================================================================ brand
  {
    const cols: { c: number[]; id: string }[] = [];
    for (const x of infos) {
      if (x.group) continue;
      if (x.fill[3] > 0.05 && !(x.l.paints?.some(p => p.stops))) cols.push({ c: x.fill, id: x.l.id });
      for (const k of x.l.props.fill?.kf ?? []) cols.push({ c: k.v, id: x.l.id });
    }
    const chroma = cols.filter(({ c }) => { const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]); return mx - mn > 0.18; });
    const hues: number[][] = [];
    for (const { c } of chroma) if (!hues.some(h => Math.hypot(h[0] - c[0], h[1] - c[1], h[2] - c[2]) < 0.2)) hues.push(c);
    if (hues.length > 5) push('palette-drift', hues.length > 7 ? 'medium' : 'low', `${hues.length} different accent colors (${hues.slice(0, 6).map(hex).join(' ')}…): keep 1 accent + 1-2 support colors`, [], undefined, []);
    const P = store.project;
    const tokens = Object.values(P.tokens?.items ?? {}).filter((t: any) => t.type === 'color');
    if (tokens.length) {
      const tv = tokens.map((t: any) => ({ t, c: tokenColor(P, t) })).filter(x => x.c);
      const off = chroma.filter(({ c, id }) => !(L[id] && linkOf(L[id], 'fill')) && !tv.some(x => Math.hypot(x.c![0] - c[0], x.c![1] - c[1], x.c![2] - c[2]) < 0.08));
      const ids = [...new Set(off.map(o => o.id))];
      if (ids.length >= 2) {
        const nearest = (c: number[]) => tv.slice().sort((a, b) => Math.hypot(a.c![0] - c[0], a.c![1] - c[1], a.c![2] - c[2]) - Math.hypot(b.c![0] - c[0], b.c![1] - c[1], b.c![2] - c[2]))[0].t.name;
        const first = off[0];
        push('off-brand', ids.length >= 4 ? 'medium' : 'low', `${ids.length} layers use colors that are not in the brand styles (e.g. ${hex(first.c)})`, ids.slice(0, 8), undefined,
          [{ tool: 'link_style', args: { ids: ids.filter(id => { const c = off.find(o => o.id === id)!.c; return nearest(c) === nearest(first.c); }).slice(0, 8), prop: 'fill', style: nearest(first.c) } }]);
      }
    }
    const fams = new Map<string, string[]>();
    for (const x of infos) if (x.text && !x.piece) { const f = String(x.l.text!.fontFamily).split(',')[0].trim(); fams.set(f, [...(fams.get(f) ?? []), x.l.id]); }
    if (fams.size > 2) {
      const sorted = [...fams.entries()].sort((a, b) => b[1].length - a[1].length);
      const strays = sorted.slice(2).flatMap(([, ids]) => ids);
      push('font-drift', 'low', `${fams.size} font families (${sorted.map(f => f[0]).join(', ')}): one family (two at most) reads as a brand`, strays, undefined,
        strays.slice(0, 3).map(id => ({ tool: 'update_layer', args: { id, text: { fontFamily: sorted[0][0] } } })));
    }
  }

  // ================================================================ logo (a sting: one mark + a wordmark, ≤ 10 s)
  // measurable parts of the logo rubric (guides/logo-recipes.md, from a study of 249 professional logo
  // animations): lead-in, lock time, hold, length vs pace, wordmark delay and entry, snap, final move,
  // easing family, and whether the idea is more than pops and fades
  if (logo && animated.length) {
    const pace = opts.pace ?? 'medium';
    const lockArea = (() => { const b = unionBox([...logo.mark, ...logo.word].map(x => x.idx), N, G); return Math.max(1, (b[2] - b[0]) * (b[3] - b[1])); })();
    // tiny secondary bits (sparkles, specks) may keep moving through the hold
    const markL = logo.mark.filter(x => !x.group && x.area >= 0.02 * lockArea);
    const wordL = logo.word;
    const leavesAll = [...markL, ...wordL];
    // idle loops (expressions: breathing, wobble) may run through the hold: such a layer counts as settled
    // once its keyed motion is done
    const idle = (x: Info) => x.expr || ancestors(store, x.l).some(a => PHYS.some(k => a.props[k]?.expr?.trim()));
    const leaves = leavesAll.filter(x => !idle(x));
    const keyedEnd = (xs: Info[]) => Math.max(0, ...xs.filter(idle).flatMap(x => x.segs.map(sg => sg.t1)));
    const sz = (li: number, r: number) => Math.max(G(r, li, 2) - G(r, li, 0), G(r, li, 3) - G(r, li, 1));
    const same = (li: number, s: number, r: number) => {
      const oa = G(s, li, 4), ob = G(r, li, 4);
      if (oa < 0.05 && ob < 0.05) return true;
      if (Math.abs(oa - ob) > 0.1) return false;
      const tol = Math.max(4 * S, 0.03 * sz(li, r));
      for (let k = 0; k < 4; k++) if (Math.abs(G(s, li, k) - G(r, li, k)) > tol) return false;
      return true;
    };
    // the reference frame: the last frame with the whole lockup on screen (before a mirrored exit, if any)
    let rRef = N;
    const full = (s: number) => (!wordL.length || wordL.some(x => G(s, x.idx, 4) > 0.5)) && markL.filter(x => G(s, x.idx, 4) > 0.5).length >= Math.max(1, Math.ceil(markL.length * 0.8));
    while (rRef > 0 && !full(rRef)) rRef--;
    const exits = rRef < N - 1;
    const settledFrom = (list: Info[], r: number) => { let s = r; while (s > 0 && list.every(x => same(x.idx, s - 1, r))) s--; return s; };
    // with an exit, the lockup is the last still stretch (≥ 0.5 s) before it leaves
    if (exits) {
      const minRun = Math.max(1, Math.round((0.5 / D) * N));
      let r = rRef;
      while (r > 0) { const a = settledFrom(leaves, r); if (r - a >= minRun && full(a)) break; r = a - 1; }
      if (r > 0) rRef = r;
    }
    const stillMark = markL.filter(x => !idle(x));
    const lockS0 = leaves.length ? settledFrom(leaves, rRef) : 0, markS0 = stillMark.length ? settledFrom(stillMark, rRef) : lockS0;
    const lockT = Math.max(times[lockS0], keyedEnd(leavesAll)), markLand = Math.max(times[markS0], keyedEnd(markL));
    const lockS = sampleAt(lockT);
    const hold = (exits ? times[rRef] : D) - lockT;
    lockup = { lock: r2(lockT), hold: r2(hold) };
    // first keyed motion (idle expressions run from 0 by nature)
    const keyed = animated.flatMap(x => [...x.segs.map(sg => sg.t0), ...(x.l.textAnim ? [x.l.inPoint + x.l.textAnim.start] : []), ...(x.l.pathKf && x.l.pathKf.length > 1 ? [x.l.pathKf[0].t] : [])]);
    const fm = Math.min(keyed.length ? Math.min(...keyed) : firstMotion, ...markL.map(x => x.enterT >= 0 && isFinite(x.enterT) ? x.enterT : D));
    const build = lockT - fm;
    const ids = animated.map(x => x.l.id).slice(0, 24);
    // lead-in: almost nothing starts on frame 0 (median first motion 0.27 s)
    if (fm < 0.05 && !loopy) push('logo-lead-in', 'low', `the logo moves from frame 0: leave a 0.2-0.3 s blank (or still) lead-in so the first frame reads`, [], [0, 0.3],
      [{ tool: 'retime', args: { offset: 0.25 } }]);
    // lock: the idea is done by ~2.5 s (build 1.5-3 s); long builds lose the viewer
    const maxBuild = pace === 'fast' ? 2.6 : pace === 'calm' ? 3.8 : 3.2;
    if (build > maxBuild + 0.2) push('logo-lock', build > maxBuild + 1 ? 'medium' : 'low', `the lockup completes at ${ft(lockT)} (a ${r2(build)} s build): logo builds land in 1.5-3 s (idea done by ~2.5 s, wordmark 0.5-0.7 s after)`, ids, [fm, lockT],
      [{ tool: 'retime', args: { ids, pivot: r2(fm), scale: r2(Math.max(0.4, (maxBuild - 0.3) / build)) } }]);
    // hold: the exact lockup on screen ≥ 1.2 s (3+ identical frames of a 12-frame sheet), not a dead 3 s+
    if (hold < 1.2) push('logo-hold', hold < 0.6 ? 'high' : 'medium', `the finished lockup holds for ${r2(Math.max(0, hold))} s${exits ? ' before the exit' : ''}: hold it still ≥ 1.2 s (1.5-2 s; elegant 2.5 s) so it reads`, ids, [lockT, exits ? times[rRef] : D],
      exits ? [{ tool: 'retime', args: { from: r2(times[rRef] - 0.01), offset: r2(1.6 - hold) } }] : [{ tool: 'set_composition', args: { duration: r2(lockT + 1.7) } }]);
    // a long hold: the study's holds are 1.5-2.5 s; a slow creep through 3 s+ of nothing is still nothing
    const lastBig = Math.max(lockT, ...all.filter(sg => !(sg.t1 - sg.t0 > 1.5 && (sg.key === 'scale' ? sg.mag < 8 : sg.key === 'position' ? sg.mag < 20 * S : sg.key === 'rotation' ? sg.mag < 5 : true))).map(sg => sg.t1));
    const longHold = pace === 'calm' ? 3.6 : 3.1;
    if (!exits && !loopy && D - lastBig > longHold) push('logo-hold', D - lastBig > longHold + 1 ? 'medium' : 'low', `the lockup sits for ${r2(D - lastBig)} s after the last real move (${ft(lastBig)}): logo holds run 1.5-2 s (elegant 2.5 s); end the sting sooner instead of stretching the hold`, [], [lastBig, D],
      [{ tool: 'set_composition', args: { duration: r2(lastBig + (pace === 'calm' ? 2.4 : 2)) } }]);
    // length vs pace (medians 5-6 s; fast 4-5, elegant ≤ 7.5)
    const [lo, hi] = pace === 'fast' ? [3.5, 6.5] : pace === 'calm' ? [4.5, 9] : [4, 7.5];
    if (!loopy && (D > hi || D < lo)) push('logo-length', D > hi + 1.5 ? 'medium' : 'low', `the sting runs ${ft(D)}: ${pace} logo stings run ${lo}-${hi} s (lead-in 0.25 s, build to ~2.5 s, wordmark, hold 1.5-2 s)`, [], [0, D],
      [{ tool: 'set_composition', args: { duration: r2(Math.min(hi, Math.max(lo, lockT + 1.8 + (exits ? D - times[rRef] : 0)))) } }]);
    // wordmark: a separate beat 0.4-0.8 s after the mark lands, ideally out of the mark
    const wIdx = wordL.map(x => x.idx);
    let ws = -1;
    for (let s = 0; s <= N && ws < 0; s++) if (wIdx.some(li => G(s, li, 4) > 0.05 && outside(s, li) < 0.97)) ws = s;
    if (wordL.length && markL.length && ws > 0) {
      const wStart = Math.min(times[ws], ...wordL.flatMap(x => x.segs.filter(sg => sg.kind === 'enter').map(sg => sg.t0)), ...wordL.filter(x => x.l.textAnim).map(x => x.l.inPoint + x.l.textAnim!.start));
      const delay = wStart - markLand;
      const wids = logo.wordIds;
      if (delay < -0.6 && markLand - fm > 0.8) push('logo-wordmark-timing', 'medium', `the wordmark starts at ${ft(wStart)}, ${r2(-delay)} s before the mark lands (${ft(markLand)}): let the mark finish its idea, then the wordmark 0.4-0.8 s later as its own beat`, wids, [wStart, markLand],
        [{ tool: 'retime', args: { ids: wids, offset: r2(markLand + 0.5 - wStart) } }]);
      else if (delay > 1.6) push('logo-wordmark-timing', 'low', `the wordmark waits ${r2(delay)} s after the mark lands: bring it in 0.4-0.8 s after (0.45 s fast, 0.8 s elegant)`, wids, [markLand, wStart],
        [{ tool: 'retime', args: { ids: wids, offset: r2(markLand + 0.6 - wStart) } }]);
      // entry: from behind the mark under a mask, out of the mark, or built letter by letter, not a plain fade / pop
      const clipped = wordL.some(x => masked.has(x.l.id) || ancestors(store, x.l).some(a => a.clip || masked.has(a.id)));
      const mb = unionBox(markL.map(x => x.idx), lockS, G), mc = [(mb[0] + mb[2]) / 2, (mb[1] + mb[3]) / 2];
      const wb0 = unionBox(wIdx, ws, G), wb1 = unionBox(wIdx, lockS, G);
      const d0 = Math.hypot((wb0[0] + wb0[2]) / 2 - mc[0], (wb0[1] + wb0[3]) / 2 - mc[1]), d1 = Math.hypot((wb1[0] + wb1[2]) / 2 - mc[0], (wb1[1] + wb1[3]) / 2 - mc[1]);
      // out of the mark = it travels away from the mark a real distance (a 40-60 px nudge beside a fade is not)
      const outOfMark = d1 - d0 > Math.max(110 * S, 0.3 * (wb1[2] - wb1[0]));
      const built = wordL.some(x => x.l.textAnim) || wordL.filter(x => x.segs.length).length >= 3;
      const moves = wordL.some(x => x.segs.some(sg => sg.kind === 'enter' && sg.key !== 'opacity' && !(sg.key === 'scale' && Math.abs(sg.a.v[0] - sg.a.v[1]) < 1)));
      if (!clipped && !outOfMark && !built) {
        const from = (markL.length > 1 && logo.markGroup) ? logo.markGroup : markL.slice().sort((a, b) => b.area - a.area)[0].l.id;
        const fades = wordL.some(x => x.segs.some(sg => sg.key === 'opacity' && sg.kind === 'enter'));
        push('logo-wordmark-entry', moves && !fades ? 'low' : 'medium', `the wordmark ${moves ? (fades ? 'fades in with a small nudge beside the mark' : 'slides in on its own') : 'only fades / pops in'}: let it come out of the mark (slide out from behind it under a mask while the mark makes room, grow from a glyph, or build from the same parts)`, wids, [wStart, wStart + 0.6],
          [{ tool: 'rig', args: { kind: 'reveal-from', ids: wids.slice(0, 1), t0: r2(Math.max(wStart, markLand + 0.4)), duration: 0.6, options: { from } } }]);
      }
    }
    // the idea: something becomes / does something (draw-on, morph, hinge, assemble, a mask reveal, a pivoted
    // turn, a pull-back) rather than every part popping or fading in
    const kinds = markL.map(x => techniqueOf(store, x, masked));
    const anim = kinds.filter(k => k !== 'static');
    const generic = anim.filter(k => k === 'pop' || k === 'fade').length;
    const groupMoves = logo.markGroup && L[logo.markGroup] && PHYS.some(k => (L[logo.markGroup!].props[k]?.kf?.length ?? 0) >= 2 && L[logo.markGroup!].props[k]!.kf!.some((q, i, a) => i > 0 && q.v.some((v, j) => Math.abs(v - a[0].v[j]) > 25)));
    if (anim.length && !groupMoves && generic / anim.length >= 0.7) push('logo-generic', generic === anim.length ? 'high' : 'medium', `${generic} of ${anim.length} parts of the mark just ${kinds.includes('pop') ? 'pop / scale in' : 'fade in'}: no idea from the mark itself. Pick a concept family that comes from its form or meaning (assemble, draw, transform, the object's own action, a pull-back) — get_guide "logo-recipes"`, markL.map(x => x.l.id).slice(0, 8), [fm, markLand],
      [{ tool: 'get_guide', args: { name: 'logo-recipes' } }]);
    // snap and settle: arrivals decelerate hard (expo / quart / spring) unless the piece is calm and soft
    const arrivals = all.filter(sg => markL.some(x => x.l.id === sg.l.id) && PHYS.includes(sg.key) && sg.kind !== 'exit' && sg.a.interp !== 'hold' && sg.t1 <= lockT + 0.05 && (sg.key === 'position' ? sg.mag >= 30 * S : sg.mag >= 12));
    const springy = arrivals.some(sg => overshootSeg(sg.a, sg.b) || sg.a.interp === 'spring');
    const soft = arrivals.filter(sg => sg.s0 < 0.8 && !overshootSeg(sg.a, sg.b) && sg.a.interp !== 'spring');
    if (pace !== 'calm' && arrivals.length >= 2 && !springy && soft.length / arrivals.length >= 0.6) push('logo-snap', 'low', `${soft.length} of ${arrivals.length} mark moves drift in symmetrically (${[...new Set(soft.map(s => s.ease))].slice(0, 3).join(', ')}): logos snap (Expo / Quart Out arrivals, then dead still) or spring; soft Sine In Out only for calm / elegant pieces`, [...new Set(soft.map(s => s.l.id))].slice(0, 6), undefined,
      soft.slice(0, 3).map(sg => ({ tool: 'set_easing', args: { id: sg.l.id, prop: sg.key, indices: [sg.i], ease: 'Expo Out' } })));
    // the final move is small (a 20-60 px nudge, a settle), not a big landing
    const lastMoves = all.filter(sg => leaves.some(x => x.l.id === sg.l.id) && PHYS.includes(sg.key) && sg.kind !== 'exit' && sg.a.interp !== 'hold' && sg.t1 <= lockT + 0.05 && sg.t1 >= lockT - 0.35);
    const bigLast = lastMoves.filter(sg => (sg.key === 'position' ? sg.mag >= 300 * S : sg.key === 'scale' ? sg.mag >= 60 : sg.mag >= 90) && !overshootSeg(sg.a, sg.b) && sg.a.interp !== 'spring');
    if (lastMoves.length && bigLast.length === lastMoves.length) push('logo-final-move', 'low', `the lockup ends on a big move (${nm(bigLast[0].l)}.${bigLast[0].key}): finish with a small 20-60 px nudge or a settle, then rest`, [bigLast[0].l.id], [bigLast[0].t0, bigLast[0].t1],
      [{ tool: 'secondary_motion', args: { ids: [bigLast[0].l.id], overshoot: 0.06, segments: 'last' } }]);
    // one easing family (snappy expo / soft sine / springs); settles and small follow-ups don't count
    const fam = new Map<string, number>();
    for (const sg of all) {
      if (!PHYS.includes(sg.key) || sg.a.interp === 'hold' || sg.kind === 'exit') continue;
      const kf = sg.l.props[sg.key]!.kf!;
      let big = 0; for (let k = 0; k < kf.length - 1; k++) { let m = 0; for (let j = 0; j < kf[k].v.length; j++) m += (kf[k + 1].v[j] - kf[k].v[j]) ** 2; big = Math.max(big, Math.sqrt(m)); }
      if (sg.mag * (sg.key === 'scale' ? Math.SQRT2 : 1) < 0.3 * big) continue;
      const f = easeFamily(sg);
      if (f) fam.set(f, (fam.get(f) ?? 0) + 1);
    }
    const tot = [...fam.values()].reduce((a, b) => a + b, 0);
    const mixed = [...fam.entries()].filter(([, n]) => n / Math.max(1, tot) >= 0.2);
    if (tot >= 6 && mixed.length >= 3) push('logo-ease-family', 'low', `the moves mix ${mixed.map(([f, n]) => `${f} ${n}`).join(', ')}: one easing family per logo (followers reuse the lead's ease 0.03-0.1 s later)`, [], undefined, []);
  }

  // ================================================================ music
  let hasMusic = false;
  try { hasMusic = musicCheck(store, all, fps, push); } catch { /* no analysis */ }

  // ---------------------------------------------------------------- score
  const sub = {} as Record<Category, number>;
  const pen = {} as Record<Category, number>;
  for (const c of CATEGORIES) { sub[c] = 100; pen[c] = 0; }
  for (const i of issues) { sub[i.category] = Math.max(0, sub[i.category] - i.penalty); pen[i.category] += i.penalty; }
  const score = animated.length ? scoreOf(pen, hasMusic) : infos.length ? 30 : 0;
  // order: severity, then penalty
  const rank = (i: Issue) => SEV[i.severity] * 10 + i.penalty;
  let list = issues.slice().sort((a, b) => rank(b) - rank(a));
  if (opts.range) { const [a, b] = opts.range; list = list.filter(i => !i.t || (i.t[1] >= a - 0.05 && i.t[0] <= b + 0.05)); }
  return {
    score, sub, penalties: pen, issues: list.slice(0, opts.max ?? 12),
    stats: { layers: infos.length, animated: animated.length, segments: all.length, samples: N + 1, lastMotion: r2(lastMotion), logo: !!logo, lockup, ms: Math.round(((globalThis.performance ?? Date).now() - t0) * 10) / 10 },
  };
}

// ---------------------------------------------------------------- pieces

interface LogoParts { mark: Info[]; word: Info[]; wordIds: string[]; markGroup?: string }
const LOGO_NAME = /logo|lockup|wordmark|sting|brand ?mark/i;

/** a logo sting: a mark (shapes) and a short, big wordmark forming one lockup near the centre, ≤ 10 s */
function detectLogo(store: Store, infos: Info[], isBg: (x: Info) => boolean, D: number, W: number, H: number, S: number, force?: boolean): LogoParts | null {
  if (force === false) return null;
  const L = store.project.layers;
  const hint = LOGO_NAME.test(store.comp.name) || infos.some(x => LOGO_NAME.test(x.l.name));
  if (!force && D > 10.5) return null;
  const texts = infos.filter(x => x.text && x.l.text!.content.trim());
  const units: { leaves: Info[]; size: number; words: number; content: string }[] = [];
  for (const x of texts.filter(t => !t.piece)) {
    const size = x.l.text!.fontSize ?? 0, content = x.l.text!.content.trim(), cy = (x.restBox[1] + x.restBox[3]) / 2;
    // single letters set by hand on one baseline (a word with shapes standing in for some letters) are one wordmark
    const join = content.length <= 2 ? units.find(u => u.content.length <= 12 && Math.abs(u.size - size) < 1 && u.leaves.every(y => y.l.text!.content.trim().length <= 2 && Math.abs((y.restBox[1] + y.restBox[3]) / 2 - cy) < 0.5 * size)) : undefined;
    if (join) { join.leaves.push(x); join.content += content; continue; }
    units.push({ leaves: [x], size, words: content.split(/\s+/).length, content });
  }
  const byParent = new Map<string, Info[]>();
  for (const x of texts.filter(t => t.piece)) byParent.set(x.l.parent ?? '', [...(byParent.get(x.l.parent ?? '') ?? []), x]);
  for (const [, ps] of byParent) units.push({ leaves: ps, size: Math.max(...ps.map(p => p.l.text!.fontSize ?? 0)), words: 1, content: ps.map(p => p.l.text!.content).join('') });
  const totalWords = units.reduce((a, u) => a + u.words, 0);
  const mark = infos.filter(x => !x.text && !x.group && !isBg(x) && x.area > 1 && !x.l.mask);
  if (!mark.length || (!force && (mark.length > (hint ? 30 : 16) || units.length > 3 || totalWords > 8))) return null;
  const cand = units.filter(u => u.words <= 3).sort((a, b) => b.size - a.size)[0];
  // the wordmark is big and dominant (taglines ≤ 0.65 of it); UI labels and lower thirds are smaller
  if (!force && units.length && (!cand || cand.size < (hint ? 48 : 80) * S || units.some(u => u !== cand && u.size > 0.65 * cand.size))) return null;
  if (!force && !units.length && !hint) return null;
  const word = cand?.leaves ?? [];
  // a card / panel behind the wordmark makes it a UI or a title card, not a lockup
  if (!force && word.length) {
    const wb = word.reduce((b, x) => [Math.min(b[0], x.restBox[0]), Math.min(b[1], x.restBox[1]), Math.max(b[2], x.restBox[2]), Math.max(b[3], x.restBox[3])], [Infinity, Infinity, -Infinity, -Infinity]);
    const wc = [(wb[0] + wb[2]) / 2, (wb[1] + wb[3]) / 2], wa = (wb[2] - wb[0]) * (wb[3] - wb[1]);
    if (mark.some(x => x.restBox[0] <= wc[0] && x.restBox[2] >= wc[0] && x.restBox[1] <= wc[1] && x.restBox[3] >= wc[1] && x.area > 3 * wa)) return null;
  }
  // one lockup: the mark and the wordmark sit together around the middle of the frame
  const box = (xs: Info[]) => xs.reduce((b, x) => [Math.min(b[0], x.restBox[0]), Math.min(b[1], x.restBox[1]), Math.max(b[2], x.restBox[2]), Math.max(b[3], x.restBox[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  const mb = box(mark), all = box([...mark, ...word]);
  const cx = (all[0] + all[2]) / 2, cy = (all[1] + all[3]) / 2;
  if (!force && !hint && (cx < 0.2 * W || cx > 0.8 * W || cy < 0.25 * H || cy > 0.75 * H)) return null;
  if (!force && (mb[2] - mb[0]) * (mb[3] - mb[1]) < 0.003 * W * H) return null;
  if (!force && word.length) {
    const wb = box(word);
    const gap = Math.max(0, Math.max(wb[0], mb[0]) - Math.min(wb[2], mb[2]), Math.max(wb[1], mb[1]) - Math.min(wb[3], mb[3]));
    if (gap > 0.35 * W) return null;
  }
  // the mark's own group (common ancestor that doesn't hold the wordmark)
  const anc = (l: Layer) => ancestors(store, l).map(a => a.id);
  let common = anc(mark[0].l);
  for (const x of mark.slice(1)) { const a = new Set(anc(x.l)); common = common.filter(id => a.has(id)); }
  const wordAnc = new Set(word.flatMap(x => anc(x.l)));
  const markGroup = common.find(id => !wordAnc.has(id) && L[id]);
  return { mark, word, wordIds: word.map(x => x.l.id), markGroup };
}

function ancestors(store: Store, l: Layer): Layer[] {
  const out: Layer[] = [];
  for (let c = l.parent ? store.project.layers[l.parent] : undefined; c; c = c.parent ? store.project.layers[c.parent] : undefined) out.push(c);
  return out;
}

function unionBox(idxs: number[], s: number, G: (s: number, l: number, k: number) => number): number[] {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const li of idxs) { if (G(s, li, 4) <= 0.02) continue; b[0] = Math.min(b[0], G(s, li, 0)); b[1] = Math.min(b[1], G(s, li, 1)); b[2] = Math.max(b[2], G(s, li, 2)); b[3] = Math.max(b[3], G(s, li, 3)); }
  return isFinite(b[0]) ? b : [0, 0, 0, 0];
}

/** how a part of a mark comes alive: a transformation / action, or a generic pop / fade (or nothing) */
function techniqueOf(store: Store, x: Info, masked: Set<string>): 'transform' | 'pop' | 'fade' | 'static' {
  const l = x.l;
  if (masked.has(l.id) || (l.pathKf?.length ?? 0) >= 2) return 'transform';
  if ((['trimStart', 'trimEnd', 'trimOffset'] as PropKey[]).some(k => (l.props[k]?.kf?.length ?? 0) >= 2)) return 'transform';
  if ((['position', 'rotation', 'scale'] as PropKey[]).some(k => l.props[k]?.expr?.trim())) return 'transform';
  for (const a of ancestors(store, l)) for (const k of PHYS) { const kf = a.props[k]?.kf; if (kf && kf.length > 1 && kf.some((q, i) => i > 0 && q.v.some((v, j) => Math.abs(v - kf[0].v[j]) > (k === 'position' ? 40 : 15)))) return 'transform'; }
  const segs = x.segs.filter(sg => sg.a.interp !== 'hold' || sg.key !== 'opacity');
  if (!segs.length) return 'static';
  let pop = false;
  for (const sg of segs) {
    if (sg.key === 'position' && sg.mag >= 40) return 'transform';
    if (sg.key === 'rotation' && sg.mag >= 15) return 'transform';
    if (sg.key === 'size' || sg.key === 'radius') return 'transform';
    if (sg.key === 'scale') {
      if (Math.abs(sg.a.v[0] - sg.a.v[1]) > 8 || Math.abs(sg.b.v[0] - sg.b.v[1]) > 8 || Math.max(sg.a.v[0], sg.b.v[0]) > 150) return 'transform';
      // scaled from a pivot that is not its centre (grows from a base, a tail, a hinge)
      const an = valueAt(l, 'anchor', sg.t1), [w, h] = layerSize(store, l, sg.t1);
      if (w > 0 && h > 0 && (Math.abs(an[0] - w / 2) > 0.2 * w || Math.abs(an[1] - h / 2) > 0.2 * h)) return 'transform';
      pop = true;
    }
  }
  return pop ? 'pop' : 'fade';
}

/** easing family of an arrival: snappy (fast start, hard stop), soft (symmetric), spring (overshoot) */
function easeFamily(sg: Seg): string | null {
  if (sg.a.interp === 'spring' || overshootSeg(sg.a, sg.b)) return 'spring';
  if (sg.a.interp === 'linear') return 'linear';
  if (sg.s0 >= 1.5 && sg.s1 <= 0.35) return 'snappy';
  if (sg.s0 < 1 && sg.s1 < 1) return 'soft';
  return null;
}

/** overall score from the penalty points per category (also used by calibration with other weights) */
export function scoreOf(pen: Record<Category, number>, music = true, w: Record<Category, number> = CAT_WEIGHTS, half = HALF): number {
  let P = 0;
  for (const c of CATEGORIES) if (c !== 'music' || music) P += (pen[c] ?? 0) * w[c];
  return Math.round(100 * Math.pow(0.5, P / half));
}

/** a growth from (or shrink to) ~0 on one axis at the start or end of the track; a squash in the middle
 *  (a blink, a squash on landing) that comes back is not a growth */
function edgeKey(kf: Keyframe[], j: number): boolean {
  return kf[0].v[j] < 30 || kf[kf.length - 1].v[j] < 30;
}

function unitsOf(l: Layer): number {
  const c = l.text?.content ?? '';
  const by = l.textAnim?.by;
  return by === 'char' ? c.replace(/\s/g, '').length : by === 'word' ? c.trim().split(/\s+/).length : c.split('\n').length;
}

function pickPrimary(list: Info[]): Info | undefined {
  let best: Info | undefined, bw = 0;
  for (const x of list) {
    const fs = x.l.text?.fontSize ?? 0;
    const w = Math.sqrt(x.area) * (x.text ? (fs >= 96 ? 1.5 : 0.7) : 1) * (x.segs.length || x.expr ? 1 : 0.5);
    if (w > bw) { bw = w; best = x; }
  }
  return best;
}

/** hero first, then top-to-bottom, left-to-right */
function readingOrder(list: Info[], primary?: Info): string[] {
  const rest = list.filter(x => x !== primary).sort((a, b) => (Math.abs(a.restBox[1] - b.restBox[1]) > 40 ? a.restBox[1] - b.restBox[1] : a.restBox[0] - b.restBox[0]));
  return [...(primary && list.includes(primary) ? [primary] : []), ...rest].map(x => x.l.id);
}

function detectLoop(store: Store, infos: Info[], D: number): boolean {
  if (/\bloop/i.test(store.comp.name)) return true;
  let periodic = 0, tracks = 0, closed = 0;
  for (const x of infos) for (const k of PROP_KEYS) {
    const p = x.l.props[k];
    if (p?.expr && /loopOut|loop_out|Math\.(sin|cos)\s*\(\s*\(?\s*time/i.test(p.expr)) periodic++;
    const kf = p?.kf;
    if (kf && kf.length >= 2 && kf.some((q, i) => i > 0 && q.v.some((v, j) => Math.abs(v - kf[0].v[j]) > 1e-6))) { tracks++; if (kf[0].t <= 0.05 && kf[kf.length - 1].t >= D - 0.05 && kf[kf.length - 1].v.every((v, j) => Math.abs(v - kf[0].v[j]) < 1e-3)) closed++; }
  }
  // periodic idle wobble on top of entrances is not a loop: only when nothing else is keyed
  return (periodic >= 2 && closed >= tracks * 0.6) || (tracks >= 2 && closed / tracks >= 0.6);
}

function outsideBox(b: number[], W: number, H: number) {
  const a = (b[2] - b[0]) * (b[3] - b[1]);
  if (a <= 0) return 0;
  const ix = Math.max(0, Math.min(b[2], W) - Math.max(b[0], 0)), iy = Math.max(0, Math.min(b[3], H) - Math.max(b[1], 0));
  return 1 - (ix * iy) / a;
}

/** comp-space shift that brings a box inside the frame with a margin (fraction of the frame) */
function intoFrame(b: number[], W: number, H: number, m: number): [number, number] {
  const mx = W * m, my = H * m;
  const w = b[2] - b[0], h = b[3] - b[1];
  let dx = 0, dy = 0;
  if (w > W - 2 * mx) dx = W / 2 - (b[0] + b[2]) / 2; else if (b[0] < mx) dx = mx - b[0]; else if (b[2] > W - mx) dx = W - mx - b[2];
  if (h > H - 2 * my) dy = H / 2 - (b[1] + b[3]) / 2; else if (b[1] < my) dy = my - b[1]; else if (b[3] > H - my) dy = H - my - b[3];
  return [Math.round(dx), Math.round(dy)];
}

/** the tool call that moves a layer by a comp-space offset (static: update_layer; keyed: every position key) */
function moveFix(store: Store, l: Layer, dx: number, dy: number): ToolCall[] {
  if (!dx && !dy) return [];
  // comp-space delta into the parent's space
  let d = [dx, dy];
  if (l.parent) {
    const m = parentMatrix(store, l);
    const im = inv(m);
    d = [im[0] * dx + im[2] * dy, im[1] * dx + im[3] * dy];
  }
  const kf = l.props.position?.kf;
  if (kf && kf.length) return [{ tool: 'set_keyframes', args: { id: l.id, prop: 'position', keyframes: toolKeys(kf, v => [v[0] + d[0], v[1] + d[1]]) } }];
  const p = valueAt(l, 'position', 0);
  return [{ tool: 'update_layer', args: { id: l.id, props: { position: [Math.round(p[0] + d[0]), Math.round(p[1] + d[1])] } } }];
}

function parentMatrix(store: Store, l: Layer): number[] {
  let m = [1, 0, 0, 1, 0, 0];
  for (let cur = l.parent ? store.layer(l.parent) : undefined; cur; cur = cur.parent ? store.layer(cur.parent) : undefined) {
    const s = valueAt(cur, 'scale', 0), r = valueAt(cur, 'rotation', 0)[0] * Math.PI / 180;
    const c = Math.cos(r), sn = Math.sin(r);
    const A = c * s[0] / 100, B = sn * s[0] / 100, C = -sn * s[1] / 100, Dd = c * s[1] / 100;
    m = [A * m[0] + C * m[1], B * m[0] + Dd * m[1], A * m[2] + C * m[3], B * m[2] + Dd * m[3], 0, 0];
  }
  return m;
}

/** size keys growing from the middle: matching position keys (same times and eases) keep the far edge fixed */
function growFix(l: Layer, vertical: boolean): ToolCall[] {
  const sz = l.props.size!.kf!;
  const an = valueAt(l, 'anchor', sz[sz.length - 1].t);
  const pos = l.props.position?.kf?.length ? null : valueAt(l, 'position', 0);
  if (!pos) return [{ tool: 'set_pivot', args: { id: l.id, at: vertical ? 'bottom' : 'left' } }];
  const last = sz[sz.length - 1].v;
  // edge to keep: bottom (vertical) = pos.y - an.y + h_final; left (horizontal) = pos.x - an.x
  const keep = vertical ? pos[1] - an[1] + last[1] : pos[0] - an[0];
  return [{ tool: 'set_keyframes', args: { id: l.id, prop: 'position', keyframes: toolKeys(sz, v => vertical ? [pos[0], keep + an[1] - v[1]] : [keep + an[0], pos[1]]) } }];
}

function colorBehind(store: Store, infos: Info[], x: Info, s: number, cx: number, cy: number, G: (s: number, l: number, k: number) => number, bg0: number[]): number[] {
  let col = bg0.slice(0, 3).concat(1);
  for (const y of infos) {
    if (y.idx >= x.idx || y.text || y.fill[3] < 0.05) continue;
    if (!['rect', 'ellipse', 'path'].includes(y.l.type)) continue;
    const o = G(s, y.idx, 4);
    if (o < 0.05 || cx < G(s, y.idx, 0) || cx > G(s, y.idx, 2) || cy < G(s, y.idx, 1) || cy > G(s, y.idx, 3)) continue;
    const st = y.l.paints?.find(p => p.stops)?.stops;
    const f = st ? [0, 1, 2, 3].map(i => st.reduce((a, q) => a + q.color[i], 0) / st.length) : y.fill;
    col = over([f[0], f[1], f[2], (f[3] ?? 1) * o], col);
  }
  void store;
  return col;
}

function bestInk(palette: number[][], bg: number[], need: number): string {
  const cands = [...palette, [1, 1, 1, 1], [0.067, 0.067, 0.067, 1]];
  const ok = cands.filter(c => contrast(c, bg) >= need);
  const pick = (ok.length ? ok : cands).sort((a, b) => contrast(b, bg) - contrast(a, bg))[ok.length ? Math.min(ok.length - 1, 0) : 0];
  return hex(pick);
}

function tokenColor(P: any, t: any): number[] | null {
  const v = tokenValue(P.tokens, t);
  return Array.isArray(v) && v.length >= 3 ? v : null;
}

/** music: big moves land on the beat grid, not every beat. returns whether there was music */
function musicCheck(store: Store, all: Seg[], fps: number, push: (rule: string, sev: Severity, msg: string, layers: string[], t: [number, number] | undefined, fix?: ToolCall[]) => void): boolean {
  const m = music(store);
  if (!m) return false;
  const bt = beats(m);
  if (bt.length < 4) return false;
  const tol = 1.5 / fps;
  const near = (t: number) => { let lo = 0, hi = bt.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (bt[mid] < t) lo = mid + 1; else hi = mid; } return Math.min(Math.abs(bt[lo] - t), lo > 0 ? Math.abs(bt[lo - 1] - t) : Infinity) <= tol; };
  const big = all.filter(s => (s.key === 'position' && s.mag >= 80) || (s.key === 'scale' && s.mag >= 25) || (s.key === 'rotation' && s.mag >= 30));
  if (big.length >= 4) {
    const on = big.filter(s => near(s.t1) || near(s.t0)).length / big.length;
    if (on < 0.5) push('off-beat', on < 0.25 ? 'high' : 'medium', `${Math.round((1 - on) * 100)}% of the ${big.length} big moves land off the beat`, [...new Set(big.map(s => s.l.id))].slice(0, 8), undefined, [{ tool: 'sync_to_audio', args: { mode: 'beats' } }]);
  }
  const lands = all.filter(s => s.key !== 'opacity').map(s => s.t1);
  const span = bt.filter(t => t >= Math.min(...lands, Infinity) && t <= Math.max(...lands, -Infinity));
  if (span.length >= 8) {
    const hit = span.filter(t => lands.some(e => Math.abs(e - t) <= tol)).length / span.length;
    if (hit >= 0.9) push('every-beat', 'low', `something lands on ${Math.round(hit * 100)}% of the beats: let downbeats and accents carry the big moves, rest between them`, [], [span[0], span[span.length - 1]], [{ tool: 'sync_to_audio', args: { mode: 'bars' } }]);
  }
  return true;
}

// ---------------------------------------------------------------- text output

/** compact text for the agent: score line, then the fixes in priority order with exact tool calls */
export function formatCritique(c: Critique, opts: { max?: number; calls?: boolean } = {}): string {
  const subs = CATEGORIES.filter(k => c.sub[k] < 100).map(k => `${k} ${Math.round(c.sub[k])}`).join(', ');
  const lines = [`score ${c.score}/100${subs ? ` (${subs})` : ' (no issues found)'}`];
  if (c.stats.lockup) lines.push(`logo sting: lockup complete at ${c.stats.lockup.lock}s, held ${c.stats.lockup.hold}s (aim: idea done by ~2.5 s, hold 1.5-2 s; recipes: get_guide "logo-recipes")`);
  c.issues.slice(0, opts.max ?? 8).forEach((i, n) => {
    lines.push(`${n + 1}. [${i.severity}] ${i.message}`);
    if (opts.calls !== false) for (const f of i.fix) lines.push(`   → ${f.tool} ${JSON.stringify(f.args)}`);
  });
  return lines.join('\n');
}
