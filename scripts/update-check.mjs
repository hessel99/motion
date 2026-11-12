// end-to-end check of UI bundle updates in the real Electron app (xvfb-run -a node scripts/update-check.mjs):
//   1. a local fake release 9.9.9 (the real dist/ plus a marker) is served over http
//   2. launch: the app checks, downloads + verifies it in the background (phase 'ready')
//   3. relaunch: the app runs the downloaded bundle and confirms it (app-ready)
//   4. a broken release 9.9.10 (never signals app-ready) is installed with "Restart to update":
//      the watchdog rolls back to the last good bundle (9.9.9) and marks 9.9.10 bad
//   5. relaunch: still 9.9.9, 9.9.10 is not tried again; "revert" goes back to the built-in UI
// Needs `npx vite build` first. Uses its own app data folder and a throwaway signing key.
// Packaged build: EXE=release/linux-unpacked/motion UPDATE_KEY=.update-key/private.pem (the key whose
// public half is in the build's package.json; packaged apps ignore MOTION_UPDATE_PUBKEY).
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, execFileSync } from 'node:child_process';
import { serveDir } from './serve-release.mjs';

const req = createRequire(execSync('npm root -g').toString().trim() + '/');
const { _electron } = req('playwright');
const core = createRequire(import.meta.url)('../electron/updates/core.cjs');
const root = process.cwd();
if (!fs.existsSync(path.join(root, 'dist/index.html'))) { console.error('run npx vite build first'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-update-check-'));
// UPDATE_KEY=<pem> uses that key (e.g. the one a packaged EXE=… build embeds), else a throwaway key
const keys = process.env.UPDATE_KEY
  ? (() => { const pem = fs.readFileSync(process.env.UPDATE_KEY, 'utf8'); return { privateKeyPem: pem, publicKey: core.publicKeyToBase64(crypto.createPublicKey(core.privateKeyFromPem(pem))) }; })()
  : core.generateKeyPair();
fs.writeFileSync(path.join(tmp, 'key.pem'), keys.privateKeyPem);
const feed = path.join(tmp, 'feed');
const userData = path.join(tmp, 'userdata');

function makeRelease(version, mutate) {
  const dist = path.join(tmp, `dist-${version}`);
  fs.cpSync(path.join(root, 'dist'), dist, { recursive: true });
  const index = path.join(dist, 'index.html');
  fs.writeFileSync(index, mutate(fs.readFileSync(index, 'utf8')));
  execFileSync(process.execPath, ['scripts/release.mjs', '--version', version, '--dist', dist, '--out', feed, '--no-shell', '--key', path.join(tmp, 'key.pem'), '--allow-other-key', '--min-shell', '0.0.1', '--notes', `- test release ${version}`], { stdio: 'inherit' });
}
makeRelease('9.9.9', html => html.replace('<head>', '<head><meta name="motion-test-ui" content="9.9.9">'));
const server = await serveDir(feed, 0);
const url = `http://127.0.0.1:${server.address().port}`;

const results = [];
const ok = (cond, what) => { results.push([cond, what]); console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };

async function launch() {
  const app = await _electron.launch({
    executablePath: process.env.EXE || (await import('electron')).default, args: process.env.EXE ? ['--no-sandbox'] : ['.', '--no-sandbox'], cwd: root,
    env: { ...process.env, MOTION_TEST: '1', MOTION_BRIDGE_PORT: '7831', MOTION_USER_DATA: userData, MOTION_UPDATE_URL: url, MOTION_UPDATE_PUBKEY: keys.publicKey, MOTION_UPDATE_FIRST_CHECK_MS: '300', MOTION_UPDATE_BOOT_TIMEOUT: '5000' },
  });
  const win = await app.firstWindow();
  return { app, win };
}
const state = (win) => win.evaluate(() => window.motionNative.updates.state());
async function waitFor(win, pred, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    let s = null;
    try { s = await state(win); } catch { /* navigating */ }
    if (s && pred(s)) return s;
    if (Date.now() > end) return s;
    await new Promise(r => setTimeout(r, 250));
  }
}
const marker = (win) => win.evaluate(() => document.querySelector('meta[name="motion-test-ui"]')?.getAttribute('content') ?? null).catch(() => 'err');
const stateFile = () => JSON.parse(fs.readFileSync(path.join(userData, 'ui', 'state.json'), 'utf8'));

try {
  // 1 + 2: first launch downloads 9.9.9 in the background
  let { app, win } = await launch();
  await win.waitForFunction(() => window.editor?.renderer, null, { timeout: 20000 });
  let s = await waitFor(win, x => x.phase === 'ready' || x.phase === 'error');
  ok(s.phase === 'ready' && s.ready?.version === '9.9.9', `background download + verify (phase ${s.phase} ${s.error ?? ''})`);
  ok(s.ready?.notes?.includes('test release 9.9.9'), 'release notes reach the renderer');
  ok(await marker(win) === null, 'still running the built-in UI until restart');
  ok(await win.evaluate(() => !!document.querySelector('.upd-pill')), 'update-ready notice is shown');
  await app.close();

  // 3: relaunch runs the downloaded bundle
  ({ app, win } = await launch());
  await win.waitForFunction(() => window.editor?.renderer, null, { timeout: 20000 });
  ok(await marker(win) === '9.9.9', 'relaunch loads the downloaded UI bundle');
  await new Promise(r => setTimeout(r, 1500));
  s = await state(win);
  ok(s.uiVersion === '9.9.9' && s.uiSource === 'downloaded', `state reports ui 9.9.9 (${s.uiVersion}, ${s.uiSource})`);
  ok(stateFile().boot === null && stateFile().active?.version === '9.9.9', 'app-ready confirmed the bundle');

  // 4: a broken bundle, installed with "Restart to update", is rolled back by the watchdog
  makeRelease('9.9.10', () => '<!doctype html><html><head><meta name="motion-test-ui" content="broken"></head><body>broken</body></html>');
  await win.evaluate(() => window.motionNative.updates.check());
  s = await waitFor(win, x => x.phase === 'ready' && x.ready?.version === '9.9.10');
  ok(s.ready?.version === '9.9.10', 'downloads the next version');
  const r = await win.evaluate(() => window.motionNative.updates.restart());
  ok(r.ok, 'restart to update accepted');
  await new Promise(r => setTimeout(r, 1500));
  ok(await marker(win) === 'broken', 'broken bundle got loaded');
  await new Promise(r => setTimeout(r, 6000));
  await win.waitForFunction(() => window.editor?.renderer, null, { timeout: 20000 });
  ok(await marker(win) === '9.9.9', 'watchdog rolled back to the last good UI (9.9.9)');
  await new Promise(r => setTimeout(r, 1000));
  s = await state(win);
  ok(s.notice?.kind === 'rolled-back' && s.uiVersion === '9.9.9', `rollback notice (${s.notice?.text})`);
  ok(stateFile().bad.includes('9.9.10'), '9.9.10 marked bad');
  ok(stateFile().boot === null, 'the fallback bundle confirmed app-ready');
  await app.close();

  // 5: next start stays on the built-in UI, does not retry 9.9.10
  ({ app, win } = await launch());
  await win.waitForFunction(() => window.editor?.renderer, null, { timeout: 20000 });
  ok(await marker(win) === '9.9.9', 'next start keeps 9.9.9');
  s = await waitFor(win, x => x.phase === 'up-to-date' || x.phase === 'error' || x.phase === 'ready', 10000);
  ok(s.phase === 'up-to-date', `bad version is not offered again (phase ${s.phase})`);
  // exports block "Restart to update"
  await win.evaluate(() => window.motionNative.updates.setBusy('export-video', true));
  const refused = await win.evaluate(() => window.motionNative.updates.restart());
  ok(!refused.ok, `restart refused while exporting (${refused.error})`);
  await win.evaluate(() => window.motionNative.updates.setBusy('export-video', false));
  // Settings → Updates → Revert: built-in UI from the next start
  await win.evaluate(() => window.motionNative.updates.revertUi());
  await app.close();
  ({ app, win } = await launch());
  await win.waitForFunction(() => window.editor?.renderer, null, { timeout: 20000 });
  ok(await marker(win) === null, 'revert: back on the built-in UI');
  await app.close();
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter(r => !r[0]).length;
console.log(failed ? `${failed} check(s) failed` : 'all update checks passed');
process.exit(failed ? 1 : 0);
