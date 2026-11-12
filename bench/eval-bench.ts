// micro benchmark of the evaluation hot path, outside the browser (no gpu contention)
import { stressProject } from '../src/app/demo';
import { Track } from '../src/core/evaluate';
import { PROP_DEFS, type PropKey } from '../src/core/model';

const N = 10000;
const p = stressProject({ count: N });
const keys: PropKey[] = ['anchor', 'position', 'scale', 'rotation', 'opacity', 'size', 'radius', 'fill', 'stroke', 'strokeWidth'];
const tracks: Track[] = [];
for (const l of Object.values(p.layers)) for (const k of keys) { const pr = l.props[k]; if (pr?.kf) tracks.push(new Track(pr, PROP_DEFS[k].dim, k === 'position')); }
const out = new Float64Array(8);
let t = 0;
for (let w = 0; w < 50; w++) for (const tr of tracks) tr.eval((w / 50) * 6, out, 0);
const frames = 300;
const t0 = performance.now();
for (let f = 0; f < frames; f++) { t = (f / 60) % 6; for (let i = 0; i < tracks.length; i++) tracks[i].eval(t, out, 0); }
const ms = (performance.now() - t0) / frames;
console.log(`${tracks.length} animated tracks: ${ms.toFixed(2)} ms/frame, ${(ms * 1e6 / tracks.length).toFixed(0)} ns/track`);
// same work but only 500 distinct tracks (fits in cache) -> tells us if we are memory bound
const small = tracks.slice(0, 500);
const t1 = performance.now();
for (let f = 0; f < frames; f++) { t = (f / 60) % 6; for (let r = 0; r < 100; r++) for (let i = 0; i < small.length; i++) small[i].eval(t, out, 0); }
const ms2 = (performance.now() - t1) / frames;
console.log(`cache-resident: ${(ms2 * 1e6 / (small.length * 100)).toFixed(0)} ns/track`);
import { TrackPool } from '../src/core/trackpool';
const pool = new TrackPool();
const handles: number[] = [];
for (const l of Object.values(p.layers)) for (const k of keys) { const pr = l.props[k]; if (pr?.kf) handles.push(pool.add(pr, PROP_DEFS[k].dim, k === 'position')); }
// correctness vs Track
const o2 = new Float64Array(8);
let maxErr = 0;
for (let s = 0; s < 200; s++) { const tt = Math.random() * 6.5 - 0.2; for (let i = 0; i < tracks.length; i += 37) { tracks[i].eval(tt, out, 0); pool.eval(handles[i], tt, o2, 0); for (let d = 0; d < tracks[i].dim; d++) maxErr = Math.max(maxErr, Math.abs(out[d] - o2[d])); } }
const hs = Int32Array.from(handles);
const t2 = performance.now();
for (let f = 0; f < frames; f++) { t = (f / 60) % 6; for (let i = 0; i < hs.length; i++) pool.eval(hs[i], t, out, 0); }
const ms3 = (performance.now() - t2) / frames;
console.log(`pool: ${ms3.toFixed(2)} ms/frame, ${(ms3 * 1e6 / hs.length).toFixed(0)} ns/track, max err vs Track ${maxErr.toExponential(1)}`);
