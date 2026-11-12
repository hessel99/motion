// Turn raw CLI failures into actionable, typed errors for the editor UI.
//   {kind:'error', message, errorKind, hint}
// errorKind: turn_budget | not_installed | auth | rate_limit | overloaded | network | timeout | cancelled | bridge | unknown

const LOGIN = {
  claude: 'Open a terminal, run `claude` and log in (or `/login` inside it), then retry.',
  codex: 'Open a terminal and run `codex login`, then retry.',
  gemini: 'Open a terminal, run `gemini` and sign in, then retry.',
};
const INSTALL = {
  claude: 'Install Claude Code: `npm i -g @anthropic-ai/claude-code`, then run `claude` once to log in.',
  codex: 'Install Codex CLI: `npm i -g @openai/codex`, then run `codex login`.',
  gemini: 'Install Gemini CLI: `npm i -g @google/gemini-cli`, then run `gemini` once to sign in.',
};

/** @returns {{errorKind:string, hint?:string}} */
export function classifyError(message, provider = 'claude') {
  const m = String(message ?? '');
  if (/^cancell?ed$/i.test(m.trim())) return { errorKind: 'cancelled' };
  if (/error_max_turns|max(imum)?[ _-]?turns/i.test(m)) return { errorKind: 'turn_budget', hint: 'The agent used its turn budget for this message (Settings → Models → Turn budget). Say **continue** to let it finish.' };
  if (/not found on PATH|ENOENT|command not found|is not recognized as an internal/i.test(m)) return { errorKind: 'not_installed', hint: INSTALL[provider] ?? INSTALL.claude };
  if (/inactive for|timed out|timeout/i.test(m) && !/ETIMEDOUT/.test(m)) return { errorKind: 'timeout', hint: 'The agent stopped responding. Retry, or try a smaller request.' };
  if (/rate.?limit|usage limit|limit reached|quota|\b429\b|too many requests/i.test(m)) return { errorKind: 'rate_limit', hint: 'Your subscription limit was reached. Wait for it to reset or switch the model/provider.' };
  if (/overloaded|\b529\b|\b503\b|internal server error|\b500\b/i.test(m)) return { errorKind: 'overloaded', hint: 'The model service is busy. Retry in a moment.' };
  if (/invalid api key|not logged in|log ?in|please run \/login|authenticat|unauthori[sz]ed|\b401\b|\b403\b|oauth|token (has )?expired|credentials/i.test(m)) return { errorKind: 'auth', hint: LOGIN[provider] ?? LOGIN.claude };
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network|fetch failed|getaddrinfo/i.test(m)) return { errorKind: 'network', hint: 'Check your internet connection, then retry.' };
  return { errorKind: 'unknown' };
}
