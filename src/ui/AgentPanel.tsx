import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
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
import { agentPrefs, setAgentPref, CLAUDE_MODELS, PROVIDER_LABEL, modelLabel } from './agent/agent-prefs';
import { showContextMenu, type MenuItem } from './menu';
import { openSettings } from './chrome/ui-state';
import { useChannels } from './hooks';
import { Button } from './ui';
import { ArrowUp, Check, ChevronDown, CircleX, File, LAYER_ICON, Layers, LoaderCircle, Plus, Sparkle, Square, SquarePen, X } from './chrome/icons';
import type { ComponentChildren } from 'preact';
import './agent/agent.css';
import { setAgentProgress, takeAsk } from './agent-bridge';

interface Turn { chatId: string; startedAt: number; activity: string; stopping: boolean; live: number; snap: DocSnapshot; startId: number }

/**
 * the left panel's agent: the conversation (when `chat`) or another tab's content (`children`)
 * above the composer, which is always there. state (messages, the running turn) lives here so
 * switching tabs never drops a conversation.
 */
export function AgentPanel(props: { chat: boolean; children?: ComponentChildren; onSent?: () => void }) {
  useChannels([], ['agent-prefs']);
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
  const { mode, provider, model } = agentPrefs;
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [, tick] = useState(0);
  /** local finish per running chat. drop = the turn was detached (another project was opened):
   *  no review card, nothing appended to the (now different) conversation */
  const finishers = useRef(new Map<string, (drop?: boolean) => void>());

  useEffect(() => agentClient.on(() => force(x => x + 1)), []);
  useEffect(() => editor.store.on('history', () => force(x => x + 1)), []);
  useEffect(() => editor.store.on('selection', () => force(x => x + 1)), []);
  useEffect(() => installVariationThumbs(), []);
  // keep scrolled to the bottom unless the user scrolled up to read
  useEffect(() => { if (stick.current) list.current?.scrollTo({ top: 1e9 }); }, [msgs, turn]);
  // elapsed timer while a turn runs
  useEffect(() => { if (!turn) return; const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, [!!turn]);

  // per-project persistence
  useEffect(() => { const k = key.current; const t = setTimeout(() => { if (k === key.current) saveChat(k, msgs, session.current); }, 400); return () => clearTimeout(t); }, [msgs]);
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;
  // a different project was opened: switch to its conversation. subscribed in a layout effect and
  // re-checked once mounted, because the startup project can load before passive effects run.
  useLayoutEffect(() => {
    const sync = () => {
      // a running turn belongs to the document that was just replaced: stop it and detach it, so
      // its remaining events / review never mix into the newly opened project
      const t = turnRef.current;
      if (t) { agentClient.cancel(t.chatId); finishers.current.get(t.chatId)?.(true); }
      const k = projectKey(editor.store.project);
      // the undo history is gone: review cards of this conversation can no longer revert/compare
      if (k === key.current) { setMsgs(m => m.some(x => x.review?.state === 'pending') ? m.map(x => (x.review?.state === 'pending' ? { ...x, review: { ...x.review, state: 'stale' as const } } : x)) : m); return; }
      saveChat(key.current, msgsRef.current, session.current);
      key.current = k;
      const c = loadChat(k);
      session.current = c?.sessions ?? {};
      variations.clear();
      setMsgs(c?.msgs ?? []);
    };
    sync();
    return editor.on('loaded', sync);
  }, []);

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
    const marker = s.historyLength; // only for the step count shown on the card
    const startId = s.topEntryId; // identifies the exact pre-turn state (revert / compare)
    const startKey = key.current;
    let assistantIdx = -1;
    let finished = false;
    const append = (fn: (m: Msg[]) => Msg[]) => setMsgs(fn);
    const activity = (a: string) => setTurn(t => (t && t.chatId === chatId ? { ...t, activity: a } : t));

    const finish = (e: ChatEvent, drop = false) => {
      if (finished) return;
      finished = true;
      agentClient.forget(chatId); // lifts the Ask-mode lock even when the bridge never sends 'done'
      finishers.current.delete(chatId);
      setTurn(t => (t && t.chatId === chatId ? null : t));
      if (drop || key.current !== startKey) return;
      const steps = Math.max(1, s.historyLength - marker);
      const diff = diffDocs(snap, snapshotDoc(s.project));
      if (s.topEntryId !== startId && !diffIsEmpty(diff)) {
        let a = Infinity, b = -Infinity;
        for (const c of [...diff.added, ...diff.changed]) { const l = s.layer(c.id); const r = l && animRange(l); if (r) { a = Math.min(a, r[0]); b = Math.max(b, r[1]); } }
        const review: ReviewInfo = { startId, endId: s.topEntryId, steps, diff, state: 'pending', range: isFinite(a) ? [a, b] : undefined };
        append(x => [...x, { role: 'review', text: '', review }]);
      }
      const bits = [e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : '', e.costUsd ? `$${e.costUsd.toFixed(3)}` : '', e.usage ? `${fmtTok(e.usage.input)} in · ${fmtTok(e.usage.output)} out` : ''].filter(Boolean);
      if (bits.length) append(x => [...x, { role: 'info', text: bits.join(' · ') }]);
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
    setTurn({ chatId, startedAt: Date.now(), activity: m === 'ask' ? 'Looking…' : 'Starting…', stopping: false, live: 0, snap, startId });
    // safety net: if the bridge never confirms a cancel, finish locally
    if (!finished) finishers.current.set(chatId, (drop?: boolean) => finish({ kind: 'done' }, drop));
  };

  const stop = () => {
    const t = turnRef.current;
    if (!t || t.stopping) return;
    agentClient.cancel(t.chatId);
    setTurn({ ...t, stopping: true, activity: 'Stopping…' });
    setTimeout(() => { if (turnRef.current?.chatId === t.chatId) finishers.current.get(t.chatId)?.(); finishers.current.delete(t.chatId); }, 6000);
  };

  const runQuick = (a: QuickAction) => send(a.prompt(targetPhrase(editor.store)), { mode: a.mode, chip: a.label });

  // asks from elsewhere (Home prompt, ⌘K, context menus, import suggestions: ./agent-bridge.ts).
  // offline or busy: the text lands in the composer instead of getting lost
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => editor.on('agent-ask', () => {
    const a = takeAsk();
    if (!a) return;
    const text = a.context ? `${a.text}

(This refers to ${a.context}.)` : a.text;
    if (agentClient.status === 'connected' && !turnRef.current) sendRef.current(text, { mode: a.mode, chip: a.chip });
    else setInput(a.text);
  }), []);
  useEffect(() => { setAgentProgress(turn ? { activity: turn.activity, live: turn.live, startedAt: turn.startedAt } : null); }, [turn?.activity, turn?.live, !!turn]);

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

  const newChat = () => { session.current = {}; setMsgs([]); variations.clear(); };
  const pickModel = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const list = providers.length ? providers : [{ id: 'claude', name: 'Claude Code', available: false }];
    const items: MenuItem[] = [];
    for (const p of list) {
      if (p.id === 'claude') {
        for (const m of CLAUDE_MODELS) items.push({ label: m.id ? m.label : 'Claude (default model)', hint: p.available ? m.hint : 'not installed', checked: provider === 'claude' && model === m.id, action: () => { setAgentPref('provider', 'claude'); setAgentPref('model', m.id); } });
        items.push({ separator: true });
      } else items.push({ label: PROVIDER_LABEL[p.id] ?? p.name, hint: p.available ? 'CLI' : 'not installed', checked: provider === p.id, action: () => setAgentPref('provider', p.id) });
    }
    items.push({ separator: true }, { label: 'Model settings…', action: () => openSettings('models') });
    showContextMenu(r.left, r.top - 8, items);
    // open upward: the composer sits at the bottom of the window
    const m = document.querySelector('.ctx-menu') as HTMLElement | null;
    if (m) m.style.top = Math.max(4, r.top - m.offsetHeight - 6) + 'px';
  };
  const attach = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showContextMenu(r.left, r.top, [
      { label: 'Mention a layer (@)', action: () => { setInput(input + (input && !input.endsWith(' ') ? ' @' : '@')); requestAnimationFrame(() => (document.querySelector('.agent-input textarea') as HTMLTextAreaElement | null)?.focus()); } },
      { label: 'Quick actions', submenu: availableActions(selCount).map(a => ({ label: a.label, disabled: !ready, action: () => { props.onSent?.(); runQuick(a); } })) },
      { separator: true },
      { label: 'New conversation', disabled: !!turn, action: newChat },
    ]);
    const m = document.querySelector('.ctx-menu') as HTMLElement | null;
    if (m) m.style.top = Math.max(4, r.top - m.offsetHeight - 6) + 'px';
  };
  const selLayer = selCount === 1 ? s.layer(s.selection[0]) : null;
  const chipLabel = selCount ? (selLayer?.name ?? `${selCount} layers`) : s.comp.name;
  const ChipIcon = selLayer ? LAYER_ICON[selLayer.type] : selCount ? Layers : File;
  const placeholder = status !== 'connected' ? 'Agent offline: start the bridge to chat'
    : mode === 'ask' ? (selCount ? 'Ask about the selection…' : 'Ask about this composition…')
    : selCount ? 'What should happen to the selection?' : 'Describe an animation…';
  const submit = () => { if (input.trim()) { props.onSent?.(); send(input); } };

  return (
    <div class="agent ag-panel">
      {props.chat ? (
        <div class="agent-chat">
          <div class="agent-head">
            <span class="agent-title">Agent</span>
            <span class={'dot ' + status} title={`Bridge: ${status}${status === 'connected' ? ` · port ${agentClient.port}` : ''}`} />
            <span class="grow" />
            <Button variant="ghost" icon size="sm" tip="New conversation" disabled={!!turn} onClick={newChat}><SquarePen /></Button>
          </div>
          <div class="agent-list" ref={list} onScroll={e => { const el = e.currentTarget as HTMLDivElement; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
            {status !== 'connected' && (
              <div class="agent-note agent-offline" title="The desktop app starts the bridge automatically; in the browser run npm run bridge. It uses the Claude Code / Codex / Gemini CLI on your computer (your own subscription).">
                <span class="dot" aria-hidden="true" />Agent offline · <button class="link" onClick={() => openSettings('connections')}>How to connect</button>
              </div>
            )}
            {status === 'connected' && providers.length > 0 && !avail && (
              <div class="agent-note">
                The <b>{providers.find(p => p.id === provider)?.name ?? provider}</b> CLI was not found. Install it and log in (e.g. <code>npm i -g @anthropic-ai/claude-code</code> then <code>claude</code>).
                <div><button class="ag-btn" onClick={() => agentClient.refreshProviders()}>Check again</button></div>
              </div>
            )}
            {msgs.length === 0 && status === 'connected' && (
              <div class="agent-empty">
                <div>Direct the agent: describe an animation, or select layers and use the quick actions below. Type <code>@</code> to mention a layer.</div>
                {['Make a logo reveal with 3 shapes popping in', 'Add a bouncy entrance to the selected layers', 'Critique my animation'].map(t => (
                  <button class="suggest" onClick={() => setInput(t)}>{t}</button>
                ))}
                <button class="link" onClick={() => openSettings('connections')}>Connect other AI apps (MCP)…</button>
              </div>
            )}
            {blocks.map(b => b.kind === 'tools' ? (
              <ToolGroup items={b.items.map(x => x.m)} running={!!turn && b.items[b.items.length - 1].i === lastToolIndex(msgs)} layerName={layerName} />
            ) : (() => {
              const { m, i } = b;
              if (m.role === 'review') return <TurnReview review={m.review!} busy={!!turn} onState={(st, note) => setReview(i, st, note)} />;
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
          <div class="ag-quick" role="toolbar" aria-label="Quick actions">
            {availableActions(selCount).map(a => (
              <button class={'ag-qchip' + (a.mode === 'ask' ? ' ask' : '')} disabled={!ready} title={`${a.title}${a.mode === 'ask' ? ' (read-only)' : ''}\nfor: ${selCount ? targetPhrase(s) : 'the whole animation'}`} onClick={() => runQuick(a)}>{a.label}</button>
            ))}
          </div>
        </div>
      ) : <div class="left-content">{props.children}</div>}
      <div class="ag-composer composer">
        <div class="ag-context" onPointerEnter={e => { (e.currentTarget as HTMLElement).title = editorContext(s, mentioned); }}>
          <span class="ctx-chip" title={selCount ? 'The selection is sent as context' : 'The composition is sent as context'}>
            <ChipIcon size={12} />
            <span class="ctx-chip-name">{chipLabel}</span>
            {selCount > 0 && <button type="button" class="ctx-chip-x" aria-label="Clear selection" onClick={() => s.select([])}><X size={12} /></button>}
          </span>
          {mentioned.map(l => <span class="ag-chip mention">@{l.name}</span>)}
        </div>
        <div class="agent-input">
          <MentionInput
            value={input}
            onInput={setInput}
            onSubmit={submit}
            onEscape={stop}
            onMention={m => setMentions(x => [...x.filter(y => y.id !== m.id), m])}
            placeholder={placeholder}
          />
          <div class="composer-foot">
            <Button variant="ghost" icon size="sm" tip="Add context" tipSide="top" onClick={attach as any} aria-haspopup="menu"><Plus /></Button>
            <button type="button" class="model-pick" aria-haspopup="menu" title="Agent and model" onClick={pickModel as any}>
              <Sparkle size={14} /><span>{modelLabel(provider, model)}</span><ChevronDown size={12} />
            </button>
            <div class="ag-mode" role="radiogroup" aria-label="Mode">
              <button role="radio" aria-checked={mode === 'edit'} class={mode === 'edit' ? 'on' : ''} title="The agent edits your document" onClick={() => setAgentPref('mode', 'edit')}>Edit</button>
              <button role="radio" aria-checked={mode === 'ask'} class={mode === 'ask' ? 'on' : ''} title="Read-only: critique / explain, no edits" onClick={() => setAgentPref('mode', 'ask')}>Ask</button>
            </div>
            <span class="grow" />
            {turn
              ? <button class="send-btn stop" title="Stop (Esc)" aria-label="Stop" disabled={turn.stopping} onClick={stop}><Square size={12} /></button>
              : <button class="primary send-btn" aria-label="Send" title="Send (Enter)" disabled={!input.trim() || status !== 'connected'} onClick={submit}><ArrowUp /></button>}
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
          <span class="ag-step-icon">{state === 'run' ? <LoaderCircle size={12} /> : state === 'err' ? <CircleX size={12} /> : <Check size={12} />}</span>
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
