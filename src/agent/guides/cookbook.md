# Cookbook
> Worked recipes with exact tool calls: logo reveal, kinetic quote, UI micro-interaction, 3-beat explainer, chart build, seamless loop, title sequence. Plus how to use the planned higher-level tools.

Conventions: 1920x1080 comp, center (960, 540). `add_layer` x/y/w/h is the box (top-left + size); the anchor is the box center, so `position` = (x + w/2, y + h/2). `<name>` = the id returned by an earlier `add_layer`. Keys: `{t, v, ease}`; the ease belongs to the segment that starts at that key.

## Logo reveal (mark + wordmark, 2.5 s, playful-to-corporate)
1. `set_composition` { duration: 4, background: "#0F172A" }
2. Shapes (final poses):
   - `add_layer` { type: "ellipse", name: "Mark dot", x: 760, y: 440, w: 200, h: 200, fill: "#2563EB" }
   - `add_layer` { type: "rect", name: "Mark bar", x: 700, y: 520, w: 320, h: 40, radius: 20, fill: "#14B8A6" }
   - `add_layer` { type: "text", name: "Wordmark", x: 1000, y: 470, w: 640, h: 140, fill: "#F8FAFC", text: { content: "Northwind", fontSize: 112, fontWeight: 800, letterSpacing: -3, align: "left", lineHeight: 1.1 } }
3. Motion in one call (lead = dot, follow = bar, then wordmark):
   `animate` { tracks: [
   { id: <dot>, prop: "scale", keyframes: [{ t: 0.2, v: 0, ease: "spring Bouncy" }, { t: 0.9, v: 100 }] },
   { id: <bar>, prop: "scale", keyframes: [{ t: 0.45, v: [0, 100], ease: "Expo Out" }, { t: 0.95, v: [100, 100] }] },
   { id: <bar>, prop: "rotation", keyframes: [{ t: 0.45, v: -12, ease: "Back Out" }, { t: 1.0, v: 0 }] },
   { id: <wordmark>, prop: "position", keyframes: [{ t: 0.8, v: [1360, 580], ease: "Expo Out" }, { t: 1.4, v: [1320, 540] }] },
   { id: <wordmark>, prop: "opacity", keyframes: [{ t: 0.8, v: 0, ease: "Ease Out" }, { t: 1.1, v: 100 }] } ] }
4. Anticipation on the dot (optional): merge a squash: `set_keyframes` { id: <dot>, prop: "scale", merge: true, keyframes: [{ t: 0.9, v: [100, 100], ease: "Sine In Out" }, { t: 1.0, v: [108, 92], ease: "Sine Out" }, { t: 1.15, v: [100, 100] }] }
5. Check: `contact_sheet` { frames: 8, start: 0, end: 2 } → dot pops first, bar sweeps, wordmark lands last, all at rest by 1.5 s.

## Kinetic quote (6 s, kinetic-type)
1. `set_composition` { duration: 6, background: "#0E0E0E" }; `set_markers` { add: [{ t: 0.2, label: "make" }, { t: 1.2, label: "simple" }, { t: 2.6, label: "bold" }] }
2. Words as separate text layers stacked at the center line:
   - `add_layer` { type: "text", name: "W1 Make it", x: 160, y: 420, w: 1600, h: 240, fill: "#F5F5F0", text: { content: "MAKE IT", fontSize: 200, fontWeight: 900, letterSpacing: -8, align: "center", lineHeight: 1 } }
   - same for "W2 Simple" (content "SIMPLE.", fill "#FF3D2E") and "W3 Bold" (content "BOLD.", fontSize 300).
3. Swaps (each word enters on its marker, exits as the next enters, 0.05 s overlap):
   `animate` { tracks: [
   { id: <w1>, prop: "position", keyframes: [{ t: 0.2, v: [960, 640], ease: "Expo Out" }, { t: 0.5, v: [960, 540], ease: "Expo In" }, { t: 1.15, v: [960, 540] }, { t: 1.35, v: [960, 440] }] },
   { id: <w1>, prop: "opacity", keyframes: [{ t: 0.2, v: 0 }, { t: 0.35, v: 100 }, { t: 1.2, v: 100 }, { t: 1.35, v: 0 }] },
   { id: <w2>, prop: "position", keyframes: [{ t: 1.2, v: [960, 640], ease: "Expo Out" }, { t: 1.5, v: [960, 540], ease: "Expo In" }, { t: 2.55, v: [960, 540] }, { t: 2.75, v: [960, 440] }] },
   { id: <w2>, prop: "opacity", keyframes: [{ t: 1.2, v: 0 }, { t: 1.35, v: 100 }, { t: 2.6, v: 100 }, { t: 2.75, v: 0 }] },
   { id: <w3>, prop: "scale", keyframes: [{ t: 2.6, v: 140, ease: "Expo Out" }, { t: 2.95, v: 100 }] },
   { id: <w3>, prop: "opacity", keyframes: [{ t: 2.6, v: 0, interp: "hold" }, { t: 2.62, v: 100 }] } ] }
4. Background inversion on "bold": a full-frame rect behind everything: `add_layer` { type: "rect", name: "Flash", x: 0, y: 0, w: 1920, h: 1080, fill: "#F5F5F0", opacity: 0 }, move it to the bottom of the stack if needed, then `animate` its opacity with `interp: "hold"` keys at 2.6 (100) and set W3's fill to "#0E0E0E".
5. Final line alternative: one text layer + `set_text_animation` { ids: [<line>], preset: "Fade up", start: 3.4, stagger: 0.1 }.

## UI micro-interaction (button press + success, 1.2 s)
1. `add_layer` { type: "rect", name: "Button", x: 760, y: 490, w: 400, h: 100, radius: 50, fill: "#2563EB" } and a label text { content: "Pay now", fontSize: 40, fontWeight: 600, align: "center" } with `parent: <button>` (coords relative to the button box: x 0, y 24, w 400, h 52).
2. Press (anticipation + release with overshoot):
   `animate` { tracks: [
   { id: <button>, prop: "scale", keyframes: [{ t: 0.2, v: 100, ease: "Quad Out" }, { t: 0.3, v: 94, ease: "spring Quick" }, { t: 0.7, v: 100 }] },
   { id: <button>, prop: "fill", keyframes: [{ t: 0.3, v: "#2563EB", ease: "Cubic In Out" }, { t: 0.55, v: "#16A34A" }] },
   { id: <button>, prop: "size", keyframes: [{ t: 0.35, v: [400, 100], ease: "Cubic In Out" }, { t: 0.65, v: [100, 100] }] } ]
   } (size shrinks to a circle; keep the radius 50).
3. Label out, check mark in: label opacity 100 → 0 (0.3 → 0.4 s, `Ease In`); a check path `add_layer` { type: "path", name: "Check", x: 935, y: 515, w: 50, h: 50, d: "M4 26 L20 42 L46 8", stroke: "#FFFFFF", strokeWidth: 8, fill: "#00000000" } with `animate` trimEnd 0 → 100 from 0.6 to 0.9 s (`Cubic Out`).
4. Durations stay in the micro range (press 0.1 s, release 0.3–0.4 s).

## 3-beat explainer (12 s, flat-explainer) — the director flow
1. `get_guide` { name: "styles/flat-explainer" }; `propose_storyboard` { title: "How Ledger works", style: "Flat illustration explainer", styleReason: "friendly, explains steps", duration: 12, beats: [
   { name: "Problem", start: 0, end: 4, description: "Docs pile up, frown face, caption", style: "Back Out pops, 0.1 s stagger" },
   { name: "Solution", start: 4, end: 8, description: "Docs fly on arcs into the phone; screen turns teal + check", style: "Cubic In Out arcs, connector draw" },
   { name: "Outcome", start: 8, end: 12, description: "Arrow to smile + coins; logo + CTA", style: "spring Quick, hold 1.5 s" } ] } → wait for approval if asked.
2. `set_composition` { duration: 12.4 }; `set_markers` { add: [{ t: 0, label: "Problem" }, { t: 4, label: "Solution" }, { t: 8, label: "Outcome" }] }
3. For each beat: `update_progress` { beat: 1, status: "active" } → `add_layer` the beat's objects (group them: `group_layers` { ids, name: "Beat 1" }) → `animate` entrances with stagger (`apply_preset` { ids, preset: "Pop", t: 0.3, stagger: 0.1 } is fine for icons) → exits/transition at the end of the beat (group opacity or a pan of the group) → `update_progress` { beat: 1, status: "done", note: "3 docs + face" }.
4. Critique: `contact_sheet` { frames: 12, start: 0, end: 12 }; fix ≤ 2 rounds.

## Chart build (bar chart, data-viz)
1. Baseline at y 900, bars 120 px wide, value 1 = 4 px. For each value v at index i: `add_layer` { type: "rect", name: "Bar Q<i>", x: 480 + i*240, y: 900 - 4v, w: 120, h: 4v, radius: 6, fill: "#2563EB" }.
2. Anchor each bar at its bottom center so it grows from the baseline: `update_layer` { id, props: { anchor: [60, 4v], position: [540 + i*240, 900] } }.
3. Axis: `add_layer` { type: "rect", name: "Axis", x: 420, y: 900, w: 1080, h: 2, fill: "#94A3B8" } with scale x 0 → 100 from a left anchor (anchor [0, 1], position [420, 901]), 0–0.6 s `Quart Out`.
4. Growth: `animate` { stagger: 0.08, tracks: [ { id: <bar1>, prop: "scale", keyframes: [{ t: 0.5, v: [100, 0], ease: "Cubic In Out" }, { t: 1.3, v: [100, 100] }] }, … same for every bar … ] }
5. Value labels: text layers above each bar, `apply_preset` { ids: labels, preset: "Fade in", t: 1.1, duration: 0.3, stagger: 0.08 }.
6. Insight: at 2.5 s grey the others (`animate` fill → "#94A3B8") and keep the key bar blue; pop a callout text with `apply_preset` "Pop".

## Seamless loop (4 s ambient, liquid-blob)
1. `set_composition` { duration: 4 }
2. Three circles (`add_layer` ellipse 360–520 px, fills `#FF5F6D`, `#7F5AF0`, `#3DA9FC`, opacity 85).
3. Breathing with keys that start = end: `animate` { tracks: [ { id: <b1>, prop: "scale", keyframes: [{ t: 0, v: [100, 100], ease: "Sine In Out" }, { t: 1, v: [108, 94], ease: "Sine In Out" }, { t: 2, v: [96, 106], ease: "Sine In Out" }, { t: 3, v: [104, 98], ease: "Sine In Out" }, { t: 4, v: [100, 100] }] } ] }
4. Drift with periods that divide 4 s: `set_expression` { ids: [<b1>, <b2>, <b3>], prop: "position", expr: "value + [30*Math.sin((time/4 + index*0.33)*2*Math.PI), 20*Math.cos((time/2 + index*0.2)*2*Math.PI)]" }
5. Rotation: `set_expression` { ids: [...], prop: "rotation", expr: "time*360/4" } (Linear, one turn per loop) or `value + 8*Math.sin(time*2*Math.PI/4)`.
6. Check the seam: `contact_sheet` { times: [0, 2, 3.98, 4] } — the first and last frames must match.

## Title sequence (10 s, editorial / minimal-luxury)
1. `set_composition` { duration: 10, background: "#0C0C0C" }; markers at 0, 3.5, 7.
2. Beat 1 (0–3.5 s): hairline path `add_layer` { type: "path", name: "Hairline", x: 560, y: 539, w: 800, h: 2, d: "M0 1 L800 1", stroke: "#C8A96A", strokeWidth: 2, fill: "#00000000" }; `animate` trimEnd 0 → 100 (0.2 → 1.4 s, `Sine In Out`). Kicker text (Inter 400, 22 px, letterSpacing 6) with `set_text_animation` { preset: "Fade up", by: "char", stagger: 0.06, start: 0.9 }.
3. Beat 2 (3.5–7 s): title in `serif` 300, 140 px, centered: opacity 0 → 100 over 1.2 s + scale 104 → 100 (`Sine Out`) from 3.6 s; credits line fades in 0.4 s after; hairline trimStart 0 → 100 (erases) 3.5–4.3 s.
4. Beat 3 (7–10 s): glint rect (white, 40 x 300, rotation 20, opacity 0) sweeps x 600 → 1320 with opacity 0 → 60 → 0 over 0.8 s (`Sine In Out`) across the title; everything fades out 9–10 s (`Sine In`).
5. Critique for luxury: nothing moves faster than 0.8 s; holds ≥ 2 s; ≤ 3 elements visible.

## Planned higher-level tools (use them by name when they appear in your tool list)
Another workstream is adding these; until they exist use the recipes above. When present they replace many low-level calls:
- `build_scene`: a whole beat in one declarative spec (layers, groups, shapes, text, keys, eases, stagger) with stable ids — use it for blocking + timing a beat in one call, then refine.
- `shape_library`: icons (Lucide), blobs, arrows, badges, sparkles as path layers — instead of hand-writing SVG `d`.
- `draw_on`: trim-path reveals for strokes/outlines (replaces the trimEnd recipe).
- `morph`: animate one shape into another (blob merges, icon transforms, logo resolves).
- `arrange`: grid / radial / along-path layouts with safe-area margins.
- `choreograph`: stagger patterns (center-out, random, wave, by distance) over many layers.
- `secondary_motion`: follow-through, overshoot, drag and settle on children/attached parts.
- `loop`: make a set of layers loop seamlessly over a period (replaces loop expressions).
- `camera_rig`: parallax planes + camera null for dolly/truck moves (3D-ish parallax style).
- `type_layout` / `split_text`: responsive text boxes, split text into word/char layers for kinetic type.
- `inspect_motion`: velocity/overshoot/holds per layer — use in the critique step to verify easing and spacing numbers.
- `check_frame`: off-canvas, overlaps, contrast, safe areas at given times — run at each beat's hold time.
- `timeline_summary`: a compact score of the piece — use before critiquing and in the final summary.
- `preview_strip`: cheaper frame strips than many screenshots — the default "look" tool during building.
