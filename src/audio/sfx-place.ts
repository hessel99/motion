// sound effects that follow the motion: find motion events (entrances, fast moves, landings, pops,
// draw-ons, type-ons, toggles, exits) from the keyframes, pick the ones worth a sound (density, grouping
// of near-simultaneous events, a per-second cap), map each to a sound type of ONE family, snap to the
// music's beats when there is music (and duck under it), and add them as normal audio layers in a
// "Sound effects" group. every sfx layer links to its source layer + event, so retiming the animation
// (sync to music, entrances on beats) re-follows it. strictly opt-in: only called on request.

import { createLayer, uid, PROP_KEYS, type Asset, type Keyframe, type Layer, type PropKey } from '../core/model';
import type { Store, Tx } from '../core/store';
import { insertLayer } from '../core/commands';
import { renderSfx, findFamily, type SfxFamily, type SfxType } from './sfx';
import { wavDataUrl } from './wav';
import { music, snapToMusic } from './timing';

export type MotionKind = 'move' | 'land' | 'pop' | 'drawon' | 'type' | 'text' | 'toggle' | 'exit' | 'fade';
export const SFX_FOR: Record<MotionKind, SfxType> = { move: 'whoosh', land: 'tap', pop: 'pop', drawon: 'sweep', type: 'key', text: 'swish', toggle: 'click', exit: 'swish', fade: 'sparkle' };
const WEIGHT: Record<MotionKind, number> = { land: 0.9, move: 0.8, pop: 0.85, drawon: 0.7, exit: 0.6, type: 0.55, text: 0.6, toggle: 0.75, fade: 0.3 };

export interface SfxEvent {
  layer: string;
  /** stable id within the layer (kind + index): sfx layers link to it */
  id: string;
  kind: MotionKind;
  /** the moment the sound refers to (landing, pop, start of a draw-on...) */
  t: number;
  /** duration of the motion behind it */
  dur: number;
  intensity: number;
  importance: number;
}

const changes = (a: Keyframe, b: Keyframe) => a.v.some((x, i) => Math.abs(x - (b.v[i] ?? x)) > 1e-6);

/** motion events of one layer (comp time) */
export function layerEvents(store: Store, l: Layer): SfxEvent[] {
  const c = store.comp, diag = Math.hypot(c.width, c.height);
  const out: SfxEvent[] = [];
  const size = l.props.size?.v ?? [100, 100];
  const area = Math.sqrt(Math.max(1, (size[0] * size[1]) / (c.width * c.height)));
  const sizeF = Math.max(0.45, Math.min(1, 0.4 + area * 1.5));
  const push = (kind: MotionKind, i: number, t: number, dur: number, intensity: number) => {
    const I = Math.max(0, Math.min(1, intensity));
    out.push({ layer: l.id, id: `${kind}:${i}`, kind, t, dur, intensity: I, importance: WEIGHT[kind] * (0.5 + 0.5 * I) * sizeF });
  };
  const kf = (k: PropKey) => l.props[k]?.kf ?? [];
  // position: moves (whoosh) and their landings (tap / impact)
  const pos = kf('position');
  let mi = 0;
  for (let i = 0; i + 1 < pos.length; i++) {
    const a = pos[i], b = pos[i + 1];
    if (!changes(a, b) || a.interp === 'hold') continue;
    const dist = Math.hypot(b.v[0] - a.v[0], b.v[1] - a.v[1]), dur = Math.max(1 / c.fps, b.t - a.t);
    const speed = dist / dur / diag; // comp diagonals per second
    const small = size[0] < 160 && size[1] < 160 && dur < 0.35 && dist < 220;
    if (small) { push('toggle', mi++, a.t, dur, 0.5); continue; }
    if (dist < diag * 0.03) continue;
    const landsHere = i + 2 >= pos.length || !changes(b, pos[i + 2]);
    if (speed > 0.25) push('move', mi, b.t, dur, Math.min(1, speed / 2));
    if (landsHere && dist > diag * 0.08) push('land', mi, b.t, dur, Math.min(1, dist / diag + speed / 4));
    mi++;
  }
  // scale: pops (from small) and shrink exits
  const sc = kf('scale');
  for (let i = 0; i + 1 < sc.length; i++) {
    const a = sc[i], b = sc[i + 1];
    if (!changes(a, b)) continue;
    const s0 = Math.max(Math.abs(a.v[0]), Math.abs(a.v[1])), s1 = Math.max(Math.abs(b.v[0]), Math.abs(b.v[1]));
    if (s0 < 35 && s1 > 60) push('pop', i, a.t + (b.t - a.t) * 0.3, b.t - a.t, Math.min(1, (s1 - s0) / 120));
    else if (s0 > 60 && s1 < 15 && i + 2 >= sc.length) push('exit', i, a.t, b.t - a.t, 0.5);
  }
  // opacity: plain fade-ins (quiet) and fade-out exits
  const op = kf('opacity');
  for (let i = 0; i + 1 < op.length; i++) {
    const a = op[i], b = op[i + 1];
    if (a.v[0] < 10 && b.v[0] > 80 && !out.some(e => Math.abs(e.t - a.t) < 0.4)) push('fade', i, a.t, b.t - a.t, 0.3);
    if (a.v[0] > 80 && b.v[0] < 10 && i + 2 >= op.length) push('exit', 100 + i, a.t, b.t - a.t, 0.45);
  }
  // draw-ons (trim paths)
  for (const k of ['trimEnd', 'trimStart'] as PropKey[]) {
    const tk = kf(k);
    for (let i = 0; i + 1 < tk.length; i++) if (Math.abs(tk[i + 1].v[0] - tk[i].v[0]) > 40) { push('drawon', i, tk[i].t, tk[i + 1].t - tk[i].t, Math.min(1, (tk[i + 1].t - tk[i].t) / 1.2)); break; }
  }
  // text animators: per-letter type-on (keys) or one swish
  if (l.textAnim && l.text) {
    const a = l.textAnim, t0 = l.inPoint + a.start;
    if (a.by === 'char' && a.stagger <= 0.1 && a.mode === 'in') {
      const units = [...l.text.content].filter(ch => ch.trim()).length;
      for (let i = 0; i < Math.min(units, 60); i++) push('type', i, t0 + i * a.stagger, a.duration, 0.35);
    } else push('text', 0, t0, a.duration, 0.5);
  }
  return out;
}

/** every layer's events in the active comp (or the given layers and their descendants) */
export function motionSfxEvents(store: Store, ids?: string[]): SfxEvent[] {
  const out: SfxEvent[] = [];
  const seen = new Set<string>();
  const walk = (list: string[]) => { for (const id of list) { const l = store.layer(id); if (!l || seen.has(id)) continue; seen.add(id); if (l.type !== 'audio') { out.push(...layerEvents(store, l)); walk(l.children); } } };
  walk(ids?.length ? ids : store.comp.root);
  return out.sort((a, b) => a.t - b.t);
}

export interface SfxPick extends SfxEvent { type: SfxType; at: number; lead: number }

/** choose the events that get a sound: importance over a density threshold, near-simultaneous events
 *  grouped (strongest wins; at high density a whoosh + hit pair may share a moment), a per-second cap */
export function pickSfx(events: SfxEvent[], o: { density?: number; kinds?: MotionKind[]; fam: SfxFamily; snap?: (t: number) => number | null; sr?: number }): SfxPick[] {
  const density = Math.max(0, Math.min(1, o.density ?? 0.5));
  const thr = (1 - density) * 0.75;
  const cand = events.filter(e => (!o.kinds || o.kinds.includes(e.kind)) && e.importance >= thr * (e.kind === 'type' ? 0.5 : 1));
  // group within 80 ms
  const groups: SfxEvent[][] = [];
  for (const e of cand) { const g = groups[groups.length - 1]; if (g && e.t - g[0].t < 0.08) g.push(e); else groups.push([e]); }
  const picks: SfxPick[] = [];
  for (const g of groups) {
    g.sort((a, b) => b.importance - a.importance);
    const take = [g[0]];
    if (density >= 0.5) { const second = g.find(e => SFX_FOR[e.kind] !== SFX_FOR[g[0].kind] && (e.kind === 'move' || g[0].kind === 'move')); if (second) take.push(second); }
    for (const e of take) {
      const type: SfxType = e.kind === 'land' && e.intensity > 0.75 ? 'impact' : SFX_FOR[e.kind];
      // whooshes peak just before the landing they lead into
      const lead = type === 'whoosh' ? -(0.62 * 0.45 * o.fam.length * (0.8 + 0.4 * e.intensity)) - Math.min(0.15, e.dur * 0.2) : 0;
      let at = e.t;
      if (o.snap && type !== 'key') { const s = o.snap(e.t); if (s !== null) at = s; }
      picks.push({ ...e, type, at, lead });
    }
  }
  // cap per second, keeping the most important
  const cap = 2 + Math.round(6 * density);
  const keep = new Set<SfxPick>();
  for (const p of [...picks].sort((a, b) => b.importance - a.importance)) {
    const n = [...keep].filter(q => Math.abs(q.at - p.at) < 0.5).length;
    if (n < cap / 2 + (p.kind === 'type' ? 4 : 0)) keep.add(p);
  }
  return picks.filter(p => keep.has(p));
}

// ---------------------------------------------------------------- assets + layers
const assetFor = new Map<string, string>();
function sfxAsset(store: Store, tx: Tx, type: SfxType, fam: SfxFamily, intensity: number): Asset {
  const q = Math.round(intensity * 4) / 4;
  const key = `${type}|${fam.id}|${q}`;
  const id = assetFor.get(key);
  if (id && store.project.assets[id]) return store.project.assets[id];
  const r = renderSfx(type, fam, q, 44100);
  const asset: Asset = { id: uid('a'), kind: 'audio', mime: 'audio/wav', data: wavDataUrl([r.L, r.R], r.sr), width: 0, height: 0 };
  tx.set(store.project.assets, asset.id, asset);
  tx.change.assets = true;
  assetFor.set(key, asset.id);
  return asset;
}

export const SFX_GROUP = 'Sound effects';
export function sfxLayers(store: Store): Layer[] { return Object.values(store.project.layers).filter(l => l.type === 'audio' && l.sfx); }
function sfxGroup(store: Store): Layer | undefined { return store.comp.root.map(id => store.layer(id)!).find(l => l?.type === 'group' && l.name === SFX_GROUP && l.children.every(c => store.layer(c)?.sfx)); }

function removeLayersTx(store: Store, tx: Tx, ids: string[]) {
  const P = store.project;
  for (const id of ids) {
    const l = P.layers[id];
    if (!l) continue;
    if (l.parent && P.layers[l.parent]) { const p = P.layers[l.parent]; tx.set(p, 'children', p.children.filter(c => c !== id)); }
    else tx.set(store.comp, 'root', store.comp.root.filter(c => c !== id));
    for (const d of [id, ...store.descendants(id)]) tx.del(P.layers, d);
  }
}

export interface AddSfxOptions { family?: string; density?: number; kinds?: MotionKind[]; ids?: string[]; volume?: number; replace?: boolean; snapToBeats?: boolean }

/** add sound effects for the motion (one undo step). returns what was placed */
export function addSoundEffects(store: Store, o: AddSfxOptions = {}): { family: SfxFamily; placed: SfxPick[]; ducked: boolean } {
  const fam = findFamily(o.family ?? 'crisp-ui');
  const m = music(store);
  const snap = m && o.snapToBeats !== false ? (t: number) => snapToMusic(store, t, 0.06, { beats: true, bars: true, onsets: false }) : undefined;
  const picks = pickSfx(motionSfxEvents(store, o.ids), { density: o.density, kinds: o.kinds, fam, snap });
  const vol = o.volume ?? (m ? 0.45 : 0.8);
  store.transact('Add sound effects', tx => {
    if (o.replace !== false) {
      const old = sfxLayers(store).map(l => l.id);
      removeLayersTx(store, tx, old);
    }
    let g = sfxGroup(store);
    if (!g) {
      g = createLayer('group', { x: 0, y: 0, w: 0, h: 0, name: SFX_GROUP, collapsed: true });
      insertLayer(store, tx, g, null, 0);
    }
    for (const p of picks) {
      const asset = sfxAsset(store, tx, p.type, fam, p.intensity);
      const src = store.layer(p.layer);
      const l = createLayer('audio', { x: 0, y: 0, w: 0, h: 0, name: `${p.type} · ${src?.name ?? ''}`.trim() });
      l.imageRef = asset.id;
      l.startTime = Math.max(0, p.at + p.lead);
      l.volume = vol;
      l.sfx = { type: p.type, family: fam.id, intensity: Math.round(p.intensity * 4) / 4, src: p.layer, event: p.id, lead: p.lead };
      insertLayer(store, tx, l, g.id);
    }
    tx.structure();
  });
  return { family: fam, placed: picks, ducked: !!m };
}

/** swap the family of every sound effect (same timing): one undo step */
export function setSfxFamily(store: Store, family: string): { family: SfxFamily; changed: number } {
  const fam = findFamily(family);
  const list = sfxLayers(store);
  store.transact('Sound effects family', tx => {
    for (const l of list) {
      const s = l.sfx!;
      const t = s.type as SfxType;
      const asset = sfxAsset(store, tx, t, fam, s.intensity);
      // whoosh leads scale with the family's length
      const lead = t === 'whoosh' && s.lead ? s.lead * (fam.length / findFamily(s.family).length) : s.lead ?? 0;
      tx.set(l, 'imageRef', asset.id);
      tx.set(l, 'sfx', { ...s, family: fam.id, lead });
      if (lead !== (s.lead ?? 0)) tx.set(l, 'startTime', Math.max(0, (l.startTime ?? 0) - (s.lead ?? 0) + lead));
      tx.touch(l.id);
    }
    tx.recompile();
  });
  return { family: fam, changed: list.length };
}

/** move linked sound effects to where their events are now (after a retime). inside a transaction */
export function refollowSfx(store: Store, tx: Tx): number {
  let moved = 0;
  const cache = new Map<string, SfxEvent[]>();
  for (const l of sfxLayers(store)) {
    const s = l.sfx!;
    if (!s.src || !s.event) continue;
    const src = store.layer(s.src);
    if (!src) continue;
    let ev = cache.get(src.id);
    if (!ev) cache.set(src.id, (ev = layerEvents(store, src)));
    const e = ev.find(x => x.id === s.event);
    if (!e) continue;
    const t = Math.max(0, e.t + (s.lead ?? 0));
    if (Math.abs(t - (l.startTime ?? 0)) > 1e-6) { tx.set(l, 'startTime', t); tx.touch(l.id); moved++; }
  }
  if (moved) tx.recompile();
  return moved;
}

/** is any layer keyed at all (sound effects need motion to follow) */
export function hasMotion(store: Store): boolean {
  return Object.values(store.project.layers).some(l => l.type !== 'audio' && (PROP_KEYS.some(k => l.props[k]?.kf?.length) || !!l.textAnim));
}
