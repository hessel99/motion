# Motion MCP endpoint

While Motion is open (desktop app, or `npm run dev` + `npm run bridge`), the bridge serves the editor's
tools over MCP so any MCP client can drive the open document — Claude Code, Claude Desktop, Cursor,
VS Code, Codex or your own agent.

- URL: `http://127.0.0.1:7823/mcp` (port: `--port <n>` or `MOTION_BRIDGE_PORT`; the desktop app picks
  a free port and shows the URL in *Settings → Connections*, with setup snippets per client)
- Transport: Streamable HTTP, `POST` only, JSON responses (no SSE stream). JSON-RPC batches work.
- Protocol versions: `2025-06-18`, `2025-03-26`, `2024-11-05`
- Methods: `initialize`, `ping`, `tools/list`, `tools/call` (`resources/list` and `prompts/list` are empty)
- Local only: binds 127.0.0.1; requests with a non-loopback `Host` or a non-local browser `Origin` get 403.
- Health: `GET /health` → `{ ok, editorConnected, tools }`

## Connect

```bash
claude mcp add --transport http motion http://127.0.0.1:7823/mcp     # Claude Code
codex -c mcp_servers.motion.url="http://127.0.0.1:7823/mcp"          # Codex
```

Generic config: `{ "mcpServers": { "motion": { "type": "http", "url": "http://127.0.0.1:7823/mcp" } } }`

Raw call:

```bash
curl -s http://127.0.0.1:7823/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_animation","arguments":{}}}'
```

Tool errors come back as `result.isError: true` with a text explaining what to fix (unknown property,
missing layer id, Ask mode, ...). If no editor is open the call fails with "The Motion editor is not open".

## Conventions

Composition pixels, origin top-left, y down. Times in seconds. Rotation in degrees clockwise. Opacity and
scale in percent. Colors `"#rrggbb"` or `[r,g,b,a]` (0..1). Every edit is a normal undoable editor
transaction and shows up live. The full agent guide is `AGENT_SYSTEM_PROMPT` in `src/agent/tools.ts`.

## Tools

`readOnlyHint` is set in each tool's MCP `annotations` (read-only tools never change the document).

| tool | read-only | what it does |
|---|---|---|
| `get_editor_context` | yes | Composition, playhead, work area, markers, selected layers/keyframes — what "this" means |
| `get_document` | yes | Composition settings + layer tree |
| `get_layer` | yes | One layer as JSON (large path geometry summarized unless `full`) |
| `get_animation` | yes | Compact keys/eases per layer: `scale: 0.2s 0 ─Back Out→ 0.8s 100` |
| `screenshot` | yes | PNG of one or a few frames |
| `contact_sheet` | yes | One labeled JPEG grid of 2–12 frames over time (cheapest way to see motion) |
| `set_time`, `playback`, `select_layers` | yes | View state only |
| `add_layer`, `update_layer`, `delete_layers`, `duplicate_layers`, `group_layers`, `precompose` | | Layers |
| `animate` | | Keyframes on many layers/properties in one call and one undo step, optional stagger |
| `set_keyframes`, `set_easing` | | One property's keys / eases (presets, springs, cubic-bezier) |
| `retime`, `stagger` | | Scale/shift timing; offset layers one after another |
| `apply_preset`, `set_text_animation`, `set_expression`, `smart_animate` | | Higher-level animation |
| `save_variation`, `apply_variation` | | A/B/C versions the user previews and picks in the sidebar |
| `set_composition`, `set_markers`, `open_composition` | | Composition |
| `export_video` | | MP4/WebM/GIF render |
| `undo` | | Undo the last change |

All input schemas are validated as strict JSON Schema in `tests/agent.test.ts` (every array has
`items`, enums are non-empty, `required` names real properties), so they load in Claude, Gemini and
OpenAI clients alike.
