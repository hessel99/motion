// the editor runtime: owns the store, the renderer and the single requestAnimationFrame loop.
// everything that draws per frame (webgl canvas, overlay, timeline) is driven from here so
// playback never goes through the ui framework.

import { Store } from '../core/store';
import { Renderer } from '../render/renderer';
import type { Project } from '../core/model';
import * as commands from '../core/commands';

export type Tool = 'select' | 'rect' | 'ellipse' | 'star' | 'polygon' | 'text' | 'pen' | 'hand';

export interface FrameHook { (now: number, t: number, playing: boolean): void }

export class Editor {
  store = new Store();
  renderer!: Renderer;
  tool: Tool = 'select';
  private hooks = new Set<FrameHook>();
  private raf = 0;
  private lastNow = 0;
  private clock = 0;
  /** play at comp fps instead of display refresh (off = smoothest) */
  snapPlaybackToFrames = false;
  /** frame timing ring buffer (ms between frames) for the perf hud */
  frameTimes = new Float32Array(120);
  frameIdx = 0;
  showHud = false;
  /** right panel tab: inspector or the style / component library */
  rightTab: 'design' | 'library' = (() => { try { return localStorage.getItem('motion.rightTab') === 'library' ? 'library' : 'design'; } catch { return 'design'; } })();
  private listeners = new Map<string, Set<() => void>>();

  attachCanvas(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(this.store, canvas);
    this.start();
    import('../audio/engine').then(m => { this.audio = new m.AudioEngine(this); });
  }
  audio: import('../audio/engine').AudioEngine | null = null;

  setTool(t: Tool) {
    this.tool = t;
    this.emit('tool');
  }

  on(ch: string, fn: () => void) {
    let s = this.listeners.get(ch);
    if (!s) this.listeners.set(ch, (s = new Set()));
    s.add(fn);
    return () => { s!.delete(fn); };
  }
  emit(ch: string) { this.listeners.get(ch)?.forEach(f => f()); }

  /** register a per-frame callback (overlay, timeline). returns unsubscribe */
  onFrame(fn: FrameHook) { this.hooks.add(fn); return () => { this.hooks.delete(fn); }; }

  play() {
    const wa = this.validWorkArea();
    if (wa && (this.store.time < wa[0] || this.store.time >= wa[1] - 1e-6)) this.store.setTime(wa[0]);
    else if (this.store.time >= this.store.comp.duration - 1e-6) this.store.setTime(0);
    this.lastNow = performance.now();
    this.clock = this.store.time;
    this.store.setPlaying(true);
  }
  pause() { this.store.setPlaying(false); }
  togglePlay() { this.store.playing ? this.pause() : this.play(); }

  /** work area clamped to the comp; null when empty/out of range (e.g. after shortening the comp) */
  validWorkArea(): [number, number] | null {
    const wa = this.store.workArea, d = this.store.comp.duration;
    if (!wa) return null;
    const a = Math.max(0, wa[0]), b = Math.min(wa[1], d);
    return b - a > 1e-3 ? [a, b] : null;
  }

  stepFrames(n: number) {
    const fps = this.store.comp.fps;
    const f = Math.round(this.store.time * fps) + n;
    this.store.setTime(f / fps);
  }

  load(p: Project) {
    this.store.load(p);
    this.emit('loaded');
  }

  private start() {
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { cancelAnimationFrame(this.raf); this.audio?.halt(); }
  /** restart the loop after stop() (e.g. after a video export) */
  resume() { this.stop(); this.lastNow = performance.now(); this.start(); }

  private tick(now: number) {
    const store = this.store;
    const dt = now - this.lastNow;
    this.lastNow = now;
    this.frameTimes[this.frameIdx++ % this.frameTimes.length] = dt;
    if (store.playing) {
      const comp = store.comp;
      // unsnapped playback clock (snapping it would freeze playback when dt < one frame)
      if (Math.abs(this.clock - store.time) > 1 / comp.fps) this.clock = store.time; // user moved the playhead
      let t = this.clock + Math.min(dt, 100) / 1000;
      const wa = this.validWorkArea();
      const a = wa ? wa[0] : 0, b = wa ? wa[1] : comp.duration;
      if (t >= b) {
        if (store.loop) t = a + ((t - a) % Math.max(1e-3, b - a));
        else { t = b; store.setPlaying(false); }
      }
      this.clock = t;
      if (this.snapPlaybackToFrames) t = Math.floor(t * comp.fps + 1e-6) / comp.fps;
      store.time = t; // direct write: avoid per-frame ui fan-out, hooks read store.time
      store.emit('tick');
    }
    const r = this.renderer;
    // isolate failures: one broken frame or hook must never stop the loop or the other hooks
    try { if (r.dirty || r.redraw || r.lastTime !== store.time) r.render(store.time); } catch (e) { this.report('render', e); r.dirty = false; }
    for (const h of this.hooks) { try { h(now, store.time, store.playing); } catch (e) { this.report('frame hook', e); } }
  }

  private lastReport = 0;
  private report(where: string, e: unknown) {
    const now = performance.now();
    if (now - this.lastReport > 2000) { console.error(`[${where}]`, e); this.lastReport = now; }
  }

  /** frames per second measured over the ring buffer */
  measuredFps() {
    let sum = 0, n = 0;
    for (const v of this.frameTimes) if (v > 0) { sum += v; n++; }
    return n ? 1000 / (sum / n) : 0;
  }
}

export const editor = new Editor();
(globalThis as any).editor = editor; // handy for debugging + perf tests
(globalThis as any).__cmds = commands; // perf scripts (scripts/edit-profile.mjs) drive commands directly
