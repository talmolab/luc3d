/**
 * test-video-table-counts.mjs — ui/video-table-counts.js gives the Videos
 * table the same Labeled / Groups / Score numbers as the per-camera loops it
 * replaced (one walk of `frameGroups` per video, and every group member read
 * with for...of).
 *
 *   - Random sessions: cameras in and out of order inside groups, null
 *     members, frames with only unlinked instances, empty lists, scores of 0,
 *     a camera with no data at all, frames missing from `frameGroups` (a lazy
 *     project's resident window).
 *   - Real Session / FrameGroup / InstanceGroup objects.
 *   - The score sums are bit-identical (same order of addition per camera).
 *   - Counted in slices (`createVideoTableCounter`): any slice size, by frame
 *     count or by clock, gives the one-shot result; a slice stops on time.
 *
 * Run: node tests/test-video-table-counts.mjs
 */
import { videoTableCounts, createVideoTableCounter } from '../ui/video-table-counts.js';
import { FrameGroup, InstanceGroup, Instance, UnlinkedInstance } from '../pose/pose-data.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
    if (cond) passed++;
    else { failed++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function eq(actual, expected, msg) { ok(Object.is(actual, expected), `${msg} (expected ${expected}, got ${actual})`); }
function group(name) { console.log('\n• ' + name); }

/** The code this replaced, per video row (ui/info-panel.js before). */
function reference(session, camName) {
    let labelCount = 0, groupCount = 0, scoreSum = 0, scoreCount = 0;
    for (const [, fg] of session.frameGroups) {
        const instances = fg.getInstances(camName);
        const unlinked = fg.getUnlinkedInstances(camName);
        if (instances.length > 0 || unlinked.length > 0) labelCount++;
        for (let j = 0; j < instances.length; j++) {
            if (instances[j].score > 0) { scoreSum += instances[j].score; scoreCount++; }
        }
    }
    for (const [, groups] of session.instanceGroups) {
        for (const g of groups) {
            for (const [cam, inst] of g.instances) if (inst && cam === camName) groupCount++;
        }
    }
    return { labeled: labelCount, groups: groupCount, scoreSum, scoreCount };
}

let seed = 7;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

function inst(score) { return new Instance([[1, 2], [3, 4]], 0, score > 0 ? 'predicted' : 'user', score); }

function randomSession(nFrames, cams, opts) {
    const frameGroups = new Map();
    const instanceGroups = new Map();
    for (let f = 0; f < nFrames; f++) {
        const resident = !opts.lazy || rnd() < 0.3;
        const fg = new FrameGroup(f);
        const groups = [];
        const nAnimals = Math.floor(rnd() * 4);
        for (let a = 0; a < nAnimals; a++) {
            const g = new InstanceGroup(f * 10 + a, a);
            const order = rnd() < 0.3 ? cams.slice().reverse() : cams;
            for (const cam of order) {
                const r = rnd();
                if (r < 0.15) continue;
                if (r < 0.2) { g.instances.set(cam, null); continue; }
                const score = rnd() < 0.2 ? 0 : Math.round(rnd() * 1000) / 997;
                const i = inst(score);
                g.instances.set(cam, i);
                if (resident) fg.addInstance(cam, i);
            }
            groups.push(g);
        }
        if (resident) {
            for (const cam of cams) {
                const r = rnd();
                if (r < 0.1) fg.addUnlinkedInstance(cam, new UnlinkedInstance(inst(0.5), cam, f * 100));
                else if (r < 0.15) fg.instances.set(cam, fg.instances.get(cam) || []);   // an empty list
            }
            frameGroups.set(f, fg);
        }
        if (groups.length) instanceGroups.set(f, groups);
    }
    return { frameGroups, instanceGroups };
}

function compare(session, cams, label) {
    const got = videoTableCounts(session);
    for (const cam of cams) {
        const ref = reference(session, cam);
        const c = got.get(cam) || { labeled: 0, groups: 0, scoreSum: 0, scoreCount: 0 };
        eq(c.labeled, ref.labeled, `${label}: ${cam} labeled`);
        eq(c.groups, ref.groups, `${label}: ${cam} groups`);
        eq(c.scoreCount, ref.scoreCount, `${label}: ${cam} scored instances`);
        eq(c.scoreSum, ref.scoreSum, `${label}: ${cam} score sum, bit for bit`);
    }
}

group('random eager sessions = the per-camera loops');
for (let t = 0; t < 20; t++) {
    const cams = ['camA', 'camB', 'camC', 'camD', 'camE'].slice(0, 2 + (t % 4));
    const s = randomSession(200 + t * 13, cams, { lazy: false });
    compare(s, cams.concat(['noSuchCam']), 'eager #' + t);
}

group('random lazy sessions (only some frames resident) = the per-camera loops');
for (let t = 0; t < 20; t++) {
    const cams = ['Camera0', 'Camera1', 'Camera2', 'Camera3', 'Camera4', 'Camera5', 'Camera6', 'Camera7'];
    const s = randomSession(300, cams, { lazy: true });
    compare(s, cams, 'lazy #' + t);
}

function sameCounts(a, b) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
        const w = b.get(k);
        if (!w || w.labeled !== v.labeled || w.groups !== v.groups
            || !Object.is(w.scoreSum, v.scoreSum) || w.scoreCount !== v.scoreCount) return false;
    }
    return true;
}

group('counted in slices = counted at once');
{
    const cams = ['Camera0', 'Camera1', 'Camera2', 'Camera3', 'Camera4', 'Camera5', 'Camera6', 'Camera7'];
    for (const lazy of [false, true]) {
        const s = randomSession(1500, cams, { lazy });
        const whole = videoTableCounts(s);
        for (const frames of [1, 3, 64, 1000]) {
            globalThis.__lucidVideoCountSliceFrames = frames;
            const c = createVideoTableCounter(s);
            let steps = 1;
            while (!c.step(12)) steps++;
            const expectSteps = Math.ceil((s.frameGroups.size + s.instanceGroups.size) / frames);
            ok(steps >= expectSteps && steps <= expectSteps + 2,
                `${lazy ? 'lazy' : 'eager'}, ${frames} frame(s) a slice: ${steps} slices (~${expectSteps})`);
            ok(sameCounts(c.result(), whole), `${lazy ? 'lazy' : 'eager'}, ${frames} frame(s) a slice: same counts`);
            ok(c.step(12) === true && sameCounts(c.result(), whole), 'a finished counter stays finished');
        }
        delete globalThis.__lucidVideoCountSliceFrames;
        // By clock: a 0 ms budget stops at the first look at the clock (256 frames).
        const c = createVideoTableCounter(s);
        let steps = 1;
        while (!c.step(0)) steps++;
        ok(steps > 1, `${lazy ? 'lazy' : 'eager'}, 0 ms a slice: ${steps} slices`);
        ok(sameCounts(c.result(), whole), `${lazy ? 'lazy' : 'eager'}, 0 ms a slice: same counts`);
    }
    ok(createVideoTableCounter(null).step(0) === true, 'no session: done at once');
}

group('no session, empty session');
eq(videoTableCounts(null).size, 0, 'no session: nothing');
eq(videoTableCounts({ frameGroups: new Map(), instanceGroups: new Map() }).size, 0, 'empty session: nothing');

group('a camera that only has unlinked instances is labeled, with no groups and no score');
{
    const fg = new FrameGroup(0);
    fg.addUnlinkedInstance('camZ', new UnlinkedInstance(inst(0.9), 'camZ', 1));
    fg.addUnlinkedInstance('camZ', new UnlinkedInstance(inst(0.9), 'camZ', 2));
    const c = videoTableCounts({ frameGroups: new Map([[0, fg]]), instanceGroups: new Map() }).get('camZ');
    eq(c.labeled, 1, 'labeled once for the frame');
    eq(c.groups, 0, 'no groups');
    eq(c.scoreCount, 0, 'unlinked scores are not counted');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
    console.error('\nFailures:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
