// the editor runtime: owns the store, the renderer and the single requestAnimationFrame loop.
// everything that draws per frame (webgl canvas, overlay, timeline) is driven from here so
// playback never goes through the ui framework.

import { Store } from '../core/store';
import { Renderer } from '../render/renderer';
import type { Project } from '../core/model';

export type Tool = 'select' | 'rect' | 'ellipse' | 'text' | 'pen' | 'hand';

export interface FrameHook { (now: number, t: number, playing: boolean): void }

export class Editor {
  store = new Store();
  renderer!: Renderer;
  tool: Tool = 'select';
  private hooks = new Set<FrameHook>();
  private raf = 0;
  private lastNow = 0;
  /** play at comp fps instead of display refresh (off = smoothest) */
  snapPlaybackToFrames = false;
  /** frame timing ring buffer (ms between frames) for the perf hud */
  frameTimes = new Float32Array(120);
  frameIdx = 0;
  showHud = false;
  private listeners = new Map<string, Set<() => void>>();

  attachCanvas(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(this.store, canvas);
    this.start();
  }

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
    if (this.store.time >= this.store.comp.duration - 1e-6) this.store.setTime(0);
    this.lastNow = performance.now();
    this.store.setPlaying(true);
  }
  pause() { this.store.setPlaying(false); }
  togglePlay() { this.store.playing ? this.pause() : this.play(); }

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

  stop() { cancelAnimationFrame(this.raf); }
  /** restart the loop after stop() (e.g. after a video export) */
  resume() { this.stop(); this.lastNow = performance.now(); this.start(); }

  private tick(now: number) {
    const store = this.store;
    const dt = now - this.lastNow;
    this.lastNow = now;
    this.frameTimes[this.frameIdx++ % this.frameTimes.length] = dt;
    if (store.playing) {
      const comp = store.comp;
      let t = store.time + Math.min(dt, 100) / 1000;
      if (t >= comp.duration) {
        if (store.loop) t = t % comp.duration;
        else { t = comp.duration; store.setPlaying(false); }
      }
      if (this.snapPlaybackToFrames) t = Math.floor(t * comp.fps) / comp.fps;
      store.time = t; // direct write: avoid per-frame ui fan-out, hooks read store.time
      store.emit('tick');
    }
    const r = this.renderer;
    if (r.dirty || r.lastTime !== store.time) r.render(store.time);
    for (const h of this.hooks) h(now, store.time, store.playing);
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
