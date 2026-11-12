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
self-critique line instead of the critique/examples lines (`AGENT_SYSTEM_PROMPT_PLAIN`).

## 1. The motion critic

`critique(store, { range?, loop?, fontOk?, max? })` samples the active composition (12 samples/s, 24–120
samples) in one pass per sample (parents before children, typed arrays, no renderer), then runs the
rules below. Typical documents take 2–25 ms in the browser (gold examples: 2–41 ms including the first-run
JIT; tests assert < 50 ms on a 41-layer document). It is also the read-only `critique` tool (`from`/`to`
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
| `timing-range` | timing | a move's duration vs `0.25 s + distance/2000 px` (scale entrances by size: ≤ 120 px 0.32 s, ≤ 400 px 0.55 s, else 0.8 s), outside 0.4×–2.4× (3.2× for springs/overshoot); < 2 frames | `retime` around the move's start |
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
2. The editor runs `polishPlan(store, round)`: the critic, and if the score is below 72 **or** any high-severity
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

CALIBRATION_RESULTS

## Files

- `src/agent/critic.ts` — the critic, `formatCritique`, `scoreOf`, `RULES`, `CAT_WEIGHTS`
- `src/agent/taste.ts` — setting, feel, timing table, default eases, `polishPlan`, `beatNote`
- `src/agent/taste-defaults.ts` — `apply_preset` defaults
- `src/agent/examples.ts`, `src/agent/guides/examples/*.md` — gold examples, replay
- `scripts/critic-calibrate.ts` — critic vs judge on saved eval runs (`--fit` for weights)
- `scripts/gold-examples.ts`, `scripts/gold-examples-shots.mjs` — example replay / contact sheets
- `scripts/agent-eval.mjs --taste on|off` — eval with/without the layer; every run records the critic score
- `tests/critic.test.ts`
