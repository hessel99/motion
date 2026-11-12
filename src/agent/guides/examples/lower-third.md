# Example: Corporate lower third (name + title), in and out
> tags: lower third, name, title, caption, interview, corporate, news, broadcast, speaker, smooth, professional, label

## Brief
"Lower third for an interview: Maria Lopez, Head of Design at Acme. Clean corporate look, it comes in, holds, and goes out. 6 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 6, "background": "#2A3342"},
    "layers": [
      {"key": "panel", "type": "rect", "x": 140, "y": 790, "w": 760, "h": 170, "radius": 6, "fill": "#FFFFFF", "anchor": "left",
       "animate": {"scale": [{"t": 0.2, "v": [0, 100], "ease": "Quart Out"}, {"t": 0.75, "v": [100, 100]}, {"t": 4.9, "v": [100, 100], "ease": "Quart In"}, {"t": 5.3, "v": [0, 100]}]}},
      {"key": "accent", "type": "rect", "x": 140, "y": 790, "w": 10, "h": 170, "fill": "#0EA5E9", "anchor": "bottom",
       "animate": {"scale": [{"t": 0.1, "v": [100, 0], "ease": "Quart Out"}, {"t": 0.5, "v": [100, 100]}, {"t": 5.15, "v": [100, 100], "ease": "Quart In"}, {"t": 5.45, "v": [100, 0]}]}},
      {"key": "name", "text": "Maria Lopez", "fontSize": 56, "fontWeight": 700, "x": 190, "y": 812, "fill": "#0F172A",
       "enter": {"t": 0.45, "from": {"opacity": 0, "dx": -30}}, "exit": {"t": 5.0, "duration": 0.25, "to": {"opacity": 0, "dx": -20}}},
      {"key": "role", "text": "Head of Design, Acme", "fontSize": 34, "fontWeight": 500, "x": 192, "y": 885, "fill": "#475569",
       "enter": {"t": 0.58, "from": {"opacity": 0, "dx": -30}}, "exit": {"t": 4.95, "duration": 0.25, "to": {"opacity": 0, "dx": -20}}},
      {"key": "speaker", "type": "ellipse", "center": [1300, 480], "w": 520, "h": 520, "fill": "#475569",
       "animate": {"scale": [{"t": 0, "v": 100, "ease": "Sine In Out"}, {"t": 6, "v": 104}]}}
    ]}}
]
```

## Why it works
- Built from its pieces in order: the accent bar grows from its bottom edge (0.1 s), the panel wipes from its left edge, the name and role slide in 0.13 s apart inside it.
- Exits are the entrance reversed, faster (0.25–0.4 s) and with accelerating eases (Quart In); text leaves first, the panel closes after it, the accent last.
- Holds ~4 s: a name and title are readable in well under that; the out leaves 0.5 s of clean frame.
- Corporate restraint: one accent colour, square-ish corners, no overshoot, all moves on the same horizontal axis; a slow push on the (placeholder) speaker keeps the shot alive.
