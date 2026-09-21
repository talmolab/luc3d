// pose/plane-angle.js — set the angle BETWEEN two annotated planes.
//
// Each plane's `planeFit` is fitted independently (a total-least-squares PCA
// through its own triangulated corners), so nothing makes two planes that are
// perpendicular in the real world come out perpendicular in the model. A floor
// and a wall annotated from noisy triangulation land a degree or two off, and
// that error is then baked into anything derived from them — a mesh object's
// geometry, an exported cage, an origin frame taken from one of them.
//
// This module lets the user ASSERT the relationship: "these two planes are at
// 90 degrees". One plane is held fixed, the other is rotated RIGIDLY until the
// angle is met.
//
//
// ## The angle is unsigned, and that is not a simplification
//
// `fitPlaneToPoints3d` returns the eigenvector of the smallest eigenvalue of
// the covariance, straight out of `jacobiEigen`. AN EIGENVECTOR'S SIGN IS
// ARBITRARY — the same annotation can yield +n or -n across runs, and only the
// CONSTRAINED fit path stabilizes it (`orientNormalLike`). So a SIGNED dihedral
// angle read off two stored normals is not reproducible: it is either theta or
// 180 - theta depending on eigen round-off in two unrelated fits.
//
// The angle here is therefore `acos(|n_fixed . n_moving|)`, which lies in
// [0, 90] and is invariant under flipping either normal. 0 means parallel,
// 90 means perpendicular. That is also exactly the convention a user means by
// "the angle between these planes", so the robust choice and the intuitive one
// coincide.
//
//
// ## The rotation axis is the shared edge
//
// Two planes that meet share their corner nodes — one `PlaneNode` with one
// `xyz`, referenced by both planes (that sharing is the whole reason the node
// pool exists). The line through those shared nodes is the natural hinge:
// rotating about it leaves every shared corner EXACTLY where it was, so the
// two planes stay joined and the fixed plane is not disturbed at all.
//
// Fallbacks, in order, for when the user has not joined the planes that way:
//
//   2+ shared nodes  the line through them                 kind: 'edge'
//   1 shared node    through it, along n_fixed x n_moving   kind: 'node'
//   0 shared nodes   through the moving plane's centroid,
//                    same direction                        kind: 'centroid'
//
// `n_fixed x n_moving` is the direction the planes' intersection line runs, so
// the fallbacks rotate about the same direction the shared edge would have had.
//
//
// ## What this module is NOT allowed to do
//
// `planAngleEdit` is PURE. It reads the model and returns a description of a
// proposed change; it writes nothing. That is what lets the UI show a preview,
// raise a refusal, or be cancelled with nothing to undo — and it is a test.
// The commit lives in `ui/plane-angle.js`, mirroring the
// `planPlaneFit` -> `applyPlaneFit` split this is modelled on.
//
// DOM-free and THREE-free on purpose. It deliberately does NOT import
// `pose/triangulation.js` — not even for `planesInvalidatedByFit`, whose job
// `PlaneModel.planesForNode` does from the other direction — because
// triangulation.js pulls in DOM and three.js UI modules, and a test would then
// need the loader stubs `tests/test-plane-constrained-fit.mjs` has to install.
// Being importable with no stubs is most of this module's value.
//
// That is also why `hingeAxis` and `planAngleEdit` take an optional `fits`
// argument. A plane can hold 3D for every corner and still carry no stored
// `planeFit` — pinning a node clears the fit of every plane standing on it —
// and such a plane is perfectly measurable; it just needs `fitPlaneToPoints3d`,
// which lives on the other side of that line. So the caller derives the fit
// (`ui/plane-angle.js` > `usableFit`) and passes it in, and everything here
// treats a derived fit and a stored one identically.

import { normalize3, cross3, dot3, rotationAboutAxis, mulMat3Vec3 } from './origin-frame.js';
import { points3dForPlane } from './plane-data.js';

/** Angles closer than this to the target count as reached. @type {number} */
export const ANGLE_TOL_DEG = 1e-6;

/**
 * Below this, two shared nodes are treated as coincident rather than as
 * defining a direction — a "hinge" from two corners a micron apart is numerical
 * noise pretending to be a line.
 * @type {number}
 */
export const HINGE_MIN_LEN = 1e-9;

/**
 * Fraction of the shared-node span within which a third shared node counts as
 * collinear with the first two. Above it the three shared corners pin a whole
 * plane, not a line, and the two planes are effectively the same plane.
 * @type {number}
 */
export const COLLINEAR_TOL_FRAC = 1e-6;

/**
 * How many names a warning spells out inline before it says "+N more".
 *
 * The angle dialog is a narrow floating panel deliberately kept out of the way
 * of the 3D view, and a warning that names every node in a 12-corner plane
 * would push it over the viewport. Three is enough for the user to recognize
 * WHICH nodes are meant — which is the whole point of naming them — while the
 * untruncated list still reaches them through the warning's `detail`.
 * @type {number}
 */
export const NAME_LIST_CAP = 3;

/**
 * Join names for a warning line, capped at `cap` with a "+N more" tail.
 *
 * Truncating here trims the LAYOUT, not the information: every caller also
 * carries the full list in the warning's `detail`, which the modal hangs off
 * the line as a tooltip.
 *
 * @param {string[]} names @param {number} cap
 * @returns {string}
 * @private
 */
function joinCapped(names, cap) {
    if (names.length <= cap) return names.join(', ');
    return names.slice(0, cap).join(', ') + ', +' + (names.length - cap) + ' more';
}

/** Any unit vector orthogonal to `d`. Local, like triangulation.js's own. @private */
function anyPerp(d) {
    // Cross with whichever axis `d` is least aligned to, so the product is
    // never near-zero and the normalization is well conditioned.
    var ax = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return normalize3(cross3(d, ax));
}

/**
 * The fit to measure a plane by: an explicit override, else its stored one.
 *
 * A plane can hold 3D for every corner and still have `planeFit === null` —
 * pinning a node deliberately clears the fit of every plane standing on it, and
 * a plane that was triangulated but never fitted never had one. Such a plane
 * still HAS a best-fit plane; nothing here can compute it, because
 * `fitPlaneToPoints3d` lives in `pose/triangulation.js` and importing that
 * would cost this module its no-stubs testability (see the header). So the
 * caller derives it and passes it in, and the geometry below neither knows nor
 * cares which of the two it got.
 *
 * @param {PlaneSkeleton} plane
 * @param {Object|null|undefined} override
 * @returns {Object|null}
 * @private
 */
function fitOf(plane, override) {
    if (override) return override;
    return (plane && plane.planeFit) ? plane.planeFit : null;
}

/** `a - b`. @private */
function sub3(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Euclidean length. @private */
function len3(v) {
    return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

/** Wrap an angle into (-pi, pi], so "smallest rotation" is well defined. @private */
function wrapAngle(a) {
    var t = a % (2 * Math.PI);
    if (t > Math.PI) t -= 2 * Math.PI;
    if (t <= -Math.PI) t += 2 * Math.PI;
    return t;
}

/**
 * The unsigned angle between two plane normals, in degrees, in [0, 90].
 *
 * `|dot|` rather than `dot`: see the module header — a stored `planeFit.normal`
 * has an arbitrary sign, so this is the only measurement that gives the same
 * answer for the same geometry twice. 0 = parallel, 90 = perpendicular.
 *
 * @param {number[]} nA @param {number[]} nB
 * @returns {number|null} null when either normal is unusable.
 */
export function planeAngleDeg(nA, nB) {
    var a = normalize3(nA), b = normalize3(nB);
    if (!a || !b) return null;
    var d = Math.abs(dot3(a, b));
    if (d > 1) d = 1;                 // round-off, not geometry
    return Math.acos(d) * 180 / Math.PI;
}

/**
 * The nodes two planes have in common, in `planeA`'s order.
 *
 * Membership is a short `number[]` of IDs, so a filter is both the clearest and
 * the fastest thing here. There is no existing helper for this — the model only
 * answers the inverse question (`planesForNode`).
 *
 * @param {PlaneSkeleton} planeA @param {PlaneSkeleton} planeB
 * @returns {number[]}
 */
export function sharedNodeIds(planeA, planeB) {
    if (!planeA || !planeB) return [];
    return planeA.nodeIds.filter(function (id) { return planeB.hasNode(id); });
}

/**
 * The hinge to rotate `movingPlane` about, given `fixedPlane` stays put.
 *
 * See the module header for the three cases. Only shared nodes that actually
 * HAVE 3D can define a line, so untriangulated ones are ignored rather than
 * contributing NaN to a direction.
 *
 * @param {PlaneSkeleton} fixedPlane
 * @param {PlaneSkeleton} movingPlane
 * @param {PlaneNodePool} pool
 * @param {{fixed?:Object, moving?:Object}} [fits] - Fits to use in place of the
 *   planes' stored ones. See `fitOf`.
 * @returns {{point:number[], dir:number[], kind:'edge'|'node'|'centroid',
 *            sharedIds:number[], hingeIds:number[]}|null}
 *   null when no usable direction exists. `hingeIds` are the nodes that lie ON
 *   the axis, and so are guaranteed not to move.
 */
export function hingeAxis(fixedPlane, movingPlane, pool, fits) {
    if (!fixedPlane || !movingPlane || !pool) return null;
    var fitF = fitOf(fixedPlane, fits && fits.fixed);
    var fitM = fitOf(movingPlane, fits && fits.moving);
    if (!fitF || !fitM) return null;

    var nF = normalize3(fitF.normal);
    var nM = normalize3(fitM.normal);
    if (!nF || !nM) return null;

    var shared = sharedNodeIds(movingPlane, fixedPlane);
    var solved = shared.filter(function (id) {
        var nd = pool.getNode(id);
        return !!(nd && nd.hasPoint3d());
    });

    // --- 2+ shared corners: the line through them. ---
    if (solved.length >= 2) {
        var p0 = pool.getNode(solved[0]).getPoint3d();
        // Take the FARTHEST shared corner rather than simply the second, so a
        // near-coincident pair does not define the hinge when a well-separated
        // one is available.
        var best = -1, bestLen = 0;
        for (var i = 1; i < solved.length; i++) {
            var l = len3(sub3(pool.getNode(solved[i]).getPoint3d(), p0));
            if (l > bestLen) { bestLen = l; best = i; }
        }
        if (best >= 0 && bestLen > HINGE_MIN_LEN) {
            var dir = normalize3(sub3(pool.getNode(solved[best]).getPoint3d(), p0));
            if (dir) {
                // Only the corners actually ON this line are guaranteed fixed.
                var onAxis = solved.filter(function (id) {
                    var r = sub3(pool.getNode(id).getPoint3d(), p0);
                    var along = dot3(r, dir);
                    var off = len3(sub3(r, [dir[0] * along, dir[1] * along, dir[2] * along]));
                    return off <= bestLen * COLLINEAR_TOL_FRAC;
                });
                return {
                    point: p0, dir: dir, kind: 'edge',
                    sharedIds: solved, hingeIds: onAxis,
                };
            }
        }
        // Fall through: every shared corner sits on top of the first one.
    }

    // The intersection direction, for both remaining cases. Parallel normals
    // leave it undetermined, so any perpendicular will do — the rotation is
    // about a line in the fixed plane either way.
    var d = normalize3(cross3(nF, nM)) || anyPerp(nF);
    if (!d) return null;

    // --- exactly 1 shared corner: hold it and swing. ---
    if (solved.length === 1) {
        return {
            point: pool.getNode(solved[0]).getPoint3d(), dir: d, kind: 'node',
            sharedIds: solved, hingeIds: solved,
        };
    }

    // --- no shared corner: pivot on the moving plane's own centroid, so the
    //     plane turns in place instead of swinging away from the scene. ---
    var c = fitM.centroid;
    if (!c || !isFinite(c[0]) || !isFinite(c[1]) || !isFinite(c[2])) return null;
    return {
        point: [c[0], c[1], c[2]], dir: d, kind: 'centroid',
        sharedIds: solved, hingeIds: [],
    };
}

/**
 * Are three or more shared corners spread over a whole plane rather than a line?
 *
 * If so the two planes already share a PLANE, not an edge: there is no rotation
 * that changes their angle without also moving the fixed plane, so the edit has
 * no valid answer and must be refused rather than approximated.
 *
 * @param {number[]} solvedSharedIds @param {PlaneNodePool} pool
 * @returns {boolean}
 */
export function sharedNodesSpanAPlane(solvedSharedIds, pool) {
    if (!solvedSharedIds || solvedSharedIds.length < 3) return false;
    var p0 = pool.getNode(solvedSharedIds[0]).getPoint3d();
    // Longest span first, so "off the line" is measured relative to a real scale.
    var dir = null, span = 0;
    for (var i = 1; i < solvedSharedIds.length; i++) {
        var r = sub3(pool.getNode(solvedSharedIds[i]).getPoint3d(), p0);
        var l = len3(r);
        if (l > span) { span = l; dir = normalize3(r); }
    }
    if (!dir || span <= HINGE_MIN_LEN) return false;
    for (var j = 1; j < solvedSharedIds.length; j++) {
        var q = sub3(pool.getNode(solvedSharedIds[j]).getPoint3d(), p0);
        var along = dot3(q, dir);
        var off = len3(sub3(q, [dir[0] * along, dir[1] * along, dir[2] * along]));
        if (off > span * COLLINEAR_TOL_FRAC) return true;
    }
    return false;
}

/**
 * The rotation about `axisDir` that puts the moving normal at `targetDeg` to
 * the fixed one — the SMALLEST such rotation.
 *
 * Rotating `m` about unit `u` by phi sweeps a cone, and the dot product with a
 * fixed `f` traces a sinusoid in phi:
 *
 *     (R(phi).m) . f  =  A + B cos(phi) + C sin(phi)
 *       A = (m.u)(u.f)          the component the rotation cannot change
 *       B = m_perp . f          m_perp = m - (m.u)u
 *       C = (u x m_perp) . f
 *
 * So the condition `|(R.m).f| = cos(target)` is `A + K cos(phi - delta) = +-T`
 * with `K = hypot(B, C)` and `delta = atan2(C, B)` — solved in closed form, two
 * signs times two arccos branches, giving up to four candidates. The one with
 * the smallest `|phi|` is returned, which is what keeps a wall tilting the way
 * it already leans instead of flipping through the floor.
 *
 * `K ~ 0` means the moving normal lies along the hinge, so rotating about it
 * does not change the angle at all — refused rather than answered.
 *
 * @param {number[]} nFixed @param {number[]} nMoving @param {number[]} axisDir
 * @param {number} targetDeg - In [0, 90].
 * @returns {number|null} Radians, or null when unreachable or degenerate.
 */
export function solveAngleRotation(nFixed, nMoving, axisDir, targetDeg) {
    var f = normalize3(nFixed), m = normalize3(nMoving), u = normalize3(axisDir);
    if (!f || !m || !u) return null;
    if (!isFinite(targetDeg) || targetDeg < 0 || targetDeg > 90) return null;

    var mu = dot3(m, u);
    var mPerp = [m[0] - mu * u[0], m[1] - mu * u[1], m[2] - mu * u[2]];
    var A = mu * dot3(u, f);
    var B = dot3(mPerp, f);
    var C = dot3(cross3(u, mPerp), f);
    var K = Math.sqrt(B * B + C * C);
    if (!(K > 1e-12)) return null;          // the angle is invariant about this axis

    var T = Math.cos(targetDeg * Math.PI / 180);
    var delta = Math.atan2(C, B);

    var best = null;
    var signs = [T, -T];
    for (var s = 0; s < signs.length; s++) {
        var rhs = (signs[s] - A) / K;
        if (rhs > 1) { if (rhs > 1 + 1e-9) continue; rhs = 1; }
        if (rhs < -1) { if (rhs < -1 - 1e-9) continue; rhs = -1; }
        var base = Math.acos(rhs);
        var branches = [base, -base];
        for (var b = 0; b < branches.length; b++) {
            var phi = wrapAngle(delta + branches[b]);
            if (best === null || Math.abs(phi) < Math.abs(best)) best = phi;
        }
    }
    if (best === null) return null;         // target unreachable about this axis

    // Verify rather than trust: a closed form that lands on the wrong branch
    // must fail loudly, not quietly rotate the user's plane somewhere else.
    var R = rotationAboutAxis(u, best);
    if (!R) return null;
    var got = planeAngleDeg(f, mulMat3Vec3(R, m));
    if (got === null || Math.abs(got - targetDeg) > 1e-6) return null;
    return best;
}

/**
 * Rotate a flat plane-ordered `points3d` about an axis through `pivot`.
 *
 * Returns a NEW array; missing nodes (all-NaN) stay missing. `fixedIds` name
 * nodes to copy through verbatim: points on the axis are fixed by the rotation
 * mathematically, but only to within round-off, and a shared corner drifting by
 * an ulp is exactly the silent divergence the shared node pool exists to
 * prevent. Copying makes them bit-identical.
 *
 * @param {Float64Array} flat @param {number[][]} R @param {number[]} pivot
 * @param {number[]} nodeIds - Plane order, parallel to `flat`.
 * @param {number[]} [fixedIds]
 * @returns {Float64Array}
 */
export function applyRotationToPoints3d(flat, R, pivot, nodeIds, fixedIds) {
    var n = (flat.length / 3) | 0;
    var out = new Float64Array(flat.length);
    var fixed = fixedIds ? new Set(fixedIds) : null;
    for (var i = 0; i < n; i++) {
        var o = i * 3;
        var x = flat[o], y = flat[o + 1], z = flat[o + 2];
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
            out[o] = NaN; out[o + 1] = NaN; out[o + 2] = NaN;
            continue;
        }
        if (fixed && nodeIds && fixed.has(nodeIds[i])) {
            out[o] = x; out[o + 1] = y; out[o + 2] = z;
            continue;
        }
        var q = mulMat3Vec3(R, [x - pivot[0], y - pivot[1], z - pivot[2]]);
        out[o] = q[0] + pivot[0];
        out[o + 1] = q[1] + pivot[1];
        out[o + 2] = q[2] + pivot[2];
    }
    return out;
}

/**
 * The same rigid motion applied to a stored `planeFit`.
 *
 * Rotating the fit rather than re-running it is deliberate. A re-fit would
 * re-derive the normal's sign from `jacobiEigen` and could flip it, which
 * changes nothing geometrically but silently inverts anything downstream that
 * read the old sign (an origin frame's +Z, a mesh object's winding). Rotating
 * is also exact and free, and `rms` / `nPoints` are properties of the
 * annotation, which a rigid motion does not change.
 *
 * @param {Object} fit @param {number[][]} R @param {number[]} pivot
 * @returns {Object|null} A new fit object.
 */
export function rotatePlaneFit(fit, R, pivot) {
    if (!fit || !R) return null;
    var c = fit.centroid, nv = fit.normal;
    if (!c || !nv) return null;
    var rc = mulMat3Vec3(R, [c[0] - pivot[0], c[1] - pivot[1], c[2] - pivot[2]]);
    var out = {
        centroid: [rc[0] + pivot[0], rc[1] + pivot[1], rc[2] + pivot[2]],
        normal: mulMat3Vec3(R, nv),
        rms: fit.rms,
        nPoints: fit.nPoints,
    };
    if (fit.constrained !== undefined) out.constrained = fit.constrained;
    return out;
}

/**
 * Plan the edit. PURE — reads the model, writes nothing.
 *
 * @param {PlaneSkeleton} fixedPlane
 * @param {PlaneSkeleton} movingPlane
 * @param {number} targetDeg - In [0, 90]. 0 = parallel, 90 = perpendicular.
 * @param {PlaneModel} model
 * @param {{fixed?:Object, moving?:Object}} [fits] - Fits to use in place of the
 *   planes' stored ones, for a plane that has 3D but no stored fit. See
 *   `fitOf`. `newMovingFit` is then the rotation of whichever fit was used.
 * @returns {{ok:boolean, code:string, message:string, warnings:Object[],
 *            axis?:Object, currentDeg?:number, targetDeg?:number,
 *            deltaDeg?:number, R?:number[][], before?:Float64Array,
 *            after?:Float64Array, movedNodeIds?:number[],
 *            blockedNodeNames?:string[], stalePlaneIds?:number[],
 *            newFixedFit?:Object, newMovingFit?:Object}}
 */
export function planAngleEdit(fixedPlane, movingPlane, targetDeg, model, fits) {
    var warnings = [];
    var fail = function (code, message) {
        return { ok: false, code: code, message: message, warnings: warnings };
    };

    if (!model) return fail('no_model', 'No plane model');
    if (!fixedPlane || !movingPlane) return fail('no_plane', 'Pick two planes');
    if (fixedPlane.id === movingPlane.id) {
        return fail('same_plane', 'The fixed and moving planes must be different');
    }
    var fitF = fitOf(fixedPlane, fits && fits.fixed);
    var fitM = fitOf(movingPlane, fits && fits.moving);
    if (!fitF) {
        return fail('no_fit', '"' + fixedPlane.name + '" has no plane yet — ' +
            'triangulate its corners first, so there is something to measure against');
    }
    if (!fitM) {
        return fail('no_fit', '"' + movingPlane.name + '" has no plane yet — ' +
            'triangulate its corners first, so there is something to rotate');
    }
    if (!isFinite(targetDeg) || targetDeg < 0 || targetDeg > 90) {
        return fail('bad_target', 'The angle must be between 0 and 90 degrees ' +
            '(0 = parallel, 90 = perpendicular)');
    }

    var pool = model.pool;
    var nF = normalize3(fitF.normal);
    var nM = normalize3(fitM.normal);
    if (!nF || !nM) return fail('no_fit', 'One of the planes has no usable normal');

    var currentDeg = planeAngleDeg(nF, nM);

    var axis = hingeAxis(fixedPlane, movingPlane, pool, fits);
    if (!axis) {
        return fail('degenerate_axis', 'These two planes give no usable hinge to ' +
            'rotate about. Triangulate their shared corners, or check that ' +
            '"' + movingPlane.name + '" is not degenerate.');
    }
    if (sharedNodesSpanAPlane(axis.sharedIds, pool)) {
        return fail('overconstrained', '"' + fixedPlane.name + '" and "' +
            movingPlane.name + '" share ' + axis.sharedIds.length + ' corners that ' +
            'are not in a line, so they already share a plane. Any rotation would ' +
            'move "' + fixedPlane.name + '" too. Remove a shared node from one of ' +
            'them first.');
    }

    var phi = solveAngleRotation(nF, nM, axis.dir, targetDeg);
    if (phi === null) {
        return fail('unreachable', 'Cannot reach ' + targetDeg + '° by rotating "' +
            movingPlane.name + '" about its shared edge with "' + fixedPlane.name +
            '". The hinge does not let that angle be set.');
    }
    var R = rotationAboutAxis(axis.dir, phi);
    if (!R) return fail('degenerate_axis', 'The hinge direction is unusable');

    var before = points3dForPlane(movingPlane, pool);
    var after = applyRotationToPoints3d(before, R, axis.point,
        movingPlane.nodeIds, axis.hingeIds);

    // Which nodes this rotation would actually MOVE. `Object.is` rather than a
    // tolerance, matching `planPlaneFit`: the hinge nodes are copied verbatim
    // and missing ones stay NaN (which `Object.is` treats as equal to itself),
    // so the diff is exact by construction.
    var movedNodeIds = [];
    for (var k = 0; k < movingPlane.nodeIds.length; k++) {
        var o = k * 3;
        if (!Object.is(before[o], after[o]) ||
            !Object.is(before[o + 1], after[o + 1]) ||
            !Object.is(before[o + 2], after[o + 2])) {
            movedNodeIds.push(movingPlane.nodeIds[k]);
        }
    }

    // A LOCKED node that would move is a hard refusal: the user pinned that
    // coordinate, and rotating the plane cannot honour the pin and the angle at
    // once. Nodes on the hinge are excluded because they do not move — locking
    // a shared corner is in fact the documented way to hold an intersection
    // line still, so it must not block the very edit it enables.
    var blockedNodeNames = [];
    for (var b = 0; b < movedNodeIds.length; b++) {
        var nd = pool.getNode(movedNodeIds[b]);
        if (nd && nd.pin === 'locked') blockedNodeNames.push(nd.name);
    }
    if (blockedNodeNames.length) {
        return {
            ok: false, code: 'locked_nodes', warnings: warnings,
            blockedNodeNames: blockedNodeNames,
            message: 'Rotating "' + movingPlane.name + '" would move ' +
                blockedNodeNames.length + ' Locked node' +
                (blockedNodeNames.length === 1 ? '' : 's') + ' — ' +
                blockedNodeNames.join(', ') + '.\n\nA Locked node’s 3D position ' +
                'cannot be changed by anything. Set it to Plane-locked or unpinned ' +
                'in the Nodes table, or pick a different plane to move.',
        };
    }

    if (!movedNodeIds.length) {
        warnings.push({
            code: 'already_there',
            message: 'The planes are already at ' + targetDeg.toFixed(3) +
                '° — nothing to move.',
        });
    }

    // A shared node moving is ordinary work, not an error — but the OTHER
    // plane's stored fit was derived from where that node used to be, so it is
    // now stale and must not be left looking valid. Asked via `planesForNode`
    // rather than `planesInvalidatedByFit` to keep triangulation.js out of this
    // module; the question is the same one, from the other side.
    //
    // Names are collected alongside the ids because a count alone ("2 other
    // planes") is unactionable: the user cannot tell which fits they are about
    // to lose, nor which corner of the moving plane is dragging them in. The
    // node that pulled each plane into the list is the one they would have to
    // un-share to avoid it, so it is named too.
    var stale = [];
    var staleNames = [];
    var staleVia = [];   // per stale plane, the moved nodes it shares
    var seenIdx = {};
    for (var s = 0; s < movedNodeIds.length; s++) {
        var mvNode = pool.getNode(movedNodeIds[s]);
        var mvName = mvNode ? mvNode.name : String(movedNodeIds[s]);
        var owners = model.planesForNode(movedNodeIds[s]);
        for (var w = 0; w < owners.length; w++) {
            var oid = owners[w].id;
            if (oid === movingPlane.id) continue;
            // `typeof`, not truthiness: index 0 is a perfectly good slot.
            if (typeof seenIdx[oid] !== 'number') {
                seenIdx[oid] = stale.length;
                stale.push(oid);
                staleNames.push(owners[w].name);
                staleVia.push([]);
            }
            staleVia[seenIdx[oid]].push(mvName);
        }
    }

    // Nodes held in a DIFFERENT plane are reported, not refused: the commit
    // runs them through `constrainPoint3dForNode`, so they land back in their
    // own plane and the rotation is no longer exactly rigid for them.
    //
    // Each name is paired with the plane it is held IN. The old wording put a
    // bare node list in parentheses right after "another plane", which read as
    // if the parenthetical named the PLANE — so the one warning that did name
    // its nodes was the one most likely to be misread.
    var constrainedNames = [];    // node names alone, for callers and tests
    var constrainedLabels = [];   // 'node (in "plane")', for the message
    for (var c2 = 0; c2 < movedNodeIds.length; c2++) {
        var cn = pool.getNode(movedNodeIds[c2]);
        if (!cn || cn.pin !== 'plane-locked' || cn.pinPlaneId === null ||
            cn.pinPlaneId === movingPlane.id) continue;
        var holder = model.getPlane(cn.pinPlaneId);
        if (!holder) continue;
        constrainedNames.push(cn.name);
        constrainedLabels.push(cn.name + ' (in "' + holder.name + '")');
    }
    if (constrainedNames.length) {
        var oneNode = constrainedNames.length === 1;
        warnings.push({
            code: 'plane_locked_elsewhere',
            message: constrainedNames.length + (oneNode ? ' node is' : ' nodes are') +
                ' Plane-locked to ' + (oneNode ? 'another plane' : 'other planes') +
                ' and will be held there, so the result may miss the target ' +
                'angle: ' + joinCapped(constrainedLabels, NAME_LIST_CAP) + '.',
            detail: 'Plane-locked node' + (oneNode ? '' : 's') + ': ' +
                constrainedLabels.join(', '),
        });
    }
    if (stale.length) {
        var onePlane = stale.length === 1;
        var staleLabels = [];
        var staleLabelsFull = [];
        for (var t = 0; t < stale.length; t++) {
            staleLabels.push('"' + staleNames[t] + '" (shares ' +
                joinCapped(staleVia[t], NAME_LIST_CAP) + ')');
            staleLabelsFull.push('"' + staleNames[t] + '" (shares ' +
                staleVia[t].join(', ') + ')');
        }
        warnings.push({
            code: 'stale_fits',
            message: stale.length +
                (onePlane ? ' other plane shares ' : ' other planes share ') +
                (onePlane && staleVia[0].length === 1 ? 'a node' : 'nodes') +
                ' that will move, so ' + (onePlane ? 'its fit' : 'their fits') +
                ' will be cleared: ' + joinCapped(staleLabels, NAME_LIST_CAP) + '.',
            detail: 'Fits that will be cleared: ' + staleLabelsFull.join(', '),
        });
    }

    return {
        ok: true, code: 'ok', message: '', warnings: warnings,
        axis: axis,
        currentDeg: currentDeg,
        targetDeg: targetDeg,
        deltaDeg: phi * 180 / Math.PI,
        R: R,
        before: before,
        after: after,
        movedNodeIds: movedNodeIds,
        blockedNodeNames: [],
        stalePlaneIds: stale,
        newMovingFit: rotatePlaneFit(fitM, R, axis.point),
    };
}
