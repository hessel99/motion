# Figma paste fidelity

Goal: copy in Figma, paste in Motion, and every layer looks the same. This page is the inventory of
what Figma's clipboard format can express for rendering, what Motion does with each feature today, and
what is left.

- **Format**: `text/html` with a base64 `fig-kiwi` buffer: a compressed kiwi *schema* plus a compressed
  message (`nodeChanges` + `blobs`). The decoder reads whatever schema a payload ships
  (`src/import/figma/decode.ts`), so new fields never break the import; the names below are the
  schema's field and enum names. The inventory was taken from the schema embedded in real clipboard
  payloads (473 definitions in a 2025 payload). Newer payloads add enum values (e.g. effect types)
  that are matched by name.
- **Code**: decoding `decode.ts`, mapping `convert.ts`, vector networks `vectornet.ts`, entry
  point `index.ts` (`parseFigmaClipboard`, stable). Rendering: `src/render/renderer.ts` (instanced
  WebGL2), `raster.ts` (canvas rasters in the atlas), `effects.ts` + `fx.ts` (effect pipeline).
- **Tests**: `tests/figma-fidelity.test.ts` builds synthetic node trees programmatically
  (`tests/fixtures/figma-synth.ts`, our own schema subset with Figma's field names; no Figma code,
  no real designs). `tests/fixtures/figma-fidelity-scene.ts` writes a paste with one of every
  feature for a visual check (`node scripts/figma-paste-shot.mjs scene.html shot.png`).
- **Debugging real pastes**: *Import menu → Save last Figma paste for debugging…* or *Settings →
  Figma import*. One `.figcapture.json` with the clipboard HTML exactly as received plus the decoded
  node tree (`src/import/figma/capture.ts`). Developers: `MOTION_FIGMA_CAPTURE_DIR=/folder` (desktop)
  or `VITE_FIGMA_CAPTURE_DIR=/folder npm run dev` saves every paste. Captures contain the user's
  design: `*.figcapture.json` is git-ignored and must never be committed (the repo is public).
- **Warnings**: what can't be imported faithfully is collected in `design.warnings` (logged on paste).

Status: **supported** = same look as Figma (within anti-aliasing / font rasterization);
**approximated** = close, known differences listed; **missing** = not rendered (fallback named).

## Node types

| feature | status | how |
|---|---|---|
| FRAME, SECTION, SYMBOL/COMPONENT, COMPONENT_SET, INSTANCE, SLIDE, TABLE | supported | group layer with its own box (fill, stroke, radius, effects), `clipsContent` → clip |
| GROUP, frames with `resizeToFit` | supported | group without box |
| RECTANGLE / ROUNDED_RECTANGLE | supported | SDF rect (animatable size / radii); raster when it needs smoothing / dashes / per-side strokes / complex paints |
| ELLIPSE (full) | supported | SDF ellipse |
| ELLIPSE with `arcData` (arcs, donuts) | supported | Figma's `fillGeometry` |
| STAR, REGULAR_POLYGON, LINE, VECTOR | supported | Figma's `fillGeometry` / `strokeGeometry`, or the `vectorNetworkBlob` when the cached geometry is missing |
| BOOLEAN_OPERATION | supported | baked `fillGeometry` (operands not imported as layers) |
| vector regions with their own fills (`vectorData.styleOverrideTable`, `Path.styleID`) | supported | per-geometry paints |
| TEXT | supported | text layer + Figma's glyph outlines (see Text) |
| INSTANCE overrides (`symbolOverrides`, `derivedSymbolData`, `overrideKey`) | supported | applied per guid path, outer instances win |
| component properties (`componentPropAssignments` → `componentPropRefs`: text, visibility, instance swap) | supported | resolved on the instance's sublayers |
| nested instances, instance swap (`overriddenSymbolID`) | supported | depth-limited (32) |
| SLICE, WIDGET, STAMP, MEDIA, CODE_BLOCK, STICKY, SHAPE_WITH_TEXT, CONNECTOR, … | approximated | their `fillGeometry` when present, otherwise an empty group (warning) |
| auto layout | supported | only the resolved positions/sizes matter (they are in `transform` / `size`) |
| constraints, prototyping, export settings, layout grids | n/a | no rendering effect |

## Transforms, opacity, blending, masks

| feature | status | how |
|---|---|---|
| position / rotation / flips (`transform`) | supported | anchor-center transform, flips as negative scale |
| skew (non-orthogonal `transform`) | approximated | skew dropped (rare: only from scaled rotated groups) |
| layer opacity | supported | |
| group opacity | supported | isolated offscreen composite |
| layer blend modes: normal, darken, multiply, screen, lighten, linear dodge (add) | supported | GPU blend functions, zero cost |
| overlay, soft light, hard light, color dodge, color burn, linear burn, difference, exclusion, hue, saturation, color, luminosity | supported | the layer (or group) is isolated and composited with the W3C blend formulas against a copy of the backdrop (`fx.ts`) |
| PASS_THROUGH vs NORMAL on groups | supported | both draw children in place unless the group needs isolation |
| masks (`mask` / `isMask`), alpha | supported | mask texture × content |
| luminance masks (`maskType: LUMINANCE`) | supported | luminance of the mask layer |
| vector / outline masks (`maskType: OUTLINE`, `maskIsOutline`) | supported | coverage of the mask's shapes, fill opacity ignored |
| clip content | supported | nearest clipping ancestor (rounded box); nested clips: only the nearest one clips |

## Paints (fills and strokes)

| feature | status | how |
|---|---|---|
| SOLID, several stacked solids | supported | normal-blend solids flatten into one animatable color |
| paint opacity, paint visibility | supported | |
| paint blend modes (multiply, overlay, … per paint) | supported | canvas composite ops in the raster; `LINEAR_BURN` → multiply (approximated, no canvas op) |
| GRADIENT_LINEAR, GRADIENT_RADIAL | supported | in the instance shader on rects / ellipses / frames (ramp texture, no raster), raster elsewhere |
| GRADIENT_ANGULAR | supported | shader (`atan`) and canvas conic gradient; starts at +x, clockwise |
| GRADIENT_DIAMOND | supported | shader (`|dx|+|dy|`) and four linear quadrants in the raster |
| gradient stops bound to variables (`stopsVar`) | approximated | resolved stops are used (no live link) |
| IMAGE, scale mode FILL / FIT | supported | cover / contain in the box, on any shape |
| IMAGE, TILE (`scale`) | supported | repeating pattern at the tile scale |
| IMAGE, STRETCH / crop (`transform`) | supported | image unit square mapped by the inverse paint transform |
| image `rotation` (90° steps) | supported | |
| image filters (`paintFilter`: exposure, contrast, saturation (`vibrance`), temperature, tint, highlights, shadows) | approximated | per-pixel tone curves on a cached filtered copy (≤ 2048 px); Figma's exact curves are not public |
| images whose bytes are not in the clipboard | missing | grey placeholder + warning (Figma only ships bytes it has locally) |
| VIDEO | approximated | its still frame (thumbnail) when present, else placeholder |
| NOISE fill (mono / duo / multi, density, size) | supported | grain cells in the raster (deterministic per cell) |
| PATTERN fill (`sourceNodeId`, spacing) | missing | skipped with a warning; plan: rasterize the source node into a tile and fill with a repeat pattern |
| EMOJI paint | missing | skipped |
| shader paints | hook | passed to `convertShaderPaint` from `src/import/figma/shaders.ts` (shader runtime, separate work); skipped with a warning without it |
| gradient / image strokes (`strokePaints`) | supported | stroke coverage, paints inside it |
| text fills with gradients / images | supported | glyph coverage, paints inside it |

## Strokes and corners

| feature | status | how |
|---|---|---|
| stroke weight, color | supported | SDF stroke (rects / ellipses), raster coverage for paths |
| stroke align inside / center / outside | supported | SDF and raster |
| dashes (`dashPattern`) | supported | paths: Figma's outlined `strokeGeometry`; boxes: canvas dashes on the box outline |
| caps (`strokeCap`: none / round / square), joins (`strokeJoin`), `miterLimit` | supported | Figma's `strokeGeometry` for vectors; canvas line styles for boxes |
| arrow / marker caps (ARROW_LINES, TRIANGLE_FILLED, …) | supported | part of Figma's `strokeGeometry` |
| per-side stroke weights (`borderStrokeWeightsIndependent`, `border*Weight`, `border*Hidden`) | supported | side bands cut to the box (inside / center / outside) |
| variable width strokes (`variableWidthPoints`), brushes | supported | baked in `strokeGeometry` (static) |
| corner radius, per-corner radii | supported | SDF, animatable |
| corner smoothing (`cornerSmoothing`) | supported | squircle outline (arc + two cubic transitions per corner, Figma's published construction) |

## Effects

All effects run on the GPU in `src/render/fx.ts`: the layer (with its subtree) renders into its own
target and is composited with its effects. Layers without effects keep the single instanced draw.
Blur radius follows Figma/CSS: gaussian σ = radius / 2. The first effect of each type is animatable
through layer props (`shadowColor`, `shadowOffset`, `shadowBlur`, `shadowSpread`, `innerShadow*`,
`blur`, `backgroundBlur`, `noiseColor`, `noiseSize`, `noiseDensity`): timeline, graph editor,
inspector (Effects section) and the agent tools (`update_layer`, `animate`) all see them. Setting
those props on any layer adds the effect.

| feature | status | how |
|---|---|---|
| DROP_SHADOW: color, offset, radius, spread | supported | shape coverage → offset → spread (dilate / erode) → blur → under the layer |
| drop shadow knock-out, `showShadowBehindNode` | supported | shadow removed under the shape unless "show behind" |
| multiple shadows | supported | accumulated in order; the first is animatable, the rest static |
| shadow blend mode | approximated | drawn normal |
| INNER_SHADOW (offset, radius, spread, color) | supported | inverted coverage, offset, spread, blur, inside the content |
| FOREGROUND_BLUR (layer blur) | supported | separable gaussian, ½ / ¼ resolution for large radii |
| progressive layer blur (`blurOpType: PROGRESSIVE`, `startOffset`, `endOffset`, `startRadius`) | approximated | three blur levels interpolated along start → end (offsets read as box fractions) |
| BACKGROUND_BLUR | supported | backdrop copy, blurred, clipped to the layer's shape, under its fills |
| progressive background blur | approximated | same three-level scheme |
| NOISE effect (MONOTONE / DUOTONE / MULTITONE, noise size, density, opacity, colors, seed) | approximated | grain cells in layer space on top of the content, clipped to it; Figma's own random pattern differs (same statistics) |
| GRAIN (older noise) | approximated | as mono noise |
| TEXTURE effect | approximated | layer sampled through a grain-cell displacement (rough edges) |
| GLASS effect (refraction, depth, light, dispersion, frost) | approximated | frosted backdrop + refraction near the edges + light rim; parameters matched by name, best effort |
| REPEAT, SYMMETRY | missing | skipped with a warning |
| shader effects | hook | `convertShaderEffect` (shader runtime) |
| effect styles (`styleIdForEffect`) | supported | resolved values are used |

## Text

Text keeps two representations: the editable text model, and **Figma's own glyph outlines**
(`derivedTextData.glyphs` + `decorations`). While the text is unchanged since the paste (`textSig`),
the outlines are drawn: exact font (also fonts that are not installed), kerning, OpenType features,
variable axes, line breaking, lists, truncation and decorations, colored per style run. After an edit
(or for per-letter text animation) the live layout takes over.

| feature | status (outlines / live layout) |
|---|---|
| font family / style / weight, italic | supported / supported (installed or bundled fonts) |
| fonts not installed | supported / approximated (fallback font) |
| variable font axes (`fontVariations`) | supported / approximated (weight only) |
| letter spacing, line height (px / % / auto) | supported / supported |
| paragraph spacing, paragraph indent | supported / supported |
| alignment left / center / right / justified, vertical align | supported / supported |
| text case upper / lower / title | supported / supported (applied when drawn) |
| small caps | supported / approximated (canvas small-caps) |
| underline / strikethrough (`textDecoration`, per run) | supported / supported (simple style) |
| decoration style (dotted / wavy), thickness, offset | supported / approximated |
| style runs (`characterStyleIDs` + `styleOverrideTable`: font, size, color, decoration, spacing) | supported / approximated (wrapping uses the base font) |
| auto resize (width / height / fixed), truncation + `maxLines` | supported / supported |
| lists (ordered / unordered) | supported / approximated (markers, no hanging indent) |
| OpenType features (`toggledOnOTFeatures`, numeric / caps variants) | supported / approximated (stored; canvas can't set most) |
| emoji | approximated (system emoji font; outlines are skipped for such texts) |
| text stroke | missing (warning) |
| text on a path (`TEXT_PATH`) | missing |

## Variables, styles, components

Linked colors / numbers, color styles, components and instances are synced into Motion's library on
paste (`src/core/design-import.ts`, see `docs/components-and-tokens.md`). Resolved values are what
renders, so they never change the look.

## Plan / next

1. Pattern fills: rasterize `sourceNodeId`'s subtree into a tile.
2. Text stroke; text on a path.
3. Effect caching: a static subtree with static effects could reuse last frame's composite
   (hash of the region's change flags + params), so a still shadowed frame costs one textured quad.
4. Nested clip intersection (only the nearest clipping ancestor clips today).
5. Figma-exact noise / texture / glass: compare against the ground-truth screenshots of the stress
   harness and tune.
6. Shader paints / effects: the shader runtime plugs into the hooks above.
