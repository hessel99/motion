# Example: Logo reveal, the door opens (home / welcome brand)
> tags: logo, reveal, brand, mark, wordmark, house, home, door, real estate, welcome, concept, open, hinge, warm

## Brief
"Animate our logo: Haven (a house outline with a door) + the tagline Welcome home. 4 s, dark navy."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 4, "background": "#0F172A"},
    "layers": [
      {"key": "glow", "type": "rect", "x": 922, "y": 522, "w": 76, "h": 116, "fill": "#FDBA74",
       "animate": {"opacity": [{"t": 1.0, "v": 0, "ease": "Ease Out"}, {"t": 1.5, "v": 85}]},
       "expr": {"opacity": "value + 6*Math.sin(time*2*Math.PI/2)"}},
      {"key": "house", "type": "path", "d": "M820 640 L820 480 L960 370 L1100 480 L1100 640 Z", "stroke": "#F8FAFC", "strokeWidth": 10, "fill": "#00000000",
       "drawOn": {"t": 0.1, "duration": 0.9, "ease": "Cubic In Out"}},
      {"key": "door", "type": "rect", "x": 920, "y": 520, "w": 80, "h": 120, "fill": "#F59E0B", "anchor": "left",
       "animate": {"scale": [{"t": 0.95, "v": [100, 100], "ease": "Cubic In Out"}, {"t": 1.45, "v": [18, 100], "ease": "spring Gentle"}, {"t": 2.2, "v": [26, 100]}]}},
      {"key": "wordmark", "text": "Haven", "fontSize": 128, "fontWeight": 700, "tracking": -3, "x": 1150, "y": 420, "fill": "#F8FAFC",
       "enter": {"t": 1.3, "from": {"opacity": 0, "dx": -60}}},
      {"key": "tagline", "text": "Welcome home", "fontSize": 40, "fontWeight": 500, "x": 1156, "y": 576, "fill": "#94A3B8",
       "enter": {"t": 1.6, "from": {"opacity": 0, "dy": 24}}}
    ]}},
  {"tool": "secondary_motion", "args": {"ids": ["<wordmark>"], "overshoot": 0.06, "segments": "first"}}
]
```

## Why it works
- The hero action is what the mark depicts: the door swings open on its hinge (anchor "left"), with a spring settle, instead of the logo popping in.
- Lead → follow: the outline draws first (0.1–1.0 s), the door opens as it completes, the wordmark slides out of the door's light 0.35 s later, the tagline 0.3 s after that: overlap, never all at once.
- Entrances decelerate (enter defaults: Quart Out / Ease Out fades); the wordmark gets a 6% overshoot settle.
- The warm glow behind the door keeps breathing through the hold (a 2 s sine that divides the comp), so the ending is alive, not frozen.
- Palette: navy, off-white, one warm accent; type 128/40 with weight contrast; everything inside the title-safe area.
