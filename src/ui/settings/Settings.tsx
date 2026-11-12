// Settings: a large modal over the window (⌘, or the app menu in the top bar). a left nav (Account / Agents / Workspace / App) and
// card sections. Appearance, Connections, Keyboard shortcuts, Models and Agent runs are real;
// Updates is real too (src/app/updates.ts, electron/updates/). Profile, Notifications and Members are placeholders.

import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { editor } from '../../app/editor';
import { flushAutosave, toast } from '../../app/actions';
import { checkForUpdates, formatBytes, getUpdateStatus, isBusy, onUpdateStatus, restartToUpdate, revertUi, setUpdatePrefs, updatesAvailable, type UpdateStatus } from '../../app/updates';
import { prefs, setPref } from '../../app/prefs';
import { activeProvider, setShareSettings, shareSettings, SHARE_PROVIDERS } from '../../app/share';
import { agentClient } from '../../agent/client';
import { useChannels } from '../hooks';
import { getThemePref, onThemeChange, setTheme, type ThemePref } from '../theme';
import { Button, Dialog, Kbd, Segmented, Select } from '../ui';
import { SHORTCUTS } from '../chrome/shortcuts';
import { ui, setUi, type SettingsSection } from '../chrome/ui-state';
import { agentPrefs, setAgentPref, CLAUDE_MODELS, PROVIDER_LABEL } from '../agent/agent-prefs';
import {
  ALargeSmall, Bell, Bot, Check, CircleCheck, CircleUser, Code, Copy, Cpu, Download, Keyboard, Link, Monitor, Moon, Plug, SquareTerminal, Sun,
  Terminal, Users, Workflow, type LucideIcon,
} from '../chrome/icons';
import './settings.css';

const NAV: { group: string; items: { id: SettingsSection; label: string; Icon: LucideIcon }[] }[] = [
  { group: 'Account', items: [
    { id: 'profile', label: 'Profile', Icon: CircleUser },
    { id: 'appearance', label: 'Appearance', Icon: Monitor },
    { id: 'notifications', label: 'Notifications', Icon: Bell },
    { id: 'shortcuts', label: 'Keyboard shortcuts', Icon: Keyboard },
  ] },
  { group: 'Agents', items: [
    { id: 'models', label: 'Models', Icon: Cpu },
    { id: 'runs', label: 'Agent runs', Icon: Workflow },
    { id: 'connections', label: 'Connections', Icon: Plug },
  ] },
  { group: 'Workspace', items: [
    { id: 'members', label: 'Members', Icon: Users },
    { id: 'fonts', label: 'Fonts', Icon: ALargeSmall },
  ] },
  { group: 'App', items: [
    { id: 'updates', label: 'Updates', Icon: Download },
    { id: 'figma', label: 'Figma import', Icon: Code },
  ] },
];

export function SettingsPage() {
  useChannels([], ['ui']);
  const sec = ui.section;
  const title = NAV.flatMap(g => g.items).find(i => i.id === sec)?.label ?? 'Settings';
  return (
    <div class="settings">
      <nav class="set-nav" aria-label="Settings">
        <div class="set-nav-title">Settings</div>
        {NAV.map(g => (
          <div class="set-group" role="group" aria-label={g.group}>
            <div class="set-group-label">{g.group}</div>
            {g.items.map(it => (
              <button type="button" class={'set-nav-item' + (it.id === sec ? ' on' : '')} aria-current={it.id === sec ? 'page' : undefined}
                onClick={() => setUi({ section: it.id })}>
                <it.Icon /><span>{it.label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <main class="set-main">
        <div class="set-col">
          <h1 class="set-title">{title}</h1>
          {sec === 'appearance' && <Appearance />}
          {sec === 'connections' && <Connections />}
          {sec === 'shortcuts' && <Shortcuts />}
          {sec === 'models' && <Models />}
          {sec === 'runs' && <AgentRuns />}
          {sec === 'fonts' && <Fonts />}
          {sec === 'updates' && <Updates />}
          {sec === 'figma' && <FigmaImport />}
          {sec === 'profile' && <Placeholder title="Profile" text="Motion runs on your computer without an account. Your name and avatar for comments will live here." />}
          {sec === 'notifications' && <Placeholder title="Notifications" text="Notifications for finished agent runs and exports are coming." />}
          {sec === 'members' && <Placeholder title="Members" text="Files are local and shared as .motion files for now. Shared workspaces are coming." />}
        </div>
      </main>
    </div>
  );
}

// ---------------- building blocks ----------------
function Card(props: { title?: string; sub?: ComponentChildren; right?: ComponentChildren; children?: ComponentChildren; class?: string }) {
  return (
    <section class={'set-card' + (props.class ? ' ' + props.class : '')}>
      {(props.title || props.right) && (
        <header class="set-card-head">
          <div class="grow">
            {props.title && <h2 class="set-card-title">{props.title}</h2>}
            {props.sub && <div class="set-card-sub">{props.sub}</div>}
          </div>
          {props.right}
        </header>
      )}
      {props.children}
    </section>
  );
}

function Row(props: { label: ComponentChildren; sub?: ComponentChildren; icon?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="set-row">
      {props.icon && <span class="set-row-icon" aria-hidden="true">{props.icon}</span>}
      <div class="grow set-row-text">
        <div class="set-row-label">{props.label}</div>
        {props.sub && <div class="set-row-sub">{props.sub}</div>}
      </div>
      {props.children}
    </div>
  );
}

function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <input type="checkbox" role="switch" class="switch" aria-label={props.label} checked={props.checked} disabled={props.disabled} onChange={e => props.onChange((e.target as HTMLInputElement).checked)} />;
}

function Status(props: { kind: 'ok' | 'off' | 'warn'; children: ComponentChildren }) {
  return <span class={'status-badge ' + props.kind}><span class="status-dot" aria-hidden="true" />{props.children}</span>;
}

function useCopy() {
  const [copied, setCopied] = useState('');
  const copy = (what: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(what); setTimeout(() => setCopied(c => (c === what ? '' : c)), 1500); }, () => toast('Could not copy', 'error'));
  };
  return { copied, copy };
}

function Placeholder(props: { title: string; text: string }) {
  return <Card title={props.title} sub={props.text}><div class="set-empty muted">Nothing to set here yet.</div></Card>;
}

// ---------------- appearance ----------------
function Appearance() {
  useChannels([], ['prefs']);
  const [theme, setT] = useState<ThemePref>(getThemePref());
  useEffect(() => onThemeChange(() => setT(getThemePref())), []);
  const cards: { id: ThemePref; label: string; sub: string; Icon: LucideIcon; note?: string }[] = [
    { id: 'dark', label: 'Dark', sub: 'Default', Icon: Moon },
    { id: 'light', label: 'Light', sub: 'Light greys', Icon: Sun },
    { id: 'system', label: 'System', sub: 'Follows your OS', Icon: Monitor, note: 'Switches with your computer.' },
  ];
  const gpu = gpuName();
  const [licenses, setLicenses] = useState(false);
  return (
    <>
      <Card title="Theme">
        <div class="theme-cards" role="radiogroup" aria-label="Theme">
          {cards.map(c => {
            const on = theme === c.id;
            return (
              <button type="button" role="radio" aria-checked={on} class={'theme-card' + (on ? ' on' : '')} onClick={() => { setTheme(c.id); setT(c.id); }}>
                <span class="theme-icon"><c.Icon /></span>
                <span class="grow theme-text"><span class="theme-label">{c.label}</span><span class="theme-sub">{c.sub}</span>{c.note && <span class="theme-note">{c.note}</span>}</span>
                <span class={'radio' + (on ? ' on' : '')} aria-hidden="true">{on && <Check size={11} strokeWidth={3} absoluteStrokeWidth={false} />}</span>
              </button>
            );
          })}
        </div>
      </Card>
      <Card title="Canvas">
        <Row label="Pixel grid when zoomed in" sub="Shows at 400% and above"><Switch label="Pixel grid when zoomed in" checked={prefs.pixelGrid} onChange={v => setPref('pixelGrid', v)} /></Row>
        <Row label="Snap to pixel grid" sub="Moved layers land on whole pixels"><Switch label="Snap to pixel grid" checked={prefs.snapToPixels} onChange={v => setPref('snapToPixels', v)} /></Row>
        <Row label="GPU engine" sub={gpu ? `WebGL 2 · ${gpu}` : 'WebGL 2'}><Status kind="ok">Active</Status></Row>
      </Card>
      <Card title="App">
        <Row label="Interface sounds" sub="Coming soon"><Switch label="Interface sounds" checked={prefs.interfaceSounds} disabled onChange={v => setPref('interfaceSounds', v)} /></Row>
        <Row label="Sound when an agent finishes" sub="Coming soon"><Switch label="Sound when an agent finishes" checked={prefs.agentSound} disabled onChange={v => setPref('agentSound', v)} /></Row>
        <Row label="Reduce motion" sub="Fewer animations in panels and menus"><Switch label="Reduce motion" checked={prefs.reduceMotion} onChange={v => setPref('reduceMotion', v)} /></Row>
        <Row label="Licenses" sub="Notices for the open-source software in Motion"><Button size="sm" onClick={() => setLicenses(true)}>View</Button></Row>
      </Card>
      {licenses && (
        <Dialog title="Open-source software" onClose={() => setLicenses(false)}>
          <ul class="licenses">
            {[['Preact', 'MIT'], ['@preact/signals', 'MIT'], ['Lucide icons', 'ISC'], ['Inter (Fontsource)', 'OFL-1.1'], ['opentype.js', 'MIT'], ['mediabunny', 'MPL-2.0'], ['gifenc', 'MIT'], ['fflate', 'MIT'], ['fzstd', 'MIT'], ['kiwi-schema', 'MIT'], ['ws', 'MIT'], ['Electron', 'MIT']].map(([n, l]) => <li><span>{n}</span><span class="muted">{l}</span></li>)}
          </ul>
        </Dialog>
      )}
    </>
  );
}

let gpuCache: string | null = null;
function gpuName() {
  if (gpuCache !== null) return gpuCache;
  try {
    const gl = editor.renderer.gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    gpuCache = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).replace(/^ANGLE \((.*)\)$/, '$1').slice(0, 60);
  } catch { gpuCache = ''; }
  return gpuCache;
}

// ---------------- connections ----------------
function Connections() {
  const [, force] = useState(0);
  useEffect(() => agentClient.on(() => force(x => x + 1)), []);
  const status = agentClient.status;
  const url = `http://127.0.0.1:${agentClient.port}/mcp`;
  const { copied, copy } = useCopy();
  const [open, setOpen] = useState<string | null>(null);
  const local = ['claude', 'codex', 'gemini'].map(id => ({ id, p: agentClient.providers.find(p => p.id === id) }));
  const connected = local.filter(x => x.p?.available).map(x => PROVIDER_LABEL[x.id]);
  const json = (o: unknown) => JSON.stringify(o, null, 2);
  const clients: { id: string; name: string; Icon: LucideIcon; how: string; where: string; snippet: string }[] = [
    { id: 'cc', name: 'Claude Code', Icon: SquareTerminal, how: 'Run in a terminal', where: 'Local · Motion MCP', snippet: `claude mcp add --transport http motion ${url}` },
    { id: 'codex', name: 'Codex', Icon: Terminal, how: 'Add to ~/.codex/config.toml', where: 'Local · Motion MCP', snippet: `[mcp_servers.motion]\nurl = "${url}"` },
    { id: 'cursor', name: 'Cursor', Icon: Code, how: 'Add to ~/.cursor/mcp.json', where: 'Local · Motion MCP', snippet: json({ mcpServers: { motion: { url } } }) },
    { id: 'desktop', name: 'Claude Desktop', Icon: Bot, how: 'Add to claude_desktop_config.json (uses mcp-remote for HTTP servers)', where: 'Local · Motion MCP', snippet: json({ mcpServers: { motion: { command: 'npx', args: ['-y', 'mcp-remote', url] } } }) },
    { id: 'other', name: 'Another MCP client', Icon: Plug, how: 'Streamable HTTP, JSON responses. Generic config:', where: 'Any client that speaks MCP over HTTP', snippet: json({ mcpServers: { motion: { type: 'http', url } } }) },
  ];
  return (
    <>
      <Card title="Local agents" sub="The agent sidebar runs these command-line agents on this computer, with your own subscription.">
        <div class="set-line">
          {status !== 'connected' ? <>The agent bridge is <b>{status}</b>. The desktop app starts it; in the browser run <code>npm run bridge</code>.</>
            : connected.length ? <>Local agents are connected: {connected.join(', ')}.</> : <>No agent CLI found on this computer.</>}
        </div>
        {local.map(({ id, p }) => (
          <Row icon={id === 'claude' ? <SquareTerminal /> : id === 'codex' ? <Terminal /> : <Bot />} label={PROVIDER_LABEL[id]}
            sub={p?.available ? <span class="mono">{p.version ?? 'installed'}</span> : undefined}>
            {status !== 'connected' ? <Status kind="off">Bridge offline</Status> : p?.available ? <Status kind="ok">Connected</Status> : <Status kind="off">Not installed</Status>}
          </Row>
        ))}
        {status === 'connected' && <div class="set-actions"><Button size="sm" onClick={() => agentClient.refreshProviders()}>Check again</Button></div>}
      </Card>
      <Card title="Agents outside Motion" sub="Let other apps' agents edit the open file through Motion's MCP endpoint.">
        {clients.map(c => (
          <>
            <Row icon={<c.Icon />} label={c.name} sub={c.where}>
              <Button size="sm" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? 'Done' : 'Set up'}</Button>
            </Row>
            {open === c.id && (
              <div class="setup">
                <div class="muted small">{c.how}</div>
                <div class="code-box">
                  <pre>{c.snippet}</pre>
                  <Button size="sm" variant="ghost" class="code-copy" onClick={() => copy(c.id, c.snippet)}>{copied === c.id ? <Check /> : <Copy />}{copied === c.id ? 'Copied' : 'Copy'}</Button>
                </div>
              </div>
            )}
          </>
        ))}
      </Card>
      <Card title="Server" sub="Apps that accept a URL connect while Motion is open. Local only (127.0.0.1).">
        <div class="url-row">
          <div class="url-field"><Link /><span class="mono">{url}</span></div>
          <Button onClick={() => copy('url', url)}>{copied === 'url' ? <Check /> : <Copy />}{copied === 'url' ? 'Copied' : 'Copy'}</Button>
        </div>
        <Row label="Status" sub={status === 'connected' ? 'The editor is connected: MCP tools act on this file.' : 'Start the bridge to serve the endpoint.'}>
          {status === 'connected' ? <Status kind="ok">Running</Status> : <Status kind="off">Offline</Status>}
        </Row>
      </Card>
      <LinkSharing />
    </>
  );
}

/** Share → "Copy a preview link": where the preview page is uploaded (src/app/share). off by default */
function LinkSharing() {
  useChannels([], ['share']);
  const prov = SHARE_PROVIDERS.find(p => p.id === shareSettings.provider);
  const ready = !!activeProvider();
  return (
    <Card title="Link sharing" sub="Share → Copy a preview link uploads the preview page (a self-contained player) and copies its link. Without a service, Share saves the page as a file to send.">
      <Row label="Service" sub={prov ? prov.description : 'Off: previews are shared as files'}>
        <Select size="sm" aria-label="Link sharing service" value={shareSettings.provider} onChange={v => setShareSettings({ provider: v })}
          options={[{ value: '', label: 'Off' }, ...SHARE_PROVIDERS.map(p => ({ value: p.id, label: p.name }))]} />
      </Row>
      {prov?.id === 'http' && <>
        <Row label="Upload URL" sub="https only. The page is POSTed as text/html; answer with the link (text or { url }).">
          <input class="set-input" aria-label="Upload URL" placeholder="https://…" value={shareSettings.endpoint} spellcheck={false}
            onChange={e => setShareSettings({ endpoint: (e.target as HTMLInputElement).value.trim() })} onKeyDown={e => e.stopPropagation()} />
        </Row>
        <Row label="Authorization" sub="Optional header value, e.g. Bearer …">
          <input class="set-input" type="password" aria-label="Authorization header" value={shareSettings.header} spellcheck={false}
            onChange={e => setShareSettings({ header: (e.target as HTMLInputElement).value })} onKeyDown={e => e.stopPropagation()} />
        </Row>
        <Row label="Status">{ready ? <Status kind="ok">Ready</Status> : <Status kind="off">Needs an https URL</Status>}</Row>
      </>}
    </Card>
  );
}

// ---------------- shortcuts ----------------
function Shortcuts() {
  return (
    <Card>
      {SHORTCUTS.map(([k, d]) => <div class="kbd-row"><span class="grow">{d}</span><Kbd>{k}</Kbd></div>)}
    </Card>
  );
}

// ---------------- models ----------------
function Models() {
  useChannels([], ['agent-prefs']);
  const [, force] = useState(0);
  useEffect(() => agentClient.on(() => force(x => x + 1)), []);
  const prov = (id: string) => agentClient.providers.find(p => p.id === id);
  const pick = (provider: string, model = '') => { setAgentPref('provider', provider); setAgentPref('model', model); };
  const on = (provider: string, model = '') => agentPrefs.provider === provider && (provider !== 'claude' || agentPrefs.model === model);
  return (
    <>
      <Card title="Agent model" sub="Used by the composer. Each agent runs its own CLI with your subscription.">
        <div role="radiogroup" aria-label="Agent model">
          {CLAUDE_MODELS.map(m => (
            <ModelRow on={on('claude', m.id)} label={`Claude Code · ${m.id ? m.label : 'Default'}`} sub={m.hint} available={prov('claude')?.available} onPick={() => pick('claude', m.id)} />
          ))}
          <ModelRow on={on('codex')} label="Codex" sub="OpenAI Codex CLI" available={prov('codex')?.available} onPick={() => pick('codex')} />
          <ModelRow on={on('gemini')} label="Gemini" sub="Gemini CLI" available={prov('gemini')?.available} onPick={() => pick('gemini')} />
        </div>
      </Card>
      <Card title="Directing" sub="How the agent runs bigger briefs.">
        <Row label="Auto model · full pieces" sub="With Claude · Auto: used for storyboards, styles and multi-beat briefs.">
          <Select size="sm" aria-label="Model for full pieces" value={agentPrefs.autoFull} onChange={v => setAgentPref('autoFull', v)} options={CLAUDE_MODELS.filter(m => m.id !== 'auto').map(m => ({ value: m.id, label: m.id ? m.label : 'CLI default' }))} />
        </Row>
        <Row label="Auto model · edits" sub="With Claude · Auto: used for quick actions, edits and small builds.">
          <Select size="sm" aria-label="Model for edits" value={agentPrefs.autoQuick} onChange={v => setAgentPref('autoQuick', v)} options={CLAUDE_MODELS.filter(m => m.id !== 'auto').map(m => ({ value: m.id, label: m.id ? m.label : 'CLI default' }))} />
        </Row>
        <Row label="Storyboards" sub="For full pieces the agent first proposes beats you can edit.">
          <Select size="sm" aria-label="Storyboard approval" value={agentPrefs.storyboard} onChange={v => setAgentPref('storyboard', v === 'auto' ? 'auto' : 'ask')} options={[{ value: 'ask', label: 'Wait for my approval' }, { value: 'auto', label: 'Build right away' }]} />
        </Row>
        <Row label="Turn budget" sub="Max tool round trips per message (empty = 90). Say “continue” when it runs out.">
          <input class="input input-sm" type="number" min="5" max="500" step="5" style={{ width: '72px' }} aria-label="Turn budget" placeholder="90" value={agentPrefs.turns} onChange={e => setAgentPref('turns', (e.target as HTMLInputElement).value.replace(/[^\d]/g, ''))} />
        </Row>
      </Card>
      <Card title="Default mode">
        <Row label="Edit" sub="The agent changes your file. Every run can be reviewed and undone in one click.">
          <input type="radio" name="agent-mode" aria-label="Edit" checked={agentPrefs.mode === 'edit'} onChange={() => setAgentPref('mode', 'edit')} />
        </Row>
        <Row label="Ask" sub="Read-only: critique and explain, no edits.">
          <input type="radio" name="agent-mode" aria-label="Ask" checked={agentPrefs.mode === 'ask'} onChange={() => setAgentPref('mode', 'ask')} />
        </Row>
      </Card>
    </>
  );
}

function ModelRow(props: { on: boolean; label: string; sub: string; available?: boolean; onPick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={props.on} class={'model-row' + (props.on ? ' on' : '')} onClick={props.onPick}>
      <span class="grow"><span class="set-row-label">{props.label}</span><span class="set-row-sub">{props.sub}</span></span>
      {props.available === false && <span class="muted small">not installed</span>}
      <span class={'radio' + (props.on ? ' on' : '')} aria-hidden="true">{props.on && <Check size={11} strokeWidth={3} absoluteStrokeWidth={false} />}</span>
    </button>
  );
}

// ---------------- agent runs ----------------
function AgentRuns() {
  const [count, setCount] = useState(() => chatKeys().length);
  return (
    <>
      <Card title="Review" sub="After every run that changed the file, a review card lists what changed. Keep it, compare before / after, or revert everything in one step.">
        <Row label="Undo history" sub="Agent edits are normal undo steps: ⌘Z works too."><CircleCheck class="ok-icon" /></Row>
      </Card>
      <Card title="Conversations" sub="Conversations are saved per file on this computer.">
        <Row label={`${count} saved conversation${count === 1 ? '' : 's'}`}>
          <Button size="sm" variant="danger" disabled={!count} onClick={() => { if (!confirm('Delete every saved agent conversation on this computer?')) return; for (const k of chatKeys()) try { localStorage.removeItem(k); } catch { /* */ } setCount(chatKeys().length); toast('Saved conversations deleted'); }}>Clear all</Button>
        </Row>
      </Card>
    </>
  );
}

function chatKeys() {
  const out: string[] = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith('motion.agent.chat:')) out.push(k); } } catch { /* */ }
  return out;
}

// ---------------- fonts ----------------
function Fonts() {
  const s = editor.store;
  const used = new Map<string, number>();
  for (const l of Object.values(s.project.layers)) if (l.text) used.set(l.text.fontFamily, (used.get(l.text.fontFamily) ?? 0) + 1);
  return (
    <Card title="Fonts in this file" sub="Text layers use fonts installed on this computer, or fonts embedded when a design was pasted.">
      {[...used].map(([f, n]) => <Row icon={<ALargeSmall />} label={<span style={{ fontFamily: f }}>{f}</span>} sub={`${n} text layer${n === 1 ? '' : 's'}`} />)}
      {!used.size && <div class="set-empty muted">No text layers yet.</div>}
    </Card>
  );
}

// ---------------- figma import ----------------
function FigmaImport() {
  return (
    <Card title="Debugging Figma pastes" sub="When a paste from Figma does not look right, save it and attach the file to a bug report. The file holds the clipboard data (your design) and how Motion decoded it.">
      <Row icon={<Download />} label="Save last Figma paste…" sub="Raw clipboard payload plus the decoded layer tree, as one .json file.">
        <Button onClick={() => { import('../../app/figma-capture').then(m => m.saveLastFigmaPaste()).catch(err => toast(String(err), 'error')); }}>Save…</Button>
      </Row>
      <div class="set-empty muted">Developers: start the app with MOTION_FIGMA_CAPTURE_DIR=/folder (desktop) or VITE_FIGMA_CAPTURE_DIR=/folder (npm run dev) to save every paste automatically.</div>
    </Card>
  );
}

// ---------------- updates ----------------
function Updates() {
  const st = useUpdateStatus();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(x => x + 1), 30_000); return () => clearInterval(t); }, []);
  if (!st) {
    return (
      <Card title={`Motion ${APP_VERSION}`} sub="Updates install automatically in the desktop app.">
        <div class="set-empty muted">You are using Motion in a browser, which always loads the latest build.</div>
      </Card>
    );
  }
  const busy = isBusy();
  const ready = st.ready;
  const checking = st.phase === 'checking';
  const downloading = st.phase === 'downloading' && st.progress;
  const pct = downloading ? Math.min(100, Math.round((st.progress!.received / Math.max(1, st.progress!.total)) * 100)) : 0;
  const ver = st.uiVersion;
  const shellNote = st.uiVersion !== st.shellVersion ? ` · app ${st.shellVersion}` : '';
  let line: ComponentChildren = st.lastCheck ? `Last checked ${ago(st.lastCheck)}` : 'Not checked yet';
  if (checking) line = 'Checking…';
  else if (downloading) line = `Downloading ${st.available?.version ?? ''}… ${formatBytes(st.progress!.received)} of ${formatBytes(st.progress!.total)}`;
  else if (ready) line = ready.kind === 'shell' ? `Motion ${ready.version} is ready. It installs when you restart or quit.` : `Motion ${ready.version} is ready to use.`;
  else if (st.phase === 'up-to-date') line = `You're up to date · checked ${ago(st.lastCheck)}`;
  const restart = async () => {
    const err = await restartToUpdate(flushAutosave);
    if (err) toast(err, 'error');
  };
  return (
    <>
      {st.notice && <Card class="upd-notice" sub={st.notice.text} />}
      <Card title={`Motion ${ver}`} sub={<span>{st.channel === 'beta' ? 'Beta channel' : 'Stable channel'}{shellNote}{st.uiSource === 'downloaded' ? ' · updated in place' : ''}</span>}
        right={ready
          ? <Button size="sm" variant="primary" disabled={busy} title={busy ? 'Available when the export has finished' : undefined} onClick={restart}>Restart to update</Button>
          : <Button size="sm" disabled={!st.enabled || checking || !!downloading} onClick={() => checkForUpdates()}>{checking ? 'Checking…' : 'Check for updates'}</Button>}>
        {!st.enabled && <div class="set-line muted">{st.disabledReason}</div>}
        {st.enabled && <div class="set-line muted" aria-live="polite">{line}</div>}
        {downloading && <div class="upd-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div style={{ width: pct + '%' }} /></div>}
        {st.phase === 'error' && st.error && (
          <div class="set-line upd-error">
            {st.error}
            {st.available?.manual && st.releasesUrl && <> <a href={st.releasesUrl} target="_blank" rel="noreferrer">Open downloads</a></>}
          </div>
        )}
        {busy && ready && <div class="set-line muted">Exporting: the update waits until the export has finished.</div>}
      </Card>
      {(ready || st.available) && (ready || st.available)!.notes && (
        <Card title={`What's new in ${(ready || st.available)!.version}`}>
          <div class="upd-notes">{renderNotes((ready || st.available)!.notes)}</div>
        </Card>
      )}
      <Card title="Settings">
        <Row label="Check automatically" sub="When Motion starts and every 6 hours. Updates download in the background and never interrupt your work.">
          <Switch label="Check automatically" checked={st.auto} disabled={!st.enabled} onChange={v => setUpdatePrefs({ auto: v })} />
        </Row>
        <Row label="Channel" sub={st.channel === 'beta' ? 'Early builds: new features sooner, a little less tested' : 'Tested releases'}>
          <Segmented size="sm" label="Update channel" value={st.channel} disabled={!st.enabled}
            options={[{ value: 'stable', label: 'Stable' }, { value: 'beta', label: 'Beta' }]} onChange={v => setUpdatePrefs({ channel: v })} />
        </Row>
        {st.uiSource === 'downloaded' && (
          <Row label="Use the built-in version" sub={`Go back to Motion ${st.bundledVersion} on the next start, if this version misbehaves`}>
            <Button size="sm" onClick={() => revertUi().then(() => toast(`Motion ${st.bundledVersion} is used after a restart`))}>Revert</Button>
          </Row>
        )}
        {!st.shellSupported && st.shellBlocked && st.enabled && (
          <Row label="Full app updates" sub={st.shellBlocked}><Status kind="off">Manual</Status></Row>
        )}
      </Card>
    </>
  );
}

const APP_VERSION = (import.meta as any).env?.VITE_APP_VERSION ?? '';

function useUpdateStatus(): UpdateStatus | null {
  const [s, setS] = useState<UpdateStatus | null>(getUpdateStatus());
  useEffect(() => onUpdateStatus(x => setS(x ? { ...x } : null)), []);
  return updatesAvailable() ? s : null;
}

function ago(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

/** release notes are short markdown-ish text: "- item" lines become a list, other lines paragraphs */
function renderNotes(notes: string) {
  const out: ComponentChildren[] = [];
  let items: string[] = [];
  const flush = () => { if (items.length) out.push(<ul>{items.map(i => <li>{i}</li>)}</ul>); items = []; };
  for (const raw of notes.split(/\r?\n/)) {
    const l = raw.trim().replace(/\*\*/g, '');
    if (!l) { flush(); continue; }
    const m = /^[-*•]\s+(.*)$/.exec(l);
    if (m) items.push(m[1]);
    else { flush(); out.push(<p>{l.replace(/^#+\s*/, '')}</p>); }
  }
  flush();
  return out;
}
