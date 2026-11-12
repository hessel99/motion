# UI structure (v3)

Canvas and timeline are the core of the window; the agent supports them. Dark is the designed
theme (light works through the same tokens). Screenshots: `docs/shots/ui-v3/`
(`node scripts/ui-shots.mjs`, `node scripts/agent-panel-shots.mjs` against the fake claude).

## The window (v5: title bar + rail + fixed sidebars + full-bleed stage) — LOCKED

```
┌───────────────────────────────── title bar (40px) ─────────────────────────────┐
│ ● ● ●  [file tab ●] [file tab] +            (drag)              ↶ ↷ …  [Share] │
├──┬──────────────┬───────────────────────────────────────┬──────────────────────┤
│⌂ │ Agent    ● ✎ │                                       │ Pill               … │
│+ │              │   canvas, full bleed (no card)        │ Rectangle · 5 keys   │
│⌕ │  thread      │        [ layer ]                      │ align · Position ·   │
│──│              │        [tool pill · zoom]             │ Layout · Appearance ·│
│✦ │              ├───────────────────────────────────────┤ Fill · Stroke ·      │
│◇ │              │ comp tabs · transport · tools         │ Effects · Animate …  │
│🔔│  composer    │ timeline                              │                      │
│⚙ │              │                                       │                      │
└──┴──────────────┴───────────────────────────────────────┴──────────────────────┘
 rail   left sidebar          the stage (middle)             right sidebar
```

**Why a title bar row.** The mac app hides the native title bar (`titleBarStyle: hiddenInset`), so
the traffic lights float over whatever the renderer draws at the window's top left. In v4 that was
the rail and the left sidebar's header, and they collided. Now one 40px row spans the window: its
left `--traffic-w` (80px) is reserved for the traffic lights (electron `trafficLightPosition`
x 20 / y 14 centres them in the row), and everything else (rail, sidebars, stage) starts below
it, so nothing can reach them at any window size. The frame is read once at startup
(`src/ui/chrome/platform.ts` → `<html data-platform data-traffic-lights data-fullscreen>`):
- **mac app**: the zone is reserved; **mac full screen** (no traffic lights): it collapses to a
  small gutter (main.cjs forwards `enter/leave-full-screen`).
- **windows / linux app**: the native frame stays; the row is an in-app bar, no reserve.
- **browser**: nothing reserved. `?platform=mac` emulates the mac frame with stand-in circles at
  the real position (`&fullscreen` for full screen), so screenshots prove there is no overlap.

**The grid is locked.** Five regions in `grid-template-areas` (`chrome.css .app`), every size in
`tokens.css` "app shell" (`--titlebar-h`, `--traffic-w`, `--rail-w`, `--left-w`, `--right-w`,
`--panel-head-h`, `--stage-min`, `--timeline-h`, `--tl-min`, `--app-min-w/h`); no absolute
positioning or negative margins between regions. Below 1280px the sidebars narrow (264 / 280).
The window can't get smaller than 1100×700 (`BrowserWindow minWidth/minHeight`). The timeline
row is `minmax(--tl-min, --tl-h)`, so a saved tall timeline gives way before the canvas drops
under `--stage-min`.

**Guard: `npm run layout:check`** (`scripts/layout-lock.mjs`). States (empty doc, shape selected,
agent running against the fake claude, Home, Settings, Share popover) × 1100×700, 1280×800,
1440×900, 1728×1117, 1920×1080, 2560×1440 × mac / browser frame. It asserts the region boxes don't
intersect or leave the window, no control sits in the traffic-light zone, no page scroll, and no
primary control's label is clipped, then compares 1x screenshots with `tests/layout-baselines/`
(failures + diffs land in `tests/layout-baselines/.out/`). After an intended change:
`node scripts/layout-lock.mjs --update` and commit the new baselines.

- **Rail** (icon only, tooltips with shortcuts): Home, New file (⌘N), Ask / commands (⌘K),
  Agent (⌘I), Assets, Updates (desktop app, with a dot when one is ready), Settings at the bottom.
  Clicking the active Agent / Assets icon collapses the left sidebar.
- **Two fixed sidebars** under the title bar, flush to the window edges, a hairline toward the
  stage. Each starts with a 40px header row (`--panel-head-h`): "Agent" with its status dot and
  new-conversation button, "Assets", or the inspector's selection title.
- **The stage**: the canvas full bleed (the pasteboard colour around the composition, no inset
  card, no name label over the frame), the timeline below one divider (its top edge is the
  splitter).
- **Title bar right**: undo / redo, the app menu (…), and **Share**
  (neutral primary). Share opens a popover with two ways out:
  - *Share a preview file*: one self-contained html page (the animation rendered frame-accurately
    as an embedded video + a small player: play / pause, scrub, loop, frame time, Space and , .
    keys). Works offline; save it and send it (`src/app/share/player.ts`).
  - *Copy a preview link* uploads that page through a `ShareProvider` (`src/app/share/index.ts`:
    `configured()`, `upload(blob, name) → url`). Shipped with one provider, "your upload endpoint"
    (POST to an https URL you control, optional Authorization header). Off by default: the popover
    then shows **Set up link sharing…**, which opens Settings → Connections → Link sharing.
  - *Export a file…* (⌘E): the export dialog (MP4 / WebM / GIF / PNG / Lottie).

### v3 layout notes (still valid inside the stage)

- **Home** (⌂, and whenever no file is open): the brief box "What do you want to make?" (format
  chips, starter chips, drop zone), start from a size, recent files (thumbnails, IndexedDB:
  `src/app/recent.ts`), import (Lottie, SVG, After Effects, images/audio, Figma paste hint).
- **Left sidebar**: Agent or Assets (compositions, components, colors/numbers, imported files), picked on the rail.
  Layers live in the timeline only.
- **Canvas**: floating tool pill (select, hand, shapes with variants, pen, text, zoom + view
  options), a selection bar over the selected layer, the brief box on an empty composition, a suggestion after an import.
- **Timeline**: compositions as pill tabs (+ new, close, double-click a precomp layer opens its
  tab), the agent's progress pill when the panel is hidden, compact transport (start, frame step,
  play, loop, full-screen preview, editable timecode, duration and fps menus), range, auto-key, Keys | Graph, a zoom slider. 28px rows; the beat the agent is building is highlighted.
- **Inspector**: calm field rows (label · fields · keyframe diamond; ‹ › on hover when
  animated), sections with "+" / "−" where something can be added (Stroke). Section,
  FieldRow and SwatchRow (`src/ui/ui.tsx`) and PropRow (`Inspector.tsx`) are the building blocks for
  new rows (shader params, effect props).
- **Settings**: a modal (⌘, or the app menu). **Ask bar**: ⌘K or "/" anywhere.

## Audit of the previous UI

| element | what it did | decision | why |
|---|---|---|---|
| Home icon (top left) | opened the app menu | **keep, made real** | It is now Home: brief, new from a size, open, recent, import. The menu moved to "…". |
| Single document tab | showed the project name, rename | **keep, made real** | Real multi-document tabs: new, open, close, reorder by drag, dirty dot, middle-click close, ⌘T/⌘N, ⌘W, Ctrl+Tab. |
| "+" next to the tab | replaced the project after a confirm | **keep, changed** | Opens a new file in a new tab; nothing is discarded. |
| Settings tab in the strip | Settings as a pseudo document | **move** | Settings is a modal; it is not a document. |
| Composition dropdown | switch / new / rename comp, add as layer | **move** | Compositions are tabs in the timeline header and a list in Assets. Two switchers for one thing was the confusion. |
| "1920×1080 · 60 fps · 4s" text | read-only format | **remove** | Size, fps and duration are editable in the inspector (nothing selected) and the transport. |
| Agent button (top bar) | toggled the agent | **merge** | Side panel toggle (▯) in the top bar and ⌘I; the Agent tab in the panel. |
| Export menu button | menu of five exports | **keep, single entry** | Opens one Export dialog with every format (Video, GIF, Image, Lottie, After Effects). |
| Export section (inspector, empty selection) | a second export UI | **remove** | One entry point. The empty-selection inspector is composition settings. |
| Undo / redo | undo, redo, history on right-click | **keep** | Quiet icons, top right. |
| Big transport bar (52px) | timecode, 7 playback buttons, loop, range, marker, auto-key, timeline zoom | **merge** | Into the ~40px timeline header. Prev/next key buttons dropped (J/K, in the tooltips). |
| Transport splitter | sized the timeline | **move** | The timeline card's top edge. |
| Floating toolbar: tools | move/hand, shapes, pen, text | **keep, compact** | Five buttons, hand separate, shapes behind a corner caret. |
| Floating toolbar: Insert (+) | file, new comp, comp as layer, demo | **remove** | ⌘O / Home import, timeline "+", Assets / comp tab menu, Home. |
| Floating toolbar: view options | zoom steps, pixel grid, snapping, fps playback, HUD | **move** | Into the zoom menu inside the tool pill. |
| Zoom badge (bottom right) | zoom to fit | **move** | Into the tool pill, with the view options menu. |
| Left panel tabs Agent / Components / Library | three icon tabs | **merge** | Agent \| Assets (soft segmented tabs). |
| Left panel collapse / reopen buttons | hide / show the panel | **move** | One toggle in the top bar (and ⌘I). |
| Agent header "Agent ●" + new chat | title, status, new chat | **keep, slimmer** | Status dot and new chat sit in the tab row; the tab already says Agent. |
| Agent quick chips (Animate in, Bouncier, Smoother, Snappier…) | one-click canned prompts | **remove** | Noise above the composer; the agent infers intent. Targeted asks live where the target is (context menus, selection bar, ⌘K). |
| Style chip row | style recipe for the next brief | **move** | "+" → Style (shown as a removable chip when picked); the agent picks a style itself otherwise. |
| Edit / Ask toggle | read-only mode | **remove** | A question is just a message. The backend's ask mode is unused by the UI. |
| Model picker in the composer | provider / model | **move** | "+" → Model, and Settings → Models. |
| Bridge-offline paragraph | long instructions | **change** | One line, "Agent offline · How to connect" (details in the tooltip and Settings). |
| Inspector title block | name, type · keys, … | **keep** | Now "Rectangle · in Group 14 · 5 keys". |
| Transform section | position, scale, rotation, opacity, size, anchor | **split** | Position (position, rotation, anchor), Layout (size, scale, clip), Appearance (opacity, radius, blend, mask). |
| Arrange section (align bar) | align / distribute | **move** | Under the inspector header, like design tools. |
| Corner radius / Blending / Mask / Frame sections | one control each | **merge** | Rows in Layout / Appearance. |
| Fill type select | solid / linear / radial | **keep, segmented** | Solid \| Linear \| Radial pills. |
| Stroke section | always shown | **change** | "+" adds a stroke, "−" removes it. |
| Animate preset grid | 12 buttons | **compact** | One "Choose…" menu (in / out / loop) + duration (+ stagger). |
| Easing, Rhythm, Timing, Expressions, Text, Text animation, Trim, Component, Precomp | — | **keep** | Restyled to the field rows. |
| Markers section | list + add | **keep** | "+" on the section. |
| Timeline Keys/Graph/Speed (drawn in the canvas) | track view | **move** | DOM segmented control in the header. |
| Timeline layer label dot | layer colour | **remove** | The (now soft) layer bar already carries the label colour. |
| Welcome dialog | first-run tips | **keep** | Text updated. |

Every remaining control was clicked through after the change (e2e plus the screenshot scripts).

## Agent first

- Home and empty compositions open with the brief box; starter chips fill a brief, format chips
  set the size (also read from the brief: "story", "square"…).
- ⌘K / "/" opens the ask bar: commands filter as you type; a sentence goes to the agent with
  the selection, selected keys and preview range as context (chips show it).
- Right-click on layers (canvas, timeline), keyframes and the ruler: two or three one-click asks
  plus "Ask agent…". The selection bar has "Ask".
- After artwork (Figma paste, SVG, image) or audio comes in: one dismissible suggestion,
  "Animate this" / "Sync to music". Never automatic.
- While the agent works the user keeps working; with the panel hidden its progress shows as a
  pill in the timeline header; the storyboard beat being built is highlighted in the timeline.
- All of these go through `askAgent(text, { chip, context })` (`src/ui/agent-bridge.ts`).

## The agent panel: what is in it and why

- **Header**: Agent | Assets, a status dot (tooltip: connection and model) and New conversation.
  One conversation per document (stored with the project key), so no history list yet.
- **Empty state**: one line on what the agent does and three example briefs. No generic tweak
  chips: targeted tweaks belong to the thing being tweaked (context menu, selection bar, ⌘K).
- **Thread**: user messages are soft cards; agent replies are plain readable text (14px,
  relaxed line height). Layer names the agent writes in bold/code become chips: click selects the
  layer and moves the playhead to where its animation starts. Tool work collapses into one quiet
  row ("Worked through 12 steps", or the current step while running) that expands into the steps.
  A centered status line ("Beat 2/3 · Reveal · Writing… · 8s") replaces the boxed indicator.
  The storyboard card (concepts as a pick-one list with large rows, beats, approve) and the review
  card (diff, compare, revert, result contact sheet) stay: they are the director workflow and the
  safety net. A "Jump to latest" pill appears when you scroll up while it streams. One row per turn: while it runs, the activity row; once it changed the file, the review card ("added 3 layers · 13 steps") whose details hold the diff and the steps. Run stats (time, cost, tokens) go to the console, not the thread.
- **Composer**: one rounded box. Enter sends, Shift+Enter is a newline, Esc stops a run (the send
  button turns into stop). Bottom left: "+" (add an image/SVG/audio, mention a layer, style,
  model) and "point at a layer on the canvas" (the next layer clicked becomes an @mention). Files
  pasted or dropped into it come into the document and get selected, so "animate this" refers to
  them. Context chips only appear when there is something beyond the composition (selection,
  mentions, a style).

## Borrowed patterns, adapted for motion

| pattern (from AI design tools) | adapted here as |
|---|---|
| Floating bottom tool pill, active tool filled, zoom inside | Same, neutral filled active tool; the zoom's menu carries the zoom steps (pixel grid, snapping, comp-fps playback and the HUD only in dev builds / `?dev`). |
| Second floating pill for page actions (preview, export, full screen) | Not a second pill: playback already lives in the timeline transport, and a duplicate play/loop/range on the canvas was noise. The canvas-specific part, **full-screen preview** (only the canvas, playing; Esc leaves), is a button in the transport. |
| Mini toolbar above the selected element | **Motion actions** above the selected layer: keyframe at the playhead (on what is animated, else position), ease its keys (springs and curves), show in the timeline, Ask. Hidden while dragging, playing or using another tool. |
| Inline links to created items | Layer chips in agent replies: select the layer **and** jump the playhead to its animation start. Neutral chip with the layer-type icon. |
| "Pick all that apply" question card | Storyboard **concepts** as a pick-one card with large rows and the choice mark on the right. Concept thumbnails are not available yet (the agent proposes concepts as text). |
| "Started · task" status line | Tied to storyboard beats: "Beat 2/3 · Reveal · …", and the beat's time range is highlighted in the timeline while it is built. |
| Accent colour on primary / active / links | Not taken. Primary is near-white on dark, active states neutral; blue only means selection, playhead, keyframes. |
| Chat panel full height | The agent stays beside the canvas; the timeline keeps the full width under both, because time is the main axis of a motion tool. |

## Not done / deviations

- No conversation history list (one conversation per document).
- Concept choice cards show no looping thumbnails (no preview data from the agent yet).
- Breadcrumbs for nested precomps were not added; tabs cover the navigation.
- In a browser tab ⌘T / ⌘W / Ctrl+Tab stay with the browser; the desktop menu sends them to the app.
- The read-only Ask mode still exists in the agent backend (quick actions, client) but nothing in the UI sends it.

## v4 changes (rail, sidebars, Share)

| element | before | decision | why |
|---|---|---|---|
| Agent \| Assets segmented tabs | top of the left card | **move** to the rail | One place to switch side views; frees the sidebar header for its title and the agent's status. |
| Home and panel-toggle buttons (top left) | top bar | **move** to the rail | Home is a rail icon; the active rail icon toggles the sidebar. |
| Sidebars as inset cards | radius + gaps | **change** to fixed full-height sidebars | Calmer frame; the inset look is kept for the stage only, where the work is. |
| Export button | top right | **replace** with Share | Share covers sending a preview (file now, link when set up) and exporting files. |
| Rhythm panel | inspector | **removed** (on the main branch) | Asked for by the user. |
| Timeline header labels (Range, Auto-key, duration, zoom) | always | **shrink** in a narrow stage | Container queries drop labels first, then the duration and zoom slider. |

## Removed in 0.4

The app keeps its core (canvas, tools, timeline + graph editor, eases / springs, inspector, precomps,
the agent, Figma paste, imports, audio, Share / export, components, updates). Everything below was
removed from the UI, code, tests and agent tools; old documents still open (unknown fields are
dropped or ignored).

| feature | why | what replaces it |
|---|---|---|
| Timeline markers (ruler flags, inspector section, M, J/K marker stops, drag / rename / delete, `set_markers`, `build_scene` markers, Lottie markers) | Extra UI and a second timing system next to the music grid; nobody needed named moments | Audio beat / bar / section grids (analysis, ruler ticks, snapping). `align_to_beats` defaults to the music's beats (or explicit times / bpm); `place_on_beats` places entrances. Old files drop `comp.markers` on open |
| Audio inspector "Markers on bars" / "On hits" | Wrote markers | Snapping to the beat grid, Sync timing |
| Ease studio: feel pad, knob, live swatches, A/B lane, Perform recording (`src/ui/patterns/*`) | Experiments that doubled the easing UI | Easing section: spring + curve presets, the bezier editor with influence, the graph editor |
| Speed graph mode | A second graph editor; the value graph covers editing, the speed view was read-only | Keys \| Graph |
| Inspector Animate panel (preset menu, duration, stagger, Smart animate row) | The agent does presets, stagger and smart animate better and in context | Agent tools `apply_preset`, `stagger`, `smart_animate` (⌘K / chat) |
| Variations (tray, `save_variation` / `apply_variation`, "3 variations" quick action) | The review card + undo already cover trying alternatives | The agent builds one strong option and names the others; undo / revert per turn |
| Style sync from W3C / Tokens Studio files, URLs, Figma variables REST API; Sync ▾ menu, review dialog, tokens-file export, desktop file watching | Rarely used, needed tokens / Enterprise plans | Figma paste still syncs variables / color styles (one undo step); linked colours / numbers and light / dark modes stay |
| After Effects script export (`.jsx`) | Untested in real AE, a large embedded interpreter | Lottie (also imports into AE through plugins), MP4 / WebM, GIF, PNG |
| Pixel grid, snap to pixel grid, comp-fps playback and Performance HUD toggles; stress scenes and demo in the app menu | Developer tools | Shown in dev builds, with `?dev`, or `localStorage motion.dev = 1` |
| Settings: Profile, Notifications, Members placeholders; "coming soon" sound switches; the Default mode (Edit / Ask) card | Placeholders and a dead setting (the agent always edits) | — |
| Dead code: `src/audio/beats.ts`, debug scripts (`hang*.mjs`, `probe.mjs`, `atlas-probe.mjs`, `library-shots.mjs`), unused CSS | Unused | — |

Kept on purpose: `.aep` import (lazy-loaded, no cost to the main bundle; removing it also means
changing the desktop shell's open dialog), text animation presets (text is core), the expression
editor, the store's preview-override hook (harmless, in the renderer's hot path), and the
`@preact/signals` dependency. It is unused, but removing a dependency changes the shell
fingerprint and would force a full app update, so it goes with the next shell release.
