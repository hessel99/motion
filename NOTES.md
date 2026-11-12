# Motion — engineering notes

> **Design note:** the visual design is intentionally basic right now. A dedicated design pass is planned later.
> The focus so far is performance, correctness and the core workflow.

## What exists

- **Electron desktop app** (`electron/`) plus the same UI in a plain browser (`npm run dev`)
- **WebGL2 renderer**: one instanced draw call for the whole composition
- **Timeline**: a virtualized canvas with keyframes, a marquee, drag, trimming, reorder/reparent by drag, a context menu and rename
- **Inspector**:
  - scrubbable number fields, which also accept math like `100+20` or `*2`
  - a keyframe diamond per property
  - colors, text, comp settings
  - easing editor: a bezier curve plus presets, and **springs** with a bounce value, Figma Motion style
- **Viewport**:
  - select, move, resize (shift keeps the aspect ratio, alt resizes from the center), rotate (shift snaps to 15°)
  - marquee, double-click to enter a group, alt-drag to duplicate
  - create rect/ellipse/text, pan and zoom
  - motion path display, a hover outline and a perf HUD
- **After Effects-style animation**:
  - per-property stopwatch; changing an animated property creates a keyframe at the playhead
  - an auto-key mode
  - linear, bezier, hold and spring interpolation, plus spatial bezier (curved motion paths)
  - J/K jump between keyframes, F9 applies easy ease
- **Import**:
  - **Figma copy and paste** (just ⌘C in Figma, ⌘V here)
  - SVG (by paste or drop), Lottie JSON, After Effects `.aep` (best effort, see below), images
- **Smart animate** (Figma style, `src/core/smart.ts`): select two versions of a design (e.g. two pasted Figma frames) → Animate panel → *Smart animate A → B*. Layers are matched by name path; every differing property (transform, size, fill, radius, stroke, path shape with the same structure) gets an eased key pair, unmatched layers fade in/out, the end frame is removed. One undo step; also an agent tool (`smart_animate`).
- **Gradient fills**: Fill → Solid / Linear / Radial, angle, color stops (add/remove, position, color+alpha). Static (not keyframed). Exported to Lottie as gradient fills (`gf`, checked against lottie-web: mean pixel error 1.7; gradients on non-square boxes stretch slightly differently); the AE script uses the first stop color.
- **Markers**: M adds one at the playhead; drag, name (double-click), delete (right-click). J/K and keyframe drags snap to them. Exported to Lottie and AE; the agent can set them (`set_markers`).
- **Audio layers**: drop or open a wav/mp3/m4a/ogg. Waveform in the timeline, drag to shift in time, volume in the inspector, **Add markers on beats** (onset detection, `src/audio/beats.ts`). Playback through WebAudio is (re)scheduled on play, on loop wrap and on playhead jumps, so the editor clock stays frame-accurate.
- **Export**: Lottie JSON, **GIF**, and **video** (MP4 H.264 / WebM VP9 through WebCodecs + mediabunny; verified with ffprobe in Chromium and Electron). **After Effects script** (`.jsx`, `src/export/aejsx.ts`): rebuilds the comp in AE (shape layers, nulls as parents, box text, precomps, images, keyframes with temporal ease/hold/linear, spatial tangents, expressions). It embeds the Lottie export data and a small ES3 interpreter; tested against a mock of the AE scripting DOM (`tests/aejsx.test.ts`), not yet in a real AE. Audio layers are mixed offline (`OfflineAudioContext`) into one stereo track (AAC when the platform has it, else Opus). `scripts/audio-check.mjs` checks the streams with ffprobe.
- **Graph editor**: value curves in the timeline. Drag keys (time/value) and bezier handles on the real curve, which Figma Motion doesn't have.
- **Expressions** (`wiggle(2, 20)`, `loopOut('pingpong')`, `time * 90`, `linear(...)`, vectors…): a *safe* mini language with its own parser and interpreter (`src/core/expr.ts`). It never calls `eval`, so opening someone else's project can't run code.
- **Text animation** (per letter / word / line, like AE text animators): presets (Fade up, Typewriter, Pop letters, Spin letters, …), order (forward, backward, center, random), springs. Every unit is its own instance in the same single draw call.
- **Precomps** (⇧⌘C to pre-compose, a comp switcher, start offset), **masks** (Figma-style), **group opacity** done right (offscreen isolation)
- **Pen tool** + path point editing; **animation presets** (fade/slide/pop/…) with stagger; **align/distribute**
- **Snapping + smart guides** in the viewport; timeline scrollbars; layers can be moved in time; keyframe copy/paste
- **AI agent sidebar**: chat with **Claude Code**, Codex CLI or Gemini CLI using *your own subscription* (through the local bridge). The agent drives the editor with MCP tools: add/update layers, keyframes, easing, screenshots and more.
- **Autosave** to local storage, plus `.motion` project files (JSON)

## Running it

```bash
npm install
npm run dev            # browser at http://localhost:5173
npm run bridge         # (browser only) local agent bridge on 127.0.0.1:7823
npm run electron       # build + desktop app (starts the bridge itself)
npm test               # unit tests (vitest)
node scripts/e2e.mjs out.png           # ui interaction test in chromium (dev server must run)
node scripts/perf.mjs 1000,5000,10000  # playback perf (dev server must run)
node scripts/agent-loop.mjs out.png    # drives the editor through MCP like an agent (bridge + dev server)
node scripts/agent-chat.mjs out.png "prompt"  # REAL claude code run through the sidebar
```

Useful URL parameters: `?stress=5000`, `&kinds=rect,ellipse,text,path`, `&nested`, `&play`, `&hud`, `?demo`, `?blank`, `?nobridge`.

## Why WebGL2 (measured, `bench/canvas-bench.html`)

The test animates 5,000 rounded rectangles. Measured in Chromium on a software GPU (llvmpipe), so the absolute numbers are low, but the ranking holds on real GPUs:

| technique | fps | cpu per frame |
|---|---|---|
| DOM + CSS transforms | 6 | 5.8 ms |
| Canvas2D | 7.6 | 7.3 ms |
| SVG | 18 | 9.7 ms |
| WebGL2, one draw per shape | 54 | 15.9 ms |
| **WebGL2 instanced (chosen)** | **120** | **0.7 ms** |

WebGPU would be the next step, but WebGL2 works everywhere Electron runs, and the bottleneck is no longer the GPU API.

## Renderer architecture (`src/render/`)

- **One draw call**: every layer is an instance (40 floats) drawn as one `drawArraysInstanced`.
- **Rects and ellipses are SDFs** (signed distance fields) computed in the fragment shader. You get exact anti-aliasing at any zoom, and size, corner radius, stroke and colors animate without any texture work.
- **Paths, text, images and gradients are rasters** in a `TEXTURE_2D_ARRAY` atlas, so the scene still needs one draw call.
  - Path and text rasters are *coverage masks* (R = fill, G = stroke), tinted in the shader, so color and opacity animation never re-rasterizes.
  - Each layer is rasterized **once at the largest scale its animation reaches**. A hysteresis window (1x to 2.8x) avoids re-rasterizing during playback.
  - The atlas keeps a **CPU shadow copy** per page. All raster writes in a frame become at most a few sub-rectangle `texSubImage3D` calls per page. Compaction and growth happen on the CPU copies, so there is no GPU read-back.
- **Clipping** (Figma "clip content"): the nearest clipping ancestor is passed per instance and tested in the shader as a rounded box.
- **Group opacity and masks** use offscreen layers, built as a small per-frame command list (DRAW / PUSH / MASK / POP with an FBO stack).
  - A group is isolated only while its opacity is below 1 and it has children, so it fades as one image the way Figma and AE do.
  - A Figma-style mask (imported from `isMask`, or the "Use as mask" checkbox) renders into its own texture, and the content is multiplied by its alpha.
  - Scenes without either keep the single draw call.
- **Keyframe evaluation**:
  - all animated tracks are packed into **one contiguous `Float64Array` (`TrackPool`)** in evaluation order
  - easing uses a 256-sample lookup table per curve, shared between tracks
  - the last segment is cached, so forward playback finds its keyframe in O(1)
  - static layers are never re-evaluated
- **The comp background** is a scissored `clear`, which costs no fragment work.
- **Per-frame budget**: first-time rasters are spread over frames; one never blocks a frame for long.

### Playback numbers

These numbers come from `scripts/perf.mjs`, on the same 4-core container with a software GPU. **CPU per frame** is the time the editor itself needs per frame. The fps here is limited by the *software* rasterizer (an empty loop only reaches ~57 fps in this container), so on a real GPU the fps follows the CPU column.

| scene (everything animated: position, rotation, scale, opacity, color) | cpu per frame |
|---|---|
| 1,000 shapes | 0.5 ms |
| 5,000 shapes | 3.2 ms |
| 10,000 shapes | 7.9 ms |
| 25,000 shapes | 16 ms |
| 2,000 mixed (text, vector stars, shapes, rotating groups) | 2.0 ms |
| 5,000 mixed, steady state | 5.4 ms |

The 16.6ms budget for 60 fps leaves a lot of headroom for realistic scenes, which have hundreds to a few thousand layers.

## Lessons learned (performance)

1. **Do not use `desynchronized: true` on the WebGL canvas.** It removed compositor backpressure, so the page queued frames faster than the GPU drew them. Memory grew ~15 MB/s until the browser was killed. Removing it made memory flat.
2. **Many small texture uploads into a texture the GPU is still reading are poison.** Drivers either stall or copy the whole texture per call. Batch them through CPU shadow pages with one sub-rectangle upload per page per frame.
3. **Keyframe evaluation was memory-bound, not math-bound.** 50k tracks as separate objects took 115 ns per track; packed contiguously, 37 ns, with bit-identical results (`bench/eval-bench.ts`).
4. **Layers animating their scale used to re-rasterize all the time.** Rasterizing at the maximum animated scale plus hysteresis fixed that.
5. UI frameworks stay out of the playback loop. The single `requestAnimationFrame` loop in `src/app/editor.ts` drives the WebGL canvas, the overlay and the timeline; panels only re-render when paused.

## Figma paste

- Figma puts its kiwi-encoded binary scene on the clipboard as HTML (`(figmeta)` / `(figma)` markers). The decoder handles deflate and zstd, and it reads the binary schema embedded in the payload, so new Figma fields don't break it.
- Mapping:
  - frames → groups (with clip)
  - rect/ellipse → SDF layers (animatable radius, size, fill)
  - vectors and boolean operations → paths, using Figma's own fill and stroke geometry
  - text → text layers
  - instances → their component subtree
  - gradients → gradient paints
- Pasting a single frame into an empty project makes the composition the size of that frame, Figma Motion style.
- **Verified against real Figma clipboard captures**, including the 2025 format. The captures come from the test data of github.com/darknoon/figma-format-parse; run `scripts/figma-real-check.sh`, which downloads them on demand because that repo has no license. A real iPhone screen (51 layers: frames, component instances, text, emoji) pastes and renders correctly in under 50ms.
- Newer clipboards can omit cached vector geometry and only carry the **vector network** blob. We decode that too (`src/import/figma/vectornet.ts`).
- Unit tests also cover a synthetic payload. Some rarer fields are still educated guesses (listed in `src/import/figma/convert.ts`).

## After Effects `.aep`

- Parsed from the RIFX container, using the community format spec from py-aep / aep_parser.
- Verified against real sample files: comps, solids, layer flags, static transforms, text documents.
- **Keyframes and shape layers are verified with real .aep files from public GitHub repos** (`bench/aep-real.ts`):
  - A Lottie-tutorial thermometer (shape paths + keyframed position/scale) renders correctly and animates as intended.
  - A 4 MB broadcast template parses in 130 ms (21 comps, 267 layers, 139 keyframes; text, nested comps and timing come through).
  - Footage (video/PSD) is not inside .aep files, so it becomes placeholders.
- Also imported (checked on real files from py-aep and lottie-android, pixel-compared with their official Lottie exports): blend modes, solo, **expressions** on transforms (only those our safe language accepts), **track mattes** (alpha / inverted) and **masks** (add, subtract, intersect, difference, inverted, opacity, animated paths), polystars, trim paths, animated shape paths.
- Skipped: effects, luma mattes (treated as alpha), mask feather/expansion, repeaters, merge paths, time remap, 3D, cameras, lights.
- **Lottie** import/export is the reliable interchange format today (round-trip tested).
- **Lottie import is measured against the official lottie-web player** on 11 real files (`scripts/lottie-compare.mjs`, `REF_RENDERER=svg`).
  - 9 of 11 have a mean pixel error under 2.2 of 255. Supported: masks (add, subtract, intersect), track mattes, animated paths, trim paths, compound paths, AE stacking order with parenting, precomp time stretch/remap, simple expressions, blend modes.
  - Remaining gaps, most frequent first: merge paths (path booleans), expressions referencing other layers or effects, gradient strokes, round corners, per-character text animators.
- **Lottie export is verified against the official lottie-web player** (`scripts/export-compare.mjs`): frame-identical for transforms, easing, springs and opacity with its default SVG renderer.
  - Text in the bundled Inter is exported as **glyph outlines** (`chars`, `src/export/lottie-glyphs.ts`, opentype.js loaded only on export), so every player draws it without the font installed. Measured against lottie-web (SVG): mean pixel error 0.003–0.38 on the demo. Other fonts stay font-name based.

## Agent integration

- `bridge/server.mjs`, local only (127.0.0.1, origin-checked):
  - a WebSocket to the editor
  - an MCP server (Streamable HTTP, JSON responses) at `/mcp`
  - spawns CLIs (`claude -p --output-format stream-json`, `codex exec --json`, `gemini`) with the MCP config pointing back at itself
- The editor registers its tools (`src/agent/tools.ts`). Any MCP client can connect to `http://127.0.0.1:7823/mcp` while the app is open.
- Verified with a real Claude Code run: it built a four-layer animation in 28 seconds, used screenshots to check its work, and fixed its own anchor mistake.
- MCP endpoint reference for external clients: [docs/MCP.md](docs/MCP.md).

### Directing the agent (sidebar)

- **Context, automatically**: each message carries an `<editor_context>` block (comp, playhead, work area, markers, selected layers with what is animated, @-mentioned layers). The composer shows it as chips; type `@` to mention a layer.
- **Review every turn**: the document is snapshotted before a turn and diffed after it (`src/agent/diff.ts`). The review card lists added/changed/removed layers and properties (click to select), *Hold to compare* (undo to the pre-turn state while held, redo on release), *Replay*, *Revert* (undo back to the turn start) and *Keep*.
- **Quick actions** on the selection (`src/agent/quick.ts`): Animate in, Bouncier, Smoother, Snappier, Slower, Faster, Stagger, Anticipation, 3 variations, Critique, Explain.
- **Ask mode** (Critique/Explain or the Edit/Ask toggle): read-only turns. The editor refuses editing tools, and Claude Code only pre-approves the read-only ones.
- **Variations**: the agent builds versions and calls `save_variation`; the tray shows filmstrips, click to preview (applies + plays), scrub, *Use*.
- **Tools for agents**: `get_animation` (compact text), `animate` (many tracks, one undo step), `retime`, `stagger`, `contact_sheet` (labeled frame grid, one JPEG). Tool results are compact JSON/text.
- **Lean Claude runs**: `--tools "" --disable-slash-commands` (no built-in Bash/file tools, no skills), with automatic fallback for older CLIs. The same 3-card build went from 285k to 41k input tokens per turn (cost $0.089 → $0.078; most of the 285k were cache reads).
- **Errors** are typed in the bridge (`bridge/errors.mjs`: not installed, auth, rate limit, overloaded, network, timeout, cancelled) and shown with the fix plus Retry. A turn whose CLI prints nothing for 5 min is killed (`MOTION_AGENT_IDLE_MS`). A bridge disconnect ends running turns cleanly.
- **Persistence**: the conversation and CLI session ids are stored per project (keyed by the first composition id, which is saved in the file). Review cards from earlier sessions are marked stale, because the undo history is gone.
- Checks: `tests/agent.test.ts` (schema validation, tools against a real store, diff/context), `tests/bridge-agent.test.mjs` (a fake `claude` replays recorded stream-json: success, auth, crash, timeout, cancel, lean fallback), `scripts/agent-ui-check.mjs` (Playwright, full panel against `tests/fixtures/fake-claude/claude`, which really calls the MCP tools), `scripts/agent-real-check.mjs` (real subscription runs: build, variations, critique).

## Quality process used

- Three independent read-only review rounds by separate agents. Each round reported 10–15 confirmed bugs with reproductions; all were fixed and most now have regression tests (`tests/core.test.ts`, "review regressions").
- Real-world fixtures:
  - Figma clipboard captures, including the 2025 format
  - 11 Lottie files from lottie-web, compared against the official player
  - real `.aep` files
- `scripts/` holds the browser and Electron checks: e2e interactions, perf, drag-and-drop, agent loop, precomps, masks, text animation, Lottie comparison, video/GIF export, context loss, desktop autosave.

## Known limitations / next

- Only the nearest clip ancestor clips (no nested clip intersection). No effects yet (on purpose).
- **Design pass** (visual polish of all panels) is still to do. The current UI is functional on purpose.
- Lottie export of text for lottie-web's *canvas* renderer (it needs glyph outlines).
- AE: effects, expressions beyond the safe subset, 3D, cameras, luma/inverted mattes.
- Audio: no scrubbing sound, no fades/volume keyframes yet, no audio in Lottie/GIF.
