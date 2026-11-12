// inspector for audio layers. small self-contained rows (each reads the store itself) so they drop into
// any inspector layout: analysis summary, volume (keyframable), fades, timing (start / trim), mute and
// snapping, tempo (bpm override, tap tempo, grid / downbeat nudge), music actions (sync, markers, fit),
// and the opt-in sound effects picker.
import { useRef, useState } from 'preact/hooks';
import './audio.css';
import { editor } from '../../app/editor';
import { addKeyframe, isAnimated, setCompSettings, setLayerField, setProp, toggleAnimated, valueAt } from '../../core/commands';
import type { AudioSettings, Layer } from '../../core/model';
import { useChannels } from '../hooks';
import { Checkbox, NumField, Section } from '../ui';
import { layerAnalysis, analysisFailed } from '../../audio/analysis-store';
import { music, sections, beats } from '../../audio/timing';
import { musicalLengths, syncToMusic, patternTimes, markersOnBeats, type SyncMode } from '../../audio/sync';
import { musicSnap } from './timeline-audio';
import { SFX_FAMILIES, renderAudition, type SfxFamily } from '../../audio/sfx';
import { addSoundEffects, setSfxFamily, sfxLayers, hasMotion } from '../../audio/sfx-place';
import { toast } from '../../app/actions';
import { askAgent } from '../../audio/import';

const st = () => editor.store;
const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

function setAudio(ids: string[], patch: Partial<AudioSettings>, label: string, mergeKey?: string) {
  const s = st();
  s.transact(label, tx => {
    for (const id of ids) {
      const l = s.layer(id);
      if (!l) continue;
      const next: AudioSettings = { ...(l.audio ?? {}), ...patch };
      for (const k of Object.keys(next) as (keyof AudioSettings)[]) if (next[k] === undefined) delete next[k];
      tx.set(l, 'audio', next);
      tx.touch(id);
    }
  }, mergeKey);
}

export function AudioInspector({ layers }: { layers: Layer[] }) {
  useChannels(['doc', 'history', 'selection'], ['audio']);
  const l = layers[0];
  const ids = layers.map(x => x.id);
  return (
    <Section title={layers.length > 1 ? `${layers.length} audio layers` : l.name} right={<span class="insp-type">{l.sfx ? 'sound effect' : 'audio'}</span>}>
      <div class="au-rows">
        {!l.sfx && <AnalysisRow l={l} />}
        <VolumeRow l={l} ids={ids} />
        <FadeRow l={l} ids={ids} />
        <TimingRow l={l} ids={ids} />
        <MuteRow l={l} ids={ids} />
        {!l.sfx && <TempoRow l={l} />}
        {!l.sfx && <MusicActionsRow />}
        <SfxRow />
      </div>
    </Section>
  );
}

const SEC_COLOR: Record<string, string> = { intro: 'rgba(120,170,255,0.6)', build: 'rgba(255,190,90,0.7)', drop: 'rgba(255,90,120,0.8)', breakdown: 'rgba(110,220,200,0.6)', main: 'rgba(255,255,255,0.18)', outro: 'rgba(160,140,255,0.6)' };

export function AnalysisRow({ l }: { l: Layer }) {
  const s = st();
  const asset = l.imageRef ? s.project.assets[l.imageRef] : undefined;
  const a = layerAnalysis(l, s.project.assets);
  if (!asset) return null;
  if (!a) return <div class="au-row"><span class="au-stat muted">{analysisFailed(asset, l.audio?.bpm) ? 'Could not analyse this audio' : 'Analysing the music…'}</span></div>;
  const m = music(s);
  const secs = m && m.layer.id === l.id ? sections(m) : [];
  const span = secs.length ? secs[secs.length - 1].t1 - secs[0].t0 : 1;
  return (
    <>
      <div class="au-row">
        <span class="au-label">Music</span>
        <span class="au-grow au-stat" title={`${a.beats.length} beats, analysed in ${Math.round(a.ms)} ms`}>{a.bpm} BPM · {a.meter}/4 · {fmt(a.duration)}{a.steady ? '' : ' · free tempo'}{l.audio?.bpm ? ' · manual' : ''}</span>
      </div>
      {secs.length > 0 && (
        <div class="au-sections" title={secs.map(x => `${x.label} ${x.t0.toFixed(1)}–${x.t1.toFixed(1)} s (energy ${x.energy})`).join('\n')}>
          {secs.map(x => <span style={{ width: `${((x.t1 - x.t0) / span) * 100}%`, background: SEC_COLOR[x.label], opacity: 0.4 + 0.6 * x.energy }} />)}
        </div>
      )}
    </>
  );
}

export function VolumeRow({ l, ids }: { l: Layer; ids: string[] }) {
  const s = st();
  const v = valueAt(l, 'volume', s.time)[0] * (l.volume ?? 1);
  const animated = isAnimated(l, 'volume');
  const onKey = !!l.props.volume?.kf?.some(k => Math.abs(k.t - s.time) < 0.5 / s.comp.fps);
  return (
    <div class="au-row">
      <span class="au-label">Volume</span>
      <span class="au-grow">
        <NumField label="%" min={0} max={200} step={1} value={Math.round(v)} onChange={(n, mk) => { for (const id of ids) { const x = s.layer(id); if (x) setProp(s, id, 'volume', [Math.max(0, n) / (x.volume ?? 1)], { mergeKey: mk }); } }} />
        <button type="button" class={'au-btn' + (onKey ? ' primary' : '')} title={animated ? 'Add a volume key at the playhead (right click: stop animating)' : 'Animate the volume (keyframes)'}
          onClick={() => (animated ? addKeyframe(s, ids, 'volume') : toggleAnimated(s, ids, 'volume'))}
          onContextMenu={e => { e.preventDefault(); if (animated) toggleAnimated(s, ids, 'volume'); }}>◆</button>
      </span>
    </div>
  );
}

export function FadeRow({ l, ids }: { l: Layer; ids: string[] }) {
  return (
    <div class="au-row">
      <span class="au-label">Fades</span>
      <span class="au-grow">
        <NumField label="In" min={0} step={0.05} suffix="s" value={l.audio?.fadeIn ?? 0} onChange={(n, mk) => setAudio(ids, { fadeIn: Math.max(0, n) || undefined }, 'Fade in', mk)} />
        <NumField label="Out" min={0} step={0.05} suffix="s" value={l.audio?.fadeOut ?? 0} onChange={(n, mk) => setAudio(ids, { fadeOut: Math.max(0, n) || undefined }, 'Fade out', mk)} />
      </span>
    </div>
  );
}

export function TimingRow({ l, ids }: { l: Layer; ids: string[] }) {
  const s = st(), f = 1 / s.comp.fps;
  const setField = (k: 'startTime' | 'inPoint' | 'outPoint', n: number, label: string, mk?: string) => s.transact(label, tx => { for (const id of ids) { const x = s.layer(id); if (x) { tx.set(x, k, n); tx.touch(id); } } tx.recompile(); }, mk);
  return (
    <div class="au-row">
      <span class="au-label">Timing</span>
      <span class="au-grow">
        <NumField label="Start" step={f} suffix="s" value={l.startTime ?? 0} title="When the clip starts (comp time); drag the waveform to move it" onChange={(n, mk) => setField('startTime', n, 'Audio start', mk)} />
        <NumField label="In" step={f} min={0} suffix="s" value={Math.max(0, l.inPoint)} title="Trim: audible from" onChange={(n, mk) => setField('inPoint', Math.max(0, n), 'Trim audio', mk)} />
        <NumField label="Out" step={f} suffix="s" value={l.outPoint >= 1e8 ? s.comp.duration : l.outPoint} title="Trim: audible until" onChange={(n, mk) => setField('outPoint', n >= s.comp.duration - 1e-6 ? 1e9 : n, 'Trim audio', mk)} />
      </span>
    </div>
  );
}

export function MuteRow({ l, ids }: { l: Layer; ids: string[] }) {
  const [, force] = useState(0);
  return (
    <div class="au-row">
      <span class="au-label"></span>
      <span class="au-grow">
        <Checkbox checked={!!l.audio?.mute} onChange={v => setAudio(ids, { mute: v || undefined }, v ? 'Mute' : 'Unmute')}>Mute</Checkbox>
        <Checkbox checked={musicSnap.on} title="Keys, layer in/out and the playhead snap to beats, bars and hits (hold Alt / Shift to bypass)" onChange={v => { musicSnap.set(v); force(x => x + 1); }}>Snap to beats</Checkbox>
      </span>
    </div>
  );
}

export function TempoRow({ l }: { l: Layer }) {
  const s = st();
  const taps = useRef<{ wall: number; t: number }[]>([]);
  const [flash, setFlash] = useState(false);
  const a = layerAnalysis(l, s.project.assets);
  const fps = s.comp.fps;
  const tap = () => {
    const now = performance.now();
    const list = taps.current = [...taps.current.filter(x => now - x.wall < 3000), { wall: now, t: s.time }];
    setFlash(true); setTimeout(() => setFlash(false), 90);
    if (list.length < 4) return;
    const iv = list.slice(1).map((x, i) => (x.wall - list[i].wall) / 1000).sort((p, q) => p - q);
    const bpm = Math.round((60 / iv[iv.length >> 1]) * 10) / 10;
    // while playing, the taps also place the grid: offset that best matches tap moments
    let gridOffset = l.audio?.gridOffset;
    if (s.playing && a) {
      const start = l.startTime ?? 0, p = 60 / bpm, b0 = a.beats[0] ?? 0;
      const res = list.map(x => { const rel = x.t - start - b0; return rel - Math.round(rel / p) * p; });
      gridOffset = Math.round((res.reduce((u, v) => u + v, 0) / res.length) * 1000) / 1000;
    }
    setAudio([l.id], { bpm, gridOffset }, 'Tap tempo', 'tap');
  };
  return (
    <>
      <div class="au-row">
        <span class="au-label">Tempo</span>
        <span class="au-grow">
          <NumField label="BPM" min={30} max={300} step={0.1} value={l.audio?.bpm ?? a?.bpm ?? 120} title="Override the detected tempo (the beat grid is re-fitted)" onChange={(n, mk) => setAudio([l.id], { bpm: Math.max(30, Math.min(300, n)) }, 'Tempo', mk)} />
          <button type="button" class={'au-btn au-tap' + (flash ? ' flash' : '')} title="Tap along (4+ taps); while playing it also aligns the grid" onClick={tap}>Tap</button>
          {(l.audio?.bpm || l.audio?.gridOffset || l.audio?.barOffset) ? <button type="button" class="au-btn" title="Back to the detected tempo and grid" onClick={() => setAudio([l.id], { bpm: undefined, gridOffset: undefined, barOffset: undefined }, 'Reset tempo')}>Auto</button> : null}
        </span>
      </div>
      <div class="au-row">
        <span class="au-label">Grid</span>
        <span class="au-grow">
          <button type="button" class="au-btn" title="Nudge the beat grid one frame earlier" onClick={() => setAudio([l.id], { gridOffset: Math.round(((l.audio?.gridOffset ?? 0) - 1 / fps) * 1e4) / 1e4 }, 'Nudge grid')}>‹</button>
          <NumField label="ms" step={1} value={Math.round((l.audio?.gridOffset ?? 0) * 1000)} title="Beat grid offset" onChange={(n, mk) => setAudio([l.id], { gridOffset: n / 1000 || undefined }, 'Nudge grid', mk)} />
          <button type="button" class="au-btn" title="Nudge the beat grid one frame later" onClick={() => setAudio([l.id], { gridOffset: Math.round(((l.audio?.gridOffset ?? 0) + 1 / fps) * 1e4) / 1e4 }, 'Nudge grid')}>›</button>
          <button type="button" class="au-btn" title="Move the downbeat (bar start) one beat later" onClick={() => setAudio([l.id], { barOffset: ((l.audio?.barOffset ?? 0) + 1) % (a?.meter ?? 4) || undefined }, 'Move downbeat')}>Downbeat +1</button>
        </span>
      </div>
    </>
  );
}

export function MusicActionsRow() {
  const s = st();
  const [mode, setMode] = useState<SyncMode>('beats');
  const m = music(s);
  if (!m) return null;
  const lens = musicalLengths(m, s.comp.duration);
  return (
    <>
      <div class="au-row">
        <span class="au-label">Sync</span>
        <span class="au-grow">
          <select class="au-btn" value={mode} title="What the important moments snap to" onChange={e => setMode((e.target as HTMLSelectElement).value as SyncMode)}>
            <option value="beats">Beats</option><option value="bars">Bars</option><option value="accents">Hits</option><option value="sections">Sections</option>
          </select>
          <button type="button" class="au-btn primary" title="Retime the animation so starts and landings hit the music (one undo step)" onClick={() => { const r = syncToMusic(s, { mode }); toast(r?.anchors.length ? `Synced ${r.anchors.length} moments to the ${mode}` : 'Nothing to sync (animate something first)'); }}>Sync timing</button>
          <button type="button" class="au-btn" title="Let the agent design with the music" onClick={() => askAgent('Design the animation with the music: big moves on downbeats, accents on the strongest hits, energy that follows the sections.')}>Ask agent</button>
        </span>
      </div>
      <div class="au-row">
        <span class="au-label"></span>
        <span class="au-grow">
          <button type="button" class="au-btn" title="A timeline marker on every bar" onClick={() => { const t = patternTimes(m, 'bar', 0, s.comp.duration); markersOnBeats(s, t, 'bar'); toast(`${t.length} bar markers`); }}>Markers on bars</button>
          <button type="button" class="au-btn" title="Markers on the strongest hits" onClick={() => { const t = patternTimes(m, 'accents', 0, s.comp.duration); markersOnBeats(s, t, 'accent'); toast(`${t.length} hit markers`); }}>On hits</button>
          {Math.abs(lens.full - s.comp.duration) > 0.05 && <button type="button" class="au-btn" title="Composition length = the music" onClick={() => setCompSettings(s, { duration: Math.round(lens.full * s.comp.fps) / s.comp.fps })}>Fit {lens.full.toFixed(1)} s</button>}
          {lens.phrase && Math.abs(lens.phrase - s.comp.duration) > 0.05 && lens.phrase < lens.full && <button type="button" class="au-btn" title="End on the next 4-bar phrase" onClick={() => setCompSettings(s, { duration: Math.round(lens.phrase! * s.comp.fps) / s.comp.fps })}>Phrase {lens.phrase.toFixed(1)} s</button>}
        </span>
      </div>
      <div class="muted small">{beats(m).length} beats in the comp · Alt-drag (Shift-scrub) ignores the beats</div>
    </>
  );
}

// ---------------------------------------------------------------- sound effects (opt-in)
let auditionCtx: AudioContext | null = null;
let auditionSrc: AudioBufferSourceNode | null = null;
function play(fam: SfxFamily) {
  auditionCtx ??= new AudioContext();
  const r = renderAudition(fam);
  const b = auditionCtx.createBuffer(2, r.L.length, r.sr);
  b.copyToChannel(r.L as Float32Array<ArrayBuffer>, 0); b.copyToChannel(r.R as Float32Array<ArrayBuffer>, 1);
  try { auditionSrc?.stop(); } catch { /* stopped */ }
  const src = auditionCtx.createBufferSource();
  src.buffer = b; src.connect(auditionCtx.destination); src.start();
  auditionSrc = src;
}

export function SfxRow() {
  const s = st();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const existing = sfxLayers(s);
  const current = existing[0]?.sfx?.family;
  const fams = all ? SFX_FAMILIES : SFX_FAMILIES.filter(f => ['crisp-ui', 'soft-warm', 'cinematic'].includes(f.id) || f.id === current);
  const use = (f: SfxFamily) => {
    if (existing.length) { const r = setSfxFamily(s, f.id); toast(`${r.changed} sounds now ${f.name}`); }
    else {
      if (!hasMotion(s)) { toast('Animate something first: sound effects follow the motion'); return; }
      const r = addSoundEffects(s, { family: f.id });
      toast(`${r.placed.length} sound effects added (${f.name}) · one undo step`);
    }
    // preview over the actual animation
    s.setTime(0); editor.play();
  };
  if (!open) {
    return (
      <div class="au-row">
        <span class="au-label">Sound FX</span>
        <span class="au-grow">
          <button type="button" class="au-btn" onClick={() => setOpen(true)}>{existing.length ? `${existing.length} sounds · ${SFX_FAMILIES.find(f => f.id === current)?.name ?? ''}` : 'Add sound effects…'}</button>
        </span>
      </div>
    );
  }
  return (
    <div class="au-sfx">
      <div class="muted small">Pick a sound family: the whole video uses it. ▶ to audition.</div>
      {fams.map(f => (
        <div class={'au-sfx-fam' + (f.id === current ? ' on' : '')}>
          <button type="button" class="au-btn au-play" aria-label={`Play ${f.name}`} onClick={() => play(f)}>▶</button>
          <span class="au-sfx-name">{f.name}<div class="au-sfx-hint">{f.hint}</div></span>
          <button type="button" class="au-btn" onClick={() => use(f)}>{existing.length ? 'Swap' : 'Use'}</button>
        </div>
      ))}
      <div class="au-row">
        {!all && <button type="button" class="au-btn" onClick={() => setAll(true)}>More families</button>}
        {existing.length > 0 && <button type="button" class="au-btn" onClick={() => { const ids = existing.map(x => x.id); import('../../core/commands').then(c => c.deleteLayers(s, [...ids, ...s.comp.root.filter(id => s.layer(id)?.name === 'Sound effects')])); setOpen(false); }}>Remove all</button>}
        <button type="button" class="au-btn" onClick={() => setOpen(false)}>Done</button>
      </div>
    </div>
  );
}
