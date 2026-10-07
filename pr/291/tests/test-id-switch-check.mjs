/**
 * test-id-switch-check.mjs — Tracks ▸ Check ID Switches, body size AND images
 * (pose/id-switch-check.js) on synthetic tracked sessions.
 *
 * Three animals of clearly different size (x1.00, x1.15, x0.85 of a mouse-sized
 * template, 1.5 mm keypoint noise) live apart and meet at scheduled close
 * encounters; the scenario is defined in time, so it can be recorded at any
 * frame rate — the check's scores must not depend on it. Clean labels must produce no flags; labels that swap after one
 * specific encounter must flag exactly that encounter as the onset, and mark the
 * pair's later encounters as repeats (`continues`) — the signature of a switch
 * that persists. Plus the failure reasons and the softmax classifier itself.
 *
 *
 * The image check is tested with SYNTHETIC embeddings (a fixed random
 * "appearance" vector per animal + noise, from 4 cameras) — no model, no GPU —
 * on animals of IDENTICAL size: the size check's blind spot, which the image check
 * exists for. Crop geometry helpers (ui/image-embedder.js) are checked too.
 *
 * Run:  node tests/test-id-switch-check.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PD = await import(pathToFileURL(path.join(ROOT, 'pose', 'pose-data.js')).href);
const SC = await import(pathToFileURL(path.join(ROOT, 'pose', 'id-switch-check.js')).href);

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function eq(a, e, m) { ok(a === e, `${m} (expected ${e}, got ${a})`); }
function group(n) { console.log('\n• ' + n); }

const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
    'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
// A mouse-sized template in mm, nose along +x, body centred near the origin.
const TEMPLATE = {
    Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
    Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
    Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0],
    Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0], Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0],
};
const SCALES = [1.0, 1.15, 0.85];

// Deterministic PRNG + Gaussian.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

function pose(scale, cx, cy, heading, r) {
    const out = new Float64Array(NODES.length * 3);
    const c = Math.cos(heading), s = Math.sin(heading);
    NODES.forEach((n, i) => {
        const [x, y, z] = TEMPLATE[n];
        out[i * 3] = cx + scale * (c * x - s * y) + 1.5 * gauss(r);
        out[i * 3 + 1] = cy + scale * (s * x + c * y) + 1.5 * gauss(r);
        out[i * 3 + 2] = scale * z + 1.5 * gauss(r);
    });
    return out;
}

/**
 * Build a tracked session recorded at `fps`. The motion is defined in TIME (a
 * clock `u` in 1/15-s units, so the same scenario can be recorded at any frame
 * rate): animals idle at home spots 400 mm apart; at each scheduled encounter two
 * of them walk to a meeting point, stay within ~20 mm for a while, and walk back.
 * `swapAfter` = index of the encounter after which the two animals' identity
 * labels are exchanged for the rest of the session (null = clean).
 * `opts.swapAtU` + `opts.swapPair` instead exchange two animals' labels at an
 * arbitrary time — e.g. while they are far apart, away from every encounter.
 */
function buildSession(swapAfter, fps = 60, scales = SCALES, opts = {}) {
    const r = rng(7);
    const home = [[0, 0], [400, 0], [200, 350]];
    const PAIRS = [[0, 1], [1, 2], [0, 2]];
    const events = [];
    for (let e = 0; e < 24; e++) events.push({ pair: PAIRS[e % 3], t0: 300 + e * 260 });   // in u (1/15 s)
    const U = 300 + 24 * 260 + 300, nFrames = Math.floor(U / 15 * fps);
    const session = new PD.Session([], new PD.Skeleton('m', NODES, []), [], 'synthetic');
    for (let i = 0; i < 3; i++) session.addIdentity('id_' + i);
    const encounterEnds = events.map(ev => ({ frame: Math.round((ev.t0 + 60) / 15 * fps), pair: ev.pair }));
    const swapU = opts.swapAtU != null ? opts.swapAtU : swapAfter != null ? events[swapAfter].t0 + 60 : Infinity;
    const swapPair = opts.swapPair || (swapAfter != null ? events[swapAfter].pair : null);
    let gid = 1;
    for (let f = 0; f < nFrames; f++) {
        const u = f * 15 / fps;
        const pos = home.map(h => [h[0] + 15 * Math.sin(u / 37 + h[0]), h[1] + 15 * Math.cos(u / 41 + h[1])]);
        for (const ev of events) {
            const d = u - ev.t0;                 // 0..40 walk in, 40..60 together, 60..100 walk out
            if (d < 0 || d > 100) continue;
            const [a, b] = ev.pair;
            const mid = [(home[a][0] + home[b][0]) / 2, (home[a][1] + home[b][1]) / 2];
            const w = d < 40 ? d / 40 : d <= 60 ? 1 : 1 - (d - 60) / 40;
            for (const [k, side] of [[a, -1], [b, 1]]) {
                const target = [mid[0] + side * 10, mid[1]];
                pos[k] = [home[k][0] + w * (target[0] - home[k][0]), home[k][1] + w * (target[1] - home[k][1])];
            }
        }
        const label = [0, 1, 2];
        if (u >= swapU) { const [a, b] = swapPair; [label[a], label[b]] = [label[b], label[a]]; }
        session.instanceGroups.set(f, [0, 1, 2].map(k => {
            const g = new PD.InstanceGroup(gid++, session.identities[label[k]].id);
            g.points3d = pose(scales[k], pos[k][0], pos[k][1], (u / 50 + k) % (2 * Math.PI), r);
            g._animal = k;                       // ground truth, for the synthetic image embedder
            return g;
        }));
    }
    return { session, events, encounterEnds };
}

// ===========================================================================
group('fitSoftmax — separable 2-class data is classified correctly');
{
    const n = 400, D = 2, X = new Float64Array(n * D), y = new Int32Array(n), r = rng(3);
    for (let i = 0; i < n; i++) { y[i] = i % 2; X[i * 2] = (y[i] ? 3 : -3) + gauss(r); X[i * 2 + 1] = gauss(r); }
    const m = SC.fitSoftmax(X, y, n, D, 2, { iterations: 200 });
    let correct = 0;
    for (let i = 0; i < n; i++) { const lp = m.logProba(X.subarray(i * 2, i * 2 + 2)); if ((lp[1] > lp[0] ? 1 : 0) === y[i]) correct++; }
    ok(correct / n > 0.97, `accuracy ${correct / n} > 0.97`);
    const lp = m.logProba(new Float64Array([0, 0]));
    ok(Math.abs(Math.exp(lp[0]) + Math.exp(lp[1]) - 1) < 1e-9, 'log-probabilities normalise');
}

group('Clean labels — no possible switches flagged');
{
    const { session } = buildSession(null);
    const res = await SC.checkSizeSwitches(session, { fps: 60 });
    ok(res.ok, 'check ran (' + (res.reason || 'ok') + ')');
    ok(res.encounters.length >= 20, `found the scheduled encounters (${res.encounters.length} of 24)`);
    eq(res.flags.length, 0, 'no encounter flagged');
    ok(res.encounters.every(e => e.score > 0), 'every encounter favours the tracker\'s own labels');
}

async function switchCase(SWAP, expectKind) {
    const { session, events, encounterEnds } = buildSession(SWAP);
    const res = await SC.checkSizeSwitches(session, { fps: 60 });
    ok(res.ok, 'check ran');
    const swapEnd = encounterEnds[SWAP];
    const [a, b] = events[SWAP].pair;
    const pairKey = ['id_' + a, 'id_' + b].sort().join();
    const isPair = (e) => [e.nameA, e.nameB].sort().join() === pairKey;
    const primary = res.flags.filter(f => !f.continues && isPair(f)).concat(res.changes.filter(isPair));
    eq(primary.length, 1, 'exactly one change point for the swapped pair');
    const p = primary[0] || {};
    eq(p.kind, expectKind, 'change point kind');
    ok(Math.abs(p.frame - swapEnd.frame) <= 40, `at the swap encounter (expected frame ~${swapEnd.frame}, got ${p.frame})`);
    ok(isPair(p), `names the swapped pair (id_${a} ↔ id_${b})`);
    const minoritySide = expectKind === 'onset'
        ? res.encounters.filter(e => isPair(e) && e.frame > swapEnd.frame + 40)
        : res.encounters.filter(e => isPair(e) && e.frame < swapEnd.frame - 40);
    ok(minoritySide.length >= 2 && minoritySide.every(e => e.flagged && e.continues),
        `the ${minoritySide.length} encounters on the minority side are flagged repeats`);
    // Other pairs may be flagged too, but only where one of the swapped identities carries the
    // label the session's majority disagrees with: on the minority side of the switch.
    const swapped = new Set(['id_' + a, 'id_' + b]);
    const onMinority = (e) => expectKind === 'onset' ? e.frame > swapEnd.frame + 40 : e.frame < swapEnd.frame - 40;
    const strays = res.flags.filter(e => !(swapped.has(e.nameA) || swapped.has(e.nameB)) || !onMinority(e) && !isPair(e));
    eq(strays.length, 0, 'every flag involves a swapped identity on the minority side');
}

group('A switch late in the session (swapped stretch is the minority) — onset at the switch');
await switchCase(16, 'onset');

group('A switch early in the session (swapped stretch is the MAJORITY) — change point still at the switch');
await switchCase(7, 'end');

group('Moments — a switch AWAY from every encounter is found at the moment it happened');
{
    // animals 0 and 1 exchange labels at home, 400 mm apart, between their encounters 18 and 21
    const FPS = 60, sig = r => JSON.stringify(r.encounters.map(e => [e.frame, e.nameA, e.nameB, e.score, !!e.flagged, e.kind || '']));
    const isPair01 = e => [e.nameA, e.nameB].sort().join() === 'id_0,id_1';
    const late = 300 + 18 * 260 + 160, lateFrame = Math.round(late / 15 * FPS);
    const { session, events } = buildSession(null, FPS, SCALES, { swapAtU: late, swapPair: [0, 1] });
    const ids = session.identities;
    const plain = await SC.checkSizeSwitches(session, { fps: FPS });
    const prevEnc = Math.round((events[18].t0 + 60) / 15 * FPS);
    const p0 = plain.flags.filter(f => !f.continues && isPair01(f)).concat(plain.changes.filter(isPair01));
    ok(p0.length === 1 && Math.abs(p0[0].frame - prevEnc) < FPS,
        `without moments it is put on the pair's PREVIOUS encounter, whose time apart runs across it (${p0.map(x => x.frame)} vs switch ${lateFrame})`);
    const moment = { frame: lateFrame, startFrame: lateFrame - 10, identityA: ids[0].id, identityB: ids[1].id, cues: ['tracklet'] };
    const decoys = [0.3, 0.55].map(q => ({ frame: Math.round(q * lateFrame), startFrame: Math.round(q * lateFrame), identityA: ids[0].id, identityB: ids[2].id, cues: ['ambiguity'] }));
    const withM = await SC.checkSizeSwitches(session, { fps: FPS, moments: [moment].concat(decoys) });
    eq(sig(withM), sig(plain), 'moments only ADD change points: every encounter scores and flags exactly as without them');
    const mrow = withM.flags.concat(withM.changes).filter(x => x.look);
    ok(mrow.length === 1 && Math.abs(mrow[0].frame - lateFrame) <= 4 && mrow[0].kind === 'onset' && mrow[0].side === 'after',
        `the switch is a change point AT the moment, an onset (the swapped stretch is after it): ${JSON.stringify(mrow.map(x => [x.frame, x.kind, Math.round(x.score)]))}`);
    eq(JSON.stringify(mrow[0] && mrow[0].look), '["tracklet"]', 'it carries the moment\'s cues');
    ok(mrow[0] && mrow[0].switchBackAt === null, '…and its swapped stretch runs to the end of the session (nothing switches it back)');
    eq(withM.moments.length, 3, 'all three moments were tested');
    ok(withM.moments.filter(m => !isPair01(m)).every(m => m.score > 0), 'the moments on a clean pair agree on both sides (positive)');

    // a switch EARLY, so the swapped labelling is the session's majority: the stretch BEFORE the moment is the odd one
    const early = 300 + 2 * 260 + 160, earlyFrame = Math.round(early / 15 * FPS);
    const E = buildSession(null, FPS, SCALES, { swapAtU: early, swapPair: [0, 1] }).session;
    const eM = await SC.checkSizeSwitches(E, { fps: FPS, moments: [{ frame: earlyFrame, startFrame: earlyFrame, identityA: E.identities[0].id, identityB: E.identities[1].id, cues: ['ambiguity'] }] });
    const er = eM.flags.concat(eM.changes).filter(x => x.look);
    ok(er.length === 1 && er[0].kind === 'end' && er[0].side === 'before' && er[0].switchedAt === null && eM.changes.includes(er[0]),
        `a majority swap: the moment is an 'end' (fix the stretch before it, from the session start): ${JSON.stringify(er.map(x => [x.frame, x.kind, x.switchedAt]))}`);

    // a moment at one of the pair's encounter change points yields to it (one row, the encounter's)
    const { session: S3, encounterEnds } = buildSession(19);
    const onsetF = encounterEnds[19].frame;
    const r3 = await SC.checkSizeSwitches(S3, { fps: 60, moments: [{ frame: onsetF + 30, startFrame: onsetF, identityA: S3.identities[1].id, identityB: S3.identities[2].id, cues: ['ambiguity'] }] });
    ok(r3.moments.length === 1 && r3.moments[0].score < -200, 'the moment at an encounter switch is tested and disagrees');
    eq(r3.flags.concat(r3.changes).filter(x => x.look).length, 0, '…but adds no row: the encounter\'s change point within 3 s stands');
}

group('Frame-rate independence — the same scenario recorded at 25, 30, 60 and 120 fps');
{
    const SWAP = 16, out = {};
    for (const fps of [25, 30, 60, 120]) {
        // clean runs at the extremes only (60 fps is covered above; keeps this file fast)
        const clean = (fps === 25 || fps === 120) ? await SC.checkSizeSwitches(buildSession(null, fps).session, { fps }) : null;
        const { session, events, encounterEnds } = buildSession(SWAP, fps);
        const res = await SC.checkSizeSwitches(session, { fps });
        const pairKey = events[SWAP].pair.map(k => 'id_' + k).sort().join();
        const onset = res.flags.find(f => !f.continues && [f.nameA, f.nameB].sort().join() === pairKey);
        out[fps] = { clean: clean ? clean.flags.length : null, onset, hz: res.sampleHz, step: res.step, swapFrame: encounterEnds[SWAP].frame };
    }
    for (const fps of [25, 30, 60, 120]) {
        const o = out[fps];
        ok(Math.abs(o.hz - 15) <= 2.5, `${fps} fps: sampled at ~15 Hz (${o.hz.toFixed(2)} Hz, every ${o.step} frame(s))`);
        if (o.clean != null) eq(o.clean, 0, `${fps} fps: clean session has no flags`);
        console.log(`    ${String(fps).padStart(3)} fps: every ${o.step} frame(s) = ${o.hz.toFixed(2)} Hz | onset frame ${o.onset && o.onset.frame} (switch ${o.swapFrame}) | score ${o.onset && o.onset.score.toFixed(0)}` + (o.clean != null ? ` | clean flags ${o.clean}` : ''));
        ok(o.onset && Math.abs(o.onset.frame - o.swapFrame) <= fps, `${fps} fps: onset within 1 s of the switch (frame ${o.onset && o.onset.frame}, switch ${o.swapFrame})`);
        const ratio = o.onset && out[60].onset ? o.onset.score / out[60].onset.score : NaN;
        ok(ratio > 0.7 && ratio < 1.3, `${fps} fps: onset score ${o.onset && o.onset.score.toFixed(0)} within 30% of the 60 fps score ${out[60].onset && out[60].onset.score.toFixed(0)} (ratio ${ratio.toFixed(2)})`);
    }
}

// ---------------------------------------------------------------------------
// The image check
// ---------------------------------------------------------------------------
const PROTO = [0, 1, 2].map(a => { const r = rng(100 + a); return Float32Array.from({ length: 64 }, () => gauss(r)); });
function syntheticEmbedder(noise = 1.2, cams = ['c0', 'c1', 'c2', 'c3']) {
    const r = rng(9);
    return async (frame, items) => items.map(it => cams.map(cam => ({
        camera: cam, vector: Float32Array.from(PROTO[it.group._animal], v => v + noise * gauss(r)),
    })));
}

group('Image check — catches a swap between animals of IDENTICAL size (the size check cannot)');
{
    const SWAP = 16;
    const { session, events, encounterEnds } = buildSession(SWAP, 60, [1, 1, 1]);
    const size = await SC.checkSizeSwitches(session, { fps: 60 });
    const stages = new Set();
    const img = await SC.checkImageSwitches(session, { fps: 60, getEmbeddings: syntheticEmbedder(),
        onProgress: async (stage) => { stages.add(stage); } });
    ok(size.ok && img.ok, 'both checks ran (' + (img.reason || 'ok') + ')');
    const pairKey = events[SWAP].pair.map(k => 'id_' + k).sort().join();
    const isPair = e => [e.nameA, e.nameB].sort().join() === pairKey;
    const sizeHit = size.flags.concat(size.changes).some(f => isPair(f) && Math.abs(f.frame - encounterEnds[SWAP].frame) <= 60);
    ok(!sizeHit, 'size check misses it (equal sizes — its blind spot)');
    const onset = img.flags.find(f => !f.continues && isPair(f));
    ok(onset && Math.abs(onset.frame - encounterEnds[SWAP].frame) <= 60,
        `image check: onset at the switch (frame ${onset && onset.frame}, switch ${encounterEnds[SWAP].frame}, score ${onset && onset.score.toFixed(0)})`);
    ok(img.flags.filter(f => !f.continues && f.followOf == null).length === 1, 'image check: one independent change point');
    ok(Math.abs(img.imageHz - 15 / 8) < 1e-9 && img.cameras.length === 4 && img.crops > 1000,
        `reports its sampling (${img.imageHz.toFixed(2)} Hz, ${img.crops} crops from ${img.cameras.length} cameras)`);
    ok(stages.has('embed') && stages.has('fit'), 'progress reports both stages');
    const clean = await SC.checkImageSwitches(buildSession(null, 60, [1, 1, 1]).session, { fps: 60, getEmbeddings: syntheticEmbedder() });
    eq(clean.flags.length, 0, 'image check: clean labels → no flags');
}

group('Image check — several frames in flight (so a provider can batch them)');
{
    const SWAP = 16, { session } = buildSession(SWAP, 60, [1, 1, 1]);
    // the synthetic embedder draws its noise in CALL order, so identical scores also mean calls started in frame order
    const tracked = (inner, delay) => {
        const st = { live: 0, max: 0, frames: [] };
        return { st, fn: async (frame, items) => { st.frames.push(frame); st.live++; st.max = Math.max(st.max, st.live);
            try { const r = await inner(frame, items); await new Promise(res => setTimeout(res, delay(frame))); return r; } finally { st.live--; } } };
    };
    const one = tracked(syntheticEmbedder(), () => 0), many = tracked(syntheticEmbedder(), f => (f * 7919) % 5);
    const a = await SC.checkImageSwitches(session, { fps: 60, getEmbeddings: one.fn, inFlight: 1 });
    const b = await SC.checkImageSwitches(session, { fps: 60, getEmbeddings: many.fn, inFlight: 8 });
    ok(one.st.max === 1 && many.st.max > 1 && many.st.max <= 8, `inFlight bounds the requests in flight (1 → ${one.st.max}, 8 → ${many.st.max})`);
    ok(many.st.frames.every((f, i, A) => i === 0 || f > A[i - 1]), 'requests are started in increasing frame order (a streaming reader relies on it)');
    ok(a.ok && b.ok && a.encounters.length === b.encounters.length && a.encounters.every((e, i) => e.score === b.encounters[i].score),
        'results are identical whether 1 or 8 requests are in flight (completing out of order)');
}

group('Image check — timing summary (ui/image-embedder.js)');
{
    globalThis.window = globalThis;
    const E = await import(pathToFileURL(path.join(ROOT, 'ui', 'image-embedder.js')).href);
    const t = E.summarizeEmbedTiming({ frames: 100, crops: 1500, batches: 30, t0: 1000, t1: 11000, decodeMs: 3000, cropMs: 5000, queueMs: 20000, runMs: 900, readMs: 8100, maxBatch: 64 }, 'webgpu', 'fp16');
    ok(Math.abs(t.cropsPerS - 150) < 1e-9 && Math.abs(t.gpuBusyPct - 90) < 1e-9 && t.avgBatch === 50 && t.decodeMsPerFrame === 30,
        `summary: 150 crops/s, GPU busy 90%, batches of 50, decode 30 ms/frame (${JSON.stringify(t).slice(0, 120)}…)`);
    eq(E.formatEmbedTiming(t), '150 crops/s over 10 s · GPU busy 90% (30 batches of ~50, 6.0 ms/crop) · per frame: decode 30 ms, crop 50 ms, queue 200 ms · WebGPU fp16', 'one-line format, with the backend and precision that ran');
    eq(E.formatEmbedTiming({ crops: 0 }), '', 'nothing embedded → no line');
    // how the samples were decoded: at keyframes, or every frame (and what keyframe spacing would fix it)
    const frames = []; for (let f = 0; f < 3200; f += 32) frames.push(f);
    const kf = (gop) => { const k = []; for (let f = 0; f < 3200; f += gop) k.push(f); return k; };
    const plan = (gop, streamed = true) => Object.assign(SC.planKeyframeSamples(frames, kf(gop)), { streamed });
    const dense = E.summarizeKeyframePlans([plan(30), plan(30), plan(30, false)]);
    ok(dense.cameras === 2 && dense.of === 2 && dense.snappedPct === 100, 'keyframes every 30: 2/2 streamed cameras at keyframes (' + JSON.stringify(dense) + ')');
    ok(E.formatEmbedTiming(Object.assign({}, t, { keyframes: dense })).endsWith(' · decoded at keyframes in 2/2 cameras (100% of samples)'), 'line says keyframe decoding');
    const sparse = E.summarizeKeyframePlans([plan(250), plan(250)]);
    ok(sparse.cameras === 0 && sparse.keyframeGap === 250, 'keyframes every 250: none at keyframes');
    ok(E.formatEmbedTiming(Object.assign({}, t, { keyframes: sparse })).endsWith(' · every frame decoded (keyframe every 250 frames; a keyframe every 0.5 s — 35 frames or fewer — would decode only the samples)'),
        'line says every frame was decoded, and what keyframe spacing would avoid it');
}

group('Image check — cancellation and failure reasons');
{
    const ctl = new AbortController();
    let calls = 0;
    const slow = async (f, items) => { if (++calls === 10) ctl.abort(); return items.map(() => []); };
    let threw = null;
    try { await SC.checkImageSwitches(buildSession(null).session, { fps: 60, getEmbeddings: slow, signal: ctl.signal }); }
    catch (e) { threw = e; }
    ok(threw && threw.name === 'AbortError' && calls === 10, 'abort signal stops it mid-embedding (AbortError after the 10th frame)');
    const r1 = await SC.checkImageSwitches(buildSession(null).session, { fps: 60 });
    ok(!r1.ok && /embedder/.test(r1.reason), 'no embedder → refused (' + r1.reason + ')');
    const r2 = await SC.checkImageSwitches(buildSession(null).session, { fps: 60, getEmbeddings: async (f, it) => it.map(() => []) });
    ok(!r2.ok && /No crops/.test(r2.reason), 'nothing embeddable → refused (' + r2.reason + ')');
}

group('fitPCA — recovers the dominant direction');
{
    const n = 500, D = 10, X = new Float64Array(n * D), r = rng(5), dir = [3, 1, 0, 0, 0, 0, 0, 0, 0, 2];
    for (let i = 0; i < n; i++) { const a = 4 * gauss(r); for (let d = 0; d < D; d++) X[i * D + d] = a * dir[d] + 0.3 * gauss(r); }
    const pca = SC.fitPCA(X, n, D, 2);
    const v = pca.project(Float64Array.from(dir)), u = pca.project(new Float64Array(D));
    const along = Math.abs(v[0] - u[0]), across = Math.abs(v[1] - u[1]);
    ok(along > 3 && across < 0.3 * along, `first component follows the planted direction (|pc1| ${along.toFixed(2)}, |pc2| ${across.toFixed(2)})`);
}

group('Crop geometry (ui/image-embedder.js)');
{
    globalThis.window = globalThis;           // image-embedder imports app-state, which is DOM-free at import
    const E = await import(pathToFileURL(path.join(ROOT, 'ui', 'image-embedder.js')).href).catch(e => ({ __err: e }));
    if (E.__err) ok(false, 'image-embedder imports headlessly: ' + E.__err.message);
    else {
        const hull = E.convexHull([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1], [1, 0.5]]);
        eq(hull.length, 4, 'convex hull of a square with interior points has 4 corners');
        const pts = NODES.map(n => { const [x, y] = TEMPLATE[n]; return [400 + x, 300 - y]; });   // nose to the right in image coords
        const sk = { nose: 0, tti: 3, body: NODES.map((n, i) => i).filter(i => !/^Tail/.test(NODES[i])) };
        const g = E.cropGeometry({ getPoint: i => pts[i] }, sk);
        ok(g && Math.abs(g.L - 85) < 1e-9 && Math.abs(g.angle) < 1e-9 && Math.abs(g.scale - 160 / (1.3 * 85)) < 1e-9,
            `geometry: body length 85, nose angle 0, scale 160/(1.3 L) (${g && g.L}, ${g && g.angle}, ${g && g.scale.toFixed(4)})`);
        ok(E.cropGeometry({ getPoint: i => i === 0 ? null : pts[i] }, sk) === null, 'no nose → no crop');
        const crop = new Uint8Array(160 * 160).fill(255), data = new Float32Array(3 * 224 * 224);
        E.writeInputTensor(crop, data, 0);
        ok(Math.abs(data[0] - (1 - 0.485) / 0.229) < 1e-5 && Math.abs(data[2 * 224 * 224] - (1 - 0.406) / 0.225) < 1e-5,
            'input tensor: 224x224, ImageNet-normalised per channel');
        {   // the precomputed resize table must reproduce the per-pixel formula exactly
            let st = 7; const rc = new Uint8Array(160 * 160).map(() => (st = (st * 1103515245 + 12345) >>> 0) >>> 24);
            const got = new Float32Array(3 * 224 * 224); E.writeInputTensor(rc, got, 0);
            const M = [0.485, 0.456, 0.406], SD = [0.229, 0.224, 0.225], ref = new Float32Array(got.length);
            for (let y = 0; y < 224; y++) {
                const sy = Math.min(Math.max((y + 0.5) * 160 / 224 - 0.5, 0), 159), y0 = Math.floor(sy), y1 = Math.min(y0 + 1, 159), fy = sy - y0;
                for (let x = 0; x < 224; x++) {
                    const sx = Math.min(Math.max((x + 0.5) * 160 / 224 - 0.5, 0), 159), x0 = Math.floor(sx), x1 = Math.min(x0 + 1, 159), fx = sx - x0;
                    const v = ((rc[y0 * 160 + x0] * (1 - fx) + rc[y0 * 160 + x1] * fx) * (1 - fy) + (rc[y1 * 160 + x0] * (1 - fx) + rc[y1 * 160 + x1] * fx) * fy) / 255;
                    for (let c = 0; c < 3; c++) ref[c * 224 * 224 + y * 224 + x] = (v - M[c]) / SD[c];
                }
            }
            ok(got.every((v, i) => Object.is(v, ref[i])), 'input tensor: table-driven resize is bit-identical to the per-pixel formula');
        }
        const geos = [{ L: 40 }, null, { L: 90 }, { L: 60 }, { L: 90 }];
        const sv = (k) => Array.from(E.selectViews(geos, k)).sort((a, b) => a - b).join(',');
        eq(sv(0), '0,2,3,4', 'views per animal 0 → every croppable view');
        eq(sv(2), '2,4', 'views per animal 2 → the two largest (ties kept by view order)');
        eq(sv(3), '2,3,4', 'views per animal 3 → skips the uncroppable view and the smallest');
        eq(sv(9), '0,2,3,4', 'more than available → all croppable views');
        const agree = Array.from({ length: 50 }, (_, i) => 0.999 + i * 1e-5);
        const cb = (nnMs, cos) => E.chooseBackend({ gpuMs: 1000, nnMs, crops: 160, cos });
        eq(cb(400, agree).backend, 'webnn', 'WebNN 2.5x faster and consistent → WebNN');
        eq(cb(10000, agree).backend, 'webgpu', 'WebNN 10x slower (macOS) → WebGPU');
        ok(/not faster/.test(cb(950, agree).note), 'WebNN barely faster (<10%) → WebGPU, says why');
        const off = agree.slice(); off[0] = 0.9;
        ok(cb(400, off).backend === 'webgpu' && /differ/.test(cb(400, off).note), 'one crop far off (cosine 0.9) → WebGPU, says the embeddings differ');
        eq(E.chooseBackend({ gpuMs: 0, nnMs: 0, crops: 0, cos: [] }).backend, 'webgpu', 'no timed frames → WebGPU');
    }
}

group('Checklist save / reopen (ui/id-switch-review.js)');
{
    const R = await import(pathToFileURL(path.join(ROOT, 'ui', 'id-switch-review.js')).href);
    ok(R.serializeIdSwitchReview({}) === null && R.serializeIdSwitchReview({ _idSwitch: { results: { size: { ok: false } } } }) === null,
        'no check results → nothing to write (an untouched project keeps its bytes)');
    const pt = (frame, a, b, score, extra) => Object.assign({ frame, nameA: a, nameB: b, score }, extra || {});
    const results = {
        size: { ok: true, encounters: [1, 2, 3], sampleHz: 15, step: 4, fps: 60, fpsFromVideo: false,
                flags: [pt(100, 'id_0', 'id_1', -88.06, { startFrame: 64 }), pt(400, 'id_0', 'id_2', -5, { followOf: 100 }), pt(700, 'id_0', 'id_1', -9, { continues: true })],
                changes: [pt(900, 'id_1', 'id_2', 2.2, { kind: 'end' })] },
        image: { ok: true, encounters: [1, 2], sampleHz: 15, step: 4, fps: 60, fpsFromVideo: false, imageHz: 2, crops: 50, cameras: ['c0'],
                 flags: [pt(130, 'id_1', 'id_0', -30)], changes: [] },
    };
    R.linkIdSwitchResults(results);
    ok(results.size.flags[0].agree === results.image.flags[0], 'same pair (either order) within 1 s → linked as "Both"');
    const sess = { _idSwitch: { results, reviewed: new Set(['size:100:id_0:id_1', 'image:130:id_1:id_0']) } };
    const payload = JSON.parse(JSON.stringify(R.serializeIdSwitchReview(sess)));   // as it comes back from the file
    const back = R.ingestIdSwitchReview({}, payload);
    const st = back._idSwitch;
    ok(st && JSON.stringify(R.serializeIdSwitchReview(back)) === JSON.stringify(payload), 'reopen → re-save is lossless');
    ok(st && R.idSwitchOnsets(st.results.size) === R.idSwitchOnsets(results.size) && R.idSwitchEncounterCount(st.results.size) === 3,
        'restored counts match (possible switches, encounters checked)');
    ok(st && st.results.size.flags.some(m => m.kind === 'end') && st.results.size.flags.some(m => m.followOf === 100) && st.results.size.flags.some(m => m.continues),
        "'end' point, follow-on and repeat survive");
    ok(st && st.results.size.flags[0].agree && st.results.size.flags[0].agree.cue === 'image' && st.reviewed.has('size:100:id_0:id_1'),
        'the "Both" link is rebuilt and the ticks come back');
    ok(st && st.results.size.flags[0].startFrame === 64 && st.results.size.flags[1].startFrame === undefined,
        "an encounter's start frame survives (and stays absent where it was unknown)");
    const old = JSON.parse(JSON.stringify(payload)); old.checks.size.points.forEach(p => p.length = 7);   // saved before startFrame existed
    const st0 = R.ingestIdSwitchReview({}, old)._idSwitch;
    ok(st0 && st0.results.size.flags.length === 4 && st0.results.size.flags.every(m => m.startFrame === undefined), 'a file saved before start frames existed still opens');
    const M = await import(pathToFileURL(path.join(ROOT, 'ui', 'id-switch-modal.js')).href).catch(e => ({ __err: e }));
    if (M.__err) ok(true, 'id-switch-modal needs the browser to import (lead-in checked in the e2e test)');
    else ok(M.idSwitchLeadInFrame({ frame: 100, startFrame: 64 }, 30) === 34 && M.idSwitchLeadInFrame({ frame: 100 }, 60) === 40 &&
            M.idSwitchLeadInFrame({ frame: 10, startFrame: 5 }, 60) === 0, 'lead-in: 1 s before the start (or the end), never below 0');
    let threw = false, n = 0;
    for (const junk of [null, 7, 'x', {}, { v: 2, checks: {} }, { v: 1, checks: null }, { v: 1, checks: { size: { points: 'no' } } },
                        { v: 1, checks: { size: { points: [[1, 2, 3], null, ['a', 'b', 'c', 'd']] } } }]) {
        try { const s2 = R.ingestIdSwitchReview({}, junk); if (!s2._idSwitch || !R.idSwitchMarkers(s2._idSwitch.results.size || { flags: [] }).length) n++; }
        catch (e) { threw = true; }
    }
    ok(!threw && n === 8, `malformed payloads are ignored without throwing (${n}/8)`);
    // a single-camera candidate moment's cues ride along as a 10th column, written only for such a point
    const withLook = { size: { ok: true, encounters: [1], sampleHz: 15, step: 2, fps: 30, fpsFromVideo: true,
        flags: [pt(300, 'id_0', 'id_1', -400, { kind: 'onset', look: ['tracklet', 'ambiguity'] }), pt(600, 'id_0', 'id_2', -80)], changes: [] } };
    R.linkIdSwitchResults(withLook);
    const pl = JSON.parse(JSON.stringify(R.serializeIdSwitchReview({ _idSwitch: { results: withLook, reviewed: new Set() } })));
    ok(pl.checks.size.points[0].length === 10 && pl.checks.size.points[1].length === 9, 'a moment point has a 10th column; an encounter point keeps 9');
    const lk = R.ingestIdSwitchReview({}, pl)._idSwitch.results.size.flags;
    eq(JSON.stringify(lk.map(m => m.look || null)), '[["tracklet","ambiguity"],null]', 'the cues come back on the moment point only');
}

group('Failure reasons');
{
    const empty = new PD.Session([], new PD.Skeleton('m', NODES, []), [], 'e');
    const r1 = await SC.checkSizeSwitches(empty, { fps: 60 });
    ok(!r1.ok && /identit/i.test(r1.reason), 'no identities → asks for Track All (' + r1.reason + ')');
    const bare = new PD.Session([], new PD.Skeleton('m', ['a', 'b', 'c'], []), [], 'b');
    bare.addIdentity('x'); bare.addIdentity('y');
    const r2 = await SC.checkSizeSwitches(bare, { fps: 60 });
    ok(!r2.ok && /size nodes/.test(r2.reason), 'foreign skeleton → explains which nodes are needed');
    const r3 = await SC.checkSizeSwitches(buildSession(null).session, {});
    ok(!r3.ok && /frame rate/i.test(r3.reason), 'no frame rate → refuses rather than guessing (' + r3.reason + ')');
    // A short stretch of tracking (here: the first ~40 s) is too little to learn the animals from.
    const short = buildSession(null).session;
    for (const f of Array.from(short.instanceGroups.keys())) if (f >= 40 * 60) short.instanceGroups.delete(f);
    const r4 = await SC.checkSizeSwitches(short, { fps: 60 });
    ok(!r4.ok && /at least 60 s/.test(r4.reason) && /has 40 s/.test(r4.reason), 'under 60 s of tracking → refused, saying how much there is (' + r4.reason + ')');
}

group('Progress callback — awaited between folds, ends at total');
{
    const { session } = buildSession(null);
    const seen = [];
    await SC.checkSizeSwitches(session, { fps: 60, onProgress: async (d, t) => { seen.push([d, t]); } });
    ok(seen.length >= 2 && seen[seen.length - 1][0] === seen[seen.length - 1][1], `progress reported (${seen.length} calls, last ${seen[seen.length - 1]})`);
}

group('Keyframe sampling plan — samples move to keyframes only when keyframes are dense enough');
{
    // the image check's samples at 60 fps: every 32nd frame (15 Hz grid, every 8th sample)
    const frames = []; for (let f = 0; f < 6000; f += 32) frames.push(f);
    const kf = (gop, n = 6000) => { const k = []; for (let f = 0; f < n; f += gop) k.push(f); return k; };
    // sparse keyframes (the recordings measured: every 250 frames) → nothing moves: today's decoding exactly
    const sparse = SC.planKeyframeSamples(frames, kf(250));
    eq(sparse.snapped, 0, 'keyframe every 250 frames: no sample moves');
    ok(sparse.decode.every((f, i) => f === frames[i]), 'sparse: every sample decodes its own frame');
    eq(SC.planKeyframeSamples(frames, null).snapped, 0, 'unknown keyframes: no sample moves');
    // every 0.5 s at 60 fps → every sample on a keyframe at most 15 frames (0.25 s) away, strictly increasing
    const p = SC.planKeyframeSamples(frames, kf(30));
    eq(p.snapped, frames.length, 'keyframe every 30 frames: every sample moves to a keyframe');
    ok(p.decode.every(f => f % 30 === 0), 'every decoded frame is a keyframe');
    const shift = Math.max(...p.decode.map((f, i) => Math.abs(f - frames[i])));
    ok(shift <= 15, 'largest move ' + shift + ' frames ≤ 15 (0.25 s)');
    eq(p.maxShift, 16, 'max shift = half the sample spacing');
    ok(p.decode.every((f, i) => i === 0 || f > p.decode[i - 1]), 'decoded frames strictly increasing (no keyframe shared)');
    // GOP up to 10% over the sample spacing still qualifies (32 → 35); beyond, nothing moves
    eq(SC.planKeyframeSamples(frames, kf(32)).snapped, frames.length, 'keyframe every 32 frames (= spacing): all move');
    ok(SC.planKeyframeSamples(frames, kf(35)).snapped > 0.9 * frames.length, 'keyframe every 35 frames (≤ 1.1 × spacing): nearly all move');
    eq(SC.planKeyframeSamples(frames, kf(36)).snapped, 0, 'keyframe every 36 frames (> 1.1 × spacing): none move');
    // a recorder set to a keyframe every 0.5 s at frame rates where the check samples a bit more often:
    // 100 fps → samples every 49 frames, keyframes every 50; 50 fps → every 24, keyframes every 25
    for (const [fps, spacing, gop] of [[100, 49, 50], [50, 24, 25]]) {
        const fr = []; for (let f = 0; f < 120 * fps; f += spacing) fr.push(f);
        const k = []; for (let f = 0; f < 120 * fps; f += gop) k.push(f);
        const pl = SC.planKeyframeSamples(fr, k);
        const move = Math.max(...pl.decode.map((f, i) => Math.abs(f - fr[i])));
        ok(pl.snapped >= 0.95 * fr.length && move <= gop / 2 && move / fps <= 0.25 && pl.decode.every((f, i) => i === 0 || f > pl.decode[i - 1]),
            `${fps} fps, keyframe every 0.5 s (${gop} frames vs samples every ${spacing}): ${pl.snapped}/${fr.length} move, largest ${move} frames = ${(move / fps).toFixed(2)} s`);
    }
    // a keyframe without tracking is skipped for the next nearest; none within reach → the sample stays
    const noTrack = new Set([60, 90]);
    const q = SC.planKeyframeSamples([0, 64, 128], kf(30, 200), f => !noTrack.has(f));
    eq(q.decode.join(','), '0,64,120', 'untracked keyframes skipped; a sample with none in reach keeps its frame');
    // two samples closer than a keyframe gap can't share one keyframe
    const r = SC.planKeyframeSamples([0, 32, 40, 64, 96], kf(30, 200));
    eq(r.decode.join(','), '0,30,40,60,90', 'no keyframe used twice: 40 keeps its frame rather than share 30');
    eq(r.snapped, 4, '…and the other four move');
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
