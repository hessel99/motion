// integration: a local fake release (built by scripts/release.mjs, served over http) and the real
// updater (electron/updates/updater.cjs) driven in node: check, download, verify, install a UI
// bundle, boot it, roll back a broken one, reject tampered / foreign-signed releases, stage a
// shell update, and the macOS swap helper on fake .app folders.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { zipSync } from 'fflate';

const require = createRequire(import.meta.url);
const core = require('../electron/updates/core.cjs');
const { Updater } = require('../electron/updates/updater.cjs');
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-upd-'));
const keys = core.generateKeyPair();
const keyFile = path.join(tmp, 'key.pem');
fs.writeFileSync(keyFile, keys.privateKeyPem);
const otherKeys = core.generateKeyPair();
const otherKeyFile = path.join(tmp, 'other.pem');
fs.writeFileSync(otherKeyFile, otherKeys.privateKeyPem);

function fakeDist(name, marker) {
  const d = path.join(tmp, name);
  fs.mkdirSync(path.join(d, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), `<!doctype html><title>${marker}</title><script src="./assets/app.js"></script>`);
  fs.writeFileSync(path.join(d, 'assets', 'app.js'), `console.log(${JSON.stringify(marker)})`);
  fs.writeFileSync(path.join(d, 'assets', 'app.js.map'), '{}');
  return d;
}

/** run the real release script into its own folder (one folder per "feed state") */
function release(feedDir, { version, dist, key = keyFile, extra = [] }) {
  return execFileSync(process.execPath, [path.join(root, 'scripts/release.mjs'),
    '--version', version, '--dist', dist, '--out', feedDir, '--no-shell', '--key', key, '--allow-other-key', ...extra,
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// one http server; `served` points at the folder that is "the release" right now; `tamper` flips bytes
let served = null, tamper = false, requests = [];
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1);
  requests.push(name);
  const file = path.join(served, name);
  if (!served || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  let buf = fs.readFileSync(file);
  if (tamper && name.endsWith('.zip')) { buf = Buffer.from(buf); buf[buf.length >> 1] ^= 0xff; }
  res.writeHead(200, { 'content-length': buf.length }).end(buf);
});
let base = '';
beforeAll(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function makeUpdater(userData, extra = {}) {
  return new Updater({
    userData, fetch: (u, i) => fetch(u, i), publicKey: core.publicKeyFromBase64(keys.publicKey),
    feedUrls: (ch) => (ch === 'beta' ? [`${base}/stable.json`, `${base}/beta.json`] : [`${base}/stable.json`]),
    shellVersion: '0.1.0', bundledVersion: '0.1.0', platform: 'darwin-arm64', shell: null, ...extra,
  });
}

describe('release script', () => {
  it('builds a signed manifest + UI zip without source maps; minShell follows the shell fingerprint', () => {
    const dir = path.join(tmp, 'feed-a');
    const out = release(dir, { version: '0.2.0', dist: fakeDist('dist-a', 'ui-0.2.0') });
    expect(out).toMatch(/needs app 0.2.0/);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'stable.json'), 'utf8'));
    expect(core.readManifest(m, core.publicKeyFromBase64(keys.publicKey)).ok).toBe(true);
    expect(m.minShell).toBe('0.2.0'); // first release: no previous manifest
    const { unzipSync } = require('fflate');
    const files = Object.keys(unzipSync(fs.readFileSync(path.join(dir, 'Motion-0.2.0-ui.zip'))));
    expect(files.sort()).toEqual(['assets/app.js', 'index.html']);
    // same shell, newer version: the UI keeps running on the older shell
    const dir2 = path.join(tmp, 'feed-a2');
    const out2 = release(dir2, { version: '0.2.1', dist: fakeDist('dist-a2', 'ui-0.2.1'), extra: ['--prev', path.join(dir, 'stable.json')] });
    expect(out2).toMatch(/unchanged/);
    expect(JSON.parse(fs.readFileSync(path.join(dir2, 'stable.json'), 'utf8')).minShell).toBe('0.2.0');
    // the same zip bytes for the same dist (reproducible)
    release(path.join(tmp, 'feed-a3'), { version: '0.2.0', dist: path.join(tmp, 'dist-a') });
    expect(fs.readFileSync(path.join(tmp, 'feed-a3', 'Motion-0.2.0-ui.zip')).equals(fs.readFileSync(path.join(dir, 'Motion-0.2.0-ui.zip')))).toBe(true);
  });
  it('refuses a key that does not match package.json unless told otherwise', () => {
    expect(() => execFileSync(process.execPath, [path.join(root, 'scripts/release.mjs'), '--version', '0.2.0', '--dist', path.join(tmp, 'dist-a'), '--out', path.join(tmp, 'feed-x'), '--no-shell', '--key', keyFile], { cwd: root, stdio: 'pipe' })).toThrow();
  });
});

describe('UI bundle update end to end', () => {
  const feed = path.join(tmp, 'feed-ui');

  it('downloads, verifies, installs and boots a new UI', async () => {
    const dist = fakeDist('dist-ui', 'ui-0.3.0');
    release(feed, { version: '0.3.0', dist });
    // pretend the shell did not change since 0.1.0
    const m = JSON.parse(fs.readFileSync(path.join(feed, 'stable.json'), 'utf8'));
    const { sig, ...rest } = m;
    const resigned = core.signManifest({ ...rest, minShell: '0.1.0' }, core.privateKeyFromPem(keys.privateKeyPem));
    fs.writeFileSync(path.join(feed, 'stable.json'), JSON.stringify(resigned));
    served = feed; tamper = false;

    const userData = path.join(tmp, 'ud-1');
    const u = makeUpdater(userData);
    const phases = [];
    u.on(s => phases.push(s.phase));
    expect(u.boot().source).toBe('bundled');
    const st = await u.check({ manual: true });
    expect(st.error).toBeNull();
    expect(st.phase).toBe('ready');
    expect(st.ready).toMatchObject({ version: '0.3.0', kind: 'ui' });
    expect(phases).toContain('downloading');
    expect(fs.readFileSync(path.join(userData, 'ui', '0.3.0', 'index.html'), 'utf8')).toContain('ui-0.3.0');

    // next start: loads the downloaded bundle, app-ready keeps it
    const u2 = makeUpdater(userData);
    const b = u2.boot();
    expect(b.source).toBe('downloaded');
    expect(fs.readFileSync(b.indexHtml, 'utf8')).toContain('ui-0.3.0');
    u2.appReady();
    const u3 = makeUpdater(userData);
    expect(u3.boot().version).toBe('0.3.0');
    u3.appReady();
    // nothing new: up to date, no second download
    requests = [];
    await u3.loadPrefs();
    u3.set({ uiVersion: '0.3.0' });
    const again = await u3.check({ manual: true });
    expect(again.phase).toBe('up-to-date');
    expect(requests.filter(r => r.endsWith('.zip'))).toEqual([]);
  });

  it('rolls back a bundle that never signals app-ready and does not download it again', async () => {
    const userData = path.join(tmp, 'ud-2');
    const u = makeUpdater(userData);
    u.boot();
    await u.check();
    expect(u.status.ready?.version).toBe('0.3.0');
    const u2 = makeUpdater(userData);
    expect(u2.boot().source).toBe('downloaded');
    // watchdog fired (no app-ready in time)
    expect(u2.bootFailed('no start signal')).toMatchObject({ source: 'bundled' });
    expect(u2.status).toMatchObject({ uiSource: 'bundled', uiVersion: '0.1.0' });
    expect(u2.status.notice.kind).toBe('rolled-back');
    const u3 = makeUpdater(userData);
    expect(u3.boot().source).toBe('bundled');
    requests = [];
    const st = await u3.check({ manual: true });
    expect(st.phase).toBe('up-to-date'); // 0.3.0 is known bad
    expect(requests.some(r => r.endsWith('.zip'))).toBe(false);
  });

  it('rolls back after a crash loop (two starts without app-ready)', async () => {
    const userData = path.join(tmp, 'ud-3');
    const u = makeUpdater(userData);
    u.boot();
    await u.check();
    expect(makeUpdater(userData).boot().source).toBe('downloaded'); // crashed
    expect(makeUpdater(userData).boot().source).toBe('downloaded'); // crashed again
    const u4 = makeUpdater(userData);
    expect(u4.boot().source).toBe('bundled');
    expect(u4.status.notice.text).toMatch(/did not start/);
  });

  it('rejects a tampered download (checksum) and keeps the current UI', async () => {
    const userData = path.join(tmp, 'ud-4');
    tamper = true;
    const u = makeUpdater(userData);
    u.boot();
    const st = await u.check({ manual: true });
    tamper = false;
    expect(st.phase).toBe('error');
    expect(st.error).toMatch(/checksum/);
    expect(fs.existsSync(path.join(userData, 'ui', '0.3.0'))).toBe(false);
    expect(makeUpdater(userData).boot().source).toBe('bundled');
  });

  it('rejects a release signed with a different key', async () => {
    const evil = path.join(tmp, 'feed-evil');
    release(evil, { version: '0.9.0', dist: fakeDist('dist-evil', 'evil'), key: otherKeyFile });
    served = evil;
    const u = makeUpdater(path.join(tmp, 'ud-5'));
    u.boot();
    const st = await u.check({ manual: true });
    served = feed;
    expect(st.phase).toBe('error');
    expect(st.error).toMatch(/signature/);
    expect(requests.some(r => r.includes('0.9.0') && r.endsWith('.zip'))).toBe(false);
  });

  it('rejects a bundle with path traversal entries', () => {
    const { extractUiZip } = require('../electron/updates/updater.cjs');
    const zip = Buffer.from(zipSync({ 'index.html': new Uint8Array([1]), '../escape.txt': new Uint8Array([2]) }));
    const dir = path.join(tmp, 'trav');
    fs.mkdirSync(dir);
    expect(() => extractUiZip(zip, dir)).toThrow(/unsafe/);
    expect(fs.existsSync(path.join(tmp, 'escape.txt'))).toBe(false);
  });

  it('withdrawn (revoked) versions stop running on the next start', async () => {
    const userData = path.join(tmp, 'ud-6');
    const u = makeUpdater(userData);
    u.boot();
    await u.check();
    const u2 = makeUpdater(userData);
    expect(u2.boot().source).toBe('downloaded');
    u2.appReady();
    // publisher withdraws 0.3.0 by publishing 0.3.1 with revoke
    const feed2 = path.join(tmp, 'feed-revoke');
    release(feed2, { version: '0.3.1', dist: fakeDist('dist-031', 'ui-0.3.1'), extra: ['--revoke', '0.3.0'] });
    const m = JSON.parse(fs.readFileSync(path.join(feed2, 'stable.json'), 'utf8'));
    // and the new UI needs a new shell that this platform cannot install: only the revoke applies
    const { sig, ...rest } = m;
    fs.writeFileSync(path.join(feed2, 'stable.json'), JSON.stringify(core.signManifest({ ...rest, minShell: '0.3.1' }, core.privateKeyFromPem(keys.privateKeyPem))));
    served = feed2;
    u2.set({ uiVersion: '0.3.0', uiSource: 'downloaded' });
    const st = await u2.check({ manual: true });
    served = feed;
    expect(st.notice?.kind).toBe('revoked');
    expect(makeUpdater(userData).boot().source).toBe('bundled');
  });

  it('beta channel sees beta releases, stable does not', async () => {
    const feedB = path.join(tmp, 'feed-beta');
    fs.cpSync(feed, feedB, { recursive: true });
    release(feedB, { version: '0.4.0-beta.1', dist: fakeDist('dist-b', 'ui-beta') });
    const m = JSON.parse(fs.readFileSync(path.join(feedB, 'beta.json'), 'utf8'));
    const { sig, ...rest } = m;
    fs.writeFileSync(path.join(feedB, 'beta.json'), JSON.stringify(core.signManifest({ ...rest, minShell: '0.1.0' }, core.privateKeyFromPem(keys.privateKeyPem))));
    served = feedB;
    const s = makeUpdater(path.join(tmp, 'ud-7'));
    s.boot();
    expect((await s.check({ manual: true })).ready?.version).toBe('0.3.0');
    const b = makeUpdater(path.join(tmp, 'ud-8'));
    b.boot();
    await b.savePrefs({ channel: 'beta' });
    expect((await b.check({ manual: true })).ready?.version).toBe('0.4.0-beta.1');
    served = feed;
  });

  it('defers automatic checks while exporting, manual checks still work', async () => {
    const u = makeUpdater(path.join(tmp, 'ud-9'));
    u.boot();
    u.setBusy('export-video', true);
    requests = [];
    await u.check();
    expect(requests).toEqual([]);
    u.setBusy('export-video', false);
    await u.check();
    expect(requests).toContain('stable.json');
  });
});

describe('shell (full app) update', () => {
  it('downloads + verifies the platform zip and hands it to the stager', async () => {
    const feed = path.join(tmp, 'feed-shell');
    const shellDir = path.join(tmp, 'shell-build');
    fs.mkdirSync(shellDir, { recursive: true });
    fs.writeFileSync(path.join(shellDir, 'Motion-0.5.0-mac-arm64.zip'), Buffer.alloc(300_000, 7));
    execFileSync(process.execPath, [path.join(root, 'scripts/release.mjs'), '--version', '0.5.0', '--dist', fakeDist('dist-s', 'ui-0.5.0'), '--out', feed, '--shell-dir', shellDir, '--key', keyFile, '--allow-other-key'], { cwd: root, stdio: 'pipe' });
    const m = JSON.parse(fs.readFileSync(path.join(feed, 'stable.json'), 'utf8'));
    expect(m.minShell).toBe('0.5.0');
    expect(Object.keys(m.shell)).toEqual(['darwin-arm64']);
    served = feed;
    const staged = [];
    const u = makeUpdater(path.join(tmp, 'ud-s'), { shell: { supported: true, stage: async (file, man, art) => { staged.push({ size: fs.statSync(file).size, v: man.version, art }); return { appPath: '/x/Motion.app' }; } } });
    u.boot();
    const st = await u.check({ manual: true });
    expect(st.ready).toMatchObject({ version: '0.5.0', kind: 'shell' });
    expect(staged[0]).toMatchObject({ size: 300_000, v: '0.5.0' });
    expect(u.stagedShell.appPath).toBe('/x/Motion.app');
    // linux (no artifact): tells the user to download by hand
    const l = makeUpdater(path.join(tmp, 'ud-l'), { platform: 'linux-x64' });
    l.boot();
    const sl = await l.check({ manual: true });
    expect(sl.phase).toBe('error');
    expect(sl.available.manual).toBe(true);
    // tampered zip is rejected before staging
    tamper = true;
    const t = makeUpdater(path.join(tmp, 'ud-t'), { shell: { supported: true, stage: async () => { throw new Error('must not stage'); } } });
    t.boot();
    expect((await t.check({ manual: true })).error).toMatch(/checksum/);
    tamper = false;
  });

  it('mac-swap.sh waits for the app to exit, swaps the bundle and keeps the old one on failure', async () => {
    const { launchSwap, appBundleOf } = require('../electron/updates/shell-mac.cjs');
    expect(appBundleOf('/Applications/Motion.app/Contents/MacOS/Motion')).toBe('/Applications/Motion.app');
    expect(appBundleOf('/usr/bin/node')).toBeNull();
    const apps = path.join(tmp, 'Applications');
    const installed = path.join(apps, 'Motion.app');
    const staged = path.join(tmp, 'staged', 'Motion.app');
    fs.mkdirSync(path.join(installed, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'Contents', 'v'), 'old');
    fs.mkdirSync(path.join(staged, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'Contents', 'v'), 'new');
    const app = spawn('sleep', ['30']); // stands in for the running app
    const log = path.join(tmp, 'swap.log');
    const child = launchSwap({ helperSrc: path.join(root, 'electron/updates/mac-swap.sh'), workDir: path.join(tmp, 'swapwork'), pid: app.pid, installedApp: installed, stagedApp: staged, relaunch: false, logFile: log });
    await new Promise(r => setTimeout(r, 600));
    expect(fs.readFileSync(path.join(installed, 'Contents', 'v'), 'utf8')).toBe('old'); // still waiting
    const done = new Promise(r => child.on('exit', r));
    app.kill();
    expect(await done).toBe(0);
    expect(fs.readFileSync(path.join(installed, 'Contents', 'v'), 'utf8')).toBe('new');
    expect(fs.existsSync(staged)).toBe(false);
    expect(fs.readdirSync(apps)).toEqual(['Motion.app']); // no leftovers
    expect(fs.readFileSync(log, 'utf8')).toMatch(/updated/);
    // refuses anything that is not an .app
    const bad = launchSwap({ helperSrc: path.join(root, 'electron/updates/mac-swap.sh'), workDir: path.join(tmp, 'swapwork'), pid: 999999, installedApp: path.join(tmp, 'home'), stagedApp: staged, relaunch: false, logFile: log });
    expect(await new Promise(r => bad.on('exit', r))).toBe(1);
  });
});
