# Example: Logo sting, the petals spin open into a bloom, then the wordmark rises letter by letter
> tags: logo, sting, reveal, brand, mark, wordmark, flower, bloom, petals, radial, pinwheel, spin, rotate, open, grow, beauty, wellness, warm, spring

## Brief
"Logo sting for Petalia, a wellness brand: a six-petal flower mark (pink and orange petals that overlap) with a small centre, the wordmark petalia next to it. Warm and fresh, cream background, about 5 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 5, "background": "#FFF7ED"},
    "layers": [
      {"key": "bloom", "name": "Bloom", "children": [
        {"key": "p1", "name": "Petal 1", "type": "ellipse", "w": 74, "h": 150, "anchor": "bottom", "position": [820, 534], "rotation": 0, "fill": "#F472B6", "blend": "multiply", "enter": {"t": 0.3, "duration": 0.5, "from": {"scale": 0}, "ease": "Expo Out"}},
        {"key": "p2", "name": "Petal 2", "type": "ellipse", "w": 74, "h": 150, "anchor": "bottom", "position": [820, 534], "rotation": 60, "fill": "#FB923C", "blend": "multiply", "enter": {"t": 0.34, "duration": 0.6, "from": {"scale": 0}, "ease": "Expo Out"}},
        {"key": "p3", "name": "Petal 3", "type": "ellipse", "w": 74, "h": 150, "anchor": "bottom", "position": [820, 534], "rotation": 120, "fill": "#F472B6", "blend": "multiply", "enter": {"t": 0.38, "duration": 0.7, "from": {"scale": 0}, "ease": "Expo Out"}},
        {"key": "p4", "name": "Petal 4", "type": "ellipse", "w": 74, "h": 150, "anchor": "bottom", "position": [820, 534], "rotation": 180, "fill": "#FB923C", "blend": "multiply", "enter": {"t": 0.42, "duration": 0.5, "from": {"scale": 0}, "ease": "Expo Out"}},
        {"key": "p5", "name": "Petal 5", "type": "ellipse", "w": 74, "h": 150, "anchor": "bottom", "position": [820, 534], "rotation": 240, "fill": "#F472B6", "blend": "multiply", "enter": {"t": 0.46, "duration": 0.6, "from": {"scale": 0}, "ease": "Expo Out"}},
        {"key": "p6", "name": "Petal 6", "type": "ellipse", "w": 74, "h": 150, "anchor": "bottom", "position": [820, 534], "rotation": 300, "fill": "#FB923C", "blend": "multiply", "enter": {"t": 0.5, "duration": 0.7, "from": {"scale": 0}, "ease": "Expo Out"}},
        {"key": "core", "name": "Centre", "type": "ellipse", "center": [820, 534], "w": 46, "h": 46, "fill": "#9D174D",
         "enter": {"t": 0.95, "duration": 0.5, "from": {"scale": 0}, "ease": "spring Bouncy"}}
      ]},
      {"key": "word", "name": "Wordmark", "text": "petalia", "fontSize": 140, "fontWeight": 700, "tracking": -3, "x": 1010, "y": 452, "fill": "#831843",
       "textAnim": {"by": "char", "start": 1.75, "duration": 0.4, "stagger": 0.05, "ease": "Back Out", "from": {"opacity": 0, "dy": 50, "scale": 70}}}
    ]}},
  {"tool": "set_pivot", "args": {"id": "<bloom>", "at": [820, 534]}},
  {"tool": "animate", "args": {"tracks": [
    {"id": "<bloom>", "prop": "rotation", "keyframes": [{"t": 0.3, "v": -180, "ease": "Expo Out"}, {"t": 1.1, "v": 8, "ease": "Sine In Out"}, {"t": 1.45, "v": 0}]}
  ]}}
]
```

## Why it works
- The mark's form gives the idea: a radial flower opens the way a bloom does, turning half a revolution (−180° → +8°, Expo Out 0.8 s, then settles back to 0 with Sine In Out: a keyed overshoot, since `secondary_motion` on a group works on its children) while the petals grow out of the centre one after another (pivots at the petal bases, 0.04 s apart, 0.5/0.6/0.7 s so no two neighbours move alike).
- Pivots where the thing really moves: the group turns around the flower's centre (`set_pivot` to a comp point), each petal scales from its base (`anchor: "bottom"` at the centre), never from its own middle.
- The centre pops last with a spring (the full stop of the build); the wordmark rises letter by letter 0.5 s after the bloom settles (Back Out, 0.05 s per letter), the same springy family.
- Multiply on the overlapping petals makes the overlaps a third colour without adding one; lockup complete by ~2.5 s, then a 2.5 s still hold.
