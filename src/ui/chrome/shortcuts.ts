// the keyboard shortcut list (help dialog: ?, Settings > Keyboard shortcuts). keep in sync with
// setupShortcuts in src/app/actions.ts.
export const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'], [', / .', 'Previous / next frame (shift: 10)'], ['J / K', 'Previous / next keyframe or marker'], ['M', 'Add marker at playhead (drag to move, double-click to name)'], ['Home / End', 'Start / end'],
  ['V R O T P H', 'Select, rectangle, ellipse, text, pen, hand (polygon and star: the shape button in the tool pill)'], ['⌘Z / ⇧⌘Z', 'Undo / redo'], ['⌘C ⌘V ⌘X', 'Copy, paste (also from Figma), cut — layers or keyframes'],
  ['⌘D', 'Duplicate'], ['Alt-drag', 'Duplicate while moving'], ['⌘G / ⇧⌘G', 'Group / ungroup'], ['⇧⌘C', 'Pre-compose'],
  ['⌘[ / ⌘]', 'Send backward / bring forward (alt: to back / front)'], ['Arrows', 'Nudge (shift: 10px)'], ['⇧P ⇧S ⇧A', 'Animate position / scale / anchor'],
  ['F9', 'Easy ease on selected keys'], ['B / N', 'Preview range start / end at playhead (double-click its bar to clear)'], ['Delete', 'Delete layers or keyframes'], ['⌘0 / ⌘+ / ⌘−', 'Fit / zoom in / zoom out'],
  ['⌘ while dragging', 'No snapping'], ['Shift while dragging', 'Constrain axis / keep aspect / 15° steps'], ['Alt while resizing', 'From center'],
  ['Double-click', 'Edit text / enter group / edit path / open precomp'], ['⌘K or /', 'Ask the agent or run a command'], ['⌘I', 'Show / hide the side panel (agent)'], ['⌘E', 'Export'], ['⌘N / ⌘T', 'New file (tab)'], ['⌘W', 'Close the tab'], ['Ctrl+Tab', 'Next tab'], ['⌘,', 'Settings'], ['?', 'This help'],
];
