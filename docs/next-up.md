# Next up

The board for what gets built next. Findings from the QA agents land in **Inbox**; I sort them into Now / Next / Later.
Order inside a column is the priority. Rules for picking: blockers and anything that breaks the layout or loses work first,
then what a first-time user hits in the first 5 minutes, then pro workflow, then nice-to-haves.

## In progress
- Window shell: title bar with traffic-light space, rail + sidebars below, full-bleed canvas, compact agent panel, layout lock suite
- De-bloat: remove markers, ease studio / feel pad / perform, speed graph, variations, extra token sync, AE export, dev toggles
- QA (engineering): every flow, fixes + permanent `npm run qa`
- QA (motion designer persona): full Electron app, real jobs end to end
- QA (AI UX persona): agent panel and every AI entry point
- Figma shaders: auto-download shader code on paste (Connect Figma), mouse shaders, rotated effects
- Figma import fidelity: noise, blend modes, image filters, background blur/glass, text metrics, SVG gaps
- Export = editor: frame-by-frame parity for MP4/WebM/GIF/PNG/Lottie/preview, Lottie preflight
- Components for logo animations and showreels
- Taste layer: critic, auto-polish loop, quality defaults, gold examples, calibration

## Now
1. **Agent runs survive tab switches** (AIUX-01, blocker): switching/opening a tab mid-run silently kills the run and makes earlier review cards stale (no revert). Runs belong to their document; finish in the background or ask first.
2. **Agent turn = one undo step** (AIUX-09): one ⌘Z after a turn undoes the whole turn, consistent with the review card.
3. **Show the result after a turn** (AIUX-04): play the changed range once, so the canvas isn't empty at 0s.
4. **Entry points keep the draft and the context** (AIUX-02, AIUX-14): ⌘K/context-menu/Home/selection-bar asks never overwrite the draft; selection-bar Ask = inline prompt at the layer.
5. **Accessibility basics** (better-accessibility): keyboard trap in Corner radius, unnamed icon buttons, opaque focus ring ≥3:1, keyframes reachable by keyboard.
6. **Errors a novice can act on** (AIUX-19/20/21, W01): turn budget → "Continue" button; not logged in → in-app steps; offline → reconnect; error toasts stay until dismissed.
7. **Inspector row grid** (better-layout L01): one trailing column; fixes "Out4s".

## Next
- Clarifying questions as buttons/drop zone; starter chips that don't need a missing logo (AIUX-06/07)
- Queue/steer a follow-up while the agent runs (AIUX-03)
- Concept pick re-plans the beats (AIUX-24)
- Clickable follow-up suggestions, message actions (copy, edit & resend, restore) (AIUX-08/17)
- Badge/toast when a run finishes with the panel collapsed (AIUX-29)
- Dark elevation ring, contrast tokens, blue = selection only, type scale tokens (better-colors/ui/typography)
- Rail tooltips placement (L02); export file names consistent per format (QA O-1)
- Sidebars collapse at narrow widths (QA H-7); selection bar vs size badge (H-8); timeline bars past comp end (H-5)

## Later
- Cheaper trivial turns (AIUX-31), cost visible in turn details
- Exact Figma noise pattern, Roboto Flex named instances, glass rim, SVG markers, radial focal points
- Mouse-driven shader pointer in the preview player

## Inbox
- Motion designer QA findings (pending)
- Full lists: scratchpad qa-ai-ux.json (40), qa-better-skills.json (82), docs/qa-report.md

## Done
- 0.4.0: window shell (traffic lights), compact agent panel, full-bleed canvas, markers + AE export + pattern experiments removed, Figma fidelity round 2, shader download (Connect Figma), QA fixes
- 0.3.2: audio sync, sound effects, Figma shaders runtime
- 0.3.1: icon rail, fixed sidebars, Share
- 0.3.0: UI v3, agent tools, director workflow, concepts, Figma paste fidelity
