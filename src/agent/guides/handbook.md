# Motion handbook
> Craft rules with numbers: principles, timing tables, easing vocabulary (our exact preset names), spacing, hierarchy, loops, transitions, type, color, composition, critique rubric.

Units: seconds, composition pixels, percent for scale/opacity. Reference comp 1920x1080 @ 60 fps; scale distances by `min(width, height) / 1080` for other sizes.

## 1. The 12 principles, applied (with numbers)
1. **Squash & stretch**: keep volume. Squash on impact to scale `[115, 85]`, stretch in flight `[90, 110]`, back to `[100, 100]` within 0.08–0.15 s. UI/brand: 3–8 % max; character/playful: up to 20 %.
2. **Anticipation**: a small opposite move before the main move. Size 5–15 % of the main move's distance (or scale 92–96 % before a pop). Duration 15–25 % of the main move (0.08–0.2 s), ease `Sine In Out` or `Quad Out`. Skip it for UI feedback that must feel instant.
3. **Staging**: one idea per beat. The thing that matters moves first/most; everything else holds or is quieter (smaller distance, lower contrast, later).
4. **Straight-ahead vs pose-to-pose**: we work pose-to-pose: block key poses first (positions/scales at beat times), then time them, then add in-betweens with eases/springs.
5. **Follow-through & overlapping action**: parts don't stop together. Secondary parts (children, shadows, labels, ornaments) start 0.03–0.1 s later and settle 0.05–0.15 s later. Overshoot 3–10 % past the target then settle (`Back Out` ≈ 10 % overshoot; `spring Bouncy` ≈ 1–2 visible wobbles).
6. **Slow in / slow out**: never linear for physical moves. Entrances decelerate (`Expo Out`, `Quart Out`, `Cubic Out`), exits accelerate (`Expo In`, `Cubic In`), on-screen moves ease both ends (`Cubic In Out`, `Quart In Out`, `Easy Ease`). `Linear` only for constant mechanical motion (rotation loops, tickers, scrolling, trim offsets).
7. **Arcs**: organic things travel on arcs. Use position spatial tangents `sOut`/`sIn` (~30–50 % of the distance, perpendicular) or a rotation on a parent. Straight lines read as mechanical/UI (fine for Swiss, data-viz).
8. **Secondary action**: a small supporting motion (a shine sweep, a dot pulsing, a shadow scaling) that never competes: ≤ 30 % of the main move's amplitude, lower contrast.
9. **Timing**: number of frames = weight and mood. Light/small = fast (0.15–0.3 s), heavy/large = slow (0.5–1.0 s). Holds create readability: a title needs ≥ 1.5 s on screen + 0.3 s per extra word.
10. **Exaggeration**: push the key pose 10–30 % further than "realistic" for playful styles; 0–5 % for corporate/luxury.
11. **Solid drawing**: consistent perspective/light: if one element casts a shadow, all do; one corner radius family; one stroke width family.
12. **Appeal**: clear silhouettes, strong contrast, a limited palette (2–4 colors + neutrals), generous negative space, and motion that resolves (everything lands and rests).

## 2. Timing tables
Durations for one move at 1080p. Multiply by 1.2–1.5 for "luxury/calm", by 0.7–0.8 for "snappy/energetic".

| move | duration |
|---|---|
| micro feedback (press, toggle, hover) | 0.08–0.2 s |
| small element in (icon, chip, ≤ 120 px travel) | 0.25–0.4 s |
| medium element in (card, headline, 120–400 px) | 0.4–0.7 s |
| large element / full-screen panel (> 400 px) | 0.6–1.0 s |
| camera move / scene push | 0.8–1.6 s |
| logo resolve (whole build) | 1.2–2.5 s |
| exits | 60–80 % of the matching entrance |
| hold after a key message | ≥ 1.5 s (+0.3 s/word beyond 5 words) |

By distance: `duration ≈ 0.25 s + distance_px / 2000` (cap 1.0 s), so a 200 px move ≈ 0.35 s, 800 px ≈ 0.65 s.
By importance: hero 1.0x, supporting 0.8x and later, decoration 0.6x and quieter.

**Stagger intervals** (offset between consecutive items):
- letters 0.02–0.05 s; words 0.06–0.12 s; lines 0.1–0.2 s
- list items / cards 0.05–0.1 s (keep the total cascade ≤ 0.6 s; for > 8 items lower the step so `step × (n-1) ≤ 0.5 s`)
- grid: stagger by distance from origin (center-out or corner), 0.03–0.06 s per ring/diagonal
- big blocks / scene layers 0.1–0.25 s

**Overlap**: start the next element when the previous is 50–70 % done, never after it fully stops (except deliberate beats). Total beat length = longest element + stagger cascade + hold.

**Pacing of a piece**: a 10–15 s piece = 3–5 beats of 2–4 s; each beat = in (0.4–1 s) + hold (1–2 s) + transition out (0.3–0.6 s). Leave 0.3–0.5 s of rest at the very end (loop or end card).

## 3. Easing vocabulary (our exact names)
Pass these strings as `ease` (on the key that starts the segment). Springs: `"spring Gentle"` (bounce 0.1), `"spring Quick"` (0.2), `"spring Bouncy"` (0.45), `"spring Wobbly"` (0.65), or `"spring:0.3"` (any bounce 0–0.9). Cubic-bezier arrays `[x1,y1,x2,y2]` for custom curves.

| feel | entrance (decelerate) | exit (accelerate) | on-screen move |
|---|---|---|---|
| neutral / UI | `Cubic Out` | `Cubic In` | `Cubic In Out`, `Easy Ease` |
| snappy, confident | `Expo Out`, `Snappy` | `Expo In` | `Expo In Out`, `Quart In Out` |
| soft, calm, luxury | `Sine Out`, `Gentle`, `Quad Out` | `Sine In` | `Sine In Out` |
| strong but smooth | `Quart Out` | `Quart In` | `Quart In Out` |
| playful pop | `Back Out`, `spring Bouncy` | `Back In` | `Back In Out` |
| physical, springy | `spring Quick`, `spring:0.3` | `Cubic In` | `spring Gentle` |
| cartoony wobble | `spring Wobbly` | `Back In` | `spring:0.55` |
| mechanical, constant | `Linear` | `Linear` | `Linear` |
| digital / glitch | interp `hold` (stepped) | `hold` | `Linear` + holds |

Rules: one easing family per piece (plus `Linear` for loops) keeps it coherent. Springs: the segment length is the settle time; give springs 1.2–1.6x the duration of a bezier move. Opacity fades: `Ease Out` in / `Ease In` out, and shorter than the move (40–60 % of it). Scale pops: start at 0–60 %, never from exactly 100 % with a tiny change.

Custom curves: "fast start, very long tail" `[0.05, 0.7, 0.1, 1]`; "material standard" `[0.2, 0, 0, 1]`; "material emphasized decelerate" `[0.05, 0.7, 0.1, 1]`; "anticipate" use `Back In` (overshoots below 0).

## 4. Spacing, overlap and offsets
- Spacing = how far an element travels per frame. Check it on a contact sheet: big gaps early + small gaps late = ease out. Even gaps = linear (only for mechanical motion).
- Entrance travel distances: subtle 16–40 px, standard 60–120 px, dramatic 200–400 px or from off-frame. Pair a travel with an opacity fade (0 → 100 in the first 40–60 %).
- Scale entrances: 0 → 100 (pop, needs overshoot), 60–80 → 100 (soft), 110–130 → 100 (zoom in settle).
- Rotation entrances: 5–15° (subtle), 90–180° (playful), always with an ease out/spring.
- Offsets inside one element: position leads, rotation/scale trail by 0.02–0.06 s; fills/colors change slightly after the shape arrives.
- Avoid "everything moves at once": in any 0.3 s window, at most 2–3 focal changes.

## 5. Hierarchy and focus (lead / follow)
- Order of entry = order of reading: hero → headline → support → details → CTA.
- The lead element has the largest move, the strongest ease, the highest contrast. Followers move less (50–70 % of the distance), start later (stagger), and use the same direction.
- Direction carries meaning: left→right = progress, up = positive/arrival, down = settle/exit, toward camera (scale up) = importance.
- Focus pulls: dim or shrink non-focal elements (opacity 30–50 %, scale 95 %) when the focus moves; restore when it returns.
- Keep one consistent "light source" direction for motion: things enter from the same side within a beat.

## 6. Loops
- Seamless loop: every animated property has the same value and the same velocity at t=0 and t=end. Easiest: keys `A → B → A` with `Sine In Out` both ways, or `set_expression` with `loopOut('cycle')` (keys must start = end) or `loopOut('pingpong')`.
- Periodic expressions with an exact period P that divides the comp duration D: `value + [0, 20*Math.sin(time*2*Math.PI/P)]`, `time*360/D` (rotation, Linear), so D/P is an integer.
- Offsetting phases (`index`) creates waves: `20*Math.sin((time/P + index*0.1)*2*Math.PI)`.
- Ambient loops: amplitude small (2–8 px, 1–3°, scale ±2–5 %), period 2–6 s; nothing should "pop" at the loop point.
- Check: contact_sheet `times: [0, D]` frames must look identical.

## 7. Transitions between beats
- **Cut on motion**: the next beat starts while the last element is still moving (overlap 0.1–0.3 s).
- **Push**: outgoing group exits with `Expo In` toward one side, incoming enters from the opposite side with `Expo Out`, overlapping 0.1–0.2 s; total 0.6–1.0 s.
- **Match/morph**: an element of beat A becomes an element of beat B (same layer animates position/size/radius/fill). The strongest continuity; use it for logos and UI states.
- **Mask/wipe**: a solid rect scales across the frame (anchor at one edge), covering → reveal; 0.4–0.7 s, `Expo In Out`.
- **Scale through**: zoom into an element until it fills the frame (scale 100 → 2000+, `Expo In`), reveal beat B as its fill.
- **Fade through color**: last resort; 0.3–0.5 s.
- Exits are quicker and quieter than entrances; don't animate every element out: often fade the group (group opacity) in 0.25–0.4 s.

## 8. Typography motion
- Readability first: a line must be fully readable (static) for ≥ 1.2 s; reading speed ≈ 3–4 words/s.
- Sizes at 1080p: display/hero 120–220 px, headline 72–110 px, subhead 40–56 px, body 28–36 px, caption 22–26 px. Minimum 22 px.
- Tracking: big display text −1 to −3 % of font size (letterSpacing ≈ −0.02 × fontSize px); all-caps small labels +5 to +12 % (≈ 0.08 × fontSize).
- Line height: display 0.95–1.1, body 1.3–1.5.
- Weight contrast: pair 700–900 headlines with 400–500 support text. Inter is bundled (weights 100–900); `serif` and `monospace` generic families work for contrast.
- Reveal by unit: words for sentences (`Fade up`, `Slide words`), characters for short display words (`Pop letters`, `Spin letters`, `Center burst`), lines for paragraphs (`Drop lines`). Char stagger 0.02–0.05 s, word 0.06–0.12 s.
- Kinetic emphasis: scale one keyword 110–130 % or recolor it to the accent after its line lands (0.1–0.2 s later).
- Never animate letter tracking and position wildly on body text.

## 9. Color and contrast
- Palette: 1 background, 1 primary ink (text), 1 accent, 1–2 support colors. Accent on ≤ 10–15 % of the frame.
- Contrast: text vs background ≥ 4.5:1 (body) / 3:1 (≥ 48 px). Dark bg `#0B0B0F`–`#16161D` with ink `#F5F5F7`; light bg `#F7F5F0`–`#FFFFFF` with ink `#111111`.
- Color motion: animate `fill` for state changes (0.2–0.4 s, `Cubic In Out`); a flash to the accent for emphasis (0.08 s in, 0.3 s out).
- Background shifts between beats: keep luminance steps large (≥ 30 %) so it reads as a new scene, or tiny (≤ 5 %) for ambience.

## 10. Composition
- Safe areas: keep text inside the title-safe 90 % (1920x1080: x 96–1824, y 54–1026); important action inside 80 %.
- Grid: 12 columns, 96 px outer margin, 24–32 px gutters at 1080p; align edges to it. Baseline/spacing scale: 8 px multiples (8, 16, 24, 32, 48, 64, 96, 128).
- Balance: one dominant mass, offset from center (rule of thirds lines x 640/1280, y 360/720) unless the style is centered/symmetric (logo reveals, luxury).
- Negative space: 30–50 % of the frame empty in calm styles; dense layouts only for brutalist/editorial/data.
- Depth: larger + higher contrast + faster = closer. Background layers move 0.2–0.5x the foreground for parallax.
- Off-frame: elements entering from outside start fully outside (position ± half their size beyond the edge).

## 11. Critique rubric (score 1–5 each, fix anything < 4)
1. **Brief fit**: says what was asked, all requested elements present, right length.
2. **Style match**: palette, type, easing family and signature moves of the chosen style are visible.
3. **Timing**: durations in the table ranges; holds long enough to read; nothing rushed or dragging; total length right.
4. **Easing & spacing**: no linear physical moves; entrances ease out, exits ease in; springs settle; one easing family.
5. **Overlap & hierarchy**: lead/follow order clear; staggers within ranges; at most 2–3 focal changes at once.
6. **Composition**: inside safe areas, aligned to a grid, balanced, no unintended overlaps or clipping, readable contrast.
7. **Polish**: secondary motion/follow-through present where the style calls for it; transitions connect beats; the ending resolves (or loops seamlessly).
8. **Technical**: no errors, nothing off-frame by mistake, no layers stuck at opacity 0 or scale 0 at the end, comp duration covers the animation.
First run `critique` (the editor's critic checks these numbers and names the fixing tool calls), then look: `contact_sheet` with 8–12 frames over the whole piece, then `times` at each beat boundary and at the end; `get_animation` to verify eases and times. Name the 1–3 worst problems, fix them, look again. At most 2 fix rounds unless the user asks for more.
