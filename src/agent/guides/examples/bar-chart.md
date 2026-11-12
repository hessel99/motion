# Example: Data chart, bars grow from the baseline
> tags: chart, bar, data, graph, statistics, numbers, revenue, growth, quarter, infographic, data-viz, report, kpi

## Brief
"Animated bar chart: Revenue by quarter: Q1 12, Q2 18, Q3 15, Q4 27 ($M). Axis first, bars grow one after another, labels above, Q4 highlighted. 6 s."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"duration": 6, "background": "#FFFFFF"},
    "layers": [
      {"key": "title", "text": "Revenue by quarter", "fontSize": 72, "fontWeight": 800, "x": 160, "y": 110, "fill": "#0F172A", "enter": {"t": 0.1, "from": {"opacity": 0, "dy": 30}}},
      {"key": "unit", "text": "$M", "fontSize": 32, "fontWeight": 500, "x": 164, "y": 205, "fill": "#64748B", "enter": {"t": 0.3, "from": {"opacity": 0}}},
      {"key": "axis", "type": "rect", "x": 400, "y": 900, "w": 1120, "h": 3, "fill": "#94A3B8", "anchor": "left",
       "animate": {"scale": [{"t": 0.3, "v": [0, 100], "ease": "Quart Out"}, {"t": 0.9, "v": [100, 100]}]}},
      {"key": "bars", "staggerChildren": 0.12, "children": [
        {"key": "q1", "type": "rect", "x": 480, "y": 660, "w": 160, "h": 240, "radius": [8, 8, 0, 0], "fill": "#CBD5E1", "anchor": "bottom", "animate": {"scale": [{"t": 0.8, "v": [100, 0], "ease": "Quart Out"}, {"t": 1.5, "v": [100, 100]}]}},
        {"key": "q2", "type": "rect", "x": 740, "y": 540, "w": 160, "h": 360, "radius": [8, 8, 0, 0], "fill": "#CBD5E1", "anchor": "bottom", "animate": {"scale": [{"t": 0.8, "v": [100, 0], "ease": "Quart Out"}, {"t": 1.5, "v": [100, 100]}]}},
        {"key": "q3", "type": "rect", "x": 1000, "y": 600, "w": 160, "h": 300, "radius": [8, 8, 0, 0], "fill": "#CBD5E1", "anchor": "bottom", "animate": {"scale": [{"t": 0.8, "v": [100, 0], "ease": "Quart Out"}, {"t": 1.5, "v": [100, 100]}]}},
        {"key": "q4", "type": "rect", "x": 1260, "y": 360, "w": 160, "h": 540, "radius": [8, 8, 0, 0], "fill": "#2563EB", "anchor": "bottom", "animate": {"scale": [{"t": 0.8, "v": [100, 0], "ease": "Quart Out"}, {"t": 1.6, "v": [100, 106], "ease": "Cubic In Out"}, {"t": 1.85, "v": [100, 100]}]}}
      ]},
      {"key": "values", "staggerChildren": 0.12, "children": [
        {"key": "v1", "text": "12", "fontSize": 48, "fontWeight": 700, "align": "center", "center": [560, 620], "fill": "#334155", "enter": {"t": 1.35, "from": {"opacity": 0, "dy": 16}}},
        {"key": "v2", "text": "18", "fontSize": 48, "fontWeight": 700, "align": "center", "center": [820, 500], "fill": "#334155", "enter": {"t": 1.35, "from": {"opacity": 0, "dy": 16}}},
        {"key": "v3", "text": "15", "fontSize": 48, "fontWeight": 700, "align": "center", "center": [1080, 560], "fill": "#334155", "enter": {"t": 1.35, "from": {"opacity": 0, "dy": 16}}},
        {"key": "v4", "text": "27", "fontSize": 64, "fontWeight": 800, "align": "center", "center": [1340, 310], "fill": "#2563EB", "enter": {"t": 1.45, "from": {"opacity": 0, "scale": 60}, "ease": "spring:0.4"}}
      ]},
      {"key": "quarters", "staggerChildren": 0.12, "children": [
        {"key": "x1", "text": "Q1", "fontSize": 34, "fontWeight": 500, "align": "center", "center": [560, 950], "fill": "#64748B", "enter": {"t": 0.7, "from": {"opacity": 0}}},
        {"key": "x2", "text": "Q2", "fontSize": 34, "fontWeight": 500, "align": "center", "center": [820, 950], "fill": "#64748B", "enter": {"t": 0.7, "from": {"opacity": 0}}},
        {"key": "x3", "text": "Q3", "fontSize": 34, "fontWeight": 500, "align": "center", "center": [1080, 950], "fill": "#64748B", "enter": {"t": 0.7, "from": {"opacity": 0}}},
        {"key": "x4", "text": "Q4", "fontSize": 34, "fontWeight": 700, "align": "center", "center": [1340, 950], "fill": "#2563EB", "enter": {"t": 0.7, "from": {"opacity": 0}}}
      ]},
      {"key": "callout", "text": "+80% vs Q3", "fontSize": 40, "fontWeight": 700, "x": 1450, "y": 380, "fill": "#2563EB",
       "enter": {"t": 2.6, "from": {"opacity": 0, "dx": -30}}}
    ]}},
  {"tool": "animate", "args": {"tracks": [
    {"id": "<q4>", "prop": "fill", "merge": true, "keyframes": [{"t": 3.4, "v": "#2563EB", "ease": "Cubic In Out"}, {"t": 3.7, "v": "#1D4ED8", "ease": "Cubic In Out"}, {"t": 4.2, "v": "#2563EB"}]},
    {"id": "<v4>", "prop": "scale", "merge": true, "keyframes": [{"t": 3.4, "v": 100, "ease": "Cubic In Out"}, {"t": 3.7, "v": 112, "ease": "spring:0.4"}, {"t": 4.3, "v": 100}]}
  ]}}
]
```

## Why it works
- Bars are anchored at their bottom edge (anchor "bottom") and grow by scale Y 0 → 100: the baseline stays fixed, the data reads as growth.
- Order = reading order: title, axis wipes from the left, quarter labels, bars cascade 0.12 s apart, values land as each bar finishes.
- One accent: only Q4 is blue (bar, value, label, callout); the rest are neutral greys, so the insight is obvious in the first frame of the hold.
- Q4 gets the extra beat (overshoot 106%, a spring on its value, a later callout and a pulse at 3.4 s) instead of all bars bouncing.
