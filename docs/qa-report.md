# QA report: v0.3.2

Sweep of the whole app in Chromium (dark, 1440×900 and 1280×800), driven like a designer would.
The permanent check is `npm run qa` (`scripts/qa-flows.mjs`, against a running dev server: `URL=http://localhost:5173/ npm run qa`).
The existing `scripts/e2e.mjs`, `scripts/ui-check.mjs`, `scripts/audio-smoke.mjs` and `scripts/shader-e2e.mjs` all passed at the start of the sweep.

## Fixed

| # | issue | status | commit |
|---|---|---|---|
| QA-1 | A file opened from Home (size preset, brief) was zoomed to fit against the full-width Home stage (the sidebars are hidden there). Once the editor showed, the comp was too big and hung off the left edge of the canvas (the "Main 1920×1080" label was cut to "20×1080" at 1280×800). Fix: the viewport keeps following size changes while the view is still the automatic fit, and stops once the user zooms or pans (`src/ui/viewport-controller.ts`). | fixed, `qa-flows` check | see `git log --grep QA-1` |

## Handed off (layout / chrome: shell agent)

| # | issue |
|---|---|
| H-1 | macOS: the traffic lights (`trafficLightPosition {14,13}`, `electron/main.cjs`) sit over the top of the left sidebar. The rail starts lower, but the sidebar header ("Agent", x≈68) starts right next to the traffic lights and the `.tb-traffic` spacer is only added when the left sidebar is closed. |
| H-2 | `BrowserWindow` has no `minWidth` / `minHeight`. At 1024×640 and 800×600 the stage gets very narrow (canvas and timeline header squeeze). |
| H-3 | The empty-comp brief card ("What do you want to make?") is wider than the comp frame at 1280×800 and covers its edges. |
| H-4 | Agent panel body text is large (≈15px) next to the 12–13px of the rest of the chrome; long agent messages wrap a lot in the 300px sidebar. |
| H-5 | Timeline: layer bars run past the end-of-comp line into the scrollbar gutter on the right. |
| H-6 | `electron/main.cjs` comment points to `src/ui/chrome/TabStrip.tsx`, which no longer exists (the tab strip is `TopBar.tsx`). |
