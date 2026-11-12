# Swiss / International
> Grid-strict, asymmetric, Helvetica-like type, red + black on white; precise moves that snap to the grid.

**Use for**: design-literate brands, posters, conference titles, architecture, editorial info.

## Palette
- Background `#F4F1EA` (paper) or `#FFFFFF`; ink `#111111`; accent `#E30613` (Swiss red). Optional support `#1D4ED8` (sparingly) or grey `#8A8A8A`.
- Accent ≤ 15 % of the frame; flat fills only, no gradients/shadows.

## Shapes
Rectangles, circles, thick rules (8–24 px bars), square corners (radius 0). Big geometric masses cropped by the frame edge. Everything on a 12-column grid (96 px margins, 24 px gutters).

## Typography
Inter 700–900 display (140–260 px, letterSpacing ≈ −0.03 × size, lineHeight 0.92); Inter 500 support (32–44 px, letterSpacing 0). Flush-left, ragged right, never centered. Big numbers (300+ px) as graphic elements.

## Easing & timing
Family: `Quart In Out`, `Expo Out`, `Expo In`; `Linear` for bars growing at constant speed. No springs, no overshoot. Moves 0.4–0.7 s; staggers 0.06–0.1 s; holds ≥ 1.5 s.

## Signature moves
- Bars wipe in by scale on one axis from an edge anchor (`scale [0,100] → [100,100]`, `Expo Out`).
- Text enters by lines (dy 40–80 px + opacity: `Drop lines` with ease `Expo Out`, or `Slide words`).
- Elements slide exactly one grid column/row; everything lands on grid lines.
- One red circle or square as the single accent that moves last.

## Transitions
Hard push along the grid (`Expo In Out`, 0.6 s), or a full-frame red bar wiping across.

## Do / Don't
- Do: asymmetry, big type, strict alignment, generous white space.
- Don't: bounces, rotation, drop shadows, more than 2 colors + neutrals, centered layouts.

## Mini scene plan (8 s)
1. 0–2 s: a red bar (24 px tall) wipes in from x 96 to full width at y 200; headline "FORM FOLLOWS" drops in by lines.
2. 2–5 s: three columns fill with 01 / 02 / 03 staggered 0.1 s; thin rules grow under each.
3. 5–8 s: everything pushes up one row; a red 240 px circle lands bottom-right; hold.
