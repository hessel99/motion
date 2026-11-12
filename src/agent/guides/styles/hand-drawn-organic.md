# Hand-drawn organic
> Imperfect, warm and human: wobbly strokes drawing on, earthy palette, boiling lines and gentle arcs.

**Use for**: wellness, food, education, nonprofits, storytelling, craft brands.

## Palette
- Background `#F6EFE3` (paper); ink `#2E2A24`.
- Accents: `#D97757` terracotta, `#7A9E7E` sage, `#E9B44C` mustard, `#5B7DB1` dusty blue.

## Shapes
Path layers with irregular curves (no perfect circles); line art = stroke 4–8 px with fill `#00000000`; filled blobs with uneven edges. Underlines, arrows, scribbles, circles drawn around words.

## Typography
`serif` 400–600 or Inter 500 at 64–120 px, letterSpacing 0, friendly lowercase; the handmade feel comes from the drawn shapes around the text.

## Easing & timing
Family: `Sine In Out`, `Quad Out`, `Gentle`, `spring Gentle`. Draw-ons 0.6–1.2 s, moves 0.5–0.9 s, staggers 0.1–0.2 s. All travel on arcs (sOut/sIn).

## Signature moves
- Draw-on: path `trimEnd` 0 → 100 (`Sine In Out`); `trimStart` 0 → 100 later to "erase".
- Boil (line wobble): `wiggle(8, 0.8)` on rotation or `wiggle(8, 1.5)` on position of stroked shapes, or 3 alternating hold-key poses every 0.12 s.
- Circle-around: an elliptical scribble draws around a key word after it lands.
- Leaves/elements float on arcs with slight rotation (±5°).

## Transitions
A big organic blob grows to fill the frame (`Quad Out`), or lines draw across and become the next scene's frame.

## Do / Don't
- Do: imperfection, arcs, staggered draw-ons, warm paper colors.
- Don't: perfect geometry, linear motion, neon colors, hard cuts.

## Mini scene plan (9 s)
1. 0–3 s: a sprout line draws up from the bottom; two leaves pop on with `spring Gentle`.
2. 3–6 s: headline fades in; a terracotta underline scribbles under "grow"; leaves boil.
3. 6–9 s: a sage blob grows to fill the frame; the logo draws on in ink.
