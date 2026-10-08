/**
 * session-node-order.js — re-order a whole session's keypoint data into
 * another skeleton's node order BY NAME, and adopt one skeleton across every
 * session of a project.
 *
 * ## Why
 *
 * Every keypoint LUCID holds is stored by COLUMN: node `k` of an Instance,
 * of a group's `points3d`, of a reprojection, of a lazy store's point rows.
 * The skeleton is what NAMES column `k`. A project has ONE skeleton shared by
 * every session (`setProjectSkeleton`, ui/app-state.js), so whenever that
 * skeleton is replaced — a multi-session folder load, a `skeleton.json`, the
 * "Import skeleton for all sessions" prompt, Load Skeleton — any session whose
 * data is stored in another node order would otherwise be silently mis-named.
 * Nothing errors: geometry by column is unchanged, so tracking and
 * triangulation look fine, and everything BY NAME — labels, Tracking Wizard
 * node weights, the size/image ID-switch checks — is wrong.
 *
 * `adoptSkeletonNodeOrder` compares each session's CURRENT order (its own
 * `session.skeleton.nodes`, which describes its data) with the incoming one:
 *
 *   same names, same order    nothing to do
 *   same names, other order   the session's data is re-ordered by name
 *                             (`permuteSessionNodes`) — lossless
 *   different names           reported, never guessed: the caller still
 *                             applies the skeleton by column and says so
 *
 * The per-camera half — cameras of ONE session whose files order the same
 * nodes differently — is `loading/slp-skeleton.js`'s `nodeOrderRemap`, which
 * this module reuses so the two agree about what "the same nodes" means.
 *
 * ## What is re-ordered
 *
 * Everything held per node, in place: every Instance in `frameGroups`
 * (linked and unlinked) and in `instanceGroups` (members and
 * `reprojectedInstances`) via `Instance.permuteNodes` — coordinates,
 * occlusion, backup, `nulledNodes`; each group's `points3d` and raw
 * `reprojections`; and the derived `triangulationResults` entries (3D,
 * reprojections, per-node errors), so the Info Panel's per-node errors stay
 * attached to the right node. One `seen` set spans the whole walk: the lazy
 * hydration path SHARES coordinate buffers between a group member and its
 * resident instance, and a result entry shares `points3d`/`reprojections` with
 * its group, so each buffer must move exactly once.
 *
 * A LAZY session's store is re-ordered by its loader
 * (`SioLazyLoader.permuteNodes`, which records the new order so the
 * multi-session save's pass-2 re-open repeats it). A loader that cannot do
 * that refuses, and the session is reported instead of half re-ordered.
 *
 * DOM-free; imports only `loading/slp-skeleton.js` (itself import-free), so it
 * loads in Node (`tests/test-session-node-order.mjs`).
 */

import { nodeOrderRemap, permuteNodeAxis } from '../loading/slp-skeleton.js?v=6d16b4e09a1e';

/**
 * Re-order one per-node container in place, once: a typed array of
 * `perm.length * width` values, or a plain Array of `perm.length` entries
 * (boxed rows or scalars). Anything else is left alone.
 * @returns {boolean} moved
 */
function permuteNodeValues(arr, perm, width, seen) {
    if (!arr || typeof arr !== 'object' || seen.has(arr)) return false;
    var n = perm.length;
    if (ArrayBuffer.isView(arr)) {
        if (arr.length !== n * width) return false;
        seen.add(arr);
        permuteNodeAxis(arr, perm, width);
        return true;
    }
    if (Array.isArray(arr)) {
        if (arr.length !== n) return false;
        seen.add(arr);
        var old = arr.slice();
        for (var s = 0; s < n; s++) arr[s] = old[perm[s]];
        return true;
    }
    return false;
}

/** Each value of a `{ cameraName: perNodeArray }` dict. */
function permuteByCamera(dict, perm, width, seen) {
    if (!dict || typeof dict !== 'object' || seen.has(dict)) return;
    seen.add(dict);
    for (var cam in dict) permuteNodeValues(dict[cam], perm, width, seen);
}

/**
 * Re-order the node axis of ALL of `session`'s keypoint data in place: new
 * node `s` takes old node `perm[s]` (`nodeOrderRemap`'s convention). Does NOT
 * touch `session.skeleton` — the caller swaps the names, once the data is in
 * their order.
 *
 * For a lazy session the loader goes first, and may refuse (a camera of the
 * session loaded by column under names that are not its own, or a loader
 * that cannot re-order); then nothing at all is changed.
 *
 * @param {Session} session
 * @param {Int32Array|number[]} perm
 * @param {Object} [opts]
 * @param {Map} [opts.triangulationResults] - the ACTIVE session's results live
 *   on `state.triangulationResults`, not on the session; pass them here
 * @returns {{ok: true, instances: number, groups: number} | {ok: false, reason: string}}
 */
export function permuteSessionNodes(session, perm, opts) {
    opts = opts || {};
    var loader = session && session.lazyLoader;
    if (loader) {
        if (typeof loader.permuteNodes !== 'function') {
            return { ok: false, reason: 'its lazy loader cannot re-order nodes' };
        }
        var lr = loader.permuteNodes(perm);
        if (!lr || !lr.ok) return { ok: false, reason: (lr && lr.reason) || 'its lazy loader refused' };
    }

    var seen = new Set();
    var counts = { ok: true, instances: 0, groups: 0 };
    var visit = function (inst) {
        if (inst && typeof inst.permuteNodes === 'function' && inst.permuteNodes(perm, seen)) counts.instances++;
    };
    if (session.frameGroups) {
        for (var fg of session.frameGroups.values()) {
            for (var list of fg.instances.values()) for (var i = 0; i < list.length; i++) visit(list[i]);
            for (var ulist of fg.unlinkedInstances.values()) {
                for (var u = 0; u < ulist.length; u++) visit(ulist[u] && ulist[u].instance);
            }
        }
    }
    if (session.instanceGroups) {
        for (var groups of session.instanceGroups.values()) {
            for (var gi = 0; gi < groups.length; gi++) {
                var g = groups[gi];
                for (var member of g.instances.values()) visit(member);
                if (g.reprojectedInstances) for (var rep of g.reprojectedInstances.values()) visit(rep);
                permuteNodeValues(g.points3d, perm, 3, seen);
                permuteByCamera(g.reprojections, perm, 2, seen);
                counts.groups++;
            }
        }
    }
    var resultMaps = [session.triangulationResults, opts.triangulationResults];
    for (var mi = 0; mi < resultMaps.length; mi++) {
        var tr = resultMaps[mi];
        if (!(tr instanceof Map) || seen.has(tr)) continue;
        seen.add(tr);
        for (var entries of tr.values()) {
            for (var ei = 0; ei < (entries || []).length; ei++) {
                var r = entries[ei];
                if (!r) continue;
                permuteNodeValues(r.points3d, perm, 3, seen);
                permuteByCamera(r.reprojections, perm, 2, seen);
                permuteByCamera(r.errors, perm, 1, seen);
                permuteByCamera(r.errorsUndistorted, perm, 1, seen);
            }
        }
    }
    return counts;
}

/**
 * Bring every session's data into `skeleton`'s node order, by name, ahead of
 * the caller making `skeleton` the project skeleton. Each session is compared
 * by its OWN current order (`session.skeleton.nodes`); a session with no nodes
 * yet has nothing stored by name and is skipped.
 *
 * @param {Session[]} sessions
 * @param {{nodes: string[]}} skeleton
 * @param {Object} [opts]
 * @param {function(Session): (Map|null)} [opts.triangulationResultsFor]
 * @returns {{
 *   reordered: Array<{session: Session, name: string}>,
 *   mismatched: Array<{session: Session, name: string, missing: string[], extra: string[]}>,
 *   refused: Array<{session: Session, name: string, reason: string}>
 * }}
 */
export function adoptSkeletonNodeOrder(sessions, skeleton, opts) {
    opts = opts || {};
    var report = { reordered: [], mismatched: [], refused: [] };
    var target = (skeleton && skeleton.nodes) || [];
    var done = new Set();
    for (var i = 0; i < (sessions || []).length; i++) {
        var session = sessions[i];
        if (!session || done.has(session)) continue;
        done.add(session);
        var current = session.skeleton && session.skeleton.nodes;
        if (!current || current.length === 0 || current === target) continue;
        var name = sessionLabel(session, i);
        var r = nodeOrderRemap(target, current);
        if (r.kind === 'same') continue;
        if (r.kind === 'mismatch') {
            report.mismatched.push({ session: session, name: name, missing: r.missing, extra: r.extra });
            continue;
        }
        var res = permuteSessionNodes(session, r.perm, {
            triangulationResults: opts.triangulationResultsFor ? opts.triangulationResultsFor(session) : null,
        });
        if (res.ok) report.reordered.push({ session: session, name: name });
        else report.refused.push({ session: session, name: name, reason: res.reason });
    }
    return report;
}

function sessionLabel(session, i) {
    return (session && session.name) ? String(session.name) : ('session ' + (i + 1));
}

/**
 * The status-bar clause for an adoption report, or '' when there is nothing
 * to say. Names every session that was re-ordered, and every one whose
 * keypoints now carry names that may not be theirs.
 *
 * @param {ReturnType<typeof adoptSkeletonNodeOrder>} report
 * @returns {{text: string, warn: boolean}}
 */
export function describeSkeletonAdoption(report) {
    var names = function (list) { return list.map(function (e) { return e.name; }).join(', '); };
    var parts = [];
    if (report.reordered.length) parts.push('re-ordered ' + names(report.reordered) + ' into its node order by name');
    if (report.mismatched.length) parts.push('node names differ in ' + names(report.mismatched));
    if (report.refused.length) {
        parts.push('could not re-order ' + report.refused.map(function (e) {
            return e.name + ' (' + e.reason + ')';
        }).join(', '));
    }
    var warn = report.mismatched.length + report.refused.length > 0;
    return { text: parts.join('; ') + (warn ? ' — applied by column there, so node names may be wrong' : ''), warn: warn };
}
