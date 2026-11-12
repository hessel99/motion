import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { agentClient, type ChatEvent, type ChatMode } from '../agent/client';
import { editor } from '../app/editor';
import { composeMessage, editorContext, resolveMentions } from '../agent/context';
import { diffDocs, diffIsEmpty, snapshotDoc, type DocSnapshot } from '../agent/diff';
import { loadChat, projectKey, saveChat, type Msg, type ReviewInfo } from '../agent/history';
import { toolLabel } from '../agent/labels';
import { briefScope } from '../agent/quick';
import { approvalMessage, storyboards, type Storyboard } from '../agent/storyboard';
import { TOOLS } from '../agent/tools';
import { animRange } from '../agent/describe';
import { variations } from '../agent/variations';
import { MentionInput, mentionToken, type Mention } from './agent/MentionInput';
import { TurnReview } from './agent/TurnReview';
import { VariationTray, installVariationThumbs } from './agent/VariationTray';
import { StoryboardCard } from './agent/StoryboardCard';
import { styleLabel, stylePrefix } from './agent/StylePicker';
import { STYLE_GUIDES } from '../agent/guides';
import { agentPrefs, setAgentPref, CLAUDE_MODELS, PROVIDER_LABEL, modelLabel, resolveModel, turnBudget } from './agent/agent-prefs';
import { showContextMenu, type MenuItem } from './menu';
import { openSettings } from './chrome/ui-state';
import { useChannels } from './hooks';
import { Button } from './ui';
import { ArrowDown, ArrowUp, Check, ChevronRight, MousePointerClick, CircleX, LAYER_ICON, Layers, LoaderCircle, Palette, Plus, Square, SquarePen, X } from './chrome/icons';
import { lastImport, openBrowserFile } from '../app/actions';
import type { ComponentChildren } from 'preact';
import './agent/agent.css';
import { setAgentProgress, setChatStarted, takeAsk } from './agent-bridge';

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
  /** style picked in the style row: prefixes the next brief */
  const [style, setStyle] = useState('');
  const [dropping, setDropping] = useState(false);
  /** the thread is scrolled up (reading): a "Jump to latest" pill shows */
  const [scrolledUp, setScrolledUp] = useState(false);
  /** pick mode: the next layer clicked on the canvas becomes an @mention */
  const [picking, setPicking] = useState(false);
  const [turn, setTurn] = useState<Turn | null>(null);
  const turnRef = useRef<Turn | null>(null);
  turnRef.current = turn;
  // one mode: the agent works in the document (read-only "Ask" was dropped: a question is just a message)
  const mode: ChatMode = 'edit';
  const { provider, model } = agentPrefs;
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
  // a drafted message from elsewhere (e.g. "Ask the agent" on the audio sync card)
  useEffect(() => editor.on('agent-draft', () => { const t = (editor as any).agentDraft; if (t) { (editor as any).agentDraft = ''; setInput(t); } }), []);
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

  // the storyboard card: proposed by the agent (propose_storyboard), progress per beat (update_progress)
  useEffect(() => storyboards.on(sb => setMsgs(m => {
    const i = m.findIndex(x => x.storyboard?.id === sb.id);
    if (i >= 0) { const c = m.slice(); c[i] = { ...m[i], storyboard: sb }; return c; }
    return turnRef.current ? [...m, { role: 'storyboard', text: '', storyboard: sb }] : m;
  })), []);

  const layerName = (id: string) => editor.store.layer(id)?.name;

  const send = (text: string, opts: { mode?: ChatMode; chip?: string; style?: string } = {}) => {
    text = text.trim();
    if (!text || turnRef.current || agentClient.status !== 'connected') return;
    const s = editor.store;
    const m: ChatMode = 'edit';
    const m0 = m;
    const st = opts.style ?? '';
    const pre = st ? stylePrefix(st) : '';
    // the style line goes in the message (never the system prompt: that is the cached prefix)
    const message = composeMessage(s, pre ? `${pre}\n${text}` : text, mentions);
    const scope = briefScope(text, { chip: opts.chip, selCount: s.selection.length, style: !!st });
    setInput('');
    setMentions([]);
    if (st) setStyle('');
    stick.current = true;
    setMsgs(x => [...x, { role: 'user', text, mode: m, chip: opts.chip, ...(st ? { style: st } : {}) }]);
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
        // the preview's box is reserved right away, so its arrival doesn't shift / scroll the card
        append(x => [...x, { role: 'review', text: '', review, ...(editor.renderer ? { preview: 'pending' } : {}) }]);
        // inline preview of the result: one contact sheet over what the turn animated
        resultPreview(review.range).then(src => append(x => x.map(y => (y.review?.endId === review.endId && y.role === 'review' ? { ...y, preview: src } : y))));
      }
      const bits = [e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : '', e.costUsd ? `$${e.costUsd.toFixed(3)}` : '', e.usage ? `${fmtTok(e.usage.input)} in · ${fmtTok(e.usage.output)} out` : ''].filter(Boolean);
      // run stats (time, cost, tokens) are developer detail: the console, not the thread
      if (bits.length) console.info('[agent turn]', bits.join(' · '));
    };

    const chatId = agentClient.chat({ provider, message, sessionId: session.current[provider], model: provider === 'claude' ? resolveModel(scope, model) : undefined, mode: m, maxTurns: turnBudget() }, (e: ChatEvent) => {
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
    setTurn({ chatId, startedAt: Date.now(), activity: 'Starting…', stopping: false, live: 0, snap, startId });
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

  const approveStoryboard = (sb: Storyboard) => send(approvalMessage(storyboards.approve(sb)), { mode: 'edit', chip: sb.edited ? 'Approved storyboard (edited)' : 'Approved storyboard' });
  /** the storyboard being built right now (for the working indicator) */
  const building = turn ? [...msgs].reverse().find(x => x.storyboard)?.storyboard : undefined;
  const activeBeat = building?.state === 'building' ? building.beats.findIndex(b => b.status === 'active') : -1;

  // asks from elsewhere (Home prompt, ⌘K, context menus, import suggestions: ./agent-bridge.ts).
  // offline or busy: the text lands in the composer instead of getting lost
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => editor.on('agent-ask', () => {
    const a = takeAsk();
    if (!a) return;
    const text = a.context ? `${a.text}

(This refers to ${a.context}.)` : a.text;
    if (agentClient.status === 'connected' && !turnRef.current) sendRef.current(text, { chip: a.chip });
    else setInput(a.text);
  }), []);
  useEffect(() => setChatStarted(msgs.length > 0), [msgs.length > 0]);
  const beatRange: [number, number] | undefined = activeBeat >= 0 ? [building!.beats[activeBeat].start, building!.beats[activeBeat].end] : undefined;
  useEffect(() => {
    setAgentProgress(turn ? { activity: activeBeat >= 0 ? `${building!.beats[activeBeat].name} · ${turn.activity}` : turn.activity, live: turn.live, startedAt: turn.startedAt, range: beatRange } : null);
  }, [turn?.activity, turn?.live, !!turn, activeBeat, beatRange?.[0], beatRange?.[1]]);
  // pick from canvas: the next selected layer is mentioned
  useEffect(() => {
    if (!picking) return;
    const off = editor.store.on('selection', () => {
      const id = editor.store.selection[0];
      const l = id ? editor.store.layer(id) : null;
      if (!l) return;
      setMentions(x => [...x.filter(y => y.id !== l.id), { id: l.id, name: l.name }]);
      setInput(v => v + (v && !v.endsWith(' ') ? ' ' : '') + mentionToken(l.name) + ' ');
      setPicking(false);
      requestAnimationFrame(() => (document.querySelector('.agent-input textarea') as HTMLTextAreaElement | null)?.focus());
    });
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPicking(false); };
    window.addEventListener('keydown', esc, true);
    document.documentElement.dataset.picking = '';
    return () => { off(); window.removeEventListener('keydown', esc, true); delete document.documentElement.dataset.picking; };
  }, [picking]);

  const setReview = (i: number, state: ReviewInfo['state'], note?: string) => setMsgs(all => all.map((x, j) => (j === i && x.review ? { ...x, review: { ...x.review, state }, text: note ?? x.text } : x)));

  const providers = agentClient.providers;
  const status = agentClient.status;
  const avail = providers.find(p => p.id === provider)?.available;
  const s = editor.store;
  const selCount = s.selection.length;
  const ready = status === 'connected' && !turn;
  const mentioned = resolveMentions(s, input, mentions).filter(l => !s.selection.includes(l.id));

  /** the review card that closes the turn a message belongs to (-1: none yet) */
  const reviewOf = (i: number) => { for (let j = i + 1; j < msgs.length; j++) { if (msgs[j].role === 'user') return -1; if (msgs[j].role === 'review') return j; } return -1; };
  /** the tool steps of the turn a review card closes */
  const toolsOf = (r: number) => { const out: Msg[] = []; for (let j = r - 1; j >= 0 && msgs[j].role !== 'user'; j--) if (msgs[j].role === 'tool') out.unshift(msgs[j]); return out; };
  // render: consecutive tool steps collapse into one group
  const blocks: ({ kind: 'msg'; m: Msg; i: number } | { kind: 'tools'; items: { m: Msg; i: number }[] })[] = [];
  msgs.forEach((m, i) => {
    const last = blocks[blocks.length - 1];
    if (m.role === 'tool') { if (last?.kind === 'tools') last.items.push({ m, i }); else blocks.push({ kind: 'tools', items: [{ m, i }] }); }
    else blocks.push({ kind: 'msg', m, i });
  });

  const newChat = () => { session.current = {}; setMsgs([]); variations.clear(); };
  const modelItems = (): MenuItem[] => {
    const list = providers.length ? providers : [{ id: 'claude', name: 'Claude Code', available: false }];
    const items: MenuItem[] = [];
    for (const p of list) {
      if (p.id === 'claude') {
        for (const m of CLAUDE_MODELS) items.push({ label: m.id ? m.label : 'Claude (default model)', hint: p.available ? m.hint : 'not installed', checked: provider === 'claude' && model === m.id, action: () => { setAgentPref('provider', 'claude'); setAgentPref('model', m.id); } });
        items.push({ separator: true });
      } else items.push({ label: PROVIDER_LABEL[p.id] ?? p.name, hint: p.available ? 'CLI' : 'not installed', checked: provider === p.id, action: () => setAgentPref('provider', p.id) });
    }
    items.push({ separator: true }, { label: 'Model settings…', action: () => openSettings('models') });
    return items;
  };
  /** "+": bring in a file (it lands in the document, selected, so it is the context), mention a
   *  layer, pick a style recipe, the model */
  const attach = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showContextMenu(r.left, r.top, [
      { label: 'Add an image, SVG or audio…', action: () => pickFiles() },
      { label: 'Mention a layer', shortcut: '@', action: () => { setInput(input + (input && !input.endsWith(' ') ? ' @' : '@')); requestAnimationFrame(() => (document.querySelector('.agent-input textarea') as HTMLTextAreaElement | null)?.focus()); } },
      { label: 'Style', submenu: [{ label: 'Let the agent choose', checked: !style, action: () => setStyle('') }, { separator: true }, ...STYLE_GUIDES.map(g => ({ label: styleLabel(g), hint: g.summary.length > 42 ? g.summary.slice(0, 40) + '…' : g.summary, checked: style === g.name, action: () => setStyle(g.name) }))] },
      { separator: true },
      { label: `Model: ${modelLabel(provider, model)}`, submenu: modelItems() },
    ]);
    // open upward: the composer sits at the bottom of the window
    const m = document.querySelector('.ctx-menu') as HTMLElement | null;
    if (m) m.style.top = Math.max(4, r.top - m.offsetHeight - 6) + 'px';
  };
  /** files pasted / dropped into the composer (or picked from +) come into the document as layers
   *  and get selected: "animate this" then refers to them */
  const takeFiles = async (files: File[]) => {
    for (const f of files) await openBrowserFile(f);
    const imp = lastImport;
    if (imp && imp.ids.every(id => editor.store.layer(id))) editor.store.select(imp.ids);
    requestAnimationFrame(() => (document.querySelector('.agent-input textarea') as HTMLTextAreaElement | null)?.focus());
  };
  const pickFiles = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.accept = '.svg,image/*,audio/*';
    inp.onchange = () => takeFiles([...(inp.files ?? [])]);
    inp.click();
  };
  const selLayer = selCount === 1 ? s.layer(s.selection[0]) : null;
  const chipLabel = selLayer?.name ?? `${selCount} layers`;
  const ChipIcon = selLayer ? LAYER_ICON[selLayer.type] : Layers;
  const styleGuide = style ? STYLE_GUIDES.find(g => g.name === style) : undefined;
  const placeholder = status !== 'connected' ? 'The agent is offline'
    : turn ? 'The agent is working… (Esc stops it)'
    : selCount ? 'What should happen to the selection?' : msgs.length ? 'Reply or ask for a change…' : 'Describe an animation…';
  const submit = () => { if (input.trim()) { props.onSent?.(); send(input, { style }); } };

  return (
    <div class="agent ag-panel">
      {props.chat ? (
        <div class="agent-chat">
          <div class="agent-head">
            <h2 class="lp-title">Agent</h2>
            <span class="grow" />
            <span class={'dot ' + status} title={`Agent ${status === 'connected' ? `connected · ${modelLabel(provider, model)}` : status}`} />
            <Button variant="ghost" icon size="sm" tip="New conversation" disabled={!!turn || !msgs.length} onClick={newChat}><SquarePen /></Button>
          </div>
          <div class="agent-list" ref={list} onScroll={e => { const el = e.currentTarget as HTMLDivElement; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; if (stick.current && scrolledUp) setScrolledUp(false); }}
            onWheel={e => { const el = e.currentTarget as HTMLDivElement; requestAnimationFrame(() => { const up = el.scrollHeight - el.scrollTop - el.clientHeight >= 40; if (up !== scrolledUp) setScrolledUp(up); }); }}>
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
                <div class="agent-empty-line">Describe the animation you want. The agent builds it in this file; every turn can be reviewed and undone.</div>
                {['A logo reveal: the mark draws in, the name follows with a soft overshoot', 'Kinetic type for “Make it move”, word by word, on a 120 bpm beat', 'Animate the selected layers in with a staggered, springy entrance'].map(t => (
                  <button class="suggest" onClick={() => setInput(t)}>{t}<ChevronRight size={14} /></button>
                ))}
              </div>
            )}
            {blocks.map(b => b.kind === 'tools' ? (
              // a finished turn with a review card: its steps live inside the card (one row per turn)
              reviewOf(b.items[b.items.length - 1].i) >= 0 ? null :
              <ToolGroup items={b.items.map(x => x.m)} running={!!turn && b.items[b.items.length - 1].i === lastToolIndex(msgs)} layerName={layerName} />
            ) : (() => {
              const { m, i } = b;
              if (m.role === 'storyboard' && m.storyboard) return <StoryboardCard sb={m.storyboard} busy={!ready} onApprove={approveStoryboard} />;
              if (m.role === 'review') return (
                <>
                  <TurnReview review={m.review!} busy={!!turn} onState={(st, note) => setReview(i, st, note)}>
                    {toolsOf(i).length > 0 && <ToolGroup items={toolsOf(i)} running={false} shots={false} layerName={layerName} />}
                  </TurnReview>
                  {/* below the card: arriving late, it must not shift the card's buttons */}
                  {m.preview === 'pending' && <div class="ag-result pending" style={{ aspectRatio: previewAspect() }} />}
                  {m.preview && m.preview !== 'pending' && <button type="button" class="ag-result" title="Replay the result" onClick={() => { const r = m.review!.range; s.setTime(Math.max(0, (r?.[0] ?? 0) - 0.1)); editor.play(); }}><img src={m.preview} alt="Result: frames over time" data-testid="result-preview" onLoad={() => { if (stick.current) list.current?.scrollTo({ top: 1e9 }); }} /></button>}
                </>
              );
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
                <div class="msg user">
                  {m.style && <span class="ag-tag">{styleLabel(STYLE_GUIDES.find(g => g.name === m.style) ?? { title: m.style } as any)}</span>}
                  {m.chip ? <span title={m.text}><b>{m.chip}</b></span> : m.text}
                </div>
              );
              return <div class={'msg ' + m.role}>{m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}</div>;
            })())}
            {turn && (
              <div class="ag-working ag-status" data-testid="agent-working">
                <span class="ag-spinner" />
                <span>{activeBeat >= 0 ? <>Beat {activeBeat + 1}/{building!.beats.length} · <b>{building!.beats[activeBeat].name}</b> · </> : null}{turn.activity}{turn.live > 0 && <span class="ag-muted"> · {turn.live} layer{turn.live === 1 ? '' : 's'} changed</span>}</span>
                <span class="ag-muted">{Math.floor((Date.now() - turn.startedAt) / 1000)}s</span>
              </div>
            )}
          </div>
          {scrolledUp && <button type="button" class="ag-jump" onClick={() => { stick.current = true; setScrolledUp(false); list.current?.scrollTo({ top: 1e9, behavior: 'smooth' }); }}>Jump to latest <ArrowDown size={13} /></button>}
          <VariationTray />
        </div>
      ) : <div class="left-content">{props.children}</div>}
      <div class={'ag-composer composer' + (dropping ? ' dropping' : '')}
        onDragOver={e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={() => setDropping(false)}
        onDrop={e => { const f = [...(e.dataTransfer?.files ?? [])]; setDropping(false); if (f.length) { e.preventDefault(); e.stopPropagation(); takeFiles(f); } }}
        onPaste={e => { const f = [...(e.clipboardData?.files ?? [])]; if (f.length) { e.preventDefault(); e.stopPropagation(); takeFiles(f); } }}>
        {/* context chips only when there is something beyond the composition: the selection, mentions, a style */}
        {(selCount > 0 || mentioned.length > 0 || styleGuide) && (
          <div class="ag-context" onPointerEnter={e => { (e.currentTarget as HTMLElement).title = editorContext(s, mentioned); }}>
            {selCount > 0 && (
              <span class="ctx-chip" title="The selection is sent as context">
                <ChipIcon size={12} />
                <span class="ctx-chip-name">{chipLabel}</span>
                <button type="button" class="ctx-chip-x" aria-label="Clear selection" onClick={() => s.select([])}><X size={12} /></button>
              </span>
            )}
            {mentioned.map(l => <span class="ctx-chip mention"><span class="ctx-chip-name">@{l.name}</span></span>)}
            {styleGuide && (
              <span class="ctx-chip" title={styleGuide.summary}>
                <Palette size={12} />
                <span class="ctx-chip-name">{styleLabel(styleGuide)}</span>
                <button type="button" class="ctx-chip-x" aria-label="No style" onClick={() => setStyle('')}><X size={12} /></button>
              </span>
            )}
          </div>
        )}
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
            <Button variant="ghost" icon size="sm" class="ag-plus" tip="Add a file, mention a layer, style, model" tipSide="top" onClick={attach as any} aria-haspopup="menu"><Plus /></Button>
            <Button variant="ghost" icon size="sm" active={picking} tip={picking ? 'Click a layer on the canvas (Esc cancels)' : 'Point at a layer on the canvas'} tipSide="top" onClick={() => setPicking(p => !p)}><MousePointerClick /></Button>
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
  turn_budget: 'Turn budget used up',
};

/** width / height of the 6-frame result sheet (3 x 2 cells, labels, padding: see contactSheet in tools.ts) */
function previewAspect() {
  const c = editor.store.comp;
  const sc = Math.min(1, 220 / Math.max(c.width, c.height));
  const w = Math.round(c.width * sc), h = Math.round(c.height * sc);
  return `${3 * (w + 4) + 4} / ${2 * (h + 4 + 16) + 4}`;
}

/** a contact sheet of the turn's animated range (whole comp when the range is tiny) for the chat */
async function resultPreview(range?: [number, number]): Promise<string | undefined> {
  const s = editor.store;
  if (!editor.renderer) return undefined;
  const D = s.comp.duration;
  let [a, b] = range ?? [0, D];
  if (b - a < 0.4) { a = 0; b = D; }
  a = Math.max(0, a - 0.05); b = Math.min(D, b + 0.3);
  try {
    const res = await TOOLS.find(t => t.name === 'contact_sheet')!.run({ frames: 6, start: a, end: b, cell: 220 });
    const img = res.find(c => c.type === 'image') as { data: string; mimeType: string } | undefined;
    return img ? `data:${img.mimeType};base64,${img.data}` : undefined;
  } catch { return undefined; }
}

function fmtTok(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n); }

function lastToolIndex(msgs: Msg[]) { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'tool') return i; return -1; }

/** a run of tool steps as one quiet row ("Worked through 12 steps"; while running: the current
 *  step) that expands into the steps; what the agent looked at stays visible */
function ToolGroup(props: { items: Msg[]; running: boolean; shots?: boolean; layerName: (id: string) => string | undefined }) {
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
  const last = items[items.length - 1]?.tool;
  const n = items.length;
  return (
    <div class="ag-steps">
      <details class="ag-steps-group">
        <summary>
          <span class="ag-step-icon">{running ? <LoaderCircle size={12} class="ag-spin" /> : errors ? <CircleX size={12} /> : <Check size={12} />}</span>
          <span class="ag-grow">{running && last ? toolLabel(last.name, last.input, props.layerName) : `Worked through ${n} step${n === 1 ? '' : 's'}`}</span>
          {errors > 0 && <span class="ag-err-text">{errors} failed</span>}
          <ChevronRight size={12} class="ag-steps-chev" />
        </summary>
        {steps}
      </details>
      {props.shots !== false && images.length > 0 && <div class="ag-shots">{images.slice(-2).map(src => <img src={src} alt="What the agent looked at" title="What the agent looked at" />)}</div>}
    </div>
  );
}

/** tiny markdown renderer: **bold**, `code`, - bullets, 1. lists. builds vnodes (never innerHTML) */
function Markdown({ text }: { text: string }) {
  // a **bold** or `code` span that names a layer becomes a link: select it and jump to where its
  // animation starts (the motion equivalent of "open what was made")
  const term = (t: string, bold: boolean) => {
    const s = editor.store;
    const l = Object.values(s.project.layers).find(x => x.name === t);
    if (l) {
      const Icon = LAYER_ICON[l.type] ?? Square;
      return <button type="button" class="ag-ref" title="Select it and go to its animation" onClick={() => {
        const owner = (() => { let top = l; while (top.parent && s.layer(top.parent)) top = s.layer(top.parent)!; return Object.values(s.project.comps).find(c => c.root.includes(top.id)); })();
        if (owner && owner.id !== s.comp.id) s.openComp(owner.id);
        s.select([l.id]);
        const r = animRange(l);
        if (r) { editor.pause(); s.setTime(r[0]); }
      }}><Icon size={12} />{t}</button>;
    }
    return bold ? <b>{t}</b> : <code>{t}</code>;
  };
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map(part =>
    part.startsWith('**') && part.endsWith('**') ? term(part.slice(2, -2), true) : part.startsWith('`') && part.endsWith('`') ? term(part.slice(1, -1), false) : part);
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
