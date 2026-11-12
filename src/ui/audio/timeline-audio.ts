// timeline drawing for music: the waveform of audio layer rows (min/max peak pyramid computed once per
// buffer, rendered into cached 512 px tiles at the exact zoom and device pixel ratio, so it stays crisp
// at any zoom and redraws cost a few drawImage calls), beat / bar ticks in the ruler, subtle section
// bands, and the snap-to-music toggle.

import type { Asset, Layer } from '../../core/model';
import type { Store } from '../../core/store';
import { getAudioBuffer } from '../../audio/engine';
import { music, beats, bars, sections, snapToMusic } from '../../audio/timing';
import { onThemeChange } from '../theme';

// ---------------------------------------------------------------- snapping preference
const SNAP_KEY = 'motion.audioSnap';
export const musicSnap = {
  on: (() => { try { return localStorage.getItem(SNAP_KEY) !== '0'; } catch { return true; } })(),
  set(v: boolean) { this.on = v; try { localStorage.setItem(SNAP_KEY, v ? '1' : '0'); } catch { /* private mode */ } listeners.forEach(f => f()); },
};
const listeners = new Set<() => void>();
export function onMusicSnap(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; }

/** snap a time to the music within px pixels (null: nothing close, snapping off, or bypassed) */
export function snapMusicTime(store: Store, t: number, pxPerSec: number, px = 6, bypass = false): number | null {
  if (!musicSnap.on || bypass) return null;
  return snapToMusic(store, t, px / pxPerSec);
}

// ---------------------------------------------------------------- colors (css custom properties)
let colors: Record<string, string> | null = null;
onThemeChange(() => { colors = null; });
function col(name: string, fallback: string): string {
  if (!colors) colors = {};
  let c = colors[name];
  if (c === undefined) {
    try { c = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { c = fallback; }
    colors[name] = c;
  }
  return c;
}

// ---------------------------------------------------------------- peaks pyramid
interface Pyramid { sr: number; levels: { bucket: number; min: Float32Array; max: Float32Array }[] }
const pyramids = new WeakMap<AudioBuffer, Pyramid>();
function pyramid(buf: AudioBuffer): Pyramid {
  let p = pyramids.get(buf);
  if (p) return p;
  const ch = buf.numberOfChannels, n = buf.length, B = 32;
  const m0 = Math.ceil(n / B);
  const mn = new Float32Array(m0), mx = new Float32Array(m0);
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  for (let i = 0; i < m0; i++) {
    let lo = 0, hi = 0;
    const a = i * B, b = Math.min(n, a + B);
    for (let c = 0; c < ch; c++) { const d = data[c]; for (let j = a; j < b; j++) { const v = d[j]; if (v < lo) lo = v; if (v > hi) hi = v; } }
    mn[i] = lo; mx[i] = hi;
  }
  const levels = [{ bucket: B, min: mn, max: mx }];
  while (levels[levels.length - 1].min.length > 512) {
    const prev = levels[levels.length - 1], m = Math.ceil(prev.min.length / 4);
    const a = new Float32Array(m), b = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      let lo = 0, hi = 0;
      for (let j = i * 4; j < Math.min(prev.min.length, i * 4 + 4); j++) { if (prev.min[j] < lo) lo = prev.min[j]; if (prev.max[j] > hi) hi = prev.max[j]; }
      a[i] = lo; b[i] = hi;
    }
    levels.push({ bucket: prev.bucket * 4, min: a, max: b });
  }
  pyramids.set(buf, (p = { sr: buf.sampleRate, levels }));
  return p;
}

// ---------------------------------------------------------------- tiles
const TILE = 512;
const tiles = new Map<string, HTMLCanvasElement>();
function tile(asset: Asset, buf: AudioBuffer, pxPerSec: number, dpr: number, h: number, color: string, idx: number): HTMLCanvasElement {
  const key = `${asset.id}|${pxPerSec.toFixed(4)}|${dpr}|${h}|${color}|${idx}`;
  let c = tiles.get(key);
  if (c) { tiles.delete(key); tiles.set(key, c); return c; } // lru touch
  c = document.createElement('canvas');
  c.width = TILE; c.height = Math.ceil(h * dpr);
  const g = c.getContext('2d')!;
  const P = pyramid(buf), spp = P.sr / (pxPerSec * dpr); // samples per device pixel
  let lv = P.levels[0];
  for (const L of P.levels) if (L.bucket <= spp) lv = L;
  const mid = c.height / 2, amp = c.height / 2 - 0.5;
  g.fillStyle = color;
  for (let x = 0; x < TILE; x++) {
    const s0 = (idx * TILE + x) * spp, s1 = s0 + spp;
    let i0 = Math.floor(s0 / lv.bucket), i1 = Math.max(i0 + 1, Math.ceil(s1 / lv.bucket));
    if (i0 >= lv.min.length) break;
    i1 = Math.min(i1, lv.min.length);
    let lo = 0, hi = 0;
    for (let i = i0; i < i1; i++) { if (lv.min[i] < lo) lo = lv.min[i]; if (lv.max[i] > hi) hi = lv.max[i]; }
    const y0 = mid - hi * amp, y1 = mid - lo * amp;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
  tiles.set(key, c);
  while (tiles.size > 96) tiles.delete(tiles.keys().next().value!);
  return c;
}

export interface TlView { leftW: number; w: number; h: number; headerH: number; pxPerSec: number; dpr: number; tToX(t: number): number; xToT(x: number): number }

/** waveform of an audio layer within its row (cy = row centre, h = waveform height). false: not decoded */
export function drawWaveform(g: CanvasRenderingContext2D, v: TlView, l: Layer, asset: Asset, cy: number, h: number, color: string): boolean {
  const buf = getAudioBuffer(asset);
  if (!buf) return false;
  const start = l.startTime ?? 0;
  const x0 = v.tToX(start); // css px of buffer time 0
  const vis0 = Math.max(v.leftW, v.tToX(Math.max(start, l.inPoint))), vis1 = Math.min(v.w, v.tToX(Math.min(start + buf.duration, l.outPoint)));
  if (vis1 <= vis0) return true;
  const tw = TILE / v.dpr; // tile width in css px
  const first = Math.max(0, Math.floor((vis0 - x0) / tw)), last = Math.floor((vis1 - x0) / tw);
  g.save();
  g.beginPath(); g.rect(vis0, cy - h / 2 - 1, vis1 - vis0, h + 2); g.clip();
  for (let i = first; i <= last; i++) {
    const c = tile(asset, buf, v.pxPerSec, v.dpr, h, color, i);
    g.drawImage(c, x0 + i * tw, cy - h / 2, tw, c.height / v.dpr);
  }
  g.restore();
  return true;
}

const SECTION_COLOR: Record<string, [string, string]> = {
  intro: ['--tl-sec-intro', 'rgba(120,170,255,0.10)'],
  build: ['--tl-sec-build', 'rgba(255,190,90,0.13)'],
  drop: ['--tl-sec-drop', 'rgba(255,90,120,0.16)'],
  breakdown: ['--tl-sec-breakdown', 'rgba(110,220,200,0.10)'],
  main: ['--tl-sec-main', 'rgba(255,255,255,0.04)'],
  outro: ['--tl-sec-outro', 'rgba(160,140,255,0.10)'],
};

/** beat / bar ticks + section bands in the ruler, faint bar lines through the rows */
export function drawMusicRuler(g: CanvasRenderingContext2D, v: TlView, store: Store) {
  const m = music(store);
  if (!m) return;
  const H = v.headerH;
  // section bands: a tinted strip at the bottom of the ruler, a light wash over the rows
  for (const s of sections(m)) {
    const a = Math.max(v.leftW, v.tToX(s.t0)), b = Math.min(v.w, v.tToX(s.t1));
    if (b <= a) continue;
    const [name, fb] = SECTION_COLOR[s.label] ?? SECTION_COLOR.main;
    g.fillStyle = col(name, fb);
    g.fillRect(a, H - 4, b - a, 4);
    g.globalAlpha = 0.5;
    g.fillRect(a, H, b - a, v.h - H);
    g.globalAlpha = 1;
    if (s.label !== 'main' && b - a > 40) {
      g.fillStyle = col('--tl-sec-label', 'rgba(255,255,255,0.55)');
      g.font = '600 9px system-ui, sans-serif';
      g.fillText(s.label.toUpperCase(), a + 3, H - 9);
    }
  }
  const bt = beats(m), br = bars(m);
  const beatPx = (60 / m.a.bpm) * v.pxPerSec;
  const tick = col('--tl-beat', 'rgba(255,200,90,0.55)'), barTick = col('--tl-bar-tick', 'rgba(255,200,90,0.95)');
  if (beatPx >= 5) {
    g.fillStyle = tick;
    for (const t of bt) { const x = Math.round(v.tToX(t)) + 0.5; if (x >= v.leftW && x <= v.w) g.fillRect(x - 0.5, H - 6, 1, 6); }
  }
  const barPx = beatPx * m.a.meter, every = barPx >= 28 ? 1 : barPx >= 7 ? 4 : 16;
  g.font = '9px system-ui, sans-serif';
  br.forEach((t, i) => {
    if (i % every) return;
    const x = Math.round(v.tToX(t)) + 0.5;
    if (x < v.leftW || x > v.w) return;
    g.fillStyle = barTick;
    g.fillRect(x - 0.5, H - 10, 1.5, 10);
    g.fillStyle = col('--tl-bar-line', 'rgba(255,200,90,0.07)');
    g.fillRect(x - 0.5, H, 1, v.h - H);
    if (barPx * every >= 24) { g.fillStyle = barTick; g.fillText(String(i + 1), x + 3, H - 15); }
  });
}

/** the ♪ snap toggle in the timeline header (only while a comp has music): its hit box */
export function musicToggleBox(v: TlView, store: Store): { x: number; y: number; w: number; h: number } | null {
  if (!music(store)) return null;
  return { x: v.leftW - 182, y: 5, w: 26, h: v.headerH - 10 };
}
export function drawMusicToggle(g: CanvasRenderingContext2D, v: TlView, store: Store, on: { bg: string; text: string }, off: { bg: string; text: string }) {
  const b = musicToggleBox(v, store);
  if (!b) return;
  const s = musicSnap.on ? on : off;
  g.fillStyle = s.bg;
  g.beginPath(); g.roundRect(b.x, b.y, b.w, b.h, 4); g.fill();
  g.fillStyle = s.text;
  g.font = '12px system-ui, sans-serif';
  g.fillText('♪', b.x + b.w / 2 - 4, v.headerH / 2);
}
