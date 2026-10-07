/**
 * test-lazy-residency.mjs — bounding a lazy project's resident window
 * (`pose/lazy-residency.js`).
 *
 * Playback used to leave every frame it hydrated resident for the rest of the
 * session, and on a large project that is what made playback degrade run by run
 * (major-GC cost grows with the live graph). The fix evicts frames behind the
 * playhead — which is only safe for a frame that the normal hydration path
 * rebuilds EXACTLY. The oracle here is therefore the app's own hydration: the
 * real `batchLoadLazyFrames` / `finalizeLazyFrameGroup` (pose/triangulation.js)
 * over a real `SioLazyLoader` whose columnar store is built by hand. For every
 * frame the predicate vouches for, evict + re-hydrate must give back the same
 * frame; for every edit it refuses, the same forced round trip must LOSE the
 * edit (the negative control — so each refusal is guarding something real).
 *
 * Also pinned: holds (a running sweep is never evicted from under), the derived
 * reprojection caches going with a clean frame and staying with a dirty group,
 * the playback trim's budget, and the sync/async lookahead.
 *
 * Run:  node tests/test-lazy-residency.mjs
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
    if (cond) { passed++; }
    else { failed++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function eq(actual, expected, msg) {
    ok(actual === expected, `${msg} (expected ${expected}, got ${actual})`);
}
function group(name) { console.log('\n• ' + name); }

// UI modules pose/triangulation.js imports are stubbed (scripts/bench/hooks.mjs);
// pose-data.js, triangulation.js, sio-lazy-loader.js and lazy-residency.js load real.
globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;
class FakePredictedInstance {
    constructor(points, track) { this.points = points; this.track = track; this.score = 0.9; }
}
globalThis.SleapIO = { PredictedInstance: FakePredictedInstance };

register(pathToFileURL(path.join(ROOT, 'scripts', 'bench', 'hooks.mjs')).href);
const { state } = await imp('ui/app-state.js');
const { batchLoadLazyFrames, sweepLazyFrameWindows, loadAllLazyFrames, ensureLazyFrameData } = await imp('pose/triangulation.js');
const { SioLazyLoader } = await imp('loading/sio-lazy-loader.js');
const { Session, Skeleton, Camera, Instance, InstanceGroup, UnlinkedInstance, lazyPlaceholderXY, isLazyPlaceholderXY } = await imp('pose/pose-data.js');
const LR = await imp('pose/lazy-residency.js');

const CAMS = ['c0', 'c1', 'c2'];
const NODES = 3;
const N_FRAMES = 80;
const TRACKS = ['t0', 't1', 't2'];

/** Rows per (camera, frame): 0..3 predicted rows; some frames absent or empty. */
function nRows(cam, f) {
    const ci = CAMS.indexOf(cam);
    if ((f + ci) % 17 === 0) return null;          // no row for this frame
    if ((f + ci) % 19 === 0) return 0;             // a row, zero instances
    return 1 + ((f * 5 + ci) % 3);
}
/** Store track of row k: some trackless (-1), the rest t0..t2. */
const rowTrack = (cam, f, k) => ((f + k + CAMS.indexOf(cam)) % 4 === 0) ? -1 : (f + k) % TRACKS.length;

/** A real SioLazyLoader over a hand-built columnar store, one store per camera. */
function makeLoader(nFrames = N_FRAMES) {
    const loader = new SioLazyLoader();
    loader.nFrames = nFrames;
    for (const cam of CAMS) {
        const start = [], end = [], type = [], track = [];
        const rowMap = new Map();
        const tracks = TRACKS.map(name => ({ name }));
        for (let f = 0; f < nFrames; f++) {
            const n = nRows(cam, f);
            if (n === null) continue;
            rowMap.set(f, start.length);
            start.push(type.length);
            for (let k = 0; k < n; k++) { type.push(1); track.push(rowTrack(cam, f, k)); }
            end.push(type.length);
        }
        loader.labelsByCam.set(cam, {
            _lazyDataStore: {
                framesData: { instance_id_start: Float64Array.from(start), instance_id_end: Float64Array.from(end) },
                instancesData: { instance_type: Float64Array.from(type), track: Float64Array.from(track) },
            },
            tracks,
            frameAt(row) {
                const out = [];
                for (let j = start[row]; j < end[row]; j++) {
                    const points = [];
                    for (let k = 0; k < NODES; k++) points.push({ xy: [10 + j, 20 + k], visible: true });
                    out.push(new FakePredictedInstance(points, track[j] >= 0 ? tracks[track[j]] : null));
                }
                return { instances: out };
            },
        });
        loader.frameRowByCam.set(cam, rowMap);
        loader.numNodesByCam.set(cam, NODES);
    }
    return loader;
}

function makeSession(nFrames = N_FRAMES) {
    const cameras = CAMS.map(n => new Camera(n, [[500, 0, 256], [0, 500, 256], [0, 0, 1]],
        [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [512, 512]));
    const session = new Session(cameras, new Skeleton('s', ['a', 'b', 'c'], [[0, 1], [1, 2]]), TRACKS.slice(), 'S');
    session.lazyLoader = makeLoader(nFrames);
    return session;
}

async function hydrate(session, from, count) {
    state.session = session;
    await batchLoadLazyFrames(from, count);
}

let gid = 1;
/**
 * Group row 0 of every camera on `f` the way Track All's `commitTrackedFrame`
 * does: the HYDRATED instance becomes the member and moves from the unlinked
 * pool into `fg.instances`. Skipped where fewer than two cameras have a row.
 */
function trackFrame(session, f) {
    const fg = session.frameGroups.get(f);
    if (!fg) return null;
    const picks = [];
    for (const cam of CAMS) {
        const ul = fg.getUnlinkedInstances(cam).find(u => u.instance._rawInstIndex === 0);
        if (ul) picks.push([cam, ul]);
    }
    if (picks.length < 2) return null;
    const g = new InstanceGroup(gid++, 0);
    g.points3d = new Float64Array(NODES * 3).fill(f);
    for (const [cam, ul] of picks) {
        g.addInstance(cam, ul.instance);
        fg.addInstance(cam, ul.instance);
        fg.removeUnlinkedById(ul.id);
    }
    const list = session.instanceGroups.get(f) || [];
    list.push(g);
    session.instanceGroups.set(f, list);
    return g;
}

/**
 * Everything a frame shows, by value — except UnlinkedInstance ids, which every
 * hydration mints afresh and nothing persists. Linked members are compared by
 * object identity, via the group that holds them.
 */
function snapshot(session, f) {
    const fg = session.frameGroups.get(f);
    if (!fg) return 'absent';
    const groups = session.instanceGroups.get(f) || [];
    const parts = [];
    for (const cam of CAMS) {
        const linked = (fg.instances.get(cam) || []).map(i => {
            const gi = groups.findIndex(g => g.instances.get(cam) === i);
            return `L${i._rawInstIndex}@g${gi}:${i.type}:${i.trackIdx}:${i.modified}`;
        }).sort();
        const unlinked = (fg.unlinkedInstances.get(cam) || []).map(u => {
            const i = u.instance;
            return `U${i._rawInstIndex}:${i.type}:${i.trackIdx}:${i.modified}:${i.identityId}:${Array.from(i._xy).join(',')}`;
        }).sort();
        parts.push(cam + '[' + linked.concat(unlinked).join(' ') + ']');
    }
    return parts.join(' ');
}

/** Drop `f` and hydrate it again through the app's real path. */
async function forceRoundTrip(session, f) {
    session.frameGroups.delete(f);
    await hydrate(session, f, 1);
    return snapshot(session, f);
}

/** A session with every frame hydrated and every 3rd frame tracked. */
async function trackedSession() {
    const s = makeSession();
    await hydrate(s, 0, N_FRAMES);
    for (let f = 0; f < N_FRAMES; f += 3) trackFrame(s, f);
    return s;
}

// ---------------------------------------------------------------------------
group('SioLazyLoader.instanceRowSpan / storeTrackAt read the store without materializing');
{
    const loader = makeLoader();
    let calls = 0;
    for (const lab of loader.labelsByCam.values()) { const fa = lab.frameAt; lab.frameAt = (r) => { calls++; return fa(r); }; }
    const out = [0, 0];
    let rowsSeen = 0, mismatch = 0;
    for (const cam of CAMS) {
        for (let f = 0; f < N_FRAMES; f++) {
            const span = loader.instanceRowSpan(cam, f, out);
            const n = nRows(cam, f);
            if (n === null) { if (span !== null) mismatch++; continue; }
            if (!span || span[1] - span[0] !== n) { mismatch++; continue; }
            for (let k = 0; k < n; k++) {
                rowsSeen++;
                if (loader.storeTrackAt(cam, span[0] + k) !== rowTrack(cam, f, k)) mismatch++;
            }
        }
    }
    eq(mismatch, 0, 'every (camera, frame) span and row track matches the fixture');
    ok(rowsSeen > 100, `fixture has rows to check (${rowsSeen})`);
    eq(calls, 0, 'no frame was materialized');
    eq(loader.instanceRowSpan('nope', 1, out), null, 'unknown camera -> null');
}

// ---------------------------------------------------------------------------
group('An untouched frame is rebuildable, and the round trip gives back the same frame');
{
    const s = await trackedSession();
    let rebuildable = 0, same = 0, tracked = 0;
    for (let f = 0; f < N_FRAMES; f++) {
        if (!s.frameGroups.has(f)) continue;
        if (s.instanceGroups.has(f)) tracked++;
        const fg = s.frameGroups.get(f);
        if (!LR.lazyFrameIsRebuildable(s, f, fg)) { console.error('    not rebuildable: frame ' + f + ' ' + snapshot(s, f)); continue; }
        rebuildable++;
        const before = snapshot(s, f);
        if (await forceRoundTrip(s, f) === before) same++;
        else console.error('    differs after round trip: frame ' + f);
    }
    eq(rebuildable, s.frameGroups.size, 'every untouched frame is rebuildable');
    eq(same, rebuildable, 'every rebuildable frame round-trips identically');
    ok(tracked > 10, `tracked frames are covered (${tracked})`);
}

// ---------------------------------------------------------------------------
group('Each in-memory edit is refused — and a forced round trip would lose it (negative controls)');
{
    // [name, edit(session, f) -> true if applicable]
    const edits = [
        ['deleted unlinked prediction', (s, f) => {
            const fg = s.frameGroups.get(f); const ul = (fg.unlinkedInstances.get('c1') || [])[0];
            if (!ul) return false; fg.removeUnlinkedById(ul.id); return true;
        }],
        ['track reassigned on an unlinked instance', (s, f) => {
            const ul = (s.frameGroups.get(f).unlinkedInstances.get('c0') || [])[0];
            if (!ul) return false; ul.instance.trackIdx = ul.instance.trackIdx === 2 ? 1 : 2; return true;
        }],
        ['unlinked node moved (modified + promoted)', (s, f) => {
            const ul = (s.frameGroups.get(f).unlinkedInstances.get('c2') || [])[0];
            if (!ul) return false; ul.instance.setPoint(0, 1, 1); ul.instance.modified = true; ul.instance.type = 'user'; return true;
        }],
        ['identity carried by a trackless unlinked instance (#201)', (s, f) => {
            const ul = (s.frameGroups.get(f).unlinkedInstances.get('c0') || [])[0];
            if (!ul) return false; ul.instance.identityId = 7; return true;
        }],
        ['user-created instance (no store row)', (s, f) => {
            const inst = new Instance(new Array(NODES).fill([5, 5]), null, 'user', 0);
            s.frameGroups.get(f).addUnlinkedInstance('c1', new UnlinkedInstance(inst, 'c1')); return true;
        }],
        ['group removed, members left linked', (s, f) => {
            if (!s.instanceGroups.has(f)) return false; s.instanceGroups.delete(f); return true;
        }],
        ['member deleted from one view', (s, f) => {
            const g = (s.instanceGroups.get(f) || [])[0]; if (!g || !g.instances.has('c0')) return false;
            const m = g.instances.get('c0'); g.instances.delete('c0');
            const list = s.frameGroups.get(f).instances.get('c0'); list.splice(list.indexOf(m), 1); return true;
        }],
        // Refused, but NOT lost by a round trip: the group holds the member and
        // hydration re-links it. Kept anyway — the same "user frames stay" rule
        // `sweepLazyFrameWindows` applies when it releases a window.
        ['member promoted to user', (s, f) => {
            const g = (s.instanceGroups.get(f) || [])[0]; if (!g) return false;
            g.instances.values().next().value.type = 'user'; return true;
        }, false],
    ];
    for (const [name, edit, lostIfEvicted = true] of edits) {
        const s = await trackedSession();
        let tried = 0, refused = 0, lost = 0;
        for (let f = 0; f < N_FRAMES && tried < 4; f++) {
            if (!s.frameGroups.has(f)) continue;
            if (!edit(s, f)) continue;
            tried++;
            const after = snapshot(s, f);
            if (!LR.lazyFrameIsRebuildable(s, f, s.frameGroups.get(f))) refused++;
            // Negative control: what eviction would have done.
            if (await forceRoundTrip(s, f) !== after) lost++;
        }
        ok(tried > 0, `${name}: fixture has a frame to edit`);
        eq(refused, tried, `${name}: refused on every edited frame`);
        if (lostIfEvicted) eq(lost, tried, `${name}: a forced round trip loses it every time (the refusal is load-bearing)`);
        else eq(lost, 0, `${name}: survives a round trip (the refusal is the sweep's conservative user-frame rule)`);
    }
}

// ---------------------------------------------------------------------------
group('A camera the loader does not back is never evicted');
{
    const s = await trackedSession();
    const f = 5;
    s.frameGroups.get(f).addUnlinkedInstance('eager', new UnlinkedInstance(new Instance([[1, 1], null, null], null, 'predicted', 0.5), 'eager'));
    eq(LR.lazyFrameIsRebuildable(s, f, s.frameGroups.get(f)), false, 'frame with eager-camera data is refused');
    const noSpan = { ...s, lazyLoader: { labelsByCam: s.lazyLoader.labelsByCam } };
    eq(LR.lazyFrameIsRebuildable(noSpan, 6, s.frameGroups.get(6)), false, 'a loader without instanceRowSpan (worker-backed) is never evicted');
}

// ---------------------------------------------------------------------------
group('evictLazyFramesOutside: the window, the kept frame, the edits, and the derived caches');
{
    const s = await trackedSession();
    const tri = new Map();
    // Derived caches as fillLazyReprojections leaves them, on every tracked frame.
    const cleanG = s.instanceGroups.get(60)[0], dirtyG = s.instanceGroups.get(63)[0];
    for (const [f, gs] of s.instanceGroups) {
        for (const g of gs) {
            g.reprojections = { c0: [[1, 2]] };
            g.addReprojectedInstance('c0', new Instance([[1, 2], null, null], 0, 'reprojected', 1));
        }
        tri.set(f, gs.map(g => ({ group: g, meanError: 1 })).concat([{ group: null, meanError: 2 }]));
    }
    dirtyG.dirty = true;
    const deletedOn = 61;   // an edit outside the window
    const fg61 = s.frameGroups.get(deletedOn);
    fg61.removeUnlinkedById(fg61.unlinkedInstances.get('c1')[0].id);
    const before = s.frameGroups.size;
    const r = LR.evictLazyFramesOutside(s, 10, 20, { keep: 70, triangulationResults: tri });
    const resident = [...s.frameGroups.keys()].sort((a, b) => a - b);
    ok(resident.filter(f => f >= 10 && f <= 20).length === [...Array(11).keys()].filter(k => nRows('c0', 10 + k) !== null || nRows('c1', 10 + k) !== null || nRows('c2', 10 + k) !== null).length,
        'every frame in the window stays');
    ok(s.frameGroups.has(70), 'the kept (on-screen) frame stays');
    ok(s.frameGroups.has(deletedOn), 'the edited frame stays');
    eq(r.keptOutside, 1, 'one frame kept outside the window (the edited one)');
    eq(r.evicted, before - s.frameGroups.size, 'evicted count matches');
    ok(s.frameGroups.size < 20, `resident shrank to the window (${s.frameGroups.size})`);
    eq(cleanG.reprojections, null, 'a clean group on an evicted frame loses its reprojections');
    eq(cleanG.reprojectedInstances.size, 0, '...and its reprojected instances');
    ok(!tri.get(60) || tri.get(60).every(e => e.group === null), '...and its triangulationResults entry');
    ok(tri.get(60) && tri.get(60).length === 1, 'an entry with no group is kept');
    ok(dirtyG.reprojections !== null && dirtyG.reprojectedInstances.size === 1, 'a DIRTY group keeps its caches');
    ok(tri.get(63).some(e => e.group === dirtyG), "...and its triangulationResults entry");
    const inWin = s.instanceGroups.get(12)[0];
    ok(inWin.reprojections !== null && tri.get(12).length === 2, 'caches of a frame in the window are untouched');
    // Everything evicted comes back as it was.
    const s2 = await trackedSession();
    let same = 0, n = 0;
    for (let f = 0; f < N_FRAMES; f++) {
        if (s.frameGroups.has(f) || !s2.frameGroups.has(f)) continue;
        n++;
        await hydrate(s, f, 1);
        // Linked members are the same objects in s, so compare by value via the
        // fixture's deterministic rows rather than across sessions.
        if (LR.lazyFrameIsRebuildable(s, f, s.frameGroups.get(f))) same++;
    }
    ok(n > 50, `evicted frames re-hydrated (${n})`);
    eq(same, n, 'every evicted frame re-hydrates to an untouched frame');
}

// ---------------------------------------------------------------------------
group('Holds: nothing is evicted while an operation reads frames back');
{
    const s = await trackedSession();
    const release = LR.holdLazyResidency();
    let r = LR.evictLazyFramesOutside(s, 0, 0, {});
    ok(r.held && r.evicted === 0, 'held -> no eviction');
    ok(LR.lazyResidencyHeld(), 'lazyResidencyHeld() reports it');
    release(); release();   // idempotent
    ok(!LR.lazyResidencyHeld(), 'released (twice is harmless)');
    r = LR.evictLazyFramesOutside(s, 0, 0, {});
    ok(!r.held && r.evicted > 0, 'released -> evicts');

    // A real sweep holds for its whole run: an eviction attempted from inside
    // its callback (as a playback tick between two awaits would be) is refused,
    // and the sweep still sees every frame.
    const s3 = await trackedSession();
    state.session = s3;
    state.currentFrame = 0;
    let heldInside = 0, visited = 0;
    const want = new Set([...s3.frameGroups.keys(), ...s3.instanceGroups.keys()]).size;
    await sweepLazyFrameWindows(s3, function (fi, fg) {
        visited++;
        const rr = LR.evictLazyFramesOutside(s3, fi, fi, {});
        if (rr.held && rr.evicted === 0) heldInside++;
    }, { window: 16 });
    eq(visited, want, 'the sweep visits every frame with data');
    eq(heldInside, visited, 'every eviction attempted during the sweep was refused');
    ok(!LR.lazyResidencyHeld(), 'the sweep released its hold');

    let threw = false;
    try {
        await sweepLazyFrameWindows(s3, function () { throw new Error('boom'); }, { window: 16 });
    } catch (e) { threw = true; }
    ok(threw && !LR.lazyResidencyHeld(), 'a sweep that throws still releases its hold');

    const s4 = makeSession();
    state.session = s4;
    s4.lazyLoader.isSync = true;
    let heldDuring = false;
    const origBatch = s4.lazyLoader.getFrameSync.bind(s4.lazyLoader);
    s4.lazyLoader.getFrameSync = (f) => { heldDuring = heldDuring || LR.lazyResidencyHeld(); return origBatch(f); };
    await loadAllLazyFrames();
    ok(heldDuring && !LR.lazyResidencyHeld(), 'loadAllLazyFrames holds while loading and releases after');
}

// ---------------------------------------------------------------------------
group('trimLazyResidency: no scan within budget; a bounded window as playback advances');
{
    const s = makeSession();
    state.session = s;
    await hydrate(s, 0, 30);
    eq(LR.trimLazyResidency(s, 0, { ahead: 10, behind: 5 }), null,
        `within budget (default slack ${LR.LAZY_TRIM_SLACK}) -> no scan`);

    // Simulated playback (the loader's loop: top up the lookahead, then trim)
    // over more frames than the budget, with an edited frame left behind.
    const p = makeSession();
    state.session = p;
    const opts = { ahead: 10, behind: 5, slack: 4, triangulationResults: new Map() };
    const budget = opts.ahead + opts.behind + 1 + opts.slack;
    let maxResident = 0, scans = 0, edited = null;
    for (let cur = 0; cur < N_FRAMES; cur++) {
        await batchLoadLazyFrames(cur, opts.ahead);
        if (cur === 8) {   // the user deletes a prediction on frame 8 mid-run
            const fg = p.frameGroups.get(8);
            const ul = [...fg.unlinkedInstances.values()].find(l => l.length)[0];
            fg.removeUnlinkedById(ul.id);
            edited = snapshot(p, 8);
        }
        const r = LR.trimLazyResidency(p, cur, { ...opts, keep: cur });
        if (r) scans++;
        maxResident = Math.max(maxResident, p.frameGroups.size);
    }
    ok(maxResident <= budget + 1, `resident stays within the budget + the edited frame (${maxResident} <= ${budget + 1})`);
    ok(scans > 3 && scans < N_FRAMES / 2, `the slack spaces scans out (${scans} scans over ${N_FRAMES} ticks)`);
    eq(snapshot(p, 8), edited, 'the edited frame survived the whole run, edit intact');
    ok(!p.frameGroups.has(20) && p.frameGroups.has(N_FRAMES - 1), 'played frames behind the window are gone; the current one is resident');
}

// ---------------------------------------------------------------------------
group('Paused navigation: ensureLazyFrameData bounds the window around the frame it hydrates');
{
    const NF = 4000;
    const s = makeSession(NF);
    state.session = s;
    state.isPlaying = false;
    state.trailLength = 0;
    state.triangulationResults = new Map();
    const W = LR.LAZY_NAV_WINDOW;
    // Every frame ensureLazyFrameData adds comes with 30 prefetched; a jump
    // anywhere is what scrubbing does.
    const budget = 2 * W + 1 + LR.LAZY_TRIM_SLACK;
    // An edit the scrubbing must not undo: a deleted prediction on frame 7.
    state.currentFrame = 7;
    await ensureLazyFrameData(7);
    const fg7 = s.frameGroups.get(7);
    const ul7 = [...fg7.unlinkedInstances.values()].find(l => l.length)[0];
    fg7.removeUnlinkedById(ul7.id);
    const edited = snapshot(s, 7);
    let maxResident = 0, missingOnScreen = 0;
    const jumps = [];
    for (let k = 0; k < 200; k++) jumps.push((k * 2671 + 113) % NF);   // scattered, both directions
    for (const f of jumps) {
        state.currentFrame = f;
        await ensureLazyFrameData(f);
        if (!s.frameGroups.has(f)) missingOnScreen++;
        maxResident = Math.max(maxResident, s.frameGroups.size);
    }
    ok(maxResident <= budget + 31 + 1, `resident stays bounded while scrubbing (${maxResident} <= ${budget + 31 + 1})`);
    eq(missingOnScreen, 0, 'the frame just navigated to is always resident');
    eq(snapshot(s, 7), edited, 'the edited frame survived 200 jumps, edit intact');
    // Stepping forward frame by frame keeps everything within reach resident.
    state.currentFrame = 2000;
    for (let f = 2000; f < 2400; f++) { state.currentFrame = f; await ensureLazyFrameData(f); }
    let gaps = 0;
    for (let f = 2400 - W; f <= 2400; f++) if (!s.frameGroups.has(f) && nRows('c0', f) !== null) gaps++;
    eq(gaps, 0, `stepping keeps the last ${W} frames resident (trails, stepping back)`);
    ok(s.frameGroups.size <= budget + 31 + 1, `...and the window stays bounded (${s.frameGroups.size})`);

    // While playing, a frame missed by the playback loader must not trim with
    // the paused window (the loader's window runs 600 ahead).
    const p = makeSession(NF);
    state.session = p;
    await batchLoadLazyFrames(1000, 1500);
    const before = p.frameGroups.size;
    state.isPlaying = true;
    state.currentFrame = 1000;
    await ensureLazyFrameData(3000);
    state.isPlaying = false;
    ok(p.frameGroups.size >= before, `no paused trim during playback (${before} -> ${p.frameGroups.size})`);
    // ...and a sweep in progress holds it off too.
    const release = LR.holdLazyResidency();
    state.currentFrame = 3500;
    await ensureLazyFrameData(3500);
    ok(p.frameGroups.has(1200), 'held -> no trim on navigation either');
    release();
    await ensureLazyFrameData(3600);
    ok(!p.frameGroups.has(1200), 'released -> the next navigation trims');
}

// ---------------------------------------------------------------------------
group('Members of non-resident frames give their 2D back to the store, and get it back');
{
    /** Every member's 2D on frame f, by value, keyed by camera + store row. */
    const members2d = (s, f) => (s.instanceGroups.get(f) || []).map(g =>
        [...g.instances].map(([c, m]) => `${c}#${m._rawInstIndex}:${m.type}:${Array.from(m._xy).join(',')}:${m._occ}`).sort().join(' ')).join(' | ');
    const s = await trackedSession();
    state.session = s;
    const before = new Map();
    for (const f of s.instanceGroups.keys()) before.set(f, members2d(s, f));
    // An edited member, a promoted one, one with a nulled node, and a resident frame.
    const g3 = s.instanceGroups.get(3)[0], m3 = [...g3.instances.values()][0];
    m3.setPoint(0, 1.5, 2.5); m3.modified = true;
    const g6 = s.instanceGroups.get(6)[0], m6 = [...g6.instances.values()][0]; m6.type = 'user';
    const g9 = s.instanceGroups.get(9)[0], m9 = [...g9.instances.values()][0]; m9.nulledNodes = new Set([1]);
    before.set(3, members2d(s, 3)); before.set(6, members2d(s, 6)); before.set(9, members2d(s, 9));
    for (const f of [...s.frameGroups.keys()]) if (f !== 12) s.frameGroups.delete(f);   // only frame 12 resident
    const r = LR.releaseNonResidentMembers2D(s);
    let placeholders = 0, sharedOk = 0, kept = 0;
    for (const [f, gs] of s.instanceGroups) for (const g of gs) for (const [, m] of g.instances) {
        if (m._lazy2d) { placeholders++; if (isLazyPlaceholderXY(m._xy) && m._xy === lazyPlaceholderXY(NODES)) sharedOk++; }
        else kept++;
    }
    ok(r.members > 50 && r.members === placeholders, `released members became placeholders (${r.members})`);
    eq(sharedOk, placeholders, 'every placeholder shares the one all-NaN buffer');
    ok(!m3._lazy2d && !m6._lazy2d && !m9._lazy2d, 'edited, promoted and nulled members keep their 2D');
    ok([...s.instanceGroups.get(12)].every(g => [...g.instances.values()].every(m => !m._lazy2d)), "the resident frame's members keep their 2D");
    // Writing to a placeholder must never reach the shared buffer.
    const ph = [...s.instanceGroups.get(15)[0].instances.values()][0];
    ok(ph._lazy2d, 'fixture: frame 15 member is a placeholder');
    ph.setPoint(0, 9, 9);
    ok(Number.isNaN(lazyPlaceholderXY(NODES)[0]) && !isLazyPlaceholderXY(ph._xy), 'setPoint on a placeholder copies first (shared buffer still NaN)');
    ph.releaseLazy2d();
    // Hydrating again gives every member exactly its old 2D.
    s.frameGroups.clear();
    await hydrate(s, 0, N_FRAMES);
    let same = 0, n = 0;
    for (const [f, want] of before) { n++; if (members2d(s, f) === want) same++; else console.error('    frame ' + f + ' differs'); }
    eq(same, n, 'after re-hydration every frame\'s members have exactly their old 2D (edited ones included)');
    // Eviction releases too, and a hold stops the bulk release.
    const s2 = await trackedSession();
    LR.evictLazyFramesOutside(s2, 0, 5, {});
    ok([...s2.instanceGroups.get(30)[0].instances.values()].every(m => m._lazy2d), 'evicting a frame releases its members');
    const s3 = await trackedSession();
    for (const f of [...s3.frameGroups.keys()]) s3.frameGroups.delete(f);
    const release = LR.holdLazyResidency();
    const rh = LR.releaseNonResidentMembers2D(s3);
    release();
    ok(rh.held && rh.members === 0, 'held -> no bulk release');

    // hydrateGroupMembers2D: the 2D back WITHOUT the frame becoming resident.
    const s4 = await trackedSession();
    state.session = s4;
    const want = members2d(s4, 21);
    s4.frameGroups.delete(21);
    LR.releaseFrameMembers2D(s4, 21);
    ok([...s4.instanceGroups.get(21)[0].instances.values()].every(m => m._lazy2d), 'fixture: frame 21 released');
    const nh = LR.hydrateGroupMembers2D(s4, 21);
    ok(nh > 0 && members2d(s4, 21) === want, `hydrateGroupMembers2D restores the exact 2D (${nh} members)`);
    ok(!s4.frameGroups.has(21), '...without making the frame resident');
    eq(LR.hydrateGroupMembers2D(s4, 21), 0, 'a second call has nothing to do');
}

// ---------------------------------------------------------------------------
group('lazyPlaybackLookahead: 600 for a sync loader, 5000 for a worker-backed one');
{
    eq(LR.lazyPlaybackLookahead(new SioLazyLoader()), 600, 'SioLazyLoader');
    eq(LR.lazyPlaybackLookahead({ isSync: false }), 5000, 'worker-backed');
    eq(LR.lazyPlaybackLookahead(null), 5000, 'no loader');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
