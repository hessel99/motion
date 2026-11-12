// Full app ("shell") updates for the unsigned macOS build. Squirrel.Mac / electron-updater refuse
// to install into an app that is not signed with a Developer ID, so instead:
//   1. the verified zip is unpacked with `ditto` (keeps the framework symlinks) into the app data folder
//   2. on quit a small detached shell script (mac-swap.sh) waits for the app to exit, copies the new
//      bundle next to the installed one, clears quarantine (xattr -cr), signs it ad hoc
//      (codesign --force --deep -s -), swaps the two with renames and relaunches.
// Once the app is signed + notarized set package.json "motionUpdates.macShellUpdater" to
// "electron-updater" (see electron/updates/index.cjs and docs/updates.md).
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

/** the installed .app for an executable path like /Applications/Motion.app/Contents/MacOS/Motion */
function appBundleOf(execPath) {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return m ? m[1] : null;
}

/** can this install replace itself? -> { supported, blocked?, appPath } */
function macSupport({ execPath, isPackaged }) {
  if (process.platform !== 'darwin') return { supported: false, blocked: 'not macOS' };
  if (!isPackaged) return { supported: false, blocked: 'development build' };
  const appPath = appBundleOf(execPath);
  if (!appPath) return { supported: false, blocked: 'unexpected app location' };
  if (appPath.startsWith('/Volumes/')) return { supported: false, blocked: 'Motion runs from the disk image. Drag it to Applications first' };
  if (appPath.includes('/AppTranslocation/')) return { supported: false, blocked: 'macOS opened Motion from a temporary location. Move it to Applications (or right-click → Open once from there)' };
  try { fs.accessSync(path.dirname(appPath), fs.constants.W_OK); } catch { return { supported: false, blocked: `no permission to replace ${appPath}` }; }
  return { supported: true, appPath };
}

/**
 * unpack the verified zip into <dir>/<version>/ and find the .app.
 * -> { appPath } of the staged bundle
 */
async function stageMac(zipFile, version, dir, expectedName) {
  const target = path.join(dir, version);
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(target, { recursive: true });
  await run('/usr/bin/ditto', ['-x', '-k', zipFile, target]);
  const apps = (await fsp.readdir(target)).filter(n => n.endsWith('.app'));
  const name = apps.includes(expectedName) ? expectedName : apps[0];
  if (!name) throw new Error('the downloaded zip contains no .app');
  const appPath = path.join(target, name);
  // the bundle must say it is the version the manifest promised
  const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')]);
  if (stdout.trim() !== version) throw new Error(`downloaded app is version ${stdout.trim()}, expected ${version}`);
  return { appPath };
}

/**
 * start the detached swap helper. call right before the app exits.
 * helperSrc: path of mac-swap.sh inside the app (may be inside app.asar, so it is copied out first)
 */
function launchSwap({ helperSrc, workDir, pid, installedApp, stagedApp, relaunch, logFile, shell = '/bin/sh' }) {
  fs.mkdirSync(workDir, { recursive: true });
  const helper = path.join(workDir, 'mac-swap.sh');
  fs.writeFileSync(helper, fs.readFileSync(helperSrc), { mode: 0o755 });
  const child = spawn(shell, [helper, String(pid), installedApp, stagedApp, relaunch ? '1' : '0', logFile], {
    detached: true, stdio: 'ignore',
  });
  child.unref();
  return child;
}

module.exports = { appBundleOf, macSupport, stageMac, launchSwap };
