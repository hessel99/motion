# Example: Seamless ambient loop (background, blobs, gradient)
> tags: loop, seamless, looping, ambient, background, bg, blobs, gradient, liquid, calm, wallpaper, idle, endless, gif

## Brief
"A calm 4 s seamless looping background with soft colourful blobs, for a website hero."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 4, "background": "#0B1026", "name": "Hero loop"},
    "layers": [
      {"key": "b1", "type": "ellipse", "center": [700, 460], "w": 620, "h": 620, "fill": "#7F5AF0", "opacity": 70,
       "expr": {"position": "value + [60*Math.sin(time*2*Math.PI/4), 40*Math.cos(time*2*Math.PI/4)]", "scale": "value + [5*Math.sin(time*2*Math.PI/2), -5*Math.sin(time*2*Math.PI/2)]"}},
      {"key": "b2", "type": "ellipse", "center": [1220, 600], "w": 540, "h": 540, "fill": "#2CB1BC", "opacity": 70,
       "expr": {"position": "value + [-50*Math.sin(time*2*Math.PI/4 + 1.5), 50*Math.cos(time*2*Math.PI/4 + 1.5)]", "scale": "value + [-4*Math.sin(time*2*Math.PI/2), 4*Math.sin(time*2*Math.PI/2)]"}},
      {"key": "b3", "type": "ellipse", "center": [960, 330], "w": 380, "h": 380, "fill": "#FF5F6D", "opacity": 60,
       "expr": {"position": "value + [40*Math.cos(time*2*Math.PI/4 + 3), 30*Math.sin(time*2*Math.PI/4 + 3)]"}},
      {"key": "glass", "type": "rect", "x": 0, "y": 0, "w": 1920, "h": 1080, "fill": "#0B1026", "opacity": 25, "props": {"backgroundBlur": 120}},
      {"key": "ring", "type": "ellipse", "center": [960, 540], "w": 760, "h": 760, "stroke": "#FFFFFF33", "strokeWidth": 2, "fill": "#00000000",
       "expr": {"rotation": "time*360/4", "scale": "value + [3*Math.sin(time*2*Math.PI/4), 3*Math.sin(time*2*Math.PI/4)]"}},
      {"key": "dot", "type": "ellipse", "center": [960, 160], "w": 18, "h": 18, "fill": "#FFFFFF",
       "expr": {"position": "[960 + 380*Math.sin(time*2*Math.PI/4), 540 - 380*Math.cos(time*2*Math.PI/4)]"}}
    ]}},
  {"tool": "critique", "args": {"loop": true}}
]
```

## Why it works
- Every motion is periodic with a period that divides the comp (4 s and 2 s): frame 0 and frame 4 s are identical in value AND velocity, so the loop has no seam.
- Phases are offset (+1.5, +3 rad) and directions alternate, so the blobs drift past each other instead of pulsing in lockstep.
- Small amplitudes (40–60 px, ±5% scale) and long periods = calm; a background blur over the blobs makes them soft (no fake concentric rings).
- One crisp detail (a dot orbiting a thin ring once per loop) gives the eye something to follow.
