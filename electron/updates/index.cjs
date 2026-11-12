// Wires the updater (updater.cjs) into the Electron app: config, which renderer to load, the
// 'app-ready' watchdog with automatic rollback, IPC for Settings → Updates, scheduled checks and
// the full-app swap on quit. See docs/updates.md.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, net } = require('electron');
const core = require('./core.cjs');
const { Updater } = require('./updater.cjs');
const mac = require('./shell-mac.cjs');

const SIX_HOURS = 6 * 60 * 60 * 1000;
const pkg = require('../../package.json');
const cfg = pkg.motionUpdates || {};

/** where the feed lives. one setting: package.json "motionUpdates.repo" (or "feedUrl"). */
function feedBase() {
  if (process.env.MOTION_UPDATE_URL) return process.env.MOTION_UPDATE_URL.replace(/\/+$/, '');
  if (cfg.feedUrl) return String(cfg.feedUrl).replace(/\/+$/, '');
  return `https://github.com/${cfg.repo || 'hessel99/motion'}/releases/download/${cfg.feedTag || 'updates'}`;
}

function publicKey() {
  // a test key may only be swapped in for development builds; packaged apps trust the embedded key only
  const b64 = (!app.isPackaged && process.env.MOTION_UPDATE_PUBKEY) || cfg.publicKey;
  if (!b64) return null;
  try { return core.publicKeyFromBase64(b64); } catch (e) { console.error('[updates]', e.message); return null; }
}

function createUpdates({ isDev }) {
  const logFile = () => path.join(app.getPath('userData'), 'logs', 'updates.log');
  const log = (msg) => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    if (process.env.MOTION_UPDATE_DEBUG) process.stdout.write('[updates] ' + line);
    try { fs.mkdirSync(path.dirname(logFile()), { recursive: true }); fs.appendFileSync(logFile(), line); } catch { /* */ }
  };
  const key = publicKey();
  const platform = `${process.platform}-${process.arch}`;
  const version = app.getVersion();

  // full-app updates: the unsigned-mac helper by default; electron-updater once signed (config flag)
  let shell = null;
  const useElectronUpdater = process.platform === 'darwin' ? cfg.macShellUpdater === 'electron-updater' : !!cfg.useElectronUpdaterOn?.includes(process.platform);
  if (useElectronUpdater) shell = electronUpdaterShell(log);
  else if (process.platform === 'darwin') {
    const sup = mac.macSupport({ execPath: process.execPath, isPackaged: app.isPackaged });
    shell = {
      supported: sup.supported, blocked: sup.blocked, appPath: sup.appPath,
      stage: (file, m) => mac.stageMac(file, m.version, path.join(app.getPath('userData'), 'updates', 'shell'), `${app.getName()}.app`),
    };
  } else shell = { supported: false, blocked: 'Download the new version from the releases page (automatic app updates are macOS only for now)' };

  const updater = new Updater({
    userData: app.getPath('userData'),
    fetch: (url, init) => net.fetch(url, init),
    publicKey: key,
    feedUrls: (channel) => {
      const base = feedBase();
      return channel === 'beta' ? [`${base}/stable.json`, `${base}/beta.json`] : [`${base}/stable.json`];
    },
    shellVersion: version, bundledVersion: version, platform, shell, log,
  });
  const enabled = !!key && !process.env.MOTION_UPDATE_DISABLE && (!isDev || !!process.env.MOTION_UPDATE_URL);
  updater.set({ enabled, disabledReason: !key ? 'No update key is configured in this build.' : !enabled ? 'Updates are off in development.' : null, releasesUrl: cfg.repo ? `https://github.com/${cfg.repo}/releases` : null });

  let win = null;
  let watchdog = null;
  let quitAction = null; // 'install' (relaunch) when the user clicked "Restart to update"
  const bootTimeout = Number(process.env.MOTION_UPDATE_BOOT_TIMEOUT || cfg.bootTimeoutMs || 20000);
  const bundledIndex = path.join(__dirname, '..', '..', 'dist', 'index.html');

  const push = (s) => { if (win && !win.isDestroyed()) win.webContents.send('updates:state', publicStatus(s)); };
  updater.on(push);

  const publicStatus = (s) => ({ ...s });

  function clearWatchdog() { if (watchdog) { clearTimeout(watchdog); watchdog = null; } }

  function rollback(reason) {
    clearWatchdog();
    const next = updater.bootFailed(reason);
    if (!next || !win || win.isDestroyed()) return;
    if (next.source === 'downloaded') loadBundle(win, next); // the previous good bundle (watched again)
    else win.loadFile(bundledIndex);
  }

  function loadBundle(w, b) {
    if (!fs.existsSync(b.indexHtml)) { rollback('files missing'); return; }
    log(`loading ui ${b.version}`);
    clearWatchdog();
    watchdog = setTimeout(() => rollback(`no start signal within ${Math.round(bootTimeout / 1000)} s`), bootTimeout);
    return w.loadFile(b.indexHtml);
  }

  /** load the right renderer into win (downloaded bundle if there is a good one, else dist/) */
  function loadRenderer(w) {
    win = w;
    if (!enabled && !fs.existsSync(path.join(app.getPath('userData'), 'ui', 'state.json'))) return w.loadFile(bundledIndex);
    const b = isDev ? { source: 'bundled' } : updater.boot();
    if (b.source !== 'downloaded') return w.loadFile(bundledIndex);
    return loadBundle(w, b);
  }

  function attach(w) {
    win = w;
    w.webContents.on('render-process-gone', (_e, d) => { if (updater.bootVersion && watchdog) rollback(`renderer ${d.reason}`); });
    // -3 (ERR_ABORTED): the user cancelled the reload in the unsaved-changes dialog, not a broken bundle
    w.webContents.on('did-fail-load', (_e, code, desc, _url, isMain) => { if (isMain && code !== -3 && updater.bootVersion && watchdog) rollback(`load failed: ${desc}`); });
    w.webContents.on('did-finish-load', () => push(updater.getStatus()));
  }

  ipcMain.on('updates:app-ready', (e) => {
    if (!win || e.sender !== win.webContents) return;
    clearWatchdog();
    updater.appReady();
  });
  ipcMain.handle('updates:state', () => publicStatus(updater.getStatus()));
  ipcMain.handle('updates:check', () => (enabled ? updater.check({ manual: true }).then(publicStatus) : publicStatus(updater.getStatus())));
  ipcMain.handle('updates:prefs', async (_e, p = {}) => {
    const before = updater.status.channel;
    await updater.savePrefs({ channel: p.channel ?? updater.status.channel, auto: p.auto ?? updater.status.auto });
    if (enabled && p.channel && p.channel !== before) updater.check({ manual: true });
    return publicStatus(updater.getStatus());
  });
  ipcMain.handle('updates:busy', (_e, reason, on) => { updater.setBusy(String(reason).slice(0, 40), !!on); return true; });
  ipcMain.handle('updates:revert-ui', () => { updater.revertUi(); return publicStatus(updater.getStatus()); });
  ipcMain.handle('updates:restart', () => {
    if (updater.busy.size) return { ok: false, error: 'Finish the export first' };
    const r = updater.status.ready;
    if (!r) return { ok: false, error: 'Nothing to install' };
    if (r.kind === 'ui') {
      updater.set({ ready: null, phase: 'idle', notice: null });
      setImmediate(() => win && !win.isDestroyed() && loadRenderer(win));
      return { ok: true };
    }
    quitAction = 'install';
    setImmediate(() => app.quit());
    return { ok: true };
  });

  /** the user kept the current window (unsaved-changes dialog → Cancel): the old UI keeps running */
  function cancelLoad() {
    if (!watchdog) return;
    clearWatchdog();
    updater.bootVersion = null;
    log('reload cancelled by the user; the update applies on the next start');
  }

  // automatic checks: shortly after launch, then every 6 hours (skipped while exporting)
  function schedule() {
    if (!enabled) return;
    const tick = () => { if (updater.status.auto) updater.check().catch(() => {}); };
    setTimeout(tick, Number(process.env.MOTION_UPDATE_FIRST_CHECK_MS || 15000)).unref?.();
    setInterval(tick, SIX_HOURS).unref?.();
  }

  // a staged full-app update is installed when the app quits (and relaunched if the user asked)
  function onWillQuit() {
    const staged = updater.stagedShell;
    if (!staged) return;
    if (staged.install) { staged.install(quitAction === 'install'); return; }
    if (!shell || !shell.appPath) return;
    try {
      mac.launchSwap({
        helperSrc: path.join(__dirname, 'mac-swap.sh'),
        workDir: path.join(app.getPath('userData'), 'updates'),
        pid: process.pid, installedApp: shell.appPath, stagedApp: staged.appPath,
        relaunch: quitAction === 'install', logFile: path.join(app.getPath('userData'), 'logs', 'shell-update.log'),
      });
      log(`swap helper started for ${staged.version}`);
    } catch (e) { log(`could not start the swap helper: ${e.message}`); }
  }

  updater.loadPrefs().catch(() => {});
  return { updater, loadRenderer, attach, schedule, onWillQuit, cancelLoad };
}

/** path for signed + notarized builds: electron-updater does download + install (Squirrel.Mac / NSIS / AppImage) */
function electronUpdaterShell(log) {
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch {
    return { supported: false, blocked: 'electron-updater is configured but not installed (npm i electron-updater)' };
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  return {
    supported: true,
    // the signed manifest decided that a shell update is due; electron-updater fetches its own
    // latest-*.yml from the same GitHub release and checks the code signature itself
    async stage() {
      await autoUpdater.checkForUpdates();
      await autoUpdater.downloadUpdate();
      return { appPath: '(electron-updater)', install: (relaunch) => relaunch && autoUpdater.quitAndInstall(false, true) };
    },
  };
}

module.exports = { createUpdates, feedBase };
