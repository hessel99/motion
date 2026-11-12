# Neo-brutalist
> Raw, loud, high-contrast blocks with thick black outlines, hard offset shadows and abrupt, stepped motion.

**Use for**: indie products, dev tools, Gen-Z brands, bold announcements, web-native promos.

## Palette
- Background `#FFFDF5` or `#F2F2F2`; ink/outlines `#000000`.
- Loud accents (pick 2–3): `#FFE600` yellow, `#FF5C00` orange, `#3DDC97` mint, `#7B61FF` violet, `#FF90E8` pink.

## Shapes
Rects with strokeWidth 4–6 px black, radius 0–12; a black copy offset by [8, 8] px behind each card as the hard shadow. Stickers, arrows, stars as paths. Slight tilt (−4° to 4°) on cards.

## Typography
Inter 800–900, 96–200 px, letterSpacing 0 to −0.01 × size; `monospace` labels (24–32 px). Text inside boxes with 24–40 px padding.

## Easing & timing
Family: `Expo Out` and interp `hold` (stepped). Snappy, almost no tails: moves 0.15–0.35 s. Stepped jumps: 2–3 hold keys 0.08 s apart. Staggers 0.05–0.08 s. Overshoot only via `Back Out`.

## Signature moves
- Card slam: position from 80 px offset + rotation 6° → 0 with `Expo Out` 0.25 s; its shadow follows 0.05 s later.
- Press: card moves +8,+8 onto its shadow (0.08 s) and back (0.12 s), like a button.
- Stepped scale: 0 → 110 → 100 on `hold` keys (0, 0.08, 0.16 s).
- Sticker pop with rotation −20° → 0, `Back Out`.

## Transitions
Hard cuts, a black block wiping in 0.2 s, or the next card covering the frame.

## Do / Don't
- Do: thick outlines, offset shadows, visible boxes, playful tilt.
- Don't: soft shadows, gradients, slow fades, thin type.

## Mini scene plan (8 s)
1. 0–2.5 s: yellow card "SHIP IT." slams in from the left with its shadow; a pink star sticker pops on its corner.
2. 2.5–5.5 s: three feature cards drop in stepped (0.06 s stagger), each pressed once in sequence.
3. 5.5–8 s: black wipe; end card with logo box and a mono URL typed on.
