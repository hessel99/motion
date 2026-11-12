// Pure line parsers that turn each agent CLI's JSONL output into normalized chat events:
//   {kind:'session', sessionId} | {kind:'text_delta', text} | {kind:'text', text}
//   {kind:'tool_use', id, name, input} | {kind:'tool_result', id, isError, summary}
//   {kind:'thinking', text} | {kind:'done', result?, costUsd?, durationMs?} | {kind:'error', message}
//
// Each parser: (obj, state) => event[]  where obj is one parsed JSON line and state is a
// per-run mutable object (create with {}), used to dedupe session ids etc.

const MCP_PREFIX = 'mcp__motion__';
const SUMMARY_MAX = 400;

/** Strip the claude MCP prefix so the editor sees its own tool names. */
export function displayToolName(name) {
  return typeof name === 'string' && name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/** Summarize MCP-ish tool result content (string | block[]) to a short string. */
export function summarizeContent(content) {
  let s = '';
  if (typeof content === 'string') s = content;
  else if (Array.isArray(content)) {
    s = content
      .map((b) => {
        if (!b || typeof b !== 'object') return String(b ?? '');
        if (b.type === 'text') return b.text ?? '';
        if (b.type === 'image') return '[image]';
        return `[${b.type ?? 'block'}]`;
      })
      .join('\n');
  } else if (content != null) {
    try { s = JSON.stringify(content); } catch { s = String(content); }
  }
  return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) + '…' : s;
}

function emitSession(state, id, out) {
  if (id && state.sessionId !== id) {
    state.sessionId = id;
    out.push({ kind: 'session', sessionId: id });
  }
}

/**
 * Claude Code `-p --output-format stream-json --verbose --include-partial-messages`.
 * Verified against claude 2.1.x output: lines of type system(init)/stream_event/assistant/user/result,
 * plus misc ones (rate_limit_event, active_goal, ...) that are ignored.
 */
export function parseClaudeLine(obj, state = {}) {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init') emitSession(state, obj.session_id, out);
      break;
    case 'stream_event': {
      const ev = obj.event;
      // ignore sub-agent streams
      if (obj.parent_tool_use_id) break;
      if (ev?.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta' && ev.delta.text) out.push({ kind: 'text_delta', text: ev.delta.text });
      }
      break;
    }
    case 'assistant': {
      if (obj.parent_tool_use_id) break;
      emitSession(state, obj.session_id, out);
      const content = obj.message?.content;
      if (!Array.isArray(content)) break;
      for (const b of content) {
        if (b.type === 'text' && b.text) out.push({ kind: 'text', text: b.text });
        else if (b.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', text: b.thinking });
        else if (b.type === 'tool_use') out.push({ kind: 'tool_use', id: b.id, name: displayToolName(b.name), input: b.input ?? {} });
      }
      break;
    }
    case 'user': {
      if (obj.parent_tool_use_id) break;
      const content = obj.message?.content;
      if (!Array.isArray(content)) break;
      for (const b of content) {
        if (b.type === 'tool_result') {
          out.push({ kind: 'tool_result', id: b.tool_use_id, isError: !!b.is_error, summary: summarizeContent(b.content) });
        }
      }
      break;
    }
    case 'result': {
      emitSession(state, obj.session_id, out);
      if (obj.is_error || (obj.subtype && obj.subtype !== 'success')) {
        const msg = typeof obj.result === 'string' && obj.result ? obj.result : (obj.errors?.join?.('\n') || obj.subtype || 'claude reported an error');
        if (obj.subtype === 'error_max_turns') { out.push({ kind: 'error', message: `Reached the turn budget (error_max_turns, ${obj.num_turns ?? '?'} turns).` }); }
        else out.push({ kind: 'error', message: msg });
      }
      out.push({
        kind: 'done',
        result: typeof obj.result === 'string' ? obj.result : undefined,
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
        durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined,
        numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : undefined,
        usage: obj.usage && typeof obj.usage === 'object' ? {
          input: (obj.usage.input_tokens ?? 0) + (obj.usage.cache_creation_input_tokens ?? 0) + (obj.usage.cache_read_input_tokens ?? 0),
          cached: obj.usage.cache_read_input_tokens ?? 0,
          output: obj.usage.output_tokens ?? 0,
        } : undefined,
      });
      state.finished = true;
      break;
    }
  }
  return out;
}

/**
 * OpenAI Codex `codex exec --json` (ThreadEvent JSONL, codex-rs/exec/src/exec_events.rs):
 * thread.started{thread_id} turn.started turn.completed{usage} turn.failed{error{message}}
 * item.started/updated/completed{item{id,type,...}} error{message}
 */
export function parseCodexLine(obj, state = {}) {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  const item = obj.item;
  switch (obj.type) {
    case 'thread.started':
      emitSession(state, obj.thread_id, out);
      break;
    case 'item.started':
      if (item?.type === 'mcp_tool_call') out.push({ kind: 'tool_use', id: item.id, name: item.tool, input: item.arguments ?? {} });
      else if (item?.type === 'command_execution') out.push({ kind: 'tool_use', id: item.id, name: 'shell', input: { command: item.command } });
      if (item) (state.started ??= new Set()).add(item.id);
      break;
    case 'item.completed': {
      if (!item) break;
      const seen = state.started?.has(item.id);
      if (item.type === 'agent_message' && item.text) out.push({ kind: 'text', text: item.text });
      else if (item.type === 'reasoning' && item.text) out.push({ kind: 'thinking', text: item.text });
      else if (item.type === 'mcp_tool_call') {
        if (!seen) out.push({ kind: 'tool_use', id: item.id, name: item.tool, input: item.arguments ?? {} });
        const isError = item.status === 'failed' || !!item.error;
        out.push({ kind: 'tool_result', id: item.id, isError, summary: item.error?.message ?? summarizeContent(item.result?.content) });
      } else if (item.type === 'command_execution') {
        if (!seen) out.push({ kind: 'tool_use', id: item.id, name: 'shell', input: { command: item.command } });
        out.push({ kind: 'tool_result', id: item.id, isError: item.status === 'failed' || item.status === 'declined' || (item.exit_code ?? 0) !== 0, summary: summarizeContent(item.aggregated_output ?? '') });
      } else if (item.type === 'error' && item.message) out.push({ kind: 'error', message: item.message });
      break;
    }
    case 'turn.completed':
      out.push({ kind: 'done' });
      state.finished = true;
      break;
    case 'turn.failed':
      out.push({ kind: 'error', message: obj.error?.message ?? 'codex turn failed' });
      state.finished = true;
      state.failed = true;
      break;
    case 'error':
      out.push({ kind: 'error', message: obj.message ?? 'codex error' });
      break;
  }
  return out;
}

/**
 * Gemini CLI `gemini -p ... --output-format stream-json`
 * (packages/core/src/output/types.ts): init{session_id,model} message{role,content,delta?}
 * tool_use{tool_name,tool_id,parameters} tool_result{tool_id,status,output?,error?}
 * error{severity,message} result{status,error?,stats?}
 */
export function parseGeminiLine(obj, state = {}) {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  switch (obj.type) {
    case 'init':
      emitSession(state, obj.session_id, out);
      break;
    case 'message':
      if (obj.role !== 'assistant' || !obj.content) break;
      if (obj.delta) {
        state.buf = (state.buf ?? '') + obj.content;
        out.push({ kind: 'text_delta', text: obj.content });
      } else out.push({ kind: 'text', text: obj.content });
      break;
    case 'tool_use':
      flushGeminiText(state, out);
      out.push({ kind: 'tool_use', id: obj.tool_id, name: displayGeminiTool(obj.tool_name), input: obj.parameters ?? {} });
      break;
    case 'tool_result':
      out.push({ kind: 'tool_result', id: obj.tool_id, isError: obj.status === 'error', summary: obj.error?.message ?? summarizeContent(obj.output ?? '') });
      break;
    case 'error':
      if (obj.severity !== 'warning') out.push({ kind: 'error', message: obj.message ?? 'gemini error' });
      break;
    case 'result':
      flushGeminiText(state, out);
      if (obj.status === 'error') out.push({ kind: 'error', message: obj.error?.message ?? 'gemini error' });
      out.push({ kind: 'done', durationMs: obj.stats?.duration_ms });
      state.finished = true;
      break;
  }
  return out;
}

function flushGeminiText(state, out) {
  if (state.buf) {
    out.push({ kind: 'text', text: state.buf });
    state.buf = '';
  }
}

function displayGeminiTool(name) {
  // gemini may prefix MCP tools as "motion__tool" or "mcp_motion_tool" depending on version
  if (typeof name !== 'string') return name;
  for (const p of ['motion__', 'mcp_motion_', MCP_PREFIX]) if (name.startsWith(p)) return name.slice(p.length);
  return name;
}

/** Split a growing stdout buffer into complete JSON lines. Returns [objects, rest]. */
export function splitJsonLines(buf) {
  const lines = buf.split('\n');
  const rest = lines.pop() ?? '';
  const objs = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try { objs.push(JSON.parse(t)); } catch { /* non-JSON noise */ }
  }
  return [objs, rest];
}
