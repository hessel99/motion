# Example: UI micro-interaction, button press to success check
> tags: ui, micro-interaction, button, press, pay, checkout, submit, success, check, confirm, loading, app, product

## Brief
"A 'Pay now' button gets pressed and turns into a success check. 2-3 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 2.4, "background": "#0F172A"},
    "layers": [
      {"key": "button", "type": "rect", "x": 760, "y": 490, "w": 400, "h": 100, "radius": 50, "fill": "#2563EB",
       "animate": {
         "scale": [{"t": 0.6, "v": 100, "ease": "Quad Out"}, {"t": 0.7, "v": 94, "ease": "spring Quick"}, {"t": 1.1, "v": 100}],
         "size": [{"t": 0.75, "v": [400, 100], "ease": "Cubic In Out"}, {"t": 1.1, "v": [100, 100]}],
         "fill": [{"t": 0.75, "v": "#2563EB", "ease": "Cubic In Out"}, {"t": 1.05, "v": "#16A34A"}]}},
      {"key": "label", "text": "Pay now", "fontSize": 40, "fontWeight": 600, "align": "center", "center": [960, 540], "fill": "#FFFFFF",
       "animate": {"opacity": [{"t": 0.7, "v": 100, "ease": "Ease In"}, {"t": 0.82, "v": 0}], "scale": [{"t": 0.7, "v": 100, "ease": "Cubic In"}, {"t": 0.82, "v": 90}]}},
      {"key": "check", "shape": "check", "x": 935, "y": 515, "w": 50, "h": 50, "stroke": "#FFFFFF", "strokeWidth": 8, "fill": "#00000000",
       "drawOn": {"t": 1.12, "duration": 0.3, "ease": "Cubic Out"}},
      {"key": "ring", "type": "ellipse", "x": 900, "y": 480, "w": 120, "h": 120, "stroke": "#16A34A", "strokeWidth": 4, "fill": "#00000000",
       "animate": {"scale": [{"t": 1.15, "v": 100, "ease": "Expo Out"}, {"t": 1.7, "v": 170}], "opacity": [{"t": 1.15, "v": 0, "ease": "Ease Out"}, {"t": 1.25, "v": 80, "ease": "Ease In"}, {"t": 1.7, "v": 0}]}},
      {"key": "done", "text": "Payment sent", "fontSize": 34, "fontWeight": 500, "align": "center", "center": [960, 660], "fill": "#E2E8F0",
       "enter": {"t": 1.35, "from": {"opacity": 0, "dy": 14}}}
    ]}}
]
```

## Why it works
- The button rests 0.6 s first so "Pay now" can be read, then three clear states with overlap: press (0.1 s dip + spring release), morph (the pill shrinks to a circle as it turns green, 0.35 s), confirm (check draws on in 0.3 s, a ring ripples out once).
- Every duration is in the micro range; nothing waits for anything to fully stop.
- The label exits fast and small (Cubic In, 0.12 s) so it never fights the shape change.
- A caption names the result and stays ~1 s: readable before the end.
