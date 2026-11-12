// analysis tools: measure motion (velocity, overshoot, holds, ease shape), check frames for layout
// problems (off-canvas, overlaps, contrast, safe areas, tiny/huge) and summarize the whole piece as a
// compact score. all read-only, all compact text.

import { PROP_KEYS, PROP_DEFS, type Layer, type PropKey } from '../core/model';
import { EXPR_PROPS } from '../core/expr';
import { st, text, need, idsSchema, type ToolDef } from './tool-kit';
import { animRange, fmtTime } from './describe';
import { propAt, worldBox, shownAt, contrast, over, r2, r0 } from './motion-math';
import { critique, formatCritique } from './critic';
import { logoPace } from './taste';

const UNIT: Partial<Record<PropKey, string>> = { position: 'px', anchor: 'px', size: 'px', scale: '%', rotation: '°', opacity: '%', strokeWidth: 'px', trimStart: '%', trimEnd: '%', trimOffset: '°', radius: 'px' };

/** scalar "amount" of a property value for speed: vectors by length (scale/radius by mean), colors by rgb distance */
function vecOf(key: PropKey, v: number[]): number[] {
  if (PROP_DEFS[key].unit === 'color') return v.slice(0, 4).map(x => x * 255);
  if (key === 'scale' || key === 'radius') { const m = v.reduce((a, b) => a + b, 0) / v.length; return [m]; }
  return v;
}
const dist = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0));

function animatedProps(l: Layer): PropKey[] {
  return PROP_KEYS.filter(k => (l.props[k]?.kf?.length ?? 0) >= 2 || (!!l.props[k]?.expr && EXPR_PROPS.includes(k)));
}

/** analysis of one property: per moving segment and the holds between them */
function inspectProp(l: Layer, key: PropKey, warn: string[]): string {
  const s = st(), fps = s.comp.fps;
  const p = l.props[key]!;
  const unit = UNIT[key] ?? '';
  const dt = 1 / 120;
  const sample = (t: number) => vecOf(key, propAt(s, l, key, t));
  if (p.expr && !(p.kf?.length)) {
    // expression only: range and speed over the comp
    let prev = sample(0), lo = prev[0], hi = prev[0], peak = 0;
    for (let t = dt; t <= s.comp.duration; t += dt) {
      const v = sample(t);
      lo = Math.min(lo, v[0]); hi = Math.max(hi, v[0]);
      peak = Math.max(peak, dist(v, prev) / dt);
      prev = v;
    }
    return `${key}: expr ${JSON.stringify(p.expr)} → ${r2(lo)}..${r2(hi)}${unit}, peak ${r0(peak)}${unit}/s`;
  }
  const kf = p.kf!;
  const parts: string[] = [];
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i], b = kf[i + 1];
    const d = b.t - a.t;
    const v0 = vecOf(key, a.v), v1 = vecOf(key, b.v);
    const D = v1.map((x, j) => x - v0[j]);
    const mag = Math.sqrt(D.reduce((q, x) => q + x * x, 0));
    if (mag < 1e-6) {
      if (d >= 0.15) parts.push(`hold ${fmtTime(a.t)}–${fmtTime(b.t)}`);
      continue;
    }
    if (a.interp === 'hold') { parts.push(`${fmtTime(a.t)}→${fmtTime(b.t)} jump Δ${r0(mag)}${unit} (hold)`); continue; }
    // sample the segment plus any settle tail up to the next key
    const n = Math.max(8, Math.ceil(d / dt));
    let prev = sample(a.t), peak = 0, peakT = a.t, maxProj = 0, minProj = 0, acc = 0, prevSpeed = 0;
    const speeds: number[] = [];
    for (let k = 1; k <= n; k++) {
      const t = a.t + (d * k) / n;
      const v = sample(t);
      const sp = dist(v, prev) / (d / n);
      speeds.push(sp);
      if (sp > peak) { peak = sp; peakT = t; }
      if (k > 1) acc = Math.max(acc, Math.abs(sp - prevSpeed) / (d / n));
      prevSpeed = sp;
      const proj = v.reduce((q, x, j) => q + (x - v0[j]) * D[j], 0) / mag;
      maxProj = Math.max(maxProj, proj); minProj = Math.min(minProj, proj);
      prev = v;
    }
    const avg = mag / d;
    const rel = (peakT - a.t) / d;
    let cls = a.interp === 'spring' ? `spring:${r2(a.bounce ?? 0)}` : a.interp === 'linear' || peak < avg * 1.15 ? 'linear' : rel < 0.35 ? 'ease-out' : rel > 0.65 ? 'ease-in' : 'ease-in-out';
    const flags: string[] = [];
    const over = (maxProj - mag) / mag;
    if (over > 0.01) flags.push(`overshoot ${r0(over * 100)}%`);
    if (-minProj / mag > 0.01) flags.push(`anticipation ${r0((-minProj / mag) * 100)}%`);
    const endV = speeds[speeds.length - 1];
    const next = kf[i + 2];
    const continues = next && dist(vecOf(key, next.v), v1) > 1e-6 && Math.abs(next.t - b.t) < 0.05;
    if (endV > peak * 0.5 && peak > avg * 0.5 && !continues && a.interp !== 'spring') { flags.push('hard stop'); warn.push(`${l.name}.${key} stops abruptly at ${fmtTime(b.t)} (ease the arrival)`); }
    if (d < 2 / fps) warn.push(`${l.name}.${key} move at ${fmtTime(a.t)} lasts under 2 frames`);
    if (key === 'position' && peak > Math.max(s.comp.width, s.comp.height) * 3) warn.push(`${l.name} moves very fast (${r0(peak)}px/s at ${fmtTime(peakT)})`);
    parts.push(`${fmtTime(a.t)}→${fmtTime(b.t)} Δ${r0(mag)}${unit} ${cls} peak ${r0(peak)}${unit}/s@${fmtTime(peakT)} acc ${r0(acc)}${flags.length ? ' ' + flags.join(', ') : ''}`);
  }
  if (!parts.length) return '';
  return `${key}: ${parts.join(' | ')}${p.expr ? ` + expr ${JSON.stringify(p.expr)}` : ''}`;
}

/** solid color a box shows at a point: the topmost opaque-ish filled layer below `l` covering it, or the background */
function colorBehind(l: Layer, x: number, y: number, t: number): number[] {
  const s = st();
  const order = s.drawOrder();
  const idx = order.indexOf(l.id);
  let col = s.comp.background.slice();
  for (let i = 0; i < idx; i++) {
    const o = s.layer(order[i])!;
    if (!['rect', 'ellipse', 'path', 'group'].includes(o.type) || o.mask) continue;
    const sh = shownAt(s, o, t);
    if (!sh.shown) continue;
    const fill = o.paints?.find(p => p.stops)?.stops ? avgStops(o) : propAt(s, o, 'fill', t);
    if ((fill[3] ?? 1) * sh.opacity < 0.05) continue;
    const b = worldBox(s, o, t);
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
    col = over([fill[0], fill[1], fill[2], (fill[3] ?? 1) * sh.opacity], col);
  }
  return col;
}
function avgStops(l: Layer) {
  const st0 = l.paints!.find(p => p.stops)!.stops!;
  const c = [0, 0, 0, 0];
  for (const x of st0) for (let i = 0; i < 4; i++) c[i] += x.color[i] / st0.length;
  return c;
}

function checkAt(t: number, safe: number, ids: string[] | null): string[] {
  const s = st(), comp = s.comp, W = comp.width, H = comp.height;
  const issues: string[] = [];
  const leaves = s.drawOrder().map(id => s.layer(id)!).filter(l => l.type !== 'group' && l.type !== 'audio' && !l.mask && (!ids || ids.includes(l.id)));
  const shown = leaves.map(l => ({ l, sh: shownAt(s, l, t) })).filter(x => x.sh.shown && x.sh.opacity > 0.02).map(x => ({ ...x, b: worldBox(s, x.l, t) }));
  const area = (b: number[]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const inter = (a: number[], b: number[]) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  const sx = W * safe, sy = H * safe;
  for (const { l, b, sh } of shown) {
    const A = area(b);
    const w = b[2] - b[0], h = b[3] - b[1];
    if (A > 0) {
      const off = 1 - inter(b, [0, 0, W, H]) / A;
      if (off > 0.999) issues.push(`${l.name}: entirely off-canvas but visible (opacity ${r0(sh.opacity * 100)}%)`);
      else if (off > 0.05 && A < W * H * 0.9) issues.push(`${l.name}: ${r0(off * 100)}% off-canvas`);
    }
    if ((w < 4 || h < 4) && !(l.type === 'path' && (w >= 4 || h >= 4))) issues.push(`${l.name}: tiny (${r0(w)}×${r0(h)}px)`);
    if (A > W * H * 4) issues.push(`${l.name}: huge (${r0(w)}×${r0(h)}px, ${r0(A / (W * H))}× the frame)`);
    const isText = l.type === 'text';
    const m = isText ? safe * 2 : safe;
    if (A > 0 && A < W * H * 0.6 && (b[0] < W * m - 0.5 || b[1] < H * m - 0.5 || b[2] > W - W * m + 0.5 || b[3] > H - H * m + 0.5) && inter(b, [0, 0, W, H]) > 0) issues.push(`${l.name}: outside ${isText ? 'title' : 'action'}-safe area (${r0(m * 100)}% margin)`);
    if (isText && l.text) {
      const fg = propAt(s, l, 'fill', t);
      const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      const bg = colorBehind(l, cx, cy, t);
      const c = contrast(over([fg[0], fg[1], fg[2], (fg[3] ?? 1) * sh.opacity], bg), bg);
      const large = l.text.fontSize >= 24;
      if (c < (large ? 3 : 4.5)) issues.push(`${l.name}: low contrast ${r2(c)}:1 vs background (needs ${large ? 3 : 4.5})`);
    }
  }
  void sx; void sy;
  // overlaps: text with anything above/below that is not a backdrop; shapes covering most of each other
  let n = 0;
  for (let i = 0; i < shown.length && n < 12; i++) for (let j = i + 1; j < shown.length && n < 12; j++) {
    const a = shown[i], b = shown[j];
    const Aa = area(a.b), Ab = area(b.b);
    if (Aa > W * H * 0.5 || Ab > W * H * 0.5) continue; // backdrops
    if (a.l.parent && a.l.parent === b.l.parent && s.layer(a.l.parent)?.type === 'group' && a.l.type === 'text' && b.l.type === 'text' && s.layer(a.l.parent)!.children.length > 3) continue; // split text pieces
    const I = inter(a.b, b.b);
    const frac = I / Math.max(1e-9, Math.min(Aa, Ab));
    const textInvolved = a.l.type === 'text' || b.l.type === 'text';
    if ((textInvolved && frac > 0.1 && (a.l.type === 'text') === (b.l.type === 'text')) || (!textInvolved && frac > 0.6) || (textInvolved && b.l.type !== 'text' && frac > 0.3)) {
      issues.push(`${a.l.name} ↔ ${b.l.name}: overlap ${r0(frac * 100)}%${b.l.type !== 'text' && a.l.type === 'text' ? ` (${b.l.name} covers the text)` : ''}`);
      n++;
    }
  }
  return issues;
}

/** moving at t (any keyed prop changing within [t0, t1]) */
function movingIn(l: Layer, t0: number, t1: number): boolean {
  for (const k of PROP_KEYS) {
    const kf = l.props[k]?.kf;
    if (kf && kf.length > 1) for (let i = 0; i < kf.length - 1; i++) {
      if (kf[i + 1].t <= t0 || kf[i].t >= t1) continue;
      if (kf[i].v.some((x, j) => Math.abs(x - kf[i + 1].v[j]) > 1e-6)) return true;
    }
    if (l.props[k]?.expr && EXPR_PROPS.includes(k)) return true;
  }
  if (l.pathKf?.length && l.pathKf.some((k, i) => i < l.pathKf!.length - 1 && l.pathKf![i + 1].t > t0 && k.t < t1)) return true;
  if (l.textAnim) { const a = l.textAnim; if (a.start < t1 && a.start + a.duration + a.stagger * 30 > t0) return true; }
  return false;
}

/** "a: msg", "b: msg", "c: msg", "d: msg" -> "a, b, c +1: msg" (split text pieces share problems) */
function collapse(lines: string[]): string[] {
  const by = new Map<string, string[]>();
  const order: string[] = [];
  for (const x of lines) {
    const i = x.indexOf(': ');
    const name = i > 0 ? x.slice(0, i) : x, msg = i > 0 ? x.slice(i + 2) : '';
    if (!by.has(msg)) { by.set(msg, []); order.push(msg); }
    by.get(msg)!.push(name);
  }
  return order.map(m => { const n = by.get(m)!; return m ? `${n.slice(0, 3).join(', ')}${n.length > 3 ? ` +${n.length - 3}` : ''}: ${m}` : n.join(', '); });
}

export const ANALYSIS_TOOLS: ToolDef[] = [
  {
    name: 'inspect_motion',
    readOnly: true,
    description: 'Measure animation instead of guessing: per layer and property, each move\'s duration, size, ease shape (ease-out / ease-in / ease-in-out / linear / spring) from the velocity curve, peak speed and when, peak acceleration, overshoot and anticipation (% of the move), holds, and warnings (hard stops, sub-2-frame moves, very fast moves). Expressions are sampled too. ids default to the selection, else every animated layer (max 30).',
    inputSchema: { type: 'object', properties: { ids: idsSchema, props: { type: 'array', items: { enum: PROP_KEYS } } } },
    run: ({ ids, props }) => {
      const s = st();
      const list: Layer[] = ids?.length ? ids.map(need) : (s.selection.length ? s.selection.map(need) : s.drawOrder().map(id => s.layer(id)!));
      const out: string[] = [];
      const warn: string[] = [];
      let n = 0;
      for (const l of list) {
        const keys = animatedProps(l).filter(k => !props || props.includes(k));
        const lines = keys.map(k => inspectProp(l, k, warn)).filter(Boolean);
        if (l.textAnim) lines.push(`text: ${l.textAnim.mode} by ${l.textAnim.by} ${fmtTime(l.textAnim.start)}+${fmtTime(l.textAnim.duration)} stagger ${fmtTime(l.textAnim.stagger)} ${l.textAnim.ease}`);
        if (l.pathKf && l.pathKf.length > 1) lines.push(`shape morph ${l.pathKf.map(k => fmtTime(k.t)).join('→')}`);
        if (!lines.length) continue;
        if (++n > 30) { out.push('… more layers: pass ids'); break; }
        out.push(`${JSON.stringify(l.name)} ${l.id}`, ...lines.map(x => '  ' + x));
      }
      if (!out.length) return text(ids?.length ? 'none of these layers is animated' : 'nothing is animated');
      if (warn.length) out.push('warnings:', ...[...new Set(warn)].slice(0, 15).map(w => '  ' + w));
      return text(out.join('\n'));
    },
  },
  {
    name: 'check_frame',
    readOnly: true,
    description: 'Check frames for layout problems at given times (default 5 times across the comp): layers off-canvas (or fully off but visible), outside the action-safe (5%) / title-safe (10%, text) areas, text contrast against what is behind it (WCAG: 4.5:1, 3:1 for 24px+), overlapping text / layers covering text, tiny or huge elements. Groups are checked through their children. Returns one line per problem, "ok" when clean.',
    inputSchema: { type: 'object', properties: { times: { type: 'array', items: { type: 'number' } }, ids: { ...idsSchema, description: 'only check these layers' }, safe: { type: 'number', description: 'action-safe margin fraction (default 0.05)' } } },
    run: ({ times, ids, safe = 0.05 }) => {
      const s = st(), D = s.comp.duration, f = 1 / s.comp.fps;
      const ts: number[] = times?.length ? times.slice(0, 12).map(Number) : [0, D * 0.25, D * 0.5, D * 0.75, Math.max(0, D - f)];
      const only = ids?.length ? (ids as string[]).flatMap(id => { need(id); return [id, ...s.descendants(id)]; }) : null;
      const out: string[] = [];
      for (const t of ts) {
        const iss = collapse(checkAt(t, safe, only));
        out.push(`${fmtTime(t)}: ${iss.length ? '' : 'ok'}`.trimEnd() + (iss.length ? '\n' + iss.map(x => '  ' + x).join('\n') : ''));
      }
      return text(out.join('\n'));
    },
  },
  {
    name: 'timeline_summary',
    readOnly: true,
    description: 'A compact "score" of the whole piece: beats (groups of layers starting together), who moves when (one line per animated layer with its active span and what animates), a motion-density strip over time (▁▂▃▅▇ = how many layers move), idle stretches, and anything running past the comp end. Use it to judge pacing and structure before polishing.',
    inputSchema: { type: 'object', properties: { bucket: { type: 'number', description: 'density strip resolution in seconds (default: duration/40, min 0.1)' } } },
    run: ({ bucket }) => {
      const s = st(), comp = s.comp, D = comp.duration;
      const layers = s.drawOrder().map(id => s.layer(id)!).filter(l => l.type !== 'group' || animRange(l));
      const rows = layers.map(l => {
        const r = animRange(l);
        const expr = PROP_KEYS.filter(k => l.props[k]?.expr);
        if (!r && !expr.length) return null;
        const props = PROP_KEYS.filter(k => (l.props[k]?.kf?.length ?? 0) > 1);
        const op = l.props.opacity?.kf;
        const tags: string[] = [];
        if (op && op.length > 1 && op[0].v[0] < 1 && op[op.length - 1].v[0] > 1) tags.push('in');
        if (op && op.length > 1 && op[op.length - 1].v[0] < 1) tags.push('out');
        return { l, r: r ?? [0, D], props, expr, tags };
      }).filter(Boolean) as { l: Layer; r: [number, number]; props: PropKey[]; expr: PropKey[]; tags: string[] }[];
      const out: string[] = [`comp "${comp.name}" ${fmtTime(D)} @${comp.fps}fps, ${Object.keys(s.project.layers).length} layers, ${rows.length} animated`];
      if (!rows.length) { out.push('nothing is animated yet'); return text(out.join('\n')); }
      // beats: starts within 120ms of a beat's first start
      const starts = rows.slice().sort((a, b) => a.r[0] - b.r[0]);
      const beats: { t: number; names: string[] }[] = [];
      for (const x of starts) { const last = beats[beats.length - 1]; if (last && x.r[0] - last.t <= 0.12) last.names.push(x.l.name); else beats.push({ t: x.r[0], names: [x.l.name] }); }
      out.push(`beats (${beats.length}): ` + beats.slice(0, 20).map((b, i) => `${i + 1}@${fmtTime(b.t)} ${b.names.slice(0, 3).join(', ')}${b.names.length > 3 ? ` +${b.names.length - 3}` : ''}`).join(' · '));
      out.push('layers:');
      for (const x of starts.slice(0, 60)) out.push(`  ${fmtTime(x.r[0])}–${fmtTime(x.r[1])} ${x.l.name}: ${[...x.props, ...x.expr.map(k => k + '(expr)'), ...(x.l.textAnim ? ['text ' + x.l.textAnim.by] : []), ...(x.l.pathKf?.length ? ['morph'] : [])].join(', ')}${x.tags.length ? ` [${x.tags.join('/')}]` : ''}${x.r[1] > D + 1e-6 ? ' ⚠ past end' : ''}`);
      if (starts.length > 60) out.push(`  … ${starts.length - 60} more`);
      // density strip
      const B = bucket ?? Math.max(0.1, D / 40);
      const bars = ' ▁▂▃▄▅▆▇█';
      const counts: number[] = [];
      for (let t = 0; t < D - 1e-9; t += B) counts.push(rows.filter(x => movingIn(x.l, t, Math.min(D, t + B))).length);
      const peak = Math.max(1, ...counts);
      out.push(`density (${r2(B)}s/char, peak ${peak} moving): |${counts.map(c => bars[Math.round((c / peak) * 8)]).join('')}|`);
      const idle: string[] = [];
      let i0 = -1;
      counts.forEach((c, i) => { if (c === 0 && i0 < 0) i0 = i; if ((c !== 0 || i === counts.length - 1) && i0 >= 0) { const e = c === 0 ? i + 1 : i; if ((e - i0) * B >= 0.75) idle.push(`${fmtTime(i0 * B)}–${fmtTime(Math.min(D, e * B))}`); i0 = -1; } });
      if (idle.length) out.push(`idle: ${idle.join(', ')}`);
      const lastEnd = Math.max(...rows.map(x => x.r[1]));
      if (lastEnd < D - 1) out.push(`last motion ends ${fmtTime(lastEnd)}: ${fmtTime(D - lastEnd)} of stillness at the end`);
      return text(out.join('\n'));
    },
  },
  {
    name: 'critique',
    readOnly: true,
    description: 'The editor\'s motion critic (deterministic, ~10 ms): scores the piece 0-100 with sub-scores (timing, easing, choreography, composition, readability, polish, richness, technical, brand, music) and lists the problems worst-first, each with the layers, times and the exact tool call(s) that fix it (→ lines). Checks hard stops, one ease everywhere, everything moving at once, stagger rhythm, durations vs the handbook timing table, dead time / long static endings, reading time of text, text collisions, clipping / safe areas, contrast, bars growing from the middle, missing secondary motion, loop seams, music alignment, palette / font drift, draw-ons that don\'t render, fonts that fall back; logo stings (one mark + wordmark, ≤ 10 s) also get the logo rubric (lead-in, lock time, hold, length, wordmark delay and entry, snap, idea vs generic pops/fades). Use it after building and after each beat (from/to = the beat).',
    inputSchema: { type: 'object', properties: { from: { type: 'number', description: 'only issues touching this time range (s)' }, to: { type: 'number' }, max: { type: 'number', description: 'max issues (default 8)' }, loop: { type: 'boolean', description: 'the piece is a seamless loop (default: detected)' } } },
    run: ({ from, to, max = 8, loop }) => {
      const s = st();
      const c = critique(s, { range: from !== undefined || to !== undefined ? [from ?? 0, to ?? s.comp.duration] : undefined, max, loop, pace: logoPace() });
      return text(formatCritique(c, { max }));
    },
  },
];
