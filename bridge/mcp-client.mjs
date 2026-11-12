// Minimal MCP client for remote servers (streamable HTTP transport) with OAuth 2.1:
// protected-resource discovery (RFC 9728), authorization-server metadata (RFC 8414), dynamic client
// registration (RFC 7591), PKCE (S256), refresh tokens. Used to talk to Figma's remote MCP server
// (get_shader with source) from the bridge, so the app's renderer never handles tokens.
// Everything takes an injectable fetch (tests run it against a mocked endpoint).
import { createHash, randomBytes } from 'node:crypto';

export const PROTOCOL_VERSION = '2025-06-18';

export class AuthRequired extends Error {
  constructor(resourceMetadataUrl, message = 'authorization required') { super(message); this.name = 'AuthRequired'; this.resourceMetadataUrl = resourceMetadataUrl; }
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

/** resource_metadata="..." from a WWW-Authenticate header */
export function parseResourceMetadata(header) {
  const m = /resource_metadata="([^"]+)"/i.exec(header || '');
  return m ? m[1] : null;
}

async function getJson(fetchImpl, url) {
  const r = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** discovery: where to authorize for an mcp server url */
export async function discover(fetchImpl, serverUrl, resourceMetadataUrl) {
  const u = new URL(serverUrl);
  let prm = null;
  for (const cand of [resourceMetadataUrl, `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean)) {
    try { prm = await getJson(fetchImpl, cand); break; } catch { /* next */ }
  }
  const issuer = prm?.authorization_servers?.[0] ?? u.origin;
  const iu = new URL(issuer);
  let as = null;
  const path = iu.pathname === '/' ? '' : iu.pathname;
  for (const cand of [`${iu.origin}/.well-known/oauth-authorization-server${path}`, `${iu.origin}/.well-known/openid-configuration${path}`, `${iu.origin}${path}/.well-known/openid-configuration`]) {
    try { as = await getJson(fetchImpl, cand); break; } catch { /* next */ }
  }
  if (!as?.authorization_endpoint || !as?.token_endpoint) throw new Error(`no oauth metadata for ${serverUrl}`);
  return { resource: prm?.resource ?? serverUrl, scopes: prm?.scopes_supported, as };
}

/** dynamic client registration (public client, loopback redirect) */
export async function registerClient(fetchImpl, as, redirectUri, clientName = 'Motion') {
  if (!as.registration_endpoint) throw new Error('the server does not allow dynamic client registration');
  const r = await fetchImpl(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.client_id) throw new Error(`client registration refused (HTTP ${r.status}${body.error ? `: ${body.error}${body.error_description ? ' ' + body.error_description : ''}` : ''})`);
  return body;
}

export function authorizeUrl(as, { clientId, redirectUri, challenge, state, resource, scope }) {
  const u = new URL(as.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  if (resource) u.searchParams.set('resource', resource);
  if (scope) u.searchParams.set('scope', scope);
  return u.toString();
}

async function tokenRequest(fetchImpl, as, params) {
  const r = await fetchImpl(as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(params).toString() });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) throw new Error(`token request failed (HTTP ${r.status}${body.error ? `: ${body.error}` : ''})`);
  return { access_token: body.access_token, refresh_token: body.refresh_token ?? params.refresh_token, expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : 0 };
}
export const exchangeCode = (fetchImpl, as, { code, verifier, clientId, redirectUri, resource }) =>
  tokenRequest(fetchImpl, as, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri, ...(resource ? { resource } : {}) });
export const refreshToken = (fetchImpl, as, { refreshToken: rt, clientId, resource }) =>
  tokenRequest(fetchImpl, as, { grant_type: 'refresh_token', refresh_token: rt, client_id: clientId, ...(resource ? { resource } : {}) });

/** one response of a streamable-http POST: plain json or an sse stream carrying the json-rpc reply */
async function readRpc(r, id) {
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const text = await r.text();
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { const m = JSON.parse(data); if (m && m.id === id) return m; } catch { /* keep looking */ }
    }
    throw new Error('no json-rpc reply in the event stream');
  }
  if (r.status === 202) return null;
  return r.json();
}

/** an mcp session over streamable http. getToken() -> access token (or null) */
export class McpClient {
  constructor(url, { fetch: fetchImpl = globalThis.fetch, getToken = async () => null, clientInfo = { name: 'motion', version: '1' } } = {}) {
    this.url = url; this.fetch = fetchImpl; this.getToken = getToken; this.clientInfo = clientInfo;
    this.session = null; this.seq = 1; this.ready = null;
  }
  async post(msg) {
    const token = await this.getToken();
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION };
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.session) headers['mcp-session-id'] = this.session;
    const r = await this.fetch(this.url, { method: 'POST', headers, body: JSON.stringify(msg) });
    if (r.status === 401 || r.status === 403) {
      const www = r.headers.get('www-authenticate');
      this.ready = null; this.session = null;
      throw new AuthRequired(parseResourceMetadata(www), `the server asks for authorization (HTTP ${r.status})`);
    }
    if (r.status === 404 && this.session) { this.session = null; this.ready = null; throw new Error('mcp session expired'); }
    if (!r.ok && r.status !== 202) throw new Error(`mcp HTTP ${r.status}`);
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    return r;
  }
  async request(method, params) {
    const id = this.seq++;
    const r = await this.post({ jsonrpc: '2.0', id, method, params });
    const m = await readRpc(r, id);
    if (m?.error) throw new Error(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`);
    return m?.result;
  }
  async init() {
    if (!this.ready) {
      this.ready = (async () => {
        const res = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: this.clientInfo });
        await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
        return res;
      })();
      this.ready.catch(() => { this.ready = null; });
    }
    return this.ready;
  }
  /** tools/call -> the text of the result (joined), throws on isError */
  async callTool(name, args) {
    try { await this.init(); } catch (e) { if (String(e.message).includes('session expired')) await this.init(); else throw e; }
    const res = await this.request('tools/call', { name, arguments: args });
    const text = (res?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (res?.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
    return text;
  }
  async listTools() { await this.init(); return (await this.request('tools/list', {}))?.tools ?? []; }
}
