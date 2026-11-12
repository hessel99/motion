// taste-layer defaults for apply_preset (kept out of tools.ts so the shared file only gains one line)
import { st } from './tool-kit';
import { layerSize } from './motion-math';
import { feel, moveDuration, tasteOn } from './taste';

/** preset duration from the element size and a list stagger, when the model left them out */
export function tasteDefaults(ids: string[], duration?: number, stagger?: number): { duration?: number; stagger?: number } {
  if (!tasteOn()) return { duration, stagger };
  const s = st();
  if (duration === undefined) {
    const sizes = (ids ?? []).map(id => s.layer(id)).filter(Boolean).map(l => Math.max(...layerSize(s, l!, s.time)));
    if (sizes.length) duration = moveDuration(s, { size: sizes.reduce((a, b) => a + b, 0) / sizes.length });
  }
  if (stagger === undefined && (ids?.length ?? 0) >= 2) stagger = Math.min(feel().step, 0.6 / (ids.length - 1));
  return { duration, stagger };
}
