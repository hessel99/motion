// unit tests for the update logic in electron/updates/core.cjs: versions, manifest parsing,
// signatures (good / bad / tampered), update decisions, boot + rollback decisions.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../electron/updates/core.cjs');

const keys = core.generateKeyPair();
const priv = core.privateKeyFromPem(keys.privateKeyPem);
const pub = core.publicKeyFromBase64(keys.publicKey);
const other = core.generateKeyPair();
const otherPriv = core.privateKeyFromPem(other.privateKeyPem);

const H64 = 'a'.repeat(64), H128 = 'b'.repeat(128);
function base(extra = {}) {
  return {
    schema: 1, version: '0.2.0', channel: 'stable', date: '2026-11-12T00:00:00Z', notes: '- faster', minShell: '0.1.0',
    ui: { url: 'Motion-0.2.0-ui.zip', sha256: H64, size: 1234 },
    shell: { 'darwin-arm64': { url: 'Motion-0.2.0-mac-arm64.zip', sha512: H128, size: 99999 } },
    ...extra,
  };
}
const signed = (extra) => core.signManifest(base(extra), priv);

describe('versions', () => {
  it('parses and orders semver incl. prereleases', () => {
    expect(core.parseVersion('v1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(core.parseVersion('1.2')).toBeNull();
    expect(core.parseVersion('1.2.3; rm -rf')).toBeNull();
    const sorted = ['1.0.0', '0.9.9', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-alpha', '1.0.1', '1.0.0-beta'].sort(core.compareVersions);
    expect(sorted).toEqual(['0.9.9', '1.0.0-alpha', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0', '1.0.1']);
    expect(core.compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(core.compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(core.isPrerelease('1.0.0-beta.1')).toBe(true);
    expect(core.isPrerelease('1.0.0')).toBe(false);
  });
});

describe('manifest parsing', () => {
  it('accepts a signed manifest', () => {
    const r = core.readManifest(JSON.stringify(signed()), pub);
    expect(r.ok).toBe(true);
    expect(r.manifest.version).toBe('0.2.0');
  });
  it('rejects malformed input with a reason', () => {
    expect(core.parseManifest('{nope').error).toMatch(/JSON/);
    expect(core.parseManifest('[]').ok).toBe(false);
    expect(core.parseManifest({ ...signed(), schema: 2 }).error).toMatch(/schema/);
    expect(core.parseManifest({ ...signed(), version: 'latest' }).error).toMatch(/version/);
    expect(core.parseManifest({ ...signed(), minShell: '0.3.0' }).error).toMatch(/minShell/);
    expect(core.parseManifest({ ...signed(), ui: { ...signed().ui, sha256: 'xyz' } }).error).toMatch(/ui bundle/);
    expect(core.parseManifest({ ...signed(), shell: { 'beos-x86': signed().shell['darwin-arm64'] } }).error).toMatch(/platform/);
    const { sig, ...unsigned } = signed();
    expect(core.parseManifest(unsigned).error).toMatch(/not signed/);
  });
});

describe('signatures', () => {
  it('verifies a good signature', () => {
    expect(core.verifyManifest(signed(), pub)).toBeNull();
  });
  it('rejects a manifest signed with another key', () => {
    expect(core.verifyManifest(core.signManifest(base(), otherPriv), pub)).toMatch(/manifest signature/);
  });
  it('rejects tampering with any field', () => {
    const m = signed();
    expect(core.verifyManifest({ ...m, notes: 'evil' }, pub)).toMatch(/manifest signature/);
    expect(core.verifyManifest({ ...m, minShell: '0.0.1' }, pub)).toMatch(/manifest signature/);
    expect(core.verifyManifest({ ...m, ui: { ...m.ui, sha256: 'c'.repeat(64) } }, pub)).toMatch(/signature/);
    expect(core.verifyManifest({ ...m, ui: { ...m.ui, url: 'https://evil.example/x.zip' } }, pub)).toMatch(/manifest signature/);
    expect(core.verifyManifest({ ...m, sig: m.sig.slice(0, -4) + 'AAA=' }, pub)).toMatch(/manifest signature/);
    expect(core.verifyManifest({ ...m, sig: 'garbage' }, pub)).toMatch(/manifest signature/);
  });
  it('artifact signatures bind version and platform (no replay of an old artifact)', () => {
    const m = signed();
    const st = core.artifactStatement('shell', '0.2.0', 'darwin-arm64', H128, 99999);
    expect(core.verifyText(pub, st, m.shell['darwin-arm64'].sig)).toBe(true);
    expect(core.verifyText(pub, core.artifactStatement('shell', '0.2.0', 'darwin-x64', H128, 99999), m.shell['darwin-arm64'].sig)).toBe(false);
    expect(core.verifyText(pub, core.artifactStatement('ui', '0.3.0', null, H64, 1234), m.ui.sig)).toBe(false);
  });
  it('canonical JSON is key-order independent', () => {
    expect(core.canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(core.canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
  });
  it('rejects public keys of the wrong size', () => {
    expect(() => core.publicKeyFromBase64('AAAA')).toThrow(/32 bytes/);
  });
});

describe('update decision', () => {
  const env = { shellVersion: '0.1.0', uiVersion: '0.1.0', platform: 'darwin-arm64', bad: [], shellUpdates: true };
  it('up to date', () => {
    expect(core.decideUpdate(base({ version: '0.1.0', minShell: '0.1.0' }), env).action).toBe('none');
  });
  it('UI-only update when the shell is new enough', () => {
    expect(core.decideUpdate(base(), env)).toMatchObject({ action: 'ui', version: '0.2.0' });
  });
  it('shell update when the UI needs a newer shell', () => {
    expect(core.decideUpdate(base({ minShell: '0.2.0' }), env).action).toBe('shell');
  });
  it('shell update unavailable on platforms without an artifact or self-update', () => {
    expect(core.decideUpdate(base({ minShell: '0.2.0' }), { ...env, platform: 'linux-x64' }).action).toBe('shell-unavailable');
    expect(core.decideUpdate(base({ minShell: '0.2.0' }), { ...env, shellUpdates: false, shellBlocked: 'run from dmg' })).toMatchObject({ action: 'shell-unavailable', reason: 'run from dmg' });
  });
  it('skips versions that failed to start', () => {
    expect(core.decideUpdate(base(), { ...env, bad: ['0.2.0'] }).action).toBe('none');
  });
  it('does not re-download a UI that already runs', () => {
    expect(core.decideUpdate(base(), { ...env, uiVersion: '0.2.0' }).action).toBe('none');
  });
  it('beta users get the newest of stable and beta; stable users never see prereleases', () => {
    const list = [{ version: '0.2.0' }, { version: '0.3.0-beta.1' }];
    expect(core.pickManifest(list, 'beta').version).toBe('0.3.0-beta.1');
    expect(core.pickManifest(list, 'stable').version).toBe('0.2.0');
    expect(core.pickManifest([{ version: '0.3.0' }, { version: '0.3.0-beta.1' }], 'beta').version).toBe('0.3.0');
  });
});

describe('boot + rollback decision', () => {
  const env = { shellVersion: '0.1.0', bundledVersion: '0.1.0', revoked: [], maxAttempts: 2 };
  const b = (v, minShell = '0.1.0') => ({ version: v, dir: v, minShell });
  it('no downloads: bundled', () => {
    expect(core.decideBoot({}, env).source).toBe('bundled');
  });
  it('pending bundle becomes active and counts a boot attempt', () => {
    const d = core.decideBoot({ pending: b('0.2.0') }, env);
    expect(d).toMatchObject({ source: 'downloaded', version: '0.2.0' });
    expect(d.state.active.version).toBe('0.2.0');
    expect(d.state.pending).toBeNull();
    expect(d.state.boot).toEqual({ version: '0.2.0', attempts: 1 });
  });
  it('after app-ready the next start counts from zero again', () => {
    let s = core.decideBoot({ pending: b('0.2.0') }, env).state;
    s = core.markBootGood(s);
    expect(s.boot).toBeNull();
    const d = core.decideBoot(s, env);
    expect(d.source).toBe('downloaded');
    expect(d.state.boot.attempts).toBe(1);
  });
  it('rolls back after maxAttempts starts without app-ready (crash / hang / killed)', () => {
    let s = core.decideBoot({ pending: b('0.2.0') }, env).state; // attempt 1, never ready
    let d = core.decideBoot(s, env); // attempt 2
    expect(d.source).toBe('downloaded');
    d = core.decideBoot(d.state, env); // 2 failed attempts -> bundled
    expect(d.source).toBe('bundled');
    expect(d.state.bad).toContain('0.2.0');
    expect(d.dropped[0]).toMatchObject({ version: '0.2.0', reason: 'did not start' });
    expect(core.decideBoot(d.state, env).source).toBe('bundled');
  });
  it('markBootBad (watchdog) drops the active bundle immediately', () => {
    const s = core.decideBoot({ pending: b('0.2.0') }, env).state;
    const bad = core.markBootBad(s, '0.2.0');
    expect(bad.active).toBeNull();
    expect(core.decideBoot(bad, env).source).toBe('bundled');
    // the same version downloaded again later is not used either
    expect(core.decideBoot({ ...bad, pending: b('0.2.0') }, env).source).toBe('bundled');
  });
  it('a newer good bundle replaces a bad one', () => {
    const s = core.markBootBad(core.decideBoot({ pending: b('0.2.0') }, env).state, '0.2.0');
    expect(core.decideBoot({ ...s, pending: b('0.2.1') }, env)).toMatchObject({ source: 'downloaded', version: '0.2.1' });
  });
  it('ignores bundles that are older than the shell, need a newer shell, or were revoked', () => {
    expect(core.decideBoot({ active: b('0.2.0') }, { ...env, bundledVersion: '0.3.0', shellVersion: '0.3.0' }).source).toBe('bundled');
    expect(core.decideBoot({ active: b('0.2.0', '0.2.0') }, env).source).toBe('bundled');
    expect(core.decideBoot({ active: b('0.2.0') }, { ...env, revoked: ['0.2.0'] }).dropped[0].reason).toMatch(/withdrawn/);
  });
  it('zip entry names cannot escape the folder', () => {
    expect(core.safeEntryName('assets/a.js')).toBe('assets/a.js');
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\x', 'a\\..\\..\\x', '']) expect(core.safeEntryName(bad)).toBeNull();
  });
});
