// pose/origin-rebase.js — move the WHOLE PROJECT into the defined origin.
//
// `ui/origin-definition.js` applies an origin to what is DRAWN and to nothing
// else: the grid, the axes and the orbit move; every stored number stays in
// calibration-world coordinates. That is the right default, because the
// transform — not a rewritten point cloud — is the deliverable, and re-baking
// the data would silently change every 3D number the rest of the app reports.
//
// This module is the other choice, taken explicitly: rewrite everything so the
// project IS the new frame. It is what "Set as New Calibration" does.
//
// ## What has to move together, and why all of it
//
//     3D point      p_new = R · p_old + t                     (affine)
//     3D direction  n_new = R · n_old                         (no translation)
//     camera        R_cam' = R_cam · Rᵀ,  t_cam' = R_cam·o + t_cam
//
// Do all three and **every 2D pixel is unchanged**: a point's reprojection
// under the new calibration lands exactly where it landed under the old one.
// That invariant is the whole safety argument — the annotation's MEANING is
// untouched, only the coordinate system it is expressed in. Move the points
// without the cameras (or vice versa) and every reprojection error in the
// project silently explodes.
//
// So the set is not negotiable: `InstanceGroup.points3d` across every session,
// the plane node pool, each plane's stored fit (a centroid AND a normal, which
// transform differently — see above), and every camera. Two-dimensional data —
// member instances, reprojected instances, plane placements — is invariant and
// is deliberately not touched.
//
// ## Plan, then apply
//
// `planOriginRebase` writes NOTHING. It builds the replacement buffers beside
// the live ones and hands them back; `applyOriginRebase` swaps them in, which
// is synchronous and fast. Cancelling is therefore free and exact: drop the
// plan and not one stored number was ever touched. The cost is holding a second
// copy of the 3D — ~175 MB on a 7.3M-point project, in typed arrays allocated
// OUTSIDE V8's pointer-compressed cage (see the #185/#189 notes in CLAUDE.md),
// which is the cheap place for it. Transforming in place and inverting on
// cancel would halve that and is rejected anyway: `Rᵀ(R·p + t − t)` is not
// bit-identical to `p`, so a cancelled operation would leave the project
// perturbed in the last few ULPs of every coordinate.
//
// **Nothing here hydrates a frame, on a lazily-reopened project or otherwise.**
// The 3D is an O(groups) in-memory walk: `session.instanceGroups` is built in
// full at load time by BOTH reconstructors (see `import-export/slp-import.js`)
// — it is the grouping + 3D, and only the 2D `frameGroups` are windowed.
//
// The 2D INVENTORY is the part with a resident-only hazard, and it is handled
// the same way `ui/custom-delete-ops.js` handles it: on a lazy project the
// columnar store is counted through `lazyLoader.forEachInstanceRow`, because
// `session.frameGroups` there is a small resident window (31 of 180,210 frames
// on the real project) and counting it would report a plausible, tiny number.
// Two-dimensional data does not move, so this is an inventory line rather than
// work — but a wrong inventory line is what sent a user looking for the
// predictions the dialog said they did not have.
//
// ## A SUBSET of the sessions, chosen in the dialog
//
// Nothing here takes a "which sessions" flag. The chosen sessions are simply
// the array that is passed in, so every function below is already subset-aware
// by construction and there is no second code path for the partial case to
// drift out of step with. `subsetRebaseTally` exists only so the dialog can
// re-total its headline numbers on a checkbox click without re-walking a lazy
// project's whole columnar store, which is the expensive half of the count.
//
// DOM-free, so it is testable directly.

import { applyOriginFrame, mulMat3Vec3, rebaseExtrinsics } from './origin-frame.js?v=58ac68f48b9b';
import { points3dNodeCount, hasPoint3d, pooledPoints3d } from './pose-data.js?v=58ac68f48b9b';

/**
 * The SESSION-scoped tally fields — exactly what one `perSession` record
 * carries, and therefore exactly what has to be re-summed when the dialog's
 * session selection changes. Kept as one list so `countRebaseTargets` and
 * `subsetRebaseTally` fold through the identical code and cannot disagree
 * about what a total means.
 */
var SESSION_SCOPED_FIELDS = [
    'cameras',
    'groups', 'userGroups', 'predictedGroups', 'untypedGroups',
    'keypoints3d', 'userKeypoints3d', 'predictedKeypoints3d', 'untypedKeypoints3d',
    'userInstances', 'predictedInstances', 'reprojectedInstances',
    'userMembers', 'predictedMembers',
    'planePoints2d',
];

/**
 * Sum `t.perSession` into `t`'s totals, and derive the two numbers that are
 * built out of them. `planeNodes` / `planeFits` must already be on `t`: they
 * are PROJECT-scoped (one shared `PlaneModel`), move exactly once, and so are
 * carried through untouched rather than summed.
 */
function foldPerSessionTotals(t) {
    var i, k;
    for (k = 0; k < SESSION_SCOPED_FIELDS.length; k++) t[SESSION_SCOPED_FIELDS[k]] = 0;
    t.sessions = t.perSession.length;
    t.instanceScope = 'resident';
    for (i = 0; i < t.perSession.length; i++) {
        var ps = t.perSession[i];
        for (k = 0; k < SESSION_SCOPED_FIELDS.length; k++) {
            t[SESSION_SCOPED_FIELDS[k]] += ps[SESSION_SCOPED_FIELDS[k]];
        }
        // One session counted from the columnar store makes the whole answer
        // the store's, which is what the label in the dialog reports.
        if (ps.instanceScope === 'store') t.instanceScope = 'store';
    }
    // Every 3D point the re-base rewrites, in one number. Plane FITS are
    // excluded on purpose — a fit is a centroid and a normal, not a point.
    t.points3d = t.keypoints3d + t.planeNodes;
    // One unit per thing the plan loop visits, so the progress bar is honest
    // about where the time goes rather than weighting every stage equally.
    t.work = t.groups + t.planeNodes + t.planeFits + t.cameras;
    return t;
}

/**
 * Re-total an existing tally over a SUBSET of its sessions.
 *
 * The confirmation dialog lets the user deselect sessions, and the headline
 * numbers above the session list have to follow — a dialog that says "12,480
 * 3D points to update" while three of five sessions are switched off is lying
 * about what the button does. Recomputing by calling `countRebaseTargets` on
 * the filtered array would be correct and is what the COMMIT does, but it
 * re-walks the 2D inventory, and on a lazy project that is a pass over the
 * whole columnar store (900k rows on the real one) per checkbox click. Every
 * session-scoped number the dialog shows is already in `full.perSession`, so
 * the subset is a re-fold rather than a re-count.
 *
 * The plane pool and the plane fits are carried over verbatim: they are
 * project-scoped, they move once, and they move with the active session —
 * which the dialog does not allow to be deselected.
 *
 * @param {Object} full - a tally from `countRebaseTargets`
 * @param {(ps:Object, index:number)=>boolean} keep - per-session predicate
 * @returns {Object} a tally of the same shape, over the kept sessions only
 */
export function subsetRebaseTally(full, keep) {
    var t = {
        perSession: [],
        planeNodes: full.planeNodes || 0,
        planeFits: full.planeFits || 0,
    };
    var recs = full.perSession || [];
    for (var i = 0; i < recs.length; i++) {
        if (keep(recs[i], i)) t.perSession.push(recs[i]);
    }
    return foldPerSessionTotals(t);
}

/**
 * Tally what a re-base would touch, for the confirmation dialog.
 *
 * **`points3d` is EVERY 3D point that moves, pose and plane together**, and it
 * is what the dialog's headline has to quote. A plane node is a 3D point — it
 * is triangulated from the same 2D, it lives in the same calibration world, and
 * `applyOriginRebase` rewrites it exactly as it rewrites a keypoint. Reporting
 * only `keypoints3d` under a heading that says "3D points" told a user with
 * planes but no pose annotation that nothing would be updated, one row above
 * the nine plane nodes about to move. Keep the headline the sum; the split
 * belongs in the sub-rows, where each term is labelled.
 *
 * Groups are bucketed by their MEMBERS' types, because `InstanceGroup.points3d`
 * itself carries no user/predicted distinction — LUCID writes one `Instance3D`
 * per group either way. A group with at least one user-annotated member counts
 * as user: its 3D was solved from a point a person placed, and that is the
 * provenance the user is being asked about. Each bucket is counted BOTH ways —
 * `*Groups` is how many groups, `*Keypoints3d` is how many points they hold —
 * because a dialog that puts a group count under a "3D points" heading is
 * mixing units in the one column a reader is adding up.
 *
 * **`userInstances` / `predictedInstances` are the WHOLE 2D population, not the
 * grouped half.** Most of what an `.slp` carries is ungrouped predictions —
 * `restoreGroupingAndUnlink` moves every instance no `InstanceGroup` references
 * into `FrameGroup.unlinkedInstances` — and counting only group members
 * reported 0 predicted instances on a project holding hundreds of thousands of
 * them. The two sets are disjoint by construction, so the enumeration mirrors
 * `ui/custom-delete-ops.js`'s: the columnar store on a lazy project, group
 * members plus the unlinked pool on an eager one, and `instanceScope` says
 * which answered. `*Members` keeps the grouped subtotal, because a member is
 * also what buckets its group by provenance.
 *
 * **`perSession` is the same record again, once per session.** Only what is
 * session-scoped appears in it — cameras, pose 3D, the 2D population, plane
 * placements. The plane pool and the plane fits are project-scoped (one shared
 * `PlaneModel`), so they live only in the totals; splitting them per session
 * would invent a division the data does not have. A multi-session project can
 * carry a different `calibration.toml` per session, which is why the dialog
 * needs the breakdown at all: only one calibration file comes out, and the user
 * CHOOSES which sessions move — `subsetRebaseTally` re-folds these records so
 * the headline totals follow that choice.
 *
 * `planePoints2d` is the planes' own 2D, counted in POINTS so it is the same
 * unit as the pose 2D beside it, and it is session-scoped like `planePlacements`.
 *
 * `reprojected` is reported for completeness and is **not** work: a
 * reprojection is a pixel, and moving the world and the cameras together leaves
 * it exactly where it was. Nor is a plane FIT a point: it is a centroid and a
 * normal, which transform differently (see `planOriginRebase`), so it stays out
 * of `points3d` and keeps its own row.
 *
 * @param {Array} sessions - `state.sessions` (or a single-element array)
 * @param {Object} [model] - the `PlaneModel`, or null to skip plane counting
 * @returns {Object} tally
 */
export function countRebaseTargets(sessions, model) {
    var t = {
        sessions: 0, cameras: 0,
        groups: 0, userGroups: 0, predictedGroups: 0, untypedGroups: 0,
        keypoints3d: 0,
        userKeypoints3d: 0, predictedKeypoints3d: 0, untypedKeypoints3d: 0,
        userInstances: 0, predictedInstances: 0, reprojectedInstances: 0,
        userMembers: 0, predictedMembers: 0, instanceScope: 'resident',
        planeNodes: 0, planeFits: 0, planePoints2d: 0,
        points3d: 0,
        perSession: [],
        work: 0,
    };
    var list = sessions || [];

    for (var si = 0; si < list.length; si++) {
        var sess = list[si];
        if (!sess) continue;

        // One record per session. Everything in it is SESSION-scoped: the
        // cameras, the pose 3D, the 2D population and the plane placements.
        // The plane pool and the plane fits are deliberately absent, because
        // they are PROJECT-scoped — one shared `PlaneModel` — and splitting
        // them per session would invent a division the data does not have.
        var ps = {
            name: sess.name || ('Session ' + (t.perSession.length + 1)),
            cameras: (sess.cameras && sess.cameras.length) || 0,
            groups: 0, userGroups: 0, predictedGroups: 0, untypedGroups: 0,
            keypoints3d: 0,
            userKeypoints3d: 0, predictedKeypoints3d: 0, untypedKeypoints3d: 0,
            userInstances: 0, predictedInstances: 0, reprojectedInstances: 0,
            userMembers: 0, predictedMembers: 0,
            planePoints2d: 0,
            instanceScope: 'resident',
        };
        t.perSession.push(ps);

        // ---- pose 3D + the provenance of the groups holding it ----
        if (sess.instanceGroups) {
            for (var entry of sess.instanceGroups) {
                var groups = entry[1] || [];
                for (var gi = 0; gi < groups.length; gi++) {
                    var g = groups[gi];
                    if (g.reprojectedInstances) ps.reprojectedInstances += g.reprojectedInstances.size;
                    var anyUser = false, anyTyped = false;
                    if (g.instances) {
                        for (var inst of g.instances.values()) {
                            if (!inst) continue;
                            if (inst.type === 'user') { ps.userMembers++; anyUser = true; anyTyped = true; }
                            else if (inst.type === 'predicted') { ps.predictedMembers++; anyTyped = true; }
                        }
                    }
                    if (!g.points3d) continue;
                    ps.groups++;
                    var kp = 0;
                    for (var k = 0, n = points3dNodeCount(g.points3d); k < n; k++) {
                        if (hasPoint3d(g.points3d, k)) kp++;
                    }
                    ps.keypoints3d += kp;
                    if (anyUser) { ps.userGroups++; ps.userKeypoints3d += kp; }
                    else if (anyTyped) { ps.predictedGroups++; ps.predictedKeypoints3d += kp; }
                    else { ps.untypedGroups++; ps.untypedKeypoints3d += kp; }
                }
            }
        }

        // ---- the 2D population, from whichever enumeration is COMPLETE ----
        //
        // Never `frameGroups` alone on a lazy project (a resident window), and
        // never group members alone on either (the ungrouped predictions are
        // the bulk of an imported `.slp`). Neither set is work; both are
        // reported so the dialog describes the project the user is looking at.
        var loader = sess.lazyLoader;
        if (loader && typeof loader.forEachInstanceRow === 'function') {
            // The columnar store, grouped and ungrouped rows alike, without
            // materializing a frame. `info.type` is the store's own
            // `instance_type` column, so it needs no resident Instance.
            ps.instanceScope = 'store';
            loader.forEachInstanceRow(function (camName, frameIdx, trackIdx, info) {
                if (info && info.type === 'predicted') ps.predictedInstances++;
                else ps.userInstances++;
            });
        } else {
            // Eager project: every frame is resident, so group members plus
            // the unlinked pool IS the whole population. The two are disjoint
            // by construction — `restoreGroupingAndUnlink` moves exactly the
            // instances NO `InstanceGroup` references into `unlinkedInstances`
            // and leaves the referenced ones behind — so adding them
            // double-counts nothing. Same split `ui/custom-delete-ops.js` walks.
            ps.userInstances += ps.userMembers;
            ps.predictedInstances += ps.predictedMembers;
            if (sess.frameGroups) {
                for (var fgEntry of sess.frameGroups) {
                    var fg = fgEntry[1];
                    if (!fg || !fg.unlinkedInstances) continue;
                    for (var ulEntry of fg.unlinkedInstances) {
                        var ulList = ulEntry[1] || [];
                        for (var ui = 0; ui < ulList.length; ui++) {
                            var uInst = ulList[ui] && ulList[ui].instance;
                            if (!uInst) continue;
                            if (uInst.type === 'user') ps.userInstances++;
                            else if (uInst.type === 'predicted') ps.predictedInstances++;
                        }
                    }
                }
            }
        }

        // ---- the planes' 2D, which is session-scoped and does NOT move ----
        // Counted in POINTS rather than in placed (plane, view) pairs, so it
        // is the same unit as the pose 2D beside it in the dialog.
        var pl = sess.planePlacements;
        if (pl && typeof pl.forEach === 'function') {
            pl.forEach(function (pinst) {
                if (!pinst || typeof pinst.hasPoint !== 'function') return;
                var nn = pinst.numNodes || 0;
                for (var q = 0; q < nn; q++) if (pinst.hasPoint(q)) ps.planePoints2d++;
            });
        }
    }

    if (model) {
        var pool = model.pool && model.pool.nodes ? model.pool.nodes : [];
        for (var ni = 0; ni < pool.length; ni++) {
            var xyz = pool[ni].xyz;
            if (xyz && isFinite(xyz[0]) && isFinite(xyz[1]) && isFinite(xyz[2])) t.planeNodes++;
        }
        var planes = model.planes || [];
        for (var pi = 0; pi < planes.length; pi++) {
            if (planes[pi].planeFit) t.planeFits++;
        }
    }

    // The totals, the two derived numbers and `instanceScope`, through the same
    // fold `subsetRebaseTally` uses — so a re-totalled subset and a fresh count
    // of the same sessions are the same tally by construction.
    return foldPerSessionTotals(t);
}

/**
 * Build every replacement buffer without touching a single stored value.
 *
 * Yields to the event loop every `opts.yieldEvery` units so the progress bar
 * repaints and the Cancel button stays clickable; `opts.shouldCancel()` is
 * asked at each yield, and a true answer abandons the plan — the partial
 * buffers are simply dropped, and because nothing was written there is nothing
 * to roll back.
 *
 * @param {Array} sessions
 * @param {Object|null} model - the `PlaneModel`
 * @param {Object} frame - from `buildOriginFrame`
 * @param {{onProgress?:(done:number,total:number)=>void,
 *          shouldCancel?:()=>boolean, yieldEvery?:number}} [opts]
 * @returns {Promise<Object|null>} the plan; null when cancelled or when the
 *   frame is unusable; or `{failed: true, camera}` when one camera's extrinsics
 *   cannot be re-based — check `failed` before reading anything else.
 */
export async function planOriginRebase(sessions, model, frame, opts) {
    opts = opts || {};
    if (!frame || !frame.R || !frame.origin) return null;
    var onProgress = opts.onProgress || function () {};
    var shouldCancel = opts.shouldCancel || function () { return false; };
    var YIELD = opts.yieldEvery || 2000;

    var tally = countRebaseTargets(sessions, model);
    var total = tally.work;
    var done = 0;
    var R = frame.R;
    var t = frame.translation;

    /** @type {Array<{group:Object, next:Float64Array}>} */
    var groupPlans = [];
    /** @type {Array<{node:Object, next:Float64Array}>} */
    var nodePlans = [];
    /** @type {Array<{plane:Object, centroid:number[], normal:number[]}>} */
    var fitPlans = [];
    /** @type {Array<{camera:Object, rvec:*, tvec:number[]}>} */
    var cameraPlans = [];

    var cancelled = false;
    async function tick() {
        done++;
        if (done % YIELD !== 0) return;
        onProgress(done, total);
        await new Promise(function (r) { setTimeout(r, 0); });
        if (shouldCancel()) cancelled = true;
    }

    // ---- 1. pose 3D, every session ----
    var list = sessions || [];
    for (var si = 0; si < list.length && !cancelled; si++) {
        var sess = list[si];
        if (!sess || !sess.instanceGroups) continue;
        for (var entry of sess.instanceGroups) {
            if (cancelled) break;
            var groups = entry[1] || [];
            for (var gi = 0; gi < groups.length; gi++) {
                var g = groups[gi];
                if (!g.points3d) continue;
                var src = g.points3d;
                // Same length and NaN pattern as the source: a node without 3D
                // must come out without 3D, not at the origin. NaN survives the
                // arithmetic on its own, but copying it explicitly keeps that a
                // stated property rather than a happy accident of IEEE 754.
                var next = new Float64Array(src.length);
                for (var k = 0, n = points3dNodeCount(src); k < n; k++) {
                    var o = k * 3;
                    if (!hasPoint3d(src, k)) {
                        next[o] = NaN; next[o + 1] = NaN; next[o + 2] = NaN;
                        continue;
                    }
                    var x = src[o], y = src[o + 1], z = src[o + 2];
                    next[o] = R[0][0] * x + R[0][1] * y + R[0][2] * z + t[0];
                    next[o + 1] = R[1][0] * x + R[1][1] * y + R[1][2] * z + t[1];
                    next[o + 2] = R[2][0] * x + R[2][1] * y + R[2][2] * z + t[2];
                }
                groupPlans.push({ group: g, next: next });
                await tick();
                if (cancelled) break;
            }
        }
    }

    // ---- 2. the plane node pool ----
    if (!cancelled && model) {
        var pool = (model.pool && model.pool.nodes) ? model.pool.nodes : [];
        for (var ni = 0; ni < pool.length && !cancelled; ni++) {
            var node = pool[ni];
            var xyz = node.xyz;
            if (!xyz || !isFinite(xyz[0]) || !isFinite(xyz[1]) || !isFinite(xyz[2])) continue;
            var q = applyOriginFrame(frame, [xyz[0], xyz[1], xyz[2]]);
            var nn = new Float64Array(3);
            nn[0] = q[0]; nn[1] = q[1]; nn[2] = q[2];
            nodePlans.push({ node: node, next: nn });
            await tick();
        }

        // ---- 3. stored plane fits ----
        //
        // A fit is a POINT and a DIRECTION and they do not transform alike: the
        // centroid takes the translation, the normal must not. Feeding the
        // normal through `applyOriginFrame` is the mistake this split exists to
        // prevent — it would come back translated, denormalized, and pointing
        // somewhere that is only right when the origin happens to be at zero.
        var planes = model.planes || [];
        for (var pi = 0; pi < planes.length && !cancelled; pi++) {
            var plane = planes[pi];
            if (!plane.planeFit) continue;
            fitPlans.push({
                plane: plane,
                centroid: applyOriginFrame(frame, plane.planeFit.centroid),
                normal: mulMat3Vec3(R, plane.planeFit.normal),
            });
            await tick();
        }
    }

    // ---- 4. cameras ----
    for (var sj = 0; sj < list.length && !cancelled; sj++) {
        var s2 = list[sj];
        if (!s2 || !s2.cameras) continue;
        for (var ci = 0; ci < s2.cameras.length && !cancelled; ci++) {
            var cam = s2.cameras[ci];
            var reb = rebaseExtrinsics(cam.rotationMatrix, cam.tvec, frame);
            if (!reb) {
                // A camera whose extrinsics cannot be re-based would be left
                // pointing at the old world while everything around it moved,
                // so the whole plan is abandoned rather than partially applied.
                return { failed: true, camera: cam.name };
            }
            // Keep the notation the calibration arrived in — same rule as the
            // TOML writer, so a 3x3 (anipose) calibration stays a 3x3.
            var asMatrix = Array.isArray(cam.rvec) && Array.isArray(cam.rvec[0]);
            cameraPlans.push({
                camera: cam,
                rvec: asMatrix ? reb.R : reb.rvec,
                tvec: reb.tvec,
            });
            await tick();
        }
    }

    if (cancelled) return null;
    onProgress(total, total);
    return {
        frame: frame,
        tally: tally,
        groups: groupPlans,
        nodes: nodePlans,
        fits: fitPlans,
        cameras: cameraPlans,
    };
}

/**
 * Swap every planned buffer in. Synchronous and fast — the expensive half was
 * the planning.
 *
 * Plane nodes are written STRAIGHT TO `node.xyz`, deliberately bypassing
 * `PlaneNode.setPoint3d`'s refusal for a Locked node. A pin says "this point is
 * not to be re-solved"; it does not say "this point is exempt from the world
 * moving". Honouring the padlock here would leave locked corners behind in the
 * old frame, which is the one outcome nobody wants.
 *
 * @param {Object} plan - from `planOriginRebase`
 * @returns {Object} the plan's tally
 */
export function applyOriginRebase(plan) {
    var i;
    for (i = 0; i < plan.groups.length; i++) {
        // Into the slab pool (pose-data.js `pooledPoints3d`), not one
        // ArrayBuffer per group. The plan's own buffers are left for the GC.
        plan.groups[i].group.points3d = pooledPoints3d(plan.groups[i].next);
    }
    for (i = 0; i < plan.nodes.length; i++) {
        var node = plan.nodes[i].node, nn = plan.nodes[i].next;
        node.xyz[0] = nn[0]; node.xyz[1] = nn[1]; node.xyz[2] = nn[2];
    }
    for (i = 0; i < plan.fits.length; i++) {
        var f = plan.fits[i];
        f.plane.planeFit.centroid = f.centroid;
        f.plane.planeFit.normal = f.normal;
    }
    for (i = 0; i < plan.cameras.length; i++) {
        // Through `setExtrinsics`, which drops the memoized rotation /
        // extrinsic / projection matrices. Assigning `rvec`/`tvec` directly
        // leaves a camera that REPORTS the new pose and PROJECTS with the old.
        plan.cameras[i].camera.setExtrinsics(plan.cameras[i].rvec, plan.cameras[i].tvec);
    }
    return plan.tally;
}
