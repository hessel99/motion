// compact, token-friendly text descriptions of animation for the agent (and for the ui diff).
// one line per animated property:  scale: 0.2s 0 ─Back Out→ 0.8s 100 ─hold→ 1.2s 90
// numbers are rounded, equal vector components collapse ([100,100] → 100), colors print as hex.

import type { Keyframe, Layer, PropKey } from '../core/model';
import { PROP_DEFS, PROP_KEYS } from '../core/model';
import { EASE_PRESETS, SPRING_PRESETS } from '../core/easing';

const r2 = (x: number) => Math.round(x * 100) / 100;

export function fmtTime(t: number) { return `${r2(t)}s`; }

function hex2(x: number) { return Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0'); }

export function fmtValue(key: PropKey, v: number[]): string {
  if (PROP_DEFS[key].unit === 'color') return '#' + hex2(v[0]) + hex2(v[1]) + hex2(v[2]) + ((v[3] ?? 1) < 0.999 ? hex2(v[3]) : '');
  const r = v.map(r2);
  if (r.length === 1 || r.every(x => x === r[0])) return String(r[0]);
  return `[${r.join(',')}]`;
}

/** name the ease of the segment leaving key a and arriving at key b */
export function easeName(a: Keyframe, b?: Keyframe): string {
  if (a.interp === 'hold') return 'hold';
  if (a.interp === 'linear') return 'linear';
  if (a.interp === 'spring') {
    const p = SPRING_PRESETS.find(s => Math.abs(s.bounce - (a.bounce ?? 0)) < 0.01);
    return p ? `spring ${p.name}` : `spring:${r2(a.bounce ?? 0)}`;
  }
  const v = [a.out[0], a.out[1], b?.in[0] ?? 0.667, b?.in[1] ?? 1];
  const p = EASE_PRESETS.find(p => p.v.every((x, i) => Math.abs(x - v[i]) < 0.02));
  return p ? p.name : `[${v.map(r2).join(',')}]`;
}

export function describeTrack(key: PropKey, kf: Keyframe[]): string {
  let s = '';
  for (let i = 0; i < kf.length; i++) {
    const k = kf[i];
    s += `${fmtTime(k.t)} ${fmtValue(key, k.v)}`;
    if (i < kf.length - 1) s += ` ─${easeName(k, kf[i + 1])}→ `;
  }
  return s;
}

/** multi-line description of one layer's animation. returns '' when nothing is animated (unless `always`) */
export function describeLayerAnimation(l: Layer, opts: { always?: boolean; props?: PropKey[] } = {}): string {
  const lines: string[] = [];
  for (const key of opts.props ?? PROP_KEYS) {
    const p = l.props[key];
    if (!p) continue;
    if (p.kf?.length) lines.push(`  ${key}: ${describeTrack(key, p.kf)}`);
    if (p.expr) lines.push(`  ${key}: expr ${JSON.stringify(p.expr)}`);
  }
  if (l.pathKf?.length) lines.push(`  path shape: ${l.pathKf.length} keys at ${l.pathKf.map(k => fmtTime(k.t)).join(', ')}`);
  if (l.textAnim) {
    const a = l.textAnim;
    lines.push(`  text animator: ${a.mode} by ${a.by}, start ${fmtTime(a.start)}, ${fmtTime(a.duration)} each, stagger ${fmtTime(a.stagger)}, ease ${a.ease}${a.order && a.order !== 'forward' ? ', order ' + a.order : ''}`);
  }
  if (!lines.length && !opts.always) return '';
  const head = `${JSON.stringify(l.name)} (${l.type} ${l.id})${l.inPoint > 0 || isFinite(l.outPoint) && l.outPoint < 1e8 ? ` visible ${fmtTime(l.inPoint)}–${fmtTime(l.outPoint)}` : ''}`;
  return [head, ...(lines.length ? lines : ['  (static)'])].join('\n');
}

/** first and last keyframe time over all props (null if not animated) */
export function animRange(l: Layer): [number, number] | null {
  let a = Infinity, b = -Infinity;
  for (const k of PROP_KEYS) for (const kf of l.props[k]?.kf ?? []) { a = Math.min(a, kf.t); b = Math.max(b, kf.t); }
  for (const kf of l.pathKf ?? []) { a = Math.min(a, kf.t); b = Math.max(b, kf.t); }
  if (l.textAnim) { a = Math.min(a, l.textAnim.start); b = Math.max(b, l.textAnim.start + l.textAnim.duration); }
  return isFinite(a) ? [a, b] : null;
}
