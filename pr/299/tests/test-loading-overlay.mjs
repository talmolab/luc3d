/**
 * test-loading-overlay.mjs — the shared loading-overlay progress bar
 * (ui/loading-overlay.js) and the progress contract of the bulk sweep that
 * feeds it (`sweepLazyFrameWindows`, pose/triangulation.js).
 *
 * Pins:
 *   - `showLoadingProgress` writes "<label>: done/total frames (pct%)…" (the
 *     format Track All always used, now shared by Triangulate All), sets the bar
 *     fraction, and puts "Step k of n" / detail on the line under the bar;
 *   - a new stage SNAPS the bar (no transition) instead of animating backwards;
 *   - `showLoading` / `hideLoading` hide the bar again;
 *   - the second line estimates the time remaining from the recent rate, says
 *     "Estimating…" until it has data, resets per stage, and clears at 100%;
 *   - `createProgressPacer().due()` is clock-gated, and `yield()` resolves with
 *     no rAF / document (the Node path);
 *   - the sweep reports monotonic positions that end exactly at `total`, in both
 *     branches, even when most frames have no data.
 *
 * Run:  node tests/test-loading-overlay.mjs
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
function eq(actual, expected, msg) {
    ok(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function group(name) { console.log('\n• ' + name); }

// --- a DOM just big enough for the overlay ----------------------------------
function fakeEl(id, classes = []) {
    const set = new Set(classes);
    const attrs = {};
    return {
        id, textContent: '', style: {}, dataset: {},
        classList: {
            add: (c) => set.add(c), remove: (c) => set.delete(c),
            contains: (c) => set.has(c),
            toggle: (c, on) => { if (on === undefined) on = !set.has(c); on ? set.add(c) : set.delete(c); return on; },
        },
        setAttribute: (k, v) => { attrs[k] = v; },
        getAttribute: (k) => attrs[k],
    };
}
const els = {
    loadingOverlay: fakeEl('loadingOverlay', ['hidden']),
    loadingStatus: fakeEl('loadingStatus'),
    loadingEta: fakeEl('loadingEta', ['hidden']),
    loadingProgress: fakeEl('loadingProgress', ['hidden']),
    loadingProgressFill: fakeEl('loadingProgressFill'),
    loadingSubstatus: fakeEl('loadingSubstatus', ['hidden']),
};
globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };
globalThis.document = { getElementById: (id) => els[id] || null };
globalThis.window = globalThis;

register(pathToFileURL(path.join(ROOT, 'scripts', 'bench', 'hooks.mjs')).href);
const overlay = await import(pathToFileURL(path.join(ROOT, 'ui', 'loading-overlay.js')).href);
const { showLoading, hideLoading, showLoadingProgress, createProgressPacer,
        estimateRemainingMs, formatRemaining, __setLoadingOverlayClock } = overlay;
const { state } = await import(pathToFileURL(path.join(ROOT, 'ui', 'app-state.js')).href);
const { sweepLazyFrameWindows } =
    await import(pathToFileURL(path.join(ROOT, 'pose', 'triangulation.js')).href);

const hidden = (id) => els[id].classList.contains('hidden');
const frac = () => parseFloat(els.loadingProgressFill.dataset.fraction);
const snapped = () => els.loadingProgressFill.classList.contains('no-anim');

// ---------------------------------------------------------------------------
group('showLoadingProgress — text, bar, step line');
{
    showLoadingProgress('Assigning identities', 9000, 36000);
    eq(els.loadingStatus.textContent, 'Assigning identities: 9000/36000 frames (25%)…',
        'Track All keeps its exact text');
    ok(!hidden('loadingOverlay'), 'overlay shown');
    ok(!hidden('loadingProgress'), 'bar shown');
    eq(frac(), 0.25, 'bar fraction = done/total');
    eq(els.loadingProgressFill.style.transform, 'scaleX(0.25)', 'fill scaled with a transform');
    eq(els.loadingProgress.getAttribute('aria-valuenow'), '25', 'aria-valuenow tracks the percentage');
    ok(hidden('loadingSubstatus'), 'no step/detail line for a single-stage run with no detail');

    showLoadingProgress('Triangulating', 12000, 36000, { detail: 'Refined · 36,000 groups' });
    eq(els.loadingStatus.textContent, 'Triangulating: 12000/36000 frames (33%)…',
        'Triangulate All uses the same format');
    eq(els.loadingSubstatus.textContent, 'Refined · 36,000 groups', 'detail goes under the bar');

    showLoadingProgress('Assigning identities', 1, 2, { step: 2, steps: 2 });
    eq(els.loadingSubstatus.textContent, 'Step 2 of 2', 'multi-stage runs label the step');
    showLoadingProgress('Assigning identities', 1, 2, { step: 1, steps: 1 });
    ok(hidden('loadingSubstatus'), '"Step 1 of 1" is never shown');

    showLoadingProgress('X', 35999, 36000);
    eq(els.loadingStatus.textContent, 'X: 35999/36000 frames (99%)…', 'percentage is floored — 100% only when done');
    showLoadingProgress('X', 5, 0);
    eq(frac(), 0, 'total 0 does not divide by zero');
}

group('showLoadingProgress — animate forward, snap on a new stage');
{
    hideLoading();
    showLoadingProgress('Loading frames', 0, 100, { step: 1, steps: 2 });
    ok(snapped(), 'first update after the bar was hidden snaps');
    showLoadingProgress('Loading frames', 50, 100, { step: 1, steps: 2 });
    ok(!snapped(), 'forward progress animates');
    showLoadingProgress('Loading frames', 100, 100, { step: 1, steps: 2 });
    showLoadingProgress('Assigning identities', 0, 100, { step: 2, steps: 2 });
    ok(snapped(), 'the next stage starting at 0 snaps instead of rewinding visibly');
    eq(frac(), 0, 'new stage starts empty');
}

group('showLoading / hideLoading hide the bar');
{
    showLoadingProgress('Triangulating', 10, 100, { detail: 'DLT' });
    showLoading('Loading videos…');
    ok(hidden('loadingProgress'), 'indeterminate showLoading hides the bar');
    ok(hidden('loadingSubstatus'), '…and the detail line');
    eq(els.loadingStatus.textContent, 'Loading videos…', 'text replaced');
    showLoadingProgress('Triangulating', 10, 100);
    hideLoading();
    ok(hidden('loadingOverlay') && hidden('loadingProgress'), 'hideLoading hides overlay and bar');
    eq(frac(), 0, 'hideLoading resets the fill');
}

group('time remaining — formatting');
{
    eq(formatRemaining(4000), 'Less than 10 s remaining', 'under 10 s');
    eq(formatRemaining(43000), 'About 45 s remaining', 'rounded to 5 s');
    eq(formatRemaining(60000), 'About 1 min remaining', 'whole minute');
    eq(formatRemaining(71000), 'About 1 min 10 s remaining', 'min + s');
    eq(formatRemaining(14.4 * 60000), 'About 14 min remaining', 'minutes past 10 min');
    eq(formatRemaining(125 * 60000), 'About 2 h 5 min remaining', 'hours');
}

group('time remaining — estimator');
{
    const lin = (n, perSec) => Array.from({ length: n }, (_, i) => ({ t: i * 250, done: Math.round(i * 250 / 1000 * perSec) }));
    eq(estimateRemainingMs(lin(4, 400), 300, 36000), null, 'null before 1.5 s of samples');
    const s = lin(41, 400);                        // 10 s at 400 frames/s -> done 4000
    eq(Math.round(estimateRemainingMs(s, 4000, 36000)), 80000, 'steady rate: (36000-4000)/400 = 80 s');
    // Work slows to 100 frames/s for the last 10 s: the window follows it.
    const slow = s.concat(Array.from({ length: 40 }, (_, i) => ({ t: 10000 + (i + 1) * 250, done: 4000 + (i + 1) * 25 })));
    eq(Math.round(estimateRemainingMs(slow, 5000, 36000)), 310000, 'the recent rate wins after a slowdown');
    eq(estimateRemainingMs([{ t: 0, done: 10 }, { t: 2000, done: 10 }], 10, 36000), null,
        'no progress at all -> still estimating, never Infinity');
}

group('time remaining — the second line in the overlay');
{
    let now = 0;
    __setLoadingOverlayClock(() => now);
    hideLoading();
    showLoadingProgress('Triangulating', 0, 36000);
    eq(els.loadingEta.textContent, 'Estimating time remaining…', 'starts as "Estimating…"');
    ok(!hidden('loadingEta'), 'ETA line shown');
    for (let i = 1; i <= 40; i++) { now = i * 250; showLoadingProgress('Triangulating', i * 100, 36000); }
    // 4000 frames in 10 s = 400/s; 32000 left -> 80 s.
    eq(els.loadingEta.textContent, 'About 1 min 20 s remaining', 'estimate from the measured rate');
    eq(els.loadingEta.dataset.ms, '80000', 'raw estimate exposed as data-ms (bench reads it)');

    showLoadingProgress('Triangulating', 36000, 36000);
    ok(hidden('loadingEta'), 'cleared at 100%');

    hideLoading();
    showLoadingProgress('Loading frames', 0, 1000, { step: 1, steps: 2 });
    for (let i = 1; i <= 8; i++) { now += 250; showLoadingProgress('Loading frames', i * 50, 1000, { step: 1, steps: 2 }); }
    ok(/in this step$/.test(els.loadingEta.textContent), `multi-stage ETA is scoped to the step ("${els.loadingEta.textContent}")`);
    showLoadingProgress('Assigning identities', 0, 1000, { step: 2, steps: 2 });
    eq(els.loadingEta.textContent, 'Estimating time remaining…', 'a new stage starts a fresh estimate');

    showLoading('Loading videos…');
    ok(hidden('loadingEta'), 'indeterminate showLoading hides the ETA');
    __setLoadingOverlayClock(null);
}

group('createProgressPacer');
{
    const p = createProgressPacer(40);
    ok(!p.due(), 'not due immediately');
    const t = performance.now();
    while (performance.now() - t < 45) { /* spin */ }
    ok(p.due(), 'due once the interval has passed');
    ok(!p.due(), 'due() resets the clock');
    const y0 = performance.now();
    await p.yield();
    ok(performance.now() - y0 < 50, 'yield() resolves promptly without rAF (Node / hidden tab path)');
    ok(!p.due(), 'the interval restarts after a yield');
}

// ---------------------------------------------------------------------------
function makeSession(nFrames, twoD, { windowed = true } = {}) {
    const session = {
        frameGroups: new Map(), instanceGroups: new Map(),
        addFrameGroup(fg) { this.frameGroups.set(fg.frameIdx, fg); },
    };
    for (const f of twoD) session.frameGroups.set(f, { frameIdx: f, instances: new Map(), unlinkedInstances: new Map() });
    if (windowed) {
        session.lazyLoader = { isSync: true, nFrames, getFrameSync() { return null; }, releaseWindow() {} };
    }
    return session;
}
async function sweepProgress(session, opts, workMs) {
    state.session = session;
    state.currentFrame = 0;
    const calls = [];
    await sweepLazyFrameWindows(session, function () {
        const t = performance.now();
        while (performance.now() - t < workMs) { /* simulate work */ }
    }, { ...opts, onProgress: (d, t) => { calls.push([d, t]); } });
    return calls;
}
const monotone = (calls) => calls.every((c, i) => i === 0 || c[0] >= calls[i - 1][0]);

group('sweepLazyFrameWindows — windowed progress is a monotonic position ending at total');
{
    // 5,000 frames, only every 10th has data, ~1.2 s of work: several pacer ticks,
    // across window boundaries (2,000-frame windows).
    const data = Array.from({ length: 500 }, (_, i) => i * 10);
    const calls = await sweepProgress(makeSession(5000, data), {}, 2.4);
    ok(calls.length >= 3, `reports several times on a ~1.2 s sweep (got ${calls.length})`);
    ok(monotone(calls), 'positions never go backwards');
    ok(calls.every(c => c[1] === 5000), 'total is the frame span');
    eq(JSON.stringify(calls[calls.length - 1]), JSON.stringify([5000, 5000]), 'last report is total/total');
}

group('sweepLazyFrameWindows — range-offset sweep reports positions within the range');
{
    const calls = await sweepProgress(makeSession(5000, [1000, 1500, 2999]), { start: 1000, end: 2999 }, 0);
    eq(JSON.stringify(calls[calls.length - 1]), JSON.stringify([2000, 2000]), 'ends at range length');
    ok(calls.every(c => c[0] <= c[1]), 'never exceeds total');
}

group('sweepLazyFrameWindows — non-windowed progress ends at total');
{
    const calls = await sweepProgress(makeSession(0, Array.from({ length: 300 }, (_, i) => i), { windowed: false }), {}, 2.5);
    ok(calls.length >= 2, `reports during the sweep (got ${calls.length})`);
    ok(monotone(calls), 'monotonic');
    eq(JSON.stringify(calls[calls.length - 1]), JSON.stringify([300, 300]), 'last report is total/total');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
    console.error('\nFailures:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
