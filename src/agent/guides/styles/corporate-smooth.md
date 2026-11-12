# Corporate smooth
> Clean, trustworthy and calm: brand blue, soft cards, gentle fades and long decelerating eases, no surprises.

**Use for**: SaaS, finance, B2B explainers, keynote slides, product feature reveals.

## Palette
- Background `#FFFFFF` / `#F5F7FB`; ink `#0F172A`; secondary text `#475569`.
- Brand `#2563EB` (or the user's brand via list_styles), support `#14B8A6`, soft fill `#E0E7FF`, borders `#E2E8F0`.

## Shapes
Rounded cards (radius 16–24), 1–2 px borders, icons in circles, simple UI mockups (rects + text). Lots of white space.

## Typography
Inter 600–700 headlines 64–96 px (letterSpacing −0.02 × size); Inter 400–500 body 28–36 px, lineHeight 1.3. Left on a 12-col grid or centered.

## Easing & timing
Family: `Cubic Out` / `Quart Out` in, `Cubic In` out, `Cubic In Out` moves; optionally `spring Gentle`. Moves 0.5–0.8 s; staggers 0.08–0.12 s; holds 2–3 s. Small distances (40–80 px).

## Signature moves
- Fade up: opacity 0 → 100 + dy 40 px, `Quart Out` 0.6 s (`Slide up` preset or `Fade up` text).
- Card cascade with 0.1 s stagger and scale 96 → 100.
- Progress bar fill (scale x from a left anchor, `Cubic In Out` 1 s).
- Gentle focus: other cards dim to 50 % when one is highlighted.

## Transitions
Soft slide-push (`Cubic In Out` 0.8 s) or a 0.4 s cross-fade; match cuts between UI states.

## Do / Don't
- Do: consistency, alignment, readable holds, brand colors linked with link_style.
- Don't: bounce beyond `spring Gentle`, rotations, more than one accent, fast cuts.

## Mini scene plan (10 s)
1. 0–3 s: headline "Close your books in days" fades up; subtitle follows 0.15 s later.
2. 3–7 s: dashboard card slides in, three KPI tiles cascade, a progress bar fills to 82 %.
3. 7–10 s: content slides out left; logo + tagline fade up centered; hold.
