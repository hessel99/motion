// the Home view (the house in the top bar, and what shows when no file is open). agent first: the
// hero is the brief box ("What do you want to make?") that starts a new file and the agent; then
// a blank file from a size preset, open a file, reopen a recent one, or import. it covers the editor,
// which stays mounted underneath (its canvases and WebGL context live for the session).

import { useEffect, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { loadDemo, openFileDialog, toast, type OpenKind } from '../../app/actions';
import { documents, newDocument, openProject, switchTo, docProject } from '../../app/documents';
import { forgetRecent, recentFiles, recentKey, recentProject, recentThumb, type RecentEntry } from '../../app/recent';
import { useChannels } from '../hooks';
import { Kbd } from '../ui';
import { PromptBox } from './PromptBox';
import { Clapperboard, FileText, Film, Folder, Image, Play, Spline, X, type LucideIcon } from './icons';

const PRESETS: { name: string; w: number; h: number; note: string }[] = [
  { name: 'Landscape', w: 1920, h: 1080, note: '16:9' },
  { name: 'Square', w: 1080, h: 1080, note: '1:1' },
  { name: 'Portrait', w: 1080, h: 1920, note: '9:16' },
  { name: 'Feed', w: 1080, h: 1350, note: '4:5' },
  { name: '4K', w: 3840, h: 2160, note: '16:9' },
  { name: 'Icon', w: 512, h: 512, note: 'Lottie' },
];

const IMPORTS: { kind: OpenKind; label: string; sub: string; Icon: LucideIcon }[] = [
  { kind: 'lottie', label: 'Lottie', sub: '.json', Icon: FileText },
  { kind: 'svg', label: 'SVG', sub: 'vector layers', Icon: Spline },
  { kind: 'aep', label: 'After Effects', sub: '.aep, best effort', Icon: Clapperboard },
  { kind: 'media', label: 'Images and audio', sub: 'png, jpg, wav, mp3…', Icon: Image },
];

export function Home() {
  useChannels([], ['recent', 'docs']);
  const recent = recentFiles();
  return (
    <div class="home" role="region" aria-label="Home">
      <div class="home-col">
        <PromptBox fresh />
        <section class="home-sec">
          <h2 class="home-h">Start from a size</h2>
          <div class="home-presets">
            {PRESETS.map(p => {
              const k = 44 / Math.max(p.w, p.h);
              return (
                <button type="button" class="preset-card" onClick={() => newDocument({ width: p.w, height: p.h })} title={`New ${p.w}×${p.h} file`}>
                  <span class="preset-frame"><i style={{ width: Math.round(p.w * k) + 'px', height: Math.round(p.h * k) + 'px' }} /></span>
                  <span class="preset-name">{p.name}</span>
                  <span class="preset-size">{p.w} × {p.h} · {p.note}</span>
                </button>
              );
            })}
          </div>
          <div class="home-actions">
            <button type="button" class="home-btn" onClick={() => openFileDialog()}><Folder />Open file…<Kbd>⌘O</Kbd></button>
            <button type="button" class="home-btn" onClick={() => loadDemo()}><Play />Open the demo animation</button>
          </div>
        </section>

        <section class="home-sec">
          <h2 class="home-h">Recent</h2>
          {recent.length === 0
            ? <p class="home-empty">Files you open, save or close show up here.</p>
            : <div class="home-recent">{recent.map(r => <RecentCard key={r.key} entry={r} />)}</div>}
        </section>

        <section class="home-sec">
          <h2 class="home-h">Import</h2>
          <div class="home-imports">
            {IMPORTS.map(i => (
              <button type="button" class="import-card" onClick={() => openFileDialog(i.kind)}>
                <span class="import-icon"><i.Icon /></span>
                <span class="grow"><span class="import-label">{i.label}</span><span class="import-sub">{i.sub}</span></span>
              </button>
            ))}
          </div>
          <p class="home-hint"><b>From Figma:</b> select frames or layers in Figma, copy them (⌘C) and paste here (⌘V). A single frame becomes the composition. Files can also be dropped on the canvas.</p>
        </section>
      </div>
    </div>
  );
}

function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function RecentCard({ entry }: { entry: RecentEntry }) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => { let on = true; recentThumb(entry.key).then(t => { if (on) setThumb(t); }); return () => { on = false; }; }, [entry.key, entry.openedAt]);
  const open = async () => {
    // already open in a tab: bring it to the front
    const tab = documents().find(d => recentKey(docProject(d), d.path) === entry.key);
    if (tab) { switchTo(tab.id); editor.emit('doc-open'); return; }
    const p = entry.stored ? await recentProject(entry.key) : null;
    if (!p) { toast(`"${entry.name}" is not stored here anymore${entry.path ? ': open it with Open file…' : ''}`, 'error'); forgetRecent(entry.key); return; }
    openProject(p, entry.path);
  };
  return (
    <div class="recent-card">
      <button type="button" class="recent-open" onClick={open} title={entry.path ?? entry.name}>
        <span class="recent-thumb">{thumb ? <img src={thumb} alt="" /> : <Film class="recent-ph" size={20} />}</span>
        <span class="recent-name">{entry.name}</span>
        <span class="recent-meta">{entry.info}{entry.info ? ' · ' : ''}{ago(entry.openedAt)}</span>
      </button>
      <button type="button" class="recent-x" aria-label={`Remove ${entry.name} from recent files`} title="Remove from recent" onClick={() => forgetRecent(entry.key)}><X size={13} /></button>
    </div>
  );
}
