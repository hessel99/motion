# Example: Logo sting, one dot splits into the four parts of the mark
> tags: logo, sting, reveal, brand, mark, wordmark, dot, split, divide, multiply, symmetric, grid, modules, parts, tech, app, snappy, transformation, become

## Brief
"Logo sting for Tessel, a team workspace app: the mark is four rounded squares in a 2×2 grid (one of them coral), the wordmark tessel next to it. Bright and snappy, light background, about 5 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 5, "background": "#F5F7FB"},
    "layers": [
      {"key": "mark", "name": "Mark", "children": [
        {"key": "q1", "name": "Tile TL", "type": "rect", "center": [720, 480], "w": 104, "h": 104, "radius": 30, "fill": "#1E293B",
         "animate": {"scale": [{"t": 0.25, "v": 0, "ease": "spring Bouncy"}, {"t": 0.7, "v": 40, "ease": "Expo Out"}, {"t": 0.8, "v": 40, "ease": "Expo Out"}, {"t": 1.18, "v": 100}],
                     "position": [{"t": 0.8, "v": [780, 540], "ease": "Expo Out"}, {"t": 1.18, "v": [720, 480]}]}},
        {"key": "q2", "name": "Tile TR", "type": "rect", "center": [840, 480], "w": 104, "h": 104, "radius": 30, "fill": "#1E293B",
         "animate": {"opacity": [{"t": 0.87, "v": 0, "interp": "hold"}, {"t": 0.88, "v": 100}], "scale": [{"t": 0.88, "v": 40, "ease": "Expo Out"}, {"t": 1.26, "v": 100}],
                     "position": [{"t": 0.88, "v": [780, 540], "ease": "Expo Out"}, {"t": 1.26, "v": [840, 480]}]}},
        {"key": "q3", "name": "Tile BR", "type": "rect", "center": [840, 600], "w": 104, "h": 104, "radius": 30, "fill": "#FB7185",
         "animate": {"opacity": [{"t": 0.95, "v": 0, "interp": "hold"}, {"t": 0.96, "v": 100}], "scale": [{"t": 0.96, "v": 40, "ease": "Expo Out"}, {"t": 1.46, "v": 100}],
                     "position": [{"t": 0.96, "v": [780, 540], "ease": "Expo Out"}, {"t": 1.46, "v": [840, 600]}]}},
        {"key": "q4", "name": "Tile BL", "type": "rect", "center": [720, 600], "w": 104, "h": 104, "radius": 30, "fill": "#1E293B",
         "animate": {"opacity": [{"t": 1.03, "v": 0, "interp": "hold"}, {"t": 1.04, "v": 100}], "scale": [{"t": 1.04, "v": 40, "ease": "Expo Out"}, {"t": 1.34, "v": 100}],
                     "position": [{"t": 1.04, "v": [780, 540], "ease": "Expo Out"}, {"t": 1.34, "v": [720, 600]}]}}
      ]},
      {"key": "word", "name": "Wordmark", "text": "tessel", "fontSize": 150, "fontWeight": 700, "tracking": -5, "x": 930, "y": 448, "fill": "#1E293B",
       "textAnim": {"by": "char", "start": 1.85, "duration": 0.38, "stagger": 0.045, "ease": "Expo Out", "from": {"opacity": 0, "dx": -34}}}
    ]}},
  {"tool": "secondary_motion", "args": {"ids": ["<q1>", "<q2>", "<q3>", "<q4>"], "props": ["position"], "overshoot": 0.08, "settle": 0.25}}
]
```

## Why it works
- A transformation, not an appearance: one dot pops in (spring), holds a beat, then splits (the other tiles wait hidden under it at 40% and switch on with a hold key as they leave) into the four tiles that fly to their places (Expo Out 0.3-0.5 s, 0.08 s apart, clockwise; the coral accent travels longest) with an 8% overshoot. The mark is visibly *made of* one thing.
- Move-hold-move: pop (0.25-0.7 s), a 0.1 s hold, split; each arrival snaps and settles, then everything is dead still.
- The wordmark is its own beat ~0.45 s after the last tile lands: letters slide 34 px out of the mark's side with a 0.045 s stagger, same Expo Out family.
- 0.25 s lead-in, lockup done by ~2.5 s, a 2.5 s still hold; one accent colour on one tile.
