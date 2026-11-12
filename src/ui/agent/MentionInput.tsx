// prompt textarea with @-mentions of layers: type "@" and pick a layer; the agent gets its id.
import { useMemo, useRef, useState } from 'preact/hooks';
import { editor } from '../../app/editor';

export interface Mention { id: string; name: string }

const TYPE_ICON: Record<string, string> = { rect: '▭', ellipse: '◯', text: 'T', group: '▣', path: '✎', image: '▨', precomp: '◫', audio: '♪' };

export function mentionToken(name: string) { return /^[\w\-.]+$/.test(name) ? `@${name}` : `@[${name}]`; }

export function MentionInput(props: {
  value: string;
  onInput: (v: string) => void;
  onSubmit: () => void;
  onEscape?: () => void;
  onMention: (m: Mention) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    if (query === null) return [];
    const s = editor.store;
    const q = query.toLowerCase();
    // selection first, then draw order of the active comp
    const ids = [...new Set([...s.selection, ...s.drawOrder()])];
    const out: { id: string; name: string; type: string; sel: boolean }[] = [];
    for (const id of ids) {
      const l = s.layer(id);
      if (!l || (q && !l.name.toLowerCase().includes(q))) continue;
      out.push({ id, name: l.name, type: l.type, sel: s.selection.includes(id) });
      if (out.length >= 8) break;
    }
    return out;
  }, [query]);

  const detect = (el: HTMLTextAreaElement) => {
    const upto = el.value.slice(0, el.selectionStart ?? el.value.length);
    const m = upto.match(/(?:^|\s)@([^\s@\]]{0,40})$/);
    setQuery(m ? m[1] : null);
    setActive(0);
  };

  const pick = (m: { id: string; name: string }) => {
    const el = ta.current!;
    const pos = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, pos).replace(/@([^\s@\]]{0,40})$/, mentionToken(m.name) + ' ');
    const next = before + el.value.slice(pos);
    props.onInput(next);
    props.onMention({ id: m.id, name: m.name });
    setQuery(null);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = before.length; });
  };

  return (
    <div class="ag-input-wrap">
      {query !== null && matches.length > 0 && (
        <div class="ag-mentions" role="listbox">
          {matches.map((m, i) => (
            <div role="option" aria-selected={i === active} class={'ag-mention' + (i === active ? ' on' : '')} onMouseDown={e => { e.preventDefault(); pick(m); }} onMouseEnter={() => setActive(i)}>
              <span class="ag-mention-icon">{TYPE_ICON[m.type] ?? '•'}</span>
              <span class="ag-grow">{m.name}</span>
              {m.sel && <span class="ag-muted">selected</span>}
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        rows={3}
        onInput={e => { const el = e.target as HTMLTextAreaElement; props.onInput(el.value); detect(el); }}
        onClick={e => detect(e.target as HTMLTextAreaElement)}
        onBlur={() => setTimeout(() => setQuery(null), 120)}
        onKeyDown={e => {
          e.stopPropagation(); // editor shortcuts must not fire while typing
          if (query !== null && matches.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % matches.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + matches.length) % matches.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[active]); return; }
            if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return; }
          }
          if (e.key === 'Escape') { props.onEscape?.(); return; }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); props.onSubmit(); }
        }}
      />
    </div>
  );
}
