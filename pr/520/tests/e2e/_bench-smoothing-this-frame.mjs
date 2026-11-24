/**
 * _bench-smoothing-this-frame.mjs — times Temporal Smoothing "This frame" vs
 * "All frames" on a synthetic long session (Node, no browser).
 *
 * Run: node tests/e2e/_bench-smoothing-this-frame.mjs [frames] [animals] [nodes]
 */
import { smoothSession, smoothSessionAsync, collectTrajectories } from '../../pose/temporal-smoothing.js';
import * as TS from '../../pose/temporal-smoothing.js';
import { InstanceGroup, makePoints3d, setPoint3d, pooledPoints3d } from '../../pose/pose-data.js';

const T = +(process.argv[2] || 100000), A = +(process.argv[3] || 3), N = +(process.argv[4] || 15);
const params = { smoothMedianWindow: 5, smoothGaussianWindow: 9, smoothMaxGap: 5, smoothMinSegment: 5 };

function build() {
    const instanceGroups = new Map();
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let f = 0; f < T; f++) {
        const gs = [];
        for (let a = 0; a < A; a++) {
            if (rnd() < 0.01) continue;
            const g = new InstanceGroup(1, a);
            const pts = makePoints3d(N);
            for (let k = 0; k < N; k++) setPoint3d(pts, k, rnd() < 0.02 ? [NaN, NaN, NaN] : [f + rnd(), a * 100 + k + rnd(), rnd()]);
            g.points3d = pooledPoints3d(pts);
            gs.push(g);
        }
        instanceGroups.set(f, gs);
    }
    return { instanceGroups };
}

function time(label, fn, reps = 5) {
    fn();
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) fn();
    const ms = (performance.now() - t0) / reps;
    console.log(label.padEnd(44), ms.toFixed(2), 'ms');
    return ms;
}

const s = build();
const c = Math.floor(T / 2);
console.log(`${T.toLocaleString('en-US')} frames x ${A} animals x ${N} nodes`, JSON.stringify(params));
time('collectTrajectories', () => collectTrajectories(s));
time('This frame (writeFrames path)', () => smoothSession(s, params, { writeFrames: new Set([c]) }));
if (TS.smoothFrame) time('This frame (smoothFrame)', () => TS.smoothFrame(s, params, c), 50);
time('All frames', () => smoothSession(s, params), 2);
