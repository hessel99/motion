# Editorial
> Magazine layouts in motion: serif headlines, big pull quotes, images in strict frames, measured page-like reveals.

**Use for**: publications, podcasts, journalism, essays, culture brands, documentary titles.

## Palette
- Background `#F7F4EE` (newsprint) or `#111111`; ink `#141414` / `#F2EFE8`.
- One accent: `#B3261E` (editorial red) or `#1F3A5F` (navy); rules in ink.

## Shapes
Image frames (rects with placeholder fill `#D9D3C7`), thin rules (1–3 px), 6- or 12-column grids, drop caps, issue numbers, captions.

## Typography
`serif` 400–700 headlines 96–180 px (letterSpacing −0.01 × size, lineHeight 1.0), italic feel for quotes; Inter 500 kickers/captions in caps 20–24 px with letterSpacing +0.12 × size. Headline:caption size ratio ≈ 6:1.

## Easing & timing
Family: `Quart Out`, `Cubic In Out`, `Expo Out`. Moves 0.6–1.0 s, line staggers 0.12–0.18 s, holds 2.5–4 s (reading time). Mask-like reveals (slide 60–120 px + fade).

## Signature moves
- Line-by-line headline (`Drop lines` with ease `Quart Out`, or `Fade up`).
- Rules draw first (scale x from a left anchor, `Quart Out` 0.8 s), then text lands on them.
- Image reveal: a cover rect shrinks to 0 width (anchor on its right edge), uncovering the frame.
- Pull quote: a big quote mark scales 80 → 100 (`Cubic Out`), the quote's words fade up.

## Transitions
Page turn: the layout slides one page width left (`Quart In Out` 0.9 s) while the next slides in; or a column wipe.

## Do / Don't
- Do: hierarchy, white space, grids, long readable holds.
- Don't: bounces, neon, more than 2 typefaces, cramped text.

## Mini scene plan (10 s)
1. 0–3 s: kicker "ISSUE 12 — CITIES" fades in; a rule draws; the headline lands line by line.
2. 3–7 s: an image frame reveals on the right; caption appears; a pull quote fades up on the left.
3. 7–10 s: the page slides away to the masthead end card.
