# Figma → Motion import fidelity

A repeatable stress test for the Figma import (and the SVG import): a synthetic Figma file with one
feature per frame, Figma's own renders of every frame as ground truth, Motion's render of the same
frame after import, and a per-pixel comparison. Everything below is from synthetic test frames only.

## What is measured

**The Figma test file** ("Motion fidelity test", in the owner's drafts; the file key is in every
`bench/results/figma-truth/*/meta.json`). 181 frames of 400×300 in 11 sections, built by
`scripts/figma-fidelity/build/*.js` through the Figma MCP `use_figma` tool (plugin API):

| section | frames | covers |
|---|---|---|
| paint | 24 | solid, alpha, linear (angle, 4 stops, stop alpha, short span), radial (offset, elliptic), angular, diamond, multiple fills, paint opacity, hidden paint, per-paint blend, image fill / fit / tile / crop / rotated / filters / opacity over solid (generated images), gradient on ellipse and text |
| blend | 20 | all 18 layer blend modes over a hue + gray backdrop, pass-through vs normal group, group opacity |
| effect | 18 | drop shadow (spread, multiple, behind transparent fill, on text, on stroke-only ellipse, on a clipping frame), inner shadow, layer blur, progressive blur, background blur, progressive background blur, noise mono / duo / multi, texture, glass |
| stroke | 15 | center / inside / outside, radius + outside, dashes (center, outside + round caps), gradient, multiple, per-side weights, all caps incl. arrows, miter / bevel / round joins, open curve, text stroke, dashed inside ellipse, hairlines 0.5–2.75 px |
| shape | 16 | radius, per-corner, smoothing 100%, clamped radius, arc, donut, star, polygon, line, rotation, flip H, flip V + rotation, nested clip (rotated inner clip), no clip, rotated group, image-filled frame with radius |
| geometry | 18 | masks (alpha, vector, luminance, text mask, two masks), booleans (union, subtract, intersect, exclude, nested + stroke), vectors (even-odd, nonzero, nested holes, curves, multi-region network with per-region fills, open network, scaled, flattened text) |
| instance | 6 | main component, default instance, overrides (fill, text, nested fill), resized + rotated, instance nested in a component |
| text | 23 | Inter regular / 7 weights, Roboto Flex named instances (variable font), serif italic / serif bold / mono, styled runs, letter spacing (% and px), line height px / % / auto, decoration, case (upper, lower, title, small caps), lists, 4 horizontal + vertical alignment, auto-resize modes, truncation, paragraph spacing, rotated + opacity, 200 px display, unicode / ligatures |
| shader-fill | 11 | every fill shader from `list_shaders` |
| shader-effect | 27 | every effect shader from `list_shaders`, applied on a frame holding the test pattern (mark + text + gradient + shapes) |
| combo | 3 | mark + logotype on a gradient background with a noise effect: without shader, with a shader fill overlay, with a shader fill + a shader effect |

**Shaders: only 3 of 38 are applied.** The plugin API can only apply shaders that
`figma.listAvailableShaders()` returns, which is the account's own shaders (Waveform gradient,
Crayon sketch, Midpoint mirror). Figma's 35 first-party shaders are rejected by `importShaderById`
(also with `id/version`). Their frames exist with the test pattern and a `shader-slot` layer; apply
the shader by hand (select `shader-slot` → add the effect / fill), then re-run the dump for the
`shader-fill` / `shader-effect` sections. Until then those frames are listed but excluded from the
scores (the report marks them).

**SVG**: 29 hand-written nasty SVGs (`scripts/svg-fidelity/cases.mjs`): arcs, nested transforms incl.
skew / matrix / flips, `use` / `symbol` / `defs`, linear + radial gradients with
`gradientTransform`, `spreadMethod`, `href` inheritance and focal points, clip paths (incl. text and
`objectBoundingBox`), masks, dashes / caps / joins / miter limit, fill rules, text with `tspan`, x/y
lists, anchors, CSS (`<style>` classes, ids, compound + child selectors, `!important`, inline style),
percent / physical units, `viewBox` + `preserveAspectRatio` (slice, meet, none), opacity stacking,
named / hsl / 8-digit colors, nested `<svg>`, markers, patterns, filters, path syntax edge cases,
non-scaling stroke, `paint-order`, inheritance + visibility, data-URI images, and 3 seeded random
paths. Ground truth is Chromium drawing the same SVG.

**Score** per case (1x): `100 × (0.4·ssim + 0.3·(1 − bad) + 0.3·(1 − soft))`, where bad / soft
are the share of pixels whose max channel delta (both composited over white) exceeds 32 / 8, and
ssim is a block SSIM (8×8, stride 4) on luminance. 2x is measured as well (report.json). The noise
floor is ~97–100: identical shapes score 99.6–100; the text baseline offset below costs every
frame containing text 2–4 points.

## How the payload is obtained

Motion's paste reads Figma's clipboard HTML (a fig-kiwi binary). **Nothing automatable produces
that payload**: the plugin sandbox has no clipboard or kiwi access, the REST API has no kiwi
export, and the MCP tools return images, metadata and plugin-API values only. So the converter is
exercised through two equivalent node-JSON routes plus real pastes:

1. **Plugin dump (used for this report, no token needed).** `90-dump.js` serializes every frame's
   node tree with the plugin API (transforms, paints incl. gradient transforms and image bytes,
   effects, strokes, dash / cap / join, per-side weights, radii, smoothing, arc data, fill and
   stroke geometry, vector networks, text with styled segments and lists, instance links, shader
   paints / effects with their parameters) plus `exportAsync` PNGs at 1x and 2x. `use_figma` returns
   at most 48 KB of text, but images written with `figma.io.write` come back byte-exact, so the
   dump is a binary container split into "data PNGs" (≤560 KB of raw bytes in RGBA pixels, ≤4 per
   call). `scripts/figma-fidelity/unpack.mjs` reassembles them into
   `bench/results/figma-truth/<section>/{meta.json,truth/*.png}`.
   `src/import/figma/rest.ts` (`pluginNodesToMessage`) turns that JSON into the decoded-kiwi
   message shape `figmaMessageToLayers` consumes (kiwi field names: `fillPaints`, `FOREGROUND_BLUR`,
   `blurOpType`, `borderTopWeight`, `textData.characterStyleIDs` / `styleOverrideTable`,
   `vectorData.styleOverrideTable`, `commandsBlob` blobs, …). Plugin quirk handled there: children of
   GROUP / BOOLEAN_OPERATION report `relativeTransform` in the nearest frame's space.
2. **REST** (`scripts/figma-fidelity/rest-fetch.mjs`, `restNodesToMessage`): `FIGMA_TOKEN=… node
   scripts/figma-fidelity/rest-fetch.mjs <fileKey>` fetches nodes (`geometry=paths`), renders
   (`/v1/images`, 1x + 2x) and image fills into the same layout (`rest-<section>/`). No token is
   available in this environment and `api.figma.com` / `www.figma.com` are blocked by its network
   proxy, so this route is covered by unit tests only (`tests/figma-rest.test.ts`), not by a live run.
3. **Real pastes**: any `fixtures/figma-paste/*.html` or `*.figcapture.json` (the paste-debug
   capture format) is picked up automatically and rendered through `parseFigmaClipboard`; a
   `<name>.png` / `<name>@2x.png` next to it (Figma's export of the same frame) turns it into a
   scored case. Both folders are gitignored.

What the JSON routes cannot carry that a real paste has: `derivedTextData` (Figma's glyph outlines,
so text goes through Motion's font path instead of the outline path), vector network blobs,
derived symbol data, variable / style references. Text scores here therefore measure the font
fallback; real pastes measure the outline path.

## Running it

```bash
npm run fidelity                                   # figma truth (if present) + svg + pastes
node scripts/figma-fidelity.mjs --only svg         # svg suite only (needs nothing)
node scripts/figma-fidelity.mjs --filter text/ --scale 1,2
node scripts/figma-fidelity.mjs --peer ../other-checkout --out bench/results/figma-fidelity-peer
node scripts/figma-fidelity/sheet.mjs --group blend  # contact sheets truth | motion | diff
```

It starts its own Vite dev server on a free port (5391+), drives the app in headless Chromium,
imports each case into an empty project, renders the composition at 1x and 2x through the real
renderer (`syncRaster`), and writes `bench/results/figma-fidelity/report.html` (truth / Motion / diff
per case, worst first) and `report.json`. A full run (210 cases × 2 scales) takes about a minute.
`--peer` copies another checkout's `src/` next to the results and measures that build with the same
harness (used below for the paints / effects / text branch in progress).

Rebuilding the Figma side: run `00-prelude.js` + a part through `use_figma` (the parts are
idempotent per section; the prelude is also stored in the file's shared plugin data `fid/prelude`,
so a part can run as `new AsyncFunction(prelude + part)`), then `90-dump.js` per section with
`SECTION = '<name>'` and `CHUNKS = [0..3]`, `[4..7]`, … until all chunks are out, then
`node scripts/figma-fidelity/unpack.mjs <dir with the returned pngs>`.

## Scores (Nov 12 2026)

Columns: `main` = this branch's importer and renderer (02e8fa9); `wip` = the paints / effects /
text branch being built in parallel, measured with `--peer` at the time of writing.

| group | cases | main mean | main worst | wip mean | wip worst |
|---|---|---|---|---|---|
| shader-effect (applied ones) | 2 | 39.6 | 18.7 | 39.6 | 18.7 |
| combo | 3 | 68.5 | 54.7 | 62.3 | 48.6 |
| effect | 18 | 80.5 | 41.1 | 80.8 | 2.2 |
| blend | 20 | 81.5 | 65.7 | 71.2 | 48.7 |
| paint | 24 | 83.4 | 13.1 | 97.9 | 66.1 |
| mask | 5 | 84.8 | 66.1 | 97.6 | 88.9 |
| svg | 29 | 87.5 | 40.6 | 87.6 | 40.6 |
| shader-fill (applied ones) | 1 | 88.0 | 88.0 | 88.0 | 88.0 |
| text | 23 | 89.6 | 73.6 | 89.9 | 72.6 |
| vector | 8 | 94.3 | 63.8 | 99.1 | 98.4 |
| instance | 6 | 96.5 | 95.7 | 98.4 | 97.5 |
| stroke | 15 | 97.4 | 90.8 | 98.4 | 90.8 |
| shape | 16 | 97.5 | 71.2 | 99.3 | 95.2 |
| bool | 5 | 98.4 | 92.3 | 98.4 | 92.3 |
| **all figma frames** | 146 | **87.6** | | **89.6** | |

Already at the noise floor on main: solid / linear / radial gradients (incl. stop alpha, elliptic,
off-center, multiple fills), corner radius incl. per-corner and smoothing, arcs, donut, star, lines,
rotation, flips, booleans, even-odd / nonzero / nested holes, curves, open networks, normal /
multiply / screen / lighten / linear-dodge blend, group opacity, alpha masks, instances, SVG path
syntax, arcs, transforms, viewBox / preserveAspectRatio, fill rules, opacity stacking, random paths.

## Biggest mismatches (main), with diagnosis

Ranked by score; the wip column says whether the parallel branch already fixes it.

| # | case(s) | score main / wip | diagnosis |
|---|---|---|---|
| 1 | paint/image-tile | 13.1 / 100 | `imageScaleMode: TILE` + `scale` (scalingFactor) ignored: the rect becomes an image layer stretched over the box (`topImageAsset` never reads the scale mode). |
| 2 | shader-effect/Crayon sketch, Midpoint mirror, shader-fill/Waveform gradient, combo/brand* | 18.7, 60.5, 88, 54.7–57.3 / same | `SHADER` paints and effects are dropped by the converter: no shader runtime is wired into import yet. Shader fill renders as nothing (the overlay rect disappears), shader effects render the unprocessed layer. |
| 3 | effect/noise-duo, noise-multi, noise-mono | 41.1, 46.4, 57.1 / **2.2, 8.2, 22.5** | main: NOISE dropped. wip renders noise but far too strong: Figma's grain is ~1 px at 1x for noiseSize 1.5–3 (pixel autocorrelation ≈0 beyond lag 1) and sparse — duo at density 0.5 changes 33% of pixels and keeps the gradient visible, mono (white 35%, density 0.6) 14.5%, multi (density 0.8, opacity 0.6) 23%. wip replaces the whole surface with the two duo colors, ignores multitone `opacity` (90% of pixels change by > 24), and doubles mono (30%). Density / opacity mapping and grain size need recalibrating. |
| 4 | paint/image-rotated | 56.7 / 98.3 | Image paint `rotation` (90°) ignored. |
| 5 | paint/angular, angular-rotated, diamond | 61.7, 60.0, 76.4 / 99.9 | `GRADIENT_ANGULAR` and `GRADIENT_DIAMOND` are approximated as radial ("no renderer equivalent" in convert.ts). |
| 6 | paint/fill-blend-multiply | 63.2 / 100 | Per-paint `blendMode` ignored: the MULTIPLY solid on top of the gradient is drawn normally and hides it. |
| 7 | paint/image-filters | 63.4 / 66.1 | main: `paintFilter` ignored. wip applies it with the wrong curves: with exposure .3, contrast .4, saturation −.6, temperature .5, tint .3, highlights −.4, shadows .5 Figma goes mean luminance .49 → .73, luminance std .23 → .155 and saturation .75 → .21; wip gives .56, .28 (contrast up instead of down: highlights / shadows not applied, contrast too strong) and .54 (saturation −.6 far too weak); exposure too weak. |
| 8 | vector/network-regions | 63.8 / 99.9 | Per-region fills of a vector network (`vectorData.styleOverrideTable` + `styleID` on fill geometry) ignored; the node-level fills are empty, so nothing is filled. |
| 9 | paint/image-crop, image-opacity-over-solid | 65.3, 65.3 / 98.8, 99.3 | `CROP` (`imageTransform`) ignored; an image paint above a solid turns the rect into an image layer, dropping the solid underneath and the image paint's 50% opacity. |
| 10 | blend/color-burn, linear-burn, difference, soft-light, saturation, color-dodge, overlay, hue, exclusion, luminosity, color, hard-light | 65.7–76.8 / **48.7–59.1** | main: only NORMAL, MULTIPLY, SCREEN, LINEAR_DODGE, DARKEN, LIGHTEN are mapped, the other 12 modes draw as normal. wip regresses: every layer with one of these modes is drawn on an opaque black rectangle the size of its bounds and the mode still isn't applied — the isolation buffer is composited without its alpha and without the blend. |
| 11 | blend/darken | 84.2 / 84.2 | Darken leaves a black box around the ellipse: `min(src, dst)` is applied to the transparent (0,0,0,0) pixels of the layer's quad as well; it needs to be weighted by coverage (`dst + (min − dst)·αsrc`). |
| 12 | mask/vector, mask/luminance | 66.1, 69.7 / 99.7, 99.9 | `maskType` ignored: a VECTOR (outline) mask uses the mask's alpha (30% → content faded to 30%), a LUMINANCE mask uses alpha (opaque gradient → no fade). |
| 13 | effect/layer-blur, progressive-blur, background-blur, progressive-background-blur, glass, drop shadows | 67.8, 68.7, 87.5, 82.8, 90.9, 78–97 / 94.9, 91.9, **84.8, 82.9, 91.6**, 99.9 | main drops all effects. wip adds shadows, inner shadow, layer and progressive layer blur (good), but background blur (normal and progressive) and glass still render nothing: the frosted panel is just its 25% white fill. |
| 14 | text/* (every frame with text, plus the pattern under all effect / shader frames) | −2…−4 per frame / same | **Baseline 0.07 em too high**: measured at 2x, 36 px text sits 2.5 px too high, 200 px text 14 px, 22 px with 40 px line height 1.5 px. Auto line height is mapped to 1.2 while Figma uses the font's hhea metrics (Inter: ascender 0.96875, descender 0.2421875 → 1.21 em) and places the first baseline at half-leading + ascender. Horizontal advances match exactly (single-line bounding boxes identical to the pixel at 2x). |
| 15 | text/variable-font-weight, italic-serif, auto-resize | 73.6, 81.1 / 72.6, 82.3 | Only Inter is bundled: Roboto Flex, Playfair Display, Source Serif 4 and JetBrains Mono fall back to system fonts, and because `textAutoResize: WIDTH_AND_HEIGHT` is not honored, the fallback (wider) text wraps inside Figma's measured box ("Roboto Flex Thin" → two lines). Auto-width text must never wrap. (Real pastes can use `derivedTextData` outlines instead; the wip branch does.) |

More mismatches, smaller but certain (both builds unless noted):

- **Text features missing**: underline / strikethrough, paragraph spacing, truncation with ellipsis
  + max lines, lists (bullets, numbers, indent), TITLE case and SMALL_CAPS, justified alignment;
  vertical alignment (main; fixed in wip); styled runs (main; wip renders them but lays out mixed
  sizes on different lines than Figma).
- **Line breaking**: 24 px Inter at a 352 px box breaks one word earlier than Figma in all four
  alignments although advances match, so the fit test is stricter than Figma's (trailing space
  counted, or no epsilon on the width compare).
- **Strokes**: text strokes are not rendered (white text with a black outside stroke is invisible);
  per-side stroke weights, multiple stroke paints, gradient strokes and dashes on rectangles /
  ellipses are ignored on main (fixed in wip); outside strokes on rectangles get round outer
  corners instead of miter.
- **Nested clipping**: a rotated clipping frame inside a clipping frame (`shape/nested-clip`) lets
  its child spill outside both clips.
- **Image sampling**: Figma upsamples small image fills with nearest-neighbour (blocky edges in the
  truth at 1x and 2x); Motion filters bilinearly. Costs ~1–4 points on every image case.
- **Frame image fill** (`shape/frame-radius-clip-image`, 71.2 / 99): image fills on frames become a
  gray placeholder on main.

## SVG import, biggest mismatches

| case | score | diagnosis |
|---|---|---|
| svg/image-data-uri | 40.6 | `<image>` is not imported (data URI or otherwise). |
| svg/masks | 43.3 | `mask` (luminance, `maskContentUnits`) ignored: masked content draws unmasked. |
| svg/clip-paths | 45.1 | `clip-path` ignored entirely (circle, `objectBoundingBox` polygon, text clip, clip on a clip). |
| svg/nested-svg | 68.7 | A nested `<svg>`'s `viewBox` / `preserveAspectRatio` / `overflow` are ignored: its content is drawn at user units (tiny). |
| svg/pattern | 70.2 | `pattern` fills unsupported (shape left unfilled). |
| svg/css-styles | 71.9 | Only simple class selectors work: `#id`, compound (`rect.c`), child combinator (`g.k > circle`) and `!important` are ignored; class `stroke-dasharray` ignored. |
| svg/linear-gradients | 73.7 | `spreadMethod` reflect / repeat ignored (pad), `href` gradient inheritance with its own `gradientTransform` not applied. |
| svg/radial-gradients | 79.5 | Focal point (`fx` / `fy`) and `spreadMethod="repeat"` ignored. |
| svg/use-defs-symbol | 88.5 | `<use>` of a `<symbol>` with `viewBox` ignores the use's `width` / `height` (symbol drawn at 10×10 user units). |
| svg/filters | 91.2 | `feGaussianBlur` / `feDropShadow` ignored. |
| svg/colors | 93.4 | Named colors beyond the basic set (`cornflowerblue`, `rebeccapurple`) and `transparent` + stroke fail. |
| svg/stroke-scaling | 94.0 | `vector-effect: non-scaling-stroke` and `paint-order: stroke` ignored. |
| svg/dashes-caps-joins | 95.8 | `stroke-dasharray` / `dashoffset` ignored (solid lines). |
| svg/text | 95.6 | `tspan` fill / weight / style ignored, per-glyph `x` / `y` lists ignored. |
| svg/markers | 98.8 | Markers (`marker-start/mid/end`) not drawn. |

## Caveats

- Figma renders are what Figma exports (`exportAsync` PNG, same engine as the canvas). Motion
  renders on SwiftShader in this container; differences between GPUs are below the noise floor.
- The JSON routes rebuild kiwi field names by hand (`rest.ts`). A wrong mapping there would show up
  as a converter failure; the group-transform quirk and `POLYGON` → `REGULAR_POLYGON` were found
  and fixed that way. Real pastes in `fixtures/figma-paste/` are the check on that.
- Scores are not comparable across runs with different `--scale` or a different truth export.
