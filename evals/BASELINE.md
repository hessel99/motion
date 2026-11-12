# Agent baseline — 2026-11-12

First full run of the eval harness (`scripts/agent-eval.mjs`) on the current agent: 37 MCP tools, the
~600-word `AGENT_SYSTEM_PROMPT`, Claude Code CLI through the bridge, **model `sonnet`** (claude-sonnet-5-5),
one run per brief, concurrency 3, seed 1. Judge: `opus` (claude-opus-5-5), rubric in `evals/judge.md`.
Raw results: `evals/results/2026-11-12/` (per brief: `video.mp4`, `contact.jpg`, `document.json`, `tools.json`,
`transcript.json`, `timeline.txt`, `metrics.json`, `judge.json`; plus `summary.md/json`, `calibration.json`).

## Numbers

| | |
|---|---|
| Judge overall (mean of 6 criteria, 1–10) | **5.24** — brief fit 6.0, style 5.81, timing/easing 5.31, composition 5.81, **richness 4.19**, **polish 4.31** |
| Best / worst | 03 toggle 6.17, 09 playful 6.0 / 01 logo 4.33, 15 luxury 4.67, 06 loop / 12 hand-drawn / 16 reference 4.83 |
| Machine checklist | 92% of checkable items (presence checks: they pass easily, the judge is the discriminating signal) |
| Tool errors | **0** of 330 calls (the failures below are silent, not errors) |
| Per brief | mean **52 s** wall (19–104 s), 21.6 turns, 20.6 tool calls, **$0.13** (range $0.05–0.25), 47k–252k input tokens (mostly cache reads) |
| Suite | agent $2.12, judge $0.98, ~7 min at concurrency 3 |

Judge consistency (`calibration.json`, same inputs judged twice on 01/07/13): 89% of criterion scores identical,
100% within 1 point, overall spread 0.11 on average (max 0.17). An earlier 3× calibration (before the final judge
input format) gave overall spreads 0.33 / 0 / 0.5. So a single-brief delta under ~0.5 is noise; the suite mean is
stable to ~0.1. Note this measures judge noise only: agent run-to-run variance needs `--repeat 2+`.

## Top failure classes (ranked by impact)

### 1. Missing visual primitives: no gradient, blur/glow, shadow, mask/clip or blend from the agent
Every style brief needs at least one of these and the agent can't reach any of them: across 16 documents there are
**0 gradient fills, 0 masks/clips, 0 blend modes, 0 effects** (the editor has gradient paints, masks, clip and
blend modes; the tools don't expose them). The agent fakes them and says so:
- 06 loop bg: "Each is a stack of concentric low-opacity circles, which fakes a blur … the editor has no blur
  effect". Judge: "hard-edged concentric target rings with visible stepped banding" (35 layers, 65 calls for it).
- 16 reference: gradient band built as 3 flat rects that leave a white wedge; "I didn't build a clip mask, so the
  lines fade in instead of emerging"; "I can fake the card shadows with soft offset rectangles" → style 4.
- 13 parallax: "I could only fake the sky gradient with two overlapping rectangles, since layers take a single fill".
- 01 logo: "The wordmark isn't masked behind the ring" (brief: slides out from behind the mark).
- 10 lower third, 11 glitch (sun-gradient stripe, CRT glow) same story.
**Fix**: `set_fill` with linear/radial gradients, drop shadow / glow / blur (effects), `set_mask`/clip-to-parent,
blend modes in `add_layer`/`update_layer` — or one declarative `build_scene` that covers them.

### 2. Silent no-ops: draw-on (trim paths) never renders
Trim keys are accepted on any layer but only render on a **path with `trimOn`**, which no tool can set.
5/16 briefs keyed trims that do nothing (`metrics.deadTrimLayers`): 01 (Mark Ring ellipse + Mark Slash path),
03 (Check), 04 (Check), 10 (Accent Line), 12 (wheat stem, grains, loaf outline, loaf scores). The hero beat
of 01 and 12 and the opening of 10 are dead air; the judge noticed every time ("the trim-path animation isn't
rendering"), the agent never did — its single contact sheet showed fully drawn strokes and it moved on.
**Fix**: turn trim on automatically when trim props are keyed on a path; error (with the fix) on non-paths, or
convert ellipse/rect to a path; plus a "draw on" preset. Audit for other accept-and-ignore inputs.

### 3. No critique → fix loop: it looks once, then stops
15 of 16 runs called `contact_sheet` exactly once (one run twice), always as the last step, and then ended the
turn. Mean turn is 52 s. Visible defects in its own contact sheet stayed: dead draw-ons (class 2), floating bars
(05), phrase collisions (02: P1 × P2 text overlap 0.27 s), cards butting edges (16), an orb pile-up (06).
The brief's duration was even overridden: 07 set the comp to **7 s instead of the briefed 10 s** and all motion
ends at 4.4 s (2.6 s dead hold).
**Fix**: a rubric-driven self-critique step (render → inspect → fix, capped), analysis tools that flag problems
in text (`check_frame`: off-canvas, overlaps, dead layers; `inspect_motion`: holds, dead time), and a prompt rule
to keep the brief's comp settings.

### 4. Generic easing: "Easy Ease" by default, almost no springs/overshoot
Easy Ease is the most used ease (176 of ~620 moving segments) because it's what you get when no ease is passed.
It is the *only* ease in 13 parallax (18/18), 14 neo-brutalist (10/10, brief: "slap on with a quick rotation snap
and overshoot" → judge: "the stickers glide in instead of slapping on", timing 4) and 02 kinetic type (9/9).
Springs appear in 1 brief (09), Back Out on 3 segments in the whole suite. 13's "camera push" is one identical
0–8 s Easy Ease on every plane ("reads as a mechanical zoom"). Hand-rolled overshoot in 03 (Quad In into the
peak, Quad Out back) "reads as a ricochet off a wall".
**Fix**: style → easing vocabulary in the knowledge layer (snappy/bouncy/smooth/mechanical recipes), make the
default ease an explicit choice (or warn), spring/overshoot presets on `animate`, per-layer variation helpers.

### 5. Building at too low an altitude (one layer per call, one call per turn)
Turns ≈ tool calls + 1 in every run: no batching, no parallel calls. 06 took 65 calls (31 `add_layer`,
14 `set_expression`, 8 `duplicate_layers`, 8 `update_layer`); 04 took 22 `add_layer` calls; 14 took 21.
Time and tokens go into plumbing instead of richness (richness is the lowest criterion, 4.19), and complex
briefs come out thin: 04's 3-beat explainer is 6 small notes in a mostly empty frame; 07's "energetic transitions"
are hold-cut opacity pops.
**Fix**: `build_scene` (declarative layers + keys + styles in one transaction, idempotent ids for refinement),
`add_layers` batch, arrangement/stagger/choreography helpers (grid, radial, center-out, wave).

### 6. Geometry and layout pitfalls: anchors, growth direction, collisions
- 05 bar chart: bars are keyed with `size` 0→h plus `position`, but the anchor stays where it was set, so bars
  grow from a fixed point instead of the baseline — "slabs floating mid-air" at 1.63/2.17/2.73 s (the checklist
  "bottom edge fixed" check fails).
- Text collisions while phrases hand over: 02 (P1×P2, P2×P3, P3×P4), 04 (password labels), 09 (letters).
- 16: cards' edges exactly butt each other; 13: the title floats in empty sky instead of between depth planes.
**Fix**: "grow from edge"/anchor helpers (`set_anchor: bottom`), layout helpers, and the analysis tools from
class 3 (overlap/collision report per time range) so the agent can see it.

### 7. Typography: fonts silently fall back, tracking can't animate, few text animators
- Requested fonts that don't exist render in a fallback with no warning (`metrics.missingFonts`): 15 luxury
  (Cormorant Garamond, Georgia) → "ÉCLAT renders as a thin sans in every frame", style 4; 12 (Georgia), 11
  (Arial Black), 09 (Arial Rounded MT Bold). Only Inter is bundled; the agent has no font list.
- 15: "letter-spacing can't be keyframed here" → tracking-tighten faked with a 105→100 scale.
- Text animators were used in only 5/16 runs; emphasis inside a line needs separate layers.
**Fix**: `list_fonts` + error/warning on unknown families (or bundle a small serif/display/mono set), animatable
letter spacing, per-range styling and more text-animator presets (by-line mask reveal, tracking in).

### 8. Weak structure over time: no scenes, no secondary motion, dead endings
- 0/16 runs used precomps; scenes/beats are hand-timed on flat layer lists. 13's parallax rig is per-layer keys
  with the same ease, no camera/null.
- Motion often stops early: 07 ends at 4.4 s of 7 (and 10 briefed), 05 at 3.5 s of 6 (2.5 s static), 08's second
  half is a blinking square; 11 is "completely static between bursts".
- Secondary motion (idle drift, follow-through, overlap) is rare; 09's jostle/idle wiggle is phase-locked on every
  layer ("copy-pasted").
**Fix**: director workflow (storyboard beats with durations before building), beat/scene helpers on precomps,
camera/parallax rig, loop and idle-motion helpers (offset phases), end-hold rules in the handbook.

## What already works
- Zero tool errors; schemas and error texts are clear enough that the agent never tripped.
- Simple, well-scoped briefs land: 03 toggle (6.17), 09 playful (6.0, springs + squash on 11 layers).
- Expressions are used well when the agent thinks of them: seamless loop via `cos/sin(2π t/6)` (06 loops
  perfectly, `loopDiff` < 0.01), 12fps boil with `floor(time*12)` (12), bobbing cards (16), wiggle jitter (04).
- Cheap and fast: $0.13 and under a minute per brief on sonnet — there is room to spend more on quality
  (critique loop, stronger model for directing).

## Caveats
- One run per brief; agent variance is not measured yet (use `--repeat 2` on a subset before trusting deltas
  smaller than ~0.5 per brief).
- Headless Chromium has no system fonts: fallbacks may be milder in the desktop app (Georgia exists on macOS),
  but Cormorant Garamond / Arial Rounded would still fall back, and the agent can't know either way.
- The machine checklist mostly tests presence; it is a regression guard, not a quality score. Two checks were
  made stricter after this run (trim must actually render; serif font must actually load).
- The owner's subscription reported `seven_day` utilization 0.87 (`allowed_warning`) during the run.
