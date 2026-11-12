import { render } from 'preact';
import { App } from './ui/App';
import './ui/styles.css';
import { initTheme } from './ui/theme';
import { editor } from './app/editor';
import { setupDocuments } from './app/documents';
import { agentClient } from './agent/client';
import { signalAppReady, updatesAvailable } from './app/updates';
import { loadDemo, loadStress, newProject, preloadImporters, restoreAutosave, restoreAutosaveNative, setupAutosave, setupTitle } from './app/actions';

const q = new URLSearchParams(location.search);
initTheme();

if (q.has('styleguide')) {
  // living style guide (tokens + components in both themes): ?styleguide
  Promise.all([import('./ui/StyleGuide'), import('./ui/chrome/icons')]).then(([m, i]) => render(<i.IconProvider><m.StyleGuide /></i.IconProvider>, document.getElementById('app')!));
} else startEditor();

function startEditor() {
  setupDocuments();
  render(<App />, document.getElementById('app')!);

  // ?stress=5000[&animated=0.1], ?demo, ?blank (an empty document), ?hud, ?play
  requestAnimationFrame(async () => {
    // startup: url params for testing, else the autosaved tabs, else the Home view
    if (q.has('stress')) loadStress(+(q.get('stress') || 1000), q.get('kinds')?.split(',') as any, q.has('nested'), q.has('animated') ? +q.get('animated')! : undefined);
    else if (q.has('demo')) loadDemo();
    else if (q.has('blank')) newProject();
    else if (!(await restoreAutosaveNative()) && !restoreAutosave()) editor.emit('home');
    if (q.has('hud')) { editor.showHud = true; editor.emit('hud'); }
    if (q.has('play')) editor.play();
    setupAutosave();
    setupTitle();
    preloadImporters();
    import('./app/figma-capture').then(m => m.setupFigmaCaptureAutoSave()).catch(() => {});
    // the editor is up: a freshly installed update is kept (no signal = automatic rollback)
    signalAppReady();
  });
  if (updatesAvailable()) {
    import('./ui/updates/UpdateNotice').then(({ UpdateNotice }) => {
      const el = document.body.appendChild(document.createElement('div'));
      el.id = 'update-notice';
      render(<UpdateNotice />, el);
    });
  }
  if (!q.has('nobridge')) agentClient.connect();
  // figma shader sources: pasted designs get their shaders' code through the bridge
  void import('./app/shader-sources').then(m => m.shaderSources.start(editor.store));
  // stress lab (scripts/stress-lab.mjs): scene builders + measurement loops, never loaded otherwise
  if (q.has('lab')) import('./lab/index');
}
