// score layout: the inspector merged into the timeline. every property row of the score gets its
// value fields and an ease swatch (the segment under the playhead) right in the row, next to its
// keys. a DOM overlay aligned with the canvas rows; it re-renders only when the rows move
// (scroll, expand, resize) or the document / time changes, and steps aside during playback
// (the canvas then draws the values itself).
import { useEffect, useReducer } from 'preact/hooks';
import { editor } from '../../app/editor';
import { keyId, setEase, setInterp, setProp, setSpring, valueAt } from '../../core/commands';
import { EASE_PRESETS, SPRING_PRESETS } from '../../core/easing';
import { PROP_DEFS, type Layer, type PropKey } from '../../core/model';
import { useChannels } from '../hooks';
import { MiniCurve, MiniSpring } from '../Inspector';
import { showContextMenu, type MenuItem } from '../menu';
import { HEADER_H, ROW_H, type Timeline } from '../timeline';
import { ColorSwatch, NumField } from '../ui';

const FIELDS_W = 196;
const SWATCH_W = 26;

export function ScoreFields({ getTl }: { getTl: () => Timeline | null }) {
  useChannels(['doc', 'time', 'keys', 'playing']);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const st = editor.store;
  const tl = getTl();
  useEffect(() => {
    const t = getTl();
    if (!t) return;
    let sig = '';
    t.onBase = () => {
      const s = `${t.scrollY}|${t.rows.length}|${t.leftW}|${t.h}|${t.rows[0]?.id}`;
      if (s !== sig) { sig = s; force(0); }
    };
    return () => { t.onBase = null; t.hideValues = false; };
  }, []);
  if (!tl) return null;
  const playing = st.playing;
  if (tl.hideValues === playing) { tl.hideValues = !playing; tl.invalidate(); }
  if (playing) return null;
  const first = Math.max(0, Math.floor(tl.scrollY / ROW_H));
  const last = Math.min(tl.rows.length, first + Math.ceil((tl.h - HEADER_H) / ROW_H) + 1);
  const rows = [];
  for (let i = first; i < last; i++) {
    const r = tl.rows[i];
    if (r.kind !== 'prop' || !r.prop) continue;
    const y = tl.rowY(i) - HEADER_H;
    rows.push(<ScoreRow key={r.id + ':' + r.prop} layer={r.layer} prop={r.prop} y={y} x={tl.leftW - FIELDS_W - SWATCH_W - 10} />);
  }
  return <div class="score-fields" style={{ top: HEADER_H + 'px', width: tl.leftW + 'px' }}>{rows}</div>;
}

function ScoreRow({ layer: l, prop, y, x }: { layer: Layer; prop: PropKey; y: number; x: number }) {
  const st = editor.store;
  const def = PROP_DEFS[prop];
  const v = valueAt(l, prop, st.time);
  const set = (nv: number[], mk?: string) => setProp(st, l.id, prop, nv, { mergeKey: mk });
  const suffix = def.unit === '%' ? '%' : def.unit === '°' ? '°' : '';
  let fields;
  if (def.unit === 'color') {
    const hex = '#' + v.slice(0, 3).map(c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('');
    const fromHex = (h: string, mk?: string) => set([parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, v[3]], mk);
    fields = <>
      <ColorSwatch size="sm" value={hex} alpha={v[3]} label={def.label} onInput={h => fromHex(h, 'score-color-' + l.id + prop)} onChange={h => fromHex(h)} />
      <span class="score-hex mono">{hex.toUpperCase()}</span>
      <NumField label="A" min={0} max={100} suffix="%" value={Math.round(v[3] * 100)} onChange={(n, mk) => set([v[0], v[1], v[2], n / 100], mk)} />
    </>;
  } else if (def.dim === 4) {
    fields = <NumField label="R" min={0} value={v[0]} onChange={(n, mk) => set([n, n, n, n], mk)} />;
  } else if (def.dim === 2) {
    const lbl = prop === 'scale' ? ['W', 'H'] : prop === 'size' ? ['W', 'H'] : ['X', 'Y'];
    fields = <>
      <NumField label={lbl[0]} value={v[0]} suffix={suffix} min={(def as any).min} onChange={(n, mk) => set([n, v[1]], mk)} />
      <NumField label={lbl[1]} value={v[1]} suffix={suffix} min={(def as any).min} onChange={(n, mk) => set([v[0], n], mk)} />
    </>;
  } else {
    fields = <NumField label="" value={v[0]} suffix={suffix} min={(def as any).min} max={(def as any).max} onChange={(n, mk) => set([n], mk)} />;
  }
  return (
    <div class="score-row" style={{ transform: `translate(${x}px, ${y}px)` }}>
      <div class="score-vals" style={{ width: FIELDS_W + 'px' }}>{fields}</div>
      <EaseSwatch layer={l} prop={prop} />
    </div>
  );
}

/** the ease of the segment under the playhead; click: select that segment and pick an ease */
function EaseSwatch({ layer: l, prop }: { layer: Layer; prop: PropKey }) {
  const st = editor.store;
  const kf = l.props[prop]?.kf ?? [];
  if (kf.length < 2) return <span class="score-ease none" title="Add a second key to ease between them" />;
  let i = 0;
  while (i < kf.length - 2 && kf[i + 1].t <= st.time + 1e-6) i++;
  const a = kf[i], b = kf[i + 1];
  const keys = [keyId(l.id, prop, i), keyId(l.id, prop, i + 1)];
  const selected = st.keySelection.has(keys[0]) && st.keySelection.has(keys[1]);
  const v = a.interp === 'linear' ? [0, 0, 1, 1] : [a.out[0], a.out[1], b.in[0], b.in[1]];
  const name = a.interp === 'spring' ? `Spring ${Math.round((a.bounce ?? 0.3) * 100)}%` : a.interp === 'hold' ? 'Hold'
    : EASE_PRESETS.find(p => p.v.every((x, k) => Math.abs(x - v[k]) < 1e-3))?.name ?? 'Custom curve';
  const open = (e: MouseEvent) => {
    st.keySelection = new Set(keys);
    st.emit('keys');
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [
      ...EASE_PRESETS.map(p => ({ label: (p.name === name ? '● ' : '   ') + p.name, action: () => setEase(st, keys, p.name) })),
      { separator: true },
      ...SPRING_PRESETS.map(p => ({ label: '   Spring · ' + p.name, action: () => setSpring(st, keys, p.bounce) })),
      { separator: true },
      { label: '   Hold', action: () => setInterp(st, keys, 'hold') },
    ];
    showContextMenu(r.right + 4, r.top, items);
  };
  return (
    <button type="button" class={'score-ease' + (selected ? ' on' : '')} title={`${PROP_DEFS[prop].label}: ${name} (${a.t.toFixed(2)}s → ${b.t.toFixed(2)}s). Click to change`} aria-label={`Ease ${name}`} onClick={open}>
      {a.interp === 'spring' ? <MiniSpring bounce={a.bounce ?? 0.3} /> : a.interp === 'hold' ? <span class="score-hold">▭</span> : <MiniCurve v={v} />}
    </button>
  );
}
