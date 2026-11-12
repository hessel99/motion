// everything a frame depends on that arrives asynchronously in the editor, awaited before an
// export renders its first frame: fonts, decoded images, and the music analysis that audio()
// expressions read (without it the first export after an import would render audio-reactive
// layers flat).

import { editor } from '../app/editor';
import { getBitmap } from '../render/raster';
import { ensureAnalysis } from '../audio/analysis-store';
import { refreshAudioEnv } from '../audio/timing';

export async function prepareExport(timeoutMs = 15000) {
  const store = editor.store, p = store.project;
  try { await (document as any).fonts?.ready; } catch { /* */ }
  const until = performance.now() + timeoutMs;
  for (const a of Object.values(p.assets ?? {})) {
    while (a.kind === 'image' && !getBitmap(a) && performance.now() < until) await new Promise(r => setTimeout(r, 20));
  }
  const audio = Object.values(p.layers).filter(l => l.type === 'audio' && l.imageRef && p.assets[l.imageRef]);
  if (audio.length) {
    await Promise.race([
      Promise.all(audio.map(l => ensureAnalysis(p.assets[l.imageRef!], l.audio?.bpm).catch(() => null))),
      new Promise(r => setTimeout(r, Math.max(0, until - performance.now()))),
    ]);
    if (refreshAudioEnv(store)) editor.renderer.dirty = true;
  }
}
