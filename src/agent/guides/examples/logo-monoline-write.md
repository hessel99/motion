# Example: Elegant logo sting, a monoline mark writes itself, then a brush-stroke mask writes the wordmark
> tags: logo, sting, reveal, elegant, calm, script, monoline, handwriting, signature, write, write-on, draw, draw-on, stroke, line, pen, florist, craft, mask, path, brush

## Brief
"Logo sting for Fernway, a florist: a monoline leaf drawn in one continuous line, the wordmark fernway in an italic serif next to it. Cream background, deep green ink, calm, about 5.5 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 5.5, "background": "#FBF7EE"},
    "layers": [
      {"key": "leaf", "name": "Leaf line", "type": "path",
       "d": "M640 660 C660 600 700 540 760 490 C800 456 850 432 900 424 C890 500 850 570 790 610 C740 642 690 650 660 640 C700 600 740 560 790 520",
       "stroke": "#1F4D3A", "strokeWidth": 9, "fill": "#00000000",
       "drawOn": {"t": 0.25, "duration": 1.9, "ease": "Sine In Out"},
       "animate": {"rotation": [{"t": 1.9, "v": 0, "ease": "Sine In Out"}, {"t": 2.25, "v": -3, "ease": "Back Out"}, {"t": 2.75, "v": 0}]}},
      {"key": "bud", "name": "Bud", "type": "ellipse", "center": [912, 412], "w": 22, "h": 22, "fill": "#C2410C",
       "enter": {"t": 2.0, "duration": 0.45, "from": {"scale": 0}, "ease": "spring Gentle"}},
      {"key": "script", "name": "Wordmark write", "children": [
        {"key": "brush", "name": "Brush mask", "type": "path", "d": "M930 560 C1040 520 1140 600 1250 556 C1360 512 1460 600 1580 556",
         "stroke": "#FFFFFF", "strokeWidth": 200, "fill": "#00000000", "mask": true,
         "drawOn": {"t": 2.35, "duration": 1.05, "ease": "Sine In Out"}},
        {"key": "word", "name": "Wordmark", "text": "fernway", "font": "serif", "italic": true, "fontSize": 140, "fontWeight": 400, "x": 950, "y": 470, "fill": "#1F4D3A"}
      ]},
      {"key": "swash", "name": "Swash", "type": "path", "d": "M990 660 C1100 676 1260 676 1380 650", "stroke": "#C2410C", "strokeWidth": 4, "fill": "#00000000",
       "drawOn": {"t": 3.05, "duration": 0.6, "ease": "Sine Out"}}
    ]}}
]
```

## Why it works
- The idea is writing: the mark is one continuous line drawn at an even pen speed (one 1.9 s Sine In Out draw-on, no stops), and it ends with a flourish: a 3° tilt that settles with Back Out as the pen lifts, then the bud blooms on with a gentle spring.
- The wordmark is written too, not faded: a thick stroke (200 px, wider than the letters) used as a mask draws along a wavy path through the word, so the reveal follows the pen's direction. Any `draw_on` path works as a path-following mask (`mask: true` on the stroke, the content above it in the same group).
- Calm timing from the study: 0.25 s lead-in, one long soft move per beat (Sine In Out 1-2 s), the wordmark 0.2 s after the mark's last stroke, lockup complete by 3.4 s, a 2 s still hold.
- Two inks on cream: terracotta only on the bud and the closing swash under the word (the final small move), a 4 px line against the 9 px mark.
