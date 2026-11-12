# Example: Playful logo sting, the o's are eyes that look around, blink, then the camera pulls back to the word
> tags: logo, sting, playful, friendly, fun, character, eyes, look, blink, letters, o, counters, wordmark, personify, literal, kids, app, camera, pull back

## Brief
"Logo sting for look, a kids' reading app: the wordmark look where the two o's are eyes with pupils. Friendly and funny, yellow background, about 5 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 5, "background": "#FDE047"},
    "layers": [
      {"key": "logo", "name": "Logo", "children": [
        {"key": "l", "name": "l", "text": "l", "fontSize": 240, "fontWeight": 800, "x": 690, "y": 380, "fill": "#1C1917"},
        {"key": "o1", "name": "Eye left", "type": "ellipse", "center": [860, 582], "w": 134, "h": 134, "stroke": "#1C1917", "strokeWidth": 30, "fill": "#FFFFFF"},
        {"key": "o2", "name": "Eye right", "type": "ellipse", "center": [1016, 582], "w": 134, "h": 134, "stroke": "#1C1917", "strokeWidth": 30, "fill": "#FFFFFF"},
        {"key": "p1", "name": "Pupil left", "type": "ellipse", "center": [860, 582], "w": 40, "h": 40, "fill": "#1C1917",
         "animate": {"position": [{"t": 0.3, "v": [860, 582], "ease": "Cubic In Out"}, {"t": 0.55, "v": [841, 578]}, {"t": 0.95, "v": [841, 578], "ease": "Cubic In Out"}, {"t": 1.2, "v": [879, 576]}, {"t": 2.3, "v": [879, 576], "ease": "Back Out"}, {"t": 2.6, "v": [860, 582]}]}},
        {"key": "p2", "name": "Pupil right", "type": "ellipse", "center": [1016, 582], "w": 40, "h": 40, "fill": "#1C1917",
         "animate": {"position": [{"t": 0.33, "v": [1016, 582], "ease": "Cubic In Out"}, {"t": 0.58, "v": [997, 578]}, {"t": 0.98, "v": [997, 578], "ease": "Cubic In Out"}, {"t": 1.23, "v": [1035, 576]}, {"t": 2.33, "v": [1035, 576], "ease": "Back Out"}, {"t": 2.63, "v": [1016, 582]}]}},
        {"key": "k", "name": "k", "text": "k", "fontSize": 240, "fontWeight": 800, "x": 1098, "y": 380, "fill": "#1C1917"}
      ]}
    ]}},
  {"tool": "rig", "args": {"kind": "blink", "ids": ["<o1>", "<o2>", "<p1>", "<p2>"], "t0": 1.35, "options": {"count": 2}}},
  {"tool": "rig", "args": {"kind": "frame-detail", "ids": ["<logo>"], "t0": 1.75, "duration": 0.8, "options": {"at": [938, 580], "zoom": 4.5, "tilt": 0, "ease": "Expo Out"}}}
]
```

## Why it works
- Literal action / personification: the two o's are eyes, so the logo *looks* before it is read. It opens close on the eyes (4.5×, the l and k cropped away), the pupils glance left, hold, glance right (move-hold-move, 0.25 s moves, 0.4 s holds), blink twice, then the camera pulls back (Expo Out 0.8 s) and the eyes are letters of the word.
- The final move is small and meaningful: the pupils return to the centre with a Back Out snap (they look at you), ±19 px, landing as the pull-back settles at ~2.6 s; then a 2.4 s still hold.
- The pull-back is `rig frame-detail` on the logo group with the zoom held until 1.75 s (keys hold before their first time), centred between the eyes.
- Playful but disciplined: one accent (yellow), ink and white, no extra decoration; Cubic In Out for glances, Back Out for the punch, Expo Out for the camera.
