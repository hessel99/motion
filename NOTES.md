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
URL=http://localhost:4173/ node scripts/cpu-bench.mjs 10000,25000 [--animated 0.1]  # cpu per frame without the gpu
URL=http://localhost:5173/ node scripts/fx-bench.mjs 1000,10000  # effect prototypes (dev server only)
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

WebGPU would be the next step, but WebGL2 works everywhere Electron runs, and the bottleneck is no longer the GPU API. Re-checked with evidence in "Architecture decisions" below.

## Architecture decisions (re-checked, Nov 2026)

How to measure (this container has a software GPU, SwiftShader, so fps is meaningless):
- `scripts/cpu-bench.mjs`: main-thread cost per frame with the GPU taken out (rAF loop stopped, 64x40 canvas, draw calls stubbed, everything else real: eval, instance writing, buffer upload). The primary metric.
- `scripts/fx-bench.mjs`: effect prototypes (dev server only); GPU columns are SwiftShader, read them *relative* to the plain render of the same row.
- `scripts/pixel-compare.mjs`: guards optimizations. `SELF=1` compares each incremental frame with a full rewrite of the same frame (must be 0 diff); `A=… B=…` compares two builds (text rasters have a noise floor of 1/255 on ~300 bytes between page loads).
- `scripts/profile-play.mjs`, `scripts/profile-load.mjs`: CPU profiles of playback and of loading a big scene.
- Run your servers on unusual ports: other agents use 4173/4181/4182/5173…, and a benchmark against someone else's server measures their build.

| decision | verdict | evidence |
|---|---|---|
| WebGL2, one instanced draw + atlas | **keep** | CPU per frame is eval-bound, not API-bound: draw submission is 0.2 ms at 10k layers, 0.5 ms at 25k (`cpu-bench`, `submitMs`). WebGPU would not make a frame faster. |
| WebGPU | **plan, not now** | Electron 33 (Chromium 130.0.6723.191) on Linux: `navigator.gpu` exists but `requestAdapter()` returns **null**, also with `--enable-unsafe-webgpu`. Chromium ships WebGPU on macOS/Windows/ChromeOS; on Linux it comes later and per GPU. A WebGPU-only renderer would lose Linux and every blocklisted GPU. WebGPU's real wins come later: compute (GPU keyframe eval, particles, GPU path rendering like Vello, GPU culling), storage buffers instead of 10 vertex attributes, `firstInstance` (no attribute re-pointing per draw range), render bundles. **Plan**: keep the frame description backend-neutral (command list / render graph below) so a WebGPU backend can be added behind feature detection when an effect needs compute. None of the effects measured below needs compute. |
| CPU evaluation on the main thread | **keep, optimized** | 10k all-animated layers: eval 2.8 ms, whole frame 3.9 ms; 25k: 7.0 / 9.8 ms. Realistic scenes animate a fraction of their layers; static ones now cost almost nothing. |
| worker + SharedArrayBuffer eval | **plan for >25k animated layers** | Eval is ~70% of the frame and parallel per root subtree; 4 workers would take 25k from ~7 ms to ~2 ms, but they add a sync barrier (or a frame of latency), COOP/COEP headers in the browser build, and SAB-shaped data. Only worth it once the main-thread path is exhausted. |
| WASM-SIMD eval | **reject for now** | Eval is memory-bound: `bench/eval-bench.ts` 41 ns/track packed vs 26 ns cache-resident. SIMD speeds up arithmetic, not cache misses. The win came from data layout (struct-of-arrays, below), which JS does as well as WASM. |
| GPU evaluation (keyframes in a texture, eval in the vertex shader) | **plan (largest long-term lever)** | Leaves that are SDF shapes with plain keyframes don't need CPU values each frame (only the selection, for hit testing and overlays). Upload keyframes once, one time uniform per frame → 100k+ animated layers at ~0 CPU. Needs the CPU path for parents, expressions, raster scale decisions and the selection. |
| raster atlas for paths/text/images | **keep** | Static and transform-animated vectors cost one texture fetch; color/opacity animate without re-raster; animated scale rasterizes once at max scale. Weak spots: animated path shapes and trim paths rasterize every frame on the CPU, and deep zoom on text re-rasterizes. |
| GPU path rendering (stencil-then-cover / Slug-style analytic coverage / Vello compute) | **plan** | Needed for morphing paths, trim paths, animated stroke width, and text at any zoom without re-raster. First step that works in WebGL2: per-path curve data in a texture + analytic coverage in the fragment shader (Slug-like, one instance per path, still one draw). Vello-style compute needs WebGPU. |
| text | **keep raster, plan MSDF / analytic glyphs** | Per-unit text animation is already one instance per glyph. Glyph rasters at max scale are fine for playback; an MSDF or curve glyph cache would make zoom and large scale animations free. |

## Effect pipeline (design, from the prototypes in `src/render/fx-proto.ts`)

### Measured (`scripts/fx-bench.mjs`, stress scene of moving rects/ellipses)

Cells: CPU ms / CPU+GPU ms (SwiftShader, median of 2-3 frames). Compare each cell to `plain` in the same row.

| layers, comp | plain | accum ×8 | accum ×16 | velocity (≤16 samples) | blur r20 full res | blur r20 ½ res | blur r50 ½ | blur r50 ¼ |
|---|---|---|---|---|---|---|---|---|
| 1k, 1920×1080 | 1.9 / 35 | 5.9 / 493 | 6.8 / 838 | 3.4 / 75 | 0.0 / 545 | 0.2 / 83 | 0.2 / 178 | 0.1 / 36 |
| 10k, 1920×1080 | 11.8 / 274 | 30 / 2535 | 69 / 5016 | 8.6 / 589 | 0.2 / 560 | 0.1 / 104 | 0.1 / 209 | 0.1 / 33 |
| 1k, 3840×2160 | 4.6 / 61 | 7.6 / 1112 | – | 2.5 / 158 | 0.5 / 3810 | 0.7 / 450 | 0.5 / 1797 | 0.2 / 384 |
| 10k, 3840×2160 | 24 / 491 | 82 / 7022 | – | 9.7 / 1555 | 0.4 / 2543 | 0.2 / 395 | 0.2 / 780 | 0.2 / 186 |

(The CPU column here includes dev-server overhead and GPU back-pressure; the clean CPU numbers are in "Playback numbers".)

What this shows:
- **Temporal supersampling** costs N times everything: N evaluations, N instance writes and uploads, N full fills (×9 GPU for 8 samples, ×18 for 16). At 10k layers the CPU side alone is N × 3.9 ms, so 31 ms for 8 samples. Impossible in real time, fine for export.
- **Per-instance velocity blur**: each instance carries its matrix at shutter open and close. The fragment shader integrates coverage along the motion with an adaptive sample count (1 sample when a layer doesn't move). It is **one draw plus one extra evaluation**. GPU cost is ×2.2 the plain render at 1080p and ×3.2 at 4K. For moving shapes it looks the same as 32-sample accumulation (side-by-side check: `fx-bench --shot out.png`). This is the playback-time motion blur.
- **Separable gaussian blur**: cost is resolution × taps and does not depend on layer count. Full-res r20 at 1080p costs about two plain 10k renders on SwiftShader. At ½ res it is 5× cheaper, and r50 at ¼ res is cheaper than r20 at ½. Downsampling by radius is mandatory: a blur of radius ≥ 8 px loses nothing visible at ½ res, and ≥ 24 px loses nothing at ¼.
- Real-GPU estimate (texture-rate bound, e.g. an M1-class GPU at ~40 Gtexel/s): r20 full-res 1080p = 2 passes × 2.1 Mpx × 16 bilinear fetches ≈ 66 M fetches ≈ 1.6 ms; ≈ 0.2 ms at ½ res; 4K is ×4. A plain 10k-layer frame fills ~10-20 Mpx of quads, ≈ 0.5 ms. So on a real GPU: velocity blur ≈ +1 ms; a few downsampled blurs/glows ≈ +0.2-0.5 ms each; accumulation ×8 ≈ 4 ms GPU **plus 30 ms CPU**.

### Decisions

1. **Motion blur**: per-instance velocity blur in the main shader for playback (shutter angle/phase as comp settings, adaptive samples, max 16-32). Exact temporal supersampling only for export and for content that changes non-affinely (path morphs, text animators, nested comps with their own motion); those render as a group into an FBO N times.
2. **Blur / glow / shadow**: render-graph nodes on a layer's or group's offscreen texture. Each runs at a resolution chosen from the radius and the playback quality, with separable passes and a bilinear upsample in the composite.
3. Effects never break the single draw for layers without effects. The command list splits draws only around layers that have effects, as it already does for masks and group opacity.

### Render graph (what the renderer needs, in implementation order)

The current command list (DRAW / PUSH / MASK / BLEND / POP with an FBO stack) is already a linear render graph. Effects need:

1. **Offscreen targets with their own size** (`renderer.setTarget` exists now; the prototype uses it). A layer or group with effects renders into a texture sized to its *bounds plus effect padding* (blur radius, glow spread, motion extent), not to the canvas. Today PUSH allocates canvas-size targets; bounds-sized targets cut fill and memory for small layers.
2. **Effect commands**: `PUSH(bounds, scale)` → draws → `EFFECT(id, params)` × n → `POP(blend, opacity)`. Each effect is a small module: `{ padding(params), passes(params, scale), cacheKey(params) }`, where `passes` returns a list of fullscreen passes. Multi-pass effects run over pooled textures: blur = down + h + v; glow = threshold + blur + add; drop shadow = alpha + offset + blur + composite under.
3. **Texture pool**: targets keyed by (w, h, format) and reused every frame, so a frame allocates nothing. Use RGBA16F (`EXT_color_buffer_float`, available in Electron 33 and Chrome) for accumulation and HDR glow; RGBA8 otherwise.
4. **Caching**: each node gets a content hash = hash(subtree revision, evaluated values that affect its pixels, effect params, scale). If the hash hasn't changed since the last frame (static subtree, static effect), reuse the effect's output texture: a static blurred background then costs one textured quad per frame. The change flags now produced by evaluation (`chg[]`, see "Renderer architecture") are exactly the "did this subtree change" signal the hash needs.
5. **Resolution scaling during playback**: a budget controller picks a quality level per frame. If recent GPU time (`EXT_disjoint_timer_query` where available, else frame time) exceeds ~12 ms, effects drop to ½ then ¼ resolution and motion-blur samples halve. When paused, and on export, everything renders at full quality. Scrubbing uses playback quality; the paused frame upgrades after ~150 ms idle.
6. **Budgets**: 16.6 ms per frame. Targets: CPU ≤ 6 ms (eval + writing + graph building), GPU ≤ 10 ms. Each effect declares a cost estimate (pixels × taps), so the controller can predict instead of only reacting.
7. **Velocity data**: the instance stream gets the previous-shutter matrix (6 floats; a second vertex buffer with divisor 1 as in the prototype, or part of the main record). It comes from a second evaluation at `t - shutter`; the incremental path makes that cheap for static layers.
8. **Order of operations** follows AE: transform-independent effects (blur) apply in the layer's local space before its transform; others apply after it (motion blur, drop-shadow direction in comp space).

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
  - the per-frame loops read **struct-of-arrays** copies of the item fields (parent, time offset, in/out, flags, kind, blend, clip, pool handles). At 25k layers, chasing item and layer objects was most of the write time (cache misses; see `cpu-bench.mjs` with `LINES=render`).
  - **change propagation**: evaluation marks items whose matrix, opacity or visibility changed (`chg[]`, inherited by children). Unchanged items keep last frame's world matrix. Their instance is neither rewritten nor uploaded if it sits in the same slot as last frame, and only written instance ranges are uploaded (`bufferSubData` per merged range). `renderer.incremental = false` turns this off for A/B checks; `pixel-compare.mjs` with `SELF=1` checks that frames are identical.
  - compile builds no `Track` objects for animated props (they go straight into the pool) and memoizes ease LUTs by a numeric hash
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

Current numbers from `scripts/cpu-bench.mjs` (the table above is older and came from `perf.mjs`): production build, GPU taken out, quiet machine, two runs each. "Before" is commit 3ad8ef6.

| scene (everything animated) | before: frame (eval / write) | after: frame (eval / write) |
|---|---|---|
| 1,000 shapes | 0.4-0.5 ms | 0.4 ms |
| 5,000 shapes | 2.6 (1.8 / 0.6-0.7) | 2.7 (1.8-1.9 / 0.7) |
| 10,000 shapes | 4.9-6.1 (3.4-4.2 / 1.2-1.6) | 3.9-4.0 (2.8 / 0.9-1.0) |
| 25,000 shapes | 17.7-18.4 (13.7-14.0 / 3.3-3.7) | 9.8-10.4 (7.0-7.5 / 2.2-2.3) |

- **Not in these numbers**: when a project had no audio, the audio engine walked the whole layer tree on every playing frame (1.1 ms at 10k layers, 3.3 ms at 25k, plus garbage). Fixed.
- **Load** (compile + first render of a big project): 10k layers 249-349 → 48-102 ms; 25k layers 438-725 → 100-120 ms.
- **Partly animated** (`&animated=0.1`: 10% of layers move, scattered): at 25k layers, incremental writes take the frame from 4.7 to 4.1 ms (eval 1.2 ms). Scattered changes still upload the whole buffer, because the ranges merge; clustered changes (e.g. one animated group) upload only their range.

## Lessons learned (performance)

1. **Do not use `desynchronized: true` on the WebGL canvas.** It removed compositor backpressure, so the page queued frames faster than the GPU drew them. Memory grew ~15 MB/s until the browser was killed. Removing it made memory flat.
2. **Many small texture uploads into a texture the GPU is still reading are poison.** Drivers either stall or copy the whole texture per call. Batch them through CPU shadow pages with one sub-rectangle upload per page per frame.
3. **Keyframe evaluation was memory-bound, not math-bound.** 50k tracks as separate objects took 115 ns per track; packed contiguously, 37 ns, with bit-identical results (`bench/eval-bench.ts`).
4. **Layers animating their scale used to re-rasterize all the time.** Rasterizing at the maximum animated scale plus hysteresis fixed that.
5. UI frameworks stay out of the playback loop. The single `requestAnimationFrame` loop in `src/app/editor.ts` drives the WebGL canvas, the overlay and the timeline; panels only re-render when paused.
6. **Measure what the renderer stats don't show.** At 10k layers the audio engine's per-frame tree walk cost about a third of the evaluation. It only showed up in a whole-page CPU profile (`profile-play.mjs`).
7. **Object graphs are cache misses.** Moving the per-item fields the frame loops read into typed arrays halved evaluation at 25k layers. After that, the remaining write cost was the first touch of each layer object, so the writer now reads typed arrays too.

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
