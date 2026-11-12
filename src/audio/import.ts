// bringing audio in (paste, drop, File → Import): an audio layer at the playhead (0 in an empty comp),
// then, once decoded and analysed, two optional offers: fit the comp to the music (whole song, or the
// next 4-bar phrase), and "Sync animation to the music?" when the comp already moves.

import { editor } from '../app/editor';
import { createLayer, uid, type Asset, type Layer } from '../core/model';
import { ensureAnalysis } from './analysis-store';
import { music, refreshAudioEnv } from './timing';
import { musicalLengths, syncToMusic } from './sync';
import { insertLayer, setCompSettings } from '../core/commands';

export const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba'];
export const isAudioFile = (f: { name: string; type: string }) => f.type.startsWith('audio/') || AUDIO_EXT.includes(f.name.split('.').pop()!.toLowerCase());

const MIME: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', weba: 'audio/webm' };

const fileToDataUrl = (f: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(f); });

/** comp has animation on non-audio layers */
export function compIsAnimated(): boolean {
  const s = editor.store;
  const walk = (ids: string[]): boolean => ids.some(id => { const l = s.layer(id); return !!l && l.type !== 'audio' && (Object.values(l.props).some(p => p?.kf?.length) || !!l.textAnim || walk(l.children)); });
  return walk(s.comp.root);
}

/** add an audio layer from a data url; returns the layer (no ui) */
export function addAudioLayer(name: string, data: string, mime: string, opts: { at?: number; offers?: boolean } = {}): Layer {
  const s = editor.store;
  const empty = !s.comp.root.some(id => s.layer(id)?.type !== 'audio');
  const asset: Asset = { id: uid('a'), kind: 'audio', mime, data, width: 0, height: 0 };
  const l = createLayer('audio', { x: 0, y: 0, w: 0, h: 0, name });
  l.imageRef = asset.id;
  l.startTime = opts.at ?? (empty ? 0 : Math.round(s.time * s.comp.fps) / s.comp.fps);
  l.volume = 1;
  s.transact('Import audio', tx => {
    tx.set(s.project.assets, asset.id, asset);
    tx.change.assets = true;
    insertLayer(s, tx, l, null);
  });
  s.select([l.id]);
  ensureAnalysis(asset);
  return l;
}

export async function importAudioFile(f: File, opts: { at?: number } = {}) {
  const ext = f.name.split('.').pop()!.toLowerCase();
  const data = await fileToDataUrl(f);
  const l = addAudioLayer(f.name.replace(/\.[^.]+$/, ''), data, f.type || MIME[ext] || 'audio/mpeg', opts);
  const { toast } = await import('../app/actions');
  toast(`Audio added at ${(l.startTime ?? 0).toFixed(2)}s · analysing the music…`);
  await offerAfterImport(l);
}

/** after decode + analysis: fit-comp offer and the sync offer */
export async function offerAfterImport(l: Layer) {
  const s = editor.store;
  const asset = l.imageRef ? s.project.assets[l.imageRef] : undefined;
  if (!asset) return;
  const t0 = performance.now();
  const a = await ensureAnalysis(asset, l.audio?.bpm);
  const { toast } = await import('../app/actions');
  if (!a) { toast('Could not analyse this audio (beats and sync are unavailable)', 'error'); return; }
  refreshAudioEnv(s);
  editor.emit('audio');
  const m = music(s);
  const { actionCard } = await import('../ui/audio/action-card');
  const secs = a.sections.filter(x => x.label !== 'main').map(x => x.label);
  toast(`${Math.round(a.bpm)} BPM · ${a.meter}/4 · ${a.beats.length} beats${secs.length ? ' · ' + [...new Set(secs)].join(', ') : ''} (${Math.round(performance.now() - t0)} ms)`);
  if (m && m.layer.id === l.id) {
    const end = m.start + a.lastSound;
    if (s.comp.duration < end - 0.05) {
      const lens = musicalLengths(m, s.comp.duration);
      const fit = (d: number, label: string) => () => { setCompSettings(s, { duration: Math.round(d * s.comp.fps) / s.comp.fps }); toast(label); };
      const acts = [{ label: `Fit to music (${lens.full.toFixed(1)} s)`, run: fit(lens.full, 'Composition fitted to the music'), primary: true }];
      if (lens.phrase && lens.phrase < lens.full - 0.5) acts.push({ label: `End on a phrase (${lens.phrase.toFixed(1)} s)`, run: fit(lens.phrase, 'Composition ends on a 4-bar phrase'), primary: false });
      else if (lens.bar && lens.bar < lens.full - 0.5) acts.push({ label: `End on a bar (${lens.bar.toFixed(1)} s)`, run: fit(lens.bar, 'Composition ends on a bar'), primary: false });
      actionCard(`The music is longer than the composition (${s.comp.duration.toFixed(1)} s)`, acts, { id: 'fit', detail: 'Change the composition length?' });
    }
    if (compIsAnimated()) {
      actionCard('Sync animation to the music?', [
        { label: 'Sync timing', primary: true, run: () => { const r = syncToMusic(s, { mode: 'beats' }); toast(r && r.anchors.length ? `Synced: ${r.anchors.length} moments moved onto beats (one undo step)` : 'Nothing to sync'); } },
        { label: 'Ask the agent', run: () => askAgent('Sync my animation to the music: big moves on downbeats, accents on the strongest hits, holds in quiet parts. Keep the motion style.') },
      ], { id: 'sync', detail: 'Moves land on beats and accents; one undo step.' });
    }
  }
}

/** open the agent panel with a drafted message */
export async function askAgent(text: string) {
  const { openLeft } = await import('../ui/chrome/ui-state');
  openLeft('agent');
  (editor as any).agentDraft = text;
  setTimeout(() => editor.emit('agent-draft'), 50);
}
