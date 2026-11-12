// gif frame timing / size rules (pure: unit tested, shared by the exporter and the export dialog)

/** number of frames (same rule as the video export: frames that start inside [t0, t1)) */
export function gifFrameCount(duration: number, fps: number) { return Math.max(1, Math.ceil(duration * fps - 1e-6)); }

/** delay of frame i in centiseconds: start times rounded to cs, so the sum never drifts */
export function gifDelayCs(i: number, fps: number) { return Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps); }

/** GIF size for a comp: the long side at most maxSize */
export function gifSize(w: number, h: number, maxSize = 640) {
  const scale = Math.min(1, maxSize / Math.max(w, h));
  return { width: Math.max(2, Math.round(w * scale)), height: Math.max(2, Math.round(h * scale)) };
}

