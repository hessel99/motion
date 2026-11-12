import { springAt } from '../core/easing';
// export our model to lottie / bodymovin json (v5 schema).
//
// mapping:
//  - rect / ellipse  -> shape layer (ty 4) with one group: rc / el + fl (+ st). the shape's
//                       centre follows size/2 so the layer transform maps 1:1 (our box = layer space)
//  - path            -> shape layer with one sh per subpath (geometry scaled by size/geomSize, static)
//  - group           -> null layer (ty 3) used as parent; a group with a visible fill also gets a rect
//  - text            -> text layer (ty 5), exported as box text (sz/ps) so the box round-trips
//  - image           -> image layer (ty 2) with an embedded asset
//  - our tree        -> ae parenting (`parent` = ind of the parent layer)
// keyframes keep times (frames), values, bezier handles (o of key k / i of key k+1), hold (h:1)
// and spatial tangents (to/ti).
// known gaps: our group opacity multiplies into children but ae parenting does not inherit
// opacity, so group opacity only affects the group's own fill; clip is not exported.

import type { Composition, Keyframe, Layer, Paint, PathCmd, Project, Prop } from '../core/model';

const R = (x: number) => Math.round(x * 1e6) / 1e6;
const WEIGHT_STYLE: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

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
  const r = exportPropInner(p, def, fr, conv, spatial);
  // expressions: our syntax is a subset of after effects / lottie-web javascript for the common cases
  // (audio() reads the editor's music analysis: lottie players have no music, so those keep their keys)
  if (p?.expr && !/\baudio\s*\(/.test(p.expr)) r.x = p.expr.startsWith('var ') ? p.expr : `var $bm_rt = ${p.expr};`;
  return r;
}

function exportPropInner(p: Prop | undefined, def: number[], fr: number, conv: (v: number[]) => number[] = v => v, spatial = false): any {
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
  return { v: fn(p.v), kf: p.kf?.map(k => ({ ...k, v: fn(k.v) })) };
}

function transform(l: Layer, fr: number, anchorOverride?: Prop): any {
  return {
    a: exportProp(anchorOverride ?? l.props.anchor, [0, 0], fr),
    p: exportProp(l.props.position, [0, 0], fr, v => v, true),
    s: exportProp(l.props.scale, [100, 100], fr),
    r: exportProp(l.props.rotation, [0], fr),
    o: exportProp(l.props.opacity, [100], fr),
  };
}

const IDENTITY_TR = {
  ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 }, nm: 'Transform',
};

/** our linear/radial paint -> lottie gradient fill (gf) in layer space */
function gradientItem(l: Layer, p: Paint): any {
  const sz = l.geomSize ?? (firstV(l.props.size, [100, 100]) as [number, number]);
  const m = p.transform ?? [1, 0, 0, 1, 0, 0];
  const map = (x: number, y: number) => [R((m[0] * x + m[2] * y + m[4]) * sz[0]), R((m[1] * x + m[3] * y + m[5]) * sz[1])];
  const stops = (p.stops ?? []).slice().sort((a, b) => a.pos - b.pos);
  const k: number[] = [];
  for (const st of stops) k.push(R(st.pos), R(st.color[0]), R(st.color[1]), R(st.color[2]));
  for (const st of stops) k.push(R(st.pos), R(st.color[3] ?? 1));
  const [s0, e0] = p.type === 'linear' ? [map(0, 0.5), map(1, 0.5)] : [map(0.5, 0.5), map(1, 0.5)];
  return { ty: 'gf', nm: 'Gradient Fill', t: p.type === 'linear' ? 1 : 2, r: 1, o: { a: 0, k: R((p.opacity ?? 1) * 100) }, s: { a: 0, k: s0 }, e: { a: 0, k: e0 }, g: { p: stops.length, k: { a: 0, k } }, h: { a: 0, k: 0 }, a: { a: 0, k: 0 } };
}

function paintItems(l: Layer, fr: number): any[] {
  const out: any[] = [];
  const grad = l.paints?.find(p => (p.type === 'linear' || p.type === 'radial') && p.stops?.length);
  if (grad) out.push(gradientItem(l, grad));
  const fill = l.props.fill;
  const fv = firstV(fill, [0, 0, 0, 0]);
  if (!grad && fill && (fill.kf?.length || fv[3] > 0)) {
    out.push({
      ty: 'fl', nm: 'Fill', r: l.geometry?.[0]?.fillRule === 'evenodd' ? 2 : 1,
      c: exportProp(mapPropValues(fill, v => [v[0], v[1], v[2], 1]), [0, 0, 0, 1], fr),
      o: exportProp(mapPropValues(fill, v => [(v[3] ?? 1) * 100]), [100], fr),
    });
  }
  const sw = firstV(l.props.strokeWidth, [0])[0];
  const st = l.props.stroke;
  if (st && (sw > 0 || l.props.strokeWidth?.kf?.length)) {
    out.push({
      ty: 'st', nm: 'Stroke', lc: 2, lj: 2, ml: 4,
      c: exportProp(mapPropValues(st, v => [v[0], v[1], v[2], 1]), [0, 0, 0, 1], fr),
      o: exportProp(mapPropValues(st, v => [(v[3] ?? 1) * 100]), [100], fr),
      w: exportProp(l.props.strokeWidth, [0], fr),
    });
  }
  return out;
}

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

function hex(c: number[]) {
  const h = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
  return `#${h(c[0] ?? 0)}${h(c[1] ?? 0)}${h(c[2] ?? 0)}`;
}

export function projectToLottie(project: Project): any {
  const comp = project.comps[project.activeComp] ?? Object.values(project.comps)[0];
  if (!comp) throw new Error('project has no composition');
  const fr = comp.fps || 30;
  const op = Math.max(1, Math.round(comp.duration * fr));
  const assets: any[] = [];
  const assetIds = new Map<string, string>();
  const fonts = new Map<string, any>();
  const buildLayers = (comp: Composition, stack: string[]): any[] => {
    const L = project.layers;
    // draw order (bottom -> top), parents before children
    const order: string[] = [];
    const walk = (ids: string[]) => { for (const id of ids) { const l = L[id]; if (!l) continue; order.push(id); walk(l.children); } };
    walk(comp.root);
    const n = order.length;
    const ind = new Map<string, number>();
    // lottie order is top -> bottom; ind = position in that list (1-based)
    for (let i = 0; i < n; i++) ind.set(order[i], n - i);
    const layers: any[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const l = L[order[i]];
      const base: any = {
        ddd: 0, ind: ind.get(l.id), nm: l.name, sr: 1, st: 0, bm: 0,
        ip: Math.max(0, R(l.inPoint * fr)), op: R(Math.min(l.outPoint, comp.duration) * fr),
        ks: transform(l, fr),
      };
      if (!(base.op > base.ip)) base.op = Math.max(op, base.ip + 1);
      if (l.parent && ind.has(l.parent)) base.parent = ind.get(l.parent);
      if (!l.visible) base.hd = true;
      const size = firstV(l.props.size, [100, 100]);
      switch (l.type) {
        case 'rect':
        case 'ellipse': {
          const prim: any = l.type === 'rect'
            ? { ty: 'rc', nm: 'Rectangle Path', d: 1, s: exportProp(l.props.size, [100, 100], fr), p: exportProp(mapPropValues(l.props.size, v => [v[0] / 2, v[1] / 2]), [50, 50], fr), r: exportProp(mapPropValues(l.props.radius, v => [v[0] ?? 0]), [0], fr) }
            : { ty: 'el', nm: 'Ellipse Path', d: 1, s: exportProp(l.props.size, [100, 100], fr), p: exportProp(mapPropValues(l.props.size, v => [v[0] / 2, v[1] / 2]), [50, 50], fr) };
          layers.push({ ...base, ty: 4, shapes: [{ ty: 'gr', nm: l.type === 'rect' ? 'Rectangle' : 'Ellipse', it: [prim, ...paintItems(l, fr), IDENTITY_TR] }] });
          break;
        }
        case 'path': {
          const gs = l.geomSize ?? (size as [number, number]);
          const sx = gs[0] ? size[0] / gs[0] : 1, sy = gs[1] ? size[1] / gs[1] : 1;
          const it: any[] = [];
          for (const g of l.geometry ?? []) for (const s of cmdsToLottieShapes(g.cmds, sx, sy)) it.push({ ty: 'sh', nm: 'Path', ks: { a: 0, k: s } });
          layers.push({ ...base, ty: 4, shapes: [{ ty: 'gr', nm: 'Path', it: [...it, ...paintItems(l, fr), IDENTITY_TR] }] });
          break;
        }
        case 'group': {
          const fv = firstV(l.props.fill, [0, 0, 0, 0]);
          if (fv[3] > 0 || l.props.fill?.kf?.length || l.paints?.some(p => p.type === 'linear' || p.type === 'radial')) {
            const prim = { ty: 'rc', nm: 'Rectangle Path', d: 1, s: exportProp(l.props.size, [100, 100], fr), p: exportProp(mapPropValues(l.props.size, v => [v[0] / 2, v[1] / 2]), [50, 50], fr), r: exportProp(mapPropValues(l.props.radius, v => [v[0] ?? 0]), [0], fr) };
            layers.push({ ...base, ty: 4, shapes: [{ ty: 'gr', nm: 'Rectangle', it: [prim, ...paintItems(l, fr), IDENTITY_TR] }] });
          } else layers.push({ ...base, ty: 3 });
          break;
        }
        case 'text': {
          const t = l.text!;
          const fill = firstV(l.props.fill, [1, 1, 1, 1]);
          const wStyle = WEIGHT_STYLE[Math.min(900, Math.max(100, Math.round((t.fontWeight || 400) / 100) * 100))];
          const fStyle = `${wStyle}${t.fontStyle === 'italic' ? ' Italic' : ''}`;
          const fName = (t.fontFamily || 'Inter').replace(/\s+/g, '') + '-' + fStyle.replace(/\s+/g, '');
          fonts.set(fName, { fName, fFamily: t.fontFamily || 'Inter', fStyle, ascent: 75, origin: 0, fPath: '', fWeight: '' });
          const doc = {
            s: t.fontSize, f: fName, t: t.content.replace(/\n/g, '\r'), j: t.align === 'right' ? 1 : t.align === 'center' ? 2 : 0,
            tr: t.fontSize ? R((t.letterSpacing / t.fontSize) * 1000) : 0, lh: R(t.fontSize * t.lineHeight), ls: 0,
            fc: [R(fill[0]), R(fill[1]), R(fill[2])], sz: size.slice(0, 2).map(R), ps: [0, 0],
          };
          layers.push({ ...base, ty: 5, t: { d: { k: [{ t: 0, s: doc }] }, p: {}, m: { g: 1, a: { a: 0, k: [0, 0] } }, a: [] } });
          break;
        }
        case 'precomp': {
          const inner = l.compRef ? project.comps[l.compRef] : undefined;
          if (inner && !stack.includes(inner.id)) {
            const refId = 'comp_' + inner.id;
            if (!assets.some(a => a.id === refId)) {
              const sub = buildLayers(inner, [...stack, inner.id]);
              assets.push({ id: refId, nm: inner.name, fr, layers: sub });
            }
            layers.push({ ...base, ty: 0, refId, w: inner.width, h: inner.height, st: R((l.startTime ?? 0) * fr) });
          } else layers.push({ ...base, ty: 3 });
          break;
        }
        case 'image': {
          const a = l.imageRef ? project.assets[l.imageRef] : undefined;
          if (a) {
            let id = assetIds.get(a.id);
            if (!id) {
              id = `image_${assetIds.size}`;
              assetIds.set(a.id, id);
              assets.push({ id, w: a.width, h: a.height, u: '', p: a.data, e: a.data.startsWith('data:') ? 1 : 0 });
            }
            layers.push({ ...base, ty: 2, refId: id });
          } else layers.push({ ...base, ty: 3 });
          break;
        }
      }
    }
    return layers;
  };
  const layers = buildLayers(comp, [comp.id]);
  const out: any = {
    v: '5.7.4', fr, ip: 0, op, w: comp.width, h: comp.height, nm: comp.name, ddd: 0, assets, layers, markers: (comp.markers ?? []).filter(m => m.t <= comp.duration).map(m => ({ tm: R(m.t * fr), cm: m.label, dr: 0 })),
  };
  if (fonts.size) out.fonts = { list: Array.from(fonts.values()) };
  return out;
}

export { hex as _hex };
