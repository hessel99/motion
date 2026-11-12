# Cutting motion to music
> Designing with a soundtrack: read the music first (tempo, bars, sections, accents), big moves on downbeats, accents on the hits, holds in breakdowns, energy that follows the sections, anticipation before the beat, phrases of 4/8 bars, loops on bar boundaries. Plus the audio tools and sound effects.

Motion cut to music feels inevitable: the eye sees a landing exactly when the ear hears the hit. It only works when the timing is exact (within a frame) and selective (not every beat).

## 1. Read the music first
- The editor context says when the comp has music (`music: … BPM, sections …`). Call `get_audio_analysis` once: BPM, beat and bar length, downbeats, sections with energy, the strongest hits (accents) and an energy strip per bar. Zoom into a passage with `from`/`to` for every beat (bar.beat labels) and onset.
- Write the plan in beats and bars, not seconds: "logo lands on the drop (bar 9.1), wordmark on 9.3, tagline on bar 11". At 120 BPM a beat is 0.5 s and a bar 2 s; at 90 BPM a beat is 0.667 s.
- Fit the comp to a phrase: end on a bar line (ideally after 4, 8 or 16 bars) or on the last hit. Never cut mid-bar.

## 2. Where moves go
- **Downbeats (beat 1 of a bar)** carry the big moves: the hero entrance, a scene change, a camera move landing. Bar 1 of a phrase (every 4 or 8 bars) is the strongest.
- **Accents** (the loudest hits: a drop, a crash, a snare fill end) get the moments that should *hit*: a logo landing, a flash, a type slam. `accents` in the analysis are sorted by strength; use the top few.
- **Backbeats (2 and 4: snares)** suit secondary hits: a word popping, a shape bouncing, a small scale punch.
- **Land on the beat, start before it**: the landing (end of the move, the contact of a bounce, the peak of an overshoot) is what must sit on the beat. A 0.4 s ease-out entrance landing on 2.0 s starts at 1.6 s. Anticipation (a small pull-back) goes in the 2-4 frames before the beat.
- **Don't hit every beat.** Hitting all of them reads as mechanical and tiring. Pick a rhythm: one move per bar in calm sections, per half bar in busy ones, per beat only in short bursts (a build, a drop), then rest.
- **Holds**: a held pose for a bar or two before a big hit makes the hit land. Silence or a breakdown = hold, slow drift, or a single slow move (`Sine In Out`, 2+ bars).

## 3. Energy follows the sections
| section | motion |
|---|---|
| intro | sparse, slow, small; establish the space; one element at a time, on bars |
| build | accelerate: intervals halve (bars → beats → half beats) toward the drop, scale/brightness rising, maybe a shake that grows (`place_on_beats` pattern `build`) |
| drop | the payoff: the hero move exactly on the drop's downbeat, the biggest scale / colour change, fast cuts on beats for 1-2 bars, then settle into a groove |
| breakdown | hold or float: long eases, little movement, soft colours; let the music breathe |
| main / verse | a steady groove: one gesture per bar, secondary pulses on backbeats |
| outro | resolve: elements leave in reverse order on bars, the end card holds through the last hit |

Match the easing to the sound: punchy drums → `Expo Out` / `Back Out` / `spring Bouncy`, soft pads → `Sine In Out` / `Ease In Out`, staccato → short holds and cuts.

## 4. Phrasing and loops
- Music is phrased in 4 and 8 bars; so is the motion: a new idea every 4 or 8 bars, variations inside the phrase.
- A loop must be a whole number of bars long (1, 2, 4) and start and end on a downbeat; loop expressions (`loopOut('cycle')`) with a cycle length of one bar.
- Staggers can be musical: 1/8 or 1/16 notes (beat / 2, beat / 4) instead of arbitrary 0.07 s.

## 5. Tools
- `sync_to_audio` (mode `beats`, `bars`, `accents`, `sections`): retimes existing keys so starts, landings and overshoot peaks move to the nearest strong beat; everything else stretches with them (key order, eases and the relative timing are kept). One undo step. Use it after blocking, then fine-tune.
- `place_on_beats`: pattern (beat, half-bar, bar, two-bars, accents, build); moves each layer's animation so layer i starts (or lands, `anchor: "land"`) on pattern time i.
- `audio_reactive`: a property follows the music live, e.g. a background's scale pulsing with the kick: band `low`, amount 6, smoothing 0.12. Bands: `low` (kick, bass), `mid`, `high` (hats), `amp`, `beat` (a decaying pulse on every beat), `bar` (on downbeats), `accent` (on the strongest hits). It is the expression `value + amount * audio('low', 0.12, 0)`; write it yourself with `set_expression` for anything fancier, e.g. `value + [8, 8] * audio('beat', 0.1)` or a colour flash on accents. Keep reactive motion subtle (2-8% scale, a few px): it supports the choreography, it is not the choreography.
- Markers: `set_markers` for named moments ("drop", "hook").

## 6. Sound effects (only when the user asks)
- Never add sounds unprompted. When asked: `list_sfx_families`, choose ONE family from the brand traits (crisp-ui for product UI, soft-warm for friendly lifestyle, playful for kids/games, cinematic for launches, glitchy-tech for cyber, minimal-luxury for premium, organic-wooden for natural brands), offer `preview_sfx` for 2-3 candidates when the user wants to choose, then `add_sound_effects` (density 0.3-0.6). Swap later with `set_sfx_family`.
- Rules the tool applies: one sound per moment, the most important event wins, whooshes lead into landings, sounds snap to the beat and sit under the music.

## 7. Checklist
- Every hero landing within one frame of a downbeat or accent (check with `get_animation` times against `get_audio_analysis`).
- At least one hold or calm passage; not every beat used.
- Biggest move on the drop / strongest accent.
- Comp ends on a bar line or the last hit; nothing still moving after the music ends.
