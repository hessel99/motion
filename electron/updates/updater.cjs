// The updater without Electron: check the feed, download + verify + install UI bundles, download +
// verify + stage shell (full app) updates. electron/updates/index.cjs wires it to the app; the
// tests drive it directly in node against a local fake release (tests/updates-integration.test.mjs).
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./core.cjs');

const UI_MAX_BYTES = 200 * 1024 * 1024;
const SHELL_MAX_BYTES = 1024 * 1024 * 1024;

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}
function writeJsonAtomicSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * download url into file while hashing. fetchImpl is Electron's net.fetch in the app (system proxy
 * and certificates), global fetch in tests. Checks the size limit while streaming.
 * -> { size, sha256, sha512 } (hex)
 */
async function download(fetchImpl, url, file, { maxBytes, expectedSize, onProgress, signal } = {}) {
  const res = await fetchImpl(url, { signal, redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const total = expectedSize || Number(res.headers.get('content-length')) || 0;
  const h256 = crypto.createHash('sha256'), h512 = crypto.createHash('sha512');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(file);
  let size = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > (maxBytes || Infinity) || (expectedSize && size > expectedSize)) throw new Error('download is larger than expected');
      h256.update(value); h512.update(value);
      if (!out.write(value)) await new Promise(r => out.once('drain', r));
      onProgress && onProgress(size, total);
    }
  } catch (e) {
    out.destroy();
    await fsp.rm(file, { force: true });
    throw e;
  }
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  return { size, sha256: h256.digest('hex'), sha512: h512.digest('hex') };
}

/** unzip a UI bundle (flat files, no symlinks) with fflate into dir. rejects unsafe paths. */
function extractUiZip(buf, dir) {
  const { unzipSync } = require('fflate');
  const files = unzipSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const names = Object.keys(files);
  if (!names.includes('index.html')) throw new Error('bundle has no index.html');
  for (const name of names) {
    const safe = core.safeEntryName(name);
    if (!safe) throw new Error(`unsafe path in bundle: ${name}`);
    if (safe.endsWith('/')) continue;
    const target = path.join(dir, safe);
    if (!target.startsWith(dir + path.sep)) throw new Error(`unsafe path in bundle: ${name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, files[name]);
  }
}

const SAFE_VERSION = v => /^[0-9A-Za-z.+-]+$/.test(v) && !v.includes('..');

class Updater {
  /**
   * opts: {
   *   userData, fetch, publicKey (KeyObject), feedUrls: (channel) => [urls], shellVersion, bundledVersion,
   *   platform ('darwin-arm64'), shell: { supported, blocked?, stage(file, manifest, art) -> Promise<{appPath}> } | null,
   *   log?, now?
   * }
   */
  constructor(opts) {
    this.o = opts;
    this.dir = path.join(opts.userData, 'updates');
    this.uiRoot = path.join(opts.userData, 'ui');
    this.stateFile = path.join(this.uiRoot, 'state.json');
    this.prefsFile = path.join(this.dir, 'prefs.json');
    this.log = opts.log || (() => {});
    this.listeners = new Set();
    this.busy = new Set();
    this.inflight = null;
    this.status = {
      phase: 'idle', // idle | checking | downloading | ready | up-to-date | error
      shellVersion: opts.shellVersion, bundledVersion: opts.bundledVersion,
      uiVersion: opts.bundledVersion, uiSource: 'bundled',
      channel: 'stable', auto: true, lastCheck: 0,
      progress: null, available: null, ready: null, error: null, notice: null,
      shellSupported: !!(opts.shell && opts.shell.supported), shellBlocked: opts.shell?.blocked || null,
    };
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  set(patch) { Object.assign(this.status, patch); for (const f of this.listeners) { try { f(this.status); } catch { /* */ } } }
  getStatus() { return { ...this.status }; }

  // ------------------------------------------------------------ state + prefs
  readStateSync() { try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; } }
  writeStateSync(s) { writeJsonAtomicSync(this.stateFile, s); }
  async loadPrefs() {
    const p = await readJson(this.prefsFile, {});
    this.set({ channel: p.channel === 'beta' ? 'beta' : 'stable', auto: p.auto !== false, lastCheck: p.lastCheck || 0 });
  }
  async savePrefs(patch = {}) {
    if (patch.channel !== undefined) patch.channel = patch.channel === 'beta' ? 'beta' : 'stable';
    if (patch.auto !== undefined) patch.auto = !!patch.auto;
    this.set(patch);
    await writeJsonAtomic(this.prefsFile, { channel: this.status.channel, auto: this.status.auto, lastCheck: this.status.lastCheck });
  }

  /**
   * startup: decide which renderer to load (sync, before the window opens).
   * revoked: versions withdrawn by the last seen manifest. -> { source, version, indexHtml? }
   */
  boot({ maxAttempts = 2 } = {}) {
    const st = this.readStateSync();
    const d = core.decideBoot(st, { shellVersion: this.o.shellVersion, bundledVersion: this.o.bundledVersion, revoked: st.revoked || [], maxAttempts });
    for (const x of d.dropped) this.log(`ui ${x.version} not used: ${x.reason}`);
    const failed = d.dropped.find(x => x.reason === 'did not start');
    this.writeStateSync(d.state);
    this.bootVersion = d.source === 'downloaded' ? d.version : null;
    this.set({
      uiVersion: d.version, uiSource: d.source,
      notice: failed ? { kind: 'rolled-back', version: failed.version, text: `Motion ${failed.version} did not start, so the previous version is used.` } : null,
    });
    this.cleanupSoon(d.state);
    if (d.source === 'bundled') return { source: 'bundled', version: d.version };
    return { source: 'downloaded', version: d.version, indexHtml: path.join(this.uiRoot, d.dir, 'index.html') };
  }

  /** the renderer signalled 'app-ready' */
  appReady() {
    if (!this.bootVersion) return;
    const st = this.readStateSync();
    if (st.active?.version !== this.bootVersion) return;
    this.writeStateSync(core.markBootGood(st));
    this.log(`ui ${this.bootVersion} started fine`);
  }

  /** the downloaded renderer failed (no app-ready in time, crash, load error): mark bad, switch to bundled */
  bootFailed(reason) {
    const v = this.bootVersion;
    if (!v) return false;
    this.writeStateSync(core.markBootBad(this.readStateSync(), v));
    this.bootVersion = null;
    this.log(`ui ${v} failed (${reason}), rolling back to the built-in interface`);
    this.set({ uiVersion: this.o.bundledVersion, uiSource: 'bundled', notice: { kind: 'rolled-back', version: v, text: `Motion ${v} did not start (${reason}), so the previous version is used.` } });
    return true;
  }

  /** forget downloaded UI bundles (Settings → "Use built-in version"). takes effect on the next start. */
  revertUi() {
    const st = this.readStateSync();
    const bad = st.active ? [...new Set([...(st.bad || []), st.active.version])] : st.bad || [];
    this.writeStateSync({ ...st, active: null, pending: null, boot: null, bad });
    if (this.status.ready?.kind === 'ui') this.set({ ready: null, phase: 'idle' });
  }

  cleanupSoon(state) {
    setTimeout(() => this.cleanup(state).catch(() => {}), 10_000).unref?.();
  }
  /** remove bundle folders that are neither active nor pending */
  async cleanup(state = this.readStateSync()) {
    const keep = new Set([state.active?.dir, state.pending?.dir].filter(Boolean));
    let names = [];
    try { names = await fsp.readdir(this.uiRoot); } catch { return; }
    for (const n of names) {
      if (keep.has(n)) continue;
      const p = path.join(this.uiRoot, n);
      try { if ((await fsp.stat(p)).isDirectory()) await fsp.rm(p, { recursive: true, force: true }); } catch { /* */ }
    }
  }

  // ------------------------------------------------------------ check + download
  setBusy(reason, on) {
    on ? this.busy.add(reason) : this.busy.delete(reason);
    this.set({ busy: [...this.busy] });
  }

  /** fetch all feeds for the channel, verify, pick the newest. -> manifest | null */
  async fetchManifest() {
    const urls = this.o.feedUrls(this.status.channel);
    const found = [];
    let lastErr = null;
    for (const url of urls) {
      try {
        const res = await this.o.fetch(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
        if (res.status === 404) continue; // e.g. no beta feed yet
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (text.length > 1024 * 1024) throw new Error('manifest too large');
        const r = core.readManifest(text, this.o.publicKey);
        if (!r.ok) throw new Error(r.error);
        r.manifest.__base = res.url || url;
        found.push(r.manifest);
      } catch (e) {
        lastErr = e;
        this.log(`feed ${url}: ${e.message}`);
      }
    }
    if (!found.length && lastErr) throw lastErr;
    return core.pickManifest(found, this.status.channel);
  }

  /** check (and download in the background). manual: user clicked "Check for updates". */
  check({ manual = false } = {}) {
    if (this.inflight) return this.inflight;
    if (!manual && this.busy.size) { this.log('check deferred: busy'); return Promise.resolve(this.getStatus()); }
    this.inflight = this._check(manual).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async _check(manual) {
    this.set({ phase: 'checking', error: null });
    try {
      const m = await this.fetchManifest();
      const now = (this.o.now || Date.now)();
      await this.savePrefs({ lastCheck: now });
      if (!m) { this.set({ phase: 'up-to-date', available: null }); return this.getStatus(); }
      // remember revocations even when there is nothing new: the next start drops withdrawn bundles
      const st = this.readStateSync();
      const revoked = m.revoke || [];
      if (JSON.stringify(st.revoked || []) !== JSON.stringify(revoked)) this.writeStateSync({ ...st, revoked });
      const effectiveUi = this.status.ready?.kind === 'ui' ? this.status.ready.version : this.status.uiVersion;
      if (st.active && revoked.includes(st.active.version) && this.status.uiSource === 'downloaded') {
        this.set({ notice: { kind: 'revoked', version: st.active.version, text: `Motion ${st.active.version} was withdrawn. Restart to go back to a safe version.` } });
      }
      const d = core.decideUpdate(m, {
        shellVersion: this.o.shellVersion, uiVersion: effectiveUi, platform: this.o.platform, bad: st.bad || [],
        shellUpdates: !!(this.o.shell && this.o.shell.supported), shellBlocked: this.o.shell?.blocked,
      });
      const info = { version: m.version, notes: m.notes || '', date: m.date || null, kind: d.action === 'ui' ? 'ui' : 'shell' };
      if (this.status.ready && core.compareVersions(this.status.ready.version, m.version) >= 0) { this.set({ phase: 'ready' }); return this.getStatus(); }
      if (d.action === 'none') { this.set({ phase: 'up-to-date', available: null }); return this.getStatus(); }
      if (d.action === 'shell-unavailable') {
        this.set({ phase: 'error', available: { ...info, manual: true }, error: `Motion ${m.version} needs a new app download: ${d.reason}.` });
        return this.getStatus();
      }
      this.set({ available: info });
      if (d.action === 'ui') await this.downloadUi(m, info);
      else await this.downloadShell(m, info);
      return this.getStatus();
    } catch (e) {
      this.log(`check failed: ${e && e.stack || e}`);
      this.set({ phase: 'error', progress: null, error: manual ? `Could not check for updates: ${e.message}` : `Last check failed: ${e.message}` });
      return this.getStatus();
    }
  }

  async downloadUi(m, info) {
    if (!SAFE_VERSION(m.version)) throw new Error('bad version');
    const url = core.resolveUrl(m.ui.url, m.__base);
    const tmpZip = path.join(this.dir, `ui-${m.version}.zip.part`);
    this.set({ phase: 'downloading', progress: { received: 0, total: m.ui.size } });
    const got = await download(this.o.fetch, url, tmpZip, {
      maxBytes: UI_MAX_BYTES, expectedSize: m.ui.size,
      onProgress: (received, total) => this.set({ progress: { received, total } }),
    });
    if (got.size !== m.ui.size || got.sha256 !== m.ui.sha256) { await fsp.rm(tmpZip, { force: true }); throw new Error('downloaded interface does not match its checksum'); }
    const dirName = m.version;
    const target = path.join(this.uiRoot, dirName);
    const tmpDir = path.join(this.uiRoot, `${dirName}.tmp-${process.pid}`);
    await fsp.rm(tmpDir, { recursive: true, force: true });
    await fsp.mkdir(tmpDir, { recursive: true });
    try {
      extractUiZip(await fsp.readFile(tmpZip), tmpDir);
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.rename(tmpDir, target);
    } catch (e) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      throw e;
    } finally {
      await fsp.rm(tmpZip, { force: true });
    }
    const st = this.readStateSync();
    this.writeStateSync({ ...st, pending: { version: m.version, dir: dirName, minShell: m.minShell } });
    this.set({ phase: 'ready', progress: null, ready: { ...info, kind: 'ui' } });
    this.log(`ui ${m.version} downloaded and verified`);
  }

  async downloadShell(m, info) {
    if (!SAFE_VERSION(m.version)) throw new Error('bad version');
    const art = m.shell[this.o.platform];
    const url = core.resolveUrl(art.url, m.__base);
    const file = path.join(this.dir, `shell-${m.version}-${this.o.platform}.zip`);
    this.set({ phase: 'downloading', progress: { received: 0, total: art.size } });
    const got = await download(this.o.fetch, url, file, {
      maxBytes: SHELL_MAX_BYTES, expectedSize: art.size,
      onProgress: (received, total) => this.set({ progress: { received, total } }),
    });
    if (got.size !== art.size || got.sha512 !== art.sha512) { await fsp.rm(file, { force: true }); throw new Error('downloaded app does not match its checksum'); }
    const staged = await this.o.shell.stage(file, m, art);
    await fsp.rm(file, { force: true });
    this.stagedShell = { version: m.version, ...staged };
    this.set({ phase: 'ready', progress: null, ready: { ...info, kind: 'shell' } });
    this.log(`app ${m.version} downloaded, verified and staged at ${staged.appPath}`);
  }
}

module.exports = { Updater, download, extractUiZip, readJson, writeJsonAtomic };
