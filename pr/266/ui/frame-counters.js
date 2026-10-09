// ui/frame-counters.js — pure, DOM-free logic behind the status bar's
// "Labeled Frames", "Instances" and "Triangulated" counters. The DOM half
// (which camera is active, when to recount, writing the text) is
// `updateFrameCounters` in ui/rendering.js.
//
// This module imports NO project modules — it only reads the Session it is
// handed — so a Node test can drive it with real `pose/pose-data.js` objects
// and a real `SioLazyLoader`. Same contract as ui/custom-delete-ops.js.
//
// ## Why the counters cannot just walk `session.frameGroups`
//
// On a lazy project `frameGroups` is the RESIDENT window: the frames hydrated
// for display, a few thousand of a 108,000-frame project. Counting it gave
// "Labeled Frames: 5789" and "Triangulated: 5789" on a project whose every frame
// had just been triangulated. That is the resident-only bug class of #194/#195.
// So a count is split in two:
//
//   - RESIDENT frames are counted live from their FrameGroup, exactly as before.
//     They are what is on screen, they carry in-memory edits the store does not
//     know about, and the current frame is always one of them, so an edit shows
//     up in the count immediately.
//   - Every OTHER frame comes from a whole-project BASELINE: one value per frame,
//     computed from the columnar store plus `session.instanceGroups` (which, unlike
//     `frameGroups`, covers every frame) without hydrating anything. It is what the
//     frame would count as if it were visited now, because it mirrors
//     `finalizeLazyFrameGroup` (pose/triangulation.js): a store row whose in-frame
//     offset is some group member's `_rawInstIndex` is that member (with the
//     member's type), and every other row is ungrouped (with the store's type).
//
// The baseline is per-FRAME rather than a single total so that the resident
// frames can be taken back out of it: `total - sum(baseline over resident) +
// sum(live over resident)`. That is O(resident) per call, the same cost as the
// old resident-only count, and it is exact whatever the resident set happens to
// be — scrubbing hydrates and evicts frames without the baseline being touched.
//
// "Triangulated" needs no store: `instanceGroups` is the whole project, so its
// baseline is just "has 3D" per frame — which also counts a frame that has 3D
// but no 2D FrameGroup, something the old loop never reached on any project.
//
// Building a baseline is a whole-project walk (~100 ms at 108,000 frames, nearly
// all of it touching each frame's groups), so it must not run per frame, and the
// builder is RESUMABLE (`createFrameCounterBaselineBuilder`) so the caller can
// spread it over short tasks. When to rebuild is the caller's decision (see
// `updateFrameCounters`).

/**
 * One frame of one camera, from a RESIDENT FrameGroup. The rules are the
 * status bar's: a frame is labeled in `cam` if it holds a user instance
 * (grouped or not) or a GROUPED prediction; an ungrouped prediction is raw
 * tracker output and does not count. "Instances" counts user instances only.
 *
 * @param {Object} fg - FrameGroup
 * @param {string} cam
 * @returns {number} -1 if the frame is not labeled in `cam`, otherwise the
 *   number of user instances (0 = labeled only by a grouped prediction).
 *   Encoded in one number so the per-frame loop allocates nothing.
 */
export function residentFrameUserCount(fg, cam) {
    var labeled = false;
    var users = 0;
    var linked = fg.instances.get(cam);
    if (linked) {
        for (var i = 0; i < linked.length; i++) {
            var t = linked[i].type || 'user';
            if (t === 'user') { labeled = true; users++; }
            else if (t === 'predicted') labeled = true;
        }
    }
    var unlinked = fg.getUnlinkedInstances(cam);
    for (var u = 0; u < unlinked.length; u++) {
        if ((unlinked[u].instance.type || 'user') === 'user') { labeled = true; users++; }
    }
    return labeled ? users : -1;
}

/**
 * "Triangulated" means the frame has at least one InstanceGroup carrying 3D.
 * @param {Array|undefined} groups - `session.instanceGroups.get(frameIdx)`
 * @returns {boolean}
 */
export function groupsHaveTriangulation(groups) {
    if (!groups) return false;
    for (var g = 0; g < groups.length; g++) {
        if (groups[g].points3d) return true;
    }
    return false;
}

/**
 * Resolve ONE frame of one camera from the store, as hydration would: a row
 * whose offset is some group member's `_rawInstIndex` is that member (and has
 * the member's type); every other row is ungrouped (and has the store's type).
 * `rowType`/`memberType` are scratch arrays reused across frames.
 *
 * @returns {number} `residentFrameUserCount`'s encoding (-1 = not labeled).
 */
function storeFrameUserCount(session, cam, frameIdx, nRows, rowType, memberType) {
    for (var o = 0; o < nRows; o++) memberType[o] = undefined;
    var groups = session.instanceGroups.get(frameIdx);
    if (groups) {
        for (var gi = 0; gi < groups.length; gi++) {
            var m = groups[gi].instances.get(cam);
            if (!m || m._rawInstIndex == null) continue;
            // A member past the frame's last row has no 2D to hydrate from, and
            // `finalizeLazyFrameGroup` drops it, so it counts for nothing.
            if (m._rawInstIndex >= 0 && m._rawInstIndex < nRows) {
                memberType[m._rawInstIndex] = m.type || 'user';
            }
        }
    }
    var labeled = false;
    var users = 0;
    for (var r = 0; r < nRows; r++) {
        var mt = memberType[r];
        if (mt !== undefined) {
            if (mt === 'user') { labeled = true; users++; }
            else if (mt === 'predicted') labeled = true;
        } else if (rowType[r] === 'user') {
            labeled = true; users++;
        }
    }
    return labeled ? users : -1;
}

// Work per `step()` when the caller does not say: frames for the camera half,
// `instanceGroups` entries for the 3D half. A step costs a few ms on a real
// project — the camera half is memory-latency bound, ~0.5 us a frame, because
// every frame touches its groups' per-camera maps.
var DEFAULT_STEP = 8192;

/**
 * A whole-project baseline, built in resumable steps so the caller can spread
 * it over several short tasks. On a 108,000-frame x 8-camera project a full
 * build is on the order of 100 ms — too long to block the page for — and
 * nearly all of it is touching each frame's groups, which no reordering avoids.
 *
 * Two halves:
 *   - `tri`: per-frame "has 3D" over the WHOLE project. `session.instanceGroups`
 *     is never windowed — a lazy reopen restores every frame's groups and
 *     nothing evicts them — so this needs no store.
 *   - the camera half, for `cam`: per-frame labeled / user-instance values from
 *     the columnar store via `lazyLoader.forEachInstanceRow`, no frame hydrated
 *     (see `storeFrameUserCount`). `null` when the project is not lazy or its
 *     loader cannot enumerate rows (the worker-backed analysis-`.h5` loader):
 *     every frame with data is then a FrameGroup, so the resident count is the
 *     whole count.
 *
 * The session is read LIVE between steps. A change mid-build can leave the
 * result stale; the caller rebuilds after changes anyway.
 *
 * @param {Object} session
 * @param {string|null} cam
 * @param {{tri?: boolean}} [opts] - `tri: false` skips the 3D half (its
 *   `result.tri` is then null), for a camera switch, which needs only the
 *   camera half.
 * @returns {{step: function(number=): boolean, result: Object}} `step(budget)`
 *   does about `budget` units of work and returns true once the build is done;
 *   `result` is then `{tri: {byFrame: Uint8Array, total}, cams: Map<cam,
 *   {byFrame: Int32Array, labeledTotal, usersTotal}>}`, `byFrame` in
 *   `residentFrameUserCount`'s encoding.
 */
export function createFrameCounterBaselineBuilder(session, cam, opts) {
    var withTri = !(opts && opts.tri === false);
    var loader = session.lazyLoader;
    var lazyCam = !!(cam && loader && typeof loader.forEachInstanceRow === 'function');
    // Frames at or past `nFrames` never hydrate (`getFrameSync` refuses them),
    // so they are never on screen and the camera half does not count them.
    var n = lazyCam ? Math.max(0, loader.nFrames | 0) : 0;

    var triArr = withTri ? new Uint8Array(Math.max(1, loader ? (loader.nFrames | 0) : 0, session.instanceGroups.size)) : null;
    var triTotal = 0;
    var triIter = withTri ? session.instanceGroups.entries() : null;
    var triDone = !withTri;

    var camHalf = lazyCam ? { byFrame: new Int32Array(n).fill(-1), labeledTotal: 0, usersTotal: 0 } : null;
    var next = 0;   // next frame of the camera half

    // One frame's rows arrive contiguously (forEachInstanceRow walks each
    // camera-frame's [start, end) range in one go), so accumulate the frame in
    // two reused arrays and resolve it on the frame boundary.
    var curFrame = -1, nRows = 0;
    var rowType = [], memberType = [];
    var flush = function () {
        if (curFrame < 0 || nRows === 0) return;
        var v = storeFrameUserCount(session, cam, curFrame, nRows, rowType, memberType);
        if (v >= 0) {
            camHalf.byFrame[curFrame] = v;
            camHalf.labeledTotal++;
            camHalf.usersTotal += v;
        }
    };
    var lo = 0, hi = 0;
    var visit = function (camName, frameIdx, trackIdx, info) {
        // Narrowed by the loader already; checked again for a loader that
        // ignores the options and visits everything.
        if (camName !== cam || frameIdx < lo || frameIdx >= hi) return;
        if (frameIdx !== curFrame) {
            flush();
            curFrame = frameIdx;
            nRows = 0;
        }
        var off = info ? info.offsetInFrame : nRows;
        rowType[off] = info ? info.type : 'user';
        if (off >= nRows) nRows = off + 1;
    };

    var builder = {
        result: null,
        step: function (budget) {
            if (builder.result) return true;
            var b = budget > 0 ? budget : DEFAULT_STEP;
            if (!triDone) {
                for (var k = 0; k < b; k++) {
                    var e = triIter.next();
                    if (e.done) { triDone = true; break; }
                    var f = e.value[0];
                    if (!groupsHaveTriangulation(e.value[1]) || !(f >= 0)) continue;
                    if (f >= triArr.length) {
                        var grown = new Uint8Array(Math.max(f + 1, triArr.length * 2));
                        grown.set(triArr);
                        triArr = grown;
                    }
                    if (!triArr[f]) { triArr[f] = 1; triTotal++; }
                }
                return false;
            }
            if (lazyCam && next < n) {
                lo = next;
                hi = Math.min(n, next + b);
                curFrame = -1;
                loader.forEachInstanceRow(visit, { camera: cam, start: lo, end: hi });
                flush();
                next = hi;
                if (next < n) return false;
            }
            var cams = new Map();
            if (camHalf) cams.set(cam, camHalf);
            builder.result = { tri: withTri ? { byFrame: triArr, total: triTotal } : null, cams: cams };
            return true;
        },
    };
    return builder;
}

/**
 * Build just the camera half for `cam`, in one go — what a switch to a view
 * with no camera half yet needs before it can show anything.
 *
 * @returns {{byFrame: Int32Array, labeledTotal: number, usersTotal: number}|null}
 */
export function computeLazyCameraBaseline(session, cam) {
    var builder = createFrameCounterBaselineBuilder(session, cam, { tri: false });
    while (!builder.step(Infinity)) { /* until done */ }
    return builder.result.cams.get(cam) || null;
}

/**
 * Build the whole baseline in one go. A walk of `instanceGroups` plus one
 * camera's store rows — never call this per frame.
 *
 * @param {Object} session
 * @param {string|null} cam
 * @returns {Object} see `createFrameCounterBaselineBuilder`'s `result`
 */
export function computeFrameCounterBaseline(session, cam) {
    var builder = createFrameCounterBaselineBuilder(session, cam);
    while (!builder.step(Infinity)) { /* until done */ }
    return builder.result;
}

/**
 * What a camera half contributes for the frames that are NOT resident — the
 * only part of it `countFrameCounters` uses. Two builds of the same camera that
 * differ here saw a change to non-resident frames, i.e. a bulk operation, which
 * the caller takes as a sign that its OTHER cameras' halves are stale too.
 *
 * @param {Object} session
 * @param {{byFrame: Int32Array, labeledTotal: number, usersTotal: number}} half
 * @returns {{labeled: number, instances: number}}
 */
export function nonResidentCameraCounts(session, half) {
    var labeled = half.labeledTotal, instances = half.usersTotal;
    var arr = half.byFrame;
    session.frameGroups.forEach(function (fg, f) {
        if (f < arr.length && arr[f] >= 0) { labeled--; instances -= arr[f]; }
    });
    return { labeled: labeled, instances: instances };
}

/**
 * The three status-bar numbers: resident frames live, everything else from
 * `baseline`. O(resident frames).
 *
 * `baseline` may be stale for frames that changed while NOT resident (a bulk
 * operation); the caller rebuilds it. It is never wrong about a resident frame,
 * because those are always taken from the live FrameGroup. With no baseline,
 * or none for `cam`, Labeled Frames and Instances are the old resident-only
 * count.
 *
 * @param {Object} session
 * @param {string|null} cam - the active camera; with none, nothing is labeled
 * @param {Object|null} baseline - from `computeFrameCounterBaseline` /
 *   `createFrameCounterBaselineBuilder`, for this session
 * @returns {{labeled: number, instances: number, triangulated: number}}
 */
export function countFrameCounters(session, cam, baseline) {
    var camBase = (baseline && cam && baseline.cams) ? (baseline.cams.get(cam) || null) : null;
    var camArr = camBase ? camBase.byFrame : null;
    var triBase = baseline ? baseline.tri : null;
    var triArr = triBase ? triBase.byFrame : null;

    var labeled = 0, instances = 0, triangulated = 0;
    // What the baseline says about the resident frames, to take back out.
    var baseLabeled = 0, baseUsers = 0, baseTri = 0;

    session.frameGroups.forEach(function (fg, f) {
        if (cam) {
            var u = residentFrameUserCount(fg, cam);
            if (u >= 0) { labeled++; instances += u; }
            if (camArr && f < camArr.length) {
                var b = camArr[f];
                if (b >= 0) { baseLabeled++; baseUsers += b; }
            }
        }
        if (groupsHaveTriangulation(session.instanceGroups.get(f))) triangulated++;
        if (triArr && f < triArr.length && triArr[f]) baseTri++;
    });

    if (camBase) {
        labeled += camBase.labeledTotal - baseLabeled;
        instances += camBase.usersTotal - baseUsers;
    }
    if (triBase) triangulated += triBase.total - baseTri;

    return { labeled: labeled, instances: instances, triangulated: triangulated };
}
