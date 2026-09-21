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
// **This is an O(groups) in-memory walk even on a lazily-reopened project.**
// `session.instanceGroups` is built in full at load time by BOTH reconstructors
// (see `import-export/slp-import.js`) — it is the grouping + 3D, and only the
// 2D `frameGroups` are windowed. So there is no hydration sweep here and no
// resident-only hazard: nothing this module reads can be absent.
//
// DOM-free, so it is testable directly.

import { applyOriginFrame, mulMat3Vec3, rebaseExtrinsics } from './origin-frame.js';
import { points3dNodeCount, hasPoint3d } from './pose-data.js';

/**
 * Tally what a re-base would touch, for the confirmation dialog.
 *
 * Groups are bucketed by their MEMBERS' types, because `InstanceGroup.points3d`
 * itself carries no user/predicted distinction — LUCID writes one `Instance3D`
 * per group either way. A group with at least one user-annotated member counts
 * as user: its 3D was solved from a point a person placed, and that is the
 * provenance the user is being asked about.
 *
 * `reprojected` is reported for completeness and is **not** work: a
 * reprojection is a pixel, and moving the world and the cameras together leaves
 * it exactly where it was.
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
        userInstances: 0, predictedInstances: 0, reprojectedInstances: 0,
        planeNodes: 0, planeFits: 0,
        work: 0,
    };
    var list = sessions || [];
    for (var si = 0; si < list.length; si++) {
        var sess = list[si];
        if (!sess) continue;
        t.sessions++;
        t.cameras += (sess.cameras && sess.cameras.length) || 0;
        if (!sess.instanceGroups) continue;
        for (var entry of sess.instanceGroups) {
            var groups = entry[1] || [];
            for (var gi = 0; gi < groups.length; gi++) {
                var g = groups[gi];
                if (g.reprojectedInstances) t.reprojectedInstances += g.reprojectedInstances.size;
                var anyUser = false, anyTyped = false;
                if (g.instances) {
                    for (var inst of g.instances.values()) {
                        if (!inst) continue;
                        if (inst.type === 'user') { t.userInstances++; anyUser = true; anyTyped = true; }
                        else if (inst.type === 'predicted') { t.predictedInstances++; anyTyped = true; }
                    }
                }
                if (!g.points3d) continue;
                t.groups++;
                if (anyUser) t.userGroups++;
                else if (anyTyped) t.predictedGroups++;
                else t.untypedGroups++;
                for (var k = 0, n = points3dNodeCount(g.points3d); k < n; k++) {
                    if (hasPoint3d(g.points3d, k)) t.keypoints3d++;
                }
            }
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

    // One unit per thing the plan loop visits, so the progress bar is honest
    // about where the time goes rather than weighting every stage equally.
    t.work = t.groups + t.planeNodes + t.planeFits + t.cameras;
    return t;
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
        plan.groups[i].group.points3d = plan.groups[i].next;
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
