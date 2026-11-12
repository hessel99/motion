# Liquid / blob
> Fluid organic shapes that morph, merge and wobble in soft overlapping colors; motion is continuous, viscous and elastic.

**Use for**: wellness, music, creative agencies, abstract backgrounds, brand moods, ambient/loading loops.

## Palette
- Background `#0F0E17` or `#FFF5F0`.
- Blobs `#FF5F6D` coral, `#FFC371` peach, `#7F5AF0` violet, `#2CB67D` green, `#3DA9FC` sky; overlaps at 80–90 % opacity for color mixing.

## Shapes
Path blobs of 6–8 smooth cubic points (`C` commands), circles, pills; large shapes partly off-frame. Morph by animating scale/size/rotation of circles and pills (or path shape keys with the same command structure when a morph tool exists).

## Typography
Inter 700–800, 96–160 px, letterSpacing −0.02 × size, white or ink on top of the blobs; minimal text.

## Easing & timing
Family: `Sine In Out` for continuous motion, `spring Gentle` / `spring:0.3` for merges and arrivals, `Back Out` for drips and pops. Ambient periods 3–8 s; merges 0.6–1.2 s. Nothing ever fully stops.

## Signature moves
- Breathing: scale `[100,100] → [108,94] → [96,106] → [100,100]` over 4 s, `Sine In Out`, then `loopOut('cycle')`.
- Wobble: rotation `value + 8*Math.sin(time*2*Math.PI/5)` plus a position sine with another period; phase per blob via `index`.
- Merge: two circles drift together and overshoot into each other (spring) while a bridging pill scales in between them.
- Drip: a small circle detaches with `Back Out` and arcs away.

## Transitions
A blob grows to fill the frame (scale 100 → 1500, `Expo In`) and becomes the next background.

## Do / Don't
- Do: continuous motion, soft overlaps, smooth curves, seamless loops.
- Don't: hard corners, linear moves, stepped timing, cluttered small shapes.

## Mini scene plan (8 s loop)
1. 0–3 s: three blobs breathe and drift in phase-shifted sines.
2. 3–5.5 s: two blobs merge with a spring; the title fades up on top.
3. 5.5–8 s: the blobs separate back to their start poses so the loop is seamless at 8 s.
