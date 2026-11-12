// agent turn handling in the bridge, against a fake `claude` CLI that replays recorded stream-json:
// success, auth failure, missing CLI, idle timeout and cancellation. no real agent is spawned.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTurn, buildCommand } from '../bridge/providers.mjs';
import { classifyError } from '../bridge/errors.mjs';

let dir;
let oldPath;

const FAKE = `#!/usr/bin/env node
const mode = process.env.FAKE_CLAUDE_MODE;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (mode === 'hang') { out({ type: 'system', subtype: 'init', session_id: 's-h' }); setInterval(() => {}, 1000); return; }
  if (mode === 'auth') { out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', session_id: 's-a' }); return; }
  if (mode === 'old' && process.argv.includes('--tools')) { process.stderr.write("error: unknown option '--tools'\\n"); process.exit(1); }
  if (mode === 'crash') { process.stderr.write('Error: getaddrinfo ENOTFOUND api.anthropic.com\\n'); process.exit(1); }
  out({ type: 'system', subtype: 'init', session_id: 's-1' });
  out({ type: 'assistant', session_id: 's-1', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__motion__animate', input: { tracks: [] } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'ok: 2 tracks on 1 layers' }] }] } });
  out({ type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'echo:' + input.slice(0, 20) + ' args:' + process.argv.slice(2).join(' ').includes('mcp__motion__get_animation') }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's-1', total_cost_usd: 0.01, duration_ms: 900, num_turns: 2, usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 50 } });
});
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-fake-claude-'));
  fs.writeFileSync(path.join(dir, 'claude'), FAKE, { mode: 0o755 });
  oldPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + oldPath;
});
afterAll(() => {
  process.env.PATH = oldPath;
  delete process.env.FAKE_CLAUDE_MODE;
  fs.rmSync(dir, { recursive: true, force: true });
});

function turn(mode, opts = {}) {
  process.env.FAKE_CLAUDE_MODE = mode;
  return new Promise((resolve) => {
    const events = [];
    const run = runTurn('claude', { message: 'hello there', mcpUrl: 'http://127.0.0.1:1/mcp', workDir: dir, ...opts }, (e) => {
      events.push(e);
      if (e.kind === 'done') resolve(events);
    });
    opts.onRun?.(run);
  });
}

describe.skipIf(process.platform === 'win32')('bridge agent turns (fake claude CLI)', () => {
  it('relays a recorded successful turn with usage + cost', async () => {
    const ev = await turn('ok');
    expect(ev.map((e) => e.kind)).toEqual(['session', 'tool_use', 'tool_result', 'text', 'done']);
    expect(ev[1].name).toBe('animate');
    expect(ev[3].text).toBe('echo:hello there args:false');
    expect(ev[4]).toMatchObject({ costUsd: 0.01, durationMs: 900, numTurns: 2, usage: { input: 1010, cached: 1000, output: 50 } });
  });

  it('Ask mode restricts the allowed tools to the read-only ones', async () => {
    const ev = await turn('ok', { readOnlyTools: ['get_animation', 'contact_sheet'] });
    expect(ev.find((e) => e.kind === 'text').text).toContain('args:true');
  });

  it('auth failures become typed, actionable errors', async () => {
    const ev = await turn('auth');
    const err = ev.find((e) => e.kind === 'error');
    expect(err).toMatchObject({ errorKind: 'auth' });
    expect(err.hint).toMatch(/log in/);
    expect(ev.at(-1).kind).toBe('done');
  });

  it('crashes include stderr and are classified (network)', async () => {
    const ev = await turn('crash');
    const err = ev.find((e) => e.kind === 'error');
    expect(err.message).toMatch(/ENOTFOUND/);
    expect(err.errorKind).toBe('network');
  });

  it('kills a silent CLI after the idle timeout', async () => {
    const t0 = Date.now();
    const ev = await turn('hang', { idleMs: 300 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ errorKind: 'timeout' });
    expect(ev.filter((e) => e.kind === 'done').length).toBe(1);
  });

  it('cancel ends the turn with a "cancelled" error kind', async () => {
    const ev = await turn('hang', { onRun: (r) => setTimeout(() => r.cancel(), 150) });
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ errorKind: 'cancelled' });
  });

  it('uses lean flags (no built-in tools) and falls back for CLIs without --tools', async () => {
    const lean = buildCommand('claude', { message: 'x', mcpUrl: 'http://127.0.0.1:1/mcp', workDir: dir }).args;
    expect(lean.slice(lean.indexOf('--tools'), lean.indexOf('--tools') + 3)).toEqual(['--tools', '', '--disable-slash-commands']);
    const ev = await turn('old');
    expect(ev.map((e) => e.kind)).toEqual(['session', 'tool_use', 'tool_result', 'text', 'done']);
    // remembered: later turns don't try the lean flags again
    expect(buildCommand('claude', { message: 'x', mcpUrl: 'http://127.0.0.1:1/mcp', workDir: dir }).args).not.toContain('--tools');
  });

  it('a missing CLI is reported with install instructions', async () => {
    process.env.FAKE_CLAUDE_MODE = 'ok';
    const ev = await new Promise((resolve) => {
      const events = [];
      runTurn('codex', { message: 'x', mcpUrl: 'http://127.0.0.1:1/mcp', workDir: dir }, (e) => { events.push(e); if (e.kind === 'done') resolve(events); });
    });
    // codex is not installed in the test environment (if it is, it still must end with done)
    if (ev.some((e) => e.errorKind === 'not_installed')) expect(ev.find((e) => e.kind === 'error').hint).toMatch(/npm i -g/);
    expect(ev.at(-1).kind).toBe('done');
  }, 20000);
});

describe('error classification', () => {
  it.each([
    ['claude CLI not found on PATH', 'not_installed'],
    ['Invalid API key · Please run /login', 'auth'],
    ['OAuth token has expired', 'auth'],
    ['Claude AI usage limit reached|1700000000', 'rate_limit'],
    ['API Error: 529 Overloaded', 'overloaded'],
    ['fetch failed', 'network'],
    ['cancelled', 'cancelled'],
    ['claude was inactive for 300s and was stopped (timed out).', 'timeout'],
    ['something odd', 'unknown'],
  ])('%s → %s', (msg, kind) => { expect(classifyError(msg).errorKind).toBe(kind); });

  it('buildCommand pre-approves all motion tools normally, only read-only ones in Ask mode', () => {
    const base = { message: 'x', mcpUrl: 'http://127.0.0.1:1/mcp', workDir: os.tmpdir() };
    const a = buildCommand('claude', base).args;
    expect(a[a.indexOf('--allowedTools') + 1]).toBe('mcp__motion');
    const b = buildCommand('claude', { ...base, readOnlyTools: ['get_document', 'screenshot'] }).args;
    expect(b[b.indexOf('--allowedTools') + 1]).toBe('mcp__motion__get_document,mcp__motion__screenshot');
  });
});
