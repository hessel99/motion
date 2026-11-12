// tiny dom context menu with submenus (vanilla, used by timeline + viewport)

export type MenuItem =
  | { label: string; action?: () => void; shortcut?: string; submenu?: MenuItem[]; disabled?: boolean; separator?: false }
  | { separator: true };

let current: HTMLElement | null = null;

export function closeMenu() {
  current?.remove();
  current = null;
}

export function showContextMenu(x: number, y: number, items: MenuItem[]) {
  closeMenu();
  const root = build(items);
  document.body.appendChild(root);
  place(root, x, y);
  current = root;
  const off = (e: Event) => {
    if (current && !current.contains(e.target as Node)) { closeMenu(); window.removeEventListener('pointerdown', off, true); }
  };
  setTimeout(() => window.addEventListener('pointerdown', off, true));
  // capture phase + stop: escape only closes the menu (it must not also clear the selection)
  const mine = root;
  window.addEventListener('keydown', function esc(e) {
    if (e.key !== 'Escape') return;
    window.removeEventListener('keydown', esc, true);
    if (current !== mine) return; // this menu was already closed: let escape through
    e.stopImmediatePropagation(); e.preventDefault(); closeMenu();
  }, true);
}

function build(items: MenuItem[]): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  for (const it of items) {
    if ('separator' in it && it.separator) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      el.appendChild(s);
      continue;
    }
    const item = it as Exclude<MenuItem, { separator: true }>;
    const row = document.createElement('div');
    row.className = 'ctx-item' + (item.disabled ? ' disabled' : '');
    row.innerHTML = `<span>${escapeHtml(item.label)}</span><span class="ctx-sc">${item.submenu ? '›' : escapeHtml(item.shortcut ?? '')}</span>`;
    if (item.submenu) {
      let sub: HTMLElement | null = null;
      row.addEventListener('pointerenter', () => {
        el.querySelectorAll(':scope > .ctx-menu').forEach(n => n.remove());
        sub = build(item.submenu!);
        el.appendChild(sub);
        const r = row.getBoundingClientRect();
        place(sub, r.right - 2, r.top - 4);
      });
    } else {
      row.addEventListener('pointerenter', () => el.querySelectorAll(':scope > .ctx-menu').forEach(n => n.remove()));
      row.addEventListener('click', () => { if (!item.disabled) { closeMenu(); item.action?.(); } });
    }
    el.appendChild(row);
  }
  return el;
}

function place(el: HTMLElement, x: number, y: number) {
  el.style.left = '0px';
  el.style.top = '0px';
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
  el.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
