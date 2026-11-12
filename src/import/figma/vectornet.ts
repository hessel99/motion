// figma "vector network" blob (vectorData.vectorNetworkBlob) -> path commands.
// newer clipboards may omit the cached fillGeometry for vectors and only carry the network.
// layout (little endian): u32 vertexCount, u32 segmentCount, u32 regionCount,
//   vertices: (u32 style, f32 x, f32 y)*, segments: (u32 style, u32 start, f32 tsx, f32 tsy, u32 end, f32 tex, f32 tey)*,
//   regions: (u32 flags, u32 loopCount, loops: (u32 count, u32 segmentIndex*)*)*
// coordinates are in vectorData.normalizedSize space. independent implementation of the layout
// documented by darknoon/figma-format-parse (fig-renderer/src/geometry.ts).

import type { PathCmd, PathGeometry } from '../../core/model';

interface Seg { start: number; end: number; tx: number; ty: number; ex: number; ey: number }

export function decodeVectorNetwork(bytes: Uint8Array, sx = 1, sy = 1): { fills: PathGeometry[]; stroke: PathGeometry | null } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u32 = () => { if (o + 4 > bytes.length) throw 0; const v = view.getUint32(o, true); o += 4; return v; };
  const f32 = () => { if (o + 4 > bytes.length) throw 0; const v = view.getFloat32(o, true); o += 4; if (!Number.isFinite(v)) throw 0; return v; };
  try {
    const nv = u32(), ns = u32(), nr = u32();
    if (12 + nv * 12 + ns * 28 > bytes.length) return null;
    const vx = new Float64Array(nv), vy = new Float64Array(nv);
    for (let i = 0; i < nv; i++) { u32(); vx[i] = f32() * sx; vy[i] = f32() * sy; }
    const segs: Seg[] = [];
    for (let i = 0; i < ns; i++) {
      u32();
      const start = u32(), tx = f32() * sx, ty = f32() * sy, end = u32(), ex = f32() * sx, ey = f32() * sy;
      if (start >= nv || end >= nv) return null;
      segs.push({ start, end, tx, ty, ex, ey });
    }
    // walk a set of segments into connected contours
    const contour = (indices: number[]): PathCmd[] => {
      const remaining = new Set(indices);
      const adj = new Map<number, number[]>();
      for (const i of indices) for (const v of [segs[i].start, segs[i].end]) { const a = adj.get(v); a ? a.push(i) : adj.set(v, [i]); }
      const cmds: PathCmd[] = [];
      while (remaining.size) {
        let idx = remaining.values().next().value as number;
        let start = segs[idx].start;
        // open chains start at an endpoint (vertex with a single remaining edge)
        for (const [v, edges] of adj) {
          const live = edges.filter(e => remaining.has(e));
          if (live.length === 1) { start = v; idx = live[0]; break; }
        }
        let cur = start;
        cmds.push(['M', vx[start], vy[start]]);
        while (remaining.has(idx)) {
          remaining.delete(idx);
          const s = segs[idx], fwd = cur === s.start;
          const next = fwd ? s.end : s.start;
          const t1x = fwd ? s.tx : s.ex, t1y = fwd ? s.ty : s.ey, t2x = fwd ? s.ex : s.tx, t2y = fwd ? s.ey : s.ty;
          if (t1x || t1y || t2x || t2y) cmds.push(['C', vx[cur] + t1x, vy[cur] + t1y, vx[next] + t2x, vy[next] + t2y, vx[next], vy[next]]);
          else cmds.push(['L', vx[next], vy[next]]);
          cur = next;
          if (cur === start) { cmds.push(['Z']); break; }
          const e = adj.get(cur)?.find(x => remaining.has(x));
          if (e === undefined) break;
          idx = e;
        }
      }
      return cmds;
    };
    const fills: PathGeometry[] = [];
    for (let r = 0; r < nr; r++) {
      const flags = u32();
      const loops = u32();
      if (loops > bytes.length / 4) return null;
      const cmds: PathCmd[] = [];
      for (let l = 0; l < loops; l++) {
        const count = u32();
        if (count > (bytes.length - o) / 4) return null;
        const idx: number[] = [];
        for (let k = 0; k < count; k++) { const s = u32(); if (s >= ns) return null; idx.push(s); }
        cmds.push(...contour(idx));
      }
      // low bit of the region flags is the winding rule (0 = nonzero, 1 = evenodd) per our reading of the format
      if (cmds.length) fills.push({ cmds, fillRule: flags & 1 ? 'evenodd' : 'nonzero' });
    }
    const all = contour(segs.map((_, i) => i));
    return { fills, stroke: all.length ? { cmds: all, fillRule: 'nonzero' } : null };
  } catch {
    return null;
  }
}
