// the editor state the agent gets with every message (so "this", "these", "here" work):
// composition, playhead, work area, markers, selection and @-mentioned layers. kept compact.

import type { Store } from '../core/store';
import type { Layer } from '../core/model';
import { PROP_KEYS } from '../core/model';
import { fmtTime } from './describe';
import { music, musicLayer, sections } from '../audio/timing';

const MAX_LIST = 24;

function layerLine(l: Layer): string {
  const anim = PROP_KEYS.filter(k => l.props[k]?.kf?.length).map(k => `${k} ${l.props[k]!.kf!.length}k`);
  const expr = PROP_KEYS.filter(k => l.props[k]?.expr);
  const extra = [
    anim.length ? `keys: ${anim.join(', ')}` : 'static',
    expr.length ? `expr: ${expr.join(', ')}` : '',
    l.textAnim ? 'text animator' : '',
    l.children.length ? `${l.children.length} children` : '',
    l.text ? `text ${JSON.stringify(l.text.content.slice(0, 40))}` : '',
  ].filter(Boolean).join('; ');
  return `- ${JSON.stringify(l.name)} ${l.type} id=${l.id} (${extra})`;
}

/** layers whose name was @-mentioned in the message ("@Logo", "@[Big title]") */
export function resolveMentions(store: Store, message: string, picked: { id: string; name: string }[] = []): Layer[] {
  const out = new Map<string, Layer>();
  for (const p of picked) {
    const l = store.layer(p.id);
    if (l && (message.includes('@' + p.name) || message.includes(`@[${p.name}]`))) out.set(l.id, l);
  }
  // the agent panel resolves its draft on every render: no '@', no scan over every layer
  if (!message.includes('@')) return [...out.values()];
  let layers: Layer[] | null = null;
  for (const m of message.matchAll(/@\[([^\]]+)\]|@([\w\-.]+)/g)) {
    const name = (m[1] ?? m[2]).trim();
    layers ??= Object.values(store.project.layers);
    const l = layers.find(x => x.name === name) ?? layers.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (l) out.set(l.id, l);
  }
  return [...out.values()];
}

export function editorContext(store: Store, mentioned: Layer[] = []): string {
  const c = store.comp;
  const lines: string[] = [];
  lines.push(`comp ${JSON.stringify(c.name)} ${c.width}x${c.height} ${c.fps}fps ${fmtTime(c.duration)}, ${Object.keys(store.project.layers).length} layers; playhead ${fmtTime(store.time)}${store.workArea ? `; work area ${fmtTime(store.workArea[0])}–${fmtTime(store.workArea[1])}` : ''}`);
  const mk = c.markers ?? [];
  if (mk.length) lines.push(`markers: ${mk.slice(0, MAX_LIST).map(m => `${fmtTime(m.t)}${m.label ? ' ' + JSON.stringify(m.label) : ''}`).join(', ')}${mk.length > MAX_LIST ? ` (+${mk.length - MAX_LIST})` : ''}`);
  const ml = musicLayer(store);
  if (ml) {
    const m = music(store);
    lines.push(m ? `music: ${JSON.stringify(ml.name)} id=${ml.id} ${Math.round(m.a.bpm)} BPM ${m.a.meter}/4, ${fmtTime(m.from)}–${fmtTime(m.to)}, sections ${sections(m).map(x => `${x.label}@${fmtTime(x.t0)}`).join(' ')} (get_audio_analysis for beats/accents; design to it)`
      : `music: ${JSON.stringify(ml.name)} id=${ml.id} (analysing; get_audio_analysis waits for it)`);
  }
  const sel = store.selection.map(id => store.layer(id)).filter(Boolean) as Layer[];
  if (sel.length) {
    lines.push(`selected (${sel.length}, in selection order):`);
    for (const l of sel.slice(0, MAX_LIST)) lines.push(layerLine(l));
    if (sel.length > MAX_LIST) lines.push(`- … ${sel.length - MAX_LIST} more`);
  } else lines.push('selected: nothing');
  const extra = mentioned.filter(l => !store.selection.includes(l.id));
  if (extra.length) {
    lines.push('mentioned:');
    for (const l of extra.slice(0, MAX_LIST)) lines.push(layerLine(l));
  }
  if (store.keySelection.size) lines.push(`selected keyframes: ${[...store.keySelection].slice(0, MAX_LIST).join(', ')}`);
  return `<editor_context>\n${lines.join('\n')}\n</editor_context>`;
}

/** the text sent to the agent: user message + context. "this"/"these" refer to the selection. */
export function composeMessage(store: Store, text: string, picked: { id: string; name: string }[] = []): string {
  return `${text}\n\n${editorContext(store, resolveMentions(store, text, picked))}`;
}
