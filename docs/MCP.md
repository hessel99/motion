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

Tool results may contain `{type: "file", name, data, mimeType}` items (rendered previews): the bridge writes
them to `<os tmp>/motion-previews/<name>` and replaces them with a text item holding the path.

Tool errors come back as `result.isError: true` with a text explaining what to fix (unknown property,
missing layer id, Ask mode, ...). If no editor is open the call fails with "The Motion editor is not open".

## Conventions

Composition pixels, origin top-left, y down. Times in seconds. Rotation in degrees clockwise. Opacity and
scale in percent. Colors `"#rrggbb"` or `[r,g,b,a]` (0..1). Every edit is a normal undoable editor
transaction and shows up live (every tool call is one undo step). The full agent guide is `AGENT_SYSTEM_PROMPT` in
`src/agent/tools.ts`; worked examples for the higher-level tools are in `docs/agent-tools-cookbook.md`.

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
| **Scene** | | |
| `build_scene` | | Declarative scene spec → whole scene in one undo step: layers (rect/ellipse/path/text/group/star/polygon/image placeholder/precomp), nesting, transforms, solid/gradient fills, strokes, text styles, keyframes, `enter`/`exit` shorthands, `drawOn`, stagger blocks, text animators, expressions, masks, blend. Stable `key`s: re-sending updates in place; `prune` removes keyed layers not in the spec. Returns `{summary, ids, notes}` |
| **Shapes** | | |
| `add_shape_path` | | Path from SVG `d` / polyline, or boolean `union`/`subtract`/`intersect`/`exclude` of d strings, library shapes or existing layers |
| `shape_library` | | Named primitives (arrow, check, plus, heart, bubble, badge, blob(seed), wave, burst, spiral, star, ring, cloud, ...) and any Lucide icon (`lucide:rocket`) |
| `draw_on` | | Trim-path reveal / erase (rect/ellipse converted to paths, strokes added, fills fade in, groups staggered) |
| `morph` | | Path shape keys from a layer to another shape / layer / d, structures matched automatically; optional `back` |
| **Choreography** | | |
| `arrange` | | grid / row / column / radial / along a path / seeded scatter; optional animated `transition` |
| `choreograph` | | Stagger whole animations: sequential, reverse, center-out, edges-in, random, wave (by position), distance (from a point); `step`, `overlap` or `spread` |
| `secondary_motion` | | Overshoot + settle oscillations and anticipation on existing moves |
| `loop` | | Seamless cycle / pingpong / offset loops (closing keys + `loopOut`), `fitComp` |
| `camera_rig` | | Depth groups + pan/zoom keys for parallax |
| `align_to_beats` | | Snap animation starts / ends / keys to markers, beat times or a bpm grid |
| **Typography** | | |
| `type_layout` | | Eyebrow / headline / subline / body / caption stack with a type scale, tracking, fit-to-width; idempotent by key |
| `split_text` | | Text → one layer per char / word / line in a group that keeps the transform; optional staggered preset |
| `text_on_path` | | Letters placed and rotated along a path |
| **Analysis** (all read-only) | | |
| `inspect_motion` | yes | Per move: duration, size, ease shape from the velocity curve, peak speed/acceleration, overshoot, anticipation, holds, warnings |
| `check_frame` | yes | Off-canvas, safe areas, WCAG text contrast vs what is behind, overlaps, tiny/huge, at chosen times |
| `timeline_summary` | yes | Beats, who moves when, motion-density strip, idle stretches |
| **Preview** | | |
| `preview_strip` | yes | Many small labeled frames in one image: row, grid (≤24) or onion skin |
| `preview_video` | yes | Short low-res GIF saved to a file (desktop: exports folder; bridge: OS temp `motion-previews/`), returns the path |
| **Concept** (animate what the artwork depicts) | | |
| `inspect_artwork` | yes | One labeled image (real render with numbered outlines + every part alone on a neutral background) and JSON per part: bounds, area, colors, subpaths, components/holes, aspect, letter-like rows, relations (`inHoleOf`, `inside`, `contains`, `neighbours`) and a geometry-only hint ("tall rectangle, sits in the hole of #2 (house-like pentagon with a hole)"). Compound paths are listed as `n.k` components |
| `split_shape` | | One compound path → part layers at exactly the same place, in a group that takes the original's transform/keys: `components` (holes stay with their contour, a shape inside a hole is its own part) or `subpaths`; text → letters; a group → every compound path inside |
| `set_pivot` | | Anchor to a named spot (`left`, `bottom`, `top-left`, ...), a comp point or another layer's edge (`{layerEdgeOf}`) without moving the layer (position compensated, also keyed / parented) |
| `rig` | | Motion rigs as editable keys: `hinge` (door/lid with foreshortening, perspective taper, shading, lit opening), `grow`, `swing`, `unfold`, `orbit`, `blink`, `pulse`, `beat`, `liquid-fill`, `draw-then-fill`, `launch`, `land`, `type-on`, `assemble`, `reveal-from`; `t0`, `duration`, `intensity`, `mode`, `loop`, `options`. Returns keys per layer and created helper layers |

All input schemas are validated as strict JSON Schema in `tests/agent.test.ts` (every array has
`items`, enums are non-empty, `required` names real properties), so they load in Claude, Gemini and
OpenAI clients alike.
