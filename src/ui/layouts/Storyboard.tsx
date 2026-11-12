// director layout: a storyboard of the composition's key moments (real renders, re-shot when the
// document settles) and the summon bar for the panels that are not docked.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { useChannels } from '../hooks';
import { Button, Kbd } from '../ui';
import { askAgent, summon, toggleSummon } from './layout';
import { keyMoments, type Moment } from './moments';

const THUMB = 220;

export function Storyboard() {
  useChannels(['doc', 'comps', 'selection'], ['loaded']);
  const s = editor.store;
  const moments = keyMoments(9);
  const sig = moments.map(m => m.t.toFixed(3)).join(',');
  const thumbs = useThumbs(moments, sig);
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  // playhead on the thread + active card: per frame, but only a transform and (rarely) a class
  useEffect(() => editor.onFrame((_n, t) => {
    const dur = editor.store.comp.duration;
    if (track.current) track.current.style.transform = `translateX(${((t / dur) * 100).toFixed(3)}%)`;
    let a = 0;
    for (let i = 0; i < moments.length; i++) if (moments[i].t <= t + 1e-4) a = i;
    if (a !== active) setActive(a);
  }), [sig, active]);
  const dur = s.comp.duration;
  const go = (m: Moment) => { s.setTime(m.t); if (m.ids.length) s.select(m.ids.filter(id => s.layer(id))); };
  const caption = (m: Moment, i: number) => m.label ?? (i === 0 && !m.layers.length ? 'Opening frame' : m.layers.length ? m.layers.slice(0, 3).join(', ') + (m.layers.length > 3 ? ` +${m.layers.length - 3}` : '') : 'Hold');
  return (
    <section class="storyboard" aria-label="Storyboard: key moments">
      <div class="sb-head">
        <span class="section-title">Key moments</span>
        <span class="muted small">{moments.length} beats · {dur}s · click a beat to jump there and select what moves</span>
        <span class="grow" />
        <Button variant="ghost" size="sm" active={summon.timeline} tip="Timeline sheet (`)" onClick={() => toggleSummon('timeline')}>▤ Timeline</Button>
      </div>
      <div class="sb-strip">
        {moments.map((m, i) => (
          <div class={'sb-card' + (i === active ? ' on' : '')} key={m.t}>
            <button type="button" class="sb-frame" onClick={() => go(m)} aria-label={`Jump to ${m.t.toFixed(2)}s: ${caption(m, i)}`} style={{ aspectRatio: `${s.comp.width} / ${s.comp.height}` }}>
              {thumbs.get(m.t.toFixed(3)) ? <img src={thumbs.get(m.t.toFixed(3))} alt="" draggable={false} /> : <span class="sb-blank" />}
              <span class="sb-time mono">{m.t.toFixed(2)}s</span>
            </button>
            <div class="sb-cap">
              <span class="sb-cap-text" title={caption(m, i)}>{caption(m, i)}</span>
              <button type="button" class="ghost btn-sm sb-ask" title="Ask the agent about this moment" onClick={() => askAgent(`At ${m.t.toFixed(2)}s${m.layers.length ? ` (${m.layers.join(', ')})` : ''}: `)}>✦</button>
            </div>
          </div>
        ))}
        <button type="button" class="sb-add" title="Ask the agent for a new beat" onClick={() => askAgent(`Add a new beat after ${moments[moments.length - 1]?.t.toFixed(2) ?? 0}s: `)}>
          <span class="sb-add-plus">✦</span><span>New beat…</span>
        </button>
      </div>
      <div class="sb-thread" aria-hidden="true">
        {moments.map(m => <span class="sb-dot" style={{ left: `${(m.t / dur) * 100}%` }} />)}
        <div class="sb-playhead" ref={track}><span /></div>
      </div>
    </section>
  );
}

/** renders of the moments, re-shot 400 ms after the document settles (never during playback or a drag) */
function useThumbs(moments: Moment[], sig: string) {
  const [map, setMap] = useState(() => new Map<string, string>());
  // the document version: bumped by edits only (not by playback or by this component's renders)
  const [ver, setVer] = useState(0);
  useEffect(() => {
    const offs = [editor.store.on('doc', () => setVer(v => v + 1)), editor.on('loaded', () => setVer(v => v + 1)), editor.on('theme', () => setVer(v => v + 1))];
    return () => offs.forEach(o => o());
  }, []);
  const times = useMemo(() => moments.map(m => m.t), [sig]);
  useEffect(() => {
    let cancelled = false, timer = 0;
    const shoot = () => {
      if (cancelled) return;
      const st = editor.store;
      if (st.playing || document.querySelector('.viewport:active')) { timer = window.setTimeout(shoot, 500); return; }
      const next = new Map<string, string>();
      try { for (const t of times) next.set(t.toFixed(3), editor.renderer.snapshot(Math.min(t, st.comp.duration - 1e-4), THUMB)); } catch { return; }
      setMap(next);
    };
    timer = window.setTimeout(shoot, map.size ? 400 : 60);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sig, ver]);
  return map;
}

/** director: the docked-nothing panels, summoned from a small bar over the stage */
export function SummonBar() {
  useChannels([], ['layout']);
  return (
    <div class="summon-bar" role="toolbar" aria-label="Panels">
      <Button variant="ghost" size="sm" active={summon.inspector} tip="Properties" onClick={() => toggleSummon('inspector')}>◧ Properties</Button>
      <Button variant="ghost" size="sm" active={summon.timeline} tip="Timeline (`)" onClick={() => toggleSummon('timeline')}>▤ Timeline</Button>
      <Button variant="ghost" size="sm" tip="Command palette" onClick={() => toggleSummon('palette', true)}><Kbd>⌘K</Kbd></Button>
    </div>
  );
}
