// the brief box: "What do you want to make?". the hero of Home and of a new document's empty
// canvas. a brief starts the agent (in a new document on Home: its size comes from the format
// chips or from the brief itself); files dropped on it (a logo, an SVG, an image, audio) come in
// as layers; a Figma frame is pasted with ⌘V anywhere.

import { useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { openBrowserFile } from '../../app/actions';
import { setCompSettings } from '../../core/commands';
import { activeDoc, newDocument } from '../../app/documents';
import { askAgent } from '../agent-bridge';
import { ArrowUp, Upload } from './icons';

type Format = '16:9' | '9:16' | '1:1';
const SIZES: Record<Format, [number, number]> = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };

const STARTERS: { label: string; brief: string; format?: Format }[] = [
  { label: 'Logo reveal', brief: 'A logo reveal: the mark draws in, the wordmark follows with a soft overshoot, then a calm hold.' },
  { label: 'UI micro-interaction', brief: 'A UI micro-interaction: a button press with a satisfying spring, a check mark and a subtle confetti burst.', format: '1:1' },
  { label: 'Kinetic type', brief: 'Kinetic typography: a short punchy line, word by word, with bold scale and position changes on the beat.' },
  { label: 'Social post', brief: 'A social post animation: a headline, an image card and a call to action, energetic and on brand.', format: '9:16' },
  { label: 'Explainer', brief: 'A short explainer scene: three simple shapes illustrate a process step by step, with clear transitions.' },
];

/** a size from words in the brief (story / square / …), else none */
function formatFromBrief(text: string): Format | null {
  const t = text.toLowerCase();
  if (/9\s*:\s*16|vertical|portrait|story|stories|reel|tiktok|shorts/.test(t)) return '9:16';
  if (/1\s*:\s*1|square|instagram post/.test(t)) return '1:1';
  if (/16\s*:\s*9|landscape|youtube|widescreen/.test(t)) return '16:9';
  return null;
}

/** `fresh`: on Home (makes a new document). otherwise it works on the open (empty) document */
export function PromptBox(props: { fresh: boolean }) {
  const [text, setText] = useState('');
  const [format, setFormat] = useState<Format | null>(null);
  const [over, setOver] = useState(false);
  const target = (): void => {
    const f = format ?? formatFromBrief(text) ?? '16:9';
    const [w, h] = SIZES[f];
    if (props.fresh || !activeDoc()) newDocument({ width: w, height: h });
    else if (format || formatFromBrief(text)) setCompSettings(editor.store, { width: w, height: h });
  };
  const submit = () => {
    const brief = text.trim();
    if (!brief) return;
    target();
    setText('');
    askAgent(brief);
  };
  const drop = async (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    target();
    for (const f of files) await openBrowserFile(f);
  };
  return (
    <div class={'prompt' + (over ? ' dropping' : '') + (props.fresh ? ' prompt-hero' : '')}
      onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop as any}>
      <h1 class="prompt-title">What do you want to make?</h1>
      <div class="prompt-box">
        <textarea class="prompt-input" rows={props.fresh ? 3 : 2} value={text} placeholder="A logo reveal: the mark draws in, the name follows with a soft overshoot…"
          aria-label="Describe the animation"
          onInput={e => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
        <div class="prompt-foot">
          <div class="seg seg-sm prompt-formats" role="group" aria-label="Format">
            {(['16:9', '9:16', '1:1'] as Format[]).map(f => (
              <button type="button" class={(format ?? formatFromBrief(text) ?? '16:9') === f ? 'on' : ''} aria-pressed={(format ?? formatFromBrief(text) ?? '16:9') === f} onClick={() => setFormat(f)}>{f}</button>
            ))}
          </div>
          <span class="prompt-drop muted"><Upload size={14} />Drop files</span>
          <span class="grow" />
          <button type="button" class="send-btn primary" aria-label="Start" title="Start (Enter)" disabled={!text.trim()} onClick={submit}><ArrowUp /></button>
        </div>
      </div>
      <div class="prompt-chips">
        {STARTERS.map(s => (
          <button type="button" class="prompt-chip" onClick={() => { setText(s.brief); if (s.format) setFormat(s.format); }}>{s.label}</button>
        ))}
      </div>
    </div>
  );
}
