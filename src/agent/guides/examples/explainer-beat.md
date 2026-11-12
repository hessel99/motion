# Example: Explainer beat, problem to solution with a match transition
> tags: explainer, explain, how it works, steps, problem, solution, story, beat, icons, onboarding, flat, illustration, product, app, saas

## Brief
"One explainer beat: messy notes everywhere (problem) become one tidy secure app (solution). Friendly flat style, 6 s, with a caption for each half."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 6, "background": "#FEF6E4"},
    "layers": [
      {"key": "notes", "staggerChildren": 0.07, "staggerOrder": "center-out", "children": [
        {"key": "n1", "type": "rect", "x": 640, "y": 360, "w": 170, "h": 200, "radius": 12, "fill": "#F582AE", "rotation": -12, "enter": {"t": 0.2, "from": {"scale": 0, "rotation": -40}, "ease": "Back Out"}, "expr": {"rotation": "value + 3*Math.sin(time*2*Math.PI/1.5)"}},
        {"key": "n2", "type": "rect", "x": 860, "y": 300, "w": 170, "h": 200, "radius": 12, "fill": "#8BD3DD", "rotation": 8, "enter": {"t": 0.2, "from": {"scale": 0, "rotation": 40}, "ease": "Back Out"}, "expr": {"rotation": "value - 3*Math.sin(time*2*Math.PI/1.5)"}},
        {"key": "n3", "type": "rect", "x": 1080, "y": 380, "w": 170, "h": 200, "radius": 12, "fill": "#FFD803", "rotation": -6, "enter": {"t": 0.2, "from": {"scale": 0, "rotation": -30}, "ease": "Back Out"}, "expr": {"rotation": "value + 3*Math.sin(time*2*Math.PI/1.2)"}},
        {"key": "n4", "type": "rect", "x": 760, "y": 560, "w": 170, "h": 200, "radius": 12, "fill": "#8BD3DD", "rotation": 14, "enter": {"t": 0.2, "from": {"scale": 0, "rotation": 50}, "ease": "Back Out"}, "expr": {"rotation": "value - 3*Math.sin(time*2*Math.PI/1.2)"}},
        {"key": "n5", "type": "rect", "x": 990, "y": 580, "w": 170, "h": 200, "radius": 12, "fill": "#F582AE", "rotation": -16, "enter": {"t": 0.2, "from": {"scale": 0, "rotation": -50}, "ease": "Back Out"}, "expr": {"rotation": "value + 3*Math.sin(time*2*Math.PI/1.5)"}}
      ]},
      {"key": "cap1", "text": "Notes everywhere?", "fontSize": 64, "fontWeight": 800, "align": "center", "center": [960, 900], "fill": "#172C66",
       "enter": {"t": 0.6, "from": {"opacity": 0, "dy": 30}}, "exit": {"t": 3.05, "duration": 0.3, "to": {"opacity": 0, "dy": -20}}},
      {"key": "phone", "type": "rect", "x": 830, "y": 260, "w": 260, "h": 520, "radius": 40, "fill": "#172C66",
       "enter": {"t": 2.9, "duration": 0.7, "from": {"opacity": 0, "scale": 40}, "ease": "Back Out"}},
      {"key": "screen", "type": "rect", "x": 850, "y": 300, "w": 220, "h": 440, "radius": 26, "fill": "#8BD3DD",
       "enter": {"t": 3.05, "duration": 0.6, "from": {"opacity": 0, "scale": 60}, "ease": "Back Out"}},
      {"key": "lock", "shape": "lucide:shield-check", "x": 905, "y": 450, "w": 110, "h": 110, "stroke": "#172C66",
       "drawOn": {"t": 3.5, "duration": 0.6, "ease": "Cubic Out"}},
      {"key": "cap2", "text": "One safe place.", "fontSize": 64, "fontWeight": 800, "align": "center", "center": [960, 900], "fill": "#172C66",
       "enter": {"t": 3.45, "from": {"opacity": 0, "dy": 30}}}
    ]}},
  {"tool": "animate", "args": {"tracks": [
    {"id": "<n1>", "prop": "position", "merge": true, "keyframes": [{"t": 2.5, "v": [725, 460], "ease": "Expo In"}, {"t": 3.0, "v": [960, 520]}]},
    {"id": "<n2>", "prop": "position", "merge": true, "keyframes": [{"t": 2.55, "v": [945, 400], "ease": "Expo In"}, {"t": 3.05, "v": [960, 520]}]},
    {"id": "<n3>", "prop": "position", "merge": true, "keyframes": [{"t": 2.6, "v": [1165, 480], "ease": "Expo In"}, {"t": 3.1, "v": [960, 520]}]},
    {"id": "<n4>", "prop": "position", "merge": true, "keyframes": [{"t": 2.5, "v": [845, 660], "ease": "Expo In"}, {"t": 3.0, "v": [960, 520]}]},
    {"id": "<n5>", "prop": "position", "merge": true, "keyframes": [{"t": 2.55, "v": [1075, 680], "ease": "Expo In"}, {"t": 3.05, "v": [960, 520]}]},
    {"id": "<n1>", "prop": "scale", "keyframes": [{"t": 0.2, "v": 0, "ease": "Back Out"}, {"t": 0.8, "v": 100}, {"t": 2.6, "v": 100, "ease": "Expo In"}, {"t": 3.0, "v": 0}]},
    {"id": "<n2>", "prop": "scale", "keyframes": [{"t": 0.27, "v": 0, "ease": "Back Out"}, {"t": 0.87, "v": 100}, {"t": 2.65, "v": 100, "ease": "Expo In"}, {"t": 3.05, "v": 0}]},
    {"id": "<n3>", "prop": "scale", "keyframes": [{"t": 0.34, "v": 0, "ease": "Back Out"}, {"t": 0.94, "v": 100}, {"t": 2.7, "v": 100, "ease": "Expo In"}, {"t": 3.1, "v": 0}]},
    {"id": "<n4>", "prop": "scale", "keyframes": [{"t": 0.2, "v": 0, "ease": "Back Out"}, {"t": 0.8, "v": 100}, {"t": 2.6, "v": 100, "ease": "Expo In"}, {"t": 3.0, "v": 0}]},
    {"id": "<n5>", "prop": "scale", "keyframes": [{"t": 0.27, "v": 0, "ease": "Back Out"}, {"t": 0.87, "v": 100}, {"t": 2.65, "v": 100, "ease": "Expo In"}, {"t": 3.1, "v": 0}]}
  ]}},
  {"tool": "build_scene", "args": {"layers": [
    {"key": "phone", "expr": {"scale": "value + [2*Math.sin(time*2*Math.PI/2), 2*Math.sin(time*2*Math.PI/2)]"}},
    {"key": "screen", "expr": {"scale": "value + [2*Math.sin(time*2*Math.PI/2), 2*Math.sin(time*2*Math.PI/2)]"}}
  ]}}
]
```

## Why it works
- Two states, one idea each, linked by a match transition: the messy notes fly INTO the place where the phone appears (Expo In, staggered 0.05 s) and the phone springs out of that point. Cause and effect, not a cut.
- The problem jitters (a small rotation wobble per note, different periods), the solution is calm: the motion itself tells the story.
- Captions hand over cleanly: the first exits (0.3 s, up) before the second enters at the same spot.
- Flat explainer palette (pink, teal, yellow on cream, navy ink), Back Out pops for the playful half, a shield icon that draws itself as the payoff, then a 2% breathing pulse in the hold.
