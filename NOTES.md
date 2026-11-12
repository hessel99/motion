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
- **Export**: Lottie JSON and **video** (MP4 H.264 / WebM VP9 through WebCodecs + mediabunny; verified with ffprobe in Chromium and Electron)
- **Graph editor**: value curves in the timeline. Drag keys (time/value) and bezier handles on the real curve, which Figma Motion doesn't have.
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
- Keyframe and shape-layer byte layouts follow the spec but are not yet verified against real files with keyframes.
- Skipped: effects, masks, mattes, expressions, 3D, cameras, lights.
- **Lottie** import/export is the reliable interchange format today (round-trip tested).

## Agent integration

- `bridge/server.mjs`, local only (127.0.0.1, origin-checked):
  - a WebSocket to the editor
  - an MCP server (Streamable HTTP, JSON responses) at `/mcp`
  - spawns CLIs (`claude -p --output-format stream-json`, `codex exec --json`, `gemini`) with the MCP config pointing back at itself
- The editor registers its tools (`src/agent/tools.ts`). Any MCP client can connect to `http://127.0.0.1:7823/mcp` while the app is open.
- Verified with a real Claude Code run: it built a four-layer animation in 28 seconds, used screenshots to check its work, and fixed its own anchor mistake.

## Known limitations / next

- Group opacity multiplies into children instead of compositing the group as a whole (it needs offscreen layers).
- Only the nearest clip ancestor clips (no nested clip intersection). No masks or mattes yet. No effects yet (on purpose).
- No graph editor yet: easing is edited per segment (like Figma Motion). A value/speed graph would be a differentiator.
- Rasterization runs on the main thread. Moving it to a worker with OffscreenCanvas would remove the cold-start stutter on huge imports.
- Precomps/multiple compositions are not built yet.
