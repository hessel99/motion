# Example: Logo sting, a giant crop of the mark pulls back to reveal it, then the wordmark slides out
> tags: logo, sting, reveal, brand, mark, wordmark, camera, zoom, pull back, zoom out, crop, detail, scale, bold, editorial, confident, frame-detail, behind, mask

## Brief
"Logo sting for Apexa, an outdoor brand: the mark is a bold mountain triangle with a small sun dot at its top-right, the wordmark apexa next to it. Confident and editorial, deep green background, about 5 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 5, "background": "#0E2A22"},
    "layers": [
      {"key": "mark", "name": "Mark", "children": [
        {"key": "peak", "name": "Mountain", "type": "polygon", "points": 3, "x": 640, "y": 410, "w": 260, "h": 230, "fill": "#F1EFE7"},
        {"key": "sun", "name": "Sun", "type": "ellipse", "center": [858, 420], "w": 62, "h": 62, "fill": "#F59E0B",
         "animate": {"position": [{"t": 1.35, "v": [858, 456], "ease": "Expo Out"}, {"t": 1.85, "v": [858, 420]}]}}
      ]},
      {"key": "word", "name": "Wordmark", "text": "apexa", "fontSize": 156, "fontWeight": 800, "tracking": -5, "x": 950, "y": 430, "fill": "#F1EFE7"}
    ]}},
  {"tool": "rig", "args": {"kind": "frame-detail", "ids": ["<mark>"], "t0": 0.25, "duration": 1.35, "options": {"at": "<sun>", "zoom": 9, "tilt": 5, "ease": "Expo Out"}}},
  {"tool": "rig", "args": {"kind": "reveal-from", "ids": ["<word>"], "t0": 1.95, "duration": 0.6, "intensity": 0.5, "options": {"from": "<mark>"}}}
]
```

## Why it works
- Camera & scale from the mark's own detail: the piece opens on a 9× crop of the sun dot against the mountain (an abstract, ambiguous frame), then pulls back 1.35 s with Expo Out and a 5° tilt that settles: the viewer recognises the mark only in the last third of the build.
- `rig frame-detail` pivots every listed layer on the same point (here the sun's centre), so a group or several layers zoom like one camera; never pull back from the dead centre.
- The mark then does its own small action: the sun rises 36 px into place as the camera settles (the literal action, one step after the transformation).
- The wordmark is its own beat 0.1 s after the sun lands: it slides out from behind the mark's right edge under a mask (`rig reveal-from`), and the mark gives a small push back as it emerges: the final move is a small one.
- One family (Expo Out arrivals), two colours plus the accent dot; lockup complete by ~2.6 s, a 2.4 s still hold.
