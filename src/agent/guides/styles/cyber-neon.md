# Cyber / neon
> Night-city neon: glowing strokes on near-black, magenta/cyan, grids receding to the horizon, flicker-on lights and smooth synth motion.

**Use for**: gaming, esports, nightlife, synthwave music, tech events, futuristic UI.

## Palette
- Background `#07020F` / `#0B0620`; grid lines `#2A1B5A`.
- Neon `#FF2E97` magenta, `#00E5FF` cyan, `#FFE53D` yellow, `#9D4DFF` violet. Glow = a copy of the shape in the same color with a 2–3x stroke width at 25–35 % opacity behind it.

## Shapes
Stroked outlines (3–6 px, fill transparent) with glow copies; a perspective grid (converging lines), a sun disc cut by horizontal bars, HUD frames, corner brackets, scan rings.

## Typography
Inter 800 caps 100–180 px, letterSpacing +0.04 × size; glow via a duplicate text layer (same color, opacity 30 %, scale 102 %) behind. `monospace` HUD labels 20–28 px.

## Easing & timing
Family: `Expo Out`, `Quart In Out`, `Linear` (grid scroll, rotations), `hold` for flicker. Moves 0.4–0.8 s; flicker-on = 4–6 hold keys over 0.3 s (opacity 0/100/20/100/50/100). Ambient motion never stops.

## Signature moves
- Neon flicker-on (hold keys on opacity) of the main sign, the glow copy flickering in sync.
- Grid scroll: horizontal lines move down `Linear` with `loopOut('cycle')`.
- HUD ring spin: rotation `time*45`, inner ring `-time*60`.
- Light trail: animate `trimStart` and `trimEnd` together (or `trimOffset`) so a dash travels along a path.

## Transitions
A 2-frame white flash + cut, or a horizontal scan bar sweeping down to reveal the next scene.

## Do / Don't
- Do: glow layering, darkness around neon, continuous ambient motion.
- Don't: light backgrounds, pastels, flat fills without glow, more than 2 neons + 1 accent.

## Mini scene plan (8 s)
1. 0–2.5 s: the grid scrolls toward the viewer; the sun disc rises with `Quart Out`.
2. 2.5–5.5 s: "NIGHT RUN" flickers on; HUD brackets snap into the corners.
3. 5.5–8 s: a light trail races along a path to the logo; final flash.
