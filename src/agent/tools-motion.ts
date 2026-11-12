// choreography tools: layouts (grid / radial / along a path / scatter), stagger patterns, secondary
// motion (anticipation, overshoot, settle), seamless loops, camera rigs and beat alignment.
// every call is one undo step and reports what it did (skipped layers are named, never silently).

import { createLayer, PROP_KEYS, type Keyframe, type Layer, type PropKey } from '../core/model';
import { insertLayer, valueAt } from '../core/commands';
import { EXPR_PROPS } from '../core/expr';
import type { Tx } from '../core/store';
import { st, text, need, idsSchema, easeSchema, resolveEase, buildKeys, shiftLayerKeys, type ToolDef } from './tool-kit';
import { animRange, fmtTime } from './describe';
import { centerOf, inv, apply, worldMatrix, rng, samplePath, layerSize } from './motion-math';
import { orderDelays } from './tools-scene';
import { parseD } from './shape-lib';
import { music, beats as musicBeats } from '../audio/timing';
import { transformCmds } from '../import/svg';

const r2 = (x: number) => Math.round(x * 100) / 100;

/** ids, or a single group id meaning its children */
function members(ids: string[], what: string): Layer[] {
  if (!Array.isArray(ids) || !ids.length) throw new Error(`ids must list the layers to ${what} (or one group: its children)`);
  const list = ids.map(need);
  if (list.length === 1 && list[0].type === 'group' && list[0].children.length) return list[0].children.map(need);
  return list;
}

/** set a layer's resting position; an animated position track moves along by the same delta */
function movePositionTx(tx: Tx, l: Layer, target: number[], t: number) {
  const p = l.props.position ?? { v: valueAt(l, 'position', t) };
  if (!l.props.position) tx.set(l.props, 'position', p);
  const cur = valueAt(l, 'position', t);
  const dx = target[0] - cur[0], dy = target[1] - cur[1];
  tx.set(p, 'v', [p.v[0] + dx, p.v[1] + dy]);
  if (p.kf?.length) tx.set(p, 'kf', p.kf.map(k => ({ ...k, v: [k.v[0] + dx, k.v[1] + dy] })));
  tx.touch(l.id);
}

/** position value that puts the layer's box center at parent-space point c (rotation ignored) */
function positionForCenter(l: Layer, c: number[], t: number) {
  const s = st();
  const [w, h] = layerSize(s, l, t);
  const a = valueAt(l, 'anchor', t), sc = valueAt(l, 'scale', t);
  return [c[0] + (a[0] - w / 2) * sc[0] / 100, c[1] + (a[1] - h / 2) * sc[1] / 100];
}

export const MOTION_TOOLS: ToolDef[] = [
  {
    name: 'arrange',
    description: 'Lay out layers (or a group\'s children): grid, row, column, radial (circle/arc), along a path (SVG d in parent coordinates or a path layer), or scatter (seeded, non-overlapping). Places box centers in the parent\'s space; animated positions move along. transition {t, duration, ease, stagger} animates from the current places instead of jumping. rotate:true turns layers to face outward (radial) / along the path.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: idsSchema,
        layout: { enum: ['grid', 'row', 'column', 'radial', 'path', 'scatter'] },
        center: { type: 'array', items: { type: 'number' }, description: 'layout center (default: composition / parent center)' },
        cols: { type: 'number', description: 'grid columns (default ~sqrt(n))' },
        gap: { anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }], description: 'grid/row/column spacing between boxes, px (default 24)' },
        cell: { type: 'array', items: { type: 'number' }, description: 'grid cell [w,h] (default: largest box)' },
        radius: { type: 'number', description: 'radial radius px' },
        startAngle: { type: 'number', description: 'degrees, 0 = top, clockwise (default 0)' },
        endAngle: { type: 'number', description: 'default startAngle + 360 (full circle)' },
        d: { type: 'string', description: 'path layout: SVG path in parent coordinates' },
        path: { type: 'string', description: 'path layout: a path layer id to follow' },
        bounds: { type: 'array', items: { type: 'number' }, description: 'scatter area [x,y,w,h] (default: composition with 10% margin)' },
        seed: { type: 'number' }, minDistance: { type: 'number', description: 'scatter: min center distance px' },
        rotate: { type: 'boolean' },
        transition: { type: 'object', properties: { t: { type: 'number' }, duration: { type: 'number' }, ease: easeSchema, stagger: { type: 'number' } } },
      },
      required: ['ids', 'layout'],
    },
    run: a => {
      const s = st();
      const list = members(a.ids, 'arrange');
      const n = list.length;
      const parent = list[0].parent;
      if (list.some(l => l.parent !== parent)) throw new Error('arrange layers that share a parent (or pass one group)');
      const t = s.time;
      const pBox = parent ? layerSize(s, s.layer(parent)!, t) : [s.comp.width, s.comp.height];
      const C = a.center ?? [pBox[0] / 2, pBox[1] / 2];
      const sizes = list.map(l => { const sz = layerSize(s, l, t), sc = valueAt(l, 'scale', t); return [sz[0] * Math.abs(sc[0]) / 100, sz[1] * Math.abs(sc[1]) / 100]; });
      const gap = Array.isArray(a.gap) ? a.gap : [a.gap ?? 24, a.gap ?? 24];
      let pts: number[][] = [];
      let rots: (number | null)[] = list.map(() => null);
      switch (a.layout) {
        case 'grid': case 'row': case 'column': {
          const cols = a.layout === 'row' ? n : a.layout === 'column' ? 1 : Math.max(1, Math.round(a.cols ?? Math.ceil(Math.sqrt(n))));
          const rows = Math.ceil(n / cols);
          const cw = a.cell?.[0] ?? Math.max(...sizes.map(x => x[0])), ch = a.cell?.[1] ?? Math.max(...sizes.map(x => x[1]));
          const W = cols * cw + (cols - 1) * gap[0], H = rows * ch + (rows - 1) * gap[1];
          pts = list.map((_, i) => [C[0] - W / 2 + (i % cols) * (cw + gap[0]) + cw / 2, C[1] - H / 2 + Math.floor(i / cols) * (ch + gap[1]) + ch / 2]);
          break;
        }
        case 'radial': {
          const R = a.radius ?? Math.min(pBox[0], pBox[1]) * 0.3;
          const a0 = a.startAngle ?? 0, a1 = a.endAngle ?? a0 + 360;
          const full = Math.abs(a1 - a0) >= 359.999;
          pts = list.map((_, i) => { const ang = (a0 + (a1 - a0) * (full ? i / n : n === 1 ? 0.5 : i / (n - 1))) * Math.PI / 180; return [C[0] + Math.sin(ang) * R, C[1] - Math.cos(ang) * R]; });
          if (a.rotate) rots = list.map((_, i) => a0 + (a1 - a0) * (full ? i / n : n === 1 ? 0.5 : i / (n - 1)));
          break;
        }
        case 'path': {
          let cmds;
          if (a.d) cmds = parseD(a.d);
          else if (a.path) {
            const pl = need(a.path);
            if (pl.type !== 'path' || !pl.geometry?.length) throw new Error('path must be a path layer id');
            const [w, h] = layerSize(s, pl, t), g = pl.geomSize ?? [w, h];
            const m = [g[0] ? w / g[0] : 1, 0, 0, g[1] ? h / g[1] : 1, 0, 0];
            const toParent = (() => { const W = worldMatrix(s, pl.id, t), P = inv(worldMatrix(s, parent, t)); return [P[0] * W[0] + P[2] * W[1], P[1] * W[0] + P[3] * W[1], P[0] * W[2] + P[2] * W[3], P[1] * W[2] + P[3] * W[3], P[0] * W[4] + P[2] * W[5] + P[4], P[1] * W[4] + P[3] * W[5] + P[5]]; })();
            cmds = transformCmds(transformCmds(pl.geometry.flatMap(x => x.cmds), m as any), toParent as any);
          } else throw new Error('path layout needs d (SVG path) or path (a path layer id)');
          const sp = samplePath(cmds, n);
          pts = sp.map(p => [p.x, p.y]);
          if (a.rotate) rots = sp.map(p => p.angle);
          break;
        }
        case 'scatter': {
          const B = a.bounds ?? [pBox[0] * 0.1, pBox[1] * 0.1, pBox[0] * 0.8, pBox[1] * 0.8];
          const R = rng(a.seed ?? 1);
          const minD = a.minDistance ?? Math.max(...sizes.map(x => Math.max(x[0], x[1]))) * 0.9;
          for (let i = 0; i < n; i++) {
            let best: number[] = [0, 0], bd = -1;
            for (let k = 0; k < 40; k++) {
              const p = [B[0] + sizes[i][0] / 2 + R() * Math.max(0, B[2] - sizes[i][0]), B[1] + sizes[i][1] / 2 + R() * Math.max(0, B[3] - sizes[i][1])];
              const d = pts.length ? Math.min(...pts.map(q => Math.hypot(q[0] - p[0], q[1] - p[1]))) : Infinity;
              if (d > bd) { bd = d; best = p; }
              if (d >= minD) break;
            }
            pts.push(best);
          }
          break;
        }
        default: throw new Error('layout must be grid, row, column, radial, path or scatter');
      }
      const tr = a.transition;
      if (tr) resolveEase(tr.ease ?? 'Expo Out');
      s.transact('Agent: arrange', tx => {
        list.forEach((l, i) => {
          const target = positionForCenter(l, pts[i], t);
          if (tr) {
            const t0 = (tr.t ?? t) + i * (tr.stagger ?? 0), dur = tr.duration ?? 0.6;
            const from = valueAt(l, 'position', t0);
            const p = l.props.position!;
            const keep = (p.kf ?? []).filter(k => k.t < t0 - 1e-6 || k.t > t0 + dur + 1e-6);
            tx.set(p, 'kf', [...keep, ...buildKeys('position', [{ t: t0, v: from, ease: tr.ease ?? 'Expo Out' }, { t: t0 + dur, v: target }])].sort((x, y) => x.t - y.t));
            if (rots[i] != null) {
              const r = l.props.rotation ?? { v: [0] };
              if (!l.props.rotation) tx.set(l.props, 'rotation', r);
              tx.set(r, 'kf', buildKeys('rotation', [{ t: t0, v: valueAt(l, 'rotation', t0), ease: tr.ease ?? 'Expo Out' }, { t: t0 + dur, v: rots[i]! }]));
            }
          } else {
            movePositionTx(tx, l, target, t);
            if (rots[i] != null) { if (l.props.rotation?.kf?.length) tx.set(l.props.rotation, 'kf', undefined); tx.set(l.props, 'rotation', { v: [rots[i]!] }); }
          }
          tx.touch(l.id);
        });
      });
      return text({ arranged: n, layout: a.layout, centers: pts.map(p => p.map(Math.round)) .slice(0, 24) });
    },
  },
  {
    name: 'choreograph',
    description: 'Re-time whole layer animations into a stagger pattern (keeps each layer\'s own keys and eases, shifts them): sequential (given order), reverse, center-out, edges-in, random (seed), wave (by position along axis x/y, e.g. left→right ripple), distance (from a point, e.g. a shockwave). Timing: step = seconds between consecutive layers/ranks, or overlap = 0..1 share of each animation overlapping the previous one (0 = one after another, 0.7 = tight cascade), or spread = total seconds first→last (wave/distance). ids: layers, or one group = its children.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: idsSchema,
        pattern: { enum: ['sequential', 'reverse', 'center-out', 'edges-in', 'random', 'wave', 'distance'] },
        step: { type: 'number' }, overlap: { type: 'number', description: '0..1 (or 0..100 %)' }, spread: { type: 'number' },
        start: { type: 'number', description: 'when the first layer starts (default: earliest current start)' },
        axis: { enum: ['x', 'y', 'xy'], description: 'wave direction (xy = diagonal)' }, reverse: { type: 'boolean', description: 'wave/distance: from the far end' },
        point: { type: 'array', items: { type: 'number' }, description: 'distance pattern origin in comp px (default: comp center)' },
        seed: { type: 'number' },
      },
      required: ['ids'],
    },
    run: a => {
      const s = st();
      const list = members(a.ids, 'choreograph');
      const animated = list.filter(l => animRange(l));
      const skipped = list.filter(l => !animRange(l)).map(l => l.name);
      if (animated.length < 2) throw new Error('choreograph needs at least two animated layers (animate them first, e.g. build_scene enter or apply_preset)');
      const n = animated.length;
      const ranges = animated.map(l => animRange(l)!);
      const durs = ranges.map(r => Math.max(0.01, r[1] - r[0]));
      const ov = a.overlap !== undefined ? (a.overlap > 1 ? a.overlap / 100 : a.overlap) : undefined;
      if (ov !== undefined && !(ov >= 0 && ov < 1)) throw new Error('overlap must be 0..1 (or 0..99 %)');
      const step = a.step ?? (ov !== undefined ? (durs.reduce((x, y) => x + y, 0) / n) * (1 - ov) : 0.08);
      const pattern = a.pattern ?? 'sequential';
      let delays: number[];
      if (pattern === 'wave' || pattern === 'distance') {
        const tEnd = Math.max(...ranges.map(r => r[1]));
        const cs = animated.map(l => centerOf(s, l, tEnd));
        const P = a.point ?? [s.comp.width / 2, s.comp.height / 2];
        const val = cs.map(c => pattern === 'distance' ? Math.hypot(c[0] - P[0], c[1] - P[1]) : a.axis === 'y' ? c[1] : a.axis === 'xy' ? c[0] + c[1] : c[0]);
        const lo = Math.min(...val), hi = Math.max(...val);
        const spread = a.spread ?? step * (n - 1);
        delays = val.map(v => (hi > lo ? ((a.reverse ? hi - v : v - lo) / (hi - lo)) * spread : 0));
      } else {
        if (!['sequential', 'reverse', 'center-out', 'edges-in', 'random'].includes(pattern)) throw new Error('pattern must be sequential, reverse, center-out, edges-in, random, wave or distance');
        delays = orderDelays(n, pattern, step, a.seed ?? 1);
      }
      const base = a.start ?? Math.min(...ranges.map(r => r[0]));
      if (base < 0) throw new Error('start must be >= 0');
      s.transact('Agent: choreograph', tx => {
        animated.forEach((l, i) => {
          const d = base + delays[i] - ranges[i][0];
          if (Math.abs(d) > 1e-9) { shiftLayerKeys(tx, l, t => Math.max(0, t + d), 1); tx.touch(l.id); }
        });
      });
      const end = Math.max(...animated.map(l => animRange(l)![1]));
      return text(`${pattern}: ${n} layers start ${fmtTime(base)}…${fmtTime(base + Math.max(...delays))} (step ${r2(step)}s), last ends ${fmtTime(end)}${end > s.comp.duration ? ` — past comp end ${fmtTime(s.comp.duration)}` : ''}${skipped.length ? `; skipped (not animated): ${skipped.join(', ')}` : ''}`);
    },
  },
  {
    name: 'secondary_motion',
    description: 'Add follow-through to existing moves: overshoot past the target then settle back (oscillations), and/or anticipation (a small opposite move before the main move). Works on position, scale, rotation and size keys; the main move still arrives at its original time, settling adds time after it (squeezed if the next key is close). overshoot/anticipation are fractions of each move (0.1 = 10%).',
    inputSchema: {
      type: 'object',
      properties: {
        ids: idsSchema,
        props: { type: 'array', items: { enum: ['position', 'scale', 'rotation', 'size'] }, description: 'default: all of these that are animated' },
        overshoot: { type: 'number', description: '0..0.6, default 0.12 (0 = none)' },
        settle: { type: 'number', description: 'seconds to settle after arriving (default: 40% of the move, 0.15..0.6)' },
        oscillations: { type: 'number', description: '1..3 swings while settling (default 1)' },
        anticipation: { type: 'number', description: '0..0.5, default 0' },
        segments: { enum: ['all', 'first', 'last'], description: 'which moves of each property (default all)' },
      },
      required: ['ids'],
    },
    run: a => {
      const s = st();
      const list = members(a.ids, 'add secondary motion to');
      const os = a.overshoot ?? 0.12, an = a.anticipation ?? 0, osc = Math.max(1, Math.min(3, Math.round(a.oscillations ?? 1)));
      if (!(os >= 0 && os <= 0.6) || !(an >= 0 && an <= 0.5)) throw new Error('overshoot must be 0..0.6 and anticipation 0..0.5');
      if (os === 0 && an === 0) throw new Error('nothing to add: set overshoot and/or anticipation above 0');
      const props: PropKey[] = a.props ?? ['position', 'scale', 'rotation', 'size'];
      const sine = resolveEase('Sine In Out').v;
      const report: string[] = [];
      const skipped: string[] = [];
      s.transact('Agent: secondary motion', tx => {
        for (const l of list) {
          let moves = 0;
          for (const key of props) {
            const kf = l.props[key]?.kf;
            if (!kf || kf.length < 2) continue;
            const segs: number[] = [];
            for (let i = 0; i < kf.length - 1; i++) if (kf[i].interp !== 'hold' && kf[i].interp !== 'spring' && kf[i].v.some((x, d) => Math.abs(x - kf[i + 1].v[d]) > 1e-6)) segs.push(i);
            const pick = a.segments === 'first' ? segs.slice(0, 1) : a.segments === 'last' ? segs.slice(-1) : segs;
            if (!pick.length) continue;
            const extra: Keyframe[] = [];
            const arrival = new Map<number, number[]>();
            const windUp = new Set<number>();
            for (const i of pick) {
              const k = kf[i], b = kf[i + 1], d = b.t - k.t;
              const D = b.v.map((x, j) => x - k.v[j]);
              if (an > 0 && !arrival.has(i)) {
                // wind-up: ease into a small opposite move, then the original ease takes it to the target
                extra.push({ t: k.t + d * 0.25, v: k.v.map((x, j) => x - D[j] * an), interp: k.interp, out: k.out, in: [sine[2], sine[3]] });
                windUp.add(i);
              }
              if (os > 0) {
                const next = kf[i + 2];
                let settle = a.settle ?? Math.min(0.6, Math.max(0.15, d * 0.4));
                if (next) settle = Math.min(settle, (next.t - b.t) * 0.7);
                if (settle >= 0.06) {
                  // arrive past the target at the original time, then swing back and forth and settle
                  arrival.set(i + 1, b.v.map((x, j) => x + D[j] * os));
                  for (let j = 1; j <= osc; j++) {
                    const amp = os * Math.pow(-0.45, j);
                    extra.push({ t: b.t + settle * j / (osc + 1), v: b.v.map((x, q) => x + D[q] * amp), interp: 'bezier', out: [sine[0], sine[1]], in: [sine[2], sine[3]] });
                  }
                  extra.push({ t: b.t + settle, v: b.v.slice(), interp: b.interp, out: b.out, in: [sine[2], sine[3]], ...(b.bounce !== undefined ? { bounce: b.bounce } : {}) });
                }
              }
              moves++;
            }
            const final: Keyframe[] = kf.map((k, i) => {
              let x: Keyframe = { ...k };
              if (windUp.has(i)) x = { ...x, interp: 'bezier', out: [sine[0], sine[1]] };
              if (arrival.has(i)) x = { ...x, v: arrival.get(i)!, interp: 'bezier', out: [sine[0], sine[1]] };
              return x;
            });
            final.push(...extra);
            final.sort((x, y) => x.t - y.t);
            tx.set(l.props[key]!, 'kf', final);
            tx.touch(l.id);
          }
          if (moves) report.push(`${l.name} (${moves} moves)`); else skipped.push(l.name);
        }
      });
      if (!report.length) throw new Error(`no moves found on ${props.join('/')} of these layers (they need 2+ keys with different values; spring/hold segments are left alone)`);
      return text(`added ${[os > 0 ? `overshoot ${Math.round(os * 100)}%` : '', an > 0 ? `anticipation ${Math.round(an * 100)}%` : ''].filter(Boolean).join(' + ')} to ${report.join(', ')}${skipped.length ? `; nothing to change on ${skipped.join(', ')}` : ''}`);
    },
  },
  {
    name: 'loop',
    description: 'Make layers loop seamlessly. cycle: adds a closing key equal to the first (at start + duration, or one average segment after the last key) and sets loopOut("cycle"); pingpong: back and forth (no closing key needed); offset: keeps adding the change (e.g. endless rotation). Properties expressions cannot drive (trim, path shapes) are baked by repeating keys to the comp end. fitComp sets the comp duration to a whole number of loops.',
    inputSchema: {
      type: 'object',
      properties: { ids: idsSchema, mode: { enum: ['cycle', 'pingpong', 'offset'] }, duration: { type: 'number', description: 'loop length in seconds (default: from the keys)' }, fitComp: { type: 'boolean' } },
      required: ['ids'],
    },
    run: a => {
      const s = st();
      const list = members(a.ids, 'loop');
      const mode = a.mode ?? 'cycle';
      if (!['cycle', 'pingpong', 'offset'].includes(mode)) throw new Error('mode must be cycle, pingpong or offset');
      const notes: string[] = [];
      let period = 0, count = 0;
      const compEnd = s.comp.duration;
      s.transact('Agent: loop', tx => {
        for (const l of list) {
          let did = false;
          for (const key of PROP_KEYS) {
            const p = l.props[key];
            const kf = p?.kf;
            if (!p || !kf || kf.length < 2) continue;
            if (p.expr && !/loop(Out|In)\s*\(/.test(p.expr)) { notes.push(`${l.name}.${key}: has an expression, left alone`); continue; }
            let keys = kf.map(k => ({ ...k }));
            const first = keys[0], last = keys[keys.length - 1];
            if (mode === 'cycle') {
              const len = a.duration ?? (last.t - first.t) * keys.length / (keys.length - 1);
              const endT = first.t + len;
              if (endT < last.t - 1e-6) throw new Error(`${l.name}.${key}: keys run to ${fmtTime(last.t)}, longer than the loop duration ${fmtTime(len)}`);
              const same = last.v.every((x, i) => Math.abs(x - first.v[i]) < 1e-6);
              if (!same || endT > last.t + 1e-6) {
                if (Math.abs(endT - last.t) < 1e-6) keys[keys.length - 1] = { ...last, v: first.v.slice() };
                else { last.interp = first.interp; last.out = first.out; keys.push({ ...first, t: endT, v: first.v.slice(), in: first.in }); }
              }
              period = Math.max(period, endT - first.t);
            } else period = Math.max(period, (last.t - first.t) * (mode === 'pingpong' ? 2 : 1));
            if (EXPR_PROPS.includes(key)) { tx.set(p, 'kf', keys); tx.set(p, 'expr', `loopOut('${mode}')`); }
            else {
              // bake: repeat the cycle (or the back-and-forth) up to the comp end
              const span = keys[keys.length - 1].t - keys[0].t;
              if (span <= 0 || mode === 'offset') { notes.push(`${l.name}.${key}: cannot loop this property with ${mode}`); continue; }
              const out = keys.slice();
              let rev = false;
              for (let off = span; keys[0].t + off < compEnd + span; off += span) {
                rev = !rev;
                const seq = mode === 'pingpong' && rev ? keys.slice().reverse().map((k, i) => ({ ...k, t: keys[0].t + off + (span - (k.t - keys[0].t)) })) : keys.map(k => ({ ...k, t: k.t + off }));
                out.push(...seq.slice(1));
                if (out.length > 2000) break;
              }
              tx.set(p, 'kf', out);
              notes.push(`${l.name}.${key}: baked to comp end`);
            }
            did = true;
          }
          if (l.pathKf && l.pathKf.length >= 2 && mode !== 'offset') notes.push(`${l.name}: path shape keys not looped (use morph with back)`);
          if (did) { count++; tx.touch(l.id); } else notes.push(`${l.name}: nothing animated to loop`);
        }
        if (a.fitComp && period > 0) {
          const loops = Math.max(1, Math.round(compEnd / period));
          tx.set(s.comp, 'duration', Math.round(loops * period * 1000) / 1000);
          tx.comp();
        }
      });
      if (!count) throw new Error(`nothing to loop: ${notes.join('; ')}`);
      const loops = period > 0 ? s.comp.duration / period : 0;
      return text(`${mode} loop on ${count} layer(s), period ${fmtTime(period)}; comp ${fmtTime(s.comp.duration)} = ${r2(loops)} loops${Math.abs(loops - Math.round(loops)) > 0.01 ? ' (not whole: pass fitComp:true for a seamless file)' : ''}${notes.length ? '; ' + notes.join('; ') : ''}`);
    },
  },
  {
    name: 'camera_rig',
    description: 'Parallax camera: puts top-level layers into depth groups (one group per depth, a "null" you can also animate) and keys a camera move (pan x/y in px, zoom %) on them. depth 1 = moves with the camera, 0.5 = far background (half speed), 2 = foreground (double), 0 = fixed (HUD/titles). Calling again with the same depths reuses the groups and replaces the camera keys.',
    inputSchema: {
      type: 'object',
      properties: {
        layers: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, depth: { type: 'number' } }, required: ['id', 'depth'] } },
        keys: { type: 'array', description: 'camera keyframes', items: { type: 'object', properties: { t: { type: 'number' }, x: { type: 'number', description: 'pan right, px' }, y: { type: 'number', description: 'pan down, px' }, zoom: { type: 'number', description: '% (100 = none)' }, ease: easeSchema }, required: ['t'] } },
      },
      required: ['layers', 'keys'],
    },
    run: a => {
      const s = st(), P = s.project, comp = s.comp;
      if (!Array.isArray(a.layers) || !a.layers.length) throw new Error('layers must list {id, depth}');
      if (!Array.isArray(a.keys) || !a.keys.length) throw new Error('keys must list camera keyframes {t, x, y, zoom}');
      for (const k of a.keys) if (k.ease !== undefined) resolveEase(k.ease);
      const W = comp.width, H = comp.height;
      const depths = [...new Set(a.layers.map((x: any) => +x.depth))].sort((p: any, q: any) => p - q) as number[];
      for (const x of a.layers) { const l = need(x.id); if (!(x.depth >= 0)) throw new Error('depth must be >= 0'); const top = l.parent ? P.layers[l.parent] : null; if (top && !top.sceneKey?.startsWith('camera:')) throw new Error(`"${l.name}" is inside a group: rig top-level layers (or the group itself)`); }
      const sorted = a.keys.slice().sort((p: any, q: any) => p.t - q.t);
      const groups: Record<string, string> = {};
      s.transact('Agent: camera rig', tx => {
        for (const d of depths) {
          const key = `camera:${d}`;
          let g = Object.values(P.layers).find(l => l.sceneKey === key && comp.root.includes(l.id));
          const mem = a.layers.filter((x: any) => +x.depth === d).map((x: any) => need(x.id));
          if (!g) {
            g = createLayer('group', { x: 0, y: 0, w: W, h: H, name: d === 0 ? 'Camera · fixed' : `Camera · depth ${d}` });
            g.sceneKey = key;
            const idx = Math.min(...mem.map((m: Layer) => (m.parent ? comp.root.indexOf(m.parent) : comp.root.indexOf(m.id))).filter((i: number) => i >= 0));
            insertLayer(s, tx, g, null, isFinite(idx) ? idx : undefined);
          }
          const G = g;
          for (const m of mem as Layer[]) {
            if (m.parent === G.id) continue;
            if (m.parent) { const op = P.layers[m.parent]; tx.set(op, 'children', op.children.filter(c => c !== m.id)); }
            else tx.set(comp, 'root', comp.root.filter(c => c !== m.id));
            // the group box sits at 0,0 with an identity transform at rest: child coordinates stay valid
            tx.set(G, 'children', [...G.children, m.id]);
            tx.set(m, 'parent', G.id);
            tx.touch(m.id);
          }
          const frames = sorted.map((k: any) => ({ t: k.t, ease: k.ease ?? 'Ease In Out', x: k.x ?? 0, y: k.y ?? 0, z: (k.zoom ?? 100) / 100 }));
          tx.set(G.props, 'anchor', { v: [W / 2, H / 2] });
          tx.set(G.props, 'position', { v: [W / 2, H / 2], kf: buildKeys('position', frames.map((f: any) => ({ t: f.t, ease: f.ease, v: [W / 2 - f.x * d, H / 2 - f.y * d] }))) });
          tx.set(G.props, 'scale', { v: [100, 100], kf: buildKeys('scale', frames.map((f: any) => ({ t: f.t, ease: f.ease, v: 100 * (1 + (f.z - 1) * d) }))) });
          if (d === 0) { tx.set(G.props.position!, 'kf', undefined); tx.set(G.props.scale!, 'kf', undefined); }
          tx.touch(G.id);
          groups[String(d)] = G.id;
        }
        // drop rig groups that ended up empty
        for (const l of Object.values(P.layers)) if (l.sceneKey?.startsWith('camera:') && !l.children.length && comp.root.includes(l.id)) { tx.set(comp, 'root', comp.root.filter(c => c !== l.id)); tx.del(P.layers, l.id); }
        tx.structure();
      });
      return text({ groups, keys: sorted.length, note: 'animate a depth group like a null for extra moves; depth 0 stays fixed' });
    },
  },
  {
    name: 'align_to_beats',
    description: 'Snap animation to beats: explicit times, a bpm grid, or (default) the beats of the analysed music layer. mode start: each layer\'s animation starts on the nearest beat; sequence: layer i starts on beat fromBeat+i (one hit per beat); end: each animation lands (last key) on the nearest beat; keys: every key within tolerance snaps to its nearest beat (key spacing changes).',
    inputSchema: {
      type: 'object',
      properties: {
        ids: idsSchema, mode: { enum: ['start', 'sequence', 'end', 'keys'] },
        beats: { type: 'array', items: { type: 'number' }, description: 'beat times (default: the music\'s beats)' },
        bpm: { type: 'number' }, offset: { type: 'number', description: 'bpm grid: first beat time' },
        fromBeat: { type: 'number', description: 'sequence: index of the first beat (default 0)' },
        tolerance: { type: 'number', description: 'keys mode: max snap distance in seconds (default 0.25)' },
      },
      required: ['ids'],
    },
    run: a => {
      const s = st();
      const list = members(a.ids, 'align');
      let beats: number[] = a.beats?.map(Number) ?? [];
      if (!beats.length && a.bpm) { const step = 60 / a.bpm; for (let t = a.offset ?? 0; t <= s.comp.duration + 1e-9; t += step) beats.push(Math.round(t * 1000) / 1000); }
      if (!beats.length) { const m = music(s); if (m) beats = musicBeats(m); }
      if (!beats.length) throw new Error('no beats: add a music layer (analysed), or pass beats [...] or bpm');
      beats.sort((x, y) => x - y);
      const near = (t: number) => beats.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), beats[0]);
      const mode = a.mode ?? 'start';
      const animated = list.filter(l => animRange(l));
      if (!animated.length) throw new Error('none of these layers is animated');
      const lines: string[] = [];
      s.transact('Agent: align to beats', tx => {
        animated.forEach((l, i) => {
          const r = animRange(l)!;
          if (mode === 'keys') {
            const tol = a.tolerance ?? 0.25;
            let moved = 0;
            for (const k of PROP_KEYS) {
              const p = l.props[k];
              if (!p?.kf?.length) continue;
              const used = new Set<number>();
              const kf = p.kf.map(x => { const b = near(x.t); if (Math.abs(b - x.t) <= tol && Math.abs(b - x.t) > 1e-6 && !used.has(b) && !p.kf!.some(o => o !== x && Math.abs(o.t - b) < 1e-6)) { used.add(b); moved++; return { ...x, t: b }; } return x; });
              kf.sort((x, y) => x.t - y.t);
              tx.set(p, 'kf', kf);
            }
            if (moved) { tx.touch(l.id); lines.push(`${l.name}: ${moved} keys`); }
            return;
          }
          let target: number;
          if (mode === 'sequence') { const bi = (a.fromBeat ?? 0) + i; if (bi >= beats.length) { lines.push(`${l.name}: no beat #${bi}, left`); return; } target = beats[bi]; }
          else if (mode === 'end') target = near(r[1]) - (r[1] - r[0]);
          else target = near(r[0]);
          const d = target - r[0];
          if (target < 0) { lines.push(`${l.name}: would start before 0, left`); return; }
          if (Math.abs(d) > 1e-9) { shiftLayerKeys(tx, l, t => Math.max(0, t + d), 1); tx.touch(l.id); }
          lines.push(`${l.name} → ${fmtTime(mode === 'end' ? target + r[1] - r[0] : target)}`);
        });
      });
      return text(`${mode} on ${beats.length} beats: ${lines.join(', ') || 'nothing moved'}`);
    },
  },
];

export { apply };
