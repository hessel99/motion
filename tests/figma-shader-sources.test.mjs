// figma shader sources through a mocked figma mcp server: oauth (discovery, dynamic client
// registration, pkce, loopback redirect, refresh), streamable http (json + sse replies, sessions),
// shader matching by build sha, the app cache (offline second paste), the claude cli fallback, and
// the bridge's websocket messages + callback route.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createShaderSources, fileSecrets, findShader, shaderCache, toolResultsFromStream, claudeProvider } from '../bridge/figma-shaders.mjs';
import { startBridge } from '../bridge/server.mjs';

const SHA_A = 'a'.repeat(40), SHA_A_OLD = 'b'.repeat(40), SHA_B = 'c'.repeat(40);
const UUID_A = '11111111-2222-3333-4444-555555555555', UUID_B = '66666666-7777-8888-9999-000000000000';
const SRC = (n) => `import { defineProperties } from 'figma:shaders'\nexport default function Effect() {}\nexport function render(d, f) {}\ndefineProperties(Effect, { ${n}: { type: 'number', defaultValue: 1 } })\n`;
const SHADERS = {
  [UUID_A]: { name: 'Stripes', type: 'fill', versions: { [SHA_A]: SRC('speed'), [SHA_A_OLD]: SRC('speed') }, latest: SHA_A },
  [UUID_B]: { name: 'Invert', type: 'effect', versions: { [SHA_B]: SRC('amount') }, latest: SHA_B },
};

/** a fake figma: oauth server + mcp endpoint */
function mockFigma() {
  const state = { calls: [], registered: 0, tokens: new Set(), codes: new Map(), refreshed: 0, down: false, sse: false, rejectRegistration: false };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = await new Promise(r => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => r(b)); });
    const json = (s, o, h = {}) => { res.writeHead(s, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
    if (state.down) { res.writeHead(503); return res.end(); }
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['mcp'] });
    if (u.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ['S256'] });
    if (u.pathname === '/register') {
      if (state.rejectRegistration) return json(403, { error: 'access_denied', error_description: 'client not allowed' });
      state.registered++;
      const b = JSON.parse(body);
      return json(201, { client_id: 'client-1', redirect_uris: b.redirect_uris });
    }
    if (u.pathname === '/authorize') {
      // the "user" approves immediately: redirect with a code bound to the pkce challenge
      const code = 'code-' + Math.random();
      state.codes.set(code, u.searchParams.get('code_challenge'));
      res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}` });
      return res.end();
    }
    if (u.pathname === '/token') {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        const ch = state.codes.get(p.get('code'));
        const ok = ch && createHash('sha256').update(p.get('code_verifier')).digest('base64url') === ch;
        if (!ok) return json(400, { error: 'invalid_grant' });
        state.tokens.add('tok-1');
        return json(200, { access_token: 'tok-1', refresh_token: 'ref-1', expires_in: 1 });
      }
      if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'ref-1') { state.refreshed++; state.tokens.add('tok-2'); return json(200, { access_token: 'tok-2', expires_in: 3600 }); }
      return json(400, { error: 'invalid_grant' });
    }
    if (u.pathname === '/mcp') {
      const auth = (req.headers.authorization || '').replace('Bearer ', '');
      if (!state.tokens.has(auth)) return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      const m = JSON.parse(body);
      if (!m.id) { res.writeHead(202); return res.end(); }
      let result;
      if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'figma-mock' } };
      else if (m.method === 'tools/call') {
        const { name, arguments: a } = m.params;
        state.calls.push([name, a]);
        let out;
        if (name === 'list_shaders') out = { items: Object.entries(SHADERS).map(([id, s]) => ({ id, name: s.name, type: s.type })), nextCursor: null };
        else if (name === 'get_shader') {
          const s = SHADERS[a.id];
          const v = a.version ?? s?.latest;
          if (!s || !s.versions[v]) { result = { content: [{ type: 'text', text: 'not found' }], isError: true }; }
          else out = { id: a.id, name: s.name, type: s.type, version: v, files: [{ filename: 'features.json', bytes: 2, ...(a.includeSource ? { source: '{}' } : {}) }, { filename: 'main.ts', bytes: 9, ...(a.includeSource ? { source: s.versions[v] } : {}) }] };
        }
        if (out) result = { content: [{ type: 'text', text: JSON.stringify(out) }] };
      }
      const reply = { jsonrpc: '2.0', id: m.id, result };
      if (state.sse) { res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' }); return res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`); }
      return json(200, reply, { 'mcp-session-id': 's1' });
    }
    res.writeHead(404); res.end();
  });
  return { srv, state };
}

let fig, figUrl, dir;
beforeAll(async () => {
  fig = mockFigma();
  await new Promise(r => fig.srv.listen(0, '127.0.0.1', r));
  figUrl = `http://127.0.0.1:${fig.srv.address().port}/mcp`;
  dir = mkdtempSync(join(tmpdir(), 'motion-shaders-'));
});
afterAll(() => { fig.srv.close(); rmSync(dir, { recursive: true, force: true }); });

/** follow the authorize redirect like a browser would, hand the callback query to the service */
async function signIn(svc) {
  const { url } = await svc.connect();
  expect(url).toMatch(/code_challenge_method=S256/);
  const r = await fetch(url, { redirect: 'manual' });
  const loc = new URL(r.headers.get('location'));
  expect(loc.pathname).toBe('/oauth/figma/callback');
  return svc.callback(loc.searchParams);
}

describe('figma shader sources (mocked figma mcp)', () => {
  it('signs in (discovery, registration, pkce), finds a shader by build sha, caches it for offline use', async () => {
    const secrets = fileSecrets(join(dir, 'auth.json'));
    const svc = createShaderSources({ cacheDir: join(dir, 'cache'), secrets, mcpUrl: figUrl, callbackUrl: () => 'http://127.0.0.1:9/oauth/figma/callback' });
    expect((await svc.status()).figma).toBe('disconnected');
    await expect(svc.resolve({ hash: 'h1', version: SHA_A, kind: 'fill' })).rejects.toThrow(/not connected/);
    expect(await signIn(svc)).toBe(true);
    expect(fig.state.registered).toBe(1);
    expect((await svc.status()).figma).toBe('connected');
    // the token expired (expires_in 1): the next call refreshes it
    await new Promise(r => setTimeout(r, 50));
    const s = await svc.resolve({ hash: 'hash-a', version: SHA_A, kind: 'fill', params: ['speed'] });
    expect(s).toMatchObject({ id: UUID_A, name: 'Stripes', kind: 'fill', version: SHA_A, via: 'figma' });
    expect(s.files['main.ts']).toContain('speed');
    expect(fig.state.refreshed).toBe(1);
    // an older build: get_shader with that version
    const old = await svc.resolve({ hash: 'hash-a', version: SHA_A_OLD, kind: 'fill' });
    expect(old.version).toBe(SHA_A_OLD);
    expect(fig.state.calls.some(([n, a]) => n === 'get_shader' && a.version === SHA_A_OLD && a.includeSource)).toBe(true);
    // offline: the cache answers, also for a fresh service (next app start)
    fig.state.down = true;
    const again = createShaderSources({ cacheDir: join(dir, 'cache'), secrets, mcpUrl: figUrl, callbackUrl: () => '' });
    expect(await again.resolve({ hash: 'hash-a', version: SHA_A })).toMatchObject({ via: 'cache', id: UUID_A });
    fig.state.down = false;
    // tokens never in plain sight of documents: only in the secret store
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toContain('tok-2');
  });

  it('server-sent-event replies, closest version when the build is gone', async () => {
    fig.state.sse = true;
    const secrets = fileSecrets(join(dir, 'auth2.json'));
    const svc = createShaderSources({ cacheDir: join(dir, 'cache2'), secrets, mcpUrl: figUrl, callbackUrl: () => 'http://127.0.0.1:9/oauth/figma/callback' });
    await signIn(svc);
    const s = await svc.resolve({ version: 'f'.repeat(40), kind: 'effect', params: ['amount'] });
    expect(s.id).toBe(UUID_B);
    expect(s.warning).toMatch(/not available/);
    fig.state.sse = false;
  });

  it('reports a refused client registration (third-party clients not allowed)', async () => {
    fig.state.rejectRegistration = true;
    const svc = createShaderSources({ cacheDir: join(dir, 'cache3'), secrets: fileSecrets(join(dir, 'auth3.json')), mcpUrl: figUrl, callbackUrl: () => 'http://127.0.0.1:9/cb' });
    await expect(svc.connect()).rejects.toThrow(/registration refused.*client not allowed/);
    fig.state.rejectRegistration = false;
  });

  it('claude code fallback: parses tool results from the cli stream (incl. results saved to a file)', async () => {
    const big = join(dir, 'big.txt');
    const reply = JSON.stringify({ id: UUID_B, name: 'Invert', type: 'effect', version: SHA_B, files: [{ filename: 'main.ts', source: SRC('amount') }] });
    (await import('node:fs')).writeFileSync(big, reply);
    const stream = [
      { type: 'system', subtype: 'init' },
      { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: `Error: result exceeds maximum allowed tokens. Output has been saved to ${big}.` }] }] } },
    ].map(x => JSON.stringify(x)).join('\n');
    expect(toolResultsFromStream(stream)).toEqual([reply]);
    // a fake cli process
    const { EventEmitter } = await import('node:events');
    const spawnImpl = (bin, args) => {
      const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
      expect(args).toContain('--allowedTools');
      expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__claude_ai_Figma__get_shader,mcp__claude_ai_Figma__list_shaders');
      setTimeout(() => { p.stdout.emit('data', stream); p.emit('close', 0); });
      return p;
    };
    const prov = claudeProvider({ spawnImpl, servers: ['claude.ai Figma'] });
    const cache = shaderCache(join(dir, 'cache4'));
    const s = await findShader(prov.call, { id: UUID_B, version: SHA_B }, cache);
    expect(s.files['main.ts']).toContain('amount');
  });

  it('bridge: websocket messages and the loopback callback route', async () => {
    const b = await startBridge({ port: 0, log: () => {}, dataDir: join(dir, 'bridge'), figmaMcpUrl: figUrl, claudeShaders: false });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws`);
      await new Promise(r => ws.on('open', r));
      const next = (type) => new Promise(r => { const f = (d) => { const m = JSON.parse(String(d)); if (m.type === type) { ws.off('message', f); r(m); } }; ws.on('message', f); });
      ws.send(JSON.stringify({ type: 'figma_connect' }));
      const c = await next('figma_connect');
      expect(c.url).toContain(`redirect_uri=${encodeURIComponent(`http://127.0.0.1:${b.port}/oauth/figma/callback`)}`);
      const r = await fetch(c.url, { redirect: 'manual' });
      const statusP = next('figma_status');
      const page = await fetch(r.headers.get('location'));
      expect(await page.text()).toContain('connected to Figma');
      expect((await statusP).figma).toBe('connected');
      ws.send(JSON.stringify({ type: 'shader_fetch', reqId: 7, req: { id: UUID_B, version: SHA_B } }));
      const res = await next('shader_fetch_result');
      expect(res).toMatchObject({ reqId: 7, ok: true });
      expect(res.shader.files['main.ts']).toContain('amount');
      ws.close();
    } finally { await b.close(); }
  });
});
