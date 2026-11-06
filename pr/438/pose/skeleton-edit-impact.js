// pose/skeleton-edit-impact.js — what a skeleton edit is about to touch.
//
// Adding, removing or renaming a node — or adding/removing an edge — is not a
// setting. The skeleton is the SHAPE every instance in the project is stored
// against: `Instance` holds one flat `Float64Array(2N)` keyed by node INDEX, so
// a node added or removed re-shapes every annotation in every session. LUCID is
// one skeleton per project (`ui/app-state.js`'s `setProjectSkeleton` points
// every session at one object), so the edit is never local to the session whose
// panel is open, and a confirmation quoting only the active session would
// understate it by however many sessions are loaded.
//
// This module is the DOM-free half: it counts what exists, so
// `ui/skeleton-edit-warning.js` can state it before anything is mutated. It
// deliberately mirrors `pose/origin-rebase.js`'s `countRebaseTargets` — same
// two enumerations, same reason — rather than inventing a second way to walk a
// project:
//
// - **The 2D population is the WHOLE population, never `frameGroups` alone on
//   a lazy project.** Most of an imported `.slp` is ungrouped predictions
//   living in `FrameGroup.unlinkedInstances`, and on a LAZY project
//   `session.frameGroups` is a small resident window (31 of 180,210 frames on
//   the real project), so counting it yields a plausible, tiny, wrong number. A
//   lazy session is counted through `lazyLoader.forEachInstanceRow` (the
//   columnar store, no frame materialized); an eager one through its frame
//   groups' instances plus the unlinked pool, which are disjoint by
//   construction.
//
// - **`resident` / `total` frames is the headline on a lazy project**, because
//   that ratio is what the user is really being warned about:
//   `Session.propagateNodeAdded` / `propagateNodeRemoved` can only re-shape
//   instances that are IN MEMORY. Frames still in the columnar store are
//   rebuilt later with a fixed per-instance node count, so they come back on
//   the PREVIOUS skeleton — silently, with no error, long after the edit. That
//   is the one thing the dialog has to say loudest.
//
// `perSession` is the same record once per session, so the dialog can print a
// row each and a total, and the two can never be computed two different ways.

/**
 * The sessions a skeleton edit would reach: those sharing THIS skeleton.
 *
 * Reference identity first, because that is what "one skeleton per project"
 * actually produces — every `state.sessions[i].skeleton` is the same object.
 * `compatibilityKey()` is the fallback for the case the model allows but the
 * app avoids: a session carrying a separately-built skeleton of the same shape,
 * whose `Instance` point arrays are interchangeable. A session whose skeleton
 * has a DIFFERENT shape is not touched by this edit and must not be counted, or
 * the dialog's total describes annotations that never move.
 *
 * @param {Array} sessions - `state.sessions`
 * @param {Object} skeleton - the skeleton being edited
 * @returns {{shared: Array, others: Array}}
 */
export function splitSessionsBySkeleton(sessions, skeleton) {
    var shared = [], others = [];
    var list = sessions || [];
    var key = null;
    if (skeleton && typeof skeleton.compatibilityKey === 'function') {
        key = skeleton.compatibilityKey();
    }
    for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (!s) continue;
        var sk = s.skeleton;
        var same = !!sk && (sk === skeleton ||
            (key != null && typeof sk.compatibilityKey === 'function' &&
             sk.compatibilityKey() === key));
        (same ? shared : others).push(s);
    }
    return { shared: shared, others: others };
}

/**
 * Tally the annotations a skeleton edit would re-shape, per session and in
 * total.
 *
 * Every number here is INVENTORY, not work: nothing is mutated and nothing is
 * read from the skeleton's current contents, so the same tally describes an
 * add, a remove, a rename and an edge edit. What DIFFERS between those is the
 * consequence, which is the dialog's copy and not this module's business.
 *
 * `groups` / `keypoints3d` are the triangulated side: a node edit re-shapes
 * `InstanceGroup.points3d` too (a flat `Float64Array(3N)` on the same node
 * index space) and invalidates every cached reprojection, so the dialog has to
 * be able to say how much 3D is involved.
 *
 * @param {Array} sessions - the sessions sharing the skeleton (see
 *   `splitSessionsBySkeleton`)
 * @returns {Object} tally
 */
export function countSkeletonEditImpact(sessions) {
    var t = {
        sessions: 0,
        userInstances: 0, predictedInstances: 0, instances: 0,
        reprojectedInstances: 0,
        groups: 0, keypoints3d: 0,
        lazySessions: 0, residentFrames: 0, totalFrames: 0, nonResidentFrames: 0,
        anyLazy: false,
        perSession: [],
    };
    var list = sessions || [];

    for (var si = 0; si < list.length; si++) {
        var sess = list[si];
        if (!sess) continue;

        var loader = sess.lazyLoader;
        // A lazy session is one whose store holds frames the session does not.
        // `nFrames` is the project's frame count; `frameGroups.size` is the
        // resident window. `lazy` is the condition the loud warning turns on,
        // so it is derived here once rather than guessed at in the dialog.
        var totalFrames = (loader && loader.nFrames) || 0;
        var resident = (sess.frameGroups && sess.frameGroups.size) || 0;
        var lazy = !!loader && totalFrames > 0 && resident < totalFrames;

        var ps = {
            name: sess.name || ('Session ' + (t.perSession.length + 1)),
            userInstances: 0, predictedInstances: 0, instances: 0,
            reprojectedInstances: 0,
            groups: 0, keypoints3d: 0,
            lazy: lazy,
            residentFrames: resident,
            totalFrames: totalFrames,
            instanceScope: 'resident',
        };
        t.perSession.push(ps);

        // ---- the triangulated side ----
        if (sess.instanceGroups) {
            for (var entry of sess.instanceGroups) {
                var groups = entry[1] || [];
                for (var gi = 0; gi < groups.length; gi++) {
                    var g = groups[gi];
                    if (!g) continue;
                    ps.groups++;
                    if (g.reprojectedInstances) ps.reprojectedInstances += g.reprojectedInstances.size;
                    // Counted in POINTS, the same unit as the 2D rows beside
                    // it. `points3d` is flat `[x,y,z, …]`, so its node count is
                    // length/3 — read without importing `points3dNodeCount`,
                    // which lives in `pose/pose-data.js` and would make this
                    // module depend on the whole data model for one divide.
                    if (g.points3d && g.points3d.length) ps.keypoints3d += (g.points3d.length / 3) | 0;
                }
            }
        }

        // ---- the 2D population, from whichever enumeration is COMPLETE ----
        if (loader && typeof loader.forEachInstanceRow === 'function') {
            ps.instanceScope = 'store';
            loader.forEachInstanceRow(function (camName, frameIdx, trackIdx, info) {
                if (info && info.type === 'predicted') ps.predictedInstances++;
                else ps.userInstances++;
            });
        } else if (sess.frameGroups) {
            for (var fgEntry of sess.frameGroups) {
                var fg = fgEntry[1];
                if (!fg) continue;
                if (fg.instances) {
                    for (var instEntry of fg.instances) {
                        var instList = instEntry[1] || [];
                        for (var ii = 0; ii < instList.length; ii++) {
                            var inst = instList[ii];
                            if (!inst) continue;
                            if (inst.type === 'predicted') ps.predictedInstances++;
                            else ps.userInstances++;
                        }
                    }
                }
                if (fg.unlinkedInstances) {
                    for (var ulEntry of fg.unlinkedInstances) {
                        var ulList = ulEntry[1] || [];
                        for (var ui = 0; ui < ulList.length; ui++) {
                            var uInst = ulList[ui] && ulList[ui].instance;
                            if (!uInst) continue;
                            if (uInst.type === 'predicted') ps.predictedInstances++;
                            else ps.userInstances++;
                        }
                    }
                }
            }
        }
        ps.instances = ps.userInstances + ps.predictedInstances;
    }

    for (var pi = 0; pi < t.perSession.length; pi++) {
        var r = t.perSession[pi];
        t.userInstances += r.userInstances;
        t.predictedInstances += r.predictedInstances;
        t.instances += r.instances;
        t.reprojectedInstances += r.reprojectedInstances;
        t.groups += r.groups;
        t.keypoints3d += r.keypoints3d;
        if (r.lazy) {
            t.lazySessions++;
            t.residentFrames += r.residentFrames;
            t.totalFrames += r.totalFrames;
        }
    }
    t.sessions = t.perSession.length;
    t.anyLazy = t.lazySessions > 0;
    t.nonResidentFrames = t.totalFrames - t.residentFrames;
    return t;
}

/**
 * Is there anything to warn about? A project with no annotation at all — a
 * freshly loaded set of videos, or the very first skeleton being built — must
 * not raise a modal for every node typed into the box, so the dialog asks this
 * first and applies the edit straight through when it is false.
 *
 * Groups count on their own: a project can hold triangulated groups whose 2D
 * all arrived as predictions since released from memory. So does `anyLazy`,
 * which is the one case where the counts being zero means nothing — the
 * annotations are in the store, not in the tally.
 *
 * @param {Object} tally - from `countSkeletonEditImpact`
 * @returns {boolean}
 */
export function skeletonEditNeedsConfirmation(tally) {
    if (!tally) return false;
    return (tally.instances > 0 || tally.groups > 0 || tally.anyLazy);
}
