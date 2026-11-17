/**
 * test-timeline-track-segments.mjs — the timeline's track rows
 * (`Timeline._buildTrackSegments`, ui/timeline.js) against a plain reference.
 *
 * The build runs after every whole-project run (Track All, Triangulate All,
 * ...). On the 8-camera, 108,000-frame project (539,852 groups) it used to take
 * ~0.6 s plus ~0.4 s of GC in one task: a max-track scan over every member that
 * nothing used, a string key and a Set entry per member, and one segment object
 * per frame when merging with lazy occupancy. It now collects each (camera,
 * track)'s frames in a typed buffer. These checks pin the rows it builds:
 *
 *   1. random sessions (shuffled frame order, repeated frames, null /
 *      undefined / negative tracks, cameras without a video, a repeated
 *      camera name, dense and sparse
 *      occupancy minus resident frames, > 32 tracks per camera, "No ID"
 *      track) give exactly the rows of the reference below, which uses one
 *      Set of frames per (camera, track) and nothing clever;
 *   2. `_mergeSegmentLists` is the union of two run lists, coalesced;
 *   3. a project-sized session (540k groups x 8 cameras) builds one run per
 *      row;
 *   4. each group member is read once (the old build walked them twice);
 *   5. the Identities rows (`_buildIdentitySegments`, ~1.5 s on that project
 *      when it went through `frameIdentityEntries()` with a string key and a
 *      Set entry per detection) equal a plain reference on random sessions,
 *      and `Session.forEachFrameIdentity` visits exactly the records of
 *      `frameIdentityEntries()`, in order.
 *
 * Run:  node tests/test-timeline-track-segments.mjs
 */
import { Timeline, rowBuildTuning } from '../ui/timeline.js';
import { getTrackColor, NULL_ID_COLOR } from '../ui/overlays.js';
import { Session, Camera, Skeleton } from '../pose/pose-data.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
    if (cond) { passed++; }
    else { failed++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function group(name) { console.log('\n• ' + name); }

const CAP = 32;
function makeTimeline() {
    const tl = Object.create(Timeline.prototype);
    tl.MAX_TRACK_ROWS_PER_CAMERA = CAP;
    tl._getColorByIdentity = () => false;
    return tl;
}

let seed = 12345;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
const ri = (n) => Math.floor(rnd() * n);

// ---------------------------------------------------------------------------
// Reference: one Set of frames per (camera, track), occupancy expanded to
// frames, then maximal runs. Same rules as the timeline: a member counts when
// its trackIdx is a number >= 0; occupancy skips resident (frameGroups)
// frames; rows by camera, tracks ascending; at most CAP rows per camera (the
// earliest-appearing, ties by track), then "+N more"; an empty camera gets a
// placeholder row. Occupancy-only rows keep occupancy's own runs (they are
// maximal already, as the loader builds them).
// ---------------------------------------------------------------------------
function runsOf(frames) {
    const sorted = [...frames].sort((a, b) => a - b);
    const out = [];
    for (const f of sorted) {
        const last = out[out.length - 1];
        if (last && f === last.end + 1) last.end = f;
        else out.push({ start: f, end: f });
    }
    return out;
}
function referenceRows(session) {
    let cams = (session.cameras || []).map(c => c.name);
    if (Array.isArray(session._uploadedCameras)) cams = cams.filter(n => session._uploadedCameras.includes(n));
    const rows = [];
    const resident = new Set(session.frameGroups.keys());
    const isTrack = (t) => typeof t === 'number' && t >= 0;
    for (const cam of cams) {
        const frames = new Map();   // track -> Set<frame>
        const occOnly = new Map();  // track -> occupancy runs
        const add = (t, f) => { if (!frames.has(t)) frames.set(t, new Set()); frames.get(t).add(f); };
        const occ = session.trackOccupancy && session.trackOccupancy.get(cam);
        if (occ && occ.sparse) {
            for (const [t, segs] of occ.segments) {
                const fs = [];
                for (const sg of segs) for (let f = sg.start; f <= sg.end; f++) if (!resident.has(f)) fs.push(f);
                if (fs.length) occOnly.set(t, fs);
            }
        } else if (occ) {
            for (let t = 0; t < occ.nTracks; t++) {
                const fs = [];
                for (let f = 0; f < occ.nFrames; f++) if (occ.data[f * occ.nTracks + t] && !resident.has(f)) fs.push(f);
                if (fs.length) occOnly.set(t, fs);
            }
        }
        for (const [f, groups] of session.instanceGroups || []) {
            for (const g of groups) {
                const m = g.instances.get(cam);
                if (m && isTrack(m.trackIdx)) add(m.trackIdx, f);
            }
        }
        for (const [f, fg] of session.frameGroups) {
            for (const inst of fg.instances.get(cam) || []) if (isTrack(inst.trackIdx)) add(inst.trackIdx, f);
            for (const ul of fg.unlinkedInstances.get(cam) || []) if (isTrack(ul.instance.trackIdx)) add(ul.instance.trackIdx, f);
        }
        const tracks = [...new Set([...frames.keys(), ...occOnly.keys()])].sort((a, b) => a - b);
        let cand = tracks.map(t => {
            let segments;
            if (!frames.has(t)) segments = runsOf(occOnly.get(t));
            else segments = runsOf(new Set([...frames.get(t), ...(occOnly.get(t) || [])]));
            return { t, segments, first: segments[0].start };
        });
        let hidden = 0;
        if (cand.length > CAP) {
            const keep = new Set(cand.slice().sort((a, b) => (a.first - b.first) || (a.t - b.t)).slice(0, CAP).map(c => c.t));
            hidden = cand.length - keep.size;
            cand = cand.filter(c => keep.has(c.t));
        }
        const before = rows.length;
        for (const c of cand) {
            const noId = !!(session.isNoIdTrack && session.isNoIdTrack(c.t));
            rows.push({ trackIdx: c.t, cameraName: cam, color: noId ? NULL_ID_COLOR : getTrackColor(c.t, false),
                segments: c.segments, trackName: session.tracks[c.t] || ('track_' + c.t), treeRole: 'middle',
                _isTrack: true, _trackColored: !noId });
        }
        if (hidden > 0) rows.push({ trackIdx: -1, cameraName: cam, color: null, segments: [],
            trackName: '+' + hidden + ' more', treeRole: 'middle', _isTrack: true, _isMoreIndicator: true });
        if (rows.length === before) rows.push({ trackIdx: -1, cameraName: cam, color: null, segments: [],
            trackName: '', treeRole: 'empty', _isTrack: true });
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Random sessions
// ---------------------------------------------------------------------------
const inst = (t) => ({ trackIdx: t });
function randomSession(manyTracks) {
    const cams = ['c0', 'c1', 'c2', 'c3'].slice(0, 1 + ri(4));
    let allCams = rnd() < 0.3 ? cams.concat(['noVideo']) : cams;
    if (rnd() < 0.1) allCams = allCams.concat([cams[0]]);         // a repeated camera name
    const nF = 40 + ri(250), nT = 1 + ri(manyTracks ? 60 : 6);
    const trackVal = () => { const r = rnd(); return r < 0.05 ? null : r < 0.08 ? undefined : r < 0.11 ? -1 : ri(nT); };
    const s = {
        cameras: allCams.map(name => ({ name })),
        tracks: Array.from({ length: ri(nT + 1) }, (_, i) => 'trk' + i),
        instanceGroups: new Map(), frameGroups: new Map(),
        isNoIdTrack: (t) => t === 2,
    };
    if (rnd() < 0.3) s._uploadedCameras = cams.filter(() => rnd() < 0.8);
    const frames = Array.from({ length: nF }, (_, i) => i).filter(() => rnd() < 0.6);
    if (rnd() < 0.5) frames.sort(() => rnd() - 0.5);          // groups out of frame order
    for (const f of frames) {
        const gs = [];
        for (let g = 0, ng = ri(4); g < ng; g++) {
            const m = new Map();
            for (const c of allCams) if (rnd() < 0.7) m.set(c, inst(trackVal()));
            gs.push({ instances: m });
        }
        s.instanceGroups.set(f, gs);
    }
    for (let k = 0, n = ri(30); k < n; k++) {                 // resident frames
        const fg = { instances: new Map(), unlinkedInstances: new Map() };
        for (const c of allCams) {
            if (rnd() < 0.7) fg.instances.set(c, Array.from({ length: ri(3) }, () => inst(trackVal())));
            if (rnd() < 0.5) fg.unlinkedInstances.set(c, Array.from({ length: ri(3) }, () => ({ instance: inst(trackVal()) })));
        }
        s.frameGroups.set(ri(nF), fg);
    }
    if (rnd() < 0.6) {
        s.trackOccupancy = new Map();
        for (const c of allCams) {
            if (rnd() < 0.3) continue;
            if (rnd() < 0.5) {
                const data = new Uint8Array(nF * nT);
                for (let i = 0; i < data.length; i++) data[i] = rnd() < 0.5 ? 1 : 0;
                s.trackOccupancy.set(c, { nTracks: nT, nFrames: nF, data });
            } else {
                const segments = new Map();
                for (let t = 0; t < nT; t++) {
                    if (rnd() < 0.3) continue;
                    const runs = [];
                    for (let f = ri(10); f < nF;) {
                        const e = Math.min(nF - 1, f + ri(20));
                        runs.push({ start: f, end: e });
                        f = e + 2 + ri(10);                            // a gap, as the loader's runs
                    }
                    segments.set(t, runs);
                }
                s.trackOccupancy.set(c, { sparse: true, nTracks: nT, nFrames: nF, segments });
            }
        }
    }
    return s;
}

group('1. random sessions: rows equal the reference');
{
    let bad = 0, first = null;
    for (let it = 0; it < 1500; it++) {
        const s = randomSession(it % 4 === 0);
        const tl = makeTimeline();
        tl._buildTrackSegments(s);
        const got = JSON.stringify(tl._trackSegments), want = JSON.stringify(referenceRows(s));
        if (got !== want) { bad++; if (!first) first = { it, got: got.slice(0, 400), want: want.slice(0, 400) }; }
        if (tl._trackNames.length !== tl._trackSegments.length) bad++;
    }
    if (first) console.error('    first mismatch', first);
    ok(bad === 0, `1,500 random sessions build the reference rows (${bad} differ)`);
}
{
    const tl = makeTimeline();
    tl._buildTrackSegments({ cameras: [], tracks: ['a'], instanceGroups: new Map([[0, [{ instances: new Map([['x', inst(0)]]) }]]]), frameGroups: new Map() });
    ok(tl._trackSegments.length === 0 && tl._trackNames.length === 0, 'no cameras: no rows');
}

group('2. _mergeSegmentLists');
{
    const tl = makeTimeline();
    const m = (a, b) => JSON.stringify(tl._mergeSegmentLists(a, b));
    ok(m([], []) === '[]', 'empty + empty');
    ok(m([{ start: 0, end: 4 }], []) === '[{"start":0,"end":4}]', 'one side empty');
    ok(m([{ start: 0, end: 4 }], [{ start: 5, end: 5 }]) === '[{"start":0,"end":5}]', 'adjacent runs coalesce');
    ok(m([{ start: 0, end: 4 }, { start: 10, end: 12 }], [{ start: 3, end: 11 }]) === '[{"start":0,"end":12}]', 'a run bridging two');
    ok(m([{ start: 7, end: 9 }], [{ start: 0, end: 1 }, { start: 20, end: 20 }]) ===
        '[{"start":0,"end":1},{"start":7,"end":9},{"start":20,"end":20}]', 'disjoint runs stay in order');
    const a = [{ start: 0, end: 4 }];
    tl._mergeSegmentLists(a, [{ start: 5, end: 8 }]);
    ok(a[0].end === 4, 'inputs are not modified');
}

group('3. project-sized session (540k groups x 8 cameras, lazy occupancy)');
{
    const cams = Array.from({ length: 8 }, (_, i) => 'Cam' + i);
    const s = { cameras: cams.map(name => ({ name })), tracks: ['a', 'b', 'c', 'd', 'e'],
        instanceGroups: new Map(), frameGroups: new Map(), trackOccupancy: new Map() };
    const NF = 108000;
    for (let f = 0; f < NF; f++) {
        const gs = [];
        for (let g = 0; g < 5; g++) {
            const m = new Map();
            for (const c of cams) m.set(c, inst((g + (f >> 12)) % 5));
            gs.push({ instances: m });
        }
        s.instanceGroups.set(f, gs);
    }
    for (let f = 3000; f < 5000; f++) {
        const fg = { instances: new Map(), unlinkedInstances: new Map() };
        for (const c of cams) fg.instances.set(c, [0, 1, 2, 3, 4].map(inst));
        s.frameGroups.set(f, fg);
    }
    for (const c of cams) {
        const segments = new Map();
        for (let t = 0; t < 5; t++) segments.set(t, [{ start: 0, end: 49999 }, { start: 60000, end: NF - 1 }]);
        s.trackOccupancy.set(c, { sparse: true, nTracks: 5, nFrames: NF, segments });
    }
    const tl = makeTimeline();
    const t0 = performance.now();
    tl._buildTrackSegments(s);
    const ms = performance.now() - t0;
    console.log(`    built ${tl._trackSegments.length} rows in ${ms.toFixed(0)} ms`);
    // The reference expands occupancy into frames: compare per row instead of
    // building it on the whole project (the rows are runs over 0..NF-1).
    let same = tl._trackSegments.length === 40;
    for (const row of tl._trackSegments) {
        if (row.segments.length !== 1 || row.segments[0].start !== 0 || row.segments[0].end !== NF - 1) same = false;
    }
    ok(same, 'every (camera, track) row covers 0..107,999 in one run');
}

group('4. one pass over the groups');
{
    // The old build walked every group member twice (a max-track scan whose
    // result nothing used, then the real pass). Count trackIdx reads.
    let reads = 0;
    const counted = (t) => { const o = {}; Object.defineProperty(o, 'trackIdx', { get() { reads++; return t; } }); return o; };
    const s = { cameras: [{ name: 'a' }, { name: 'b' }], tracks: ['x', 'y'], instanceGroups: new Map(), frameGroups: new Map() };
    let members = 0;
    for (let f = 0; f < 100; f++) {
        s.instanceGroups.set(f, [0, 1].map(t => ({ instances: new Map([['a', counted(t)], ['b', counted(t)]]) })));
        members += 4;
    }
    makeTimeline()._buildTrackSegments(s);
    ok(reads === members, `each member's trackIdx read once (${reads} reads, ${members} members)`);
}

// ---------------------------------------------------------------------------
// 5. Identities rows
// ---------------------------------------------------------------------------
const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
function identitySession() {
    const names = ['c0', 'c1', 'c2', 'c3'].slice(0, 1 + ri(4));
    const cams = names.map(n => new Camera(n, K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 40], [640, 480]));
    const s = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0', 't1', 't2', 't3'], 'X');
    const nId = ri(5);
    for (let i = 0; i < nId; i++) s.addIdentity('id' + i);
    if (rnd() < 0.3) s._uploadedCameras = names.filter(() => rnd() < 0.8);
    const nF = 50 + ri(200);
    for (let k = 0; k < 400; k++) {
        const r = rnd();
        s.setFrameIdentity(ri(nF), names[ri(names.length)], ri(4) - (rnd() < 0.1 ? 1 : 0),
            r < 0.15 ? -1 : r < 0.18 ? 99 : ri(Math.max(1, nId)));
    }
    for (let k = 0; k < 20; k++) s.frameIdentityMap.delete(s.frameIdentityMap.keys().next().value);
    if (rnd() < 0.3) s.frameIdentityMap.set('7:camX:2', 0);              // legacy keys
    if (rnd() < 0.3) s.frameIdentityMap.set('8:' + names[0] + ':1', 0);
    for (let k = 0, n = ri(20); k < n; k++) {
        const fg = { instances: new Map(), unlinkedInstances: new Map() };
        for (const c of names) {
            if (rnd() < 0.7) fg.instances.set(c, Array.from({ length: ri(3) }, () => ({ trackIdx: ri(4) })));
            if (rnd() < 0.5) fg.unlinkedInstances.set(c, Array.from({ length: ri(2) }, () => ({ instance: {
                trackIdx: rnd() < 0.3 ? null : ri(4), identityId: rnd() < 0.5 ? ri(Math.max(1, nId)) : undefined } })));
        }
        s.frameGroups.set(ri(nF), fg);
    }
    return s;
}
function referenceIdentityRows(s) {
    let cams = s.cameras.map(c => c.name);
    if (Array.isArray(s._uploadedCameras)) cams = cams.filter(n => s._uploadedCameras.includes(n));
    const frames = new Map();   // "id|cam" or "noid|cam" -> Set
    const add = (k, f) => { if (!frames.has(k)) frames.set(k, new Set()); frames.get(k).add(f); };
    if (s.identities.length) {
        for (const [f, fg] of s.frameGroups) {
            for (const [cam, insts] of fg.instances) for (const inst of insts) {
                const id = s.getIdentityIdForTrack(cam, inst.trackIdx, f);
                if (id == null) { if (s.isExplicitNoIdentity(cam, inst.trackIdx, f)) add('noid|' + cam, f); }
                else add(id + '|' + cam, f);
            }
            for (const [cam, uls] of fg.unlinkedInstances) for (const ul of uls) {
                const id = s.getIdentityIdForUnlinkedInstance(cam, ul.instance, f);
                if (id == null) { if (s.isExplicitNoIdentity(cam, ul.instance.trackIdx, f)) add('noid|' + cam, f); }
                else add(id + '|' + cam, f);
            }
        }
        for (const rec of s.frameIdentityEntries()) {
            if (s.frameGroups.has(rec.frameIdx)) continue;
            add((rec.identityId < 0 ? 'noid' : rec.identityId) + '|' + rec.camName, rec.frameIdx);
        }
    }
    const rows = [];
    for (const cam of cams) {
        const before = rows.length;
        for (const ident of s.identities) {
            const fs = frames.get(ident.id + '|' + cam);
            if (fs) rows.push({ trackIdx: ident.id, cameraName: cam, color: ident.color || '#667eea', segments: runsOf(fs),
                trackName: ident.name, treeRole: 'middle', _isIdentity: true });
        }
        const nf = frames.get('noid|' + cam);
        if (nf) rows.push({ trackIdx: -1, cameraName: cam, color: NULL_ID_COLOR, segments: runsOf(nf), trackName: 'No ID',
            treeRole: 'middle', _isIdentity: true, _isNoId: true });
        if (rows.length === before) rows.push({ trackIdx: -1, cameraName: cam, color: null, segments: [], trackName: '',
            treeRole: 'empty', _isIdentity: true });
    }
    return rows;
}

group('5. Identities rows equal the reference; forEachFrameIdentity = frameIdentityEntries');
{
    let bad = 0, badVisit = 0, first = null;
    for (let it = 0; it < 800; it++) {
        const s = identitySession();
        const tl = makeTimeline();
        tl._buildIdentitySegments(s);
        const got = JSON.stringify(tl._trackSegments), want = JSON.stringify(referenceIdentityRows(s));
        if (got !== want) { bad++; if (!first) first = { it, got: got.slice(0, 400), want: want.slice(0, 400) }; }
        const viaEntries = [...s.frameIdentityEntries()].map(r => [r.frameIdx, r.camName, r.trackIdx, r.identityId]);
        const viaVisit = [];
        s.forEachFrameIdentity((f, c, t, id) => viaVisit.push([f, c, t, id]));
        if (JSON.stringify(viaEntries) !== JSON.stringify(viaVisit)) badVisit++;
    }
    if (first) console.error('    first mismatch', first);
    ok(bad === 0, `800 random sessions build the reference Identities rows (${bad} differ)`);
    ok(badVisit === 0, `forEachFrameIdentity visits the frameIdentityEntries records in order (${badVisit} differ)`);
}

group('6. rows built in slices (a pause at every chance) = rows built at once');
{
    // The background build of a collapsed timeline (Timeline._startBackgroundRows)
    // runs the same steps with pauses between them.
    const saved = Object.assign({}, rowBuildTuning);
    rowBuildTuning.frames = 1; rowBuildTuning.fimStretch = 3;
    const always = { due: () => true };
    const run = (steps) => { let pauses = 0; while (!steps.next().done) pauses++; return pauses; };
    let badT = 0, badI = 0, pausesT = 0, pausesI = 0, badScan = 0;
    for (let it = 0; it < 300; it++) {
        const s = randomSession(it % 4 === 0);
        const a = makeTimeline(), b = makeTimeline();
        a._buildTrackSegments(s);
        pausesT += run(b._trackSegmentSteps(s, always));
        if (JSON.stringify(a._trackSegments) !== JSON.stringify(b._trackSegments) || JSON.stringify(a._trackNames) !== JSON.stringify(b._trackNames)) badT++;
    }
    for (let it = 0; it < 300; it++) {
        const s = identitySession();
        const a = makeTimeline(), b = makeTimeline();
        a._buildIdentitySegments(s);
        pausesI += run(b._identitySegmentSteps(s, always));
        if (JSON.stringify(a._trackSegments) !== JSON.stringify(b._trackSegments)) badI++;
        // the identity walk in stretches visits what one walk visits, in order
        const whole = [], parts = [];
        s.forEachFrameIdentity((f, c, t, id) => whole.push([f, c, t, id]));
        const scan = s.frameIdentityScan();
        for (let at = 0; at < scan.span; ) at = s.forEachFrameIdentity((f, c, t, id) => parts.push([f, c, t, id]), at, Math.min(scan.span, at + 2));
        if (JSON.stringify(whole) !== JSON.stringify(parts)) badScan++;
    }
    Object.assign(rowBuildTuning, saved);
    ok(pausesT > 0 && badT === 0, `Tracks rows: the same in 300 random sessions (${badT} differ; ${pausesT} pauses)`);
    ok(pausesI > 0 && badI === 0, `Identities rows: the same in 300 random sessions (${badI} differ; ${pausesI} pauses)`);
    ok(badScan === 0, `forEachFrameIdentity in stretches of 2 = one walk (${badScan} differ)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.error('  - ' + f); process.exit(1); }
