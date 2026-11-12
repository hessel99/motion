// Motion agent bridge: a local relay between the editor (WebSocket at /ws) and agent CLIs
// (Claude Code / Codex / Gemini) that call the editor's tools through MCP (POST /mcp).
// Binds 127.0.0.1 only. No shell or file access is exposed over the network.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { detectProviders, runTurn, PROVIDERS } from './providers.mjs';

export const TOOL_TIMEOUT_MS = 120_000;
const MAX_BODY = 4 * 1024 * 1024;
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** tool results go straight into the model context: a runaway text result is cut here (images pass) */
export const MAX_TOOL_TEXT = Number(process.env.MOTION_MAX_TOOL_TEXT) || 24_000;

/** cap each text block of a tool result; tells the model how much was cut and what to do */
export function compactContent(content, max = MAX_TOOL_TEXT) {
  if (!Array.isArray(content)) return content;
  return content.map((c) => (c && c.type === 'text' && typeof c.text === 'string' && c.text.length > max
    ? { ...c, text: `${c.text.slice(0, max)}\n… (${c.text.length - max} more characters cut: ask for less, e.g. pass ids, a section or deep:false)` }
    : c));
}

/**
 * Origins allowed to open the editor WebSocket / call MCP from a browser context.
 * "null" / file:// origins are NOT trusted by origin alone: any website can produce Origin: null
 * (sandboxed iframes, data: urls). They need the per-launch token (see isAuthorized).
 */
export function isAllowedOrigin(origin) {
  if (origin == null || origin === '') return true; // non-browser clients (CLIs, node)
  if (origin === 'null' || origin.startsWith('file://')) return false;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** origin check, plus the launch token for opaque origins (the packaged electron app loads file://) */
export function isAuthorized(req, url, token) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) return true;
  if (!token || !(origin === 'null' || String(origin).startsWith('file://'))) return false;
  const given = url.searchParams.get('token') ?? req.headers['x-motion-token'];
  return given === token;
}

/** DNS-rebinding guard: Host header must name the loopback interface. */
function isAllowedHost(host) {
  if (!host) return true;
  const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

export async function startBridge({ port = 7823, host = '127.0.0.1', log = console.log, workDir, token } = {}) {
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') throw new Error('bridge must bind to loopback only');
  const say = typeof log === 'function' ? log : () => {};

  /** @type {import('ws').WebSocket | null} */
  let editor = null;
  let tools = [];
  /** read-only documents the editor serves as MCP resources (motion guides): {uri, name, title, description, mimeType, text} */
  let resources = [];
  /** id -> {resolve, timer} */
  const pending = new Map();
  /** chatId -> {run, ws} */
  const chats = new Map();

  const send = (ws, msg) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  // ---------- tool calls into the editor ----------
  function callEditorTool(name, args) {
    return new Promise((resolve) => {
      if (!editor || editor.readyState !== 1) {
        return resolve({ ok: false, error: 'The Motion editor is not open (no editor connected to the bridge). Ask the user to open the editor and try again.' });
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: `Tool "${name}" timed out after ${TOOL_TIMEOUT_MS / 1000}s waiting for the editor.` });
      }, TOOL_TIMEOUT_MS);
      pending.set(id, { resolve, timer, ws: editor });
      send(editor, { type: 'tool_call', id, name, args: args ?? {} });
    });
  }

  function failPendingFor(ws) {
    for (const [id, p] of pending) {
      if (p.ws === ws) {
        clearTimeout(p.timer);
        pending.delete(id);
        p.resolve({ ok: false, error: 'The editor disconnected before returning a result.' });
      }
    }
  }

  // ---------- MCP (Streamable HTTP, JSON responses only) ----------
  async function handleRpc(msg) {
    const isRequest = msg && typeof msg === 'object' && 'id' in msg && msg.id !== null;
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return isRequest || !msg?.method ? fail(-32600, 'Invalid Request') : null;
    }
    if (!isRequest) return null; // notifications/*, or any notification
    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : (typeof requested === 'string' ? requested : '2025-03-26'),
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
          serverInfo: { name: 'motion', version: '0.1.0' },
          instructions: 'Tools that operate the Motion motion-design editor the user has open.',
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
            ...(t.annotations && typeof t.annotations === 'object' ? { annotations: t.annotations } : {}),
          })),
        });
      case 'tools/call': {
        const name = msg.params?.name;
        if (typeof name !== 'string') return fail(-32602, 'Missing tool name');
        if (editor && tools.length && !tools.some((t) => t.name === name)) {
          return reply({ content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true });
        }
        const r = await callEditorTool(name, msg.params?.arguments);
        if (r.ok) {
          const content = Array.isArray(r.content) && r.content.length ? r.content : [{ type: 'text', text: 'ok' }];
          return reply({ content: compactContent(content), isError: false });
        }
        const content = Array.isArray(r.content) && r.content.length ? r.content : [{ type: 'text', text: r.error ?? 'Tool failed' }];
        if (r.error && Array.isArray(r.content) && r.content.length) content.unshift({ type: 'text', text: r.error });
        return reply({ content, isError: true });
      }
      case 'resources/list':
        return reply({ resources: resources.map(({ uri, name, title, description, mimeType }) => ({ uri, name, ...(title ? { title } : {}), ...(description ? { description } : {}), mimeType: mimeType ?? 'text/markdown' })) });
      case 'resources/read': {
        const uri = msg.params?.uri;
        const r = resources.find((x) => x.uri === uri);
        if (!r) return fail(-32002, `Resource not found: ${uri}${resources.length ? '' : ' (no editor connected)'}`);
        return reply({ contents: [{ uri: r.uri, mimeType: r.mimeType ?? 'text/markdown', text: r.text }] });
      }
      case 'resources/templates/list':
        return reply({ resourceTemplates: [] });
      case 'prompts/list':
        return reply({ prompts: [] });
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function json(res, status, body, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
    res.end(JSON.stringify(body));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!isAllowedHost(req.headers.host) || !isAuthorized(req, url, token)) {
      return json(res, 403, { error: 'forbidden' });
    }
    // CORS for the dev renderer (vite on localhost:5173) hitting /health
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, mcp-protocol-version, mcp-session-id, accept',
      });
      return res.end();
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, editorConnected: !!editor && editor.readyState === 1, tools: tools.length });
    }
    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      if (Array.isArray(body)) {
        const results = (await Promise.all(body.map(handleRpc))).filter(Boolean);
        if (!results.length) { res.writeHead(202); return res.end(); }
        return json(res, 200, results);
      }
      const result = await handleRpc(body);
      if (!result) { res.writeHead(202); return res.end(); }
      return json(res, 200, result);
    }
    json(res, 404, { error: 'not found' });
  });

  // ---------- editor WebSocket ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/ws' || !isAuthorized(req, u, token) || !isAllowedHost(req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    say('[bridge] editor connected');
    editor = ws; // latest connected editor wins
    detectProviders().then((list) => send(ws, { type: 'providers', list }));

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'hello':
          editor = ws;
          tools = Array.isArray(msg.tools) ? msg.tools.filter((t) => t && typeof t.name === 'string') : [];
          resources = Array.isArray(msg.resources) ? msg.resources.filter((r) => r && typeof r.uri === 'string' && typeof r.text === 'string') : [];
          say(`[bridge] editor registered ${tools.length} tools, ${resources.length} resources`);
          break;
        case 'tool_result': {
          const p = pending.get(msg.id);
          if (!p) break;
          clearTimeout(p.timer);
          pending.delete(msg.id);
          p.resolve({ ok: !!msg.ok, content: msg.content, error: msg.error });
          break;
        }
        case 'providers_refresh':
          detectProviders(true).then((list) => send(ws, { type: 'providers', list }));
          break;
        case 'chat': {
          const { chatId, provider, message } = msg;
          if (!chatId) break;
          const emit = (event) => {
            const target = ws.readyState === 1 ? ws : editor;
            send(target, { type: 'chat_event', chatId, event });
            if (event.kind === 'done') chats.delete(chatId);
          };
          if (!PROVIDERS[provider]) { emit({ kind: 'error', message: `unknown provider: ${provider}` }); emit({ kind: 'done' }); break; }
          if (typeof message !== 'string' || !message.trim()) { emit({ kind: 'error', message: 'empty message' }); emit({ kind: 'done' }); break; }
          chats.get(chatId)?.run.cancel();
          const run = runTurn(
            provider,
            {
              message,
              sessionId: typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : undefined,
              model: typeof msg.model === 'string' && msg.model ? msg.model : undefined,
              systemPrompt: typeof msg.systemPrompt === 'string' && msg.systemPrompt ? msg.systemPrompt : undefined,
              maxTurns: Number.isInteger(msg.maxTurns) && msg.maxTurns > 0 ? Math.min(msg.maxTurns, 500) : undefined,
              readOnlyTools: Array.isArray(msg.readOnlyTools) ? msg.readOnlyTools.filter((t) => typeof t === 'string' && /^[\w-]+$/.test(t)) : undefined,
              mcpUrl: `http://127.0.0.1:${actualPort}/mcp`,
              workDir,
            },
            emit,
            say,
          );
          chats.set(chatId, { run, ws });
          break;
        }
        case 'chat_cancel':
          chats.get(msg.chatId)?.run.cancel();
          break;
      }
    });

    ws.on('close', () => {
      failPendingFor(ws);
      if (editor === ws) {
        editor = null;
        say('[bridge] editor disconnected');
      }
    });
    ws.on('error', () => {});
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const actualPort = server.address().port;
  say(`[bridge] listening on http://${host}:${actualPort} (ws /ws, mcp /mcp)`);

  return {
    port: actualPort,
    async close() {
      for (const { run } of chats.values()) run.cancel();
      chats.clear();
      for (const [id, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'bridge shutting down' }); pending.delete(id); }
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

// ---------- CLI entry ----------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : Number(process.env.MOTION_BRIDGE_PORT ?? 7823);
  const b = await startBridge({ port });
  const stop = async () => { await b.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
