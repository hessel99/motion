# Paper cut-out
> Layered paper craft: matte colors, soft drop shadows, jittery stop-motion timing and pieces that flip and slide like real paper.

**Use for**: storytelling, kids content, craft/eco brands, seasonal greetings, warm explainers.

## Palette
- Background `#F3E9DC` (kraft) or `#E4ECE7`; shadows `#000000` at 18–25 % opacity, offset [6, 8] px.
- Paper colors `#E76F51` red-orange, `#F4A261` sand, `#2A9D8F` teal, `#264653` deep green, `#E9C46A` yellow, `#FFFDF8` white.

## Shapes
Paths/rects/ellipses each with a shadow copy underneath (same shape, black, offset, low opacity), slightly rotated (−3° to 3°): hills, clouds, trees, banners. Group each object with its shadow.

## Typography
Inter 800 or `serif` 700 at 80–140 px on paper banners (text over a paper rect), letterSpacing 0.

## Easing & timing
Family: stop-motion = interp `hold` stepped at 12 fps (keys every 0.083 s) for character moves; `Back Out` / `Quad Out` for smooth paper slides. Moves 0.4–0.8 s. "On twos" jitter: rotation expression `value + (Math.floor(time*12)%2 ? 0.6 : -0.6)`.

## Signature moves
- Pop-up: an object rotates from −90° (flat) to 0 around its bottom anchor with `Back Out` 0.5 s, like a pop-up book.
- Layer slide-in: hills slide up from below back-to-front, 0.1 s stagger.
- Card flip: scale x 100 → 0 (`Quad In` 0.15 s), swap the content, 0 → 100 (`Quad Out` 0.15 s).
- Shadow lift: as an object rises its shadow offset grows [6,8] → [14,18] and its opacity drops.

## Transitions
A paper sheet (with shadow) slides across to cover the frame, or layers fold down (rotation) and the next scene pops up.

## Do / Don't
- Do: shadows on every piece, stepped jitter, layered depth, matte colors.
- Don't: glow, gradients, perfectly smooth vector-only motion, thin lines.

## Mini scene plan (9 s)
1. 0–3 s: three hill layers slide up staggered; the sun pops up from behind with `Back Out`.
2. 3–6 s: a house pops up (rotation from its bottom anchor); trees jitter on twos.
3. 6–9 s: a banner with the title slides in from the top with a stepped wobble; hold.
