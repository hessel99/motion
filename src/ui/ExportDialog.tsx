// "Export video" dialog: format, resolution, fps, quality, progress with eta + cancel.
// mounted on demand into its own container (openExportDialog) so App only needs a menu item,
// and lazy-loaded so the muxer stays out of the main bundle.

import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { editor } from '../app/editor';
import { download, toast } from '../app/actions';
import {
  evenDimensions, computeBitrate, frameCount, exportVideoDetailed, probeVideoSupport, videoFileName,
  type VideoFormat, type VideoQuality, type ExportProgress,
} from '../export/video';

let host: HTMLDivElement | null = null;

export function openExportDialog() {
  if (host) return;
  host = document.createElement('div');
  document.body.appendChild(host);
  render(<ExportDialog onClose={closeExportDialog} />, host);
}

export function closeExportDialog() {
  if (!host) return;
  render(null, host);
  host.remove();
  host = null;
}

const SCALES = [0.5, 1, 2];

function fmtDuration(ms: number) {
  if (!isFinite(ms)) return '–';
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function fmtBytes(n: number) {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(',') + 1);
}

async function saveVideo(blob: Blob, name: string, format: VideoFormat): Promise<string | null | 'downloaded'> {
  const nat = (window as any).motionNative;
  const save = nat?.saveFileAs ?? nat?.saveFile;
  if (save) {
    const filters = [format === 'mp4' ? { name: 'MP4 video', extensions: ['mp4'] } : { name: 'WebM video', extensions: ['webm'] }];
    return await save({ defaultPath: name, data: await blobToBase64(blob), encoding: 'base64', filters });
  }
  download(name, blob, blob.type);
  return 'downloaded';
}

export function ExportDialog(props: { onClose: () => void }) {
  const comp = editor.store.comp;
  const [format, setFormat] = useState<VideoFormat>('mp4');
  const [scale, setScale] = useState(1);
  const [fps, setFps] = useState(comp.fps);
  const [quality, setQuality] = useState<VideoQuality>('high');
  const [support, setSupport] = useState<Record<VideoFormat, string | null> | null>(null);
  const [prog, setProg] = useState<ExportProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    probeVideoSupport(comp.width, comp.height, comp.fps).then(s => {
      setSupport(s);
      if (!s.mp4 && s.webm) setFormat('webm');
    });
    return () => abort.current?.abort();
  }, []);

  const dims = evenDimensions(comp.width, comp.height, scale);
  const frames = frameCount(comp.duration, fps);
  const bitrate = computeBitrate(dims.width, dims.height, fps, quality);
  const estBytes = (bitrate / 8) * comp.duration;

  const start = async () => {
    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);
    setProg({ frame: 0, total: frames, progress: 0, elapsedMs: 0, etaMs: Infinity, fps: 0 });
    try {
      const res = await exportVideoDetailed({ format, scale, fps, quality }, p => setProg(p), ac.signal);
      const name = videoFileName(editor.store.project.name, res.format);
      if (res.format !== format) toast(`H.264 is not available here, exported WebM (${res.codec}) instead`);
      const saved = await saveVideo(res.blob, name, res.format);
      if (saved) toast(`Exported ${res.frames} frames (${fmtBytes(res.blob.size)}) in ${fmtDuration(res.elapsedMs)} · ${Math.round(res.frames / (res.elapsedMs / 1000))} fps`);
      props.onClose();
    } catch (e: any) {
      if (e?.name === 'AbortError') toast('Export cancelled');
      else { console.error(e); toast('Video export failed: ' + (e?.message ?? e), 'error'); }
      setBusy(false);
      setProg(null);
    } finally {
      abort.current = null;
    }
  };

  const cancel = () => { if (busy) abort.current?.abort(); else props.onClose(); };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  // modal: keep editor shortcuts (space = play, delete, ...) away while the dialog is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); cancelRef.current(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div class="xv-backdrop" onPointerDown={e => { if (e.target === e.currentTarget && !busy) props.onClose(); }}>
      <div class="xv-dialog" role="dialog" aria-label="Export video">
        <div class="xv-title">Export video</div>
        <div class="xv-grid">
          <label>Format</label>
          <select value={format} disabled={busy} onChange={e => setFormat((e.target as HTMLSelectElement).value as VideoFormat)}>
            <option value="mp4" disabled={support !== null && !support.mp4}>MP4 (H.264){support && !support.mp4 ? ' – unavailable' : ''}</option>
            <option value="webm" disabled={support !== null && !support.webm}>WebM (VP9)</option>
          </select>
          <label>Resolution</label>
          <div class="xv-seg">
            {SCALES.map(s => (
              <button class={scale === s ? 'on' : ''} disabled={busy} onClick={() => setScale(s)}>{s}×</button>
            ))}
          </div>
          <label>Frame rate</label>
          <select value={String(fps)} disabled={busy} onChange={e => setFps(Number((e.target as HTMLSelectElement).value))}>
            {[...new Set([comp.fps, 24, 25, 30, 50, 60])].sort((a, b) => a - b).map(f => (
              <option value={String(f)}>{f} fps{f === comp.fps ? ' (comp)' : ''}</option>
            ))}
          </select>
          <label>Quality</label>
          <div class="xv-seg">
            {(['low', 'medium', 'high'] as VideoQuality[]).map(q => (
              <button class={quality === q ? 'on' : ''} disabled={busy} onClick={() => setQuality(q)}>{q[0].toUpperCase() + q.slice(1)}</button>
            ))}
          </div>
        </div>
        <div class="xv-info muted">
          {dims.width}×{dims.height} · {frames} frames · {(bitrate / 1e6).toFixed(1)} Mbit/s · ~{fmtBytes(estBytes)}
        </div>
        {prog && (
          <div class="xv-progress">
            <div class="xv-bar"><div style={{ width: `${(prog.progress * 100).toFixed(1)}%` }} /></div>
            <div class="xv-stat muted">
              <span>{prog.frame} / {prog.total}{prog.fps ? ` · ${prog.fps.toFixed(0)} fps` : ''}</span>
              <span>{prog.progress >= 1 ? 'Finishing…' : `ETA ${fmtDuration(prog.etaMs)}`}</span>
            </div>
          </div>
        )}
        <div class="xv-actions">
          <button onClick={cancel}>Cancel</button>
          <button class="primary" disabled={busy || (support !== null && !support[format])} onClick={start}>{busy ? 'Exporting…' : 'Export'}</button>
        </div>
      </div>
    </div>
  );
}
