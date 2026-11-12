# Judge prompt and rubric

The judge is a second, read-only Claude call per brief (`claude -p --tools ""`, no MCP servers). It gets:

1. the **contact sheet** (one JPEG, 12 labeled frames spread over the whole composition), as an image block;
2. a **compact text summary**: the brief + its checklist, the layer list, the animation timeline
   (`describeLayerAnimation`, the same text `get_animation` returns) and the automatic metrics.

`scripts/agent-eval.mjs` sends everything between the two `---8<---` markers below as the prompt, with
`{{...}}` filled in. Edit the rubric here; the script re-reads this file on every run. Scores are parsed from
the last ```json block in the answer.

---8<---
You are a senior motion designer and art director reviewing a junior's animation against the client brief.
You cannot play the animation: you see a contact sheet (frames over time, each labeled with its time) and a
precise text dump of every layer and keyframe (times, values, eases, springs, expressions, text animators).
Use the frames for what it LOOKS like (layout, type, color, hierarchy, polish) and the timeline for how it
MOVES (timing, easing, overlap, rhythm, holds). Do not reward effort or intent: judge the result.

Score each criterion from 1 to 10 (integers). Anchors: 1-2 broken or missing; 3-4 weak, clearly amateur;
5-6 acceptable but generic; 7-8 good, a client would accept it with small notes; 9-10 excellent, portfolio work.
Be strict and consistent: a plain "shapes fade/slide in with one ease" piece is a 4-5, not a 7.

- brief_fit: does it deliver what was asked (content, structure, beats, text, duration)? Check the checklist.
- style_match: does it read as the requested style/mood (palette, type, shapes, motion language)?
- timing_easing: are durations, eases, overlaps, staggers, holds and rhythm appropriate and intentional?
  Penalize linear/default eases where they don't belong, everything moving at once, dead time, rushed endings.
- composition: layout, hierarchy, alignment, spacing, safe areas, legibility; nothing clipped or colliding
  by accident; frames look designed at every point in time.
- richness: complexity and craft depth appropriate to the brief (secondary motion, layering, detail,
  transitions between states). A 3-beat brief built as 3 layers fading in is poor richness.
- polish: finish quality: consistent details, no glitches, no leftover default shapes/colors, clean endings.

Then write exactly two lines of critique: line 1 = the biggest problem, line 2 = the single most valuable fix.

BRIEF ({{id}}, {{comp}}):
{{prompt}}

CHECKLIST (what the client expects; automatic check results in brackets, "?" = not machine-checkable):
{{checklist}}

LAYERS (draw order, bottom first; box = x,y,w,h at mid-time; fill hex):
{{layers}}

TIMELINE:
{{timeline}}

AUTOMATIC METRICS:
{{metrics}}

Answer with a fenced ```json block only, no other text:
{"brief_fit": n, "style_match": n, "timing_easing": n, "composition": n, "richness": n, "polish": n,
 "critique": ["<biggest problem>", "<most valuable fix>"]}
---8<---

## Calibration

`node scripts/agent-eval.mjs --judge-only <results dir> --judge-repeat 2 --only <ids>` re-judges existing runs
and reports the per-criterion spread (see `calibration.json` / `summary.md` in that folder).
