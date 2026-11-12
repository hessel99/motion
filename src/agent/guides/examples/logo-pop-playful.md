# Example: Playful logo sting, the dot drops in and lands (make my logo move)
> tags: logo, sting, playful, bouncy, fun, kids, app, mark, wordmark, drop, land, squash, bounce, simple, make my logo move

## Brief
"Make my logo move: a round orange mark and the word 'pip'. Fun and friendly, about 3 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 3, "background": "#FFF7ED"},
    "layers": [
      {"key": "shadow", "type": "ellipse", "x": 690, "y": 650, "w": 180, "h": 28, "fill": "#7C2D1222",
       "animate": {"scale": [{"t": 0.1, "v": [30, 30], "ease": "Ease In Out"}, {"t": 0.55, "v": [100, 100], "ease": "spring Bouncy"}, {"t": 1.2, "v": [100, 100]}]}},
      {"key": "dot", "type": "ellipse", "x": 690, "y": 470, "w": 180, "h": 180, "fill": "#F97316", "anchor": "bottom",
       "animate": {
         "position": [{"t": 0.1, "v": [780, -40], "ease": "Quad In"}, {"t": 0.55, "v": [780, 650], "ease": "Cubic Out"}, {"t": 0.8, "v": [780, 600], "ease": "Cubic In"}, {"t": 1.0, "v": [780, 650]}],
         "scale": [{"t": 0.1, "v": [90, 115], "ease": "Quad In"}, {"t": 0.55, "v": [125, 78], "ease": "spring Bouncy"}, {"t": 1.2, "v": [100, 100]}]}},
      {"key": "word", "text": "pip", "fontSize": 200, "fontWeight": 800, "tracking": -6, "x": 910, "y": 430, "fill": "#7C2D12",
       "textAnim": {"preset": "Pop letters", "start": 0.75, "stagger": 0.05}},
      {"key": "spark1", "type": "star", "points": 4, "inner": 0.35, "x": 640, "y": 420, "w": 44, "h": 44, "fill": "#FDBA74",
       "enter": {"t": 0.6, "from": {"scale": 0, "rotation": -90}, "ease": "spring:0.45"}, "expr": {"rotation": "value + 20*Math.sin(time*2*Math.PI/1.5)"}},
      {"key": "spark2", "type": "star", "points": 4, "inner": 0.35, "x": 880, "y": 380, "w": 30, "h": 30, "fill": "#FB923C",
       "enter": {"t": 0.68, "from": {"scale": 0, "rotation": 90}, "ease": "spring:0.45"}, "expr": {"rotation": "value - 20*Math.sin(time*2*Math.PI/1.5)"}}
    ]}}
]
```

## Why it works
- A story in 1 s: the mark falls (Quad In = gravity), squashes on contact (125/78, volume kept), springs back and settles; the shadow grows as it lands, which sells the impact.
- The wordmark answers the landing: letters pop in one after another (0.05 s) just as the mark settles: overlap, not a queue.
- Two sparkles are secondary: smaller, later, quieter colours, and they keep rocking in the hold so the end is alive.
- Playful = springs and squash, but the final frame is the clean lockup (scale 100, upright).
