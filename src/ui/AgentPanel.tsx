import { useEffect, useRef, useState } from 'preact/hooks';
import { agentClient, type ChatEvent } from '../agent/client';
import { editor } from '../app/editor';

interface Msg {
  role: 'user' | 'assistant' | 'tool' | 'error' | 'info' | 'revert';
  text: string;
  marker?: number;
  steps?: number;
  endMarker?: number;
  tool?: { name: string; input: any; result?: string; isError?: boolean; id: string };
}

const STORAGE = 'motion.agent';

export function AgentPanel() {
  const [, force] = useState(0);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>(() => { try { return localStorage.getItem(STORAGE + '.provider') || 'claude'; } catch { return 'claude'; } });
  const session = useRef<Record<string, string | undefined>>({});
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => agentClient.on(() => force(x => x + 1)), []);
  useEffect(() => editor.store.on('history', () => force(x => x + 1)), []);
  useEffect(() => { list.current?.scrollTo({ top: 1e9 }); }, [msgs]);

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    const sel = editor.store.selection;
    const ctx = sel.length ? `\n\n[editor context: selected layer ids: ${sel.join(', ')}; playhead at ${editor.store.time.toFixed(2)}s]` : `\n\n[editor context: playhead at ${editor.store.time.toFixed(2)}s]`;
    setMsgs(m => [...m, { role: 'user', text }]);
    const marker = editor.store.historyLength;
    let assistantIdx = -1;
    const append = (fn: (m: Msg[]) => Msg[]) => setMsgs(fn);
    const id = agentClient.chat({ provider, message: text + ctx, sessionId: session.current[provider] }, (e: ChatEvent) => {
      switch (e.kind) {
        case 'session': session.current[provider] = e.sessionId; break;
        case 'text_delta':
          append(m => {
            const c = m.slice();
            if (assistantIdx >= 0 && c[assistantIdx]?.role === 'assistant') c[assistantIdx] = { ...c[assistantIdx], text: c[assistantIdx].text + e.text };
            else { assistantIdx = c.length; c.push({ role: 'assistant', text: e.text }); }
            return c;
          });
          break;
        case 'text':
          append(m => {
            const c = m.slice();
            if (assistantIdx >= 0 && c[assistantIdx]?.role === 'assistant') c[assistantIdx] = { ...c[assistantIdx], text: e.text };
            else c.push({ role: 'assistant', text: e.text });
            assistantIdx = -1;
            return c;
          });
          break;
        case 'tool_use':
          assistantIdx = -1;
          append(m => [...m, { role: 'tool', text: '', tool: { id: e.id, name: e.name, input: e.input } }]);
          break;
        case 'tool_result':
          append(m => m.map(x => (x.tool?.id === e.id ? { ...x, tool: { ...x.tool!, result: e.summary, isError: e.isError } } : x)));
          break;
        case 'error': append(m => [...m, { role: 'error', text: e.message }]); break;
        case 'done': {
          setBusy(null);
          const steps = editor.store.historyLength - marker;
          if (steps > 0) append(m => [...m, { role: 'revert', text: '', marker, steps, endMarker: editor.store.historyLength }]);
          if (e.durationMs) append(m => [...m, { role: 'info', text: `done · ${(e.durationMs / 1000).toFixed(1)}s` }]);
          break;
        }
      }
    });
    setBusy(id);
  };

  const providers = agentClient.providers;
  const status = agentClient.status;
  const avail = providers.find(p => p.id === provider)?.available;

  return (
    <div class="agent">
      <div class="agent-head">
        <span class={'dot ' + status} title={`bridge: ${status}`} />
        <select value={provider} onChange={e => { const v = (e.target as HTMLSelectElement).value; setProvider(v); try { localStorage.setItem(STORAGE + '.provider', v); } catch { /* ignore */ } }}>
          {(providers.length ? providers : [{ id: 'claude', name: 'Claude Code', available: false }]).map(p => (
            <option value={p.id}>{p.name}{p.available ? '' : ' (not found)'}</option>
          ))}
        </select>
        <button class="ghost" title="New conversation" onClick={() => { session.current[provider] = undefined; setMsgs([]); }}>New</button>
      </div>
      <div class="agent-list" ref={list}>
        {status !== 'connected' && (
          <div class="agent-note">
            <b>Agent bridge offline.</b> The desktop app starts it automatically. In the browser run <code>npm run bridge</code>.
            The bridge uses the Claude Code / Codex / Gemini CLI on your computer, so your own subscription is used.
          </div>
        )}
        {status === 'connected' && providers.length > 0 && !avail && (
          <div class="agent-note">The <b>{provider}</b> CLI was not found. Install it and log in (e.g. <code>npm i -g @anthropic-ai/claude-code</code> then <code>claude</code>).</div>
        )}
        {msgs.length === 0 && status === 'connected' && (
          <div class="agent-empty">
            <div>Ask the agent to build or change your animation.</div>
            {['Make a logo reveal with 3 shapes popping in', 'Add a bouncy entrance to the selected layers', 'Stagger all layers 0.1s with Expo Out'].map(s => (
              <button class="suggest" onClick={() => setInput(s)}>{s}</button>
            ))}
          </div>
        )}
        {msgs.map((m, mi) => (
          m.role === 'revert' ? (
            <div class="msg revert">
              <span class="muted small">{m.steps} change{m.steps === 1 ? '' : 's'} by the agent</span>
              <button class="ghost" disabled={editor.store.historyLength !== m.endMarker} title={editor.store.historyLength !== m.endMarker ? 'You made changes after this turn; use Undo (⌘Z) instead' : ''} onClick={() => {
                const n = editor.store.undoTo(m.marker!);
                setMsgs(all => all.map((x, j) => (j === mi ? { ...x, role: 'info', text: `reverted ${n} change${n === 1 ? '' : 's'}` } : x)));
              }}>Undo agent changes</button>
            </div>
          ) : m.role === 'tool' ? (
            <details class={'msg tool' + (m.tool?.isError ? ' err' : '')}>
              <summary>{m.tool!.result === undefined ? '⋯' : m.tool!.isError ? '✕' : '✓'} {m.tool!.name.replace(/^mcp__motion__/, '')}</summary>
              <pre>{JSON.stringify(m.tool!.input, null, 1)}</pre>
              {m.tool!.result && <pre>{m.tool!.result}</pre>}
            </details>
          ) : <div class={'msg ' + m.role}>{m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}</div>
        ))}
        {busy && <div class="msg info">working…</div>}
      </div>
      <div class="agent-input">
        <textarea
          value={input}
          placeholder={status === 'connected' ? 'Describe an animation…' : 'Bridge offline'}
          onInput={e => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          rows={3}
        />
        {busy ? <button onClick={() => { agentClient.cancel(busy); setBusy(null); }}>Stop</button> : <button class="primary" disabled={!input.trim() || status !== 'connected'} onClick={send}>Send</button>}
      </div>
    </div>
  );
}

/** tiny markdown renderer: **bold**, `code`, - bullets. builds vnodes (never innerHTML) */
function Markdown({ text }: { text: string }) {
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map(part =>
    part.startsWith('**') && part.endsWith('**') ? <b>{part.slice(2, -2)}</b> : part.startsWith('`') && part.endsWith('`') ? <code>{part.slice(1, -1)}</code> : part);
  return <>{text.split('\n').map(line => {
    const b = line.match(/^\s*[-*]\s+(.*)/);
    if (b) return <div class="md-li">• {inline(b[1])}</div>;
    const h = line.match(/^#+\s+(.*)/);
    if (h) return <div><b>{inline(h[1])}</b></div>;
    return line.trim() ? <div>{inline(line)}</div> : <div class="md-gap" />;
  })}</>;
}
