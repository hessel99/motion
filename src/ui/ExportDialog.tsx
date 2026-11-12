// the Export dialog (every format; video with format, resolution, fps, quality, progress with eta + cancel).
// mounted on demand into its own container (openExportDialog) so App only needs a menu item,
// and lazy-loaded so the muxer stays out of the main bundle.

import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { editor } from '../app/editor';
import { download, exportAeScript, exportFramePng, exportGifFile, exportLottie, toast } from '../app/actions';
import { Button, Dialog, Segmented } from './ui';
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

type Kind = 'video' | 'gif' | 'image' | 'lottie' | 'ae';
const KINDS: { value: Kind; label: string }[] = [
  { value: 'video', label: 'Video' }, { value: 'gif', label: 'GIF' }, { value: 'image', label: 'Image' }, { value: 'lottie', label: 'Lottie' }, { value: 'ae', label: 'After Effects' },
];
const remembered = (): Kind => { try { const v = localStorage.getItem('motion.export.kind') as Kind; return KINDS.some(k => k.value === v) ? v : 'video'; } catch { return 'video'; } };

/** the export dialog: the one place to export (top bar Export, ⌘E). video (MP4 / WebM with
 *  progress, eta, cancel), GIF, the current frame as PNG, Lottie JSON, an After Effects script */
export function ExportDialog(props: { onClose: () => void }) {
  const comp = editor.store.comp;
  const [kind, setKindState] = useState<Kind>(remembered);
  const setKind = (k: Kind) => { setKindState(k); try { localStorage.setItem('motion.export.kind', k); } catch { /* */ } };
  const [format, setFormat] = useState<VideoFormat>('mp4');
  const [scale, setScale] = useState(1);
  const [fps, setFps] = useState(comp.fps);
  const [quality, setQuality] = useState<VideoQuality>('high');
  const [gifSize, setGifSize] = useState(640);
  const [gifFps, setGifFps] = useState(Math.min(comp.fps, 30));
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

  const startVideo = async () => {
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
  const start = () => {
    if (kind === 'video') return startVideo();
    // the other formats run with their own progress toast (or instantly): the dialog closes
    props.onClose();
    if (kind === 'gif') exportGifFile({ maxSize: gifSize, fps: gifFps }).catch(() => {});
    else if (kind === 'image') exportFramePng(scale).catch(() => {});
    else if (kind === 'lottie') exportLottie();
    else if (kind === 'ae') exportAeScript();
  };

  const cancel = () => { if (busy) abort.current?.abort(); else props.onClose(); };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  // modal: keep editor shortcuts (space = play, delete, ...) away while the dialog is open
  useEffect(() => {
    // editor shortcuts skip themselves while an aria-modal dialog is open; don't stop propagation
    // here, it would also starve the dialog's own focus trap and segmented-control arrow keys
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRef.current(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const gifScale = Math.min(1, gifSize / Math.max(comp.width, comp.height));
  const label: Record<Kind, string> = { video: busy ? 'Exporting…' : 'Export video', gif: 'Export GIF', image: 'Export PNG', lottie: 'Export Lottie', ae: 'Export script' };
  return (
    <Dialog title="Export" class="xv-dialog" actionsClass="xv-actions" onClose={() => cancelRef.current()} dismissable={!busy}
      actions={<>
        <Button onClick={cancel}>Cancel</Button>
        <Button variant="primary" class="xv-go" disabled={busy || (kind === 'video' && support !== null && !support[format])} onClick={start}>{label[kind]}</Button>
      </>}>
        <Segmented class="xv-kinds" label="Format" value={kind} disabled={busy} options={KINDS} onChange={setKind} />
        <div class="xv-sub muted">{comp.name} · {comp.width}×{comp.height} · {fmtDurationS(comp.duration)}</div>
        {kind === 'video' && <>
          <div class="xv-grid">
            <label for="xv-format">Format</label>
            <select id="xv-format" value={format} disabled={busy} onChange={e => setFormat((e.target as HTMLSelectElement).value as VideoFormat)}>
              <option value="mp4" disabled={support !== null && !support.mp4}>MP4 (H.264){support && !support.mp4 ? ' – unavailable' : ''}</option>
              <option value="webm" disabled={support !== null && !support.webm}>WebM (VP9)</option>
            </select>
            <label>Resolution</label>
            <Segmented class="xv-seg" label="Resolution" value={scale} disabled={busy} options={SCALES.map(s => ({ value: s, label: `${s}×` }))} onChange={setScale} />
            <label for="xv-fps">Frame rate</label>
            <select id="xv-fps" value={String(fps)} disabled={busy} onChange={e => setFps(Number((e.target as HTMLSelectElement).value))}>
              {[...new Set([comp.fps, 24, 25, 30, 50, 60])].sort((a, b) => a - b).map(f => (
                <option value={String(f)}>{f} fps{f === comp.fps ? ' (comp)' : ''}</option>
              ))}
            </select>
            <label>Quality</label>
            <Segmented class="xv-seg" label="Quality" value={quality} disabled={busy} options={(['low', 'medium', 'high'] as VideoQuality[]).map(q => ({ value: q, label: q[0].toUpperCase() + q.slice(1) }))} onChange={setQuality} />
          </div>
          <div class="xv-info muted">
            {dims.width}×{dims.height} · {frames} frames · {(bitrate / 1e6).toFixed(1)} Mbit/s · ~{fmtBytes(estBytes)} · audio layers are mixed in
          </div>
        </>}
        {kind === 'gif' && <>
          <div class="xv-grid">
            <label>Size</label>
            <Segmented class="xv-seg" label="GIF size" value={gifSize} options={[320, 480, 640, 960].map(v => ({ value: v, label: `${v}px` }))} onChange={setGifSize} />
            <label for="xv-gfps">Frame rate</label>
            <select id="xv-gfps" value={String(gifFps)} onChange={e => setGifFps(Number((e.target as HTMLSelectElement).value))}>
              {[12, 15, 24, 25, 30, 50].map(f => <option value={String(f)}>{f} fps</option>)}
            </select>
          </div>
          <div class="xv-info muted">{Math.round(comp.width * gifScale)}×{Math.round(comp.height * gifScale)} · {Math.max(1, Math.round(comp.duration * gifFps))} frames · loops forever</div>
        </>}
        {kind === 'image' && <>
          <div class="xv-grid">
            <label>Scale</label>
            <Segmented class="xv-seg" label="Scale" value={scale} options={[0.5, 1, 2, 4].map(s => ({ value: s, label: `${s}×` }))} onChange={setScale} />
          </div>
          <div class="xv-info muted">The frame under the playhead ({editor.store.time.toFixed(2)}s) as a PNG.</div>
        </>}
        {kind === 'lottie' && <div class="xv-info muted">Lottie JSON for the web and apps (lottie-web, iOS, Android): shapes, text, gradients, precomps and markers.</div>}
        {kind === 'ae' && <div class="xv-info muted">A script (.jsx) that rebuilds this composition in After Effects: File › Scripts › Run Script File… Shape layers, text, precomps, keyframes with their easing.</div>}
        {prog && (
          <div class="xv-progress">
            <div class="xv-bar progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(prog.progress * 100)}><div style={{ width: `${(prog.progress * 100).toFixed(1)}%` }} /></div>
            <div class="xv-stat muted">
              <span>{prog.frame} / {prog.total}{prog.fps ? ` · ${prog.fps.toFixed(0)} fps` : ''}</span>
              <span>{prog.progress >= 1 ? 'Finishing…' : `ETA ${fmtDuration(prog.etaMs)}`}</span>
            </div>
          </div>
        )}
    </Dialog>
  );
}

function fmtDurationS(d: number) { return `${+d.toFixed(2)}s`; }
