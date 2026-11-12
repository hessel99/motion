// Settings: its own tab in the tab strip. a left nav (Account / Agents / Workspace / App) and
// card sections. Appearance, Connections, Keyboard shortcuts, Models and Agent runs are real;
// Profile, Notifications, Members and Updates are placeholders.

import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { editor } from '../../app/editor';
import { toast } from '../../app/actions';
import { prefs, setPref } from '../../app/prefs';
import { agentClient } from '../../agent/client';
import { useChannels } from '../hooks';
import { getThemePref, onThemeChange, setTheme, type ThemePref } from '../theme';
import { Button, Dialog, Kbd } from '../ui';
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
    { id: 'light', label: 'Light', sub: 'Paper white', Icon: Sun },
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
    </>
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
        <Row label="Variations" sub="Ask for variations: the agent saves A / B / C versions you preview and pick in the sidebar."><CircleCheck class="ok-icon" /></Row>
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

// ---------------- updates ----------------
function Updates() {
  return (
    <Card title="Motion 0.1.0" sub="Updates are delivered with new builds of the desktop app.">
      <Row label="You're on the latest version you installed"><Button size="sm" onClick={() => toast('Automatic updates are not set up yet')}>Check for updates</Button></Row>
    </Card>
  );
}
