# Concept-driven motion
> Read the artwork and the brand before animating: what each part depicts, the brand's personality, then a metaphor → motion recipe (door opens, leaf grows, rocket launches…). Plus anti-patterns.

Motion should say what the mark *means*. A door that opens, a leaf that unfurls, a rocket that lifts off is remembered; the same shapes popping in one by one is forgettable. Pop/fade/scale-in are secondary motion only (supporting parts, wordmark settle), never the idea.

## 1. Read the artwork (always, before animating a logo, icon, illustration or imported Figma frame)
1. Look: `inspect_artwork` (renders each part alone with bounds and a shape hint) when available; otherwise `contact_sheet` / `screenshot` of the frame and `get_document` / `get_layer` for the parts, or `preview_strip`.
2. Separate the parts: a compound vector or flattened logo → `split_shape` (by subpath / connected component, keeps position) so each meaningful piece can move on its own. Name the parts after what they depict ("Door", "Roof", "Leaf", "Tittle"), not "Path 3".
3. Name what each part depicts: objects (door, house, leaf, cup, rocket, eye, bubble, key, gear, flame, wave, mountain, sun), letters (which letter, which glyph is special: a dot, a counter, a swash), symbols (check, arrow, play, plus, heart, star, location pin), abstract shapes (circle = unity/globe/sun, triangle = direction/peak, square = stability).
4. Read the brand: name (literal meanings: "Orbit", "Haven", "Sprout"), colours (warm/cool, saturated/muted, dark/light), type (geometric sans = modern/tech, serif = heritage/editorial, rounded = friendly, heavy = bold), shape language (rounded vs sharp, symmetric vs dynamic), and the brief (audience, product, tone words).
5. Write it down in one line each: "Parts: house outline, door (rect, left hinge), window dot, wordmark 'Haven'. Brand: warm, trustworthy, home rental, rounded sans."

## 2. Concepts: 2–3 ideas rooted in meaning
- Each concept = the idea + why it fits the brand, one line. E.g. "Door opens: light spills out, the wordmark walks out of the doorway — Haven is about welcome and arriving home."
- Make them genuinely different: a literal action of the depicted object; a transformation (one part becomes another: a dot becomes the i's tittle, a line becomes the horizon); a brand-attribute feel (precise / playful / calm) applied to the same parts.
- Recommend one, then build it, unless the user already said what they want. In the director flow pass them as `concepts` (with `recommended`) to `propose_storyboard`; the user picks on the card.
- Personality decides the execution of the same metaphor: a door opens with `spring Gentle` for a cosy brand, with `Expo Out` and a hard light flash for a security brand.

## 3. Metaphor → motion library (recipes)
Pivot = `set_pivot` (or `update_layer` anchor + position so nothing moves). Rigs = `rig` presets when available. Times for a 2–3 s logo build.
- **Door opens** (house, home, entry, welcome, access): pivot at the hinge edge. Fake 3D: animate scale x 100 → 15–25 (`Cubic In Out` 0.6 s) while a darker inner rect (the opening) shows behind it; optional light: a warm rect/ellipse behind the door, opacity 0 → 100 and scale 80 → 110 as the door opens. `rig` "hinge"/"door-open". Then something comes out (wordmark slides from the doorway 0.1 s after).
- **Leaf grows from its stem** (eco, growth, health): stem path draws on (`trimEnd` 0 → 100, `Sine In Out` 0.6 s), leaf pivot at its base, scale 0 → 100 + rotation −25° → 0 (`spring Gentle`, starts when the stem is 70 % drawn), a tiny settle sway (rotation ±3°). `rig` "grow-from-base".
- **Sprout / plant rises; sun rises**: pivot bottom, scale y 0 → 100 then x catches up (stretch); the sun moves up on an arc behind a horizon line with a warm fill shift.
- **Wave flows** (water, sound, flow, ocean): position x Linear loop with `loopOut('cycle')`, or a sine expression on y with phase per segment (`index`); draw the wave line on first.
- **Rocket launches** (startup, speed, growth): anticipation — squash scale [108, 92] and 6 px down (0.15 s), then launch up with `Expo In` → out of frame or to its resting pose with `Expo Out`; flame flickers (scale y expression `100 + 15*Math.sin(time*40)`), small smoke circles pop and fade behind.
- **Lock clicks shut** (security, privacy): shackle drops 12–20 px with `Expo In` and a 2-frame overshoot (`Back Out` small), body shakes ±2 px for 0.1 s, a check/glint follows.
- **Key turns**: pivot at the key's bow center, rotation 0 → 90 with `Back Out`; the lock opens after.
- **Eye blinks** (vision, attention, watch): eye shape scale y 100 → 8 → 100 (0.08 s down `Quad In`, 0.12 s up `Quad Out`); pupil follows a point with a short delay. `rig` "blink".
- **Speech bubble pops with its tail** (chat, community, support): bubble scales from the tail tip (pivot at the tail), `spring Bouncy`; then three typing dots bounce in sequence (y −10 px, stagger 0.12 s, loop) before the text/wordmark appears.
- **Chat dots type**: three dots, y and opacity sine with phase per dot: `value + [0, -8*Math.max(0, Math.sin((time*2 - index*0.3)*Math.PI))]`.
- **Gear meshes** (engineering, process, tools): two gears rotate in opposite directions with speeds inverse to their size (`time*90`, `-time*90*r1/r2`), Linear; start with a short `Cubic Out` spin-up.
- **Flame flickers** (energy, passion, food): scale y and x wiggle at different frequencies (`wiggle(8, 6)` on scale), a slight rotation wiggle; color shifts between two warm hues.
- **Heart beats** (health, love, care): scale 100 → 112 → 100 → 106 → 100 over 0.8 s (`Quad Out` / `Sine In Out`), loop; a soft ring expands and fades on the first beat.
- **Arrow / path draws, then points** (direction, delivery, growth): the line draws on with `trimEnd`, the arrowhead pops at the end (`Back Out`), then the whole arrow nudges forward 8–12 px once.
- **Location pin drops**: falls from above with `Expo In`, squash on landing [115, 85], ripple ring expands under it.
- **Stacked blocks build up** (platform, data, infrastructure, construction): blocks drop one by one from above, stagger 0.1 s, each lands with a small squash; the stack settles.
- **Wordmark emerges from the mark**: letters slide out from behind the mark (the mark covers them; order left→right, stagger 0.03–0.05 s), or the mark rolls/moves aside to reveal them.
- **A dot becomes the i's tittle** (or the full stop, the umlaut): the dot bounces in on an arc and lands exactly on the i (`spring Quick`), the rest of the word is already there or follows.
- **Letter morphs / counters**: an "O" is a planet that orbits a moon; an "A" is a mountain the sun rises behind; a "C" opens like a mouth.
- **Liquid fills** (drinks, energy, progress, finance): a rect inside the container shape (masked by placement) rises from the bottom with `Cubic In Out`; the surface wobbles (sine on rotation ±3°). `rig` "liquid-fill".
- **Pages flip** (books, docs, education): page pivot at the spine, scale x 100 → −100 (`Cubic In Out` 0.4 s) with a fill darkening at the midpoint.
- **Magnifier scans** (search, insight): the lens moves on an arc across the mark/word, scaling what's beneath (duplicate at 120 % visible only inside the lens area) then settles.
- **Check draws on** (done, tasks, approval): the check path `trimEnd` 0 → 100 with `Cubic Out` 0.3 s, the circle around it scales in first with `Back Out`.
- **Play button morphs** (video, media, music): triangle → pause bars → triangle via shape morph (`morph`), or a rotating triangle that settles; a ripple ring on "press".
- **Paper plane flies in and lands** (send, mail, travel): flies on a curved path (sOut/sIn tangents), rotation follows the direction, lands with a little skid and settle (`spring Gentle`).
- **Envelope opens**: flap pivot at the top edge, scale y 100 → −100 (flip), a letter slides up out of it.
- **Globe / orbit** (global, network, "Orbit"): small satellites travel on an ellipse (a rotating parent group, Linear), the planet rotates slightly; `rig` "orbit".
- **Mountain / peak** (outdoor, achievement): line draws up the slopes from the bottom, a flag swings on its pole (pivot at the pole, `spring Wobbly`).
- **Cup steams** (coffee, warmth): 2–3 wavy lines draw on and drift up while fading, loop.
- **Lightbulb lights** (ideas): bulb fill shifts dark → warm with a hold-key flicker, rays scale out from the center.
- **Shield / badge stamps** (trust, quality): slams down from scale 140 with `Expo Out`, a 2-frame shake, a shine sweep crosses it.
- **Bird / wing** (freedom, delivery): wing parts rotate from the shoulder pivot (swing) twice, then the bird glides on an arc. `rig` "swing".
- **Unfold / origami / map**: panels rotate (scale x from an edge pivot) one after another. `rig` "unfold".
- **Draw then fill** (hand-made, craft, signature): outlines draw on (stroke, fill transparent), then fill fades/wipes in. `rig` "draw-then-fill".

## 4. Choreograph the concept
- One hero action carries the idea (the door opening); everything else supports it and comes after (wordmark, tagline).
- Anticipation before the hero action; follow-through after (the door swings 5° past and settles; the leaf sways).
- 2–3 s for a logo build, then hold ≥ 1 s on the finished lockup. The final frame is the exact brand lockup, unchanged.
- Keep geometry honest: parts end exactly at their original positions, rotations, scales and colours.

## 5. Anti-patterns (fix these when you see them)
- Generic pop / fade / scale-in applied to every part — the "PowerPoint build".
- Everything at once, or every part with the same ease and duration.
- Motion that contradicts the meaning: a door that scales from its center instead of swinging on its hinge; a leaf that drops from the sky; a rocket that fades in; a lock that bounces playfully for a bank.
- Animating the artwork without looking at it; animating "Path 1..12" without knowing what they are.
- Breaking the mark: parts left rotated/offset at the end, colours changed, the wordmark retyped in another font.
- Overloading: more than one metaphor fighting for attention in a 3 s logo.
