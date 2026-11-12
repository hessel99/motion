// Agent CLI providers: detection + spawning one non-interactive turn per chat message.
// Each turn is a fresh process; conversation continuity uses the CLI's own session resume.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeLine, parseCodexLine, parseGeminiLine, splitJsonLines } from './parsers.mjs';

const IS_WIN = process.platform === 'win32';

/** GUI-launched apps (Electron on macOS) don't inherit the shell PATH; add the usual CLI install dirs. */
export function augmentedEnv(extra = {}) {
  const home = os.homedir();
  const dirs = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    IS_WIN ? path.join(process.env.APPDATA ?? '', 'npm') : '',
  ].filter(Boolean);
  // nvm installs: every node version's bin dir (newest first)
  try {
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    for (const v of fs.readdirSync(nvm).sort().reverse()) dirs.push(path.join(nvm, v, 'bin'));
  } catch { /* no nvm */ }
  const cur = (process.env.PATH ?? '').split(path.delimiter);
  const PATH = [...cur, ...dirs.filter((d) => !cur.includes(d))].join(path.delimiter);
  return { ...process.env, PATH, ...extra };
}

export const PROVIDERS = {
  claude: { id: 'claude', name: 'Claude Code', bin: 'claude' },
  codex: { id: 'codex', name: 'OpenAI Codex', bin: 'codex' },
  gemini: { id: 'gemini', name: 'Gemini CLI', bin: 'gemini' },
};

let providerCache = null;

/** Detect installed CLIs via `<cli> --version` (cached; pass force to refresh). */
export async function detectProviders(force = false) {
  if (providerCache && !force) return providerCache;
  providerCache = Promise.all(
    Object.values(PROVIDERS).map(
      (p) =>
        new Promise((resolve) => {
          execFile(p.bin, ['--version'], { env: augmentedEnv(), timeout: 8000, shell: IS_WIN, windowsHide: true }, (err, stdout) => {
            if (err) return resolve({ id: p.id, name: p.name, available: false });
            const version = String(stdout).trim().split('\n')[0];
            resolve({ id: p.id, name: p.name, available: true, version });
          });
        }),
    ),
  );
  return providerCache;
}

/** Default working dir for agent processes. Stable so `--resume` finds claude's per-cwd sessions. */
export function defaultWorkDir() {
  const dir = path.join(os.homedir(), '.motion', 'agent');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/**
 * Build the command for one turn. Pure (except gemini's settings file), exported for tests.
 * @returns {{bin:string, args:string[], stdin?:string, env?:object, parse:Function}}
 */
export function buildCommand(provider, { message, sessionId, model, systemPrompt, mcpUrl, workDir }) {
  switch (provider) {
    case 'claude': {
      const mcpConfig = JSON.stringify({ mcpServers: { motion: { type: 'http', url: mcpUrl } } });
      const args = [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--mcp-config', mcpConfig,
        '--strict-mcp-config',
        '--allowedTools', 'mcp__motion',
        '--permission-mode', 'default',
      ];
      if (sessionId) args.push('--resume', sessionId);
      if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
      if (model) args.push('--model', model);
      // Load the editor's MCP tools up front instead of via deferred ToolSearch (one less round trip).
      return { bin: 'claude', args, stdin: message, env: { ENABLE_TOOL_SEARCH: 'false' }, parse: parseClaudeLine };
    }
    case 'codex': {
      // -c values are TOML; the quotes make the URL a TOML string.
      const args = ['-c', `mcp_servers.motion.url="${mcpUrl}"`, 'exec', '--json', '--skip-git-repo-check'];
      if (model) args.push('-m', model);
      if (sessionId) args.push('resume', sessionId);
      args.push('-'); // read prompt from stdin
      const prompt = !sessionId && systemPrompt ? `${systemPrompt}\n\n---\n\n${message}` : message;
      return { bin: 'codex', args, stdin: prompt, parse: parseCodexLine };
    }
    case 'gemini': {
      // Gemini reads MCP servers from settings files; point the system settings at a generated one.
      const settingsPath = path.join(workDir, 'gemini-motion-settings.json');
      try {
        writeFileSync(settingsPath, JSON.stringify({ mcpServers: { motion: { httpUrl: mcpUrl, trust: true } } }, null, 2));
      } catch {}
      const prompt = !sessionId && systemPrompt ? `${systemPrompt}\n\n---\n\n${message}` : message;
      const args = ['-p', prompt, '--output-format', 'stream-json', '--allowed-mcp-server-names', 'motion'];
      if (sessionId) args.push('--resume', sessionId);
      if (model) args.push('-m', model);
      return { bin: 'gemini', args, env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath }, parse: parseGeminiLine };
    }
    default:
      throw new Error(`unknown provider: ${provider}`);
  }
}

/**
 * Run one turn. Calls onEvent(normalizedEvent) for each event; guarantees exactly one terminal
 * event ('done' or 'error'). Returns {cancel()}.
 */
export function runTurn(provider, opts, onEvent, log = () => {}) {
  const workDir = opts.workDir ?? defaultWorkDir();
  let cmd;
  try {
    cmd = buildCommand(provider, { ...opts, workDir });
  } catch (e) {
    onEvent({ kind: 'error', message: e.message });
    return { cancel() {} };
  }
  const state = {};
  let terminal = false;
  let cancelled = false;
  let stderrTail = '';
  const emit = (ev) => {
    if (terminal) return;
    if (ev.kind === 'done' || ev.kind === 'error') {
      // an 'error' followed by 'done' in the same batch: error is terminal for the UI only via done
      if (ev.kind === 'done') terminal = true;
    }
    onEvent(ev);
  };
  const finishWithError = (message) => {
    if (terminal) return;
    onEvent({ kind: 'error', message });
    onEvent({ kind: 'done' });
    terminal = true;
  };

  log(`[bridge] spawn ${cmd.bin} ${provider}${opts.sessionId ? ' (resume)' : ''}`);
  let child;
  try {
    child = spawn(cmd.bin, cmd.args, {
      cwd: workDir,
      env: augmentedEnv(cmd.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    finishWithError(`failed to start ${cmd.bin}: ${e.message}`);
    return { cancel() {} };
  }

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    const [objs, rest] = splitJsonLines(buf);
    buf = rest;
    for (const o of objs) for (const ev of cmd.parse(o, state)) emit(ev);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });
  child.on('error', (e) => {
    finishWithError(e.code === 'ENOENT' ? `${cmd.bin} CLI not found on PATH` : `${cmd.bin} failed: ${e.message}`);
  });
  child.on('close', (code, signal) => {
    if (buf.trim()) {
      const [objs] = splitJsonLines(buf + '\n');
      for (const o of objs) for (const ev of cmd.parse(o, state)) emit(ev);
    }
    if (cancelled) return finishWithError('cancelled');
    if (!terminal) {
      if (code === 0 && provider !== 'claude') emit({ kind: 'done' });
      else finishWithError(`${cmd.bin} exited with ${signal ?? `code ${code}`}${stderrTail ? `: ${stderrTail.trim().slice(-800)}` : ''}`);
    }
  });
  if (cmd.stdin != null) {
    child.stdin.on('error', () => {});
    child.stdin.end(cmd.stdin);
  } else child.stdin.end();

  return {
    cancel() {
      if (terminal || cancelled) return;
      cancelled = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { if (child.exitCode == null) child.kill('SIGKILL'); } catch {} }, 3000).unref?.();
    },
  };
}
