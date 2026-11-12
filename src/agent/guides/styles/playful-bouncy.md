# Playful bouncy
> Rounded shapes, candy colors, springs and squash & stretch: everything has weight, overshoots and wobbles.

**Use for**: kids/consumer apps, onboarding, celebrations, social stickers, mascots.

## Palette
- Background `#FFF4E6` or `#E8F1FF`; ink `#2B2D42`.
- Accents: `#FF6B6B` coral, `#FFD93D` sun, `#6BCB77` green, `#4D96FF` blue, `#C77DFF` lilac.

## Shapes
Circles, pills (radius = h/2), blobs, rounded rects (radius 24–48). Optional soft strokes (6–10 px). Dots/faces for character.

## Typography
Inter 800, 96–180 px, letterSpacing −0.01 × size. Short words; letters can bounce individually.

## Easing & timing
Family: springs — `spring Bouncy` for arrivals, `spring Wobbly` for celebration, `Back Out` for small pops, `Back In` for exits. Moves 0.4–0.8 s (springs need 1.3x). Staggers 0.06–0.1 s, letters 0.04 s. Exaggerate 15–30 %.

## Signature moves
- Pop with squash: scale `[0,0] → [115,85] → [92,108] → [100,100]` at 0 / 0.25 / 0.4 / 0.55 s (`Back Out`, `Sine In Out`, `Sine Out`).
- Drop & bounce: position from above with `spring Bouncy`; on landing scale `[120,80]` for 0.08 s.
- Anticipation: scale to 92 % (0.1 s) before jumping.
- Idle wiggle: rotation expression `value + 3*Math.sin(time*2*Math.PI/1.5)`.
- Letters: `Pop letters` (spring 0.5, stagger 0.03).

## Transitions
Circle iris (a big circle scales 0 → covers the frame with `Expo In`), or elements bouncing out downward while the next ones drop in.

## Do / Don't
- Do: overshoot, arcs (sOut/sIn), follow-through on attached parts, happy colors.
- Don't: linear moves, sharp corners, long static holds without an idle motion.

## Mini scene plan (8 s)
1. 0–2.5 s: three colored balls drop in staggered 0.12 s with `spring Bouncy` and landing squash.
2. 2.5–5.5 s: balls arc into a row and stretch into pills; title "Let's play!" pops by letter.
3. 5.5–8 s: confetti dots burst outward (`Back Out`, random rotation); logo pops with a wobble.
