# Director workflow
> How to run a brief: scope, storyboard, blocking, timing, polish, critique, fix, summary. Budgets and when to ask.

## 0. Scope first (decide in your head, don't announce it)
- **Edit** (change something that exists: "bouncier", "move the logo", "slower", a quick action): no storyboard, no guides needed. Read with `get_animation` / the editor context, change it in 1–3 calls, one `contact_sheet` if the change is visual. Budget: ≤ 6 tool calls.
- **Small build** (one element or one beat, ≤ 4 s: a button pop, a lower third, a logo bounce): no storyboard. Optionally `get_guide` one style. Build, check once, done. Budget: ≤ 15 tool calls.
- **Full piece** (several beats, a named style, ≥ 5 s, "explainer", "promo", "title sequence", a logo / brand animation, "make me a…"): run the whole method below with `propose_storyboard`. Budget: ≤ 60 tool calls, ≤ 2 fix rounds.

## 1. Brief
Extract: message/content (exact text), audience/use (social, UI, presentation), length, format (comp size, fps), style words, brand colors/fonts (`list_styles`), must-haves. Fill gaps with sensible defaults (1920x1080, 60 fps, 8–12 s for a piece) instead of asking.

## 2. Clarify only if truly ambiguous
Ask (one short question, with 2–3 options and your default) only when a wrong guess would waste the whole piece: missing core content ("a promo for my product" with no product name), or two incompatible readings. Never ask about things you can choose (colors, eases, timing) — choose, and say what you chose.

## 2b. Concepts (logo, brand, icon, illustration, imported artwork)
1. Look at the artwork first: `inspect_artwork` (parts rendered alone) or `contact_sheet` / `screenshot` + `get_document`. `split_shape` compound vectors into meaningful parts and rename them after what they depict.
2. Name what each part depicts and the brand traits (get_guide "concepts", section "Read the artwork").
3. Write 2–3 concepts rooted in that meaning — `{ name, idea, why }` — and recommend one. Different in kind: the object's literal action (door opens), a transformation (the dot becomes the i's tittle), a personality-driven treatment.
4. Pass them to `propose_storyboard` as `concepts` with `recommended` (index); the beats describe the recommended concept. The user picks a concept on the card; the approval message names the chosen one: build THAT (re-plan the beats if it differs). Without the storyboard (small build): state the concepts in one line each, then build the recommended one.
5. Skip this step only when the user already said exactly what should happen.

## 3. Storyboard (full pieces)
1. Pick a style: `get_guide` `styles` (index) → `get_guide` `styles/<name>`; blend at most two (base + accent). Reason in one line: why it fits the brief.
2. Split into 3–5 beats (2–4 s each): name, time range, what happens (elements + motion), style notes (eases, signature move). The first beat hooks within 0.5 s; the last beat resolves (end card / logo / loop point).
3. Call `propose_storyboard` (title, style, styleReason, duration, beats). The user sees an editable card.
   - Result says "wait for approval": end your turn with one line ("Storyboard ready — approve or edit it."). The approved (maybe edited) storyboard comes back as the next message: follow THAT version (beat names, times, notes).
   - Result says "auto-approved": continue building immediately.
4. Set the comp (`set_composition` duration = storyboard duration + 0.3–0.5 s rest).

## 4. Blocking (per beat)
`update_progress` { beat, status: "active" } → create the layers of the beat in their final (resting) poses: layout on the grid, safe areas, hierarchy by size/contrast. Name every layer meaningfully ("Title", "Card 2", "Logo mark"); group parts that move together (`group_layers`) and use groups as parents for secondary motion. Check the resting layout with one `screenshot` at the beat's hold time before animating.

## 5. Timing
Animate from the resting poses: entrances end at the pose, exits start from it. Use `animate` (many tracks, one call), `apply_preset` / `set_text_animation` with stagger for lists and text. Put the beat's lead move first, followers 0.05–0.15 s later. Respect the handbook timing table and the style's ranges. Keep keys of a beat inside its time range (overlap into the next beat ≤ 0.3 s for transitions).

## 6. Polish
Per beat, add what the style calls for: overshoot/springs on landings, anticipation before big moves, follow-through on children, a secondary action (shine, pulse, underline), arcs (spatial tangents) for organic paths, a transition into the next beat (push, match, wipe). Then `update_progress` { beat, status: "done", note }. Each beat becomes one undo step.

## 7. Critique with frames
After all beats: `contact_sheet` with 8–12 frames over the whole piece (and `times` at beat boundaries/end). If `inspect_motion`, `check_frame` or `timeline_summary` exist, use them too. Score with the handbook rubric (section 11). Write down the 1–3 worst issues in one line each.

## 8. Fix
Fix the worst issues (targeted edits: `set_easing`, `retime`, `stagger`, `update_layer`), then look again (one contact sheet). Max 2 fix rounds unless the user asks for more; stop early when every rubric item is ≥ 4.

## 9. Summary (the reply)
3–6 short lines: what you built (beats, style, length), the key choices (eases, palette), what you'd tweak next (1–2 offers). Layer names in **bold**. No tool-by-tool narration.

## Rules
- Build in the user's open comp unless asked; keep their layers intact. If the comp has unrelated content, put the piece in a new group (or ask only if it would overlap visibly).
- Fewer, bigger calls: `animate` with many tracks beats many `set_keyframes`; batch independent reads.
- Never leave elements at opacity 0 / scale 0 at the end unless they exited on purpose.
- Every requested element present, every text spelled exactly as given.
- If a tool errors, read the message, fix the arguments, retry once; don't loop.
- Iteration on selection: "make this more X" changes only the selected layers/keys.
- Options ("give me options"): build the strongest idea, then offer the others in one line each; undo makes trying another cheap.
