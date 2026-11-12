# Example: Staggered feature list in a brand style (cards cascade in)
> tags: list, stagger, cards, features, items, cascade, brand, corporate, smooth, product, saas, bullet, benefits, grid

## Brief
"Show our 4 features as cards that come in one after another, in our brand (indigo #4F46E5, Inter). Title on top. 5 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 5, "background": "#F8FAFC"},
    "layers": [
      {"key": "title", "text": "Why teams switch", "fontSize": 88, "fontWeight": 800, "tracking": -2, "x": 160, "y": 150, "fill": "#0F172A",
       "enter": {"t": 0.1, "from": {"opacity": 0, "dy": 40}}},
      {"key": "accent", "type": "rect", "x": 164, "y": 270, "w": 120, "h": 8, "radius": 4, "fill": "#4F46E5", "anchor": "left",
       "animate": {"scale": [{"t": 0.35, "v": [0, 100], "ease": "Expo Out"}, {"t": 0.95, "v": [100, 100]}]}},
      {"key": "cards", "staggerChildren": 0.08, "children": [
        {"key": "c1", "type": "rect", "x": 160, "y": 380, "w": 370, "h": 440, "radius": 24, "fill": "#FFFFFF", "stroke": "#E2E8F0", "strokeWidth": 2, "enter": {"t": 0.5, "from": {"opacity": 0, "dy": 80}}},
        {"key": "c2", "type": "rect", "x": 570, "y": 380, "w": 370, "h": 440, "radius": 24, "fill": "#FFFFFF", "stroke": "#E2E8F0", "strokeWidth": 2, "enter": {"t": 0.5, "from": {"opacity": 0, "dy": 80}}},
        {"key": "c3", "type": "rect", "x": 980, "y": 380, "w": 370, "h": 440, "radius": 24, "fill": "#FFFFFF", "stroke": "#E2E8F0", "strokeWidth": 2, "enter": {"t": 0.5, "from": {"opacity": 0, "dy": 80}}},
        {"key": "c4", "type": "rect", "x": 1390, "y": 380, "w": 370, "h": 440, "radius": 24, "fill": "#4F46E5", "enter": {"t": 0.5, "from": {"opacity": 0, "dy": 80}}}
      ]},
      {"key": "icons", "staggerChildren": 0.08, "children": [
        {"key": "i1", "shape": "lucide:zap", "x": 200, "y": 420, "w": 72, "h": 72, "stroke": "#4F46E5", "enter": {"t": 0.75, "from": {"scale": 0}, "ease": "spring Quick"}},
        {"key": "i2", "shape": "lucide:shield-check", "x": 610, "y": 420, "w": 72, "h": 72, "stroke": "#4F46E5", "enter": {"t": 0.75, "from": {"scale": 0}, "ease": "spring Quick"}},
        {"key": "i3", "shape": "lucide:users", "x": 1020, "y": 420, "w": 72, "h": 72, "stroke": "#4F46E5", "enter": {"t": 0.75, "from": {"scale": 0}, "ease": "spring Quick"}},
        {"key": "i4", "shape": "lucide:sparkles", "x": 1430, "y": 420, "w": 72, "h": 72, "stroke": "#FFFFFF", "enter": {"t": 0.75, "from": {"scale": 0}, "ease": "spring Quick"}}
      ]},
      {"key": "labels", "staggerChildren": 0.08, "children": [
        {"key": "t1", "text": "Fast setup", "fontSize": 44, "fontWeight": 700, "x": 200, "y": 700, "fill": "#0F172A", "enter": {"t": 0.85, "from": {"opacity": 0, "dy": 20}}},
        {"key": "t2", "text": "Secure", "fontSize": 44, "fontWeight": 700, "x": 610, "y": 700, "fill": "#0F172A", "enter": {"t": 0.85, "from": {"opacity": 0, "dy": 20}}},
        {"key": "t3", "text": "Built for teams", "fontSize": 44, "fontWeight": 700, "x": 1020, "y": 700, "fill": "#0F172A", "enter": {"t": 0.85, "from": {"opacity": 0, "dy": 20}}},
        {"key": "t4", "text": "AI inside", "fontSize": 44, "fontWeight": 700, "x": 1430, "y": 700, "fill": "#FFFFFF", "enter": {"t": 0.85, "from": {"opacity": 0, "dy": 20}}}
      ]}
    ]}},
  {"tool": "animate", "args": {"tracks": [
    {"id": "<c4>", "prop": "scale", "keyframes": [{"t": 2.4, "v": 100, "ease": "Cubic In Out"}, {"t": 2.8, "v": 104, "ease": "Cubic In Out"}, {"t": 3.3, "v": 102}]},
    {"id": "<i4>", "prop": "rotation", "keyframes": [{"t": 2.5, "v": 0, "ease": "spring:0.4"}, {"t": 3.2, "v": 12}]}
  ]}},
  {"tool": "secondary_motion", "args": {"ids": ["<c1>", "<c2>", "<c3>", "<c4>"], "overshoot": 0.05, "segments": "first"}}
]
```

## Why it works
- Hierarchy: title first (it is read first), the accent rule wipes from its left edge, then the cards cascade left to right 0.08 s apart (total 0.24 s), then each card's icon and label follow inside it: three overlapping waves, never everything at once.
- Followers move less: cards rise 80 px, labels 20 px; icons pop with a quick spring.
- Brand: one accent colour (indigo) on the rule, icons and the highlighted card; Inter 800/700; cards on a 4-column grid with equal gutters.
- After the build, the highlight card lifts (104%) and its icon tilts: one focal change in the hold, which keeps the ending alive and says "this one".
