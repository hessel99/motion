# Motion — engineering notes

> **Design note:** the visual design is intentionally basic right now. A dedicated design pass is planned later; the token-based design system it will build on is described under "Design system" below.
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
- **Ease studio** (`src/ui/patterns/`, see `docs/ux-patterns.md`): a *feel pad* (lazy ↔ punchy × linear ↔ silky, with an overshoot knob), live swatches that preview on the real layer without touching the document, an A/B spacing lane, a hardware-style spring knob; the classic bezier editor is one tab away.
- **Rhythm panel**: tempo, stagger, groove knobs for selected layers, magnet to markers (beats); **Perform**: drag a layer while the playhead runs, get a few clean eased keys.
- **Agent review**: every agent turn ends in a review card (changed layers/props, hold to compare, replay, revert by undo-entry id, keep); editor context + @-mentions; quick actions (bouncier, snappier, stagger, 3 variations, critique); Ask mode (read-only); compact tools (`animate`, `retime`, `stagger`, `get_animation`, `contact_sheet`). See `docs/MCP.md`.
- **Window layout (motion first)**: time is the main axis. The canvas (stage) sits on top; under it a prominent **transport** (big timecode, duration menu, start / prev key / prev frame / play / next frame / next key / end, loop, preview range, marker, auto-key, timeline zoom) and a generous, resizable **timeline** (drag the transport's top edge; layer rows live there, with an ease swatch per animated property: click it to edit that segment in the ease studio), both as wide as the window minus the inspector. The **agent** (with Library and Components tabs) is a collapsible left panel beside the stage (⌘I). The **inspector** runs the full height: the ease studio leads when keys are selected, then Transform as property rows with ‹ ◆ › key navigation, Animate, Rhythm, Timing; with nothing selected it shows the composition, markers and export. The top bar holds the document tab, the composition switcher with size · fps · duration, undo / redo, Agent and Export. Screenshots: `docs/shots/design-v2/` (`node scripts/design-shots.mjs`).
- **Design system**: tokens in `src/ui/tokens.css` (dark default, light via File menu or `?theme=light`), canvas parity via `src/ui/theme.ts`, primitives in `src/ui/ui.tsx`, living style guide at `?styleguide`.
- **Smart animate** (Figma style, `src/core/smart.ts`): select two versions of a design (e.g. two pasted Figma frames) → Animate panel → *Smart animate A → B*. Layers are matched by name path; every differing property (transform, size, fill, radius, stroke, path shape with the same structure) gets an eased key pair, unmatched layers fade in/out, the end frame is removed. One undo step; also an agent tool (`smart_animate`).
- **Components and linked styles** (see `docs/components-and-tokens.md`): main components + instances (real linked layers: own place, delay, overrides; main edits and animation propagate inside the same undo step), named colors/numbers that fill, stroke, radius, stroke width and opacity link to (resolved values stay in the props, so zero render cost; light/dark modes; hand edits unlink). Library tab: palette with usage counts, click to select users, drag a swatch onto a layer. Sync from Figma paste (variables, color styles, components), W3C / Tokens Studio files (watched in the desktop app), URLs or the Figma variables API, always through a before → after review, one undo step.
- **Gradient fills**: Fill → Solid / Linear / Radial, angle, color stops (add/remove, position, color+alpha). Static (not keyframed). Exported to Lottie as gradient fills (`gf`, checked against lottie-web: mean pixel error 1.7; gradients on non-square boxes stretch slightly differently); the AE script uses the first stop color.
- **Markers**: M adds one at the playhead; drag, name (double-click), delete (right-click). J/K and keyframe drags snap to them. Exported to Lottie and AE; the agent can set them (`set_markers`).
- **Audio layers**: drop or open a wav/mp3/m4a/ogg. Waveform in the timeline, drag to shift in time, volume in the inspector, **Add markers on beats** (onset detection, `src/audio/beats.ts`). Playback through WebAudio is (re)scheduled on play, on loop wrap and on playhead jumps, so the editor clock stays frame-accurate.
- **Export**: Lottie JSON, **GIF**, and **video** (MP4 H.264 / WebM VP9 through WebCodecs + mediabunny; verified with ffprobe in Chromium and Electron). **After Effects script** (`.jsx`, `src/export/aejsx.ts`): rebuilds the comp in AE (shape layers, nulls as parents, box text, precomps, images, keyframes with temporal ease/hold/linear, spatial tangents, expressions). It embeds the Lottie export data and a small ES3 interpreter; tested against a mock of the AE scripting DOM (`tests/aejsx.test.ts`), not yet in a real AE. Audio layers are mixed offline (`OfflineAudioContext`) into one stereo track (AAC when the platform has it, else Opus). `scripts/audio-check.mjs` checks the streams with ffprobe.
- **Graph editor**: value curves in the timeline. Drag keys (time/value) and bezier handles on the real curve, which Figma Motion doesn't have.
- **Expressions** (`wiggle(2, 20)`, `loopOut('pingpong')`, `time * 90`, `linear(...)`, vectors…): a *safe* mini language with its own parser (`src/core/expr.ts`). It never calls `eval` or `new Function`, so opening someone else's project can't run code. The parsed tree is compiled once per (expression, property size) into closures built from fixed code: shapes (scalar / vector of n) are known at compile time where possible, constants are folded, scalar math reads `time` / `index` / `value` directly, and every result goes through buffers allocated at compile time (doubles returned from closure calls would be boxed). The renderer keeps one frame object per layer property (seed, key times and `valueAt` made once) and only fetches the keyframed value when the expression reads it. Element-wise ops take arrays and indices (`ap`, `ap1`), so no double crosses a call boundary and nothing gets boxed where V8 doesn't inline. Stress lab `expr-3k` (3,000 layers, 4 expressions each), run alternately against the old build on a busy 4-core machine: eval 12.3-14.3 → 3.4-4.2 ms per frame, tick p50 14.6 → 4.2-4.7 ms, gc 1.3-1.8% → 0.1-0.4%. `tests/expr-compiled.test.ts` checks the compiled evaluator against the old tree interpreter (`tests/expr-reference.ts`) on ~16k random expression/context pairs (values, shapes, errors, `random()` call counts); `npx vitest bench tests/expr.bench.ts` is the micro-benchmark (expr-3k frame in node: 18-21 → 7.4-9 ms).
- **Text animation** (per letter / word / line, like AE text animators): presets (Fade up, Typewriter, Pop letters, Spin letters, …), order (forward, backward, center, random), springs. Every unit is its own instance in the same single draw call.
- **Precomps** (⇧⌘C to pre-compose, a comp switcher, start offset), **masks** (Figma-style), **group opacity** done right (offscreen isolation)
- **Pen tool** + path point editing; **animation presets** (fade/slide/pop/…) with stagger; **align/distribute**
- **Snapping + smart guides** in the viewport; timeline scrollbars; layers can be moved in time; keyframe copy/paste
- **AI agent sidebar**: chat with **Claude Code**, Codex CLI or Gemini CLI using *your own subscription* (through the local bridge). The agent drives the editor with MCP tools: add/update layers, keyframes, easing, screenshots and more.
- **Autosave** to local storage, plus `.motion` project files (JSON)
- **Self-updating desktop app** (`electron/updates/`, `docs/updates.md`): Ed25519-signed manifest on GitHub Releases; interface-only updates (the `dist/` zip, ~1.3 MB) load from the app data folder with an app-ready watchdog and automatic rollback to the last good / built-in interface; full app updates when `minShell` (derived from a fingerprint of electron/, bridge/, Electron + deps) moves past the installed app, swapped on quit by a helper script for the unsigned Mac build. Tag `vX.Y.Z` → `.github/workflows/release.yml` publishes.

## Running it

```bash
npm install
npm run dev            # browser at http://localhost:5173
npm run bridge         # (browser only) local agent bridge on 127.0.0.1:7823
npm run electron       # build + desktop app (starts the bridge itself)
npm test               # unit tests (vitest)
node scripts/e2e.mjs out.png           # ui interaction test in chromium (dev server must run)
node scripts/perf.mjs 1000,5000,10000  # playback perf (dev server must run)
npm run stress         # stress lab: ~25 brutal scenarios on the production build + regression report
npm run stress:quick   # shorter windows, 30s soak (results are only compared with other quick runs)
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

### Stress lab (`scripts/stress-lab.mjs`, scenes in `src/lab/`)

- Builds the production bundle, serves it on port 4182 and opens `?lab`, which lazily loads the scene builders and measurement loops (`window.motionLab`). Nothing of it ships in the normal startup path.
- Scenarios: springs 10k/25k, 8-deep nesting, group-opacity isolation stack, 200 precomps x 50 instances, 2k text animators, 1k path morphs + trim, 3k expressions, 500 big gradient/image rasters, masks + blend modes, overdraw, a production-like mix, camera zoom/pan while playing, scrubbing, drag while playing, motion-blur sub-frames (x1..x16), undo/redo storm, bulk commands, synthetic Lottie/Figma imports, a 3 minute soak.
- **tick** = the whole editor frame on the main thread (render + timeline/overlay hooks). Draw calls are stubbed for the main numbers because the container GPU is SwiftShader (a few fps for 10k layers); `swFps` is the real software-GPU rate.
- Every run writes `bench/results/<date>.json` and compares each scenario with its newest earlier result (>10% worse is flagged; rows measured while the machine was busy are marked noisy). `--only a,b`, `--top` (profile top functions), `--report <file>`, `--strict` (exit 1 on regressions).

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


### Atlas and gradients (after the stress lab)

- Plain linear/radial gradients on rects, ellipses and groups are drawn in the instance shader (SDF shape + a 256-texel color ramp row + inverse paint transform per instance): no raster, no atlas space, free size/radius animation.
- The atlas reuses freed slots, evicts least-recently-used entries one at a time (never what the current frame draws), compacts in place uploading only moved entries, and prunes raster metadata on eviction. Rasters are capped at 1/8 page; a raster that doesn't fit falls back to a lower resolution, so **layers never disappear** (rasters-500: 77 → 500 of 500 drawn).
- Per-frame path shapes (morph, trim) draw into a ring-allocated canvas texture: no getImageData, no per-frame atlas keys (metadata no longer grows with comp length).
- Isolation/mask offscreen passes are scissored to the region's screen bounds; each draw range binds one cached vertex array.
- Stress lab, CPU mode: mixed-10k 105 → 25 ms, camera-mixed-10k 106 → 27 ms, rasters-500 79 → 0.4 ms per frame.

### Deep zoom: viewport tiles (`scripts/zoom-check.mjs`)

- A raster layer whose raster at screen resolution would be big (a side > 2040 px, or > 1 Mpx while less than half of it is on screen) is drawn as **tiles of its raster at screen resolution, only where it is visible** (+ a 1 tile prefetch ring). Texture memory follows the screen size, not the zoom; text, paths, gradient rasters and images (up to their native resolution) stay crisp at any zoom (limit 1%..25600%).
  - Tile levels are quarter octaves (settled view: 1..1.19x screen resolution). Tiles of a level share one pixel grid and carry a 1 px apron of real content, so linear filtering across seams is exact.
  - A missing tile is drawn from the small whole-layer raster (a sub-rectangle of it, same quad), so a layer never disappears. A new level replaces the shown one only once all its visible tiles are resident (no blurry flash).
  - Tile jobs go to the raster workers nearest-to-visible first, at most 6 in flight (no stale queues during fast pans); images tile on the main thread within the frame budget; exports (`syncRaster`) raster tiles synchronously.
- **Zoom gestures**: two zoom changes within 180 ms count as a gesture. During it rasters and tile levels are kept and drawn scaled (no thrash); only rasters that got more than 2x too soft upgrade, progressively. When the gesture settles, sharp versions are rasterized. A single zoom jump (zoom to fit, keyboard) re-rasters at once as before.
- **Atlas budget**: optional allocations (upgrades with an old raster to show, tiles) stay within 8 pages (128 MB), never evict entries drawn in the last 30 frames and never compact. Compactions are rate limited to one per 60 frames.
- **Viewport UI**: ctrl/cmd+wheel and trackpad pinch zoom at the cursor (Safari gesture events too); mouse-wheel notches glide over a few frames; overlay lines and handles snap to device pixels at any zoom / dpr.
- `scripts/zoom-check.mjs` (scenes from `scripts/zoom-dump.mjs`, lab scenes `zoomMix` / `crisp`): zoom sweep 0.05x -> 64x -> 0.05x while playing, holds at 4x / 32x, and crispness against a direct canvas2d render of the same view. Before -> after (1600x1000, dpr 1, software GPU):

| | before | after |
|---|---|---|
| sweep: evictions / compactions / uploads per s | 200 / 1.5 / 247 MB | 0 / 0 / 6 MB |
| sweep: frame ms mean / p95 | 29.9 / 128 | 4.8 / 27 |
| hold 4x playing: evictions / compactions / uploads per s | 27 / 3.1 / 318 MB | 24 / 0 / 2.8 MB |
| hold 4x: frame ms mean / p95 | 116 / 332 | 4.0 / 10.6 |
| hold 32x playing: evictions / compactions / uploads per s | 4.6 / 1.4 / 140 MB | 78 / 0.33 / 43 MB |
| hold 32x: frame ms mean / p95 | 239 / 407 | 16.7 / 62.7 |
| crisp, mean abs error (0-255) text 8x / 32x / 128x | 4.6 / 4.9 / 8.7 | 1.1 / 0.17 / 0.13 |
| crisp, mean abs error star path 8x / 32x / 128x | 5.0 / 17.9 / 36.3 | 0.33 / 0.71 / 0.81 |

  (hold 32x after: ~50 big scale-animating stars overlap the view and re-tile as they grow; those evictions are LRU replacement of off-screen tiles, not thrash. Before, the headline text at 32x was not drawn at all.)
- 1x is pixel identical (`pixel-compare.mjs`: max diff 1/255 on text, the known noise floor).

### Timeline at scale (`scripts/timeline-bench.mjs`, `scripts/timeline-profile.mjs`)

- The bench drives the canvas timeline with synthetic wheel / pointer / input events in `?stress=N[&nested]` scenes and times each step (event handlers incl. every store listener + the timeline frame hook). `TALL=700` makes the timeline 700px high (28 visible rows) instead of the default 300px.
- How it stays cheap:
  - The rows are drawn straight into the visible canvas, only when something changed. The playhead is on a separate transparent overlay canvas (`.tl-overlay`, no pointer events): moving it clears and redraws a 16px strip. The old design copied an offscreen "base" canvas into the visible one on every redraw, and that `drawImage` forced a synchronous flush of the whole canvas: ~3 ms of a ~3.5 ms scroll step.
  - Rows are rebuilt lazily (at most once per frame) and only when the row structure can have changed. `Store.onChange` gives the touched layers; for those it compares the prop-row mask of expanded layers (and the search match) with the last build. Dragging keys or editing values does not walk the tree any more.
  - `reveal()` runs on every single-layer selection. It reuses the rows plus a lazy id → row index, instead of rebuilding them and doing a `findIndex`.
  - Keys are sorted by time, so prop rows, collapsed summaries and the marquee binary-search into the visible time range. Collapsed-row summaries are cached per layer until the layer changes.
  - Graph editor: `pick()` stops once it has found the 12 curves it shows. Before, it split every selected key id on each redraw (25-30 ms with 40k selected keys).
  - Search: match sets are cached per filter string until the document changes. Backspace reuses an earlier result, and typing more characters only rescans the matches of the longest cached shorter filter. Lower-cased names are cached too. Ellipsized layer names are cached per font, width and text.
- Results (production build, 700px timeline, mean / p95 ms per step, before → after; quiet-machine numbers vary ±30%):

| step (25k layers, flat) | before | after |
|---|---|---|
| wheel scroll / ctrl+wheel zoom | 4.3 / 11.4, 4.2 / 11.8 | 0.6 / 0.9, 0.6 / 1.0 |
| row hover | 4.3 / 11.9 | 0.5 / 0.8 |
| click a row (selection + reveal) | 7.8 / 14.0 | 0.9 / 5.8 |
| marquee (per move) | 4.8 / 12.0 | 0.8 / 2.3 |
| drag ~6k selected keys (per move) | 16.0 / 29.0 | 5.5 / 13.5 |
| graph editor redraw, 40k selected keys | 33.7 / 46.4 | 1.6 / 3.1 |
| search typing (per key) | 24.7 / 38.1 | 13.0 / 35.7 |
| expand / collapse all (150k rows) | 30.1 / 55.7 | 22.0 / 37.8 |
| playback frame hook | 0.1 | 0.05 (no full-canvas copy per frame any more) |

- What is left: expanding everything still allocates one object per row (150k rows ≈ 20-35 ms, once). Most of a key-drag step is now `moveKeysFrom` and the other store listeners, not the timeline. A search that matches most layers still rebuilds a row list of that size on each keystroke. Toggling visibility is a structural change (the renderer recompiles), so it still rebuilds the rows (~3 ms at 25k).

## Lessons learned (performance)

1. **Do not use `desynchronized: true` on the WebGL canvas.** It removed compositor backpressure, so the page queued frames faster than the GPU drew them. Memory grew ~15 MB/s until the browser was killed. Removing it made memory flat.
2. **Many small texture uploads into a texture the GPU is still reading are poison.** Drivers either stall or copy the whole texture per call. Batch them through CPU shadow pages with one sub-rectangle upload per page per frame.
3. **Keyframe evaluation was memory-bound, not math-bound.** 50k tracks as separate objects took 115 ns per track; packed contiguously, 37 ns, with bit-identical results (`bench/eval-bench.ts`).
4. **Layers animating their scale used to re-rasterize all the time.** Rasterizing at the maximum animated scale plus hysteresis fixed that.
5. UI frameworks stay out of the playback loop. The single `requestAnimationFrame` loop in `src/app/editor.ts` drives the WebGL canvas, the overlay and the timeline; panels only re-render when paused.
6. **Measure what the renderer stats don't show.** At 10k layers the audio engine's per-frame tree walk cost about a third of the evaluation. It only showed up in a whole-page CPU profile (`profile-play.mjs`).
7. **Object graphs are cache misses.** Moving the per-item fields the frame loops read into typed arrays halved evaluation at 25k layers. After that, the remaining write cost was the first touch of each layer object, so the writer now reads typed arrays too.
8. **An offscreen 2D canvas "cache" is not free.** Copying it into the visible canvas with `drawImage` forces the offscreen canvas's pending drawing to be flushed synchronously, and on every redraw that copy cost more than drawing the rows themselves. Use stacked canvases (static content + a small overlay) instead.

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
- **Lottie import is measured against the official lottie-web player** (`scripts/lottie-compare.mjs`, `REF_RENDERER=svg`) on 45 real files: the 11 lottie-web test animations plus 34 from lottie-android's sample set (`snapshot-tests/src/main/assets`, picked for merge paths, repeaters, round corners, gradient strokes and expressions).
  - Mean pixel error over the 45: 3.9 -> 1.8 of 255 after the shape modifiers below (lottie-web's 11: 2.7 -> 2.5). Worst before: swipe_menu 50.7 -> 0.2 (repeater), loading_disc 19.8 -> 2.9 (gradient stroke + slider-driven trim), Repeater 15.9 -> 8.6, RoundedCorners 5.9 -> 0.1, kod.io 4.0 -> 0.4.
  - Supported: masks (add, subtract, intersect), track mattes, animated paths, trim paths, compound paths, AE stacking order with parenting, precomp time stretch/remap, simple expressions, blend modes, and:
    - **merge paths**: mode 1 (merge) concatenates into one compound path (exact curves, keys kept); add / subtract / intersect / exclude are polygon booleans on the flattened beziers (`src/import/pathops.ts`: split at every intersection, keep edges by winding classification, chain into oriented rings), applied top to bottom like AE / Skottie. Animated operands are sampled once per frame. Paths consumed by a merge keep only the paints above it. A raster (compositing) fallback was not needed: the boolean is a few ms per shape and the result exports and strokes like any path. **lottie-web ignores merge paths** (no `mm` modifier), so on files that use subtract / intersect our output is *closer to After Effects but further from lottie-web* (play_and_like_it 0.7 -> 2.6: the "explosion" ring is a ring, lottie-web draws a disc).
    - **repeaters** (copies, offset incl. animated, transform with position j·p and rotation / scale around the anchor like lottie-web, opacity ramp, composite order), **round corners** (lottie-web's vertex rounding on paths and stars, corner radius on rects, animated radius keeps the path structure), **gradient strokes** (stroke-only mask path under a gradient box, so trims / animated widths work), **every paint above a path** is drawn (extra layers only when the nearer paint does not hide them).
    - **expressions that only read another property**: `thisComp.layer('X').effect('Slider Control')('Slider')`, `content('G').content('P').path`, `thisComp.layer(n).transform.rotation`... resolve to that property's keyframes.
  - Remaining gaps: expressions with logic (rigs such as rubberhose / Duik, `createPath`, starfish), trim paths on fills (the fill of a trimmed path), stroke dashes, per-character text animators (banner), luma mattes. Small comps (cloud_disconnection, 72 px) look soft because rasters follow the comp scale, not the snapshot size (renderer side).
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
- **Review every turn**: the document is snapshotted before a turn and diffed after it (`src/agent/diff.ts`). The review card lists added/changed/removed layers and properties (click to select), *Hold to compare* (undo to the pre-turn state while held, redo on release), *Replay*, *Revert* (undo back to the turn start) and *Keep*. Cards are tied to undo entry ids (`Store.topEntryId`), not step counts: they act only while the turn's last entry is on top, so they can never undo your own later edits.
- **Quick actions** on the selection (`src/agent/quick.ts`): Animate in, Bouncier, Smoother, Snappier, Slower, Faster, Stagger, Anticipation, 3 variations, Critique, Explain.
- **Ask mode** (Critique/Explain or the Edit/Ask toggle): read-only turns. The editor refuses editing tools, and Claude Code only pre-approves the read-only ones.
- **Director workflow** (`src/agent/prompt.ts`, `src/agent/guides/`, `src/agent/storyboard.ts`): the system prompt is a small stable core (< 1,200 words: role, conventions, working method, tool choice, quality bar), the cached prefix of every request. Craft knowledge is markdown loaded on demand with `get_guide` (also MCP resources `motion://guides/...`): `handbook` (12 principles with numbers, timing tables, easing names mapped to our presets/springs, spacing, hierarchy, loops, transitions, type, color, composition, critique rubric), `workflow` (brief → storyboard → blocking → timing → polish → critique → fix → summary; scope and budget rules), `cookbook` (exact tool calls for 7 pieces + how to use the planned higher-level tools), `styles/*` (16 recipes: palette hex, type, easing family, timing, signature moves, transitions, do/don't, mini scene plan). For full pieces the agent calls `propose_storyboard`: the chat shows an editable card (beats: name, time range, description, style notes; add/remove), *Approve & build* sends the edited plan back as the next message (Settings → Models → Storyboards: wait for approval / build right away). `update_progress` marks beats active/done on the card; each beat's edits are squashed into one undo step "Beat N · name" (`Store.squashSince`). After building, the agent critiques with contact sheets against the handbook rubric, max 2 fix rounds.
- **Concept-driven motion** (`src/agent/guides/concepts.md`): before animating artwork (logo, icon, illustration, imported frame) the agent must look at it (`inspect_artwork` when available, else contact sheet / screenshot), name what the parts depict and the brand traits, and propose 2–3 concepts rooted in that meaning (door opens on its hinge, leaf grows from its stem, dot lands as the i's tittle…), recommend one and build it. In the director flow the concepts go on the storyboard card (`propose_storyboard` `concepts` + `recommended`); the user picks one and the approval tells the agent which (and to re-plan if it differs). Pop/fade/scale-in are secondary motion only. Eval briefs for this: `src/agent/guides/evals/concept-briefs.json` (house + door, leaf + wordmark, chat bubble, rocket; setup tool calls + judge rubric) — move to `evals/` with the harness. Animating trim on a path now switches its *Trim paths* on (draw-on recipes render).
- **Style picker + result preview**: a chip row (one per style recipe) prefixes the next brief with the style (in the message, never the system prompt). Every editing turn ends with a contact sheet of what it animated under the review card (click to replay).
- **Runtime**: model *Auto* (Settings → Models → Directing) runs full pieces on the strongest alias (default `opus`) and edits/quick actions on a faster one (default `sonnet`), chosen per message by `briefScope` (`src/agent/quick.ts`). Claude gets `--max-turns` (default 90, `MOTION_AGENT_MAX_TURNS`, or Settings → Turn budget); running out is a typed `turn_budget` error ("say continue"). Tool text results are capped at 24k chars by the bridge.
- **Variations**: the agent builds versions and calls `save_variation`; the tray shows filmstrips, click to preview (applies + plays), scrub, *Use*.
- **Tools for agents**: `get_animation` (compact text), `animate` (many tracks, one undo step), `retime`, `stagger`, `contact_sheet` (labeled frame grid, one JPEG). Tool results are compact JSON/text.
- **Lean Claude runs**: `--tools "" --disable-slash-commands` (no built-in Bash/file tools, no skills), with automatic fallback for older CLIs. The same 3-card build went from 285k to 41k input tokens per turn (cost $0.089 → $0.078; most of the 285k were cache reads).
- **Errors** are typed in the bridge (`bridge/errors.mjs`: not installed, auth, rate limit, overloaded, network, timeout, cancelled) and shown with the fix plus Retry. A turn whose CLI prints nothing for 5 min is killed (`MOTION_AGENT_IDLE_MS`). A bridge disconnect ends running turns cleanly.
- **Persistence**: the conversation and CLI session ids are stored per project (keyed by the first composition id, which is saved in the file). Review cards from earlier sessions are marked stale, because the undo history is gone.
- Checks: `tests/agent.test.ts` (schema validation, tools against a real store, diff/context, guides load + only name real eases/springs + their expressions compile, prompt size budget, storyboard flow with per-beat undo), `tests/bridge-agent.test.mjs` (a fake `claude` replays recorded stream-json: success, auth, crash, timeout, cancel, lean fallback), `scripts/agent-ui-check.mjs` (Playwright, full panel against `tests/fixtures/fake-claude/claude`, which really calls the MCP tools), `scripts/agent-real-check.mjs` (real subscription runs: build, variations, critique), `scripts/agent-director-check.mjs` (real run of the director flow: style chip → storyboard card → approve → beats → critique).

## Quality process used

- Three independent read-only review rounds by separate agents. Each round reported 10–15 confirmed bugs with reproductions; all were fixed and most now have regression tests (`tests/core.test.ts`, "review regressions").
- Real-world fixtures:
  - Figma clipboard captures, including the 2025 format
  - 11 Lottie files from lottie-web, compared against the official player
  - real `.aep` files
- `scripts/` holds the browser and Electron checks: e2e interactions, perf, drag-and-drop, agent loop, precomps, masks, text animation, Lottie comparison, video/GIF export, context loss, desktop autosave.

## Design system (`src/ui/`)

The look is token driven, so a visual pass should only need to edit `tokens.css`.

- **`tokens.css`**:
  - semantic colors: surfaces, text levels, accent and selection, status, keyframes
  - canvas tokens for the timeline (`--tl-*`), the graph editor (`--graph-*`, `--axis-*`) and the viewport overlay (`--vp-*`)
  - spacing, radii, type scale, control sizes, shadows, motion durations and easings, z layers, focus ring
  - dark is the default. Light is `data-theme="light"` on `<html>`: File menu → Light theme, or `?theme=light`. A theme can also be set on a subtree.
- **`theme.ts`**: canvas parity. It resolves the canvas tokens into `T` once at startup and again on each theme change (a MutationObserver on `data-theme`). Draw code reads `T.tlBg` and `T.font.ui`. Nothing calls `getComputedStyle` per frame (measured: 0 calls during playback; a theme switch costs about 13ms once).
- **`ui.tsx`**: the primitives Button, NumField, Select, Checkbox, Toggle, Slider, Segmented, Section, Dialog (focus trap, Escape, focus restore), ColorSwatch and Kbd.
- **`styles.css`**: the component classes.
  - `.btn` with `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.btn-icon`, `.btn-sm` and `.btn-lg`. The legacy `.primary` and `.ghost` classes still work.
  - `.seg`, `.section`, `.ctx-menu`, `.toast`, `.dialog`, `.swatch`, `.kbd` and `.progress`.
  - CSS-only tooltips through `data-tooltip`.
  - Menus (`menu.ts`) support arrow keys, Home/End, →/← for submenus, type-ahead, and Enter/Space.
- **Style guide**: `?styleguide` shows every token and component in both themes. It also runs live WCAG contrast checks (all text pairs reach AA) and draws a timeline and graph sample through `theme.ts`.
- **Performance rules**: no backdrop-filter or blur, and transitions only on the color and opacity of small controls. Panels use `contain`. The per-frame timecode uses tabular digits in a fixed-width box.

## Known limitations / next

- **Effects: none yet, on purpose.** The renderer is prepared (effect-pipeline design + motion blur / gaussian blur prototypes, see "Architecture decisions"); effects get added one by one after v0.5, in the order of `docs/research-2026-11.md` (drop shadow, blur, motion blur, glow, …).
- **Design pass** still to do: the design system (`src/ui/tokens.css`, `?styleguide`) is ready to be re-themed by changing tokens only, once the visual direction is set.
- Layers that animate their path shape (morph, trim) are not tiled: at deep zoom they are capped at one 2040 px raster per frame. Per-glyph text animation units are not tiled either.
- Zoomed-in playback of many big layers that animate their *scale* still re-tiles them as they grow (bounded: 6 tile jobs in flight, LRU within the byte budget). GPU text/path rendering (see decisions) would make that free.
- The anticipatory max-scale boost can still fill the atlas to 12 pages at fit zoom in raster-heavy scenes (required rasters may exceed the 8 page budget; optional ones may not).
- Only the nearest clip ancestor clips (no nested clip intersection).
- Lottie text glyphs only for the bundled Inter; other fonts export by name.
- AE: effects, expressions beyond the safe subset, 3D, cameras, luma mattes (as alpha), mask feather; the .jsx export uses the first stop of gradients and skips audio.
- Audio: no scrubbing sound, no fades/volume keyframes yet, no audio in Lottie/GIF.
- Perform (gesture recording) and the feel pad were only tested with automated mouse input: needs a real-hand pass.
- Performance numbers come from a container with a software GPU: CPU budgets are measured, GPU costs are estimated. Re-run `npm run stress` and `scripts/cpu-bench.mjs` on real hardware to get a baseline.
- Known bottlenecks (stress lab): very large scenes still evaluate every animated layer each frame (GPU-side evaluation is the long-term lever); structural edits recompile the whole scene; precomp instances are evaluated per instance.
