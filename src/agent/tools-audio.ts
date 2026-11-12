// agent tools for music and sound: read the analysis of the comp's music (tempo, bars, sections,
// accents, an energy strip), retime animation onto it, drive properties from it (audio() expressions),
// put entrances on beat patterns, and (only when the user asks) synthesized sound effects
// that follow the motion. results are compact text.

import { PROP_DEFS, type PropKey } from '../core/model';
import { checkExpr, EXPR_PROPS } from '../core/expr';
import { setExpr } from '../core/commands';
import { audioLevel, bandIndex, AUDIO_BANDS } from '../core/audio-env';
import { editor } from '../app/editor';
import { st, text, idsSchema, checkProp, need, writeTrack, type ToolDef, type ToolContent } from './tool-kit';
import { ensureAnalysis } from '../audio/analysis-store';
import { music, musicLayer, beats, bars, accents, sections, onsets, refreshAudioEnv, beatPeriod, type Music } from '../audio/timing';
import { syncToMusic, patternTimes, distributeOnBeats, type SyncMode, type BeatPattern } from '../audio/sync';
import { SFX_FAMILIES, SFX_TYPES, findFamily, renderAudition, renderSfx, type SfxType } from '../audio/sfx';
import { addSoundEffects, setSfxFamily, sfxLayers, hasMotion, type MotionKind } from '../audio/sfx-place';
import { encodeWav, bytesToBase64 } from '../audio/wav';

const f2 = (t: number) => (Math.round(t * 100) / 100).toFixed(2);
const BARS = '▁▂▃▄▅▆▇█';

/** the comp's music with its analysis (waits for a running analysis) */
async function needMusic(): Promise<Music> {
  const s = st();
  const l = musicLayer(s);
  if (!l) throw new Error('no audio layer in this composition (the user can paste or drop a song)');
  const asset = l.imageRef ? s.project.assets[l.imageRef] : undefined;
  if (!asset) throw new Error('the audio layer has no audio data');
  const a = await ensureAnalysis(asset, l.audio?.bpm);
  if (!a) throw new Error('the audio could not be decoded / analysed');
  const m = music(s);
  if (!m) throw new Error('the audio layer is hidden or muted');
  if (refreshAudioEnv(s) && editor.renderer) editor.renderer.dirty = true;
  return m;
}

function strip(m: Music, t0: number, t1: number, step: number): string {
  let out = '';
  const vals: number[] = [];
  for (let t = t0; t < t1 - 1e-6; t += step) {
    let s = 0, n = 0;
    for (let x = t; x < Math.min(t1, t + step); x += 1 / 60) { s += audioLevel(0, x) + audioLevel(1, x); n++; }
    vals.push(s / Math.max(1, n));
  }
  const mx = Math.max(1e-6, ...vals);
  for (const v of vals) out += BARS[Math.min(7, Math.floor((v / mx) * 7.99))];
  return out;
}

/** compact summary for the agent's context line (also used by editor context) */
export function musicSummary(m: Music): string {
  return `${Math.round(m.a.bpm)} BPM ${m.a.meter}/4, ${f2(m.to - m.from)}s from ${f2(m.from)}s, ${sections(m).map(s => s.label).join('→')}`;
}

export const AUDIO_TOOLS: ToolDef[] = [
  {
    name: 'get_audio_analysis',
    readOnly: true,
    description: 'Read the music of the composition (its first audio layer): tempo (BPM), meter, beat grid and bars (downbeats), sections (intro/build/drop/breakdown/main/outro with energy 0..1), the strongest hits (accents) and an energy strip. Times are comp seconds. Pass from/to to zoom in: every beat (bar.beat) and every onset with strength in that range.',
    inputSchema: { type: 'object', properties: { from: { type: 'number' }, to: { type: 'number' } } },
    run: async a => {
      const m = await needMusic();
      const s = st(), A = m.a, p = beatPeriod(m), bar = p * A.meter;
      const bt = beats(m), br = bars(m), sec = sections(m), acc = accents(m);
      if (a.from !== undefined || a.to !== undefined) {
        const t0 = Math.max(m.from, a.from ?? m.from), t1 = Math.min(m.to, a.to ?? m.to);
        const lines = [`${f2(t0)}–${f2(t1)}s, ${Math.round(A.bpm)} BPM, beat ${f2(p)}s, bar ${f2(bar)}s`];
        const first = br[0] ?? bt[0] ?? 0;
        const label = (t: number) => { const i = Math.round((t - first) / p); const b = Math.floor(i / A.meter), k = ((i % A.meter) + A.meter) % A.meter; return `${b + 1}.${k + 1}`; };
        lines.push('beats: ' + bt.filter(t => t >= t0 - 1e-6 && t <= t1 + 1e-6).map(t => `${f2(t)}(${label(t)})`).join(' '));
        lines.push('onsets (t:strength): ' + onsets(m, 0.15).filter(o => o.t >= t0 && o.t <= t1).slice(0, 80).map(o => `${f2(o.t)}:${f2(o.s)}`).join(' '));
        const inAcc = acc.filter(x => x.t >= t0 && x.t <= t1);
        if (inAcc.length) lines.push('accents: ' + inAcc.map(x => `${f2(x.t)}★${f2(x.s)}`).join(' '));
        lines.push(`energy per beat: ${strip(m, t0, t1, p)}`);
        return text(lines.join('\n'));
      }
      const lines = [
        `music ${JSON.stringify(m.layer.name)} (layer ${m.layer.id}): ${Math.round(A.bpm * 10) / 10} BPM, ${A.meter}/4${A.steady ? ', steady grid' : ', variable tempo'}; audible ${f2(m.from)}–${f2(m.to)}s in comp (comp is ${f2(s.comp.duration)}s)`,
        `beat ${f2(p)}s, bar ${f2(bar)}s; ${bt.length} beats from ${f2(bt[0] ?? 0)}s; ${br.length} bars, downbeats: ${br.slice(0, 40).map(f2).join(' ')}${br.length > 40 ? ' …' : ''}`,
        `sections: ${sec.map(x => `${x.label} ${f2(x.t0)}–${f2(x.t1)} (energy ${x.energy})`).join(' | ')}`,
        `accents (strongest hits, time:strength): ${[...acc].sort((x, y) => y.s - x.s).slice(0, 16).sort((x, y) => x.t - y.t).map(x => `${f2(x.t)}:${f2(x.s)}`).join(' ')}`,
        `energy per bar (▁ quiet .. █ loud): ${strip(m, br[0] ?? m.from, m.to, bar)}`,
        `tools: sync_to_audio (retime existing keys), place_on_beats (staggered entrances), audio_reactive or expression audio('${AUDIO_BANDS.join("'|'")}', smoothing, threshold)`,
      ];
      return text(lines.join('\n'));
    },
  },
  {
    name: 'sync_to_audio',
    description: 'Retime existing animation to the music: moves starting, landing and overshoot peaks are matched to the nearest strong beat (mode beats), bar starts (bars), accents/strongest hits (accents) or section starts (sections); everything in between is stretched/compressed (one monotonic time warp: key order, eases and relative timing are kept). ids: layers (with their children); default all. One undo step. Sound effects that follow moved layers re-follow.',
    inputSchema: { type: 'object', properties: { ids: idsSchema, mode: { enum: ['beats', 'bars', 'accents', 'sections'] } } },
    run: async a => {
      await needMusic();
      const r = syncToMusic(st(), { ids: a.ids, mode: (a.mode ?? 'beats') as SyncMode, label: 'Agent: sync to music' });
      if (!r || !r.anchors.length) return text('nothing to sync: no animated moments near the music\'s beats (animate first, or use place_on_beats)');
      return text(`${r.anchors.length} moments moved (${r.keys} keys on ${r.layers} layers): ${r.anchors.slice(0, 16).map(x => `${x.kind} ${f2(x.from)}→${f2(x.to)} (${x.target})`).join(', ')}${r.anchors.length > 16 ? ' …' : ''}`);
    },
  },
  {
    name: 'audio_reactive',
    description: "Drive a property from the music. Sets the expression value + amount * audio(band, smoothing, threshold) (evaluated live from the cached envelope, also in exports), or with bake: true writes keyframes at every frame instead. band: low (kick/bass), mid, high (hats), amp (overall), beat (a pulse decaying after each beat), bar (pulse on downbeats), accent (pulse on the strongest hits). amount: a number (scalar props, or both axes of scale/position) or an array per component. smoothing: release in seconds (0.05-0.3 typical). threshold 0..1: ignore quieter levels.",
    inputSchema: {
      type: 'object',
      properties: {
        ids: idsSchema, prop: { enum: EXPR_PROPS }, band: { enum: [...AUDIO_BANDS] },
        amount: { anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }] },
        smoothing: { type: 'number' }, threshold: { type: 'number' }, bake: { type: 'boolean' }, from: { type: 'number' }, to: { type: 'number' },
      },
      required: ['ids', 'prop', 'band', 'amount'],
    },
    run: async a => {
      await needMusic();
      const key = checkProp(a.prop);
      if (!EXPR_PROPS.includes(key)) throw new Error(`audio_reactive works on: ${EXPR_PROPS.join(', ')}`);
      const dim = PROP_DEFS[key].dim;
      const amt = Array.isArray(a.amount) ? a.amount.map(Number) : new Array(dim).fill(Number(a.amount));
      if (amt.length !== dim || amt.some((x: number) => !isFinite(x))) throw new Error(`amount must be a number or ${dim} numbers for ${key}`);
      if (key === 'position' && !Array.isArray(a.amount)) amt[0] = 0; // a scalar moves position vertically only
      const sm = Math.max(0, Number(a.smoothing ?? 0.12)), th = Math.max(0, Math.min(0.95, Number(a.threshold ?? 0)));
      const band = AUDIO_BANDS[bandIndex(a.band)];
      const call = `audio('${band}', ${sm}, ${th})`;
      const expr = dim === 1 ? `value + ${amt[0]} * ${call}` : `value + [${amt.join(', ')}] * ${call}`;
      if (!a.bake) {
        const err = checkExpr(expr, dim);
        if (err) throw new Error('expression error: ' + err);
        setExpr(st(), a.ids.map((id: string) => need(id).id), key, expr);
        return text(`expression on ${key} of ${a.ids.length} layer(s): ${expr}`);
      }
      const s = st(), fps = s.comp.fps, t0 = Math.max(0, a.from ?? 0), t1 = Math.min(s.comp.duration, a.to ?? s.comp.duration);
      const bi = bandIndex(band);
      let keys = 0;
      s.transact('Agent: audio reactive (baked)', tx => {
        for (const id of a.ids) {
          const l = need(id), base = (l.props[key]?.v ?? (PROP_DEFS[key].default as unknown as number[])).slice();
          const kf = [];
          for (let f = Math.round(t0 * fps); f <= Math.round(t1 * fps); f++) {
            const t = f / fps, lv = audioLevel(bi, t, sm, th);
            kf.push({ t, v: base.map((v, d) => v + amt[d] * lv), interp: 'linear' as const, out: [0.333, 0] as [number, number], in: [0.667, 1] as [number, number] });
          }
          writeTrack(tx, l, key as PropKey, kf, false);
          keys += kf.length;
        }
      });
      return text(`baked ${keys} keys (${band})`);
    },
  },
  {
    name: 'place_on_beats',
    description: 'Musical timing patterns: shift each layer\'s animation (in ids order, rigidly, eases kept) so layer i starts (anchor start) or lands (anchor land) on pattern time i. pattern: beat, half-bar, bar, two-bars, accents, build (accelerating toward the next drop or `to`: bars, then beats, then half beats). from/to limit the range; count caps the number of times.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { enum: ['beat', 'half-bar', 'bar', 'two-bars', 'accents', 'build'] }, ids: idsSchema, from: { type: 'number' }, to: { type: 'number' }, count: { type: 'number' }, anchor: { enum: ['start', 'land'] } },
      required: ['pattern', 'ids'],
    },
    run: async a => {
      if (!a.ids?.length) throw new Error('place_on_beats needs ids (in the order they should enter)');
      const m = await needMusic();
      const s = st();
      const n = Math.min(a.count ?? Infinity, a.ids.length);
      const times = patternTimes(m, a.pattern as BeatPattern, a.from ?? 0, a.to ?? (a.pattern === 'build' ? Infinity : s.comp.duration), n);
      if (!times.length) throw new Error('no pattern times in that range');
      const r = distributeOnBeats(s, a.ids, times, a.anchor ?? 'start');
      return text(`${r.length} entrances: ${r.map(x => `${s.layer(x.id)?.name ?? x.id} ${f2(x.t)}`).join(', ')}${r.length < a.ids.length ? ` (${a.ids.length - r.length} without a beat or animation, left)` : ''}`);
    },
  },
  // ---------------------------------------------------------------- sound effects (only on request)
  {
    name: 'list_sfx_families',
    readOnly: true,
    description: 'Sound-effect families (synthesized, license-free): each is one character shared by every sound type, so a video sounds coherent. Only use sound-effect tools when the user asked for sound effects.',
    inputSchema: { type: 'object', properties: {} },
    run: () => text(`families:\n${SFX_FAMILIES.map(f => `- ${f.id} (${f.name}): ${f.hint}`).join('\n')}\nsound types: ${SFX_TYPES.join(', ')}\nmotion → sound: entrance/fast move → whoosh, landing → tap (big: impact), scale-in → pop, draw-on → sweep, per-letter type-on → key clicks, small UI toggle → click, exit → swish, text reveal → swish. current sfx layers: ${sfxLayers(st()).length}`),
  },
  {
    name: 'preview_sfx',
    readOnly: true,
    description: 'Render a short audition of a sound family (or chosen sound types) to a wav file and return its path, so the user can listen. Does not change the document.',
    inputSchema: { type: 'object', properties: { family: { type: 'string' }, types: { type: 'array', items: { enum: [...SFX_TYPES] } } }, required: ['family'] },
    run: a => {
      const fam = findFamily(a.family);
      const r = a.types?.length === 1 ? renderSfx(a.types[0] as SfxType, fam, 0.6) : renderAudition(fam, a.types?.length ? a.types : undefined);
      const out: ToolContent[] = [{ type: 'text', text: `${fam.name}: ${(a.types ?? ['whoosh', 'pop', 'tap', 'ding']).join(', ')} (${r.duration.toFixed(2)}s)` }, { type: 'file', name: `sfx-${fam.id}.wav`, data: bytesToBase64(encodeWav([r.L, r.R], r.sr)), mimeType: 'audio/wav' }];
      return out;
    },
  },
  {
    name: 'add_sound_effects',
    description: 'ONLY when the user asks for sound effects: add synthesized sounds that follow the motion (entrances/fast moves, landings, pops, draw-ons, type-ons, toggles, exits), all from one family (pick it from the brand: list_sfx_families). density 0..1 (0.3 sparse, 0.5 default, 0.8 busy): not every event gets a sound, near-simultaneous events are grouped. With music they snap to its beats and are ducked. Replaces earlier sound effects. They are audio layers in a "Sound effects" group, linked to their layers (they follow retimes). One undo step.',
    inputSchema: { type: 'object', properties: { family: { type: 'string' }, density: { type: 'number' }, events: { type: 'array', items: { enum: ['move', 'land', 'pop', 'drawon', 'type', 'text', 'toggle', 'exit', 'fade'] } }, ids: idsSchema, volume: { type: 'number', description: '0..1 (default 0.8, 0.45 under music)' } }, required: ['family'] },
    run: a => {
      const s = st();
      if (!hasMotion(s)) throw new Error('nothing animated yet: sound effects follow the motion');
      const r = addSoundEffects(s, { family: a.family, density: a.density, kinds: a.events as MotionKind[] | undefined, ids: a.ids, volume: a.volume });
      const by: Record<string, number> = {};
      for (const p of r.placed) by[p.type] = (by[p.type] ?? 0) + 1;
      return text(`${r.placed.length} sound effects (${r.family.name}${r.ducked ? ', snapped to beats and ducked under the music' : ''}): ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    },
  },
  {
    name: 'set_sfx_family',
    description: 'Swap the family of every sound effect in the document (same timing). One undo step.',
    inputSchema: { type: 'object', properties: { family: { type: 'string' } }, required: ['family'] },
    run: a => { const r = setSfxFamily(st(), a.family); return text(`${r.changed} sound effects now ${r.family.name}`); },
  },
];
