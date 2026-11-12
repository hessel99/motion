// Figma shader sources for pasted designs. Figma's clipboard / REST / plugin data carry a shader's
// identity ("<hash>/<build sha>") and its param values, never its source; the source comes from
// Figma's MCP server (get_shader with includeSource). This module finds it and keeps an app-level
// cache (one folder per shader@build), so the next paste is instant and works offline.
//
// providers, tried in order:
//  1. figma: Motion's own MCP client to Figma's remote server (OAuth 2.1, PKCE, dynamic client
//     registration, loopback redirect to this bridge). tokens live in the secret store only.
//  2. claude: the user's Claude Code CLI and the Figma MCP server it has configured (one headless
//     turn that makes the tool calls; slower, needs no extra login)
//  3. none: the editor asks for the files (Import shader…)
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { McpClient, AuthRequired, discover, registerClient, authorizeUrl, exchangeCode, refreshToken, pkcePair } from './mcp-client.mjs';

export const FIGMA_MCP_URL = process.env.MOTION_FIGMA_MCP_URL || 'https://mcp.figma.com/mcp';
const SHA = /^[0-9a-f]{40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------- secrets (tokens): encrypted with electron safeStorage when available ----------------

/** box: {encrypt(string) -> Buffer, decrypt(Buffer) -> string} (electron safeStorage) or null (dev: a 0600 file) */
export function fileSecrets(file, box = null) {
  let data = null;
  const load = () => {
    if (data) return data;
    try {
      const raw = fs.readFileSync(file);
      data = JSON.parse(box ? box.decrypt(raw) : raw.toString('utf8'));
    } catch { data = {}; }
    return data;
  };
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify(data);
    fs.writeFileSync(file, box ? box.encrypt(text) : text, { mode: 0o600 });
  };
  return {
    encrypted: !!box,
    get: (k) => load()[k],
    set: (k, v) => { load()[k] = v; save(); },
    del: (k) => { delete load()[k]; save(); },
  };
}

// ---------------- app cache ----------------

export function shaderCache(dir) {
  const indexFile = path.join(dir, 'index.json');
  let index = null;
  const idx = () => {
    if (index) return index;
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { index = {}; }
    index.bySha ??= {}; index.byHash ??= {}; index.shaders ??= {};
    return index;
  };
  const saveIndex = () => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(indexFile, JSON.stringify(index, null, 1)); };
  const safe = (s) => String(s).replace(/[^\w.@-]/g, '_');
  return {
    dir,
    /** {id, name, kind, version, files} | null */
    get(sha, id) {
      const i = idx();
      const folder = sha ? i.bySha[sha] : id && i.shaders[id]?.version && i.bySha[i.shaders[id].version];
      if (!folder) return null;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, folder, 'meta.json'), 'utf8'));
        const files = {};
        for (const f of meta.files) files[f] = fs.readFileSync(path.join(dir, folder, safe(f)), 'utf8');
        return { id: meta.id, name: meta.name, kind: meta.kind, version: meta.version, files };
      } catch { return null; }
    },
    put(s) {
      const folder = `${safe(s.id)}@${safe(s.version ?? 'latest')}`;
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
      for (const [f, text] of Object.entries(s.files)) fs.writeFileSync(path.join(dir, folder, safe(f)), text);
      fs.writeFileSync(path.join(dir, folder, 'meta.json'), JSON.stringify({ id: s.id, name: s.name, kind: s.kind, version: s.version, files: Object.keys(s.files) }));
      const i = idx();
      if (s.version) i.bySha[s.version] = folder;
      if (s.hash) i.byHash[s.hash] = s.id;
      saveIndex();
    },
    /** what list_shaders / manifests told us (id -> {name, kind, version}) */
    known: () => idx().shaders,
    note(id, info) { const i = idx(); i.shaders[id] = { ...i.shaders[id], ...info }; saveIndex(); },
    hashToId: (h) => idx().byHash[h],
  };
}

// ---------------- providers: something that can call figma mcp tools ----------------

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

/** the get_shader / list_shaders replies (json in the text content) */
async function listShaders(call) {
  const out = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const r = parseJson(await call('list_shaders', cursor ? { cursor } : {}));
    if (!r) break;
    out.push(...(r.items ?? []));
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
}

/** find + fetch one shader's source. req: {id?, hash?, version?, kind?, name?, params?: string[]} */
export async function findShader(call, req, cache, log = () => {}) {
  const want = req.version && SHA.test(req.version) ? req.version : null;
  const fetchSrc = async (id, version) => {
    const r = parseJson(await call('get_shader', { id, includeSource: true, ...(version ? { version } : {}) }));
    if (!r?.files?.length || !r.files.some(f => typeof f.source === 'string')) throw new Error(`get_shader ${id}: no source in the reply`);
    const files = {};
    for (const f of r.files) if (typeof f.source === 'string') files[f.filename] = f.source;
    return { id: r.id ?? id, name: r.name, kind: r.type, version: r.version ?? version, description: r.description, files };
  };
  let candidates;
  if (req.id && UUID.test(req.id)) candidates = [{ id: req.id }];
  else if (req.hash && cache.hashToId(req.hash)) candidates = [{ id: cache.hashToId(req.hash) }];
  else {
    const list = await listShaders(call);
    for (const s of list) cache.note(s.id, { name: s.name, kind: s.type });
    candidates = list.filter(s => !req.kind || s.type === req.kind);
    // a name (when the paste has one) goes first
    if (req.name) candidates.sort((a, b) => (b.name === req.name) - (a.name === req.name));
  }
  // 1. the exact build: its latest version, or that version of it
  for (const c of candidates) {
    let latest = cache.known()[c.id]?.version;
    if (!latest) {
      const m = parseJson(await call('get_shader', { id: c.id }));
      latest = m?.version;
      if (m) cache.note(c.id, { name: m.name, kind: m.type, version: m.version });
    }
    if (!want || latest === want) return { ...(await fetchSrc(c.id, want ?? undefined)), exact: true };
  }
  if (want) {
    for (const c of candidates) {
      try {
        const m = parseJson(await call('get_shader', { id: c.id, version: want }));
        if (m && (m.version === want || !m.version)) return { ...(await fetchSrc(c.id, want)), exact: true };
      } catch { /* not this one */ }
    }
  }
  // 2. the closest: the candidate whose params match the paste's param names best (latest build)
  if (req.params?.length) {
    let best = null, bestScore = 0;
    for (const c of candidates.slice(0, 60)) {
      let src;
      try { src = await fetchSrc(c.id); } catch { continue; }
      cache.put(src);
      const main = src.files['main.ts'] ?? '';
      const score = req.params.filter(p => new RegExp(`["']?\\b${p.replace(/[^\w]/g, '')}\\b["']?\\s*:`).test(main)).length / req.params.length;
      if (score > bestScore) { bestScore = score; best = src; }
      if (score === 1) break;
    }
    if (best && bestScore >= 0.6) { log(`[shaders] ${req.version}: build not found, using ${best.name} @${best.version}`); return { ...best, exact: false }; }
  }
  throw new Error(`no shader in the connected Figma library matches ${req.name ?? req.hash ?? req.id ?? ''}@${req.version ?? '?'}`);
}

// ---------------- claude code cli as a provider ----------------

/** tool results (text) of a `claude -p --output-format stream-json` run, in order; large results the
 *  cli saved to a file are read back */
export function toolResultsFromStream(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = parseJson(line.trim());
    if (m?.type !== 'user' || !Array.isArray(m.message?.content)) continue;
    for (const c of m.message.content) {
      if (c?.type !== 'tool_result') continue;
      let t = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.filter(x => x?.type === 'text').map(x => x.text).join('\n') : '';
      const saved = /saved to (\/[^\s'"]+?\.(?:txt|json))/.exec(t);
      if (saved) { try { t = fs.readFileSync(saved[1], 'utf8'); } catch { /* keep the note */ } }
      out.push(t);
    }
  }
  return out;
}

/** figma mcp server names configured in the user's claude code */
export async function claudeFigmaServers(bin = 'claude', env = process.env) {
  const text = await new Promise((res) => execFile(bin, ['mcp', 'list'], { env, timeout: 30_000 }, (e, so) => res(e ? '' : String(so))));
  return text.split('\n').map(l => /^([^:]+):/.exec(l.trim())?.[1]?.trim()).filter(n => n && /figma/i.test(n));
}

/** a provider that runs one claude turn for a batch of calls ([{tool, args}]) */
export function claudeProvider({ bin = 'claude', env = process.env, spawnImpl = spawn, servers = null, log = () => {} } = {}) {
  let names = servers;
  const run = async (calls) => {
    names ??= await claudeFigmaServers(bin, env);
    if (!names.length) throw new Error('Claude Code has no Figma MCP server configured');
    const prefix = `mcp__${names[0].replace(/[^\w-]/g, '_')}__`;
    const prompt = 'Make exactly these MCP tool calls, in this order, with exactly these arguments, then stop. Do not summarize the results.\n'
      + calls.map((c, i) => `${i + 1}. ${prefix}${c.tool} ${JSON.stringify(c.args)}`).join('\n');
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', String(calls.length + 4), '--allowedTools', `${prefix}get_shader,${prefix}list_shaders`];
    log(`[shaders] claude: ${calls.length} figma call(s)`);
    const text = await new Promise((res, rej) => {
      const child = spawnImpl(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', rej);
      child.on('close', code => (code === 0 || out ? res(out) : rej(new Error(`claude exited ${code}: ${err.slice(-300)}`))));
    });
    const results = toolResultsFromStream(text);
    if (results.length < calls.length) throw new Error(`claude made ${results.length} of ${calls.length} calls`);
    return results.slice(-calls.length);
  };
  // findShader calls tools one by one: each becomes a (cached) one-call turn
  return { name: 'claude', call: async (tool, args) => (await run([{ tool, args }]))[0], run };
}

// ---------------- the service ----------------

export function createShaderSources({ cacheDir, secrets, fetchImpl = globalThis.fetch, mcpUrl = FIGMA_MCP_URL, callbackUrl, log = () => {}, claude = null }) {
  const cache = shaderCache(cacheDir);
  const tokenKey = `oauth:${mcpUrl}`;
  let pending = null; // {state, verifier, clientId, as, resource, redirectUri}
  let lastError = '';
  const saved = () => secrets.get(tokenKey) ?? null;

  const getToken = async () => {
    const t = saved();
    if (!t?.access_token) return null;
    if (t.expires_at && t.expires_at < Date.now() + 30_000 && t.refresh_token) {
      try {
        const fresh = await refreshToken(fetchImpl, t.as, { refreshToken: t.refresh_token, clientId: t.clientId, resource: t.resource });
        secrets.set(tokenKey, { ...t, ...fresh });
        return fresh.access_token;
      } catch (e) { log(`[shaders] token refresh failed: ${e.message}`); }
    }
    return t.access_token;
  };
  const client = new McpClient(mcpUrl, { fetch: fetchImpl, getToken, clientInfo: { name: 'motion', version: '1' } });
  const figmaCall = (tool, args) => client.callTool(tool, args);

  async function connect() {
    const redirectUri = callbackUrl();
    let resourceMeta = null;
    try { await client.init(); return { url: null, connected: true }; } catch (e) { if (e instanceof AuthRequired) resourceMeta = e.resourceMetadataUrl; else throw e; }
    const d = await discover(fetchImpl, mcpUrl, resourceMeta);
    // a registered client is reused (per redirect uri: the bridge port can change)
    let reg = secrets.get(`client:${mcpUrl}`);
    if (!reg || reg.redirectUri !== redirectUri) {
      const r = await registerClient(fetchImpl, d.as, redirectUri);
      reg = { clientId: r.client_id, redirectUri };
      secrets.set(`client:${mcpUrl}`, reg);
    }
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString('hex');
    pending = { state, verifier, clientId: reg.clientId, as: d.as, resource: d.resource, redirectUri };
    return { url: authorizeUrl(d.as, { clientId: reg.clientId, redirectUri, challenge, state, resource: d.resource, scope: d.scopes?.join(' ') }), connected: false };
  }

  /** the browser came back to the loopback redirect */
  async function callback(query) {
    if (!pending || query.get('state') !== pending.state) throw new Error('unexpected sign-in response (state mismatch)');
    if (query.get('error')) throw new Error(`Figma refused: ${query.get('error_description') ?? query.get('error')}`);
    const p = pending;
    pending = null;
    const tok = await exchangeCode(fetchImpl, p.as, { code: query.get('code'), verifier: p.verifier, clientId: p.clientId, redirectUri: p.redirectUri, resource: p.resource });
    secrets.set(tokenKey, { ...tok, as: p.as, clientId: p.clientId, resource: p.resource });
    client.ready = null; client.session = null;
    await client.init();
    lastError = '';
    return true;
  }

  async function status() {
    const out = { figma: saved()?.access_token ? 'connected' : 'disconnected', claude: false, encrypted: !!secrets.encrypted, error: lastError, cacheDir };
    if (claude) { try { out.claude = (await claudeFigmaServers()).length > 0; } catch { /* no cli */ } }
    return out;
  }

  /** req -> {id, name, kind, version, files, via, warning?} */
  async function resolve(req) {
    const hit = cache.get(req.version, req.id);
    if (hit) return { ...hit, via: 'cache' };
    const errors = [];
    const providers = [];
    if (saved()?.access_token) providers.push({ name: 'figma', call: figmaCall });
    if (claude) providers.push(claude);
    for (const p of providers) {
      try {
        const s = await findShader(p.call, req, cache, log);
        cache.put({ ...s, hash: req.hash });
        // exact build cached under the requested sha too (the reply may omit its version)
        if (s.exact && req.version && s.version !== req.version) cache.put({ ...s, version: req.version, hash: req.hash });
        return { id: s.id, name: s.name, kind: s.kind, version: s.version, files: s.files, via: p.name, warning: s.exact ? undefined : `Figma build ${String(req.version).slice(0, 8)} is not available: using the current version` };
      } catch (e) {
        if (e instanceof AuthRequired) { secrets.del(tokenKey); lastError = 'Figma sign-in expired'; }
        errors.push(`${p.name}: ${e.message}`);
      }
    }
    throw new Error(providers.length ? errors.join('; ') : 'not connected to Figma (Settings → Connections), and no Claude Code Figma server');
  }

  return {
    connect, callback, status, resolve, cache,
    disconnect: () => { secrets.del(tokenKey); client.ready = null; client.session = null; },
    /** a shader the user imported by hand (or from a document) joins the cache */
    put: (s) => cache.put(s),
  };
}
