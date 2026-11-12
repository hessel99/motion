// Update logic without Electron: versions, manifest parsing, signatures, compatibility and the
// boot / rollback decision. Used by the app (electron/updates/*.cjs), the release scripts
// (scripts/release.mjs) and the tests (tests/updates-*.test.mjs). Only node:crypto, no deps.
'use strict';
const crypto = require('node:crypto');

// ---------------------------------------------------------------- versions
/** parse "1.2.3", "v1.2.3-beta.2" -> {major, minor, patch, pre: ['beta', 2]} | null */
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.').map(x => (/^\d+$/.test(x) ? +x : x)) : [] };
}

/** semver order: -1, 0, 1. invalid versions sort lowest. */
function compareVersions(a, b) {
  const A = parseVersion(a), B = parseVersion(b);
  if (!A || !B) return A ? 1 : B ? -1 : 0;
  for (const k of ['major', 'minor', 'patch']) if (A[k] !== B[k]) return A[k] < B[k] ? -1 : 1;
  // a release is newer than its prereleases
  if (!A.pre.length || !B.pre.length) return A.pre.length === B.pre.length ? 0 : A.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'number') return -1; // numeric identifiers sort before alphanumeric
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
const isPrerelease = v => !!parseVersion(v)?.pre.length;

// ---------------------------------------------------------------- signatures
// Ed25519. The public key is 32 raw bytes (base64) embedded in package.json "motionUpdates";
// the private key is a PKCS#8 PEM that only lives in CI secrets.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyFromBase64(b64) {
  const raw = Buffer.from(String(b64 || ''), 'base64');
  if (raw.length !== 32) throw new Error('update public key must be 32 bytes (base64)');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}
function publicKeyToBase64(key) {
  const der = key.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32)).toString('base64');
}
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey: publicKeyToBase64(publicKey), privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}
const privateKeyFromPem = pem => crypto.createPrivateKey(String(pem));

/** JSON with sorted keys and no whitespace: the exact bytes that get signed */
function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/** what an artifact signature covers: kind + version + platform + hash + size (the hash binds the bytes) */
function artifactStatement(kind, version, platform, hash, size) {
  return ['motion-update-v1', kind, version, platform || '-', hash, String(size)].join('\n');
}
const signText = (privateKey, text) => crypto.sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64');
function verifyText(publicKey, text, sigB64) {
  try {
    const sig = Buffer.from(String(sigB64 || ''), 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(text, 'utf8'), publicKey, sig);
  } catch { return false; }
}

// ---------------------------------------------------------------- manifest
// {
//   schema: 1, version, channel: 'stable'|'beta', date, notes, minShell,
//   ui: { url, sha256, size, sig },
//   shell: { 'darwin-arm64': { url, sha512, size, sig }, ... },
//   revoke: ['0.2.3'],            // UI bundles that must not run anymore (rollback)
//   sig                           // Ed25519 over canonicalJson(manifest without sig)
// }
const HEX = n => new RegExp(`^[0-9a-f]{${n}}$`);
const isUrl = s => typeof s === 'string' && /^(https?:\/\/|\.{0,2}\/|[\w.-]+$)/.test(s) && s.length < 2048;

/** validate shape. returns {ok:true, manifest} | {ok:false, error} (never throws) */
function parseManifest(input) {
  let m = input;
  try { if (typeof input === 'string' || Buffer.isBuffer(input)) m = JSON.parse(String(input)); } catch { return { ok: false, error: 'manifest is not valid JSON' }; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, error: 'manifest is not an object' };
  if (m.schema !== 1) return { ok: false, error: `unsupported manifest schema ${m.schema}` };
  if (!parseVersion(m.version)) return { ok: false, error: 'manifest version is invalid' };
  if (!parseVersion(m.minShell)) return { ok: false, error: 'manifest minShell is invalid' };
  if (compareVersions(m.minShell, m.version) > 0) return { ok: false, error: 'minShell is newer than the version' };
  if (m.notes !== undefined && typeof m.notes !== 'string') return { ok: false, error: 'notes must be text' };
  if (m.revoke !== undefined && (!Array.isArray(m.revoke) || !m.revoke.every(parseVersion))) return { ok: false, error: 'revoke must be a list of versions' };
  if (m.ui !== undefined) {
    const u = m.ui;
    if (!u || !isUrl(u.url) || !HEX(64).test(u.sha256) || !Number.isSafeInteger(u.size) || u.size <= 0 || typeof u.sig !== 'string') return { ok: false, error: 'ui bundle entry is invalid' };
  }
  if (m.shell !== undefined) {
    if (!m.shell || typeof m.shell !== 'object') return { ok: false, error: 'shell entry is invalid' };
    for (const [plat, a] of Object.entries(m.shell)) {
      if (!/^(darwin|win32|linux)-(arm64|x64)$/.test(plat)) return { ok: false, error: `unknown shell platform ${plat}` };
      if (!a || !isUrl(a.url) || !HEX(128).test(a.sha512) || !Number.isSafeInteger(a.size) || a.size <= 0 || typeof a.sig !== 'string') return { ok: false, error: `shell entry ${plat} is invalid` };
    }
  }
  if (typeof m.sig !== 'string') return { ok: false, error: 'manifest is not signed' };
  return { ok: true, manifest: m };
}

function signManifest(manifest, privateKey) {
  const out = { ...manifest };
  delete out.sig;
  if (out.ui) out.ui = { ...out.ui, sig: signText(privateKey, artifactStatement('ui', out.version, null, out.ui.sha256, out.ui.size)) };
  if (out.shell) {
    out.shell = Object.fromEntries(Object.entries(out.shell).map(([plat, a]) => [plat, { ...a, sig: signText(privateKey, artifactStatement('shell', out.version, plat, a.sha512, a.size)) }]));
  }
  out.sig = signText(privateKey, canonicalJson(out));
  return out;
}

/** checks the manifest signature and every artifact signature. returns null when fine, else the reason */
function verifyManifest(manifest, publicKey) {
  const { sig, ...rest } = manifest;
  if (!verifyText(publicKey, canonicalJson(rest), sig)) return 'manifest signature does not match';
  if (manifest.ui && !verifyText(publicKey, artifactStatement('ui', manifest.version, null, manifest.ui.sha256, manifest.ui.size), manifest.ui.sig)) return 'ui bundle signature does not match';
  for (const [plat, a] of Object.entries(manifest.shell || {})) {
    if (!verifyText(publicKey, artifactStatement('shell', manifest.version, plat, a.sha512, a.size), a.sig)) return `shell ${plat} signature does not match`;
  }
  return null;
}

/** parse + verify. {ok, manifest} | {ok:false, error} */
function readManifest(input, publicKey) {
  const p = parseManifest(input);
  if (!p.ok) return p;
  const err = verifyManifest(p.manifest, publicKey);
  return err ? { ok: false, error: err } : p;
}

/** resolve a manifest url relative to the manifest location (lets local test releases use plain file names) */
function resolveUrl(url, base) {
  try { return new URL(url, base).href; } catch { return url; }
}

/** beta users see beta and stable manifests; take the newest. stable users only see stable. */
function pickManifest(list, channel) {
  const ok = list.filter(m => m && (channel === 'beta' || !isPrerelease(m.version)));
  ok.sort((a, b) => compareVersions(b.version, a.version));
  return ok[0] || null;
}

// ---------------------------------------------------------------- decisions
/**
 * what to do with a (verified) manifest.
 * env: { shellVersion, uiVersion (the UI that runs now), platform: 'darwin-arm64', bad: [versions],
 *        shellUpdates: bool (can this install replace itself) }
 * -> { action: 'none' | 'ui' | 'shell' | 'shell-unavailable', version, reason }
 */
function decideUpdate(manifest, env) {
  const v = manifest.version;
  if (compareVersions(v, env.uiVersion) <= 0 && compareVersions(v, env.shellVersion) <= 0) return { action: 'none', version: v, reason: 'up to date' };
  if ((env.bad || []).includes(v)) return { action: 'none', version: v, reason: `${v} failed to start before and is skipped` };
  const shellOk = compareVersions(env.shellVersion, manifest.minShell) >= 0;
  if (shellOk && manifest.ui) {
    if (compareVersions(v, env.uiVersion) <= 0) return { action: 'none', version: v, reason: 'up to date' };
    return { action: 'ui', version: v, reason: 'interface update' };
  }
  // the new UI needs a newer app shell (Electron, main process, bridge or native parts changed)
  const art = manifest.shell && manifest.shell[env.platform];
  if (!art) return { action: 'shell-unavailable', version: v, reason: `no app download for ${env.platform}` };
  if (!env.shellUpdates) return { action: 'shell-unavailable', version: v, reason: env.shellBlocked || 'this install cannot update itself' };
  return { action: 'shell', version: v, reason: 'full app update' };
}

/**
 * which renderer to load at startup.
 * state: { active, pending, previous: {version, dir, minShell} | null, bad: [versions], good: [versions], boot: {version, attempts} | null }
 * previous is the last bundle that started fine before active: the first fallback when active fails.
 * env: { shellVersion, bundledVersion, revoked: [versions], maxAttempts }
 * -> { source: 'bundled' | 'downloaded', version, dir?, state (new state to persist), dropped: [{version, reason}] }
 * A downloaded bundle runs only when it is newer than the bundled one, compatible with this shell,
 * not revoked, not marked bad and has not failed to signal 'app-ready' maxAttempts times in a row.
 */
function decideBoot(state, env) {
  const s = { active: null, pending: null, bad: [], boot: null, ...(state || {}) };
  s.bad = [...(s.bad || [])];
  const maxAttempts = env.maxAttempts || 2;
  const dropped = [];
  const usable = (b, why) => {
    if (!b || !b.version || !b.dir) return false;
    let reason = null;
    if (compareVersions(b.version, env.bundledVersion) <= 0) reason = 'older than the built-in interface';
    else if (b.minShell && compareVersions(env.shellVersion, b.minShell) < 0) reason = `needs app ${b.minShell}`;
    else if ((env.revoked || []).includes(b.version)) reason = 'withdrawn by the publisher';
    else if (s.bad.includes(b.version)) reason = 'failed to start before';
    if (reason) { dropped.push({ version: b.version, reason, slot: why }); return false; }
    return true;
  };
  // a pending (freshly downloaded) bundle replaces the active one
  if (s.pending) {
    if (usable(s.pending, 'pending')) {
      // keep the last bundle that started fine as the first fallback
      if (s.active && s.active.version !== s.pending.version && (s.good || []).includes(s.active.version)) s.previous = s.active;
      s.active = s.pending;
      s.boot = null;
    }
    s.pending = null;
  }
  // failed boots: the previous launch(es) never reached 'app-ready'
  if (s.active && s.boot && s.boot.version === s.active.version && s.boot.attempts >= maxAttempts) {
    if (!s.bad.includes(s.active.version)) s.bad.push(s.active.version);
    dropped.push({ version: s.active.version, reason: 'did not start', slot: 'active' });
    s.active = null;
    s.boot = null;
  }
  if (s.active && !usable(s.active, 'active')) s.active = null;
  if (!s.active && s.previous) {
    if (usable(s.previous, 'previous')) s.active = s.previous;
    s.previous = null;
  }
  if (!s.active) { s.boot = null; return { source: 'bundled', version: env.bundledVersion, state: s, dropped }; }
  const attempts = s.boot && s.boot.version === s.active.version ? s.boot.attempts : 0;
  s.boot = { version: s.active.version, attempts: attempts + 1 };
  return { source: 'downloaded', version: s.active.version, dir: s.active.dir, state: s, dropped };
}

/** the renderer said 'app-ready': the running bundle is good */
function markBootGood(state) {
  return { ...state, boot: null, good: [...new Set([...(state.good || []), state.active?.version].filter(Boolean))] };
}
/** the running downloaded bundle failed (timeout / crash): never use it again */
function markBootBad(state, version) {
  const bad = [...new Set([...(state.bad || []), version])];
  return { ...state, bad, boot: null, active: state.active && state.active.version === version ? null : state.active };
}

/** zip entry names must stay inside the target folder */
function safeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 512) return null;
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').some(p => p === '..') || n.includes('\0')) return null;
  return n;
}

module.exports = {
  parseVersion, compareVersions, isPrerelease,
  publicKeyFromBase64, publicKeyToBase64, generateKeyPair, privateKeyFromPem,
  canonicalJson, artifactStatement, signText, verifyText,
  parseManifest, signManifest, verifyManifest, readManifest, resolveUrl, pickManifest,
  decideUpdate, decideBoot, markBootGood, markBootBad, safeEntryName,
};
