# Example: UI micro-interaction, a toggle switching on
> tags: ui, micro-interaction, toggle, switch, button, app, interface, product, feedback, state change, ios, settings

## Brief
"A settings toggle switching from off to on, for a product video. 1.5 s, light UI."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 1.6, "background": "#F2F2F7"},
    "layers": [
      {"key": "card", "type": "rect", "x": 560, "y": 400, "w": 800, "h": 280, "radius": 36, "fill": "#FFFFFF"},
      {"key": "label", "text": "Wi-Fi", "fontSize": 64, "fontWeight": 600, "x": 640, "y": 500, "fill": "#1C1C1E"},
      {"key": "track", "type": "rect", "x": 1040, "y": 490, "w": 200, "h": 104, "radius": 52, "fill": "#D1D1D6",
       "animate": {"fill": [{"t": 0.35, "v": "#D1D1D6", "ease": "Cubic In Out"}, {"t": 0.6, "v": "#34C759"}]}},
      {"key": "knob", "type": "ellipse", "x": 1048, "y": 498, "w": 88, "h": 88, "fill": "#FFFFFF",
       "animate": {
         "position": [{"t": 0.3, "v": [1092, 542], "ease": "spring:0.3"}, {"t": 0.75, "v": [1196, 542]}],
         "scale": [{"t": 0.2, "v": [100, 100], "ease": "Quad Out"}, {"t": 0.3, "v": [92, 92], "ease": "Cubic In Out"}, {"t": 0.45, "v": [112, 92], "ease": "spring Quick"}, {"t": 0.85, "v": [100, 100]}]}},
      {"key": "status", "text": "On", "fontSize": 36, "fontWeight": 500, "x": 640, "y": 580, "fill": "#34C759",
       "enter": {"t": 0.55, "from": {"opacity": 0, "dy": 10}}}
    ]}}
]
```

## Why it works
- Micro timing: press 0.1 s (scale 92 = anticipation), travel 0.45 s on a light spring, stretch 112/92 in motion and back to round: UI-sized squash, not cartoon.
- The colour change follows the knob (starts 0.05 s after it), fill animated directly (no muddy opacity cross-fade).
- A secondary status label confirms the state, later and quieter (0.2 s after the knob arrives).
- Short comp: the result holds ~0.7 s, enough to read "On".
