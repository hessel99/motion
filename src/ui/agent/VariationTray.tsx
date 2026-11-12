// A/B/C variations made by the agent: preview (applies + plays), scrub, pick.
import { useEffect, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { variations, type Variation } from '../../agent/variations';

/** filmstrip thumbnails, rendered right when the agent saves a variation (the document is in that state then) */
export function installVariationThumbs() {
  let seen = new Set<string>();
  return variations.on(() => {
    for (const v of variations.list) {
      if (seen.has(v.id) || v.thumbs) continue;
      seen.add(v.id);
      if (!editor.renderer) continue;
      const [a, b] = variations.range(v);
      try { v.thumbs = [a, (a + b) / 2, b].map(t => editor.renderer.snapshot(Math.min(t, editor.store.comp.duration), 96)); } catch { /* no gl (tests) */ }
    }
    if (!variations.list.length) seen = new Set();
  });
}

export function VariationTray() {
  const [, force] = useState(0);
  useEffect(() => variations.on(() => force(x => x + 1)), []);
  useEffect(() => editor.store.on('time', () => force(x => x + 1)), []);
  if (!variations.list.length) return null;
  const s = editor.store;

  const preview = (v: Variation) => {
    if (variations.active !== v.id) variations.apply(s, v.id);
    const [a] = variations.range(v);
    s.setTime(Math.max(0, a - 0.05));
    editor.play();
  };

  const act = variations.list.find(v => v.id === variations.active);
  const [ra, rb] = act ? variations.range(act) : [0, 0];

  return (
    <div class="ag-variations" data-testid="variations">
      <div class="ag-var-head">
        <span class="ag-grow"><b>Variations</b> <span class="ag-muted">click to preview · pick one to keep</span></span>
        <button class="ag-icon-btn" title="Close (keeps the current one)" onClick={() => variations.clear()}>✕</button>
      </div>
      <div class="ag-var-list">
        {variations.list.map(v => (
          <div class={'ag-var' + (v.id === variations.active ? ' on' : '')} onClick={() => preview(v)} title={v.note ?? v.label}>
            <div class="ag-var-strip">{(v.thumbs ?? []).map(src => <img src={src} alt="" />)}{!v.thumbs?.length && <span class="ag-muted">▶</span>}</div>
            <div class="ag-var-label">{v.label}</div>
            {v.note && <div class="ag-var-note">{v.note}</div>}
          </div>
        ))}
      </div>
      {act && (
        <div class="ag-var-foot">
          <input type="range" class="ag-grow" min={ra} max={Math.max(rb, ra + 0.01)} step={1 / s.comp.fps} value={s.time} title="Scrub this variation"
            onInput={e => { editor.pause(); s.setTime(+(e.target as HTMLInputElement).value); }} />
          <button class="ag-btn primary" title="Keep this variation and close" onClick={() => variations.clear()}>Use {act.label.split(/[·:\-]/)[0].trim()}</button>
        </div>
      )}
    </div>
  );
}
