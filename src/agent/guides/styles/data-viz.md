# Data-viz clean
> Precise, honest charts that build in reading order: axes first, then data, then the insight highlighted.

**Use for**: reports, investor updates, dashboards, research results, KPI announcements.

## Palette
- Background `#FFFFFF` or `#0F172A`; ink `#0F172A` / `#E2E8F0`; gridlines `#E2E8F0` / `#1E293B` (low contrast).
- Series `#2563EB`, `#F59E0B`, `#10B981`, `#EF4444`; highlight the insight series and grey the rest (`#94A3B8`).

## Shapes
Bars (rects, radius 4–8), lines (stroke paths 4–6 px, fill `#00000000`), dots (12–16 px ellipses), axes (1–2 px rects), labels. Fixed baseline; bars anchored at their bottom (anchor [w/2, h]).

## Typography
Inter 600 titles 48–64 px, Inter 500 value labels 28–36 px, Inter 400 axis labels 20–24 px in muted ink.

## Easing & timing
Family: `Cubic In Out` for growth, `Quart Out` for arrivals, `Linear` only for line draw-ons where speed should read as constant. Bars grow 0.6–1.0 s staggered 0.06–0.1 s; lines draw 1–1.5 s; value labels fade in at 80 % of their bar. No bounce (overshoot lies about values) — at most `spring Gentle`.

## Signature moves
- Axes draw (scale from the origin), gridlines fade in at low contrast.
- Bars grow from the baseline: scale `[100,0] → [100,100]` with the anchor at the bottom center.
- Line chart: stroke path `trimEnd` 0 → 100; dots pop as the line passes them.
- Highlight: other bars fade to grey (fill), the key bar gets the accent and a number label; a callout line draws.

## Transitions
Morph one chart into the next (bars resize/reposition), or slide the chart out while the title area stays.

## Do / Don't
- Do: accurate proportions (height = value × scale), labels, reading order, one highlighted insight.
- Don't: 3D, overshoot on values, rainbow palettes, decoration that competes with data.

## Mini scene plan (9 s)
1. 0–2 s: title "Revenue by quarter" fades up; the axis and 4 gridlines draw.
2. 2–5 s: 4 bars grow staggered 0.08 s (`Cubic In Out` 0.8 s); values fade in on top.
3. 5–9 s: the Q4 bar turns accent, others grey; a "+38 %" callout pops; hold.
