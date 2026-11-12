# The taste layer

> Quality that comes from the app, not from the model or the user. Someone with no motion-design
> experience, on any CLI provider (Claude, Codex, Gemini) and any model, should get a piece that a
> senior motion designer would at least not wince at.

The taste layer has four parts, all shipped with the app and owned by us (the tool owner):

| part | where | what it does |
|---|---|---|
| **Motion critic** | `src/agent/critic.ts` | deterministic checks over the document → score 0–100, sub-scores, a prioritised list of concrete fixes with the exact tool calls |
| **Automatic polishing loop** | `src/agent/taste.ts` (`polishPlan`), `src/ui/AgentPanel.tsx`, `update_progress` | after a build (and after each storyboard beat) the critic's worst fixes go back to the agent as a follow-up, max 2 rounds |
| **Quality-first defaults** | `src/agent/taste.ts`, `tool-kit.ts` (`buildKeys`), `tools-scene.ts` (`build_scene`), `taste-defaults.ts` (`apply_preset`) | when the model leaves timing / eases / stagger out, the tools pick them from the handbook tables |
| **Gold examples** | `src/agent/guides/examples/*.md`, `get_guide {name: "examples", brief}` | 13 proven briefs → exact tool-call sequences → why they work; the closest 1–2 are retrieved per brief |

Setting: **Settings → Models → Directing → Polish automatically** (on by default; storage key
`motion.agent.taste`). Off = no polishing rounds, the tools' old defaults, and the system prompt's plain
self-critique line instead of the critique/examples lines (`AGENT_SYSTEM_PROMPT_PLAIN`); the `critique` tool and the
examples are not advertised.

## 1. The motion critic

`critique(store, { range?, loop?, fontOk?, max? })` samples the active composition (12 samples/s, 24–120
samples) in one pass per sample (parents before children, typed arrays, no renderer), then runs the
rules below. Typical documents take 2–25 ms in the browser (the 13 gold examples: 2–41 ms in the browser; the
136 eval documents in Node: 12–25 ms best-of-6 on a loaded machine, single runs up to ~100 ms under CPU
contention; `tests/critic.test.ts` asserts < 50 ms on a 41-layer document). It is also the read-only `critique` tool (`from`/`to`
limit it to a beat).

Output: `score` (0–100), `sub` (100 minus the penalties per category), `penalties`, and `issues` worst
first: `{ rule, severity: high|medium|low, category, message, layers, t: [from, to], fix: [{tool, args}] }`.
`formatCritique` turns it into the compact text the agent reads:

```
score 41/100 (easing 64, choreography 70, readability 9, composition 70)
1. [high] "P2" and "P3" overlap for 0.5 s (3.17s–4.67s): let the outgoing text clear (or move apart) before the next arrives
   → retime {"ids":["l_qysep"],"offset":0.55}
2. [high] 100% of 9 moves use Easy Ease (the default): give entrances a decelerating ease, exits an accelerating one, accents a spring/overshoot
   → set_easing {"id":"l_3","prop":"position","indices":[0],"ease":"Expo Out"}
```

### What it checks (rule id → category)

| rule | category | the check (numbers from `guides/handbook.md`) | fix it proposes |
|---|---|---|---|
| `hard-stop` | easing | a position/scale/rotation/size move ≥ 24 px (8 %, 10°) arrives at full speed (linear or ease-in arrival, end slope ≥ 0.6 of average) and doesn't continue; gravity impacts (a squash starts at the landing, or a fall after a hop) and long drifts/spins are exempt | `set_easing` Expo Out (entrance) / Cubic In Out |
| `monotone-ease` | easing | ≥ 85 % of ≥ 6 moves share one ease (high when it is the default Easy Ease / Linear) | `set_easing` on the entrances |
| `entrance-ease` | easing | ≥ half of the entrances don't decelerate (start slope not ≫ end slope) | `set_easing` Quart Out |
| `exit-ease` | easing | exits that decelerate away | `set_easing` Cubic In |
| `all-at-once` | choreography | ≥ 4 entrances (or all of ≥ 3) start within 40 ms | `choreograph` sequential, hero first then reading order, 0.08 s (≤ 0.5 s total) |
| `lead-late` | choreography | the hero (largest element; big type counts) enters after ≥ 3 smaller non-text elements | `retime` the hero earlier |
| `slow-stagger` | choreography | a cascade of ≥ 3 like layers with step > 0.22 s (small items) or > 1.2 s total; text animators slower than 0.08 s/char, 0.2 s/word | `choreograph` with the handbook step / `set_text_animation` |
| `uniform-stagger` | choreography | ≥ 6 identical moves on an exact metronome | `choreograph` wave |
| `timing-range` | timing | a move's duration vs `0.25 s + distance/2000 px` (scale entrances by size: ≤ 120 px 0.32 s, ≤ 400 px 0.55 s, else 0.8 s), outside 0.4×–3× (4× for springs/overshoot: slow is often a style); < 2 frames | `retime` around the move's start |
| `end-hold` | timing | nothing moves for the last > max(2 s, 30 %) | a slow 4 % push on the hero through the hold (`animate` scale, merge) |
| `dead-time` | timing | > 2.5 s with no motion in the middle | `retime` with `from` (pull the rest earlier) |
| `late-start` | timing | first motion after 0.6 s | `retime` offset |
| `past-end` | technical | keys after the comp end | `retime` earlier |
| `read-hold` | readability | a text layer is fully readable (opacity ≥ 0.8, revealed, on canvas) for less than `0.3 s + words / 3.5` (min 0.6 s) | `retime {from: exit start, offset}` (delay the exit) or move it earlier |
| `text-collision` | readability | two different texts overlap > 12 % of the smaller box for ≥ 0.1 s (split letters excluded) | `retime` the later one |
| `covers-text` | readability | an opaque shape drawn above text covers > 30 % of it for ≥ 0.25 s | (judgement) |
| `contrast` | readability | WCAG contrast of text at rest against the composited fills behind it < 4.5 (3 for ≥ 24 px) | `update_layer` fill with the best palette ink |
| `off-canvas` | composition | 12–97 % outside the frame while at rest (≥ 0.4 s) or in the last frame; full-bleed layers exempt | `update_layer` position / `set_keyframes` shifted |
| `safe-area` | composition | text outside the 90 % title-safe area | same |
| `grow-middle` | composition | a one-axis scale/size growth where neither edge stays fixed (bars growing up *and* down) | `set_pivot` bottom/left, or matching position keys |
| `no-secondary` | polish | ≥ 3.5 s with no overshoot, spring, expression, follow-through keys or animated parents | `secondary_motion` 8 % on the hero + followers |
| `fade-only` | polish | ≥ 60 % of the animated layers only fade | `apply_preset` Slide up |
| `loop-seam` | polish | (loop pieces: comp named "loop", closed key tracks, periodic expressions without other keys) a property differs between 0 and the end | `loop` cycle |
| `one-move` | richness | ≥ 75 % of the animated elements move exactly once (an entrance) and stop, nothing overshoots (≥ 4 s) | `secondary_motion` on the hero and followers |
| `copy-paste` | polish | ≥ 3 same-size layers (≥ 40 % of the movers) run the identical animation (props, durations, eases, distances; only offset) or the same expression without `index` | `retime` every other one 1.25× |
| `default-fill` | polish | a visible shape still has the editor's default blue fill | `update_layer` fill (transparent behind a stroke) |
| `thin` | richness | fewer elements / moves than the length needs (≥ 4 elements up to 6.5 s, 6 up to 12 s; ≥ 1.2 non-fade moves per second) | `secondary_motion` |
| `invisible` | technical | a layer is never visible (opacity/scale 0 or off-frame throughout) | `delete_layers` |
| `dead-trim` | technical | trim keys on a layer where they can't render (not a path / Trim off), or a draw-on of a zero-width stroke | `draw_on` / `update_layer` stroke |
| `font-fallback` | technical | the first font family doesn't render (canvas measurement in the app; the eval probe's map offline) | `update_layer` text font Inter / serif |
| `palette-drift` | brand | > 5 distinct accent colours | (judgement) |
| `off-brand` | brand | ≥ 2 layers use colours not within 0.08 of a project colour style (when styles exist) | `link_style` to the nearest style |
| `font-drift` | brand | > 2 font families | `update_layer` font |
| `off-beat` | music | (music present) < 50 % of the big moves land within 1.5 frames of a beat | `sync_to_audio` beats |
| `every-beat` | music | something lands on ≥ 90 % of ≥ 8 beats | `sync_to_audio` bars |

### Score

Each issue costs `severity points (high 30, medium 16, low 7) × rule weight` in its category. The overall
score is `100 · 0.5^(P / 110)` with `P = Σ category penalty × category weight` (`CAT_WEIGHTS`, calibrated,
see below): every ~110 weighted points halve it. An empty composition scores 0. Music counts only when
there is music.

## 2. The automatic polishing loop

1. The agent finishes a turn that changed the document (no error, not waiting for storyboard approval).
2. The editor runs `polishPlan(store, round)`: the critic, and if the score is below 80 **or** any high-severity
   issue is left, the worst 3 issues that have a fix (or are high).
3. The panel adds a quiet info row **"Polishing: 3 fixes"** (no user bubble) and sends the follow-up into the
   same CLI session (same model): the critic's score, the 3 issues with their `→ tool {args}` lines, "keep the
   brief's duration", "call critique once to verify, reply with one line".
4. The follow-up turn takes over the previous turn's review card (one card for build + polish; revert goes
   back to before the build).
5. Max 2 rounds (`POLISH.maxRounds`); stops early when the score clears the bar.

Storyboard beats: `update_progress {status: "done"}` appends the critic's 1–2 worst medium/high issues
*inside that beat's time range* to the tool result, so the agent can fix a beat before starting the next one.

Model-agnostic by construction: the loop is a plain user message and the beat notes are tool results, so it
works the same for every provider the bridge runs (Claude Code, Codex, Gemini) and any model alias.

## 3. Quality-first defaults

Only when the model leaves a value out (explicit values always win), and only with the setting on:

- **Eases** (`buildKeys`, used by `animate`, `set_keyframes`, `build_scene` keyframes): opacity in → Ease Out,
  out → Ease In; scale from < 60 % → the style's entrance ease (or a settle curve on big pops), to < 60 % → the
  exit ease; position/rotation/size → the style's on-screen ease; trims and colours → Cubic In Out. (Before: Easy
  Ease everywhere, the #4 failure class of the baseline.)
- **Durations** (`build_scene` enter/exit, `apply_preset`): the handbook table by travel distance
  (`0.25 + d/2000`, cap 1 s) or by size (0.32 / 0.5 / 0.7 / 0.9 s), decorations × 0.8, exits × 0.7, times the
  style's tempo (calm 1.35, precise 0.9, snappy 0.75).
- **Settle on big moves**: entrances ≥ 300 px or from scale ≤ 30 % get the style's settle (a ~4 % overshoot
  bezier `[0.22, 1.12, 0.36, 1]`, or a spring for playful styles); fades on those use Ease Out.
- **Automatic overlap**: ≥ 3 sibling `build_scene` entrances with no time get a stagger, hero first (largest
  area / biggest type), the style's step (0.05–0.12 s, ≤ 0.6 s total); the result notes say so.
  `apply_preset` on several layers without a stagger uses the same step.
- **Feel**: from the storyboard's style or the last `get_guide styles/<name>`: calm (luxury, editorial), precise
  (swiss, data, kinetic), playful (bouncy, paper, blob, explainer), snappy (glitch, neon), smooth (corporate,
  product, UI, parallax), else neutral (Quart Out / Cubic In / Cubic In Out).

## 4. Gold examples

13 examples in `src/agent/guides/examples/`: logo reveals with three meanings (door opens, playful drop,
elegant draw + reveal), two UI micro-interactions (toggle, button → success), a staggered feature list in a brand
style, a kinetic quote, kinetic type to music, a bar chart, an explainer beat (problem → solution match
transition), a vertical social promo, a seamless loop, a lower third.

Each file: `# Example: …`, `> tags: …` (the retrieval keywords), `## Brief`, `## Tool calls` (one ```json array
of `{tool, args}`; `"<key>"` = the id `build_scene` returned for that key), `## Why it works`.

`get_guide {name: "examples", brief}` scores every example by word overlap with the brief (tags × 3, title × 2,
the example's brief × 1, simple stemming, stop words dropped) and returns the best 2 in full; without `brief` it
lists them. The system prompt tells the agent to fetch them before building a piece.

Verification: `npx vite-node scripts/gold-examples.ts` replays each one headless and prints the critic's
score; `node scripts/gold-examples-shots.mjs --url <dev server>` replays them in the real editor (music examples
get the generated 120 BPM track) and saves a 12-frame contact sheet each; `tests/critic.test.ts` requires every
example to replay with only real tools, score ≥ 85 and have no high-severity issue. All 13 score 85–100 (12 ≥ 95).

### Adding a gold example (owner)

1. Build the piece with the tools (in the app, or as a tool-call list).
2. Write `src/agent/guides/examples/<name>.md` in the format above. Use `build_scene` keys and refer to them as
   `"<key>"` in later calls. Don't use markers or the variations tools.
3. `npx vite-node scripts/gold-examples.ts <name> --verbose`: fix it until the critic is ≥ 95 with no high issue.
4. `node scripts/gold-examples-shots.mjs --url http://localhost:<port>/ --only <name>`: look at the contact sheet.
   Restart the dev server after editing an example (the guide glob is cached).
5. Add retrieval tags people would use in a brief; add a line to the retrieval test if it's a new category.
6. Keep 10–15 examples: replace weaker ones rather than piling up.

### Adding a rule (owner)

1. Add the check in `critique()` (pick its category section), push an issue with a message that says what is
   wrong in numbers and a fix with real tool names and arguments.
2. Register it in `RULES` (category + weight).
3. Add a case to `tests/critic.test.ts` (something that must trigger it, and a deliberate craft case that must not).
4. Re-run the calibration (below) and the gold examples.

## 5. Calibration and evaluation

### Calibration: does the critic predict the judge?

`npx vite-node scripts/critic-calibrate.ts <result dirs…> [--fit]` re-runs the current critic over every
saved eval document (`document.json`; fonts from the run's `probe.json`) and correlates its score with the
judge's overall score (`judge.json`, rubric `evals/judge.md`). `--fit` grid-searches `CAT_WEIGHTS` and reports
the leave-one-out correlation; the shipped weights are the fit shrunk halfway towards equal weights (the fit
alone does not generalise better than that on this little data).

| data | runs | Pearson r | Spearman ρ |
|---|---|---|---|
| everything (baseline + the 10 taste runs below) | 136 | **0.52** | 0.45 |
| within a brief (critic and judge centred per brief: does it rank builds of the same brief?) | 131 | **0.48** | |
| leave-one-out with re-fitted weights | 136 | 0.48 | |
| the original 16-run baseline alone | 16 | 0.06 | −0.03 |

Per-category correlation with the judge (136 runs): readability 0.33, technical 0.30, choreography 0.22,
polish 0.20, richness 0.15, timing 0.14, easing 0.13, composition 0.00, brand −0.07. The baseline alone is too
narrow to calibrate on (judge 4.3–6.2, mostly differences of style and richness the critic can't see). For
scale: the judge repeats itself to ±0.1–0.5 per brief (`evals/BASELINE.md`), so r ≈ 0.5 is a moderate,
useful predictor, not a replacement for the judge. What the critic sees well: mechanical defects (dead
draw-ons, text collisions, unreadable holds, dead endings, things that stop dead, everything at once). What it
can't see: style match, concept, richness of idea — the judge's lowest criteria. `evals/results/2026-11-12-taste/calibration-critic.json`
has the per-run numbers.

### Eval: taste layer on vs off, default and fast model

12 briefs (01, 02, 03, 04, 05, 06, 07, 09, 10, 12, 15, 17), one run each per configuration, judge = the default
judge model, concurrency 3, `--no-video`. Model aliases: **default** = `sonnet` (the eval harness default),
**fast** = `haiku`. "off" = `--taste off`: no polishing rounds, the tools' old defaults, no `critique` tool, no
examples and the plain prompt line (`haiku-off-3`, `sonnet-off-3`). "on" = everything on. The repeats `*-on-v1a/b` ran
with the first critic version (polish threshold 72, before the `copy-paste`, `one-move` and `default-fill` rules
and the calibrated weights; the critic column shows the score the run recorded), `haiku-on-3` with the shipped one.

| model | taste | runs | judge overall (1–10) | critic (0–100) | polishing rounds / brief | agent $ / brief |
|---|---|---|---|---|---|---|
| default | off | 12 | 6.00 | 75 | – | 0.13 |
| default | on (2 repeats) | 24 | **6.05** (6.07, 6.03) | **86** (83, 89) | 0.6 | 0.21 |
| fast | off | 12 | 5.56 | 72 | – | 0.015 |
| fast | on (3 repeats) | 36 | **5.81** (5.72, 5.85, 5.85) | **92** (95, 87, 93) | 0.3 | 0.019 |

Paired per brief (on − off, judge overall): default +0.05 ± 0.20 (s.e.), fast **+0.25 ± 0.23**; critic +8…+24
points in every configuration. Judge criteria, fast model off → on: brief fit 6.58 → 6.83, style 5.83 → 6.44,
timing/easing 5.58 → 5.75, composition 5.67 → 5.81, polish 5.33 → 5.61, richness 4.33 → 4.39.

A third condition separates the parts: "polishing loop and defaults off, but critique tool + examples
available" (`*-loopoff*`, from a run where the dev server still served the earlier prompt). The fast model then
pulled the gold examples in 8–12 of 12 briefs and called `critique` itself 17–19 times, and scored 5.81–5.83:
as much as the full layer. So for the fast model most of the gain comes from the shipped knowledge it can pull
(examples + critic tool); the automatic loop and defaults add little on top. The default model barely used
them when not pushed (0–3 example lookups) and did not move measurably.

Honest reading: the critic's own score goes up a lot (it is what the loop optimises), the judge's score goes up
a little for the fast model and not measurably for the default one. Single runs per brief: a per-brief delta
under ~0.5 is noise; the suite means above are good to roughly ±0.2. The judge's biggest complaints in all
configurations are richness and concept ("each element moves once and stops", "copy-pasted motion",
"generic"), which the critic now flags (`one-move`, `copy-paste`, `thin`) but a 3-fix polishing round does
not cure. Next levers: more gold examples per category (the cheapest, model-agnostic win measured here), richer
`secondary_motion`/variation tools the fixes can call, and a polishing round aimed at richness.

Raw results: `evals/results/2026-11-12-taste/<model>-<config>/` (summary.md/json per configuration; per brief:
document, contact sheet, timeline, tool calls, metrics with the critic before/after polishing, judge). Total
spend for all eval runs: about $18 (agent + judge).

Reproduce:

```
npx vite --port 5271 --strictPort &
node scripts/agent-eval.mjs --model sonnet --taste off --only 01,02,03,04,05,06,07,09,10,12,15,17 --concurrency 3 --max-cost 3 --no-video --out evals/results/<dir>/sonnet-off
node scripts/agent-eval.mjs --model sonnet --taste on  … --out evals/results/<dir>/sonnet-on
node scripts/agent-eval-compare.mjs evals/results/<dir>/sonnet-off evals/results/<dir>/sonnet-on
npx vite-node scripts/critic-calibrate.ts evals/results/2026-11-12 evals/results/<dir>/* --fit
```

Two harness fixes came with this work: headless turns auto-approve storyboards (otherwise a director-flow
brief ends after `propose_storyboard` with an empty document), and every brief starts from an empty document
with a page-load retry. Restart the dev server after editing `src/` during a long eval: on a machine with many
worktrees Vite's file watcher can stop seeing changes and keep serving the old modules (it happened here).

## Files

- `src/agent/critic.ts` — the critic, `formatCritique`, `scoreOf`, `RULES`, `CAT_WEIGHTS`
- `src/agent/taste.ts` — setting, feel, timing table, default eases, `polishPlan`, `beatNote`
- `src/agent/taste-defaults.ts` — `apply_preset` defaults
- `src/agent/examples.ts`, `src/agent/guides/examples/*.md` — gold examples, replay
- `scripts/critic-calibrate.ts` — critic vs judge on saved eval runs (`--fit` for weights)
- `scripts/gold-examples.ts`, `scripts/gold-examples-shots.mjs` — example replay / contact sheets
- `scripts/agent-eval.mjs --taste on|off` — eval with/without the layer; every run records the critic score
- `tests/critic.test.ts`; `scripts/taste-ui-check.mjs` (the panel's "Polishing" row against the fake CLI)
