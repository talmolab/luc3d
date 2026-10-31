/**
 * run-state.js — has Track or Triangulate been run on a session, and does its
 * result still stand? Drives the toolbar's blue Track and Triangulate buttons
 * (`ui/run-buttons.js`), the way smoothing's own state drives Smooth's.
 *
 * A run is noted when it finishes (`noteTrackRun`, `noteTriangulateRun`). Its
 * result stands while the session still shows it:
 *   - Track: some instance group has an identity.
 *   - Triangulate: some group still holds a 3D array the run produced or kept.
 *     The run marks the arrays (by reference, like the smoothing mark in
 *     `pose/pose-data.js`), so anything that replaces a group's 3D — Track
 *     All's own 3D, a re-solve outside a run, a skeleton edit — drops that
 *     group out. A node move's re-solve keeps it (`carryTriangulateMark`).
 * In memory only: a reopened project starts with neither noted.
 *
 * Asked on every overlay draw, so the answer keeps a WITNESS (a frame and a
 * group that showed the result) and only walks the session when the witness
 * stops holding: then it finds a new one, or forgets the run, after which
 * nothing is walked until the next run.
 *
 * Depends on: pose/pose-data.js
 */

import { someValidPoint3d } from './pose-data.js?v=79eeb337f123';

/** Session -> {frame, group} witness, or null = find one. Absent = not run. */
var _trackRuns = new WeakMap();
var _triangulateRuns = new WeakMap();

/** 3D arrays a Triangulate run produced or kept. */
var _triangulatedArrays = new WeakSet();

function hasIdentity(group) {
    return group.identityId != null && group.identityId >= 0;
}

function holdsTriangulateResult(group) {
    return !!group.points3d && _triangulatedArrays.has(group.points3d);
}

/**
 * Does `session` still show the result of the run recorded in `runs`?
 * Re-checks the witness; walks the session only when it no longer holds.
 */
function resultStands(session, runs, holds) {
    if (!session || !session.instanceGroups || !runs.has(session)) return false;
    var w = runs.get(session);
    if (w) {
        var list = session.instanceGroups.get(w.frame);
        if (list && list.indexOf(w.group) >= 0 && holds(w.group)) return true;
    }
    for (var [frameIdx, groups] of session.instanceGroups) {
        if (!groups) continue;
        for (var gi = 0; gi < groups.length; gi++) {
            var g = groups[gi];
            if (g && holds(g)) {
                runs.set(session, { frame: frameIdx, group: g });
                return true;
            }
        }
    }
    runs.delete(session);
    return false;
}

/** A tracking run (Track All, This frame, a frame range) finished on `session`. */
export function noteTrackRun(session) {
    if (session) _trackRuns.set(session, null);
}

/**
 * A Triangulate run finished on `session`: mark the 3D of every group on
 * `frames` (null = every frame) that the run left solved — whether it solved
 * the group or kept 3D it already had.
 * @param {Session} session
 * @param {Iterable<number>|null} frames
 */
export function noteTriangulateRun(session, frames) {
    if (!session || !session.instanceGroups) return;
    var frameIdxs = frames || session.instanceGroups.keys();
    for (var frameIdx of frameIdxs) {
        var groups = session.instanceGroups.get(frameIdx);
        if (!groups) continue;
        for (var gi = 0; gi < groups.length; gi++) {
            var g = groups[gi];
            if (g && g.triangulationMethod && g.points3d && someValidPoint3d(g.points3d)) {
                _triangulatedArrays.add(g.points3d);
            }
        }
    }
    _triangulateRuns.set(session, null);
}

/**
 * A group's 3D was re-solved into a new array (a node move): it is still the
 * run's result if the array it replaces was.
 */
export function carryTriangulateMark(oldPoints3d, newPoints3d) {
    if (oldPoints3d && newPoints3d && _triangulatedArrays.has(oldPoints3d)) {
        _triangulatedArrays.add(newPoints3d);
    }
}

/** Has Track been run on `session`, with identities still assigned? */
export function hasTrackResult(session) {
    return resultStands(session, _trackRuns, hasIdentity);
}

/** Has Triangulate been run on `session`, with some of its 3D still in place? */
export function hasTriangulateResult(session) {
    return resultStands(session, _triangulateRuns, holdsTriangulateResult);
}
