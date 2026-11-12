# Kinetic type
> Words are the visuals: big type cuts on rhythm, scales, rotates and replaces itself in sync with the beat.

**Use for**: quotes, lyric videos, manifestos, event promos, social ads without imagery.

## Palette
- High-contrast duo `#0E0E0E` / `#F5F5F0` with one accent `#FF3D2E` (or `#C6FF00`). Swap background and ink between beats for punch.

## Shapes
Mostly text. Support with bars/underlines, a single circle, or color fields flashing behind words.

## Typography
Inter 800–900: 140–320 px for the key word, 64–96 px for connecting words; letterSpacing −0.04 × size on huge words. One word or short phrase on screen at a time; key words in the accent.

## Easing & timing
Family: `Expo Out` / `Expo In` (hard in, hard out), `Back Out` for emphasis, `hold` for cuts. Each word/phrase 0.3–0.8 s on screen (120–160 wpm); key words 1.0–1.5 s. Moves 0.2–0.4 s. Put word changes on the beats.

## Signature moves
- Word swap: word A exits up (dy −80, `Expo In` 0.2 s) while word B enters from below (`Expo Out` 0.3 s), overlapping 0.05 s.
- Scale punch: key word 140 → 100 % with `Expo Out` 0.35 s, accent flash behind it.
- Rotate stack: words rotate 90° into place around a shared anchor.
- Per-char cascade for the final line (`Center burst` or `Pop letters`).
- Background inversion on the strongest beat (fill swap on `hold` keys).

## Transitions
Every beat is a cut on the word. Keep one visual anchor (baseline or center line) constant so the eye doesn't jump.

## Do / Don't
- Do: rhythm, big size contrast, sync to the beats, readable durations.
- Don't: more than ~7 words on screen, slow fades, decorative clutter.

## Mini scene plan (8 s, "Make it simple. Make it bold.")
1. 0–2 s: "MAKE" punches in, swaps to "IT", swaps to "SIMPLE." (accent).
2. 2–4.5 s: background inverts; "MAKE IT" small, "BOLD." huge with a scale punch.
3. 4.5–8 s: the full quote as two lines (`Fade up` words); an underline draws under "BOLD"; hold.
