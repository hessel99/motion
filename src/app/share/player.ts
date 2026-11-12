// the preview page: one self-contained html file with the animation (a frame-accurate video
// rendered by the export pipeline, embedded as a data url) and a small player: play / pause,
// scrub, loop, frame-accurate time. no network, no scripts from elsewhere.

import { editor } from '../editor';
import { evenDimensions, exportVideoDetailed, type ExportProgress } from '../../export/video';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
}

export interface PreviewPage { html: string; name: string; bytes: number }

/** render the active composition and wrap it in the player page (max 1280 px on the long side) */
export async function buildPreviewPage(onProgress?: (p: ExportProgress) => void, signal?: AbortSignal): Promise<PreviewPage> {
  const s = editor.store, c = s.comp;
  const scale = Math.min(1, 1280 / Math.max(c.width, c.height));
  const res = await exportVideoDetailed({ format: 'mp4', scale, quality: 'medium' }, onProgress, signal);
  const dims = evenDimensions(c.width, c.height, scale);
  const src = await blobToDataUrl(res.blob);
  const title = `${s.project.name || 'Untitled'} · ${c.name}`;
  const html = pageHtml({ title, src, width: dims.width, height: dims.height, fps: c.fps, duration: c.duration });
  const name = `${(s.project.name || 'preview').replace(/[^\w\- ]+/g, '').trim() || 'preview'} - ${c.name.replace(/[^\w\- ]+/g, '').trim() || 'comp'}.html`;
  return { html, name, bytes: html.length };
}

export function pageHtml(o: { title: string; src: string; width: number; height: number; fps: number; duration: number }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#141414;color:#ececec;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{width:min(92vw,${o.width}px)}
.stage{background:#0d0d0d;border-radius:14px;overflow:hidden;aspect-ratio:${o.width}/${o.height}}
video{display:block;width:100%;height:100%}
.bar{display:flex;align-items:center;gap:10px;margin-top:12px;padding:6px 8px;background:#1f1f1f;border-radius:999px}
button{width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:#ececec;cursor:pointer;display:grid;place-items:center;flex:none}
button:hover{background:#2c2c2c}button.on{background:#3b3b3b}
#play{background:#ececec;color:#141414}#play:hover{background:#fff}
input[type=range]{flex:1;accent-color:#5b8ff9}
.time{font:12px ui-monospace,Menlo,monospace;color:#9a9a9a;min-width:120px;text-align:right;font-variant-numeric:tabular-nums}
h1{font-size:13px;font-weight:600;margin:0 0 10px;color:#c4c4c4}
</style></head><body>
<div class="wrap">
<h1>${esc(o.title)}</h1>
<div class="stage"><video id="v" src="${o.src}" playsinline muted loop autoplay></video></div>
<div class="bar">
<button id="play" aria-label="Play / pause"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path id="ic" d="M7 4v16l13-8z"/></svg></button>
<input id="t" type="range" min="0" max="${o.duration}" step="${(1 / o.fps).toFixed(6)}" value="0" aria-label="Time">
<button id="loop" class="on" aria-label="Loop" title="Loop"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg></button>
<span class="time" id="tc">0:00:00 / ${o.duration.toFixed(2)}s</span>
</div></div>
<script>
(function(){var v=document.getElementById('v'),t=document.getElementById('t'),p=document.getElementById('play'),ic=document.getElementById('ic'),l=document.getElementById('loop'),tc=document.getElementById('tc'),fps=${o.fps},dur=${o.duration};
function fmt(s){var f=Math.floor(s*fps+1e-6),sec=Math.floor(f/fps);return Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0')+':'+String(f%fps).padStart(2,'0')}
function icon(){ic.setAttribute('d',v.paused?'M7 4v16l13-8z':'M6 4h4v16H6zM14 4h4v16h-4z')}
function tick(){t.value=v.currentTime;tc.textContent=fmt(v.currentTime)+' / '+dur.toFixed(2)+'s';requestAnimationFrame(tick)}
p.onclick=function(){v.paused?v.play():v.pause()};v.onplay=v.onpause=icon;
t.oninput=function(){v.pause();v.currentTime=+t.value};
l.onclick=function(){v.loop=!v.loop;l.classList.toggle('on',v.loop)};
document.addEventListener('keydown',function(e){if(e.code==='Space'){e.preventDefault();p.onclick()}if(e.key===','||e.key==='.'){v.pause();v.currentTime=Math.max(0,Math.min(dur,v.currentTime+(e.key==='.'?1:-1)/fps))}});
icon();tick();})();
</script></body></html>`;
}
