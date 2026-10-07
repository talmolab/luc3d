/**
 * test-lazy-residency.mjs — the lazy project's playback eviction
 * (pose/lazy-residency.js) and the store descriptor it trusts
 * (`SioLazyLoader.describeStoreFrame`, loading/sio-lazy-loader.js).
 *
 * The eviction drops a resident FrameGroup only when re-hydrating it from the
 * columnar store would rebuild exactly what is resident. Every way a resident
 * frame can differ from its store rows therefore has to BLOCK eviction, or a
 * user's edit silently reverts the next time the frame is shown. Each blocker
 * is tested against an untouched twin that IS evicted, so a predicate that
 * blocked everything (or nothing) fails here.
 *
 * Hydration is mirrored from pose/triangulation.js (`buildLazyFrameGroupSync`
 * + `finalizeLazyFrameGroup`): one predicted Instance per store row tagged
 * `_rawInstIndex`, then this frame's `instanceGroups` members re-seated by
 * `_rawInstIndex` and every other row sent to the unlinked pool. The real path
 * is exercised end to end by tests/e2e/lazy-playback-eviction.mjs.
 *
 * Run:  node tests/test-lazy-residency.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { Instance, FrameGroup, UnlinkedInstance, InstanceGroup } = await imp('pose/pose-data.js');
const { SioLazyLoader } = await imp('loading/sio-lazy-loader.js');
const R = await imp('pose/lazy-residency.js');
const { frameEvictionBlocker, evictLazyFrameGroups, holdLazyResidency, releaseLazyResidency,
        isLazyResidencyHeld, LAZY_PLAYBACK_AHEAD, LAZY_KEEP_BEHIND, LAZY_RESIDENT_CAP,
        LAZY_PREFETCH_MARGIN } = R;

let passed = 0, failed = 0;
function ok(cond, msg) {
    if (cond) passed++;
    else { failed++; console.error('  ✗ ' + msg); }
}
function eq(actual, expected, msg) {
    ok(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function group(name) { console.log('\n• ' + name); }

// ---------------------------------------------------------------------------
// Fixture: a columnar store per camera, 2 predicted instances per frame.
// ---------------------------------------------------------------------------
const NODES = 3;
const CAMS = ['A', 'B'];

/**
 * `spec(cam, f)` -> array of { track, type } for that camera-frame (type 1 =
 * predicted, 0 = user), or null for "no row".
 */
function makeLoader(nFrames, spec, opts = {}) {
    const loader = new SioLazyLoader();
    for (const cam of CAMS) {
        const tracks = [{ name: 't0' }, { name: 't1' }];
        const frameIdx = [], iStart = [], iEnd = [], track = [], itype = [];
        const rowMap = new Map();
        for (let f = 0; f < nFrames; f++) {
            const rows = spec(cam, f);
            if (!rows) continue;
            rowMap.set(f, frameIdx.length);
            frameIdx.push(f);
            iStart.push(track.length);
            for (const r of rows) { track.push(r.track); itype.push(r.type); }
            iEnd.push(track.length);
        }
        const instancesData = {
            track: opts.bigint ? BigInt64Array.from(track.map(BigInt)) : Float64Array.from(track),
        };
        if (!opts.noTypeColumn) instancesData.instance_type = Float64Array.from(itype);
        const store = {
            framesData: { frame_idx: Float64Array.from(frameIdx),
                          instance_id_start: Float64Array.from(iStart),
                          instance_id_end: Float64Array.from(iEnd) },
            instancesData,
            tracks,
        };
        loader.labelsByCam.set(cam, { _lazyDataStore: store, tracks });
        loader.frameRowByCam.set(cam, rowMap);
        loader.numNodesByCam.set(cam, NODES);
    }
    loader.nFrames = nFrames;
    return loader;
}

const twoPredicted = () => [{ track: 0, type: 1 }, { track: 1, type: 1 }];

function makeSession(nFrames, spec, opts) {
    return { lazyLoader: makeLoader(nFrames, spec || twoPredicted, opts),
             frameGroups: new Map(), instanceGroups: new Map() };
}

function pts(f, k) {
    const out = [];
    for (let n = 0; n < NODES; n++) out.push([f + k + n, f - k + n]);
    return out;
}

/** Mirror of buildLazyFrameGroupSync + finalizeLazyFrameGroup. */
function hydrate(session, f) {
    const fg = new FrameGroup(f);
    const groups = session.instanceGroups.get(f) || [];
    const memberAt = new Map();
    for (const g of groups) {
        for (const [cn, m] of g.instances) {
            if (m._rawInstIndex == null) continue;
            if (!memberAt.has(cn)) memberAt.set(cn, new Map());
            memberAt.get(cn).set(m._rawInstIndex, m);
        }
    }
    for (const cam of CAMS) {
        const d = session.lazyLoader.describeStoreFrame(cam, f);
        const linked = [];
        for (let k = 0; k < d.count; k++) {
            const inst = new Instance(pts(f, k), d.trackIdx[k] >= 0 ? d.trackIdx[k] : null,
                d.predicted[k] ? 'predicted' : 'user', 0.9);
            inst._rawInstIndex = k;
            const member = groups.length ? memberAt.get(cam)?.get(k) : undefined;
            if (member) linked.push(member);
            else fg.addUnlinkedInstance(cam, new UnlinkedInstance(inst, cam));
        }
        fg.instances.set(cam, linked);
    }
    session.frameGroups.set(f, fg);
    return fg;
}

/** A frame whose two A/B rows at offset 0 are grouped (as Track All leaves it). */
function groupFrame(session, f) {
    const fg = hydrate(session, f);
    const g = new InstanceGroup(1000 + f, 0);
    for (const cam of CAMS) {
        const ul = fg.getUnlinkedInstances(cam)[0];
        fg.removeUnlinkedById(ul.id);
        g.addInstance(cam, ul.instance);
        fg.addInstance(cam, ul.instance);
    }
    session.instanceGroups.set(f, [g]);
    return { fg, g };
}

const firstUnlinked = (fg, cam = 'A') => fg.getUnlinkedInstances(cam)[0];

// ---------------------------------------------------------------------------
group('describeStoreFrame mirrors what hydration would build');
{
    const L = makeLoader(10, (cam, f) => {
        if (f === 3) return null;                                  // no row at all
        if (f === 4) return [{ track: -1, type: 1 }, { track: 7, type: 1 }]; // trackless; id with no Track
        if (f === 5) return [{ track: 1, type: 0 }];               // a user row
        return twoPredicted();
    });
    const d = L.describeStoreFrame('A', 0);
    eq(d.count, 2, 'two rows');
    eq(Array.from(d.trackIdx).join(','), '0,1', 'track per row');
    eq(Array.from(d.predicted).join(','), '1,1', 'both predicted');
    eq(L.describeStoreFrame('A', 3).count, 0, 'a frame with no row has count 0');
    eq(L.describeStoreFrame('Z', 0), null, 'a camera the loader does not back is null, not "empty"');
    const d4 = L.describeStoreFrame('A', 4);
    eq(Array.from(d4.trackIdx).join(','), '-1,-1', 'trackless stays -1; an id past the track list is trackless too');
    eq(L.describeStoreFrame('A', 5).predicted[0], 0, 'instance_type 0 is a user row');

    const Lb = makeLoader(3, twoPredicted, { bigint: true });
    eq(Array.from(Lb.describeStoreFrame('B', 2).trackIdx).join(','), '0,1', 'a BigInt64Array track column reads as numbers');
    const Ln = makeLoader(3, twoPredicted, { noTypeColumn: true });
    eq(Ln.describeStoreFrame('A', 1).predicted[0], 0,
        'no instance_type column reads as type 0 (user), as the store\'s materializeFrame does');
}

// ---------------------------------------------------------------------------
group('an untouched hydrated frame is rebuildable — and each kind of edit is not');
{
    const S = makeSession(50);
    const block = (f, mutate) => {
        const fg = hydrate(S, f);
        const refs = mutate ? mutate(fg) : undefined;
        return frameEvictionBlocker(S, f, fg, refs instanceof Set ? refs : undefined);
    };
    eq(block(0), null, 'control: freshly hydrated predictions are rebuildable');
    eq(block(1, fg => { firstUnlinked(fg).instance.type = 'user'; }), 'user',
        'a user instance (the save reads its overlay from resident frames)');
    eq(block(2, fg => { firstUnlinked(fg).instance.modified = true; }), 'modified', 'modified flag');
    eq(block(3, fg => { firstUnlinked(fg).instance.backupPoints(); }), 'modified', 'an edit in progress (backup)');
    eq(block(4, fg => { firstUnlinked(fg).instance.nulledNodes = new Set([1]); }), 'modified', 'nulled nodes');
    eq(block(5, fg => { fg.removeUnlinkedById(firstUnlinked(fg).id); }), 'count',
        'a deleted prediction (only the resident frame knows)');
    eq(block(6, fg => {
        const extra = new Instance(pts(6, 9), null, 'predicted', 0.5);
        fg.addUnlinkedInstance('A', new UnlinkedInstance(extra, 'A'));
    }), 'count', 'an added instance');
    eq(block(7, fg => { firstUnlinked(fg).instance.trackIdx = 1; }), 'track',
        'a track changed in memory only');
    eq(block(8, fg => { firstUnlinked(fg).instance.trackIdx = null; }), 'track',
        'a track cleared in memory only');
    eq(block(9, fg => { firstUnlinked(fg).instance.identityId = 3; }), 'identity',
        'a trackless instance\'s identity (#201) lives only on the instance');
    eq(block(10, fg => { firstUnlinked(fg).instance.insertNodeAt(NODES); }), 'skeleton',
        'a skeleton node added to resident frames only');
    eq(block(11, fg => {
        fg.addUnlinkedInstance('EAGER', new UnlinkedInstance(new Instance(pts(11, 0), 0, 'predicted', 1), 'EAGER'));
    }), 'camera', 'data for a camera the loader does not back');
    eq(block(12, fg => { firstUnlinked(fg).instance._rawInstIndex = undefined; }), 'row', 'no store row');
    eq(block(13, fg => { fg.getUnlinkedInstances('B')[1].instance._rawInstIndex = 0; }), 'row', 'two instances claim one row');
    eq(block(14, fg => new Set([firstUnlinked(fg, 'B')])), 'ui', 'the UI holds an UnlinkedInstance');
    eq(block(15, fg => new Set([firstUnlinked(fg, 'B').instance])), 'ui', 'the UI holds an Instance');
    eq(block(16, fg => { firstUnlinked(fg).instance.type = 'reprojected'; }), 'type',
        'a type that is not what the row decodes to');

    const noApi = { ...S, lazyLoader: { labelsByCam: S.lazyLoader.labelsByCam } };
    eq(frameEvictionBlocker(noApi, 0, S.frameGroups.get(0)), 'loader',
        'a loader that cannot describe its store (worker-backed LazyFrameLoader) never evicts');
}

// ---------------------------------------------------------------------------
group('grouped frames: members survive in instanceGroups, so only the seating is checked');
{
    const S = makeSession(20);
    const { fg, g } = groupFrame(S, 0);
    eq(frameEvictionBlocker(S, 0, fg), null, 'control: a grouped, untouched frame is rebuildable');

    const b = groupFrame(S, 1);
    b.g.instances.get('A').trackIdx = 1;   // a member's own fields are not compared...
    eq(frameEvictionBlocker(S, 1, b.fg), null, '...because the member object comes back as itself');

    const c = groupFrame(S, 2);
    c.g.instances.get('B').type = 'user';
    eq(frameEvictionBlocker(S, 2, c.fg), 'user', 'a user member pins its frame (save overlay)');

    const d = groupFrame(S, 3);
    S.instanceGroups.delete(3);           // linked instances that no group claims
    eq(frameEvictionBlocker(S, 3, d.fg), 'grouping', 'a linked non-member would come back unlinked');

    const e = hydrate(S, 4);              // unlinked, but a group claims its row
    const g4 = new InstanceGroup(4004, 0);
    const claimed = new Instance(pts(4, 0), 0, 'predicted', 0.9);
    claimed._rawInstIndex = 0;
    g4.addInstance('A', claimed);
    S.instanceGroups.set(4, [g4]);
    eq(frameEvictionBlocker(S, 4, e), 'grouping', 'an unlinked row a group claims would come back linked');

    eq(frameEvictionBlocker(S, 0, fg, new Set([g])), 'ui', 'the selected / edit-group group pins its frame');
}

// ---------------------------------------------------------------------------
group('evictLazyFrameGroups: cap, windows, blockers, hold');
{
    const S = makeSession(5000);
    for (let f = 0; f < 3000; f++) hydrate(S, f);
    firstUnlinked(S.frameGroups.get(10)).instance.type = 'user';          // far away, edited
    S.frameGroups.get(20).removeUnlinkedById(firstUnlinked(S.frameGroups.get(20)).id);

    eq(evictLazyFrameGroups(S, { anchors: [2500], cap: 3000 }), null, 'at the cap nothing runs');
    eq(S.frameGroups.size, 3000, '...and nothing is dropped');

    holdLazyResidency(); holdLazyResidency();
    ok(isLazyResidencyHeld(), 'held');
    eq(evictLazyFrameGroups(S, { anchors: [2500], cap: 10 }), null, 'held: nothing runs');
    releaseLazyResidency();
    eq(evictLazyFrameGroups(S, { anchors: [2500], cap: 10 }), null, 'holds nest: one release is not enough');
    releaseLazyResidency();
    ok(!isLazyResidencyHeld(), 'released');

    const rep = evictLazyFrameGroups(S, { anchors: [2500, 2600], ahead: 100, behind: 200, cap: 10 });
    // protected: [2400-200, 2500+100] ∪ [2500-200, 2600+100] = [2300, 2700], inclusive = 401 frames.
    eq(rep.protected, 401, 'frames inside either window are protected');
    eq(rep.blocked.user, 1, 'the user-edited frame is reported blocked');
    eq(rep.blocked.count, 1, 'the deleted-prediction frame is reported blocked');
    eq(rep.evicted, 3000 - 401 - 2, 'everything else is evicted');
    eq(S.frameGroups.size, 403, 'resident = protected + blocked');
    ok(S.frameGroups.has(10) && S.frameGroups.has(20), 'the two edited frames are still resident');
    ok(S.frameGroups.has(2300) && S.frameGroups.has(2700) && !S.frameGroups.has(2299) && !S.frameGroups.has(2701),
        'window edges are inclusive: [anchor - behind, anchor + ahead]');
}

// ---------------------------------------------------------------------------
group('an evicted frame drops its derived reprojections; a kept one does not');
{
    const S = makeSession(100);
    const tri = new Map();
    const far = groupFrame(S, 0), near = groupFrame(S, 90), held = groupFrame(S, 1);
    held.g.instances.get('A').type = 'user';
    for (const x of [far, near, held]) {
        x.g.reprojections = { A: pts(0, 0) };
        x.g.addReprojectedInstance('A', new Instance(pts(0, 0), 0, 'reprojected', 1));
        tri.set(x.fg.frameIdx, [{ group: x.g }]);
    }
    evictLazyFrameGroups(S, { anchors: [90], ahead: 5, behind: 5, triangulationResults: tri });
    ok(!S.frameGroups.has(0), 'far frame evicted');
    eq(far.g.reprojections, null, 'its reprojections are dropped');
    eq(far.g.reprojectedInstances.size, 0, 'its reprojected instances are dropped');
    ok(!tri.has(0), 'its triangulationResults entry is dropped');
    ok(S.instanceGroups.get(0)[0] === far.g, 'its group (and 3D) stays — instanceGroups is never evicted');
    ok(near.g.reprojections && tri.has(90), 'a protected frame keeps its caches');
    ok(held.g.reprojections && tri.has(1), 'a blocked frame keeps its caches');
}

// ---------------------------------------------------------------------------
group('evict -> re-hydrate rebuilds the same frame');
{
    const S = makeSession(50);
    const { g } = groupFrame(S, 7);
    const before = S.frameGroups.get(7);
    const shape = (fg) => CAMS.map(c => [
        fg.getInstances(c).map(i => i._rawInstIndex).join(','),
        fg.getUnlinkedInstances(c).map(u => `${u.instance._rawInstIndex}:${u.instance.trackIdx}:${u.instance.type}:${u.instance.toPointsArray().flat().join(' ')}`).join('|'),
    ].join('/')).join(';');
    const shapeBefore = shape(before);
    evictLazyFrameGroups(S, { anchors: [40], ahead: 1, behind: 1 });
    ok(!S.frameGroups.has(7), 'evicted');
    const after = hydrate(S, 7);
    eq(shape(after), shapeBefore, 'same rows, same seating, same unlinked content');
    ok(after.getInstances('A')[0] === g.instances.get('A') && after.getInstances('B')[0] === g.instances.get('B'),
        'the group members come back as the SAME objects');
}

// ---------------------------------------------------------------------------
group('simulated playback stays under the cap; edits survive');
{
    const N = 20000;
    const S = makeSession(N);
    hydrate(S, 5);
    firstUnlinked(S.frameGroups.get(5)).instance.modified = true;
    let max = 0;
    // The playback loader: top up [cur, cur + AHEAD), then evict around cur.
    for (let cur = 0; cur < N; cur += 6) {
        for (let f = cur; f < Math.min(N, cur + LAZY_PLAYBACK_AHEAD); f++) if (!S.frameGroups.has(f)) hydrate(S, f);
        max = Math.max(max, S.frameGroups.size);
        evictLazyFrameGroups(S, { anchors: [cur], cap: LAZY_RESIDENT_CAP });
    }
    ok(max <= LAZY_RESIDENT_CAP + 6, `resident never exceeds the cap plus one top-up (max ${max})`);
    ok(S.frameGroups.has(5) && firstUnlinked(S.frameGroups.get(5)).instance.modified,
        'the edited frame played past 20,000 frames ago is still resident, edit intact');
}

// ---------------------------------------------------------------------------
group('the constants agree with the code they protect');
{
    // Protected ahead covers the playback loader AND ensureLazyFrameData's
    // 30-frame scrub prefetch, or a pass drops what was just loaded.
    const tri = fs.readFileSync(path.join(ROOT, 'pose', 'triangulation.js'), 'utf8');
    const m = /for \(var pfi = 1; pfi <= (\d+); pfi\+\+\)/.exec(tri);
    ok(m && LAZY_PREFETCH_MARGIN >= Number(m[1]), `prefetch margin covers the scrub prefetch (${m && m[1]} frames)`);
    // Node trails draw only RESIDENT past frames; the export allows up to 500.
    const ovl = fs.readFileSync(path.join(ROOT, 'ui', 'overlay-export-modal.js'), 'utf8');
    const t = /'trailLength', 0, (\d+)/.exec(ovl);
    ok(t && LAZY_KEEP_BEHIND > Number(t[1]), `keep-behind covers the longest node trail (${t && t[1]})`);
    // A cap at or under the protected window would run a pass on every
    // hydration that can evict nothing.
    ok(LAZY_RESIDENT_CAP > LAZY_PLAYBACK_AHEAD + LAZY_PREFETCH_MARGIN + LAZY_KEEP_BEHIND + 1,
        'the cap leaves room above one protected window');
    // The playback loader's lookahead IS the protected ahead window.
    const wiring = fs.readFileSync(path.join(ROOT, 'ui', 'ui-wiring.js'), 'utf8');
    ok(!/batchLoadLazyFrames\([^)]*5000\)/.test(wiring), 'no 5000-frame playback lookahead is left');
    ok((wiring.match(/batchLoadLazyFrames\([^)]*LAZY_PLAYBACK_AHEAD\)/g) || []).length === 3,
        'Play, Space and the background loader all use LAZY_PLAYBACK_AHEAD');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
