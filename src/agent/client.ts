// websocket client to the local bridge (bridge/server.mjs). registers the editor tools and
// relays chat with cli agents (claude code / codex / gemini) using the user's subscription.

import { TOOLS, READ_ONLY_TOOLS } from './tools';
import { AGENT_SYSTEM_PROMPT, ASK_MODE_PROMPT } from './prompt';
import { GUIDES } from './guides';
import { withToolStore } from './tool-kit';
import type { Store } from '../core/store';

export interface Provider { id: string; name: string; available: boolean; version?: string }
export interface ChatEvent { kind: string; [k: string]: any }
export type ChatMode = 'edit' | 'ask';

type Status = 'connecting' | 'connected' | 'offline';

/** the tool list as sent to the bridge (and served over MCP) */
export function toolManifest() {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: !!t.readOnly, destructiveHint: t.name === 'delete_layers' || t.name === 'undo', openWorldHint: false },
  }));
}

/** the motion guides as MCP resources (served by the bridge: resources/list, resources/read) */
export function resourceManifest() {
  return GUIDES.map(g => ({ uri: `motion://guides/${g.name}`, name: g.name, title: g.title, description: g.summary, mimeType: 'text/markdown', text: g.text }));
}

class AgentClient {
  status: Status = 'offline';
  providers: Provider[] = [];
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private chatHandlers = new Map<string, (e: ChatEvent) => void>();
  private imageListeners = new Set<(img: { tool: string; data: string; mimeType: string; chatId?: string }) => void>();
  /** chatId -> the store of the document the chat works in (runs belong to their document: a tool
   *  call of a chat whose document is in a background tab edits that document, never the visible one) */
  private targets = new Map<string, () => Store | null>();
  /** tool calls run one at a time (a background document's store is swapped in for one call) */
  private toolQueue: Promise<unknown> = Promise.resolve();
  /** the chat whose tool call is running right now (tools that report to the ui: storyboards) */
  toolChat: string | undefined;
  /** chats running in Ask (read-only) mode: editing tools are refused while any is active */
  private readOnlyChats = new Set<string>();
  private retry = 500;
  port = 7823;
  private token = '';

  on(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { this.listeners.forEach(f => f()); }
  /** images produced by tools (screenshot, contact sheet): lets the ui show what the agent saw */
  onToolImage(fn: (img: { tool: string; data: string; mimeType: string; chatId?: string }) => void) { this.imageListeners.add(fn); return () => { this.imageListeners.delete(fn); }; }

  async connect() {
    const native = (globalThis as any).motionNative;
    if (native?.bridgePort) {
      try { this.port = await native.bridgePort(); } catch { /* fall back to default */ }
      try { this.token = (await native.bridgeToken?.()) ?? ''; } catch { /* older preload */ }
    }
    const qp = new URLSearchParams(location.search).get('bridge');
    if (qp) this.port = +qp;
    this.open();
  }

  private open() {
    this.status = 'connecting';
    this.emit();
    let ws: WebSocket;
    try { ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.status = 'connected';
      this.retry = 500;
      ws.send(JSON.stringify({ type: 'hello', tools: toolManifest(), resources: resourceManifest() }));
      this.emit();
    };
    ws.onclose = () => {
      this.ws = null;
      this.status = 'offline';
      // running chats can't finish anymore: end them with an actionable error instead of spinning forever
      for (const [id, h] of this.chatHandlers) {
        h({ kind: 'error', errorKind: 'bridge', message: 'Lost the connection to the agent bridge. The agent may have stopped mid-turn; review its changes below.' });
        h({ kind: 'done' });
        this.chatHandlers.delete(id);
        this.readOnlyChats.delete(id);
        this.targets.delete(id);
      }
      this.emit();
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onmessage = ev => { try { this.handle(JSON.parse(String(ev.data))); } catch (e) { console.warn('agent bridge message', e); } };
  }

  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), this.retry);
    this.retry = Math.min(10000, this.retry * 2);
  }

  /** try now instead of waiting for the backoff ("Reconnect") */
  reconnect() {
    if (this.status === 'connected' || this.ws) return;
    clearTimeout(this.reconnectTimer);
    this.retry = 500;
    this.open();
  }

  /** run a tool locally (used by the bridge relay; exported for tests / scripted use) */
  async runTool(name: string, args: any, chatId?: string) {
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) throw new Error(`unknown tool ${name}`);
    // without a chat id (an older bridge, scripted use) the only running chat is the caller
    if (!chatId && this.chatHandlers.size === 1) chatId = [...this.chatHandlers.keys()][0];
    const readOnly = chatId && this.chatHandlers.has(chatId) ? this.readOnlyChats.has(chatId) : this.readOnlyChats.size > 0;
    if (readOnly && !tool.readOnly) throw new Error(`"${name}" is disabled: this turn is read-only (critique / explain). Describe the change you would make instead; the user can ask for it.`);
    const store = chatId ? this.targets.get(chatId)?.() ?? null : null;
    // a call never waits on a stuck earlier one for more than a minute (the bridge gave up on it)
    const prev = Promise.race([this.toolQueue, new Promise(r => setTimeout(r, 60000))]);
    const run = prev.then(() => {
      this.toolChat = chatId;
      return withToolStore(store, () => tool.run(args ?? {})).finally(() => { this.toolChat = undefined; });
    });
    this.toolQueue = run.catch(() => {});
    const content = await run;
    for (const c of content) if (c.type === 'image') this.imageListeners.forEach(f => f({ tool: name, data: c.data, mimeType: c.mimeType, chatId }));
    return content;
  }

  /** the document store a chat's tool calls work on (see `targets`) */
  setTarget(chatId: string, store: () => Store | null) { this.targets.set(chatId, store); }

  private async handle(m: any) {
    if (m.type === 'providers') { this.providers = m.list; this.emit(); }
    else if (m.type === 'tool_call') {
      try {
        const content = await this.runTool(m.name, m.args, typeof m.chatId === 'string' ? m.chatId : undefined);
        this.send({ type: 'tool_result', id: m.id, ok: true, content });
      } catch (e: any) {
        this.send({ type: 'tool_result', id: m.id, ok: false, error: String(e?.message ?? e) });
      }
    } else if (m.type !== 'chat_event') {
      this.extra.forEach(f => f(m));
    } else if (m.type === 'chat_event') {
      this.chatHandlers.get(m.chatId)?.(m.event);
      if (m.event.kind === 'done') { this.chatHandlers.delete(m.chatId); this.readOnlyChats.delete(m.chatId); this.targets.delete(m.chatId); }
    }
  }

  private send(m: any) { this.ws?.readyState === 1 && this.ws.send(JSON.stringify(m)); }
  /** other bridge services (figma shader sources): raw messages both ways */
  private extra = new Set<(m: any) => void>();
  listen(fn: (m: any) => void) { this.extra.add(fn); return () => { this.extra.delete(fn); }; }
  post(m: any): boolean { if (this.ws?.readyState !== 1) return false; this.send(m); return true; }

  chat(opts: { provider: string; message: string; sessionId?: string; model?: string; mode?: ChatMode; maxTurns?: number; store?: () => Store | null }, onEvent: (e: ChatEvent) => void) {
    const chatId = 'c' + Math.random().toString(36).slice(2);
    if (opts.store) this.targets.set(chatId, opts.store);
    if (this.ws?.readyState !== 1) {
      queueMicrotask(() => { onEvent({ kind: 'error', errorKind: 'bridge', message: 'The agent bridge is offline.' }); onEvent({ kind: 'done' }); });
      return chatId;
    }
    this.chatHandlers.set(chatId, onEvent);
    const ask = opts.mode === 'ask';
    if (ask) this.readOnlyChats.add(chatId);
    this.send({
      // the ask-mode note goes into the message (codex/gemini only get the system prompt on the first turn)
      type: 'chat', chatId, provider: opts.provider, message: ask ? `${ASK_MODE_PROMPT}\n\n${opts.message}` : opts.message, sessionId: opts.sessionId, model: opts.model, maxTurns: opts.maxTurns,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      readOnlyTools: ask ? READ_ONLY_TOOLS() : undefined,
    });
    return chatId;
  }

  cancel(chatId: string) { this.send({ type: 'chat_cancel', chatId }); }

  /** stop routing a chat's events and lift its Ask-mode lock. for turns finished locally (the
   *  cancel safety net, a detached turn) whose 'done' may never arrive from the bridge */
  forget(chatId: string) {
    this.chatHandlers.delete(chatId);
    this.targets.delete(chatId);
    if (this.readOnlyChats.delete(chatId)) this.emit();
  }

  /** chats whose Ask-mode lock is active (tests / diagnostics) */
  get readOnlyCount() { return this.readOnlyChats.size; }

  refreshProviders() { this.send({ type: 'providers_refresh' }); }
}

export const agentClient = new AgentClient();
