#!/usr/bin/env node
// Builds the update artifacts + signed manifest for one version (see docs/updates.md).
//
//   node scripts/release.mjs [options]
//     --out DIR           output folder (default release/updates)
//     --dist DIR          built renderer (default dist)
//     --shell-dir DIR     where electron-builder put the app zips (default release); --no-shell to skip
//     --channel C         stable | beta (default: beta for prerelease versions like 0.3.0-beta.1)
//     --notes TEXT|@FILE  release notes shown in Settings → Updates
//     --base-url URL      absolute URL where the artifacts will be downloadable
//                         (CI: https://github.com/OWNER/REPO/releases/download/vX.Y.Z); default: relative names
//     --feed URL          current update feed (…/releases/download/updates) to read the previous
//                         manifest from (decides minShell); --prev FILE reads it from a file instead
//     --key FILE          PKCS#8 PEM private key (default: env MOTION_UPDATE_PRIVATE_KEY, then .update-key/private.pem)
//     --allow-other-key   sign even if the key does not match package.json motionUpdates.publicKey (tests)
//     --version V         override the version (tests; default package.json)
//     --revoke V1,V2      UI versions that must stop running (rollback)
//     --min-shell V       force minShell (advanced: e.g. after a shell change that is known to be compatible)
//
// Output: Motion-<v>-ui.zip, the app zips (copied), <channel>.json (the feed manifest) and
// manifest-<v>.json (same content, kept with the version's release).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUiZip, core, hashFile, shellFingerprint, shellPlatformOf } from './release-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);
const die = (msg) => { console.error(`release: ${msg}`); process.exit(1); };

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = opt('version', pkg.version);
if (!core.parseVersion(version)) die(`invalid version ${version}`);
const channel = opt('channel', core.isPrerelease(version) ? 'beta' : 'stable');
if (!['stable', 'beta'].includes(channel)) die('channel must be stable or beta');
if (channel === 'stable' && core.isPrerelease(version)) die(`${version} is a prerelease: publish it on the beta channel`);
const out = path.resolve(root, opt('out', 'release/updates'));
const dist = path.resolve(root, opt('dist', 'dist'));
const shellDir = path.resolve(root, opt('shell-dir', 'release'));
const baseUrl = opt('base-url', '');
const urlFor = (name) => (baseUrl ? `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(name)}` : name);

// ---- key
// an explicit --key wins; then the env secret (CI); then the local key file
const explicitKey = opt('key', null);
let pem = explicitKey ? fs.readFileSync(path.resolve(root, explicitKey), 'utf8') : process.env.MOTION_UPDATE_PRIVATE_KEY;
const keyFile = fs.existsSync(path.join(root, '.update-key/private.pem')) ? path.join(root, '.update-key/private.pem') : null;
if (!pem && keyFile) pem = fs.readFileSync(keyFile, 'utf8');
if (!pem) die('no signing key: set MOTION_UPDATE_PRIVATE_KEY or pass --key FILE (create one with `node scripts/gen-update-key.mjs`)');
let privateKey;
try { privateKey = core.privateKeyFromPem(pem); } catch (e) {
  // describe the shape of the secret without revealing it
  const t = String(pem).trim();
  const body = t.replace(/-----[A-Z ]+-----/g, '').replace(/[^A-Za-z0-9+/=]/g, '');
  die(`the signing key could not be read (${e.message}). It has ${t.length} characters, ${t.includes('-----BEGIN') ? 'a' : 'no'} BEGIN line, and ${body.length} base64 characters; ` +
    `a valid key has a "-----BEGIN PRIVATE KEY-----" line and 64 base64 characters. A 44-character value is the PUBLIC key, not the private one.`);
}
const derivedPublic = core.publicKeyToBase64(crypto.createPublicKey(privateKey));
if (derivedPublic !== pkg.motionUpdates?.publicKey) {
  const msg = pkg.motionUpdates?.publicKey
    ? `the signing key does not match package.json motionUpdates.publicKey (key's public half: ${derivedPublic})`
    : `package.json motionUpdates.publicKey is empty: set it to ${derivedPublic} (node scripts/gen-update-key.mjs --write does this) and commit`;
  if (!flag('allow-other-key')) die(msg + '. Installed apps would reject this release.');
  console.warn(`release: warning: ${msg}`);
}

// ---- previous manifest (decides minShell)
async function previous() {
  const prevFile = opt('prev', null);
  if (prevFile) return JSON.parse(fs.readFileSync(prevFile, 'utf8'));
  const feed = opt('feed', null);
  if (!feed) return null;
  const found = [];
  for (const ch of ['stable', 'beta']) {
    try {
      const r = await fetch(`${feed.replace(/\/+$/, '')}/${ch}.json`, { redirect: 'follow' });
      if (r.ok) found.push(await r.json());
    } catch { /* first release */ }
  }
  found.sort((a, b) => core.compareVersions(b.version, a.version));
  return found[0] || null;
}
const prev = await previous();
const fingerprint = shellFingerprint(root);
let minShell = version;
if (prev && prev.shellFingerprint === fingerprint && core.parseVersion(prev.minShell) && core.compareVersions(prev.minShell, version) <= 0) minShell = prev.minShell;
if (opt('min-shell', null)) {
  minShell = opt('min-shell');
  if (!core.parseVersion(minShell) || core.compareVersions(minShell, version) > 0) die('--min-shell must be a version <= the release version');
}
console.log(`release: ${version} (${channel}), shell ${fingerprint.slice(0, 12)}… ${minShell === version ? 'changed or first release → needs app ' + version : 'unchanged → runs on app ' + minShell + '+'}`);

// ---- artifacts
fs.mkdirSync(out, { recursive: true });
const uiName = `Motion-${version}-ui.zip`;
fs.writeFileSync(path.join(out, uiName), buildUiZip(dist));
const ui = hashFile(path.join(out, uiName));

const shell = {};
if (!flag('no-shell') && fs.existsSync(shellDir)) {
  for (const name of fs.readdirSync(shellDir)) {
    if (!name.includes(`-${version}-`)) continue;
    const plat = shellPlatformOf(name);
    if (!plat) continue;
    const src = path.join(shellDir, name);
    if (path.resolve(src) !== path.join(out, name)) fs.copyFileSync(src, path.join(out, name));
    const h = hashFile(path.join(out, name));
    shell[plat] = { url: urlFor(name), sha512: h.sha512, size: h.size };
    console.log(`release: app ${plat}: ${name} (${(h.size / 1048576).toFixed(1)} MB)`);
  }
}
if (minShell === version && !Object.keys(shell).length) console.warn('release: warning: this release needs a new app, but no app zips were found: existing installs can only update by hand');

let notes = opt('notes', '');
if (notes.startsWith('@')) notes = fs.readFileSync(notes.slice(1), 'utf8');
const revoke = (opt('revoke', '') || '').split(',').map(s => s.trim()).filter(Boolean);

const manifest = core.signManifest({
  schema: 1, version, channel, date: new Date().toISOString(), notes: notes.trim(), minShell, shellFingerprint: fingerprint,
  ui: { url: urlFor(uiName), sha256: ui.sha256, size: ui.size },
  ...(Object.keys(shell).length ? { shell } : {}),
  ...(revoke.length ? { revoke } : {}),
}, privateKey);
const check = core.readManifest(JSON.stringify(manifest), core.publicKeyFromBase64(derivedPublic));
if (!check.ok) die(`self-check failed: ${check.error}`);
const json = JSON.stringify(manifest, null, 2) + '\n';
fs.writeFileSync(path.join(out, `${channel}.json`), json);
fs.writeFileSync(path.join(out, `manifest-${version}.json`), json);
console.log(`release: wrote ${path.relative(root, out)}/{${uiName}, ${channel}.json, manifest-${version}.json} (ui ${(ui.size / 1024).toFixed(0)} KB)`);
