import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startBridge, isAllowedOrigin, isAuthorized, compactContent, MAX_TOOL_TEXT } from '../bridge/server.mjs';
import { classifyError } from '../bridge/errors.mjs';
import { parseClaudeLine, parseCodexLine, parseGeminiLine, splitJsonLines } from '../bridge/parsers.mjs';
import { buildCommand, DEFAULT_MAX_TURNS } from '../bridge/providers.mjs';

let bridge;
let base;

async function rpc(body, headers = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type'), body: text ? JSON.parse(text) : null };
}

function connectEditor(tools, handler) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, { headers: { origin: 'http://localhost:5173' } });
    const msgs = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      msgs.push(m);
      if (m.type === 'tool_call') ws.send(JSON.stringify({ type: 'tool_result', id: m.id, ...handler(m) }));
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', tools }));
      resolve({ ws, msgs });
    });
    ws.on('error', reject);
  });
}

const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout');
};

beforeAll(async () => {
  bridge = await startBridge({ port: 0, log: () => {} });
  base = `http://127.0.0.1:${bridge.port}`;
});
afterAll(async () => { await bridge?.close(); });

describe('bridge MCP relay', () => {
  it('health reports no editor initially; GET /mcp is 405; no-editor tool call errors', async () => {
    const h = await (await fetch(`${base}/health`)).json();
    expect(h).toEqual({ ok: true, editorConnected: false, tools: 0 });
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    const r = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'x', arguments: {} } });
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toMatch(/not open/);
  });

  it('round-trips initialize, tools/list, tools/call through a fake editor', async () => {
    const tool = { name: 'add_layer', description: 'Add a layer', inputSchema: { type: 'object', properties: { kind: { type: 'string' } } } };
    const { ws, msgs } = await connectEditor([tool], (m) =>
      m.args.kind === 'boom'
        ? { ok: false, error: 'bad kind' }
        : { ok: true, content: [{ type: 'text', text: `added ${m.args.kind}` }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] },
    );
    await until(() => msgs.find((m) => m.type === 'providers'));
    const prov = msgs.find((m) => m.type === 'providers');
    expect(prov.list.map((p) => p.id).sort()).toEqual(['claude', 'codex', 'gemini']);
    await until(async () => (await (await fetch(`${base}/health`)).json()).tools === 1);

    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(init.status).toBe(200);
    expect(init.type).toMatch(/application\/json/);
    expect(init.body.result.protocolVersion).toBe('2025-06-18');
    expect(init.body.result.serverInfo.name).toBe('motion');
    expect(init.body.result.capabilities.tools).toBeTruthy();

    const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(note.status).toBe(202);
    expect(note.body).toBeNull();

    expect((await rpc({ jsonrpc: '2.0', id: 2, method: 'ping' })).body.result).toEqual({});

    const list = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(list.body.result.tools).toEqual([tool]);

    const call = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'add_layer', arguments: { kind: 'rect' } } });
    expect(call.body.id).toBe(4);
    expect(call.body.result.isError).toBe(false);
    expect(call.body.result.content[0]).toEqual({ type: 'text', text: 'added rect' });
    expect(call.body.result.content[1].type).toBe('image');
    const tc = msgs.find((m) => m.type === 'tool_call');
    expect(tc).toMatchObject({ name: 'add_layer', args: { kind: 'rect' } });

    const err = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'add_layer', arguments: { kind: 'boom' } } });
    expect(err.body.result).toEqual({ content: [{ type: 'text', text: 'bad kind' }], isError: true });

    const unknown = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } });
    expect(unknown.body.result.isError).toBe(true);

    expect((await rpc({ jsonrpc: '2.0', id: 7, method: 'bogus' })).body.error.code).toBe(-32601);
    ws.close();
  });

  it('rejects foreign origins on WS upgrade and MCP', async () => {
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    // opaque origins can be produced by any website (sandboxed iframes): never trusted alone
    expect(isAllowedOrigin('file://')).toBe(false);
    expect(isAllowedOrigin('null')).toBe(false);
    const u = (q) => new URL('http://127.0.0.1/ws' + q);
    const req = (origin, headers = {}) => ({ headers: { origin, ...headers } });
    expect(isAuthorized(req('null'), u(''), 'secret')).toBe(false);
    expect(isAuthorized(req('null'), u('?token=wrong'), 'secret')).toBe(false);
    expect(isAuthorized(req('null'), u('?token=secret'), 'secret')).toBe(true);
    expect(isAuthorized(req('file://'), u(''), 'secret')).toBe(false);
    expect(isAuthorized(req('null', { 'x-motion-token': 'secret' }), u(''), 'secret')).toBe(true);
    expect(isAuthorized(req('null'), u('?token='), undefined)).toBe(false); // no token configured: opaque origins refused
    expect(isAuthorized(req('https://evil.example'), u('?token=secret'), 'secret')).toBe(false);
    expect(isAuthorized(req(undefined), u(''), 'secret')).toBe(true); // CLIs send no origin
    const bad = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' });
    expect(bad.status).toBe(403);
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, { headers: { origin: 'https://evil.example' } });
        ws.on('open', () => resolve('open'));
        ws.on('error', reject);
      }),
    ).rejects.toThrow(/403/);
  });

  it('reports chat errors for unknown provider', async () => {
    const { ws, msgs } = await connectEditor([], () => ({ ok: true }));
    ws.send(JSON.stringify({ type: 'chat', chatId: 'c1', provider: 'nope', message: 'hi' }));
    await until(() => msgs.find((m) => m.type === 'chat_event' && m.event.kind === 'done'));
    expect(msgs.filter((m) => m.type === 'chat_event').map((m) => m.event.kind)).toEqual(['error', 'done']);
    ws.close();
  });
});

// Sample lines recorded from a real `claude -p --output-format stream-json --verbose --include-partial-messages` run (trimmed).
const CLAUDE_SAMPLE = [
  '{"type":"active_goal","value":null,"session_id":"s-1"}',
  '{"type":"system","subtype":"init","cwd":"/x","session_id":"s-1","tools":["mcp__motion__add_layer"],"mcp_servers":[{"name":"motion","status":"connected"}],"model":"claude-opus-5-5"}',
  '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1","role":"assistant","content":[]}},"session_id":"s-1","parent_tool_use_id":null}',
  '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"session_id":"s-1","parent_tool_use_id":null}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Adding a "}},"session_id":"s-1","parent_tool_use_id":null}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"rect."}},"session_id":"s-1","parent_tool_use_id":null}',
  '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Adding a rect."}]},"session_id":"s-1","parent_tool_use_id":null}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"kind\\""}},"session_id":"s-1","parent_tool_use_id":null}',
  '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"mcp__motion__add_layer","input":{"kind":"rect"}}]},"session_id":"s-1","parent_tool_use_id":null}',
  '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":[{"type":"text","text":"added rect"}]}]},"session_id":"s-1","parent_tool_use_id":null}',
  '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"thinking","thinking":"done now","signature":"x"},{"type":"text","text":"Done."}]},"session_id":"s-1","parent_tool_use_id":null}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
  '{"type":"result","subtype":"success","is_error":false,"duration_ms":2781,"num_turns":2,"result":"Done.","session_id":"s-1","total_cost_usd":0.086924}',
].join('\n');

describe('claude stream-json parser', () => {
  it('normalizes a recorded run', () => {
    const [objs, rest] = splitJsonLines(CLAUDE_SAMPLE + '\n{"partial":');
    expect(rest).toBe('{"partial":');
    const state = {};
    const events = objs.flatMap((o) => parseClaudeLine(o, state));
    expect(events).toEqual([
      { kind: 'session', sessionId: 's-1' },
      { kind: 'text_delta', text: 'Adding a ' },
      { kind: 'text_delta', text: 'rect.' },
      { kind: 'text', text: 'Adding a rect.' },
      { kind: 'tool_use', id: 'toolu_1', name: 'add_layer', input: { kind: 'rect' } },
      { kind: 'tool_result', id: 'toolu_1', isError: false, summary: 'added rect' },
      { kind: 'thinking', text: 'done now' },
      { kind: 'text', text: 'Done.' },
      { kind: 'done', result: 'Done.', costUsd: 0.086924, durationMs: 2781, numTurns: 2, usage: undefined },
    ]);
  });

  it('turns error results into error + done and handles string tool_result content', () => {
    expect(parseClaudeLine({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'nope' }] } })).toEqual([
      { kind: 'tool_result', id: 't', isError: true, summary: 'nope' },
    ]);
    const ev = parseClaudeLine({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in', session_id: 's' }, { sessionId: 's' });
    expect(ev.map((e) => e.kind)).toEqual(['error', 'done']);
    expect(ev[0].message).toBe('Not logged in');
  });

  it('ignores sub-agent events', () => {
    expect(parseClaudeLine({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'sub' }] } })).toEqual([]);
  });
});

describe('codex / gemini parsers', () => {
  it('codex exec --json', () => {
    const s = {};
    const lines = [
      { type: 'thread.started', thread_id: 'th-1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'hmm' } },
      { type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'motion', tool: 'add_layer', arguments: { kind: 'rect' }, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'motion', tool: 'add_layer', arguments: { kind: 'rect' }, result: { content: [{ type: 'text', text: 'ok' }] }, status: 'completed' } },
      { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Done' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    expect(lines.flatMap((l) => parseCodexLine(l, s))).toEqual([
      { kind: 'session', sessionId: 'th-1' },
      { kind: 'thinking', text: 'hmm' },
      { kind: 'tool_use', id: 'i1', name: 'add_layer', input: { kind: 'rect' } },
      { kind: 'tool_result', id: 'i1', isError: false, summary: 'ok' },
      { kind: 'text', text: 'Done' },
      { kind: 'done' },
    ]);
  });

  it('gemini stream-json', () => {
    const s = {};
    const lines = [
      { type: 'init', session_id: 'g-1', model: 'gemini-2.5-pro' },
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'assistant', content: 'Hel', delta: true },
      { type: 'message', role: 'assistant', content: 'lo', delta: true },
      { type: 'tool_use', tool_name: 'add_layer', tool_id: 't1', parameters: { kind: 'rect' } },
      { type: 'tool_result', tool_id: 't1', status: 'success', output: 'ok' },
      { type: 'result', status: 'success', stats: { duration_ms: 50 } },
    ];
    expect(lines.flatMap((l) => parseGeminiLine(l, s))).toEqual([
      { kind: 'session', sessionId: 'g-1' },
      { kind: 'text_delta', text: 'Hel' },
      { kind: 'text_delta', text: 'lo' },
      { kind: 'text', text: 'Hello' },
      { kind: 'tool_use', id: 't1', name: 'add_layer', input: { kind: 'rect' } },
      { kind: 'tool_result', id: 't1', isError: false, summary: 'ok' },
      { kind: 'done', durationMs: 50 },
    ]);
  });
});

describe('buildCommand', () => {
  it('claude args carry mcp config, resume, system prompt and model; prompt via stdin', () => {
    const c = buildCommand('claude', { message: 'hi', sessionId: 's1', model: 'sonnet', systemPrompt: 'SP', mcpUrl: 'http://127.0.0.1:1/mcp', workDir: '/tmp' });
    expect(c.bin).toBe('claude');
    expect(c.stdin).toBe('hi');
    const cfg = JSON.parse(c.args[c.args.indexOf('--mcp-config') + 1]);
    expect(cfg).toEqual({ mcpServers: { motion: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } });
    expect(c.args).toEqual(expect.arrayContaining(['-p', '--verbose', '--include-partial-messages', '--allowedTools', 'mcp__motion', '--resume', 's1', '--append-system-prompt', 'SP', '--model', 'sonnet']));
  });
});

describe('bridge: guides as MCP resources, compact results, turn budget', () => {
  it('serves the editor-registered resources (list + read) and caps huge text results', async () => {
    const res = [{ uri: 'motion://guides/handbook', name: 'handbook', title: 'Motion handbook', description: 'craft rules', mimeType: 'text/markdown', text: '# Motion handbook\n...' }];
    const big = 'x'.repeat(MAX_TOOL_TEXT + 500);
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, { headers: { origin: 'http://localhost:5173' } });
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'tool_call') ws.send(JSON.stringify({ type: 'tool_result', id: m.id, ok: true, content: [{ type: 'text', text: big }] }));
    });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', tools: [{ name: 'dump', description: 'big output', inputSchema: { type: 'object', properties: {} } }], resources: res }));
    await until(async () => (await (await fetch(`${base}/health`)).json()).tools === 1);

    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    expect(init.body.result.capabilities.resources).toBeTruthy();
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    expect(list.body.result.resources).toEqual([{ uri: 'motion://guides/handbook', name: 'handbook', title: 'Motion handbook', description: 'craft rules', mimeType: 'text/markdown' }]);
    const read = await rpc({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'motion://guides/handbook' } });
    expect(read.body.result.contents[0]).toEqual({ uri: 'motion://guides/handbook', mimeType: 'text/markdown', text: '# Motion handbook\n...' });
    const miss = await rpc({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'motion://guides/nope' } });
    expect(miss.body.error.message).toMatch(/not found/);

    const call = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'dump', arguments: {} } });
    const t = call.body.result.content[0].text;
    expect(t.length).toBeLessThan(MAX_TOOL_TEXT + 200);
    expect(t).toMatch(/500 more characters cut/);
    ws.close();
  });

  it('compactContent leaves small text and images alone', () => {
    const c = [{ type: 'text', text: 'ok' }, { type: 'image', data: 'x'.repeat(100), mimeType: 'image/png' }];
    expect(compactContent(c, 10)).toEqual(c);
  });

  it('claude gets a turn budget (default or per message); max-turns results are a typed error', () => {
    const base = { message: 'x', mcpUrl: 'http://127.0.0.1:1/mcp', workDir: '/tmp' };
    const a = buildCommand('claude', base).args;
    expect(a[a.indexOf('--max-turns') + 1]).toBe(String(DEFAULT_MAX_TURNS));
    const b = buildCommand('claude', { ...base, maxTurns: 12 }).args;
    expect(b[b.indexOf('--max-turns') + 1]).toBe('12');
    const ev = parseClaudeLine({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 12, session_id: 's' }, {});
    expect(ev.find((e) => e.kind === 'error').message).toMatch(/turn budget/);
    expect(classifyError('Reached the turn budget (error_max_turns, 12 turns).').errorKind).toBe('turn_budget');
  });
});
