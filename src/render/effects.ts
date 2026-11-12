// layer effects: from the model (Layer.effects + the animatable effect props) to resolved values per
// frame, in layer units. pure (no gl): the renderer converts them to device pixels and runs the gpu
// passes in fx.ts. see core/model.ts Effect for the "first effect of a type is live" rule.

import { Track } from '../core/evaluate';
import { PROP_DEFS, SIMPLE_BLENDS, type BlendMode, type Effect, type EffectType, type Layer, type NoiseParams, type PropKey } from '../core/model';

export interface ResolvedEffect {
  type: EffectType;
  color: number[];
  offset: [number, number];
  /** figma blur radius (gaussian sigma = radius / 2) */
  radius: number;
  spread: number;
  showBehind: boolean;
  progressive?: Effect['progressive'];
  noise?: NoiseParams;
  params?: Record<string, number>;
}

/** which props feed the live (first) effect of each type */
const LIVE: Partial<Record<EffectType, { color?: PropKey; offset?: PropKey; radius?: PropKey; spread?: PropKey; noiseColor?: PropKey; noiseSize?: PropKey; noiseDensity?: PropKey }>> = {
  dropShadow: { color: 'shadowColor', offset: 'shadowOffset', radius: 'shadowBlur', spread: 'shadowSpread' },
  innerShadow: { color: 'innerShadowColor', offset: 'innerShadowOffset', radius: 'innerShadowBlur', spread: 'innerShadowSpread' },
  layerBlur: { radius: 'blur' },
  backgroundBlur: { radius: 'backgroundBlur' },
  noise: { noiseColor: 'noiseColor', noiseSize: 'noiseSize', noiseDensity: 'noiseDensity' },
};

/** the effect list a layer renders with (explicit effects + implicit ones from effect props) */
export function effectList(l: Layer): Effect[] {
  const list = l.effects ? l.effects.slice() : [];
  const has = (t: EffectType) => list.some(e => e.type === t);
  const p = l.props;
  if (!has('dropShadow') && p.shadowColor) list.push({ type: 'dropShadow' });
  if (!has('innerShadow') && p.innerShadowColor) list.push({ type: 'innerShadow' });
  if (!has('layerBlur') && p.blur) list.push({ type: 'layerBlur' });
  if (!has('backgroundBlur') && p.backgroundBlur) list.push({ type: 'backgroundBlur' });
  if (!has('noise') && p.noiseColor) list.push({ type: 'noise', noise: { mode: 'mono', size: 1, density: 0.5 } });
  return list;
}

/** does this layer render through the effect pipeline at all (cheap check at compile time) */
export function hasEffects(l: Layer): boolean {
  if (l.effects?.some(e => e.visible !== false)) return true;
  const p = l.props;
  return !!(p.shadowColor || p.innerShadowColor || p.blur || p.backgroundBlur || p.noiseColor);
}

/** blend modes that need the backdrop: drawn through the effect composite (never by the gpu blend unit) */
export function needsBlendShader(b: BlendMode | undefined): boolean {
  return !!b && !SIMPLE_BLENDS.has(b);
}

/** compiled effect evaluation for one layer: tracks for the animated live props */
export class EffectEval {
  readonly list: Effect[];
  readonly animated: boolean;
  private tracks = new Map<PropKey, Track>();
  private buf = new Float64Array(4);
  constructor(layer: Layer, prop: (k: PropKey) => Layer['props'][PropKey]) {
    this.list = effectList(layer).filter(e => e.visible !== false);
    let anim = false;
    for (const e of this.list) {
      const live = LIVE[e.type];
      if (!live) continue;
      for (const k of Object.values(live)) {
        if (!k || this.tracks.has(k)) continue;
        const p = prop(k);
        if (!p) continue;
        this.tracks.set(k, new Track(p, PROP_DEFS[k].dim));
        if ((p.kf?.length ?? 0) > 1) anim = true;
      }
    }
    this.animated = anim;
  }

  private val(k: PropKey | undefined, t: number): number[] | null {
    if (!k) return null;
    const tr = this.tracks.get(k);
    if (!tr) return null;
    tr.eval(t, this.buf, 0);
    return Array.from(this.buf.subarray(0, PROP_DEFS[k].dim));
  }

  /** resolved effects at local time t (figma order) */
  at(t: number): ResolvedEffect[] {
    const out: ResolvedEffect[] = [];
    const seen = new Set<EffectType>();
    for (const e of this.list) {
      const live = !seen.has(e.type) ? LIVE[e.type] : undefined;
      seen.add(e.type);
      const r: ResolvedEffect = {
        type: e.type,
        color: (live && this.val(live.color, t)) || e.color || [0, 0, 0, 0.25],
        offset: ((live && this.val(live.offset, t)) || e.offset || [0, 4]) as [number, number],
        radius: (live && this.val(live.radius, t)?.[0]) ?? e.radius ?? (e.type === 'dropShadow' || e.type === 'innerShadow' ? 4 : 0),
        spread: (live && this.val(live.spread, t)?.[0]) ?? e.spread ?? 0,
        showBehind: !!e.showBehind,
      };
      if (e.progressive) r.progressive = e.progressive;
      if (e.params) r.params = e.params;
      if (e.type === 'noise' || e.type === 'texture') {
        const n: NoiseParams = { ...(e.noise ?? { mode: 'mono', size: 1, density: 0.5 }) };
        if (live) {
          const c = this.val(live.noiseColor, t), s = this.val(live.noiseSize, t), d = this.val(live.noiseDensity, t);
          if (c) { if (n.mode === 'multi') n.opacity = c[3]; else n.color = c; }
          if (s) n.size = s[0];
          if (d) n.density = Math.max(0, Math.min(1, d[0] / 100));
        }
        r.noise = n;
      }
      out.push(r);
    }
    return out;
  }

  /** how far (layer units) effects reach outside the layer's own pixels */
  padding(fx: ResolvedEffect[]): number {
    let pad = 0;
    for (const e of fx) {
      if (e.type === 'dropShadow') pad = Math.max(pad, Math.abs(e.offset[0]) + Math.abs(e.offset[1]) + Math.max(0, e.spread) + e.radius * 1.5);
      else if (e.type === 'layerBlur') pad = Math.max(pad, Math.max(e.radius, e.progressive?.startRadius ?? 0) * 1.5);
      else if (e.type === 'texture') pad = Math.max(pad, e.radius + 2);
    }
    return pad;
  }
}
