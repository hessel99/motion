import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { agentClient, type ChatEvent, type ChatMode } from '../agent/client';
import { editor } from '../app/editor';
import { composeMessage, editorContext, resolveMentions } from '../agent/context';
import { diffDocs, diffIsEmpty, snapshotDoc, type DocSnapshot } from '../agent/diff';
import { loadChat, projectKey, saveChat, type Msg, type ReviewInfo } from '../agent/history';
import { toolLabel } from '../agent/labels';
import { availableActions, targetPhrase, type QuickAction } from '../agent/quick';
import { animRange } from '../agent/describe';
import { variations } from '../agent/variations';
import { MentionInput, type Mention } from './agent/MentionInput';
import { TurnReview } from './agent/TurnReview';
import { VariationTray, installVariationThumbs } from './agent/VariationTray';
import './agent/agent.css';

const STORAGE = 'motion.agent';
const pref = (k: string, d: string) => { try { return localStorage.getItem(STORAGE + '.' + k) || d; } catch { return d; } };
const setPref = (k: string, v: string) => { try { localStorage.setItem(STORAGE + '.' + k, v); } catch { /* */ } };

interface Turn { chatId: string; startedAt: number; activity: string; stopping: boolean; live: number; snap: DocSnapshot; marker: number }

export function AgentPanel() {
  const [, force] = useState(0);
  const key = useRef(projectKey(editor.store.project));
  const restored = useMemo(() => loadChat(key.current), []);
  const [msgs, setMsgs] = useState<Msg[]>(() => restored?.msgs ?? []);
  const session = useRef<Record<string, string | undefined>>(restored?.sessions ?? {});
  const [input, setInput] = useState('');
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [turn, setTurn] = useState<Turn | null>(null);
  const turnRef = useRef<Turn | null>(null);
  turnRef.current = turn;
  const [mode, setMode] = useState<ChatMode>(() => (pref('mode', 'edit') === 'ask' ? 'ask' : 'edit'));
  const [provider, setProvider] = useState<string>(() => pref('provider', 'claude'));
  const [model, setModel] = useState<string>(() => pref('model', ''));
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [, tick] = useState(0);
  const finishers = useRef(new Map<string, () => void>());

  useEffect(() => agentClient.on(() => force(x => x + 1)), []);
  useEffect(() => editor.store.on('history', () => force(x => x + 1)), []);
  useEffect(() => editor.store.on('selection', () => force(x => x + 1)), []);
  useEffect(() => installVariationThumbs(), []);
  // keep scrolled to the bottom unless the user scrolled up to read
  useEffect(() => { if (stick.current) list.current?.scrollTo({ top: 1e9 }); }, [msgs, turn]);
  // elapsed timer while a turn runs
  useEffect(() => { if (!turn) return; const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, [!!turn]);

  // per-project persistence
  useEffect(() => { const t = setTimeout(() => saveChat(key.current, msgs, session.current), 400); return () => clearTimeout(t); }, [msgs]);
  useEffect(() => editor.on('loaded', () => {
    const k = projectKey(editor.store.project);
    if (k === key.current) return;
    saveChat(key.current, msgs, session.current);
    key.current = k;
    const c = loadChat(k);
    session.current = c?.sessions ?? {};
    variations.clear();
    setMsgs(c?.msgs ?? []);
  }), [msgs]);

  // live change counter while the agent works
  useEffect(() => editor.store.on('history', () => {
    const t = turnRef.current;
    if (!t) return;
    const d = diffDocs(t.snap, snapshotDoc(editor.store.project));
    const live = d.added.length + d.changed.length + d.removed.length;
    if (live !== t.live) setTurn(x => (x && x.chatId === t.chatId ? { ...x, live } : x));
  }), []);

  // show the images the agent looked at inside its tool steps
  useEffect(() => agentClient.onToolImage(img => {
    if (!turnRef.current) return;
    setMsgs(m => {
      for (let i = m.length - 1; i >= 0; i--) {
        const t = m[i].tool;
        if (t && !t.image && t.name.endsWith(img.tool)) { const c = m.slice(); c[i] = { ...m[i], tool: { ...t, image: `data:${img.mimeType};base64,${img.data}` } }; return c; }
      }
      return m;
    });
  }), []);

  const layerName = (id: string) => editor.store.layer(id)?.name;

  const send = (text: string, opts: { mode?: ChatMode; chip?: string } = {}) => {
    text = text.trim();
    if (!text || turnRef.current || agentClient.status !== 'connected') return;
    const s = editor.store;
    const m = opts.mode ?? mode;
    const m0 = m;
    const message = composeMessage(s, text, mentions);
    setInput('');
    setMentions([]);
    stick.current = true;
    setMsgs(x => [...x, { role: 'user', text, mode: m, chip: opts.chip }]);
    const snap = snapshotDoc(s.project);
    const marker = s.historyLength;
    let assistantIdx = -1;
    let finished = false;
    const append = (fn: (m: Msg[]) => Msg[]) => setMsgs(fn);
    const activity = (a: string) => setTurn(t => (t && t.chatId === chatId ? { ...t, activity: a } : t));

    const finish = (e: ChatEvent) => {
      if (finished) return;
      finished = true;
      const steps = s.historyLength - marker;
      const diff = diffDocs(snap, snapshotDoc(s.project));
      if (steps > 0 && !diffIsEmpty(diff)) {
        let a = Infinity, b = -Infinity;
        for (const c of [...diff.added, ...diff.changed]) { const l = s.layer(c.id); const r = l && animRange(l); if (r) { a = Math.min(a, r[0]); b = Math.max(b, r[1]); } }
        const review: ReviewInfo = { marker, endMarker: s.historyLength, steps, diff, state: 'pending', range: isFinite(a) ? [a, b] : undefined };
        append(x => [...x, { role: 'review', text: '', review }]);
      }
      const bits = [e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : '', e.costUsd ? `$${e.costUsd.toFixed(3)}` : '', e.usage ? `${fmtTok(e.usage.input)} in · ${fmtTok(e.usage.output)} out` : ''].filter(Boolean);
      if (bits.length) append(x => [...x, { role: 'info', text: bits.join(' · ') }]);
      finishers.current.delete(chatId);
      setTurn(null);
    };

    const chatId = agentClient.chat({ provider, message, sessionId: session.current[provider], model: provider === 'claude' && model ? model : undefined, mode: m }, (e: ChatEvent) => {
      switch (e.kind) {
        case 'session': session.current[provider] = e.sessionId; break;
        case 'text_delta':
          activity('Writing…');
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
        case 'thinking': activity('Thinking…'); break;
        case 'tool_use':
          assistantIdx = -1;
          activity(toolLabel(e.name, e.input, layerName) + '…');
          append(m => [...m, { role: 'tool', text: '', tool: { id: e.id, name: e.name, input: e.input, startedAt: Date.now() } }]);
          break;
        case 'tool_result':
          activity('Thinking…');
          append(m => m.map(x => (x.tool?.id === e.id ? { ...x, tool: { ...x.tool!, result: e.summary, isError: e.isError, ms: x.tool!.startedAt ? Date.now() - x.tool!.startedAt : undefined } } : x)));
          break;
        case 'error':
          if (e.errorKind === 'cancelled') append(m => [...m, { role: 'info', text: 'Stopped.' }]);
          else append(m => [...m, { role: 'error', text: e.message, errorKind: e.errorKind, hint: e.hint, retry: text, mode: m0 }]);
          break;
        case 'done': finish(e); break;
      }
    });
    setTurn({ chatId, startedAt: Date.now(), activity: m === 'ask' ? 'Looking…' : 'Starting…', stopping: false, live: 0, snap, marker });
    // safety net: if the bridge never confirms a cancel, finish locally
    finishers.current.set(chatId, () => finish({ kind: 'done' }));
  };

  const stop = () => {
    const t = turnRef.current;
    if (!t || t.stopping) return;
    agentClient.cancel(t.chatId);
    setTurn({ ...t, stopping: true, activity: 'Stopping…' });
    setTimeout(() => { if (turnRef.current?.chatId === t.chatId) finishers.current.get(t.chatId)?.(); finishers.current.delete(t.chatId); }, 6000);
  };

  const runQuick = (a: QuickAction) => send(a.prompt(targetPhrase(editor.store)), { mode: a.mode, chip: a.label });

  const setReview = (i: number, state: ReviewInfo['state'], note?: string) => setMsgs(all => all.map((x, j) => (j === i && x.review ? { ...x, review: { ...x.review, state }, text: note ?? x.text } : x)));

  const providers = agentClient.providers;
  const status = agentClient.status;
  const avail = providers.find(p => p.id === provider)?.available;
  const s = editor.store;
  const selCount = s.selection.length;
  const ready = status === 'connected' && !turn;
  const mentioned = resolveMentions(s, input, mentions).filter(l => !s.selection.includes(l.id));

  // render: consecutive tool steps collapse into one group
  const blocks: ({ kind: 'msg'; m: Msg; i: number } | { kind: 'tools'; items: { m: Msg; i: number }[] })[] = [];
  msgs.forEach((m, i) => {
    const last = blocks[blocks.length - 1];
    if (m.role === 'tool') { if (last?.kind === 'tools') last.items.push({ m, i }); else blocks.push({ kind: 'tools', items: [{ m, i }] }); }
    else blocks.push({ kind: 'msg', m, i });
  });

  return (
    <div class="agent ag-panel">
      <div class="agent-head">
        <span class={'dot ' + status} title={`bridge: ${status}${status === 'connected' ? ` · port ${agentClient.port}` : ''}`} />
        <select value={provider} title="Agent" onChange={e => { const v = (e.target as HTMLSelectElement).value; setProvider(v); setPref('provider', v); }}>
          {(providers.length ? providers : [{ id: 'claude', name: 'Claude Code', available: false }]).map(p => (
            <option value={p.id}>{p.name}{p.available ? '' : ' (not found)'}</option>
          ))}
        </select>
        {provider === 'claude' && (
          <select class="model-select" title="Model (uses your Claude subscription)" value={model} onChange={e => { const v = (e.target as HTMLSelectElement).value; setModel(v); setPref('model', v); }}>
            <option value="">default</option><option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option>
          </select>
        )}
        <button class="ghost" title="New conversation" disabled={!!turn} onClick={() => { session.current = {}; setMsgs([]); variations.clear(); }}>＋</button>
      </div>
      <div class="agent-list" ref={list} onScroll={e => { const el = e.currentTarget as HTMLDivElement; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {status !== 'connected' && (
          <div class="agent-note">
            <b>Agent bridge offline.</b> The desktop app starts it automatically. In the browser run <code>npm run bridge</code>.
            The bridge uses the Claude Code / Codex / Gemini CLI on your computer, so your own subscription is used.
          </div>
        )}
        {status === 'connected' && providers.length > 0 && !avail && (
          <div class="agent-note">
            The <b>{providers.find(p => p.id === provider)?.name ?? provider}</b> CLI was not found. Install it and log in (e.g. <code>npm i -g @anthropic-ai/claude-code</code> then <code>claude</code>).
            <div><button class="ag-btn" onClick={() => agentClient.refreshProviders()}>Check again</button></div>
          </div>
        )}
        {msgs.length === 0 && status === 'connected' && <ConnectInfo port={agentClient.port} />}
        {msgs.length === 0 && status === 'connected' && (
          <div class="agent-empty">
            <div>Direct the agent: describe an animation, or select layers and use the quick actions below. Type <code>@</code> to mention a layer.</div>
            {['Make a logo reveal with 3 shapes popping in', 'Add a bouncy entrance to the selected layers', 'Critique my animation'].map(t => (
              <button class="suggest" onClick={() => setInput(t)}>{t}</button>
            ))}
          </div>
        )}
        {blocks.map(b => b.kind === 'tools' ? (
          <ToolGroup items={b.items.map(x => x.m)} running={!!turn && b.items[b.items.length - 1].i === lastToolIndex(msgs)} layerName={layerName} />
        ) : (() => {
          const { m, i } = b;
          if (m.role === 'review') return <TurnReview review={m.review!} onState={(st, note) => setReview(i, st, note)} />;
          if (m.role === 'error') return (
            <div class={'msg error ag-error ' + (m.errorKind ?? '')}>
              <div><b>{ERROR_TITLE[m.errorKind ?? ''] ?? 'Something went wrong'}</b></div>
              {m.hint && <div class="ag-hint"><Markdown text={m.hint} /></div>}
              <details><summary class="ag-muted">details</summary><div class="ag-small">{m.text}</div></details>
              <div class="ag-row">
                {m.retry && <button class="ag-btn" disabled={!ready} onClick={() => send(m.retry!, { mode: m.mode })}>Retry</button>}
                {m.errorKind === 'not_installed' && <button class="ag-btn" onClick={() => agentClient.refreshProviders()}>Check again</button>}
                {m.errorKind === 'auth' && <button class="ag-btn" title="Start a fresh agent session (after logging in)" onClick={() => { session.current[provider] = undefined; }}>Reset session</button>}
              </div>
            </div>
          );
          if (m.role === 'user') return (
            <div class={'msg user' + (m.mode === 'ask' ? ' ask' : '')}>
              {m.mode === 'ask' && <span class="ag-tag">Ask</span>}
              {m.chip ? <span title={m.text}><b>{m.chip}</b></span> : m.text}
            </div>
          );
          return <div class={'msg ' + m.role}>{m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}</div>;
        })())}
        {turn && (
          <div class="ag-working" data-testid="agent-working">
            <span class="ag-spinner" />
            <span class="ag-grow">{turn.activity}{turn.live > 0 && <span class="ag-muted"> · {turn.live} layer{turn.live === 1 ? '' : 's'} changed</span>}</span>
            <span class="ag-muted">{Math.floor((Date.now() - turn.startedAt) / 1000)}s</span>
          </div>
        )}
      </div>
      <VariationTray />
      <div class="ag-composer">
        <div class="ag-context" title={editorContext(s, mentioned)}>
          <span class="ag-muted">Context:</span>
          {selCount ? <span class="ag-chip">{selCount === 1 ? s.layer(s.selection[0])?.name : `${selCount} selected`}</span> : <span class="ag-muted">no selection</span>}
          {mentioned.map(l => <span class="ag-chip mention">@{l.name}</span>)}
          <span class="ag-muted">· {s.time.toFixed(2)}s</span>
          {(s.comp.markers?.length ?? 0) > 0 && <span class="ag-muted">· {s.comp.markers!.length} markers</span>}
        </div>
        <div class="ag-quick" role="toolbar" aria-label="Quick actions">
          {availableActions(selCount).map(a => (
            <button class={'ag-qchip' + (a.mode === 'ask' ? ' ask' : '')} disabled={!ready} title={`${a.title}${a.mode === 'ask' ? ' — read-only' : ''}\n→ ${selCount ? targetPhrase(s) : 'whole animation'}`} onClick={() => runQuick(a)}>{a.label}</button>
          ))}
        </div>
        <div class="agent-input">
          <MentionInput
            value={input}
            onInput={setInput}
            onSubmit={() => send(input)}
            onEscape={stop}
            onMention={m => setMentions(x => [...x.filter(y => y.id !== m.id), m])}
            placeholder={status !== 'connected' ? 'Bridge offline' : mode === 'ask' ? 'Ask about your animation (read-only)…' : selCount ? 'What should happen to the selection? (@ to mention)' : 'Describe an animation… (@ to mention a layer)'}
          />
          <div class="ag-send-col">
            <div class="ag-mode" role="radiogroup" aria-label="Mode">
              <button role="radio" aria-checked={mode === 'edit'} class={mode === 'edit' ? 'on' : ''} title="The agent edits your document" onClick={() => { setMode('edit'); setPref('mode', 'edit'); }}>Edit</button>
              <button role="radio" aria-checked={mode === 'ask'} class={mode === 'ask' ? 'on' : ''} title="Read-only: critique / explain, no edits" onClick={() => { setMode('ask'); setPref('mode', 'ask'); }}>Ask</button>
            </div>
            {turn
              ? <button class="ag-btn danger" title="Stop (Esc)" disabled={turn.stopping} onClick={stop}>{turn.stopping ? '…' : 'Stop'}</button>
              : <button class="primary" disabled={!input.trim() || status !== 'connected'} onClick={() => send(input)}>Send</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

const ERROR_TITLE: Record<string, string> = {
  not_installed: 'Agent CLI not found',
  auth: 'Not logged in (or the login expired)',
  rate_limit: 'Usage limit reached',
  overloaded: 'The model is busy',
  network: 'Network problem',
  timeout: 'The agent stopped responding',
  bridge: 'Bridge disconnected',
};

function fmtTok(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n); }

function lastToolIndex(msgs: Msg[]) { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'tool') return i; return -1; }

/** a run of tool steps: human labels, status, duration; screenshots inline */
function ToolGroup(props: { items: Msg[]; running: boolean; layerName: (id: string) => string | undefined }) {
  const { items, running } = props;
  const errors = items.filter(m => m.tool?.isError).length;
  const steps = items.map(m => {
    const t = m.tool!;
    const state = t.result === undefined ? 'run' : t.isError ? 'err' : 'ok';
    return (
      <details class={'ag-step ' + state}>
        <summary>
          <span class="ag-step-icon">{state === 'run' ? '◌' : state === 'err' ? '✕' : '✓'}</span>
          <span class="ag-grow">{toolLabel(t.name, t.input, props.layerName)}</span>
          {t.ms !== undefined && t.ms > 300 && <span class="ag-muted">{(t.ms / 1000).toFixed(1)}s</span>}
        </summary>
        <div class="ag-step-body">
          <div class="ag-muted">{t.name.replace(/^mcp__motion__/, '')}</div>
          <pre>{JSON.stringify(t.input, null, 1)}</pre>
          {t.result && <pre class={t.isError ? 'ag-err-text' : ''}>{t.result}</pre>}
        </div>
      </details>
    );
  });
  const images = items.map(m => m.tool?.image).filter(Boolean) as string[];
  return (
    <div class="ag-steps">
      {items.length > 3 && !running ? (
        <details class="ag-steps-group">
          <summary>{items.length} steps{errors ? <span class="ag-err-text"> · {errors} failed</span> : ''}</summary>
          {steps}
        </details>
      ) : steps}
      {images.length > 0 && <div class="ag-shots">{images.slice(-2).map(src => <img src={src} alt="What the agent looked at" title="What the agent looked at" />)}</div>}
    </div>
  );
}

/** tiny markdown renderer: **bold**, `code`, - bullets, 1. lists. builds vnodes (never innerHTML) */
function Markdown({ text }: { text: string }) {
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map(part =>
    part.startsWith('**') && part.endsWith('**') ? <b>{part.slice(2, -2)}</b> : part.startsWith('`') && part.endsWith('`') ? <code>{part.slice(1, -1)}</code> : part);
  return <>{text.split('\n').map(line => {
    const b = line.match(/^\s*[-*]\s+(.*)/);
    if (b) return <div class="md-li">• {inline(b[1])}</div>;
    const n = line.match(/^\s*(\d+)[.)]\s+(.*)/);
    if (n) return <div class="md-li">{n[1]}. {inline(n[2])}</div>;
    const h = line.match(/^#+\s+(.*)/);
    if (h) return <div><b>{inline(h[1])}</b></div>;
    return line.trim() ? <div>{inline(line)}</div> : <div class="md-gap" />;
  })}</>;
}

/** how to connect any other MCP-capable AI app (Claude Desktop, Cursor, VS Code, ...) */
function ConnectInfo({ port }: { port: number }) {
  const url = `http://127.0.0.1:${port}/mcp`;
  const json = JSON.stringify({ mcpServers: { motion: { type: 'http', url } } }, null, 2);
  const [copied, setCopied] = useState('');
  const copy = (what: string, text: string) => { navigator.clipboard?.writeText(text).then(() => { setCopied(what); setTimeout(() => setCopied(''), 1500); }); };
  return (
    <details class="connect-info">
      <summary>Connect other AI apps (MCP)</summary>
      <div class="small muted">While Motion is open, any MCP client can drive this document: Claude Desktop, Cursor, VS Code, Codex or your own agent. Read-only tools are marked with <code>readOnlyHint</code>.</div>
      <div class="row"><code class="grow">{url}</code><button class="ghost" onClick={() => copy('url', url)}>{copied === 'url' ? '✓' : 'Copy'}</button></div>
      <div class="row"><span class="small muted grow">MCP config JSON</span><button class="ghost" onClick={() => copy('json', json)}>{copied === 'json' ? '✓' : 'Copy'}</button></div>
      <div class="small muted">Claude Code: <code>claude mcp add --transport http motion {url}</code></div>
      <div class="small muted">Codex: <code>codex -c mcp_servers.motion.url="{url}"</code></div>
    </details>
  );
}
