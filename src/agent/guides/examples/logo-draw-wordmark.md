# Example: Elegant logo reveal, the line draws the mark and the wordmark slides out from behind it
> tags: logo, reveal, elegant, minimal, luxury, corporate, line, stroke, draw, draw-on, trim, wordmark, mask, behind, monogram, calm

## Brief
"Logo reveal for NOVA (a circle monogram with a slash). Calm and premium, dark background, 4 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 4, "background": "#0B0B0F"},
    "layers": [
      {"key": "ring", "type": "path", "shape": "circle", "x": 640, "y": 400, "w": 280, "h": 280, "stroke": "#E8E2D0", "strokeWidth": 6, "fill": "#00000000",
       "drawOn": {"t": 0.15, "duration": 1.1, "ease": "Sine In Out"}},
      {"key": "slash", "type": "path", "d": "M0 200 L120 0", "x": 720, "y": 440, "w": 120, "h": 200, "stroke": "#C8A96A", "strokeWidth": 8, "fill": "#00000000",
       "drawOn": {"t": 0.95, "duration": 0.5, "ease": "Expo Out"}},
      {"key": "reveal", "clip": true, "x": 940, "y": 380, "w": 560, "h": 320, "children": [
        {"key": "wordmark", "text": "NOVA", "fontSize": 150, "fontWeight": 300, "tracking": 18, "x": 0, "y": 70, "fill": "#E8E2D0",
         "enter": {"t": 1.3, "duration": 1.0, "from": {"dx": -620}, "ease": "Quart Out"}}
      ]},
      {"key": "rule", "type": "rect", "x": 960, "y": 610, "w": 360, "h": 2, "fill": "#C8A96A", "anchor": "left",
       "animate": {"scale": [{"t": 1.9, "v": [0, 100], "ease": "Sine Out"}, {"t": 2.7, "v": [100, 100]}]}},
      {"key": "kicker", "text": "STUDIO", "fontSize": 26, "fontWeight": 500, "tracking": 10, "x": 962, "y": 632, "fill": "#8A8578",
       "enter": {"t": 2.2, "duration": 0.9, "from": {"opacity": 0, "dy": 12}, "ease": "Sine Out"}}
    ]}},
  {"tool": "build_scene", "args": {"layers": [
    {"key": "ring", "expr": {"scale": "value + [1.2*Math.sin(time*2*Math.PI/4), 1.2*Math.sin(time*2*Math.PI/4)]"}}
  ]}}
]
```

## Why it works
- The idea is drawing: the ring draws itself, the slash cuts it as the ring closes (the second element starts at 75% of the first), so it reads as one gesture.
- The wordmark slides out from behind the mark inside a clipping group (a mask at the mark's edge), not a cross-fade over it.
- Calm = long Sine/Quart curves (0.8–1.1 s), no overshoot, wide tracking, gold used only on the slash and the rule (≤ 10% of the frame).
- A 1% breathing scale on the ring keeps the 1.3 s hold alive without drawing attention.
