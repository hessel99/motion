# Build plan: the agentic motion tool

Goal: an agent inside Motion that can design **complex, stylistically distinct motion pieces** from a brief
(and iterate on them with the designer), and is clearly better at this than pointing a general coding agent at the files.

## Where we are (Nov 2026)

- 37 MCP tools (layers, keys, easing, presets, text animators, expressions, precomps, styles, components,
  smart animate, contact sheet, variations, retime/stagger), ~600-word system prompt, Claude Code CLI via the
  local bridge, review cards with revert/compare.
- Works for simple briefs (logo pop-in, staggered cards). Breaks down on: multi-scene pieces, a recognisable
  *style*, custom shapes/illustration, rich typography, secondary motion, judging its own result.

## Why a general coding agent isn't enough, and what makes ours better

1. **Domain tools at the right altitude**: one call builds a whole scene / a choreography, not 200 low-level edits.
2. **Motion knowledge built in**: principles, timing tables, style recipes, so it doesn't have to rediscover craft.
3. **It can see and measure motion**: frames over time, velocity/spacing curves, overlaps, off-frame, collisions,
   not just a single screenshot.
4. **A real design loop**: brief → storyboard → blocking → timing → polish → critique, with checkpoints the
   designer can review, branch and revert.
5. **Measured**: an eval suite tells us if a change made the agent better.

## Workstreams

### 1. Eval harness (first: everything else is measured against it)
- 15–20 briefs across complexity and style: logo reveal, kinetic typography, UI micro-interactions, an explainer
  scene with 3 beats, data/chart animation, a looping background, a product promo, "Swiss/brutalist",
  "playful bouncy", "corporate smooth", "glitch/retro", "hand-drawn organic", "3D-ish parallax", a style matched
  from a reference description.
- Runner: real agent turns headless, fixed seeds, records tool calls, errors, turns, time, tokens, cost.
- Outputs: MP4 + contact sheet per brief, a judge rubric (brief fit, style match, timing/easing quality,
  composition, complexity, polish, technical errors), scored by a vision model, plus automatic checks.
- Baseline today, then every change is compared (regressions flagged).

### 2. Tools at a higher altitude
- `build_scene`: declarative scene spec (layers, groups, shapes, text, styles, keyframes, eases, stagger,
  expressions) applied in one transaction; idempotent ids so it can be refined.
- Shape/illustration tools: SVG path input, boolean ops, primitive library (icons via Lucide paths, blobs,
  arrows, badges), draw-on (trim), morph between shapes.
- Choreography tools: arrangements (grid, radial, along path), stagger patterns (center-out, random, wave),
  follow-through / overlap helpers, loop helpers, camera/parallax rigs (precomp + nulls), beat alignment.
- Typography: per-character/word/line animators with styles, text on path, responsive text boxes.
- Analysis tools: `inspect_motion` (per-layer velocity/acceleration curves, peaks, overshoot, holds),
  `check_frame` (off-canvas, overlaps, contrast, safe areas), `timeline_summary` (compact score of the piece).
- Render tools: short video/GIF previews and frame strips at chosen times, cheaper than many screenshots.

### 3. Knowledge
- Motion design handbook (compact, retrieval-friendly): 12 principles applied to UI/brand motion, timing tables
  (durations by distance/size), easing vocabulary to our presets/springs, spacing and overlap rules, loops,
  hierarchy and focus, typography motion, transitions between scenes.
- Style library: 15+ named styles, each a recipe (palette, shapes, type, easing family, timing, signature moves,
  do/don't) the agent can apply or blend; extensible by the user ("save this as a style").
- Cookbook: worked examples with exact tool calls for common pieces.
- Loaded on demand (a `get_guide` tool / MCP resources) so the base prompt stays small and cacheable.

### 4. Agent workflow
- Director mode: for bigger briefs the agent writes a storyboard (beats, durations, style), shows it as a card the
  designer can edit, then builds beat by beat with a check after each.
- Self-critique loop: render → inspect → fix, with a cap; rubric-driven.
- Iteration on selection: "make this more X" applies to the selected layers/keys only.
- Variations in parallel (A/B/C) via subagents for exploration briefs.
- Checkpoints: each beat is one undo group; the review card shows them.

### 5. Chat UX
- Plan card (storyboard) with editable beats; progress per beat; inline video previews; tool steps folded.
- Follow-ups referencing what's on screen (@layers, selected keys, timeline range).
- Style picker and reference input (describe or paste a reference; later: image references).
- Clear cost/time indication; stop/continue.

### 6. Runtime
- Model choice per task (fast model for small edits, strongest model for directing); prompt caching of the
  stable prefix; parallel tool calls; turn budget per brief; subagents for variations.
- Reliability: schema-validated tool inputs with helpful errors, no silent no-ops, idempotent builds.

## Phases

1. **Measure**: eval harness + baseline on the current agent. Fix the top failure classes found.
2. **Power**: `build_scene`, shape/typography/choreography tools, analysis tools, cheap previews.
3. **Craft**: handbook + style library + cookbook on demand; director workflow; self-critique loop.
4. **Experience**: plan card, inline previews, style picker, iteration on selection, variations.
5. Repeat: every change re-runs the eval; target: clear wins on complex and style briefs vs. baseline and vs.
   a plain Claude Code session editing the project JSON.

## Success criteria
- Eval score up substantially on complex/style briefs; zero tool errors on the suite; fewer turns per brief.
- A designer can get a 10–15 s multi-beat piece in a named style from one brief, then refine it in chat.
