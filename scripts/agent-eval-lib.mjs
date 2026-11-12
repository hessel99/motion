// Pure helpers for scripts/agent-eval.mjs: automatic metrics + checklist checks computed from the final
// document (project JSON) and geometry samples taken in the editor (see `probe` in agent-eval.mjs).
// No browser, no I/O: unit-testable and re-runnable on saved results.

export const EASES = [
  ['Linear', [0, 0, 1, 1]], ['Easy Ease', [0.333, 0, 0.667, 1]], ['Ease In', [0.42, 0, 1, 1]], ['Ease Out', [0, 0, 0.58, 1]],
  ['Ease In Out', [0.42, 0, 0.58, 1]], ['Sine In', [0.12, 0, 0.39, 0]], ['Sine Out', [0.61, 1, 0.88, 1]], ['Sine In Out', [0.37, 0, 0.63, 1]],
  ['Quad In', [0.11, 0, 0.5, 0]], ['Quad Out', [0.5, 1, 0.89, 1]], ['Quad In Out', [0.45, 0, 0.55, 1]], ['Cubic In', [0.32, 0, 0.67, 0]],
  ['Cubic Out', [0.33, 1, 0.68, 1]], ['Cubic In Out', [0.65, 0, 0.35, 1]], ['Quart In', [0.5, 0, 0.75, 0]], ['Quart Out', [0.25, 1, 0.5, 1]],
  ['Quart In Out', [0.76, 0, 0.24, 1]], ['Expo In', [0.7, 0, 0.84, 0]], ['Expo Out', [0.16, 1, 0.3, 1]], ['Expo In Out', [0.87, 0, 0.13, 1]],
  ['Back In', [0.36, 0, 0.66, -0.56]], ['Back Out', [0.34, 1.56, 0.64, 1]], ['Back In Out', [0.68, -0.6, 0.32, 1.6]],
  ['Snappy', [0.2, 0.9, 0.1, 1]], ['Gentle', [0.4, 0.1, 0.2, 1]],
];

/** name of the ease of the segment a → b */
export function segEase(a, b) {
  if (a.interp === 'hold') return 'Hold';
  if (a.interp === 'linear') return 'Linear';
  if (a.interp === 'spring') return `Spring ${Math.round((a.bounce ?? 0.3) * 10) / 10}`;
  const v = [a.out?.[0] ?? 0.333, a.out?.[1] ?? 0, b?.in?.[0] ?? 0.667, b?.in?.[1] ?? 1];
  for (const [n, p] of EASES) if (p.every((x, i) => Math.abs(x - v[i]) < 0.02)) return n;
  return `Custom(${v.map((x) => Math.round(x * 100) / 100).join(',')})`;
}
/** keyed overshoot: a track that passes its target and comes back (direction reverses with a small return) */
function keyedOvershoot(kf) {
  for (let i = 0; i + 2 < kf.length; i++) {
    for (let j = 0; j < kf[i].v.length; j++) {
      const d1 = kf[i + 1].v[j] - kf[i].v[j], d2 = kf[i + 2].v[j] - kf[i + 1].v[j];
      if (Math.abs(d1) > 1e-6 && d1 * d2 < 0 && Math.abs(d2) < 0.4 * Math.abs(d1)) return true;
    }
  }
  return false;
}
export const overshoots = (a, b) => a.interp === 'spring' || (a.interp !== 'hold' && a.interp !== 'linear' && [a.out?.[1], b?.in?.[1]].some((y) => y != null && (y > 1.02 || y < -0.02)));

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
export function hsl(c) {
  const [r, g, b] = c, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return { h, s, l };
}
const hex = (c) => '#' + c.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');

/** distinct colors (greedy clustering, distance 0.12 in rgb) */
function cluster(colors) {
  const out = [];
  for (const c of colors) if (!out.some((o) => Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]) < 0.12)) out.push(c);
  return out;
}

const DRAWABLE = new Set(['rect', 'ellipse', 'path', 'text', 'image']);
const kfOf = (l, k) => l.props?.[k]?.kf ?? [];
const animatedProps = (l) => Object.keys(l.props ?? {}).filter((k) => kfOf(l, k).length >= 2 || l.props[k].expr);
const staticV = (l, k) => l.props?.[k]?.kf?.length ? l.props[k].kf[l.props[k].kf.length - 1].v : l.props?.[k]?.v;

/**
 * doc: project JSON. probe: { comp, samples: [{t, items: [[id, x0,y0,x1,y1, opa]]}], vals: {id: {mid:{...}, end:{...}}},
 * loopDiff, midLuma }. Returns {metrics, derived} (derived feeds the checklist).
 */
export function computeMetrics(doc, probe) {
  const comp = probe.comp;
  const W = comp.width, H = comp.height, D = comp.duration, area = W * H;
  const layers = Object.values(doc.layers);
  const byId = Object.fromEntries(layers.map((l) => [l.id, l]));
  const types = {};
  for (const l of layers) types[l.type] = (types[l.type] ?? 0) + 1;
  // ---- keys / eases
  let keyedOvershoots = 0;
  for (const l of layers) for (const p of Object.values(l.props ?? {})) if (p.kf?.length >= 3 && keyedOvershoot(p.kf)) keyedOvershoots++;
  let keys = 0, segments = 0, overshootSegs = 0, holdKeys = 0, linearSegs = 0, springSegs = 0;
  const easeCount = {}, segs = [];
  for (const l of layers) for (const [k, p] of Object.entries(l.props ?? {})) {
    const kf = p.kf ?? [];
    keys += kf.length;
    for (let i = 0; i + 1 < kf.length; i++) {
      const a = kf[i], b = kf[i + 1];
      const changes = a.v.some((x, j) => Math.abs(x - (b.v[j] ?? x)) > 1e-6);
      if (!changes) continue;
      segments++;
      const e = segEase(a, b);
      easeCount[e] = (easeCount[e] ?? 0) + 1;
      if (overshoots(a, b)) overshootSegs++;
      if (a.interp === 'hold') holdKeys++;
      if (a.interp === 'linear') linearSegs++;
      if (a.interp === 'spring') springSegs++;
      segs.push({ id: l.id, prop: k, t0: a.t, t1: b.t, ease: e });
    }
  }
  const easeFamilies = new Set(Object.keys(easeCount).map((e) => e.replace(/ (In Out|In|Out)$/, '').replace(/^Spring.*/, 'Spring').replace(/^Custom.*/, 'Custom')));
  const exprs = layers.flatMap((l) => Object.entries(l.props ?? {}).filter(([, p]) => p.expr).map(([k, p]) => ({ id: l.id, prop: k, expr: p.expr })));
  const textAnims = layers.filter((l) => l.textAnim).map((l) => ({ id: l.id, ...l.textAnim }));
  const precomps = layers.filter((l) => l.type === 'precomp').length;
  const markers = Object.values(doc.comps).reduce((n, c) => n + (c.markers?.length ?? 0), 0);
  const paths = layers.filter((l) => l.type === 'path').length;
  const gradients = layers.filter((l) => (l.paints ?? []).some((p) => p.type === 'linear' || p.type === 'radial')).length;
  // ---- palette (fills/strokes of drawable layers + gradient stops + comp background)
  const cols = [];
  for (const l of layers) {
    if (!DRAWABLE.has(l.type) && l.type !== 'group') continue;
    const f = staticV(l, 'fill');
    const grad = (l.paints ?? []).filter((p) => p.stops?.length);
    if (grad.length) for (const p of grad) for (const s of p.stops) cols.push(s.color);
    else if (f && (f[3] ?? 1) > 0.05 && (l.type !== 'group' || (f[3] ?? 0) > 0.05)) cols.push(f);
    for (const kf of kfOf(l, 'fill')) cols.push(kf.v);
    const s = staticV(l, 'stroke'), sw = staticV(l, 'strokeWidth');
    if (s && (s[3] ?? 0) > 0.05 && sw?.[0] > 0) cols.push(s);
  }
  if (comp.background && (comp.background[3] ?? 1) > 0.05) cols.push(comp.background);
  const palette = cluster(cols.filter((c) => (c[3] ?? 1) > 0.05));
  // ---- geometry over time (samples)
  const S = probe.samples;
  const dt = S.length > 1 ? S[1].t - S[0].t : D;
  let offCanvas = 0, overlapText = 0, overlapAny = 0, active = 0;
  const offLayers = {}, overlapPairs = {};
  const firstVis = {}, lastVis = {}, visCount = {};
  let lastChange = 0, firstChange = null;
  const changes = [];
  for (let si = 0; si < S.length; si++) {
    const s = S[si];
    const vis = s.items.filter((it) => it[5] > 0.05);
    for (const it of vis) { firstVis[it[0]] ??= s.t; lastVis[it[0]] = s.t; visCount[it[0]] = (visCount[it[0]] ?? 0) + 1; }
    let off = false;
    for (const [id, x0, y0, x1, y1] of vis) {
      const w = x1 - x0, h = y1 - y0, a = w * h;
      if (a <= 1 || a > 0.9 * area) continue;
      const ix = Math.max(0, Math.min(x1, W) - Math.max(x0, 0)), iy = Math.max(0, Math.min(y1, H) - Math.max(y0, 0));
      const outside = 1 - (ix * iy) / a;
      if (outside > 0.15 && outside < 0.97) { off = true; offLayers[id] = (offLayers[id] ?? 0) + dt; }
    }
    if (off) offCanvas += dt;
    let ovT = false, ovA = false;
    for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
      const A = vis[i], B = vis[j];
      const aA = (A[3] - A[1]) * (A[4] - A[2]), aB = (B[3] - B[1]) * (B[4] - B[2]);
      if (aA <= 1 || aB <= 1 || aA > 0.5 * area || aB > 0.5 * area) continue;
      const ix = Math.max(0, Math.min(A[3], B[3]) - Math.max(A[1], B[1])), iy = Math.max(0, Math.min(A[4], B[4]) - Math.max(A[2], B[2]));
      const inter = ix * iy, small = Math.min(aA, aB);
      if (inter < 0.15 * small || inter > 0.95 * small) continue; // no overlap, or one contains the other (intended layering)
      const tA = byId[A[0]]?.type === 'text', tB = byId[B[0]]?.type === 'text';
      if (tA && tB) { ovT = true; const k = `${byId[A[0]]?.name} × ${byId[B[0]]?.name}`; overlapPairs[k] = (overlapPairs[k] ?? 0) + dt; }
      ovA = true;
    }
    if (ovT) overlapText += dt;
    if (ovA) overlapAny += dt;
    if (si > 0) {
      const prev = new Map(S[si - 1].items.map((it) => [it[0], it]));
      let changed = false;
      for (const it of s.items) {
        const p = prev.get(it[0]);
        if (!p) { if (it[5] > 0.05) changed = true; continue; }
        if (Math.abs(it[5] - p[5]) > 0.01 || [1, 2, 3, 4].some((k) => Math.abs(it[k] - p[k]) > 0.5)) { changed = true; break; }
      }
      if (!changed) for (const p of S[si - 1].items) if (p[5] > 0.05 && !s.items.some((it) => it[0] === p[0])) changed = true;
      changes.push(changed);
      if (changed) { active += dt; lastChange = s.t; firstChange ??= S[si - 1].t; }
    }
  }
  // longest still window between first and last change
  let longestHold = 0, run = 0;
  for (let i = 0; i < changes.length; i++) {
    const t = S[i + 1].t;
    if (firstChange != null && t > firstChange && t <= lastChange && !changes[i]) { run += dt; longestHold = Math.max(longestHold, run); } else run = 0;
  }
  const last = S[S.length - 1];
  const lastVisSet = new Set(last.items.filter((it) => it[5] > 0.05).map((it) => it[0]));
  const exits = Object.keys(firstVis).filter((id) => !lastVisSet.has(id) && byId[id]).length;
  const clippedAtEnd = last.items.filter(([id, x0, y0, x1, y1, o]) => {
    const a = (x1 - x0) * (y1 - y0); if (o < 0.05 || a <= 1 || a > 0.9 * area) return false;
    const ix = Math.max(0, Math.min(x1, W) - Math.max(x0, 0)), iy = Math.max(0, Math.min(y1, H) - Math.max(y0, 0));
    const out = 1 - (ix * iy) / a; return out > 0.15;
  }).map((it) => byId[it[0]]?.name ?? it[0]);
  // entrance waves ("beats"): first-visible times + segment starts, clustered with 0.45s gaps
  const starts = [...Object.values(firstVis).filter((t) => t > 0), ...segs.map((s) => s.t0), ...textAnims.map((a) => (byId[a.id]?.inPoint ?? 0) + (a.start ?? 0))].sort((a, b) => a - b);
  let beats = 0, prevT = -Infinity;
  for (const t of starts) { if (t - prevT > 0.45) beats++; prevT = t; }
  const keyCoverage = (() => {
    const iv = [];
    for (const s of segs) iv.push([s.t0, s.t1]);
    for (const e of exprs) { const l = byId[e.id]; iv.push([l?.inPoint ?? 0, Math.min(D, l?.outPoint ?? D)]); }
    for (const a of textAnims) { const l = byId[a.id]; const n = (l?.text?.content ?? '').length; const t0 = (l?.inPoint ?? 0) + (a.start ?? 0); iv.push([t0, t0 + (a.duration ?? 0.5) + (a.stagger ?? 0.05) * (a.by === 'char' ? n : a.by === 'word' ? n / 5 : 2)]); }
    iv.sort((a, b) => a[0] - b[0]);
    let tot = 0, cs = -1, ce = -1;
    for (const [a, b] of iv) { const A = Math.max(0, a), B = Math.min(D, b); if (B <= A) continue; if (A > ce) { tot += ce - cs; cs = A; ce = B; } else ce = Math.max(ce, B); }
    tot += ce - cs;
    return D ? Math.min(1, tot / D) : 0;
  })();
  const drawables = layers.filter((l) => DRAWABLE.has(l.type));
  const metrics = {
    layers: layers.length, drawableLayers: drawables.length, layerTypes: types, groups: types.group ?? 0,
    animatedLayers: layers.filter((l) => animatedProps(l).length || l.textAnim).length,
    keys, segments, easesUsed: easeCount, distinctEases: Object.keys(easeCount).length, easeFamilies: easeFamilies.size,
    overshootSegments: overshootSegs, keyedOvershoots, springSegments: springSegs, holdKeys, linearSegments: linearSegs,
    expressions: exprs.length, textAnimators: textAnims.length, precomps, markers, pathLayers: paths, gradientLayers: gradients,
    paletteSize: palette.length, palette: palette.map(hex),
    keyCoverage: r3(keyCoverage), visualActivity: r3(D ? active / D : 0),
    firstMotion: r3(firstChange ?? 0), lastMotion: r3(lastChange), endHold: r3(Math.max(0, D - lastChange)), longestHold: r3(longestHold),
    offCanvasTime: r3(offCanvas), offCanvasLayers: Object.fromEntries(Object.entries(offLayers).map(([id, t]) => [byId[id]?.name ?? id, r3(t)])),
    clippedAtEnd, textOverlapTime: r3(overlapText), textOverlapPairs: Object.fromEntries(Object.entries(overlapPairs).map(([k, v]) => [k, r3(v)])),
    partialOverlapTime: r3(overlapAny), exits, beats,
    neverVisible: drawables.filter((l) => !firstVis[l.id] && l.type !== 'audio').map((l) => l.name),
    loopDiff: probe.loopDiff != null ? r3(probe.loopDiff) : null, midLuma: probe.midLuma != null ? r3(probe.midLuma) : null,
  };
  return { metrics, derived: { comp, layers, byId, segs, exprs, textAnims, palette, firstVis, lastVis, S, vals: probe.vals ?? {}, starts } };
}
const r3 = (x) => Math.round(x * 1000) / 1000;

const textLayers = (d) => d.layers.filter((l) => l.type === 'text' && l.text);
const has = (s, sub) => String(s ?? '').toLowerCase().includes(String(sub).toLowerCase());
const anyText = (d, t) => textLayers(d).some((l) => has(l.text.content, t)) || has(lettersInOrder(d), t);
function lettersInOrder(d) {
  const ls = textLayers(d).filter((l) => l.text.content.trim().length <= 2);
  const mid = (l) => d.vals[l.id]?.end?.position?.[0] ?? staticV(l, 'position')?.[0] ?? 0;
  return ls.sort((a, b) => mid(a) - mid(b)).map((l) => l.text.content.trim()).join('');
}
const propAnimated = (l, p) => kfOf(l, p).length >= 2 || !!l.props?.[p]?.expr;
const sizeOf = (d, l) => d.vals[l.id]?.mid?.size ?? staticV(l, 'size') ?? [0, 0];
const endRot = (d, l) => d.vals[l.id]?.end?.rotation?.[0] ?? staticV(l, 'rotation')?.[0] ?? 0;
const allRot = (l) => [staticV(l, 'rotation')?.[0] ?? 0, ...kfOf(l, 'rotation').map((k) => k.v[0])];
const isBlackish = (c) => c && lum(c) < 0.12 && (c[3] ?? 1) > 0.5;
const nonGroup = (d) => d.layers.filter((l) => DRAWABLE.has(l.type));

/** one checklist item → true/false (null = not machine-checkable) */
export function runCheck(check, m, d) {
  if (!check) return null;
  const L = d.layers;
  switch (check.type) {
    case 'textContains': return anyText(d, check.text);
    case 'textAllOf': return check.texts.every((t) => anyText(d, t));
    case 'textOrLetters': return anyText(d, check.text);
    case 'textCopiesMin': return textLayers(d).filter((l) => has(l.text.content, check.text)).length >= check.min;
    case 'layersMin': return nonGroup(d).length >= check.min;
    case 'layersMax': return nonGroup(d).length <= check.max;
    case 'nonTextLayersMin': return nonGroup(d).filter((l) => l.type !== 'text').length >= check.min;
    case 'textLayersMin': return textLayers(d).length >= check.min;
    case 'layersOfTypeMin': return L.filter((l) => l.type === check.layerType).length >= check.min;
    case 'pathLayersMin': return L.filter((l) => l.type === 'path' || l.shape).length >= check.min;
    case 'textAnimatorMin': return d.textAnims.length >= check.min;
    case 'perLetter': return d.textAnims.some((a) => a.by === 'char') || textLayers(d).filter((l) => l.text.content.trim().length === 1 && (animatedProps(l).length || l.textAnim)).length >= 3;
    case 'byLine': {
      if (d.textAnims.some((a) => a.by === 'line')) return true;
      const t = textLayers(d).filter((l) => l.text.content.trim().split(/\s+/).length >= 2).map((l) => d.firstVis[l.id]).filter((x) => x != null).sort((a, b) => a - b);
      return t.length >= 2 && t.slice(1).some((x, i) => x - t[i] >= 0.02 && x - t[i] <= 0.4);
    }
    case 'beatsMin': return m.beats >= check.min;
    case 'endHoldMin': return m.endHold >= check.seconds - 0.05;
    case 'motionEndsBy': return m.lastMotion <= check.seconds + 0.05;
    case 'activeAtEnd': return m.lastMotion >= d.comp.duration - 0.8;
    case 'holdMin': return m.longestHold >= check.seconds - 0.05;
    case 'coverageMin': return Math.max(m.visualActivity, m.keyCoverage) >= check.min;
    case 'exitsMin': return m.exits >= check.min;
    case 'noEntrancesAfter': return Object.values(d.firstVis).every((t) => t <= check.seconds);
    case 'paletteMax': return m.paletteSize <= check.max;
    case 'paletteMin': return m.paletteSize >= check.min;
    case 'hueRange': return check.hues.every(([a, b]) => d.palette.some((c) => { const h = hsl(c); return h.s > 0.2 && h.l > 0.08 && h.l < 0.92 && h.h >= a && h.h <= b; }));
    case 'rgbSplitColors': return [[280, 335], [170, 200]].every(([a, b]) => d.palette.some((c) => { const h = hsl(c); return h.s > 0.4 && h.h >= a && h.h <= b; }));
    case 'darkBackground': return (m.midLuma ?? 1) < 0.25;
    case 'overshoot': return m.overshootSegments > 0 || m.keyedOvershoots > 0 || d.textAnims.some((a) => /spring|back/i.test(a.ease ?? ''));
    case 'noOvershoot': return m.overshootSegments === 0 && m.keyedOvershoots === 0 && !d.textAnims.some((a) => /spring|back/i.test(a.ease ?? ''));
    case 'mechanicalEases': return m.linearSegments + m.holdKeys > 0;
    case 'noLinear': return m.linearSegments === 0;
    case 'easeUsed': return !!m.easesUsed[check.ease] || d.textAnims.some((a) => has(a.ease, check.ease));
    case 'minSegmentDuration': return d.segs.every((s) => s.t1 - s.t0 >= check.seconds - 0.01);
    case 'colorChange': return L.some((l) => propAnimated(l, 'fill')) || L.some((a) => a.type !== 'text' && propAnimated(a, 'opacity') && L.some((b) => b !== a && b.type === a.type && (() => { const sa = sizeOf(d, a), sb = sizeOf(d, b); const fa = staticV(a, 'fill'), fb = staticV(b, 'fill'); return Math.abs(sa[0] - sb[0]) < 4 && Math.abs(sa[1] - sb[1]) < 4 && fa && fb && Math.hypot(fa[0] - fb[0], fa[1] - fb[1], fa[2] - fb[2]) > 0.15; })()));
    case 'propAnimated': return L.some((l) => propAnimated(l, check.prop));
    case 'propAnimatedMin': return L.filter((l) => propAnimated(l, check.prop)).length >= check.min;
    case 'squash': return L.some((l) => kfOf(l, 'scale').some((k) => Math.abs(k.v[0] - k.v[1]) > 3) || (l.type !== 'text' && kfOf(l, 'size').length >= 2 && kfOf(l, 'size').some((k, i, a) => i > 0 && Math.abs(k.v[0] / Math.max(1, k.v[1]) - a[0].v[0] / Math.max(1, a[0].v[1])) > 0.05)));
    case 'jitter': return d.exprs.some((e) => /wiggle|random|noise/i.test(e.expr)) || m.holdKeys >= 4 || L.some((l) => ['position', 'rotation', 'scale'].some((p) => kfOf(l, p).length >= 8)) || L.some((l) => (l.pathKf?.length ?? 0) >= 3);
    case 'holdKeysMin': return m.holdKeys >= check.min;
    case 'loops': return m.loopDiff != null && m.loopDiff < 0.01;
    case 'loopTechnique': return d.exprs.some((e) => /loop|sin|cos/i.test(e.expr)) || L.filter((l) => animatedProps(l).length).every((l) => Object.keys(l.props).every((k) => { const kf = kfOf(l, k); return kf.length < 2 || kf[0].v.every((x, i) => Math.abs(x - kf[kf.length - 1].v[i]) < 0.01); }));
    case 'trimAnimated': return L.some((l) => ['trimStart', 'trimEnd', 'trimOffset'].some((p) => propAnimated(l, p)));
    case 'starShape': return L.some((l) => l.shape?.kind === 'star' || (l.type === 'path' && /star|burst|badge/i.test(l.name)));
    case 'ring': return L.some((l) => l.type === 'ellipse' && (staticV(l, 'strokeWidth')?.[0] ?? 0) > 0 && (staticV(l, 'stroke')?.[3] ?? 0) > 0.1 && (propAnimated(l, 'scale') || propAnimated(l, 'size')));
    case 'thinRectsMin': return L.filter((l) => l.type === 'rect' && (() => { const [w, h] = sizeOf(d, l); return h > 0 && h <= 16 && w >= 8 * h; })()).length >= check.min;
    case 'thickOutline': return L.some((l) => isBlackish(staticV(l, 'stroke')) && (staticV(l, 'strokeWidth')?.[0] ?? 0) >= 4);
    case 'offsetShadow': {
      const ls = nonGroup(d).filter((l) => l.type !== 'text');
      return ls.some((a) => isBlackish(staticV(a, 'fill')) && ls.some((b) => b !== a && !isBlackish(staticV(b, 'fill')) && (() => {
        const sa = sizeOf(d, a), sb = sizeOf(d, b), pa = d.vals[a.id]?.end?.position ?? staticV(a, 'position'), pb = d.vals[b.id]?.end?.position ?? staticV(b, 'position');
        if (!pa || !pb || a.parent !== b.parent) return false;
        const dx = pa[0] - pb[0], dy = pa[1] - pb[1];
        return Math.abs(sa[0] - sb[0]) < 4 && Math.abs(sa[1] - sb[1]) < 4 && dx >= 3 && dx <= 30 && dy >= 3 && dy <= 30;
      })()));
    }
    case 'tiltedAtEnd': return L.some((l) => { const r = Math.abs(endRot(d, l)) % 360; return r >= 2 && r <= 30 || r >= 330 && r <= 358; });
    case 'rotated90': return L.some((l) => { const r = ((Math.abs(endRot(d, l)) % 180)); return Math.abs(r - 90) < 5; });
    case 'rotatedAbout': return L.some((l) => allRot(l).some((r) => Math.abs(Math.abs(r) - Math.abs(check.deg)) <= check.tol));
    case 'fontSizeMin': return textLayers(d).some((l) => l.text.fontSize >= check.size);
    case 'serifFont': return textLayers(d).some((l) => /serif|garamond|playfair|didot|bodoni|times|georgia|cormorant|baskerville|cinzel|lora|merriweather/i.test(l.text.fontFamily) && !/sans/i.test(l.text.fontFamily));
    case 'textEmphasis': {
      const t = textLayers(d);
      if (t.length < 2) return false;
      const fs = t.map((l) => l.text.fontSize), fw = t.map((l) => l.text.fontWeight);
      const fills = cluster(t.map((l) => staticV(l, 'fill')).filter(Boolean));
      return Math.max(...fs) / Math.min(...fs) >= 1.3 || Math.max(...fw) - Math.min(...fw) >= 200 || fills.length >= 2;
    }
    case 'numericTextMin': return textLayers(d).filter((l) => /\d/.test(l.text.content)).length >= check.min;
    case 'staggered': {
      const t = L.filter((l) => DRAWABLE.has(l.type) && l.type !== 'text').map((l) => d.segs.filter((s) => s.id === l.id).reduce((a, s) => Math.min(a, s.t0), Infinity)).filter(isFinite).sort((a, b) => a - b);
      let best = 1, run = 1;
      for (let i = 1; i < t.length; i++) { const g = t[i] - t[i - 1]; run = g >= 0.03 && g <= 0.7 ? run + 1 : 1; best = Math.max(best, run); }
      return best >= check.min;
    }
    case 'barsGrow': {
      const rects = L.filter((l) => l.type === 'rect' && (propAnimated(l, 'size') || propAnimated(l, 'scale')));
      let n = 0;
      for (const l of rects) {
        const ys = d.S.map((s) => s.items.find((it) => it[0] === l.id)).filter((it) => it && it[5] > 0.05 && it[4] - it[2] > 2);
        if (ys.length < 3) continue;
        const bottoms = ys.map((it) => it[4]), hs = ys.map((it) => it[4] - it[2]);
        if (Math.max(...bottoms) - Math.min(...bottoms) < 6 && Math.max(...hs) - Math.min(...hs) > 20) n++;
      }
      return n >= 3;
    }
    case 'wipes': return L.some((l) => l.type === 'rect' && (propAnimated(l, 'size') || kfOf(l, 'scale').some((k) => Math.abs(k.v[0] - k.v[1]) > 5)));
    case 'beatGrid': {
      if (m.markers >= 3) return true;
      const step = 60 / check.bpm, ts = d.segs.map((s) => s.t0);
      return ts.length >= 4 && ts.filter((t) => Math.abs(t / step - Math.round(t / step)) * step < 0.04).length / ts.length >= 0.6;
    }
    case 'lowerThird': {
      const H = d.comp.height, mid = d.S[Math.floor(d.S.length / 2)];
      const t = textLayers(d).map((l) => mid?.items.find((it) => it[0] === l.id)).filter((it) => it && it[5] > 0.05);
      return t.length > 0 && t.every((it) => (it[2] + it[4]) / 2 > 0.6 * H);
    }
    case 'translucent': return nonGroup(d).some((l) => l.type !== 'text' && ((d.vals[l.id]?.mid?.opacity?.[0] ?? staticV(l, 'opacity')?.[0] ?? 100) < 98 || ((d.vals[l.id]?.mid?.fill ?? staticV(l, 'fill'))?.[3] ?? 1) < 0.98));
    case 'thinLineDraw': return nonGroup(d).some((l) => { const [w, h] = sizeOf(d, l); return Math.min(w || 1e9, h || 1e9) <= 6 && (propAnimated(l, 'size') || propAnimated(l, 'scale') || propAnimated(l, 'trimEnd') || propAnimated(l, 'trimStart')) || (l.type === 'path' && (propAnimated(l, 'trimEnd') || propAnimated(l, 'trimStart'))); });
    case 'gradientPaint': return m.gradientLayers > 0;
    case 'gradientOrHaze': return m.gradientLayers > 0 || nonGroup(d).filter((l) => l.type !== 'text' && ((staticV(l, 'opacity')?.[0] ?? 100) < 98 || (staticV(l, 'fill')?.[3] ?? 1) < 0.98)).length >= 2;
    case 'parallax': {
      const sp = [];
      for (const l of nonGroup(d)) {
        const its = d.S.map((s) => s.items.find((it) => it[0] === l.id)).filter(Boolean);
        if (its.length < 3) continue;
        const a = its[0], b = its[its.length - 1];
        const v = Math.hypot((b[1] + b[3]) / 2 - (a[1] + a[3]) / 2, (b[2] + b[4]) / 2 - (a[2] + a[4]) / 2);
        if (v > 5) sp.push(v);
      }
      sp.sort((a, b) => a - b);
      let n = sp.length ? 1 : 0;
      for (let i = 1; i < sp.length; i++) if (sp[i] / sp[i - 1] >= 1.3) n++;
      return n >= check.min;
    }
    case 'cards': return L.filter((l) => l.type === 'rect' && (() => { const [w, h] = sizeOf(d, l); const r = staticV(l, 'radius')?.[0] ?? 0; return w >= 120 && h >= 80 && Math.abs(r - check.radius) <= 4; })()).length >= check.min;
    default: return null;
  }
}

export function runChecklist(brief, metrics, derived) {
  const items = brief.checklist.map((c) => {
    let pass = null;
    try { pass = runCheck(c.check, metrics, derived); } catch (e) { pass = null; }
    return { text: c.text, type: c.check?.type ?? null, pass };
  });
  const auto = items.filter((i) => i.pass !== null);
  return { items, hits: auto.filter((i) => i.pass).length, checkable: auto.length, total: items.length };
}

export const JUDGE_KEYS = ['brief_fit', 'style_match', 'timing_easing', 'composition', 'richness', 'polish'];

/** parse the judge's answer: last ```json block (or the last {...}) */
export function parseJudge(text) {
  const blocks = [...String(text).matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const cand = blocks.length ? blocks[blocks.length - 1] : (String(text).match(/\{[\s\S]*\}/) ?? [])[0];
  if (!cand) return null;
  try {
    const j = JSON.parse(cand);
    const scores = {};
    for (const k of JUDGE_KEYS) { const v = Number(j[k]); if (!(v >= 1 && v <= 10)) return null; scores[k] = v; }
    const overall = Math.round((JUDGE_KEYS.reduce((a, k) => a + scores[k], 0) / JUDGE_KEYS.length) * 100) / 100;
    return { scores, overall, critique: Array.isArray(j.critique) ? j.critique.slice(0, 2).map(String) : [String(j.critique ?? '')] };
  } catch { return null; }
}
