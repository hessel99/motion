// parametric star / polygon outlines (figma-style tools). geometry lives in a w x h box.
import type { PathCmd, PathGeometry } from './model';

/** points around the box's inscribed ellipse, first point at the top */
export function starGeometry(kind: 'star' | 'polygon', points: number, inner: number, w: number, h: number): PathGeometry[] {
  const n = Math.max(3, Math.min(100, Math.round(points)));
  const rx = w / 2, ry = h / 2;
  const cmds: PathCmd[] = [];
  const count = kind === 'star' ? n * 2 : n;
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const r = kind === 'star' && i % 2 ? Math.max(0.01, Math.min(1, inner)) : 1;
    const x = rx + Math.cos(a) * rx * r, y = ry + Math.sin(a) * ry * r;
    cmds.push(i === 0 ? ['M', x, y] : ['L', x, y]);
  }
  cmds.push(['Z']);
  return [{ cmds, fillRule: 'nonzero' }];
}
