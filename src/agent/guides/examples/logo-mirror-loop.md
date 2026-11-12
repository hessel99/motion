# Example: Loopable logo sting, the stack builds, holds, then the build plays back out to the first frame
> tags: logo, sting, loop, loopable, seamless, exit, mirror, reverse, build out, outro, bumper, data, stack, layers, platform, grow, wordmark, behind, mask, tech

## Brief
"A loopable logo bumper for Stackwise, a data platform: the mark is three stacked rounded bars (widest at the bottom), the wordmark stackwise to the right. It should build, hold, and leave the screen empty again so it can loop. Dark blue, about 4.8 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 4.8, "background": "#0B1324"},
    "layers": [
      {"key": "mark", "name": "Mark", "children": [
        {"key": "b1", "name": "Bar bottom", "type": "rect", "x": 640, "y": 590, "w": 240, "h": 48, "radius": 24, "fill": "#38BDF8"},
        {"key": "b2", "name": "Bar middle", "type": "rect", "x": 640, "y": 516, "w": 190, "h": 48, "radius": 24, "fill": "#7DD3FC"},
        {"key": "b3", "name": "Bar top", "type": "rect", "x": 640, "y": 442, "w": 130, "h": 48, "radius": 24, "fill": "#E0F2FE"}
      ]},
      {"key": "word", "name": "Wordmark", "text": "stackwise", "fontSize": 132, "fontWeight": 700, "tracking": -4, "x": 920, "y": 452, "fill": "#E0F2FE"}
    ]}},
  {"tool": "rig", "args": {"kind": "grow", "ids": ["<b1>", "<b2>", "<b3>"], "t0": 0.25, "duration": 0.75, "intensity": 0.35, "options": {"from": "left", "stagger": 0.1}}},
  {"tool": "rig", "args": {"kind": "reveal-from", "ids": ["<word>"], "t0": 1.45, "duration": 0.6, "intensity": 0.5, "options": {"from": "<mark>"}}},
  {"tool": "rig", "args": {"kind": "reveal-from", "ids": ["<word>"], "t0": 3.55, "duration": 0.42, "mode": "out", "intensity": 0.5, "options": {"from": "<mark>", "nudge": false}}},
  {"tool": "rig", "args": {"kind": "grow", "ids": ["<b3>", "<b2>", "<b1>"], "t0": 3.8, "duration": 0.5, "intensity": 0.2, "mode": "out", "options": {"from": "left", "stagger": 0.07}}}
]
```

## Why it works
- The idea comes from the mark: a stack builds bar by bar from its left edge (rig grow, springy, 0.1 s apart, bottom first), then the wordmark slides out from behind it under a mask.
- Build 0.25-2.05 s, a 1.5 s still hold of the exact lockup, then the exit mirrors the build: the same rigs with `mode: "out"`, in reverse order (wordmark first, top bar first), at ~0.7× the duration with accelerating eases, ending on the empty first frame, so the bumper loops cleanly.
- Exits are faster than entrances and ease in; the hold is long enough to read (≥ 3 identical frames on a 12-frame sheet).
- Three tints of one blue: the colour steps also say "layers".
