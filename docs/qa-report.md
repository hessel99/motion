# QA report: v0.3.2

Sweep of the whole app in Chromium (dark, 1440×900 and 1280×800), driven like a designer would.
The permanent check is `npm run qa` (`scripts/qa-flows.mjs`, against a running dev server: `URL=http://localhost:5173/ npm run qa`).
`npm run qa:electron` (`scripts/qa-electron.mjs`, needs `npm run build` and xvfb) launches the real Electron app and fails on main / preload / renderer errors.
The shell agent's `npm run layout:check` (`scripts/layout-lock.mjs`) guards the window structure; it passes on this branch.
The existing `scripts/e2e.mjs`, `scripts/ui-check.mjs`, `scripts/audio-smoke.mjs` and `scripts/shader-e2e.mjs` all passed at the start of the sweep.

## Fixed

| # | issue | status | commit |
|---|---|---|---|
| QA-1 | A file opened from Home (size preset, brief) was zoomed to fit against the full-width Home stage (the sidebars are hidden there). Once the editor showed, the comp was too big and hung off the left edge of the canvas (the "Main 1920×1080" label was cut to "20×1080" at 1280×800). Fix: the viewport keeps following size changes while the view is still the automatic fit, and stops once the user zooms or pans (`src/ui/viewport-controller.ts`). | fixed, `qa-flows` check | see `git log --grep QA-1` |
| QA-2 | A Lottie pasted as text opened in a new tab called "clipboard". It is now named after the animation (`nm`), or "Pasted Lottie". | fixed, `qa-flows` check | see `git log --grep QA-2` |
| QA-3 | Inspector number fields with a long label shrank the label so it ran into the value: "Spread0", "Density50%", "Background Blur" and the Timing "Out" clipped. The label no longer shrinks (`.num-label`, `src/ui/styles.css`). | fixed, `qa-flows` check | see `git log --grep QA-3` |
| QA-4 | Reopening a recent file (or closing a background tab) stored "no thumbnail" over the one saved before, so its Home card went blank. The stored thumbnail is now kept unless a new one is given (`src/app/recent.ts`). | fixed, `qa-flows` check | see `git log --grep QA-4` |
| QA-5 | Copying a precomp layer into another document tab pasted a layer pointing at a composition that only existed in the first document (it rendered nothing; opening it failed). The copy now carries the compositions it shows (nested ones too, with their image assets); the paste adds the missing ones in the same undo step (`copyPayload` / `pasteMotion`, `src/app/actions.ts`). | fixed, `qa-flows` check | see `git log --grep QA-5` |
| QA-6 | Settings nav: the first group was still called "Account" after the Profile page was removed; it holds Appearance and Keyboard shortcuts. Renamed "General". | fixed | see `git log --grep QA-6` |

## Handed off (layout / chrome: shell agent)

| # | issue |
|---|---|
| H-1 | macOS: the traffic lights (`trafficLightPosition {14,13}`, `electron/main.cjs`) sit over the top of the left sidebar. The rail starts lower, but the sidebar header ("Agent", x≈68) starts right next to the traffic lights and the `.tb-traffic` spacer is only added when the left sidebar is closed. |
| H-2 | `BrowserWindow` has no `minWidth` / `minHeight`. At 1024×640 and 800×600 the stage gets very narrow (canvas and timeline header squeeze). |
| H-3 | The empty-comp brief card ("What do you want to make?") is wider than the comp frame at 1280×800 and covers its edges. |
| H-4 | Agent panel body text is large (≈15px) next to the 12–13px of the rest of the chrome; long agent messages wrap a lot in the 300px sidebar. |
| H-5 | Timeline: layer bars run past the end-of-comp line into the scrollbar gutter on the right. |
| H-7 | At 800×600 both sidebars keep their full width and crush the stage to ~130px; the transport buttons overlap the play button. |
| H-8 | The selection bar above a layer covers the blue size badge when the layer touches the top of the canvas (e.g. a pasted Figma frame, a precomp layer). |
| H-9 | The rail's Home tooltip opens below the button and covers the next rail icon (it is declared `data-tooltip-side="right"`). |
| H-6 | `electron/main.cjs` comment points to `src/ui/chrome/TabStrip.tsx`, which no longer exists (the tab strip is `TopBar.tsx`). |

## Handed off (other areas)

| # | issue | owner |
|---|---|---|
| O-2 | Agent turn revert: Revert undoes the turn's N steps one by one, so ⌘⇧Z afterwards brings the turn back one step at a time (first just "Add rect", a half-built state) while the card still says "Reverted". Either squash the turn into one undo step at the end (`Store.squashSince`, as storyboard beats do; careful with edits the user makes during the turn) or make the card follow redo. Needs an owner decision. | agent |
| O-3 | Settings → Appearance → GPU engine: the long renderer string is cut off mid-word without an ellipsis. | settings / shell |
| O-4 | `tests/pathops.test.ts` "is fast enough for detailed shapes" has a hard 30 ms limit; it failed once at 30.05 ms while the machine was loaded (passes on rerun). Flaky under load: loosen or measure the best of several runs. | tests |
| O-1 | Export file names differ per format for the same comp: `Demo.mp4`, `Demo.json`, but `Demo - Logo reveal.gif` / `.html`, `Demo_0000.png`. | export-parity |

## Checked and working

Draw rect / ellipse / pen / text; select, resize, rotate, nudge, Shift+P keyframes, auto-key; copy / paste / ⌘D / delete;
group / ungroup; precompose and open the comp tab by double-click; undo all 15 steps and redo all of them;
document tabs, Ctrl+Tab, switching while playing; Settings (⌘,) and Esc; ⌘K ask bar commands; canvas and timeline
context menus; paste SVG, PNG, Lottie and the synthetic Figma fidelity scene; Share popover; export MP4 (h264
1920×1080, 240 frames), GIF (640×360), PNG (1920×1080), Lottie (5.7.4, 4 layers), preview html (frames looked at);
save and reopen a project (same layers and comps); agent panel with the fake claude: storyboard, approve, review card;
the Electron app under xvfb (preload, bridge, updater, no main-process errors). e2e, ui-check, audio-smoke and
shader-e2e pass.

Performance: no long tasks (>100 ms) while nudging, stepping frames, switching Keys / Graph or playing the demo. The first
frame that draws a layer with blur + noise + shadow costs ~300–500 ms once in headless Chromium (effect shaders compile on
software GL); later frames are fast. Not treated as a bug.
