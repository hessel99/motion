// websocket client to the local bridge (bridge/server.mjs). registers the editor tools and
// relays chat with cli agents (claude code / codex / gemini) using the user's subscription.

import { TOOLS, READ_ONLY_TOOLS } from './tools';
import { AGENT_SYSTEM_PROMPT, AGENT_SYSTEM_PROMPT_PLAIN, ASK_MODE_PROMPT } from './prompt';
import { tasteOn, TASTE_TOOLS, TASTE_GUIDE_HINT } from './taste';
import { GUIDES } from './guides';

export interface Provider { id: string; name: string; available: boolean; version?: string }
export interface ChatEvent { kind: string; [k: string]: any }
export type ChatMode = 'edit' | 'ask';

type Status = 'connecting' | 'connected' | 'offline';

/** the tool list as sent to the bridge (and served over MCP) */
export function toolManifest() {
  // taste layer off: no critic tool and no gold examples (the plain agent; Settings → Polish automatically)
  const taste = tasteOn();
  return TOOLS.filter(t => taste || !TASTE_TOOLS.includes(t.name)).map(t => ({
    name: t.name,
    description: taste ? t.description : t.description.replace(TASTE_GUIDE_HINT, ''),
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
  private imageListeners = new Set<(img: { tool: string; data: string; mimeType: string }) => void>();
  /** chats running in Ask (read-only) mode: editing tools are refused while any is active */
  private readOnlyChats = new Set<string>();
  private retry = 500;
  port = 7823;
  private token = '';

  on(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { this.listeners.forEach(f => f()); }
  /** images produced by tools (screenshot, contact sheet): lets the ui show what the agent saw */
  onToolImage(fn: (img: { tool: string; data: string; mimeType: string }) => void) { this.imageListeners.add(fn); return () => { this.imageListeners.delete(fn); }; }

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
      }
      this.emit();
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onmessage = ev => { try { this.handle(JSON.parse(String(ev.data))); } catch (e) { console.warn('agent bridge message', e); } };
  }

  private scheduleReconnect() {
    setTimeout(() => this.open(), this.retry);
    this.retry = Math.min(10000, this.retry * 2);
  }

  /** run a tool locally (used by the bridge relay; exported for tests / scripted use) */
  async runTool(name: string, args: any) {
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) throw new Error(`unknown tool ${name}`);
    if (this.readOnlyChats.size && !tool.readOnly) throw new Error(`"${name}" is disabled: this turn is in Ask (read-only) mode. Describe the change you would make instead; the user can switch to Edit mode.`);
    const content = await tool.run(args ?? {});
    for (const c of content) if (c.type === 'image') this.imageListeners.forEach(f => f({ tool: name, data: c.data, mimeType: c.mimeType }));
    return content;
  }

  private async handle(m: any) {
    if (m.type === 'providers') { this.providers = m.list; this.emit(); }
    else if (m.type === 'tool_call') {
      try {
        const content = await this.runTool(m.name, m.args);
        this.send({ type: 'tool_result', id: m.id, ok: true, content });
      } catch (e: any) {
        this.send({ type: 'tool_result', id: m.id, ok: false, error: String(e?.message ?? e) });
      }
    } else if (m.type === 'chat_event') {
      this.chatHandlers.get(m.chatId)?.(m.event);
      if (m.event.kind === 'done') { this.chatHandlers.delete(m.chatId); this.readOnlyChats.delete(m.chatId); }
    }
  }

  private send(m: any) { this.ws?.readyState === 1 && this.ws.send(JSON.stringify(m)); }

  chat(opts: { provider: string; message: string; sessionId?: string; model?: string; mode?: ChatMode; maxTurns?: number }, onEvent: (e: ChatEvent) => void) {
    const chatId = 'c' + Math.random().toString(36).slice(2);
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
      systemPrompt: tasteOn() ? AGENT_SYSTEM_PROMPT : AGENT_SYSTEM_PROMPT_PLAIN,
      readOnlyTools: ask ? READ_ONLY_TOOLS() : undefined,
    });
    return chatId;
  }

  cancel(chatId: string) { this.send({ type: 'chat_cancel', chatId }); }

  /** stop routing a chat's events and lift its Ask-mode lock. for turns finished locally (the
   *  cancel safety net, a detached turn) whose 'done' may never arrive from the bridge */
  forget(chatId: string) {
    this.chatHandlers.delete(chatId);
    if (this.readOnlyChats.delete(chatId)) this.emit();
  }

  /** chats whose Ask-mode lock is active (tests / diagnostics) */
  get readOnlyCount() { return this.readOnlyChats.size; }

  refreshProviders() { this.send({ type: 'providers_refresh' }); }
}

export const agentClient = new AgentClient();
