# Agent tools cookbook

Short, copy-ready examples of the high-level agent tools (source: `src/agent/tools-*.ts`). For the system prompt /
guides. All coordinates are composition px (top-left origin), times in seconds, every call is one undo step.

## build_scene — a whole scene in one call

```json
{ "comp": { "duration": 6, "background": "#0b0b14" },
  "markers": [{ "t": 0.5, "label": "logo" }, { "t": 2, "label": "title" }],
  "layers": [
    { "key": "bg", "x": 0, "y": 0, "w": 1920, "h": 1080, "fill": { "type": "radial", "stops": ["#2a1b4d", "#0b0b14"] } },
    { "key": "blob", "shape": "blob", "shapeOptions": { "seed": 4 }, "center": [960, 480], "w": 420, "h": 400,
      "fill": { "type": "linear", "stops": ["#ff4d8d", "#ffb347"], "angle": 45 },
      "enter": { "t": 0.5, "duration": 0.9, "ease": "spring:0.4", "from": { "scale": 0 } } },
    { "key": "icon", "shape": "lucide:rocket", "center": [960, 480], "w": 180, "h": 180, "fill": "#ffffff",
      "drawOn": { "t": 0.9, "duration": 1 } },
    { "key": "title", "text": "Liftoff", "fontSize": 120, "fontWeight": 800, "align": "center", "center": [960, 820],
      "fill": "#ffffff", "textAnim": { "preset": "Pop letters", "start": 2 } },
    { "key": "cards", "staggerChildren": 0.08, "staggerOrder": "center-out", "children": [
      { "key": "c1", "x": 360, "y": 900, "w": 300, "h": 80, "radius": 16, "fill": "#ffffff22", "enter": { "t": 2.4, "from": { "opacity": 0, "dy": 40 } } },
      { "key": "c2", "x": 810, "y": 900, "w": 300, "h": 80, "radius": 16, "fill": "#ffffff22", "enter": { "t": 2.4, "from": { "opacity": 0, "dy": 40 } } },
      { "key": "c3", "x": 1260, "y": 900, "w": 300, "h": 80, "radius": 16, "fill": "#ffffff22", "enter": { "t": 2.4, "from": { "opacity": 0, "dy": 40 } } } ] },
    { "key": "spark", "type": "star", "points": 4, "inner": 0.3, "center": [1300, 300], "w": 60, "h": 60, "fill": "#ffd166",
      "expr": { "rotation": "time*60", "scale": "100 + sin(time*4)*10" } }
  ] }
```

- Refine: send only what changes, same keys: `{"layers":[{"key":"title","fill":"#ffd166"}]}`. A spec with
  `animate`/`enter`/`exit`/`drawOn` replaces that layer's keyframes; without them the animation is kept.
- `animate` is raw keys: `{"rotation":[{"t":0,"v":-8,"ease":"Back Out"},{"t":0.5,"v":0}]}`.
- `exit`: `{"t": 5.8, "duration": 0.4, "to": {"opacity": 0, "dy": -30}}` (t = when it ENDS).
- Stagger across keys: `"stagger": [{"keys": ["a","b","c"], "step": 0.06, "order": "random", "seed": 3}]`.
- Path from absolute coordinates (box fitted): `{"key":"swoosh","d":"M200 700 C 600 500 1200 900 1700 650","stroke":"#fff","strokeWidth":6,"drawOn":true}`.
- Precomp: `{"key":"badge","type":"precomp","comp":{"duration":2},"children":[...]}`; mask: `"mask": true` on the lower sibling.
- `prune: true` deletes earlier keyed layers that are no longer in the spec.

## Shapes

```json
// boolean of existing layers (Figma-style; operands deleted unless keep)
{ "op": "subtract", "operands": [{ "layer": "<square id>" }, { "layer": "<circle id>" }], "fill": "#ff5500" }
// boolean of library shapes
{ "op": "union", "operands": [{ "shape": "circle", "x": 0, "y": 0, "w": 120, "h": 120 }, { "shape": "square", "x": 60, "y": 60, "w": 120, "h": 120 }] }
```
- `shape_library {"shape":"badge","options":{"points":18},"center":[960,540],"w":240,"h":240,"fill":"#ffd166"}`; no `shape` lists them.
  Line art (check, wave, spiral, burst, chevron, underline, lucide:*) is stroked; `fill` sets the stroke color.
- `draw_on {"ids":["<group>"],"t":0.2,"duration":0.8,"stagger":0.1,"from":"start"}` — groups draw path by path; fills fade in.
- `morph {"id":"<blob>","to":{"shape":"heart"},"t":1.5,"duration":0.6,"ease":"Expo In Out","back":0.5}` — also `to: {"layer": id}` or `{"d": "..."}`.

## Choreography

- `arrange {"ids":["<group>"],"layout":"grid","cols":4,"gap":24,"center":[960,540]}`; `radial` + `radius` + `rotate:true`;
  `path` + `d`; `scatter` + `seed`; add `"transition":{"t":1,"duration":0.6,"stagger":0.05}` to animate into place.
- `choreograph {"ids":["<group>"],"pattern":"center-out","step":0.06}` · `{"pattern":"wave","axis":"x","spread":0.5}` ·
  `{"pattern":"distance","point":[960,540],"spread":0.4}` (shockwave) · `{"overlap":0.6}` (tight cascade).
- `secondary_motion {"ids":[...],"overshoot":0.15,"oscillations":2,"anticipation":0.1}` — on existing position/scale/rotation keys.
- `loop {"ids":[...],"mode":"cycle","fitComp":true}` — closing key + `loopOut('cycle')`; `pingpong` for back-and-forth.
- `camera_rig {"layers":[{"id":"<bg>","depth":0.3},{"id":"<mid>","depth":1},{"id":"<fg>","depth":1.8},{"id":"<title>","depth":0}],"keys":[{"t":0,"x":0,"zoom":100},{"t":4,"x":300,"zoom":115,"ease":"Sine In Out"}]}`.
- `align_to_beats {"ids":[...],"mode":"sequence"}` (layer i on marker i) · `{"mode":"end","bpm":120}` · `{"mode":"keys","tolerance":0.2}`.

## Typography

- `type_layout {"key":"hero","blocks":[{"text":"New season","role":"eyebrow"},{"text":"Make it move","role":"headline"},{"text":"Motion design for everyone","role":"subline"}],"align":"center","w":1400,"baseSize":120}` —
  returns ids `hero/0..2`; same key again updates; `fit` shrinks one-line blocks to the width; `tracking` in em.
- `split_text {"id":"<title>","by":"char","preset":"Slide up","t":0.5,"stagger":0.04}` → per-letter layers; then
  `choreograph` / `secondary_motion` / `animate` on the returned ids.
- `set_text_animation {"ids":["<text>"],"preset":"Fade up","by":"word","from":{"dy":60,"rotation":-8},"ease":"Back Out","order":"center"}` — no extra layers.
- `text_on_path {"text":"AROUND THE WORLD","fontSize":48,"d":"M560 540 A 400 400 0 0 1 1360 540","align":"center"}`.

## Analysis (read-only)

- `inspect_motion {"ids":[...]}` → `position: 0.2s→0.8s Δ412px ease-out peak 1320px/s@0.31s acc 9000 overshoot 8% | hold 0.8s–1.4s`
  plus warnings (hard stops, sub-2-frame moves, too fast). Use it to verify "snappy", "overshoot", "settles".
- `check_frame {"times":[1,2.5,4]}` → off-canvas %, safe areas, `low contrast 2.1:1`, overlaps, tiny/huge; "ok" when clean.
- `timeline_summary {}` → beats, who moves when, `density |▁▃▇█▅▂ ... |`, idle stretches, stillness at the end.

## Preview

- `preview_strip {"start":0,"end":1.2,"frames":6,"layout":"row"}` — one move as a filmstrip.
- `preview_strip {"layout":"onion","start":0.2,"end":0.8,"frames":8}` — spacing / arcs / easing in one picture.
- `preview_strip {"layout":"grid","frames":16}` — the whole piece.
- `preview_video {"start":0,"end":3,"fps":12}` → `saved image/gif: /tmp/motion-previews/....gif` (a path to hand on).

## Concept: animate what the artwork IS

Look first, then rig the parts like the real thing (a door opens instead of popping in).
`inspect_artwork {"id":"<logo>"}` → an image with numbered parts + JSON hints; compound paths show as `1.1`, `1.2`.

House logo with a door (one imported compound path):
```json
// 1. look: "1.2: tall rectangle, sits in the hole of #1.1 (house-like pentagon (pointed roof) with a hole)"
{ "id": "<logo>" }                                                     // inspect_artwork
// 2. cut it into parts at the same place → group "Logo" with "Part 1 (largest)" (house), "Part 2 (smallest)" (door)
{ "id": "<logo>" }                                                     // split_shape
// 3. the door swings in on its left hinge; the doorway lights up behind it
{ "ids": ["<door>"], "kind": "hinge", "t0": 0.4, "duration": 1.2, "options": { "edge": "left", "light": true } }
```
`hinge` moves the pivot to the edge, foreshortens (scaleX), tapers path doors in perspective (`swing: "in"` free edge
shrinks, `"out"` grows), shades the fill; `mode: "open-close"` + `hold`, `"close"` slams with a rebound.

Leaf grows from its stem (pivot at the base, spring overshoot, small sway):
`rig {"ids":["<leaf>"],"kind":"grow","options":{"from":"bottom"},"t0":0.6,"duration":0.9}` — for a leaf hanging
from a branch use `"from":"top"`; bars in a chart: several ids + `"stagger":0.06`.

Chat bubble pops with its tail (tail grows out of the bubble after it lands):
```json
{ "id": "<bubble path>" }                                                                   // split_shape → body + tail
{ "id": "<tail>", "at": { "layerEdgeOf": "<body>" } }                                      // set_pivot on the body's edge
{ "ids": ["<body>"], "kind": "grow", "options": { "from": "bottom-left" }, "t0": 0.2, "duration": 0.6 }
{ "ids": ["<tail>"], "kind": "grow", "options": { "from": "top", "pivot": "keep" }, "t0": 0.45, "duration": 0.4, "intensity": 0.8 }
```

Rocket launches (crouch, rumble, stretch, accelerate off-screen, trail echoes):
`rig {"ids":["<rocket>"],"kind":"launch","options":{"direction":"up-right"},"t0":1,"duration":1.2,"intensity":0.7}` —
the flame can `beat`/`pulse` with `loop` while it waits: `rig {"ids":["<flame>"],"kind":"pulse","options":{"period":0.3}}`.

More: `swing` (sign on a nail, `pivot:"top"`), `unfold` (map panels, `direction:"right"`), `orbit`
(`center:[960,540]` or `around:"<planet>"`, `tilt:0.6`, `orient`, `loop`), `blink` (eye, `loop`, `every:3`), `beat` (heart),
`liquid-fill` (cup / battery, `level:0.7`), `draw-then-fill` (line icons), `land` (`from:"left"`), `type-on`
(`cursor:true`), `assemble` (scattered parts fly together, `order:"outside-in"`), `reveal-from`
(`ids:["<wordmark>"]`, `options:{"from":"<mark>"}`: the wordmark slides out from behind the mark under a mask).
Entrance rigs reverse with `mode:"out"`. Everything is plain keys afterwards: `get_animation`, `retime`, `set_easing` work on it.

## A typical build loop

1. `build_scene` with all layers + entrances (keys!), 2. `choreograph` / `secondary_motion` for feel,
3. `timeline_summary` + `inspect_motion` to check pacing and eases, `check_frame` for layout,
4. `preview_strip` (grid or onion) to see it, 5. refine with `build_scene` on the same keys.
