// the keyboard shortcut list (help dialog: ?, Settings > Keyboard shortcuts). keep in sync with
// setupShortcuts in src/app/actions.ts.
export const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'], [', / .', 'Previous / next frame (shift: 10)'], ['J / K', 'Previous / next keyframe or marker'], ['M', 'Add marker at playhead (drag to move, double-click to name)'], ['Home / End', 'Start / end'],
  ['V R O T P H', 'Move, rectangle, ellipse, text, pen, hand (polygon and star in the toolbar)'], ['⌘Z / ⇧⌘Z', 'Undo / redo'], ['⌘C ⌘V ⌘X', 'Copy, paste (also from Figma), cut — layers or keyframes'],
  ['⌘D', 'Duplicate'], ['Alt-drag', 'Duplicate while moving'], ['⌘G / ⇧⌘G', 'Group / ungroup'], ['⇧⌘C', 'Pre-compose'],
  ['⌘[ / ⌘]', 'Send backward / bring forward (alt: to back / front)'], ['Arrows', 'Nudge (shift: 10px)'], ['⇧P ⇧S ⇧A', 'Animate position / scale / anchor'],
  ['F9', 'Easy ease on selected keys'], ['B / N', 'Preview range start / end at playhead (double-click its bar to clear)'], ['Delete', 'Delete layers or keyframes'], ['⌘0 / ⌘+ / ⌘−', 'Fit / zoom in / zoom out'],
  ['⌘ while dragging', 'No snapping'], ['Shift while dragging', 'Constrain axis / keep aspect / 15° steps'], ['Alt while resizing', 'From center'],
  ['Double-click', 'Edit text / enter group / edit path / open precomp'], ['⌘I', 'Show / hide the AI agent'], ['⌘,', 'Settings'], ['?', 'This help'],
];
