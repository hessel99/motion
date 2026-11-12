import { render } from 'preact';
import { App } from './ui/App';
import './ui/styles.css';
import { editor } from './app/editor';
import { agentClient } from './agent/client';
import { loadDemo, loadStress, preloadImporters, restoreAutosave, restoreAutosaveNative, setupAutosave, setupTitle } from './app/actions';

render(<App />, document.getElementById('app')!);

// startup: url params for testing (?stress=5000[&animated=0.1], ?demo, ?hud), else restore autosave, else demo
const q = new URLSearchParams(location.search);
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
