// a non-blocking toast card with action buttons ("Sync animation to the music?" → Sync timing / Ask the
// agent / ✕). lives in the shared .toasts host, dismisses itself after a while or on any action.
import './audio.css';

export interface CardAction { label: string; run: () => void | Promise<void>; primary?: boolean }

export function actionCard(title: string, actions: CardAction[], opts: { detail?: string; ms?: number; id?: string } = {}): () => void {
  let host = document.querySelector('.toasts') as HTMLElement | null;
  if (!host) { host = document.createElement('div'); host.className = 'toasts'; host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite'); document.body.appendChild(host); }
  if (opts.id) host.querySelector(`[data-card="${opts.id}"]`)?.remove();
  const el = document.createElement('div');
  el.className = 'toast au-card';
  if (opts.id) el.dataset.card = opts.id;
  const t = document.createElement('div');
  t.className = 'au-card-title';
  t.textContent = title;
  el.appendChild(t);
  if (opts.detail) { const d = document.createElement('div'); d.className = 'au-card-detail'; d.textContent = opts.detail; el.appendChild(d); }
  const row = document.createElement('div');
  row.className = 'au-card-actions';
  let timer = 0;
  const close = () => { clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'au-card-btn' + (a.primary ? ' primary' : '');
    b.textContent = a.label;
    b.onclick = async () => { close(); await a.run(); };
    row.appendChild(b);
  }
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'au-card-x'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '✕';
  x.onclick = close;
  row.appendChild(x);
  el.appendChild(row);
  host.appendChild(el);
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => { clearTimeout(timer); timer = window.setTimeout(close, 6000); });
  timer = window.setTimeout(close, opts.ms ?? 20000);
  return close;
}
