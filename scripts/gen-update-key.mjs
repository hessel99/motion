#!/usr/bin/env node
// Creates the Ed25519 key pair that signs app updates (see docs/updates.md).
//
//   node scripts/gen-update-key.mjs            writes .update-key/private.pem (git-ignored), prints the public key
//   node scripts/gen-update-key.mjs --write    also puts the public key into package.json motionUpdates.publicKey
//
// The private key must never be committed. Put it in the GitHub Actions secret
// MOTION_UPDATE_PRIVATE_KEY and keep an offline backup (password manager): if it is lost, installed
// apps can only be updated by downloading a new build by hand.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = createRequire(import.meta.url)('../electron/updates/core.cjs');
const dir = path.join(root, '.update-key');
const file = path.join(dir, 'private.pem');

if (fs.existsSync(file) && !process.argv.includes('--force')) {
  console.error(`${path.relative(root, file)} already exists. Use --force to replace it (apps built with the old public key will reject releases signed with the new one).`);
  process.exit(1);
}
const { publicKey, privateKeyPem } = core.generateKeyPair();
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(file, privateKeyPem, { mode: 0o600 });

if (process.argv.includes('--write')) {
  const pkgFile = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.motionUpdates = { ...(pkg.motionUpdates || {}), publicKey };
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
}

console.log(`
Update signing key created.

  public key (goes into the app):   ${publicKey}
  private key (secret!):            ${path.relative(root, file)}

Next steps:
  1. ${process.argv.includes('--write') ? 'package.json motionUpdates.publicKey is set. Commit package.json.' : 'Put the public key into package.json → "motionUpdates": { "publicKey": "' + publicKey + '" } (or rerun with --write) and commit.'}
  2. GitHub → the repo → Settings → Secrets and variables → Actions → New repository secret
       name:  MOTION_UPDATE_PRIVATE_KEY
       value: the whole content of ${path.relative(root, file)} (including the BEGIN/END lines)
     e.g. gh secret set MOTION_UPDATE_PRIVATE_KEY < ${path.relative(root, file)}
  3. Back up ${path.relative(root, file)} somewhere safe (password manager). Never commit it:
     .update-key/ is in .gitignore.
`);
