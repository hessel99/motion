// websocket client to the local bridge (bridge/server.mjs). registers the editor tools and
// relays chat with cli agents (claude code / codex / gemini) using the user's subscription.

import { TOOLS, AGENT_SYSTEM_PROMPT } from './tools';

export interface Provider { id: string; name: string; available: boolean; version?: string }
export interface ChatEvent { kind: string; [k: string]: any }

type Status = 'connecting' | 'connected' | 'offline';

class AgentClient {
  status: Status = 'offline';
  providers: Provider[] = [];
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private chatHandlers = new Map<string, (e: ChatEvent) => void>();
  private retry = 500;
  port = 7823;

  on(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { this.listeners.forEach(f => f()); }

  async connect() {
    const native = (globalThis as any).motionNative;
    if (native?.bridgePort) {
      try { this.port = await native.bridgePort(); } catch { /* fall back to default */ }
    }
    const qp = new URLSearchParams(location.search).get('bridge');
    if (qp) this.port = +qp;
    this.open();
  }

  private open() {
    this.status = 'connecting';
    this.emit();
    let ws: WebSocket;
    try { ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.status = 'connected';
      this.retry = 500;
      ws.send(JSON.stringify({ type: 'hello', tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }));
      this.emit();
    };
    ws.onclose = () => { this.ws = null; this.status = 'offline'; this.emit(); this.scheduleReconnect(); };
    ws.onerror = () => { /* onclose follows */ };
    ws.onmessage = ev => this.handle(JSON.parse(String(ev.data)));
  }

  private scheduleReconnect() {
    setTimeout(() => this.open(), this.retry);
    this.retry = Math.min(10000, this.retry * 2);
  }

  private async handle(m: any) {
    if (m.type === 'providers') { this.providers = m.list; this.emit(); }
    else if (m.type === 'tool_call') {
      const tool = TOOLS.find(t => t.name === m.name);
      try {
        if (!tool) throw new Error(`unknown tool ${m.name}`);
        const content = await tool.run(m.args ?? {});
        this.send({ type: 'tool_result', id: m.id, ok: true, content });
      } catch (e: any) {
        this.send({ type: 'tool_result', id: m.id, ok: false, error: String(e?.message ?? e) });
      }
    } else if (m.type === 'chat_event') {
      this.chatHandlers.get(m.chatId)?.(m.event);
      if (m.event.kind === 'done') this.chatHandlers.delete(m.chatId);
    }
  }

  private send(m: any) { this.ws?.readyState === 1 && this.ws.send(JSON.stringify(m)); }

  chat(opts: { provider: string; message: string; sessionId?: string; model?: string }, onEvent: (e: ChatEvent) => void) {
    const chatId = 'c' + Math.random().toString(36).slice(2);
    this.chatHandlers.set(chatId, onEvent);
    this.send({ type: 'chat', chatId, provider: opts.provider, message: opts.message, sessionId: opts.sessionId, model: opts.model, systemPrompt: AGENT_SYSTEM_PROMPT });
    return chatId;
  }

  cancel(chatId: string) { this.send({ type: 'chat_cancel', chatId }); }

  refreshProviders() { this.send({ type: 'providers_refresh' }); }
}

export const agentClient = new AgentClient();
