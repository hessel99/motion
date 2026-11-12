# Motion UX patterns: timing you can feel

## Vision

Most motion tools still describe timing the way 1990s compositors did: speed and influence
numbers (After Effects), a value graph, a 200 px bezier box with two handles. These are precise,
but they are the wrong first language. Animators think in **feel** (lazy, snappy, silky,
springy), **spacing** (where the ball is on each frame), **rhythm** (how layers follow each
other, how they sit on the beat) and **performance** (show it with your hand).

Motion should offer those as its main controls, with the numbers one click away for precision.
Three rules:

1. **Direct and physical.** Pads, knobs and gestures with detents and inertia, in the spirit of
   Teenage Engineering hardware and Arc's grain/knob color picker. One gesture should replace a
   paragraph of numbers.
2. **Preview on the real thing.** Hovering a choice plays it on *your* layer in the canvas
   before you commit. No abstract preview boxes.
3. **Every control reads the document.** Knobs show what is there (the stagger and groove are
   detected from the keys), so they never drift out of sync. Every gesture is one undo step.

## Pattern ideas, ranked

Impact = how much it changes daily work for a motion designer. Effort = engineering in this
codebase (S < 1 day, M = days, L = a week or more).

| # | Pattern | What it is | Impact | Effort | Status |
|---|---|---|---|---|---|
| 1 | **Feel pad** | 2D field: x = attack (lazy to punchy), y = smoothness (linear to silky), plus an overshoot knob. The background "grain" is a field of tiny curves, so you see where you are going. | High | S | **Built** |
| 2 | **Live swatches + A/B lane** | Hover (or Tab to) an ease and the selected layer plays it on the canvas; a spacing lane races the current ease (A) against the hovered one (B). Click applies. | High | S | **Built** |
| 3 | **Rhythm knobs** | Tempo ("breath": stretch the whole selection's timing), Stagger (seconds between layers) and Groove (rush or build the cascade). With the magnet on, they snap to markers and beats. | High | S | **Built** |
| 4 | **Perform (gesture recording)** | Act out the motion with the mouse while the playhead runs. You get a few clean keys with fitted eases and smooth spatial tangents. | High | M | **Built** |
| 5 | **Spring knob with detents** | A bounce knob that clicks into the named springs (Gentle, Quick, Bouncy, Wobbly), with an LED ring and the spacing lane as feedback. | Med | S | **Built** |
| 6 | Easing by example | Pick any animated layer, Lottie or video clip as a reference; its progress curve is fitted into an ease (`fitBezier` in `perform-math.ts` already does this). | High | M | Math done |
| 7 | Velocity paint | Paint speed over time on a strip (thick = fast); the keys and eases are solved from it. It works the way a spacing chart is drawn. | Med | M | Idea |
| 8 | Beat grid magnet everywhere | Keyframe drags, layer bars and rhythm knobs snap to audio beats, with a visible "groove" grid in the timeline. | High | M | Partly (rhythm knobs use markers) |
| 9 | Flick to set bounce | Throw the preview ball: release speed sets the spring's energy, and its decay sets the damping. | Med | S | Idea |
| 10 | Ease families across a scene | "Make everything in this comp feel snappier": shift every ease in the selection along the feel pad at once, keeping their differences. | High | M | Idea (feel space makes it trivial) |
| 11 | Onion-skin spacing on canvas | Ghost the layer on every N-th frame directly in the viewport while editing an ease. | Med | M | Idea |
| 12 | Timing scrub with haptics | Scrubbing slows down and gives a tick (sound or vibration) on keys, markers and beats. | Low | S | Idea |
| 13 | Breath for loops | A tempo dial that keeps loops seamless by snapping the loop length to whole beats. | Med | S | Idea |

## What is built

All of it lives in `src/ui/patterns/`. Only a few lines of the existing UI changed: the
Inspector imports two components and hides its classic preset chips while the studio is on, and
`Store` gained `notifyPreview()`, a redraw-only notification for transient previews.

### Ease studio (inspector, Easing section, when keyframes are selected)

`EaseStudio.tsx`, `FeelPad.tsx`, `Knob.tsx`, `feel.ts`, `draw.ts`, `ops.ts`

- **Tabs: Feel, Spring and Curve.** The Curve tab shows the classic bezier editor plus the
  AE-style influence fields. The **Studio** pill in the section title turns the whole studio
  off and brings back the classic panel; the choice is saved in localStorage.
- **Feel pad** (a canvas).
  - The mapping in `feel.ts` blends known curves. The corners are Expo In, Expo In Out and
    Expo Out, and the bottom edge is linear, so every point of the pad is a curve a designer
    already knows.
  - Overshoot adds anticipation on lazy curves and overshoot on punchy ones, the way the Back
    family does.
  - The inverse mapping compares *sampled motion* rather than handle positions. Back Out
    (which overshoots through y1) therefore lands in the overshoot region even though the feel
    family overshoots through y2.
  - Arrow keys move the puck (shift = coarse). Nudges within 700 ms form one undo step.
- **Overshoot and Bounce knobs.**
  - The LED ring shows the value; drag up or right to turn (shift = fine). The wheel and the
    arrow, Home and End keys also turn it, and Backspace or a double-click resets it.
  - Detents act as magnets and flash when the knob clicks in.
  - Each gesture hands out a merge key, so a turn is one undo step.
- **Spacing lane.** An animator's spacing chart: the ball's position at equal time steps, so
  bunched dots mean slow and spread dots mean fast. A live ball stretches with its speed. While
  a swatch is hovered, lane B races lane A.
- **Live swatches** (9 curves and 4 springs).
  - Hovering or focusing a swatch swaps the keyframe arrays in place: no transaction and
    nothing on the undo stack (`EasePreview`). The renderer is told through `notifyPreview`,
    and the playhead loops over the eased segments, so the real layer plays the ease in the
    viewport.
  - Leaving the swatch, pressing any key or unmounting restores the same array objects (a test
    checks that the document JSON and the history are unchanged). Click or Enter applies.
- **Cost.**
  - The pad background (gradient plus grain) is drawn once into an offscreen canvas and is
    rebuilt only when overshoot changes. The pad itself redraws only on input.
  - Lanes and swatches share one rAF ticker (`ticker.ts`) that stops when nothing is
    subscribed. Only the hovered swatch animates.
  - The feel inverse uses a lazily built table of sampled curves (21×21×11×16 floats) plus
    coordinate refinement. It runs only when the selected ease changes.

### Rhythm (inspector, for selected layers)

`RhythmPanel.tsx`, `timing.ts`, `ops.ts`

- **Tempo**: the selection's total animation length, on a log knob. Turning it rescales every
  key (props and path keys) around the first key, so the motion breathes slower or faster with
  the same shape. Key order is kept, so key selections stay valid.
- **Stagger**: seconds between layer starts, in start order. Each layer keeps its internal
  timing, and starts are rounded to frames.
- **Groove**: bends the cascade. Positive values *rush* (fast at first, then settle); negative
  values *build* (slow at first, then accelerate). The knob detects the current stagger and
  groove from the keys with a least-squares fit, so it always shows the truth.
- **Magnet**: starts (stagger) and the end (tempo) snap to timeline markers within 80 ms. With
  **Audio → Add markers on beats**, that puts a cascade on the beat in one turn.
- A **sequencer strip** shows one bar per layer plus marker ticks, and updates live while you
  turn.
- Every knob turn works from a snapshot taken when the gesture starts, so there is no drift.
  The whole turn is one undo step.

### Perform (inspector, Rhythm section, single layer)

`perform.ts`, `perform-math.ts`

- Press **Perform**, then press anywhere on the canvas and move.
  - The layer follows your hand relative to where you grabbed it, through a transient preview.
  - The playhead runs in real time, so you perform *against* the rest of the animation.
  - A trail with dots every 4 frames shows the rhythm of your hand.
  - Release to keep the result, Esc or right-click to cancel. Recording stops at the end of
    the comp.
- The samples are reduced in three steps:
  1. Ramer–Douglas–Peucker in space finds where the path bends.
  2. Recursive splitting adds a key wherever one bezier ease cannot follow the hand's timing
     (stops, sudden pushes).
  3. Each segment's ease is fitted with least squares to the progress along the drawn path.

  Catmull-Rom spatial tangents keep the path smooth. Tolerances are in screen pixels, so the
  result does not depend on zoom.
- Only the position keys inside the performed time range are replaced, as one undo step
  ("Perform motion").

### Tests

`tests/patterns.test.ts` (21 tests) covers:

- the feel mapping: corners, continuity, monotonic attack, overshoot sign, round trip, and
  where standard presets land;
- the stagger, groove and tempo math, plus magnetic snapping;
- that a stagger or tempo drag is one undo step;
- that `easedKeys` matches `setEase`;
- that a hover preview leaves no trace;
- gesture fitting: a straight eased stroke gives 2 keys with the right ease, a stop gives a key
  at the stop while jitter adds none, and a circle gets smooth tangents.

## Why this beats the industry standard

| Task | After Effects / Figma Motion | Motion |
|---|---|---|
| "Make it snappier" | Open the graph, drag tiny handles, or type speed/influence numbers | Drag the puck right and up; the curve grain shows the target |
| Compare two eases | Undo/redo while playing | Hover: A vs B lanes plus the real layer playing B |
| Stagger 12 layers | Select them, then use a script, or offset layers by hand | Turn one knob; turn Groove to shape the cascade; the magnet lands them on beats |
| Retime a whole move | Alt-drag the last key of each property and hope | Turn Tempo; every property keeps its shape |
| Rough a motion path | Set keys frame by frame, then fix the tangents | Perform it once and get ~5–10 clean keys with fitted eases |

## Extending the language to future features

The same three primitives (**pad**, **knob with detents**, **spacing lane / live preview**)
cover most of the controls we will need:

- **Motion blur → "Shutter" dial.**
  - A knob from 0° to 720° with detents at 180° (film) and 360°.
  - The LED ring doubles as a shutter-angle wedge.
  - Hovering the detents previews the blur on the canvas through the same transient-preview
    path (`notifyPreview`).
- **Wiggle / noise → "Energy × Texture" pad.**
  - x = frequency (calm to jittery), y = amplitude.
  - The grain shows tiny noise strokes.
  - It writes `wiggle(f, a)` expressions.
- **Camera / 3D → "Lens" knob** with detents at 24, 35, 50 and 85 mm, plus a dolly-zoom gesture
  on the canvas (performed like Perform).
- **Text animators → Rhythm knobs per unit.** Stagger and groove map directly onto
  `TextAnim.stagger` and the unit order.
- **Color transitions → "Temperature" pad** for gradient shifts (hue drift vs saturation), using
  the same preview-on-hover swatches.
- **Audio → the magnet becomes global.** Beats feed every snapping control. Tempo can lock to
  BPM ("stretch to 2 bars").
- **Agent integration.** Feel is a small, perceptual vocabulary (`attack`, `smooth`,
  `overshoot`), which makes it an ideal tool surface for the AI agent ("make the intro lazier,
  the outro snappier").
