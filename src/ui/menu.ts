// tiny dom context menu with submenus (vanilla, used by the top bar, timeline + viewport).
// keyboard: ↑/↓ (Home/End) move, → or Enter opens a submenu, ← closes it, Enter/Space runs
// the item, a letter jumps to the next item starting with it, Escape closes.

export type MenuItem =
  | { label: string; action?: () => void; shortcut?: string; submenu?: MenuItem[]; disabled?: boolean; separator?: false;
      /** a check mark column (radio-like choices). undefined: no column for this item */
      checked?: boolean; hint?: string }
  | { separator: true };

type Item = Exclude<MenuItem, { separator: true }>;

/** one open menu level: the root, or a submenu inside it */
interface Level { el: HTMLElement; rows: HTMLElement[]; items: Item[]; active: number }

let current: HTMLElement | null = null;
let levels: Level[] = [];
let seq = 0;
let cleanup: (() => void) | null = null;
let restoreFocus: HTMLElement | null = null;

export function closeMenu() {
  current?.remove();
  current = null;
  levels = [];
  cleanup?.();
  cleanup = null;
  // give focus back to where it was before the menu opened (menu.focus() took it)
  const prev = restoreFocus;
  restoreFocus = null;
  if (prev && document.contains(prev) && document.activeElement === document.body) prev.focus({ preventScroll: true });
}

export function showContextMenu(x: number, y: number, items: MenuItem[]) {
  closeMenu();
  const prev = document.activeElement as HTMLElement | null;
  restoreFocus = prev && prev !== document.body ? prev : null;
  const root = build(items, 0);
  document.body.appendChild(root.el);
  place(root.el, x, y);
  current = root.el;
  levels = [root];
  root.el.focus({ preventScroll: true });
  const mine = root.el;
  const off = (e: Event) => {
    if (current && !current.contains(e.target as Node)) closeMenu();
  };
  // capture phase + stop: menu keys must not reach the editor (escape must not also clear the selection)
  const keys = (e: KeyboardEvent) => {
    if (current !== mine) return;
    // while a menu is open no key reaches the editor (delete, arrows = nudge, ...). tab closes it.
    if (e.key === 'Tab') { closeMenu(); return; }
    if (onKey(e)) e.preventDefault();
    e.stopImmediatePropagation();
  };
  const t = setTimeout(() => window.addEventListener('pointerdown', off, true));
  window.addEventListener('keydown', keys, true);
  cleanup = () => { clearTimeout(t); window.removeEventListener('pointerdown', off, true); window.removeEventListener('keydown', keys, true); };
}

/** returns true when the key was handled by the menu */
function onKey(e: KeyboardEvent): boolean {
  const lv = levels[levels.length - 1];
  if (!lv) return false;
  const enabled = (i: number) => !lv.items[i].disabled;
  const step = (from: number, d: number) => {
    const n = lv.rows.length;
    for (let k = 1; k <= n; k++) { const i = (from + d * k + n * 2) % n; if (enabled(i)) return i; }
    return from;
  };
  switch (e.key) {
    case 'Escape':
      if (levels.length > 1) closeSub(levels.length - 2); else closeMenu();
      return true;
    case 'ArrowDown': setActive(lv, step(lv.active < 0 ? -1 : lv.active, 1)); return true;
    case 'ArrowUp': setActive(lv, step(lv.active < 0 ? 0 : lv.active, -1)); return true;
    case 'Home': setActive(lv, step(-1, 1)); return true;
    case 'End': setActive(lv, step(0, -1)); return true;
    case 'ArrowLeft':
      if (levels.length > 1) { closeSub(levels.length - 2); return true; }
      return false;
    case 'ArrowRight':
    case 'Enter':
    case ' ': {
      const it = lv.items[lv.active];
      if (!it || it.disabled) return e.key !== 'ArrowRight';
      if (it.submenu) { const sub = openSub(lv, lv.active); if (sub) setActive(sub, sub.items.findIndex(x => !x.disabled)); return true; }
      if (e.key === 'ArrowRight') return false;
      closeMenu();
      it.action?.();
      return true;
    }
  }
  // type-ahead: plain letters / digits jump to the next item starting with it
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && /\S/.test(e.key)) {
    const ch = e.key.toLowerCase();
    const n = lv.rows.length;
    for (let k = 1; k <= n; k++) {
      const i = (Math.max(lv.active, -1) + k + n) % n;
      if (enabled(i) && lv.items[i].label.trim().toLowerCase().startsWith(ch)) { setActive(lv, i); break; }
    }
    return true;
  }
  return false;
}

function setActive(lv: Level, i: number) {
  if (lv.active >= 0) lv.rows[lv.active]?.classList.remove('active');
  lv.active = i;
  const row = lv.rows[i];
  if (!row) { lv.el.removeAttribute('aria-activedescendant'); return; }
  row.classList.add('active');
  lv.el.setAttribute('aria-activedescendant', row.id);
  row.scrollIntoView({ block: 'nearest' });
}

/** close every submenu below level `keep` */
function closeSub(keep: number) {
  while (levels.length > keep + 1) {
    const lv = levels.pop()!;
    lv.el.remove();
  }
  const top = levels[keep];
  if (top) { top.rows[top.active]?.setAttribute('aria-expanded', 'false'); top.el.focus({ preventScroll: true }); }
}

function openSub(parent: Level, index: number): Level | null {
  const depth = levels.indexOf(parent);
  const item = parent.items[index];
  if (depth < 0 || !item.submenu) return null;
  closeSub(depth);
  const sub = build(item.submenu, depth + 1);
  parent.el.appendChild(sub.el);
  const r = parent.rows[index].getBoundingClientRect();
  place(sub.el, r.right - 2, r.top - 4);
  parent.rows[index].setAttribute('aria-expanded', 'true');
  levels.push(sub);
  sub.el.focus({ preventScroll: true });
  return sub;
}

function build(items: MenuItem[], depth: number): Level {
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.setAttribute('role', 'menu');
  el.tabIndex = -1;
  const lv: Level = { el, rows: [], items: [], active: -1 };
  for (const it of items) {
    if ('separator' in it && it.separator) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      s.setAttribute('role', 'separator');
      el.appendChild(s);
      continue;
    }
    const item = it as Item;
    const index = lv.rows.length;
    const row = document.createElement('div');
    row.className = 'ctx-item' + (item.disabled ? ' disabled' : '');
    row.id = `ctx-${++seq}`;
    row.setAttribute('role', 'menuitem');
    if (item.disabled) row.setAttribute('aria-disabled', 'true');
    if (item.submenu) { row.setAttribute('aria-haspopup', 'menu'); row.setAttribute('aria-expanded', 'false'); }
    if (item.checked !== undefined) { row.setAttribute('role', 'menuitemradio'); row.setAttribute('aria-checked', String(item.checked)); }
    const check = item.checked === undefined ? '' : `<span class="ctx-check" aria-hidden="true">${item.checked ? CHECK_SVG : ''}</span>`;
    const hint = item.hint ? `<span class="ctx-hint">${escapeHtml(item.hint)}</span>` : '';
    row.innerHTML = `${check}<span class="ctx-label">${escapeHtml(item.label)}${hint}</span><span class="ctx-sc" aria-hidden="true">${item.submenu ? CHEVRON_SVG : escapeHtml(item.shortcut ?? '')}</span>`;
    row.addEventListener('pointerenter', () => {
      const cur = levels[depth];
      if (cur !== lv) return;
      setActive(lv, index);
      if (item.submenu && !item.disabled) openSub(lv, index);
      else closeSub(depth);
    });
    if (!item.submenu) row.addEventListener('click', () => { if (!item.disabled) { closeMenu(); item.action?.(); } });
    el.appendChild(row);
    lv.rows.push(row);
    lv.items.push(item);
  }
  return lv;
}

// lucide "check" / "chevron-right" (menus are plain dom for speed: inline svg, no components)
const svg = (d: string) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const CHECK_SVG = svg('<path d="M20 6 9 17l-5-5"/>');
const CHEVRON_SVG = svg('<path d="m9 18 6-6-6-6"/>');

/** open a menu anchored to a button: under it (left or right aligned), or above it */
export function menuFrom(anchor: Element, items: MenuItem[], opts: { align?: 'left' | 'right'; above?: boolean } = {}) {
  const r = anchor.getBoundingClientRect();
  showContextMenu(r.left, r.bottom + 6, items);
  const m = current;
  if (!m) return;
  const mr = m.getBoundingClientRect();
  if (opts.align === 'right') m.style.left = Math.max(4, r.right - mr.width) + 'px';
  if (opts.above) m.style.top = Math.max(4, r.top - mr.height - 6) + 'px';
}

function place(el: HTMLElement, x: number, y: number) {
  el.style.left = '0px';
  el.style.top = '0px';
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  el.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
