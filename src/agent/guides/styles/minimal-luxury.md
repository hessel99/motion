# Minimal luxury
> Restraint and slowness: near-black or ivory, light serif display type, wide tracking, long gentle fades and tiny moves.

**Use for**: fashion, jewelry, perfume, hotels, premium product reveals, high-end titles.

## Palette
- Dark: background `#0C0C0C`, ink `#F3EFE7`, gold accent `#C8A96A`.
- Light: background `#F3EFE7`, ink `#1A1A1A`, accent `#8C6B3F`.

## Shapes
Hairlines (1–2 px), thin frames, a single circle or arch, 50 %+ empty space. Centered, symmetric compositions.

## Typography
Display in `serif` 300–400, 90–160 px, letterSpacing +0.02 × size; small-caps labels in Inter 400 20–24 px with letterSpacing +0.25 × size. lineHeight 1.1.

## Easing & timing
Family: `Sine In Out`, `Gentle`, `Sine Out`, `Quad Out`. Slow: moves 1.0–2.0 s, fades 0.8–1.5 s, letter staggers 0.06–0.1 s. Tiny distances (8–30 px) or scale 104 → 100. No springs, no overshoot.

## Signature moves
- Slow reveal: opacity 0 → 100 over 1.2 s with scale 104 → 100 (`Sine Out`).
- Tracking breathe: letters fade in by char, stagger 0.08 s, dy 10 px.
- Hairline draw-on: path line `trimEnd` 0 → 100 over 1.2 s, `Sine In Out`.
- Gold glint: a thin light rect sweeps across the logo (opacity 0 → 60 → 0, 0.8 s).

## Transitions
Fade through black (0.6–1 s) or a slow cross-fade with 0.3 s overlap. Never pushes.

## Do / Don't
- Do: patience, symmetry, few elements, long holds (2–3 s).
- Don't: bright colors, bold weights, fast moves, more than 3 elements on screen.

## Mini scene plan (10 s)
1. 0–3.5 s: a hairline draws across the center; "MAISON" fades in letter by letter above it.
2. 3.5–7 s: the line fades; the product name in serif scales 104 → 100; a gold subtitle 0.4 s later.
3. 7–10 s: glint sweeps the logo; slow fade to black.
