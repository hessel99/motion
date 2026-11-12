# App updates

Motion updates itself. You build and publish a release once (a tag push does it), and every
installed app picks it up within a few hours, or right away with **Settings → Updates → Check for updates**.

## How it works

An update has two layers, because most changes only touch the interface:

1. **Interface update (most releases).** The interface is the built web app (`dist/`, about 1.3 MB
   zipped). The app downloads the new zip in the background, checks it (see *Security*) and unpacks
   it into its data folder (`~/Library/Application Support/Motion/ui/<version>/`). It is used from
   the next start, or immediately after **Restart to update** (only the window reloads; the project
   is autosaved first, and you are asked about unsaved changes as usual).
   The interface that came with the app always stays in the app as a fallback.

   **Automatic rollback:** a new interface has to report "I started" within 20 seconds. If it does
   not (it hangs, crashes, shows a blank page, or the app is killed twice in a row while it starts),
   Motion switches back to the last interface that worked, remembers that version as broken, never
   downloads it again, and says so in a small notice.

2. **Full app update (only when needed).** When a release changes the app itself (Electron, the
   main process `electron/`, the preload, the agent bridge `bridge/`, runtime dependencies or the
   build config), the release says so with `minShell` (the oldest app version its interface runs
   on). An installed app that is older downloads the full app zip for its Mac (Apple silicon or
   Intel), checks it, unpacks it, and replaces itself **when you quit** (or right away with
   **Restart to update**): a small helper waits until Motion has exited, copies the new `Motion.app`
   next to the old one, clears the download quarantine (`xattr -cr`), signs it ad hoc
   (`codesign --force --deep -s -`), swaps the two with renames (so there is never half an app) and
   reopens Motion. If the swap fails the old app is put back. Log: `~/Library/Application Support/Motion/logs/shell-update.log`.

   The release script works out `minShell` by itself: it hashes `electron/`, `bridge/`, the
   Electron version, runtime dependencies and the build config, and compares with the previous
   release. If nothing there changed, the new interface runs on the old app and only the small
   interface zip is downloaded.

The agent bridge (`bridge/*.mjs`) is **not** part of interface updates: it runs in the main process
with full Node rights and loads `ws` from the app's `node_modules`, so it only changes with a full
app update (that is what the fingerprint above enforces).

What Motion never does: install while you export (the restart button waits, automatic checks are
skipped), interrupt playback or editing, or restart without you clicking (except installing a
downloaded full update when you quit anyway).

**Windows / Linux:** interface updates work the same. Full app updates are not automatic there yet:
Settings → Updates shows "needs a new app download" with a link to the releases page. (The CI
workflow builds macOS only; see *Later* below.)

**Settings → Updates** shows the running version (and the app version, if the interface is newer),
the channel (Stable / Beta), automatic checks (on launch and every 6 hours, on by default),
download progress, **Restart to update**, the release notes ("What's new"), and **Revert** to go
back to the interface that came with the app.

## One-time setup (owner)

The simple path assumes this repository (`hessel99/motion`) is **public**: releases live in its own
GitHub Releases and the workflow publishes them with the built-in `GITHUB_TOKEN`. Nothing else to
create.

1. **Create the signing key** (on your Mac, in the repo):

   ```bash
   node scripts/gen-update-key.mjs --write
   ```

   This writes `.update-key/private.pem` (git-ignored, never commit it) and puts the public key into
   `package.json` → `motionUpdates.publicKey`. Commit `package.json`.

2. **Add the private key as an Actions secret:** GitHub → repository → Settings → Secrets and
   variables → Actions → *New repository secret*, name `MOTION_UPDATE_PRIVATE_KEY`, value: the whole
   file including the `BEGIN`/`END` lines. Or: `gh secret set MOTION_UPDATE_PRIVATE_KEY < .update-key/private.pem`

3. **Back up** `.update-key/private.pem` (password manager). If it is lost, installed apps cannot
   be updated anymore; everyone would have to download a new build by hand once (built with a new key).

4. **Allow the workflow to create releases:** repository → Settings → Actions → General →
   Workflow permissions → *Read and write permissions* (the workflow also asks for
   `contents: write` itself; some organisations restrict it here).

5. **Install the first updating build by hand.** Builds from before this feature cannot update
   themselves. Cut the first release (below), download `Motion-<version>-mac-arm64.dmg` (or `x64`)
   from the release, drag it to **Applications** (updates do not work while Motion runs from the
   disk image), right-click → Open once. From then on it updates itself.

### Alternative: private code, separate public releases repo

If the source repo must stay private, the app cannot download from it without a token, and a token
must never ship inside the app. Use a second, **public** repo that only holds releases:

1. Create an empty public repo, e.g. `hessel99/motion-releases` (one commit, e.g. a README, so it has a default branch).
2. Set `package.json` → `motionUpdates.repo` to `"hessel99/motion-releases"` (this is the one
   place the app reads its update source from; `motionUpdates.feedUrl` can point anywhere else).
3. Create a fine-grained personal access token: GitHub → Settings → Developer settings →
   Fine-grained tokens → *Only select repositories*: `motion-releases` → Repository permissions →
   **Contents: Read and write**. Store it in the private repo as Actions secret `MOTION_RELEASES_TOKEN`.
4. In the private repo add the Actions **variable** (not secret) `MOTION_RELEASES_REPO` =
   `hessel99/motion-releases`.
5. Steps 1-5 of the simple path still apply (signing key secret in the private repo).

The workflow checks that `motionUpdates.repo` and the repo it publishes to are the same, so the
apps always look where releases go.

## Cutting a release

1. Bump the version: `npm version 0.3.0 --no-git-tag-version` (or `0.3.0-beta.1` for the beta channel), commit.
2. Tag and push: `git tag v0.3.0 && git push origin v0.3.0`.
3. The **Release** workflow (`.github/workflows/release.yml`, macOS runner, ~15 min) tests, builds
   the interface and both Mac apps (zip + dmg, arm64 + x64), writes and signs the manifest, creates
   the release `v0.3.0` with all files, and updates the feed (`stable.json` or `beta.json` on the
   fixed release named `updates`). Release notes: the commit messages since the last tag, or
   whatever you type when you run the workflow by hand.

Versions with a `-` (e.g. `0.4.0-beta.2`) go to the beta channel only. People on Beta get the newest
of beta and stable; people on Stable never see betas.

Dry run: Actions → Release → *Run workflow* with "publish" off. Everything is built and signed and
attached to the workflow run, nothing is published.

### Testing a release locally

```bash
node scripts/gen-update-key.mjs                    # once; a local key in .update-key/
npm run release:local                              # interface zip + signed manifest into release/updates/
npm run release:local:mac                          # (on a Mac) also the app zip for this Mac
npm run release:serve                              # serves release/updates on http://127.0.0.1:8790
MOTION_UPDATE_URL=http://127.0.0.1:8790 MOTION_UPDATE_PUBKEY=<public key> npx electron .
```

`MOTION_UPDATE_PUBKEY` only works in unpackaged (development) runs; a packaged app trusts only the
key it was built with. `release:local` refuses to sign with a key that does not match
`package.json` unless you pass `--allow-other-key` (then use `MOTION_UPDATE_PUBKEY` as above).

Automated checks:

- `npx vitest run tests/updates-core.test.mjs tests/updates-integration.test.mjs`: versions,
  manifest parsing, signatures (good / foreign key / tampered), compatibility, rollback decisions,
  and a fake release served over http driving the real updater (download, verify, install, boot,
  roll back, revoke, beta channel, shell staging, and the mac swap helper on fake `.app` folders).
- `npx vite build && xvfb-run -a node scripts/update-check.mjs`: the real Electron app downloads a
  local release, runs it after a restart, installs a broken one with "Restart to update", rolls
  back to the last good version, refuses to restart while exporting, and reverts.

## Rolling back

- **One user, right now:** Settings → Updates → **Revert** (back to the interface that came with
  the app from the next start). Broken interfaces roll back by themselves.
- **Everyone, a bad interface:** release a fixed version (bump, tag, push). For a quick revert,
  check out the last good commit on a branch, bump the version above the bad one, tag, push.
- **Everyone, stop a bad interface immediately:** publish the next release with the bad version
  withdrawn: run `node scripts/release.mjs … --revoke 0.3.0` (in the workflow: add
  `--revoke 0.3.0` to the "Update manifest" step for that run). Apps that see this manifest stop
  using 0.3.0 at their next start and go back to the last good one / the built-in one.
- **A bad full app:** a full app cannot be withdrawn remotely (it replaced the old one). Publish a
  fixed version; its interface and app update as usual. Each user can always reinstall any version
  from the releases page by hand.
- Do not delete the `updates` release or its `stable.json` / `beta.json`: installed apps read them.

## Security model

- **Signed releases.** Every manifest is signed with an Ed25519 key. The private key exists only in
  the `MOTION_UPDATE_PRIVATE_KEY` Actions secret (and your backup); the public key is built into the
  app (`package.json` → `motionUpdates.publicKey`). The app rejects a manifest whose signature does not
  match, so someone who can upload to the releases repo, or who intercepts the download, still
  cannot ship code to installed apps without the private key.
- **Checked downloads.** The signed manifest carries the SHA-256 (interface) / SHA-512 (app) and
  exact size of each file, and each file also has its own signature over
  (kind, version, platform, hash, size), so an old file cannot be replayed as a new version. A
  download that does not match is deleted before it is unpacked.
- **Safe unpacking.** Interface zips are unpacked with fflate into a temporary folder; entries with
  `..`, absolute paths or drive letters are refused; the folder is only renamed into place once
  everything is written. App zips are unpacked with `ditto` and must contain a `Motion.app` whose
  `CFBundleShortVersionString` is the promised version.
- **The interface runs with the same limits as before:** sandboxed renderer, context isolation, only
  the preload API. The bridge and main process never come from a download, only with a full app update.
- **No secrets in the app.** Releases are public; the app downloads without any token.
- **Not covered:** the app is not signed with an Apple Developer ID, so macOS itself does not vouch
  for it; the ad-hoc signature after an update only keeps macOS from refusing to run it. Trust rests
  on the Ed25519 key. Keep it safe.
- Only HTTPS is used in production (GitHub). `MOTION_UPDATE_URL` can point elsewhere (tests), but
  everything still has to be signed with the built-in key.

## Configuration reference

`package.json` → `motionUpdates`:

| key | default | meaning |
| --- | --- | --- |
| `repo` | `hessel99/motion` | GitHub repo whose releases hold the updates |
| `feedUrl` | — | overrides the feed location (default `https://github.com/<repo>/releases/download/updates`) |
| `publicKey` | — | Ed25519 public key (base64, 32 bytes). Empty: updates are off |
| `macShellUpdater` | `helper` | `helper` = the unsigned-app swap described above; `electron-updater` = see below |
| `bootTimeoutMs` | `20000` | how long a new interface has to report "started" |

Environment (development / tests): `MOTION_UPDATE_URL`, `MOTION_UPDATE_PUBKEY` (unpackaged only),
`MOTION_UPDATE_DISABLE=1`, `MOTION_UPDATE_BOOT_TIMEOUT`, `MOTION_UPDATE_FIRST_CHECK_MS`,
`MOTION_UPDATE_DEBUG=1` (log to stdout), `MOTION_USER_DATA` (separate data folder).
Log file: `<app data>/logs/updates.log`.

## Later: signed + notarized app

Squirrel.Mac (what `electron-updater` uses on macOS) only installs updates into an app signed with
a Developer ID. Once there is an Apple Developer account:

1. Add the signing + notarization secrets to the workflow (`CSC_LINK`, `CSC_KEY_PASSWORD`,
   `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`,
   and add `"publish": { "provider": "github", "owner": …, "repo": … }` to the electron-builder config so it
   writes `latest-mac.yml`; upload that file with the version's release.
2. `npm i electron-updater` and set `motionUpdates.macShellUpdater` to `"electron-updater"`.

The signed manifest and interface updates stay as they are; only the full-app step switches to
electron-updater (`electron/updates/index.cjs` → `electronUpdaterShell`). The same path covers
Windows (NSIS) and Linux (AppImage): build them in the workflow and list the platforms in
`motionUpdates.useElectronUpdaterOn`, e.g. `["win32", "linux"]`.

## Code map

- `electron/updates/core.cjs`: versions, manifest format + validation, Ed25519 signing/verification, update and boot/rollback decisions (no Electron, shared with the release scripts)
- `electron/updates/updater.cjs`: check, download, verify, unpack, state file, rollback bookkeeping (no Electron)
- `electron/updates/index.cjs`: Electron glue: which interface to load, the start watchdog, IPC, 6-hourly checks, swap on quit
- `electron/updates/shell-mac.cjs` + `mac-swap.sh`: full app updates for the unsigned Mac build
- `src/app/updates.ts`, `src/ui/settings/Settings.tsx` (Updates), `src/ui/updates/UpdateNotice.tsx`: the interface side
- `scripts/release.mjs`, `scripts/release-lib.mjs`, `scripts/gen-update-key.mjs`, `scripts/serve-release.mjs`, `.github/workflows/release.yml`: publishing
