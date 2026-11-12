# Example: Kinetic type quote with clean phrase handovers
> tags: kinetic, type, typography, quote, text, words, phrases, sentence, statement, title, bold, editorial, manifesto

## Brief
"Kinetic typography for the quote: Design is not just what it looks like. Design is how it works. — Steve Jobs. Bold, dark, 8 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 8, "background": "#0E0E0E"},
    "layers": [
      {"key": "p1", "text": "Design is not just", "fontSize": 120, "fontWeight": 800, "tracking": -4, "align": "center", "center": [960, 470], "fill": "#F5F5F0",
       "textAnim": {"preset": "Slide words", "start": 0.15, "stagger": 0.08},
       "exit": {"t": 2.75, "duration": 0.3, "to": {"opacity": 0, "dy": -60}, "ease": "Expo In"}},
      {"key": "p2", "text": "what it looks like.", "fontSize": 120, "fontWeight": 800, "tracking": -4, "align": "center", "center": [960, 610], "fill": "#8A8A8A",
       "textAnim": {"preset": "Slide words", "start": 0.45, "stagger": 0.08},
       "exit": {"t": 2.82, "duration": 0.3, "to": {"opacity": 0, "dy": -60}, "ease": "Expo In"}},
      {"key": "p3", "text": "Design is", "fontSize": 120, "fontWeight": 800, "tracking": -4, "align": "center", "center": [960, 430], "fill": "#F5F5F0",
       "textAnim": {"preset": "Slide words", "start": 2.9, "stagger": 0.08},
       "exit": {"t": 6.0, "duration": 0.35, "to": {"opacity": 0}, "ease": "Ease In"}},
      {"key": "p4", "text": "how it works.", "fontSize": 190, "fontWeight": 900, "tracking": -7, "align": "center", "center": [960, 640], "fill": "#FF3D2E",
       "enter": {"t": 3.3, "duration": 0.6, "from": {"opacity": 0, "scale": 70}, "ease": "spring:0.35"},
       "exit": {"t": 6.05, "duration": 0.35, "to": {"opacity": 0, "scale": 96}, "ease": "Cubic In"}},
      {"key": "underline", "type": "rect", "x": 430, "y": 760, "w": 1060, "h": 14, "fill": "#FF3D2E", "anchor": "left",
       "animate": {"scale": [{"t": 3.8, "v": [0, 100], "ease": "Expo Out"}, {"t": 4.4, "v": [100, 100], "ease": "Expo In"}, {"t": 5.8, "v": [100, 100]}, {"t": 6.05, "v": [0, 100]}]}},
      {"key": "author", "text": "— Steve Jobs", "fontSize": 56, "fontWeight": 500, "align": "center", "center": [960, 540], "fill": "#F5F5F0",
       "enter": {"t": 6.35, "duration": 0.6, "from": {"opacity": 0, "dy": 30}}}
    ]}},
  {"tool": "build_scene", "args": {"layers": [
    {"key": "p4", "expr": {"scale": "value + [1.5*Math.sin(time*2*Math.PI/2), 1.5*Math.sin(time*2*Math.PI/2)]"}}
  ]}}
]
```

## Why it works
- Phrase by phrase, never two phrases fighting: line 1 and 2 build word by word (0.08 s), hold ~1.5 s, then exit up together (Expo In, 0.3 s) BEFORE the next phrase arrives: no text-on-text collisions.
- The punchline is the hero: bigger (190 px), the accent colour, a spring entrance, an underline that wipes from its left edge, a slow 1.5% breath in the hold.
- Reading time: every phrase is fully readable ≥ 1.2 s; the attribution gets the last 1.6 s on its own.
- Grey for the setup, white for the turn, red for the payoff: colour carries the argument.
