import { render } from 'preact';
import { App } from './ui/App';
import './ui/styles.css';
import { initTheme } from './ui/theme';
import { editor } from './app/editor';
import { agentClient } from './agent/client';
import { loadDemo, loadStress, preloadImporters, restoreAutosave, restoreAutosaveNative, setupAutosave, setupTitle } from './app/actions';

const q = new URLSearchParams(location.search);
initTheme();

if (q.has('styleguide')) {
  // living style guide (tokens + components in both themes): ?styleguide
  Promise.all([import('./ui/StyleGuide'), import('./ui/chrome/icons')]).then(([m, i]) => render(<i.IconProvider><m.StyleGuide /></i.IconProvider>, document.getElementById('app')!));
} else startEditor();

function startEditor() {
  render(<App />, document.getElementById('app')!);

  // startup: url params for testing (?stress=5000[&animated=0.1], ?demo, ?hud), else restore autosave, else demo
  requestAnimationFrame(async () => {
    if (q.has('stress')) loadStress(+(q.get('stress') || 1000), q.get('kinds')?.split(',') as any, q.has('nested'), q.has('animated') ? +q.get('animated')! : undefined);
    else if (q.has('demo') || (!q.has('blank') && !(await restoreAutosaveNative()) && !restoreAutosave())) loadDemo();
    if (q.has('hud')) { editor.showHud = true; editor.emit('hud'); }
    if (q.has('play')) editor.play();
    setupAutosave();
    setupTitle();
    preloadImporters();
  });
  if (!q.has('nobridge')) agentClient.connect();
  // stress lab (scripts/stress-lab.mjs): scene builders + measurement loops, never loaded otherwise
  if (q.has('lab')) import('./lab/index');
}
