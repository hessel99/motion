// Shared pieces of the release tooling (scripts/release.mjs, tests): the UI bundle zip, the shell
// fingerprint that decides "minShell", hashing. Signing + manifest format live in
// electron/updates/core.cjs so the app and the release use the very same code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { zipSync } from 'fflate';

const require = createRequire(import.meta.url);
export const core = require('../electron/updates/core.cjs');

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/**
 * zip the built renderer (vite dist/) as a UI bundle. Source maps are left out (they are big and
 * only for debugging). Fixed timestamps: the same dist gives the same bytes.
 */
export function buildUiZip(distDir) {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) throw new Error(`${distDir}/index.html missing: run "npx vite build" first`);
  const files = {};
  for (const rel of walk(distDir)) {
    if (rel.endsWith('.map')) continue;
    files[rel] = [new Uint8Array(fs.readFileSync(path.join(distDir, rel))), { mtime: new Date('2020-01-01T00:00:00Z') }];
  }
  return Buffer.from(zipSync(files, { level: 9 }));
}

/**
 * what the app shell is made of: main process + preload + updater (electron/), the agent bridge
 * (bridge/, it runs in the main process with node_modules), the Electron version, runtime
 * dependencies and the build config. When this changes, a new UI needs the new shell (minShell).
 * The renderer (src/, dist/) is deliberately not part of it.
 */
export function shellFingerprint(root) {
  const h = crypto.createHash('sha256');
  for (const dir of ['electron', 'bridge']) {
    for (const rel of walk(path.join(root, dir))) {
      h.update(`${dir}/${rel}\0`);
      h.update(fs.readFileSync(path.join(root, dir, rel)));
      h.update('\0');
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  let lock = {};
  try { lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')); } catch { /* */ }
  const locked = (name) => lock.packages?.[`node_modules/${name}`]?.version ?? null;
  const deps = Object.keys(pkg.dependencies || {}).sort().map(n => [n, locked(n) ?? pkg.dependencies[n]]);
  h.update(core.canonicalJson({
    main: pkg.main, build: pkg.build, motionUpdates: pkg.motionUpdates || null,
    electron: locked('electron') ?? pkg.devDependencies?.electron ?? null, deps,
  }));
  return h.digest('hex');
}

export function hashFile(file) {
  const buf = fs.readFileSync(file);
  return {
    size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    sha512: crypto.createHash('sha512').update(buf).digest('hex'),
  };
}

/** electron-builder zip names (package.json build.mac.artifactName) -> manifest platform keys */
export function shellPlatformOf(fileName) {
  const m = /-(mac|win|linux)-(arm64|x64)\.(zip|exe|AppImage)$/.exec(fileName);
  if (!m) return null;
  if (m[1] === 'mac' && m[3] !== 'zip') return null;
  return `${{ mac: 'darwin', win: 'win32', linux: 'linux' }[m[1]]}-${m[2]}`;
}
