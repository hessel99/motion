# Export ↔ editor parity

Goal: what an export shows is what the editor shows. Every export path is measured frame by frame
against the editor's own renderer, with real decoders and players, and every difference found was
fixed in the exporter or the renderer (tests were never loosened to pass).

```bash
npm run parity          # quick subset (CI): 16 scenes × 8 paths, a few frames each, exits 1 on a failure (~4 min)
npm run parity:full     # every scene, every frame, plus lottie-native (what "Ignore" costs)
node scripts/export-parity.mjs --scenes text,masks --paths lottie,mp4   # a subset
```

Report: `bench/results/export-parity/report.html` (editor / export / diff of the worst frame of each
scene × path, worst first), raw numbers in `results.json` / `results-full.json`; the measurement of
the code before this work is `before-full.json`. The pure parts (colour conversion code values,
GIF delays, preflight lists, Lottie mapping) are unit tested in `tests/export-parity.test.ts`.

## How it measures

- **Reference**: the editor's renderer (`src/export/frames.ts` `FrameGrabber`) at output size, every
  raster finished synchronously, figma shaders settled for the exact frame, rendered into an RGBA
  target so transparency is real. Every raster export now renders through this same grabber, so
  the reference *is* the export's source; the harness then checks everything after it (encoders,
  containers, decoders, players).
- **Scenes** (`tests/parity/scenes.ts`, plain model code): frame barcodes (7 bits + parity, hold
  keys per frame: any decoded frame says which editor frame it shows) at 30, 24→30, 60 fps
  (odd size 211×117) and 12 fps; a colour chart; shapes and strokes (caps, joins, dashes, spatial
  bezier); linear / radial / angular / diamond gradients, image fill, noise paint; image layers;
  drop / inner shadow, layer blur, background blur, noise effect; a shader fill (animated) and a
  shader effect (our own test shaders, `tests/shader-fixtures.ts`); alpha / luminance / vector
  masks and a clip group; all 18 blend modes; group opacity and nested parents; text (weights,
  spacing, wrapping, alignment, case, runs, decoration, a serif fallback, animated fill); text
  animators; expressions (seeded `wiggle`, `random`, `time`, `loopOut`); springs; precomps with a
  start offset; trim paths and a path morph; a transparent comp; an audio click track with an
  audio-reactive (`audio()`) layer.
- **Decoding**: video and GIF with ffmpeg at the stream's own tags (`in_color_matrix=auto`,
  `in_range=auto`, every frame, passthrough timing), frame times with ffprobe; PNG with ffmpeg;
  Lottie with **lottie-web 5.12.2 (svg renderer) in Chromium**, screenshots with a transparent
  page; the share preview page in Chromium, scrubbed with its own slider and read back from its
  `<video>` after `requestVideoFrameCallback`.
- **Metrics** (0–255 per channel, premultiplied RGBA): mean error, max, share of pixels off by
  more than 24, and the mean error inside flat colour areas (colour accuracy). 4:2:0 video can't
  carry full-resolution colour at hard saturated edges, so for video each channel may match either
  the editor frame or the editor frame through an ideal BT.709 4:2:0 round trip (`raw` in the report
  is the plain error). Chromium's WebCodecs encoders offer no 4:4:4 (avc1.f4…, vp09.01… are
  unsupported); the 4:2:0 simulation is how chroma subsampling is separated from colour handling.
- **Timing**: frame count, every frame's pts vs `i / fps` (drift), container duration, the barcode
  index of every frame (off-by-one at start / end, fps conversion), GIF delays, preview seeks.
- **Audio**: click onsets in the decoded track (first decoded sample's time, pre-skip handled) vs
  their comp times: < 1 ms; track length vs video length.
- **Lottie**: anything reported before export as impossible in Lottie (not bakeable: background
  blur, the `add` / `linearBurn` blend modes) is masked out of the comparison and listed in the
  report; everything else counts.

## Results

Full run (21 scenes, every frame; `node scripts/export-parity-table.mjs` writes these tables).
"Before" is the code this work started from, measured with the first version of the harness
(the PNG sequence did not exist; video was then compared to the editor frame directly, without the
4:2:0 allowance, which mostly matters for the colour chart and stripes). Errors are 0–255 per channel.

| path | before: pass | before: worst mean | after: pass | after: worst mean | after: worst flat colour |
|---|---|---|---|---|---|
| png | 0/21 | 58.18 | 21/21 | 0.00 | – |
| pngseq | 0/21 | – | 20/21 | 0.00 | – |
| mp4 | 14/21 | 46.06 | 21/21 | 1.47 | 1.46 |
| mp4hq | 1/21 | 46.03 | 21/21 | 1.47 | 1.46 |
| webm | 14/21 | 45.96 | 21/21 | 0.84 | 0.99 |
| gif | 2/21 | 58.21 | 21/21 | 2.75 | – |
| lottie | 2/21 | 125.75 | 21/21 | 0.47 | – |
| preview | 7/21 | 46.07 | 21/21 | 1.77 | 1.89 |
| lottie-native | n/a | n/a | 0/5 | 78.94 | – |

After, per scene (worst frame mean error; ✗ = fails a tolerance):

| scene | png | pngseq | mp4 | mp4hq | webm | gif | lottie | preview | lottie-native |
|---|---|---|---|---|---|---|---|---|---|
| timing | 0.00 | 0.00 | 0.12 | 0.12 | 0.11 | 0.00 | 0.05 | 0.52 |  |
| timing-24to30 | 0.00 | 0.00 | 0.06 | 0.06 | 0.05 | 0.00 | 0.02 | 0.44 |  |
| timing-60 | 0.00 | 0.00 | 0.21 | 0.21 | 0.15 | 0.01 | 0.07 | 0.21 |  |
| timing-12 | 0.00 | 0.00 | 0.05 | 0.05 | 0.07 | 0.01 | 0.05 | 0.03 |  |
| colour | 0.00 | 0.00 | 0.15 | 0.15 | 0.14 | 0.00 | 0.19 | 1.26 |  |
| shapes | 0.00 | 0.00 | 0.52 | 0.52 | 0.31 | 0.55 | 0.39 | 0.83 |  |
| paints | 0.00 | 0.00 | 1.47 | 1.47 | 0.82 | 0.58 | 0.13 | 1.45 | 24.89 ✗ |
| images | 0.00 | 0.00 | 0.83 | 0.83 | 0.57 | 2.75 | 0.13 | 1.43 |  |
| effects | 0.00 | 0.00 | 0.97 | 0.97 | 0.56 | 0.64 | 0.47 | 1.35 | 3.35 ✗ |
| shaders | 0.00 | 0.00 | 1.12 | 1.12 | 0.84 | 0.00 | 0.01 | 1.72 | 56.84 ✗ |
| masks | 0.00 | 0.00 | 0.61 | 0.61 | 0.31 | 0.21 | 0.16 | 0.78 |  |
| blend | 0.00 | 0.00 | 1.24 | 1.24 | 0.67 | 1.31 | 0.47 | 1.77 |  |
| group-opacity | 0.00 | 0.00 | 0.38 | 0.38 | 0.29 | 0.59 | 0.39 | 0.62 |  |
| text | 0.00 | 0.00 | 0.60 | 0.60 | 0.25 | 0.19 | 0.04 | 0.75 | 16.34 ✗ |
| text-anim | 0.00 | 0.00 | 0.29 | 0.29 | 0.18 | 0.32 | 0.04 | 0.50 | 78.94 ✗ |
| expressions | 0.00 | 0.00 | 0.24 | 0.24 | 0.20 | 0.20 | 0.11 | 0.41 |  |
| springs | 0.00 | 0.00 | 0.12 | 0.12 | 0.10 | 0.17 | 0.12 | 0.51 |  |
| precomp | 0.00 | 0.00 | 0.10 | 0.10 | 0.09 | 0.01 | 0.10 | 0.52 |  |
| trim | 0.00 | 0.00 ✗ | 0.14 | 0.14 | 0.11 | 0.15 | 0.11 | 0.52 |  |
| transparent | 0.00 | 0.00 | 0.29 | 0.29 | 0.16 | 0.13 | 0.14 | 0.65 |  |
| audio | 0.00 | 0.00 | 0.19 | 0.19 | 0.14 | 0.01 | 0.13 | 0.28 |  |

`lottie-native` is informational: every preflight item set to **Ignore** (what that choice costs);
it never fails the run. The one remaining failure, `trim / pngseq`, is a max error of 3–5 / 255 on a
handful of edge pixels in 3 of 45 frames (mean 0.00): trim-path frames are drawn into a shared
per-frame canvas whose slot position depends on render order. Invisible, but not bit-exact yet.

Other measurements:

- **Timing**: every video / GIF / Lottie / preview frame shows the editor frame of the same index
  (barcodes) at 12, 24→30, 30 and 60 fps; video frame times within 0.25 / fps of `i / fps` (no
  drift), exact frame counts and durations; GIF frames start within 5 ms of `i / fps`.
- **Audio**: click onsets at 0.50002 / 1.00002 / 1.50002 s in MP4 and WebM (0.02 ms; it was 7 ms
  early in WebM by the old measurement, which ignored opus pre-skip: the file was right).
- **Colour**: flat-colour error 0.33 (MP4) / 0.31 (WebM) decoded by ffmpeg, BT.709 / sRGB / tv tags.
  Chromium's `<video>` (headless, SwiftShader) decodes limited-range saturated primaries a little
  off (pure blue 255 → 243; flat error 1.8); with the old full-range stream it read 0.4, but full
  range is what QuickTime-era and hardware players get wrong, so limited range stays.
- **Performance**: `scripts/cpu-bench.mjs 10000,25000 --animated 0.1` on production builds, base vs
  this branch, two alternating runs: frame 1.4 / 1.3 ms vs 1.3 / 1.3 ms at 10k layers, 3.3 / 3.2 vs
  3.2 / 3.2 ms at 25k (unchanged: the render path only gained a branch in the clear and the raster
  reuse checks, both outside per-instance loops).


## What was wrong, and what was fixed

| path | problem (measured before) | fix |
|---|---|---|
| PNG | 2× / 4× exported at 1× (`snapshot` capped the scale at 1) | `src/export/png.ts` renders at the asked size through FrameGrabber |
| PNG | transparent comps came out on the editor's grey (`alpha:false` canvas): mean error 58 | real alpha (offscreen RGBA target, straight-alpha PNG) |
| PNG / agent snapshots | one render pass: first-time rasters and blend backdrops missing (blend scene mean 46) | FrameGrabber renders until nothing is pending; `snapshot()` too |
| PNG / shaders | the PNG didn't wait for shader results (mean 24) | shaders settled per frame |
| PNG sequence | didn't exist | zip of numbered PNGs (export dialog → Image → Sequence) |
| all rasters | a frame's pixels depended on what was rendered before (raster scale hysteresis, also for trim / morph shapes) | exports always use the exact raster bucket |
| renderer | text animators wrapped every word onto its own line after a load (`fontMetrics` left the shared measuring context at 1000 px) | context restored |
| renderer | `darken` / `lighten` drew a black box around the layer (GPU MIN/MAX on the quad's transparent pixels) and were wrong for semi-transparent layers | both go through the blend shader |
| video | colour conversion left to the browser, full-range ("yuvj420p") output that many players show crushed / washed out | rgb → BT.709 limited range 4:2:0 in `src/export/yuv.ts` (2×2 chroma average), frames tagged BT.709 / sRGB transfer / tv range: flat-colour error 0.3 against ffmpeg |
| video | 0.5 Mbit/s floor: thin detail (shader stripes, text) smeared at small sizes | quality *high* = 0.3 bpp with a 3 Mbit/s floor |
| GIF | delays rounded per frame (33 ms → 3 cs): 10% too fast, drift up to 197 ms over 2 s | delays from rounded start times (3, 3, 4 cs…): every frame within 5 ms, exact length |
| GIF | transparent comps on the editor grey; frame count `round` vs video `ceil` | 1-bit transparency (clear colour at palette index 0, disposal 2); same frame rule as video |
| GIF | one palette from 8 frames for the whole clip | 16 sample frames + a local palette for any frame the global one misses |
| share preview | scrubbing / frame keys landed on exact frame starts and showed the previous frame (frame-index mismatch, colour error 20) | seeks go to the middle of a frame |
| share preview | medium quality, 1× video | high quality, 2× video (hidpi screens 1:1; colour keeps full resolution where shown) |
| Lottie | no comp background (mean 58–68 on every opaque scene) | a solid layer at the bottom |
| Lottie | strokes drawn **under** the fill (lottie draws group items from the end) | stroke first |
| Lottie | caps / joins hard-coded round; dashes, trim paths, path morphs, blend modes not exported | mapped (`lc` / `lj` / `ml`, `d`, `tm`, animated `sh`, `bm`) |
| Lottie | group opacity / clip ignored (AE parenting doesn't pass opacity on) | such groups become precomps (offset null inside, sized to the children's bounds over time) |
| Lottie | masks not exported | track mattes over a precomp of the masked siblings (alpha / luma; vector masks with opaque fills) |
| Lottie | expressions passed as JavaScript: other random seeds, `audio()` unknown, most native players run none | baked to per-frame keys from the renderer's own evaluation (`renderer.sampleLayer`) |
| Lottie | image layers drawn at the asset size, not the layer box | per-size image assets with `pr: none` |
| Lottie | linear gradients on non-square boxes bent | start / end chosen so lottie's isolines equal ours (exact); elliptical radials are preflighted |
| Lottie | effects, angular / diamond / image / noise fills, shaders, inner / outside strokes, smooth corners, per-corner radii, text animators, styled / non-Inter text: silently dropped or approximated | **preflight + bake**, below |
| audio | (measured fine: onsets within 0.02 ms) | exports now also wait for the music analysis `audio()` reads |

## Lottie: preflight and bakes

`lottiePreflight(project)` (`src/export/lottie.ts`) lists, before exporting, every layer that would
look different in Lottie and why. The export dialog shows the list ("3 things would look different
in Lottie") with **Bake / Ignore** per item and Bake all / Ignore all:

- **Bake** (default): the layer (with its children) is rendered by a private second renderer
  (`src/export/lottie-bake.ts`, the open document is never touched) into images in the layer's own
  space, one image if its content is static, one per frame if it animates (identical frames
  deduplicated), at the largest scale it reaches. The images sit in a precomp that keeps the layer's
  real transform, parent, opacity, blend mode and timing, so it still moves exactly like the
  original and stays editable as a layer. Bakeable: effects (drop / inner shadow, layer blur, noise,
  texture, glass), shader fills and effects, angular / diamond / image / noise / pattern fills,
  stacked fills, elliptical radial gradients, inside / outside / gradient / per-side strokes,
  outlined stroke geometry, smooth corners, different corner radii, differently filled regions,
  incompatible path morphs, text (Lottie players lay text out themselves: no kerning, their own
  line breaks, no runs / decoration / case / lists, fonts other than the embedded Inter outlines),
  text animators.
- **Ignore**: exported natively (editable shapes / text), approximated. The full parity run
  measures what that costs (`lottie-native` rows).
- **Not bakeable, left out**: background blur (it needs the backdrop), the `add` and `linearBurn`
  blend modes (no Lottie equivalent: exported as normal), audio (Lottie has none).

## Limits (honest)

- Chromium's H.264 encoder (OpenH264) ignores the requested bitrate at small sizes (0.5 and 40 Mbit/s
  gave the same stream), so `mp4hq` can only be as close as its fixed quantizer allows; hardware
  encoders (VideoToolbox, Media Foundation) follow the bitrate.
- Video is 4:2:0 (no 4:4:4 encoder in WebCodecs): thin saturated detail loses colour resolution in
  every player; players upsample chroma differently (Chromium's `<video>` vs ffmpeg differ by up to
  ~2% of pixels on stripe patterns).
- Transparent comps: MP4 / WebM are opaque (black background, as in other tools; Chromium's VP9
  encoder has no alpha); GIF has 1-bit alpha (cut at 50%). PNG keeps full alpha.
- `multiply` / `screen` over a *transparent* background composite against nothing (the GPU blend
  formulas assume an opaque backdrop); over an opaque comp background they are exact.
- Expressions inside a precomp that is instanced several times are baked from its first instance.
- Motion blur and time remapping of plain precomps are not features of the editor yet, so they are
  not in the matrix.
- Measured in a container with SwiftShader (software GL / WebGPU); decoders: ffmpeg 6.1, Chromium 153.
