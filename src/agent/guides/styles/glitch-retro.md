# Glitch / retro-digital
> Broken-signal aesthetics: RGB split, stepped jumps, scanlines, pixel blocks and terminal type on dark screens.

**Use for**: gaming, tech launches, music, hacker/crypto themes, intros with tension.

## Palette
- Background `#0A0A0F`; ink `#E6E6E6`.
- Split channels `#FF003C` (red) and `#00F0FF` (cyan); plus `#39FF14` terminal green or `#FFFC00` warning yellow.

## Shapes
Thin horizontal bars (scanlines 2–6 px, opacity 15–30 %), rectangular slices, pixel squares (8–24 px), a cursor block. RGB split = two copies of the text/logo (red, cyan) behind the white one.

## Typography
`monospace` 400–700, 40–120 px, caps or code-like; the glitched hero word in Inter 900 with tight tracking.

## Easing & timing
Family: interp `hold` (stepped) and `Linear`; short `Expo Out` for resolves. Bursts 0.1–0.4 s made of 2–6 hold keys 1–3 frames apart (0.016–0.05 s at 60 fps). Typewriter by char at 0.03–0.05 s. Calm holds between bursts (1–2 s) so it reads.

## Signature moves
- RGB split: red copy at x −6 px, cyan at x +6 px, opacity 80 %; during bursts jump offsets ±4–20 px on hold keys; settle to 0.
- Slice jitter: horizontal bar rects jump in x (hold keys) across the logo.
- Burst jitter expression: `value + (time % 2 < 0.15 ? [random(-12,12), 0] : [0,0])`.
- `Typewriter` text + blinking cursor (opacity expression `Math.floor(time*2)%2*100`).
- Scanlines drift down with `Linear` + `loopOut('cycle')`.

## Transitions
Hard cut on a glitch burst; a full-frame noise flash (white rects for 2 frames).

## Do / Don't
- Do: stepped timing, contrast between chaos and stillness, short bursts.
- Don't: smooth springs, pastel colors, constant glitching (exhausting and unreadable).

## Mini scene plan (8 s)
1. 0–2 s: black; a cursor blinks; "BOOTING..." types on in green mono.
2. 2–5 s: the logo appears with a 0.3 s RGB-split burst, then holds with occasional 2-frame slice jitters.
3. 5–8 s: tagline types on; final burst; hard cut to black on the last frame.
