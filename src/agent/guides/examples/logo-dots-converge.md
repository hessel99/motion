# Example: Logo sting, the dots converge and connect, then the wordmark slides out from behind the mark
> tags: logo, sting, reveal, brand, mark, wordmark, dots, network, community, social, connect, assemble, converge, mask, behind, slide out, lockup

## Brief
"Logo sting for Quorum, a community app: the mark is five dots joined by thin lines (a centre dot and four around it), the wordmark quorum to the right. Dark, confident, about 5 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 5, "background": "#0B1020"},
    "layers": [
      {"key": "mark", "name": "Mark", "enter": {"t": 1.55, "duration": 0.6, "from": {"dx": 230}, "ease": "Cubic In Out"}, "children": [
        {"key": "l1", "name": "Link NW", "type": "path", "d": "M760 540 L680 460", "stroke": "#5EEAD4", "strokeWidth": 6, "fill": "#00000000", "drawOn": {"t": 1.0, "duration": 0.3, "ease": "Expo Out"}},
        {"key": "l2", "name": "Link NE", "type": "path", "d": "M760 540 L840 460", "stroke": "#5EEAD4", "strokeWidth": 6, "fill": "#00000000", "drawOn": {"t": 1.05, "duration": 0.42, "ease": "Expo Out"}},
        {"key": "l3", "name": "Link SW", "type": "path", "d": "M760 540 L680 620", "stroke": "#5EEAD4", "strokeWidth": 6, "fill": "#00000000", "drawOn": {"t": 1.12, "duration": 0.32, "ease": "Expo Out"}},
        {"key": "l4", "name": "Link SE", "type": "path", "d": "M760 540 L840 620", "stroke": "#5EEAD4", "strokeWidth": 6, "fill": "#00000000", "drawOn": {"t": 1.16, "duration": 0.46, "ease": "Expo Out"}},
        {"key": "d1", "name": "Dot NW", "type": "ellipse", "center": [680, 460], "w": 52, "h": 52, "fill": "#F8FAFC"},
        {"key": "d2", "name": "Dot NE", "type": "ellipse", "center": [840, 460], "w": 52, "h": 52, "fill": "#F8FAFC"},
        {"key": "d3", "name": "Dot SW", "type": "ellipse", "center": [680, 620], "w": 52, "h": 52, "fill": "#F8FAFC"},
        {"key": "d4", "name": "Dot SE", "type": "ellipse", "center": [840, 620], "w": 52, "h": 52, "fill": "#F8FAFC"},
        {"key": "hub", "name": "Hub", "type": "ellipse", "center": [760, 540], "w": 84, "h": 84, "fill": "#5EEAD4"}
      ]},
      {"key": "reveal", "name": "Wordmark reveal", "children": [
        {"key": "edge", "name": "Reveal mask", "type": "rect", "x": 890, "y": 300, "w": 1030, "h": 480, "fill": "#FFFFFF", "mask": true,
         "enter": {"t": 1.55, "duration": 0.6, "from": {"dx": 230}, "ease": "Cubic In Out"}},
        {"key": "word", "name": "Wordmark", "text": "quorum", "fontSize": 150, "fontWeight": 700, "tracking": -4, "x": 910, "y": 438, "fill": "#F8FAFC",
         "enter": {"t": 1.62, "duration": 0.7, "from": {"dx": -520}, "ease": "Expo Out"}}
      ]}
    ]}},
  {"tool": "rig", "args": {"kind": "assemble", "ids": ["<d1>", "<d2>", "<d3>", "<d4>", "<hub>"], "t0": 0.25, "duration": 0.85, "intensity": 0.5, "options": {"order": "outside-in"}}},
  {"tool": "choreograph", "args": {"ids": ["<d1>", "<d2>", "<d4>", "<d3>", "<hub>"], "pattern": "sequential", "step": 0.07, "start": 0.25}}
]
```

## Why it works
- One idea from the mark: scattered dots converge (clockwise, 0.07 s apart, the hub last, Expo-like arrivals, a spring on the scale, a small turn that settles), then the links draw from the hub as they land: "people come together, then connect".
- Timing from the study's medians: 0.25 s blank lead-in, the mark's idea done by ~1.5 s, the wordmark starts ~0.4 s later as its own beat, lockup complete by ~2.3 s, then a still 2.7 s hold (three-plus identical end frames).
- The signature move of polished stings: the mark slides aside (Cubic In Out, 0.6 s) and the wordmark slides out from behind it under a mask that travels with the mark's edge, so the word comes from the mark instead of fading in on top.
- One easing family: Expo Out arrivals (links, wordmark, assemble), one smooth on-screen move, springs only on the dots' scale. Two colours plus white.
