# Example: Logo sting, blocks morph into the letters of the wordmark
> tags: logo, sting, wordmark, letters, type, morph, shapes, blocks, modular, geometric, transform, become, build, construction, architecture, bold, kinetic wordmark

## Brief
"Logo sting for LUX, a lighting studio: the logo is only the bold geometric wordmark LUX. Make the letters come from simple blocks. Dark, confident, about 4.5 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 4.5, "background": "#101014"},
    "layers": [
      {"key": "logo", "name": "Wordmark LUX", "children": [
        {"key": "b1", "name": "L", "type": "rect", "x": 760, "y": 465, "w": 110, "h": 150, "fill": "#FACC15",
         "enter": {"t": 0.25, "duration": 0.45, "from": {"dy": 150, "opacity": 0}, "ease": "Expo Out"}},
        {"key": "b2", "name": "U", "type": "rect", "x": 905, "y": 465, "w": 110, "h": 150, "fill": "#FACC15",
         "enter": {"t": 0.33, "duration": 0.5, "from": {"dy": 190, "opacity": 0}, "ease": "Expo Out"}},
        {"key": "b3", "name": "X", "type": "rect", "x": 1050, "y": 465, "w": 110, "h": 150, "fill": "#FACC15",
         "enter": {"t": 0.41, "duration": 0.4, "from": {"dy": 120, "opacity": 0}, "ease": "Expo Out"}}
      ]},
      {"key": "beam", "name": "Beam", "type": "rect", "x": 778, "y": 650, "w": 364, "h": 6, "fill": "#FACC15", "anchor": "left",
       "animate": {"scale": [{"t": 1.95, "v": [0, 100], "ease": "Expo Out"}, {"t": 2.5, "v": [100, 100]}]}}
    ]}},
  {"tool": "morph", "args": {"id": "<b1>", "to": {"d": "M0 0 H38 V112 H110 V150 H0 Z"}, "t": 1.05, "duration": 0.45, "ease": "Expo Out"}},
  {"tool": "morph", "args": {"id": "<b2>", "to": {"d": "M0 0 H38 V100 C38 108 44 114 52 114 H58 C66 114 72 108 72 100 V0 H110 V104 C110 132 88 150 60 150 H50 C22 150 0 132 0 104 Z"}, "t": 1.12, "duration": 0.45, "ease": "Expo Out"}},
  {"tool": "morph", "args": {"id": "<b3>", "to": {"d": "M0 0 H42 L55 44 L68 0 H110 L76 75 L110 150 H68 L55 106 L42 150 H0 L34 75 Z"}, "t": 1.19, "duration": 0.45, "ease": "Expo Out"}},
  {"tool": "animate", "args": {"tracks": [
    {"id": "<b1>", "prop": "fill", "keyframes": [{"t": 1.05, "v": "#FACC15", "ease": "Cubic In Out"}, {"t": 1.5, "v": "#F4F4F5"}]},
    {"id": "<b3>", "prop": "fill", "keyframes": [{"t": 1.19, "v": "#FACC15", "ease": "Cubic In Out"}, {"t": 1.64, "v": "#F4F4F5"}]},
    {"id": "<b1>", "prop": "position", "keyframes": [{"t": 1.85, "v": [815, 540], "ease": "Expo Out"}, {"t": 2.25, "v": [833, 540]}]},
    {"id": "<b3>", "prop": "position", "keyframes": [{"t": 1.85, "v": [1105, 540], "ease": "Expo Out"}, {"t": 2.25, "v": [1087, 540]}]}
  ]}},
  {"tool": "secondary_motion", "args": {"ids": ["<b1>", "<b3>"], "props": ["position"], "overshoot": 0.25, "settle": 0.3}}
]
```

## Why it works
- The wordmark IS the idea: three plain blocks rise in (Expo Out, varied distances and durations), hold for a beat as abstract shapes (the ambiguous frame), then each morphs into its letter 0.07 s after the previous one. The last third of the build resolves the shapes into a word.
- `morph` matches the structures itself (block → L, U with curves, X), so the morph keys are plain path keys with an Expo Out arrival; springs are not allowed on shape keys.
- Colour carries the transformation: the blocks are yellow; the outer letters turn white as they become type, the U keeps the accent (the "light" in the middle).
- The final moves are small: L and X close up 18 px (tighter tracking) with a little overshoot, and a thin beam draws under the word from its left edge; the lockup rests from ~2.5 s for a 2 s hold. One family: Expo Out everywhere.
