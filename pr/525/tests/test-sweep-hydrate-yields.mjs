/**
 * test-sweep-hydrate-yields.mjs — does the shared bulk sweep let the page
 * breathe WHILE it hydrates a window?
 *
 * `sweepLazyFrameWindows` (pose/triangulation.js) hydrates a lazy project
 * 2,000 frames at a time. It used to build each whole window in one
 * synchronous block (`batchLoadLazyFrames`) before checking its progress pacer,
 * so on the real 8-camera, 108,000-frame project every window boundary of a
 * Triangulate All held the main thread 0.3-0.8 s (the build plus the minor GC
 * that promoted it), on top of the pacer's own 250 ms chunk. It now hydrates in
 * `SWEEP_HYDRATE_SLICE`-frame slices and checks the pacer between them.
 *
 * Checked here, with a fake windowed loader whose frame build costs a fixed
 * busy-wait:
 *   1. the longest stretch without a yield stays near the pacer interval
 *      (timed at the sweep's own yields; the old block was a whole window's
 *      build, 813 ms here on main);
 *   2. the ORDER of work is unchanged: every frame is built once, in order, and
 *      a window is fully built before the callback sees any of its frames.
 *
 * Run:  node tests/test-sweep-hydrate-yields.mjs
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
    if (cond) { passed++; }
    else { failed++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function group(name) { console.log('\n• ' + name); }

// DOM + bench globals must exist before the pose modules are imported.
globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;

register(pathToFileURL(path.join(ROOT, 'scripts', 'bench', 'hooks.mjs')).href);
const { state } = await import(pathToFileURL(path.join(ROOT, 'ui', 'app-state.js')).href);
const { sweepLazyFrameWindows } =
    await import(pathToFileURL(path.join(ROOT, 'pose', 'triangulation.js')).href);
const { PROGRESS_INTERVAL_MS } =
    await import(pathToFileURL(path.join(ROOT, 'ui', 'loading-overlay.js')).href);

const WINDOW = 2000;               // the sweep's default window
const BUILD_MS = 0.4;              // cost of building one frame (busy-wait)

function busy(ms) { const t = performance.now() + ms; while (performance.now() < t) { /* spin */ } }

/** A windowed lazy session: every frame has 3D grouping (so the callback sees
 *  it) and `getFrameSync` costs BUILD_MS and returns no 2D. */
function makeSession(nFrames, log) {
    const session = {
        frameGroups: new Map(),
        instanceGroups: new Map(),
        addFrameGroup(fg) { this.frameGroups.set(fg.frameIdx, fg); },
        lazyLoader: {
            isSync: true,
            nFrames,
            getFrameSync(fi) { busy(BUILD_MS); log.push(['build', fi]); return null; },
            releaseWindow(s, e) { log.push(['release', s, e]); },
        },
    };
    for (let f = 0; f < nFrames; f++) session.instanceGroups.set(f, [{ id: 'g' + f }]);
    return session;
}

group('windowed sweep — hydrating a window yields on the pacer');
{
    const nFrames = 3 * WINDOW;
    const log = [];
    const session = makeSession(nFrames, log);
    state.session = session;
    state.currentFrame = -1;

    // Time the sweep's own yields. Without a visible document `yieldToPaint`
    // (ui/loading-overlay.js) yields through a MessageChannel: wrap it to note
    // when each yield starts (postMessage) and when the sweep resumes (the
    // message handler). The longest stretch from a resume to the next yield is
    // the longest the sweep held the thread. (A setImmediate heartbeat cannot
    // measure this in Node: a yield and the next chunk can share a poll phase.)
    const RealMC = globalThis.MessageChannel;
    let resumedAt = 0, maxGap = 0, yields = 0;
    const noteYield = () => { const g = performance.now() - resumedAt; if (g > maxGap) maxGap = g; yields++; };
    globalThis.MessageChannel = function () {
        const ch = new RealMC();
        this.port1 = {
            set onmessage(fn) { ch.port1.onmessage = (e) => { resumedAt = performance.now(); fn(e); }; },
            close() { ch.port1.close(); },
        };
        this.port2 = { postMessage(m) { noteYield(); ch.port2.postMessage(m); } };
    };
    const t0 = resumedAt = performance.now();
    try {
        await sweepLazyFrameWindows(session, function (fi) { log.push(['visit', fi]); });
    } finally {
        globalThis.MessageChannel = RealMC;
    }
    noteYield();   // the stretch from the last resume to the end
    const total = performance.now() - t0;
    const windowBuildMs = WINDOW * BUILD_MS;
    console.log(`  sweep ${total.toFixed(0)} ms, ${yields - 1} yields; longest stretch without a yield ${maxGap.toFixed(0)} ms ` +
        `(pacer ${PROGRESS_INTERVAL_MS} ms; one window's build ${windowBuildMs} ms)`);
    // Before the fix the longest stretch was a whole window's build (800 ms)
    // plus the pacer chunk it landed in. Allow the pacer interval plus a slice
    // and generous slack for a loaded machine.
    ok(maxGap < PROGRESS_INTERVAL_MS + 300,
        `longest stretch without a yield (${maxGap.toFixed(0)} ms) stays under ${PROGRESS_INTERVAL_MS + 300} ms ` +
        `(a window's build is ${windowBuildMs} ms)`);

    // Order: builds 0..n-1 exactly once each, in order.
    const builds = log.filter(e => e[0] === 'build').map(e => e[1]);
    ok(builds.length === nFrames && builds.every((f, i) => f === i), 'every frame is built once, in order');
    // A window is fully built before its first frame is visited, and visited
    // before the next window starts building.
    let okOrder = true;
    for (let w = 0; w < 3; w++) {
        const s = w * WINDOW, e = s + WINDOW;
        const lastBuild = log.findIndex(x => x[0] === 'build' && x[1] === e - 1);
        const firstVisit = log.findIndex(x => x[0] === 'visit' && x[1] === s);
        const lastVisit = log.findIndex(x => x[0] === 'visit' && x[1] === e - 1);
        const nextBuild = log.findIndex(x => x[0] === 'build' && x[1] === e);
        if (!(lastBuild < firstVisit)) okOrder = false;
        if (nextBuild >= 0 && !(lastVisit < nextBuild)) okOrder = false;
    }
    ok(okOrder, 'each window is fully built before its frames are visited, and visited before the next is built');
    const visits = log.filter(e => e[0] === 'visit').map(e => e[1]);
    ok(visits.length === nFrames && visits.every((f, i) => f === i), 'every frame is visited once, in order');
    const releases = log.filter(e => e[0] === 'release').map(e => e[1] + '-' + e[2]);
    ok(JSON.stringify(releases) === JSON.stringify(['0-2000', '2000-4000', '4000-6000']), 'windows are released as before');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
    console.error('\nFailures:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
