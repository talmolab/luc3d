/**
 * _diag-replay-identity-cues.mjs — investigation tool, not a test. Replays the identity engine
 * (pose/identity-cues.js, with the tail-band cue) on tail reads saved by
 * `tests/e2e/_diag-cue-dump.mjs`, under a sampling rule, in Node, in seconds. A frame the dump
 * did not read is served by the nearest one it did. Compares each run's labels with the
 * reference (one sample per second throughout), over every per-second frame.
 *   node tests/e2e/_diag-replay-identity-cues.mjs <dump dir> '<marks JSON>' '[{"name":..,"plan":"keys"|"perSecond","opts":{..}}, ...]'
 *   marks: identity name -> band count, e.g. {"id_0":0,"id_1":1}
 *   env EXTRA=<_real-tail-marks.mjs result JSON with windowObs>: also serve those exact frames
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ic = await import(pathToFileURL(path.join(root, 'pose', 'identity-cues.js')).href);
const tm = await import(pathToFileURL(path.join(root, 'pose', 'tail-mark.js')).href);
const [dir, marksArg, variantsArg] = process.argv.slice(2);
const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json')));
const raw = new Float32Array(fs.readFileSync(path.join(dir, 'features.f32')).buffer.slice(0));
const L = idx.L, marks = JSON.parse(marksArg), variants = JSON.parse(variantsArg);

// features per dumped sample: Map id -> [{wide, sharp}]
let off = 0;
const byFrame = new Map(), dumped = idx.samples.slice();
idx.samples.forEach((f, t) => {
    const m = new Map();
    idx.ids.forEach((id, i) => {
        const list = [];
        for (let v = 0; v < idx.counts[t][i]; v++) {
            const wide = raw.subarray(off, off + L), sharpRaw = raw.subarray(off + L, off + 2 * L);
            list.push({ wide, sharp: Number.isNaN(sharpRaw[0]) ? null : sharpRaw });
            off += 2 * L;
        }
        if (list.length) m.set(id, list);
    });
    byFrame.set(f, m);
});
if (process.env.EXTRA) {
    const ex = JSON.parse(fs.readFileSync(process.env.EXTRA)).windowObs || [];
    ex.forEach((row) => {
        if (byFrame.has(row.frame)) return;
        const m = new Map();
        idx.names.forEach((n, i) => {
            const l = row.ids[n];
            if (l && l.length) m.set(idx.ids[i], l.map((x) => ({ wide: Float32Array.from(x.wide), sharp: x.sharp ? Float32Array.from(x.sharp) : null })));
        });
        byFrame.set(row.frame, m);
        dumped.push(row.frame);
    });
    dumped.sort((a, b) => a - b);
}
const nearest = (f) => {
    let lo = 0, hi = dumped.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (dumped[m] < f) lo = m + 1; else hi = m; }
    const a = dumped[Math.max(0, lo - 1)], b = dumped[lo];
    return Math.abs(a - f) <= Math.abs(b - f) ? a : b;
};
const [f0, f1] = idx.frames;
const frames = []; for (let f = f0; f <= f1; f++) frames.push(f);

async function run(v) {
    const session = {
        identities: idx.names.map((n, i) => ({ id: idx.ids[i], name: n })),
        instanceGroups: new Map(frames.map((f) => [f, null])),
        swapIdentitiesInRange() {},
    };
    let served = 0;
    const reader = {
        plan: async () => (v.plan === 'keys' ? idx.keyframes.slice() : v.plan === 'union' ? idx.samples.slice()
            : v.plan === 'shifted' ? idx.perSecond.map((f) => f + (v.shift || 10)).filter((f) => f <= f1) : idx.perSecond.slice()),
        open: async () => {}, close() {},
        next: async (f) => { served++; return { scores: byFrame.get(nearest(f)) }; },
        at: async (f) => { served++; return { scores: byFrame.get(nearest(f)) }; },
    };
    const expected = {}; Object.keys(marks).forEach((n) => { expected[n] = { tailBands: marks[n] }; });
    const t0 = Date.now();
    const r = await ic.resolveIdentityCues(session, Object.assign({ fps: idx.fps, expected, contactRuns: idx.contactRuns,
        cues: [{ cue: tm.createTailBandCue(), reader }] }, v.opts || {}));
    return { r, ms: Date.now() - t0, served };
}
const permAt = (runs, f) => { let p = null; for (const x of runs) { if (x.frame <= f) p = x.perm; else break; } return p ? p.join('') : '?'; };
const ref = await run({ plan: 'perSecond', opts: { denseSeconds: 0 } });
if (!ref.r.ok) { console.log('reference failed: ' + ref.r.reason); process.exit(1); }
console.log(`reference (1/s): ${ref.r.samples} samples, changes at ${ref.r.runs.map((x) => x.frame).join(' ')}`);
for (const v of variants) {
    const { r, ms, served } = await run(v);
    if (!r.ok) { console.log(`${v.name}: FAILED ${r.reason}`); continue; }
    let diff = 0; const where = [];
    for (const f of idx.perSecond) if (permAt(r.runs, f) !== permAt(ref.r.runs, f)) { diff++; where.push(f); }
    console.log(`${v.name}: ${r.samples} samples (${r.dense || 0} dense), ${served} reads, ${ms} ms; changes at ${r.runs.map((x) => x.frame).join(' ')}; ` +
        `${diff} of ${idx.perSecond.length} per-second frames labelled differently${diff ? ' (' + where.slice(0, 12).join(' ') + (where.length > 12 ? ' …' : '') + ')' : ''}`);
}
