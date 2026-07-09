// ui/custom-delete-ops.js — Pure, DOM-free logic backing the
// "Custom Instance Delete…" modal (Edit menu). Mirrors SLEAP's
// sleap/gui/dialogs/delete.py DeleteDialog, expanded to LUCID's 2D
// datatypes: grouped instances (InstanceGroup members), ungrouped
// instances (UnlinkedInstance pool), and reprojections
// (InstanceGroup.reprojectedInstances).
//
// This module imports NO project modules (it only calls methods on the
// Session objects passed in), so it is safe to bridge into the browser
// test runner and unit test in isolation — same contract as
// ui/track-identity-ops.js. The DOM modal (`showCustomDeleteModal`) lives
// in ui/ui-wiring.js and consumes these two functions.
//
// TYPE semantics (matching SLEAP's "all instances" = all real labels):
//   'user'        → observed user labels only
//   'predicted'   → observed predicted labels only
//   'all'         → user + predicted (observed labels; NOT reprojections)
//   'reprojected' → triangulation reprojections only (derived; regenerate
//                   on re-triangulation)

/**
 * @typedef {Object} DeleteFilters
 * @property {'user'|'predicted'|'all'|'reprojected'} type
 * @property {'any'|'grouped'|'ungrouped'} grouping
 * @property {string|null} view          Camera name, or null for all views.
 * @property {'any'|'none'|'specific'} trackMode
 * @property {number|null} trackIdx       Track index when trackMode==='specific'.
 * @property {'any'|'none'|'specific'} identityMode
 * @property {number|null} identityId     Identity id when identityMode==='specific'.
 * @property {'currentFrame'|'currentSession'|'allSessions'|'clip'|'exceptClip'} frameScope
 */

/**
 * @typedef {Object} DeleteContext
 * @property {Object} currentSession
 * @property {number} currentFrame
 * @property {[number,number]|null} clipRange  Inclusive [start, end] frame range.
 */

function _framesInScope(session, scope, ctx) {
    if (scope === 'currentFrame') return [ctx.currentFrame];
    var all = new Set();
    session.frameGroups.forEach(function (_v, k) { all.add(k); });
    session.instanceGroups.forEach(function (_v, k) { all.add(k); });
    var frames = Array.from(all);
    if (scope === 'currentSession' || scope === 'allSessions') return frames;
    var lo = ctx.clipRange ? ctx.clipRange[0] : 0;
    var hi = ctx.clipRange ? ctx.clipRange[1] : 0;
    if (scope === 'clip') return frames.filter(function (f) { return f >= lo && f <= hi; });
    if (scope === 'exceptClip') return frames.filter(function (f) { return f < lo || f > hi; });
    return frames;
}

function _sessionsInScope(sessions, filters, ctx) {
    if (filters.frameScope === 'allSessions') return sessions.slice();
    return [ctx.currentSession];
}

function _typeMatchesObserved(instType, filterType) {
    if (filterType === 'user') return instType === 'user';
    if (filterType === 'predicted') return instType === 'predicted';
    if (filterType === 'all') return instType === 'user' || instType === 'predicted';
    return false; // 'reprojected' handled via reprojection targets, not observed
}

function _trackMatches(trackIdx, filters) {
    if (filters.trackMode === 'any') return true;
    if (filters.trackMode === 'none') return trackIdx == null;
    return trackIdx === filters.trackIdx;
}

function _identityMatches(session, camName, trackIdx, frameIdx, filters) {
    if (filters.identityMode === 'any') return true;
    var idId = session.getIdentityIdForTrack(camName, trackIdx, frameIdx);
    if (filters.identityMode === 'none') return idId == null;
    return idId === filters.identityId;
}

// For reprojection targets (group-level): identity matches the group's
// identityId; track matches if any observed member carries the track.
function _groupTrackMatches(group, filters) {
    if (filters.trackMode === 'any') return true;
    for (var pair of group.instances) {
        var inst = pair[1];
        if (filters.trackMode === 'none') { if (inst.trackIdx == null) return true; }
        else if (inst.trackIdx === filters.trackIdx) return true;
    }
    return false;
}

function _groupIdentityMatches(group, filters) {
    if (filters.identityMode === 'any') return true;
    var idId = (group.identityId != null && group.identityId >= 0) ? group.identityId : null;
    if (filters.identityMode === 'none') return idId == null;
    return idId === filters.identityId;
}

/**
 * Build the list of deletion targets for the given filters. Pure — reads
 * the model but mutates nothing.
 *
 * @param {Object[]} sessions   All sessions (used only for 'allSessions').
 * @param {DeleteFilters} filters
 * @param {DeleteContext} ctx
 * @returns {{targets: Object[], count: number, frameCount: number, sessionCount: number}}
 *   Each target is one of:
 *     {kind:'grouped',    session, frameIdx, group, camName, inst}
 *     {kind:'unlinked',   session, frameIdx, ul}
 *     {kind:'reprojGroup',session, frameIdx, group, n}   (n = # reprojections)
 *     {kind:'reprojView', session, frameIdx, group, camName}
 */
export function collectDeletionTargets(sessions, filters, ctx) {
    var targets = [];
    var frameSet = new Set();
    var sessionSet = new Set();
    var wantObserved = filters.type !== 'reprojected';
    var wantReproj = filters.type === 'reprojected';
    var wantGrouped = filters.grouping !== 'ungrouped';
    var wantUngrouped = filters.grouping !== 'grouped';
    var view = filters.view || null;

    var scopeSessions = _sessionsInScope(sessions, filters, ctx);
    scopeSessions.forEach(function (session) {
        if (!session) return;
        var frames = _framesInScope(session, filters.frameScope, ctx);
        frames.forEach(function (frameIdx) {
            var fg = session.frameGroups.get(frameIdx);
            var groups = session.getInstanceGroupsForFrame(frameIdx);

            // Grouped observed instances (members of an InstanceGroup).
            if (wantObserved && wantGrouped) {
                groups.forEach(function (group) {
                    group.instances.forEach(function (inst, camName) {
                        if (view && camName !== view) return;
                        if (!_typeMatchesObserved(inst.type, filters.type)) return;
                        if (!_trackMatches(inst.trackIdx, filters)) return;
                        if (!_identityMatches(session, camName, inst.trackIdx, frameIdx, filters)) return;
                        targets.push({ kind: 'grouped', session: session, frameIdx: frameIdx, group: group, camName: camName, inst: inst });
                        frameSet.add(session.name + ':' + frameIdx);
                        sessionSet.add(session);
                    });
                });
            }

            // Ungrouped observed instances (UnlinkedInstance pool).
            if (wantObserved && wantUngrouped && fg) {
                fg.unlinkedInstances.forEach(function (list, camName) {
                    if (view && camName !== view) return;
                    list.forEach(function (ul) {
                        var inst = ul.instance;
                        if (!_typeMatchesObserved(inst.type, filters.type)) return;
                        if (!_trackMatches(inst.trackIdx, filters)) return;
                        if (!_identityMatches(session, camName, inst.trackIdx, frameIdx, filters)) return;
                        targets.push({ kind: 'unlinked', session: session, frameIdx: frameIdx, ul: ul, camName: camName, inst: inst });
                        frameSet.add(session.name + ':' + frameIdx);
                        sessionSet.add(session);
                    });
                });
            }

            // Reprojections (only exist on groups).
            if (wantReproj && wantGrouped) {
                groups.forEach(function (group) {
                    if (!group.reprojectedInstances || group.reprojectedInstances.size === 0) return;
                    if (!_groupTrackMatches(group, filters)) return;
                    if (!_groupIdentityMatches(group, filters)) return;
                    if (view) {
                        if (group.reprojectedInstances.has(view)) {
                            targets.push({ kind: 'reprojView', session: session, frameIdx: frameIdx, group: group, camName: view });
                            frameSet.add(session.name + ':' + frameIdx);
                            sessionSet.add(session);
                        }
                    } else {
                        targets.push({ kind: 'reprojGroup', session: session, frameIdx: frameIdx, group: group, n: group.reprojectedInstances.size });
                        frameSet.add(session.name + ':' + frameIdx);
                        sessionSet.add(session);
                    }
                });
            }
        });
    });

    var count = 0;
    targets.forEach(function (t) { count += (t.kind === 'reprojGroup') ? t.n : 1; });
    return { targets: targets, count: count, frameCount: frameSet.size, sessionCount: sessionSet.size };
}

function _clearGroupTriangulation(group) {
    if (group.reprojectedInstances && typeof group.reprojectedInstances.clear === 'function') {
        group.reprojectedInstances.clear();
    }
    group.reprojections = null;
    group.observedPoints = null;
    group.points3d = null;
    group.dirty = true;
}

/**
 * Apply the deletions described by `targets` to the model. Mutates the
 * Session objects. Does NOT touch app-level caches (e.g.
 * state.triangulationResults) — the returned `purgedGroups` tells the
 * caller which groups need their triangulation cache purged and overlays
 * refreshed.
 *
 * Grouped-member deletions follow the same cascade as
 * InteractionManager._deleteSelected: a group that loses all members is
 * removed; one dropping to a single survivor is unlinked back to the
 * pool (promoting a formerly-mixed survivor to user); a partially-emptied
 * group is marked dirty. Every group that loses a member — or whose
 * reprojections are cleared — is reported in `purgedGroups`.
 *
 * @param {Object[]} targets  From collectDeletionTargets().
 * @returns {{purgedGroups: Object[], sessions: Object[]}}
 */
export function executeDeletion(targets) {
    // Bucket grouped-member targets by (session, frameIdx, group) so the
    // full-vs-partial-vs-lone-survivor decision is made once per group.
    var groupBuckets = new Map(); // group -> {session, frameIdx, group, cams:Set}
    var unlinkedTargets = [];
    var reprojGroupTargets = [];
    var reprojViewTargets = [];

    targets.forEach(function (t) {
        if (t.kind === 'grouped') {
            var b = groupBuckets.get(t.group);
            if (!b) { b = { session: t.session, frameIdx: t.frameIdx, group: t.group, cams: new Set() }; groupBuckets.set(t.group, b); }
            b.cams.add(t.camName);
        } else if (t.kind === 'unlinked') {
            unlinkedTargets.push(t);
        } else if (t.kind === 'reprojGroup') {
            reprojGroupTargets.push(t);
        } else if (t.kind === 'reprojView') {
            reprojViewTargets.push(t);
        }
    });

    var purgedGroups = [];
    var sessions = new Set();

    // 1. Grouped members.
    groupBuckets.forEach(function (b) {
        var session = b.session, frameIdx = b.frameIdx, group = b.group;
        sessions.add(session);

        // Snapshot mixed state before removing anything.
        var hasUser = false, hasPred = false;
        group.instances.forEach(function (inst) {
            if (inst.type === 'user') hasUser = true;
            else if (inst.type === 'predicted') hasPred = true;
        });
        var wasMixed = hasUser && hasPred;

        var removeCams = Array.from(b.cams).filter(function (c) { return group.instances.has(c); });
        var remaining = group.instances.size - removeCams.length;

        if (remaining <= 0) {
            session.removeInstanceGroup(frameIdx, group);
            purgedGroups.push({ session: session, frameIdx: frameIdx, group: group });
            return;
        }

        // Per-camera removal (mirrors interaction.js:1864-1886).
        var fg = session.frameGroups.get(frameIdx);
        removeCams.forEach(function (cam) {
            var inst = group.instances.get(cam);
            group.instances.delete(cam);
            if (group.observedPoints) delete group.observedPoints[cam];
            if (fg) {
                var arr = fg.instances.get(cam);
                if (arr) {
                    var i = arr.indexOf(inst);
                    if (i >= 0) arr.splice(i, 1);
                    if (arr.length === 0) fg.instances.delete(cam);
                }
            }
        });

        if (group.instances.size === 0) {
            session.removeInstanceGroup(frameIdx, group);
        } else if (group.instances.size === 1) {
            session.unlinkGroup(frameIdx, group, wasMixed);
            _clearGroupTriangulation(group);
        } else {
            // Partially emptied → its 3D/reprojection is now stale. Clear the
            // model here so every session (not just the active one the modal
            // purges) stays consistent; dirty=true triggers re-triangulation.
            _clearGroupTriangulation(group);
        }
        purgedGroups.push({ session: session, frameIdx: frameIdx, group: group });
    });

    // 2. Ungrouped instances.
    unlinkedTargets.forEach(function (t) {
        sessions.add(t.session);
        var fg = t.session.frameGroups.get(t.frameIdx);
        if (fg) fg.removeUnlinkedById(t.ul.id);
    });

    // 3. Reprojections — whole group.
    reprojGroupTargets.forEach(function (t) {
        sessions.add(t.session);
        _clearGroupTriangulation(t.group);
        purgedGroups.push({ session: t.session, frameIdx: t.frameIdx, group: t.group });
    });

    // 4. Reprojections — single view (leave other views/3D intact).
    reprojViewTargets.forEach(function (t) {
        sessions.add(t.session);
        if (t.group.reprojectedInstances) t.group.reprojectedInstances.delete(t.camName);
        t.group.dirty = true;
    });

    return { purgedGroups: purgedGroups, sessions: Array.from(sessions) };
}
