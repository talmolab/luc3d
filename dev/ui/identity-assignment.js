// ui/identity-assignment.js — Pass 3f extraction
//
// All workflows for grouping instances into identities: track/identity
// helpers, manual assignment and edit-group mode. Plus
// purgeTriangulationDataForGroup, the detach-reprojection helper every
// grouping workflow needs after unlinking/removing a group.

import { state, interactionManager, viewport3d, timeline } from './app-state.js?v=cd3b372b9ef8';
import { UnlinkedInstance } from '../pose/pose-data.js?v=cd3b372b9ef8';
import { getInstanceGroupsForFrame, updateTimelineForFrame } from '../pose/triangulation.js?v=cd3b372b9ef8';
import { drawAllOverlays } from './rendering.js?v=cd3b372b9ef8';
import { updateInfoPanel } from './info-panel.js?v=cd3b372b9ef8';
import { markDirty, setStatus } from '../import-export/save-load.js?v=cd3b372b9ef8';

// ============================================
// Track/Identity helpers (top-level so all code can access)
// ============================================

/**
 * Swap two track ids DURABLY across a frame range (luc3d #195).
 *
 * Editing `Instance.trackIdx` on resident frames is not enough on a lazily
 * reopened project, for two compounding reasons:
 *
 *  1. Only a handful of frames are RESIDENT — measured 31 of 180,210 — because
 *     2D materializes on scrub. A `for (... of session.frameGroups)` loop
 *     therefore touches ~nothing and still returns a plausible count.
 *  2. Even the frames it does touch do not keep the edit: a PREDICTED frame is
 *     dropped on window release and rebuilt from the columnar store next time it
 *     hydrates, so the new `trackIdx` evaporates. Hydrating more frames cannot
 *     fix this — the edit has to land somewhere durable.
 *
 * The durable place is the store's own `instancesData.track` column, which is
 * both what rehydration reads and what `appendStore` writes on save.
 * `SioLazyLoader.remapTracksFromIdentity` is exactly that primitive (it is how
 * "Propagate IDs → Tracks" works), and it also rebuilds each camera's sparse
 * `trackOccupancy` so the Tracks Timeline follows. Cost is one pass over the
 * track column — no frame materialization, no extra allocation.
 *
 * Identity follows automatically: `frameIdentityMap` is keyed by
 * (frameIdx, camName, trackIdx), so an instance that moves from track A to track
 * B now resolves to B's identity — which is what "swap these two animals" means.
 *
 * @param {Object} session
 * @param {number} trackA
 * @param {number} trackB
 * @param {number} frameStart inclusive
 * @param {number} frameEnd   inclusive
 * @param {string|null} [camName] restrict to one camera (null = every camera)
 * @returns {number} instance rows whose track id actually changed, or -1 when
 *   there is no windowing loader (caller should fall back to resident-only).
 */
function swapTracksInStore(session, trackA, trackB, frameStart, frameEnd, camName) {
    var loader = session.lazyLoader;
    if (!loader || typeof loader.remapTracksFromIdentity !== 'function') return -1;
    var res = loader.remapTracksFromIdentity(session.tracks, function (cam, frameIdx, oldTrk) {
        if (camName != null && cam !== camName) return oldTrk;
        if (frameIdx < frameStart || frameIdx > frameEnd) return oldTrk;
        if (oldTrk === trackA) return trackB;
        if (oldTrk === trackB) return trackA;
        return oldTrk;
    });
    if (res && res.errorRows) {
        console.error('[swapTracksInStore] ' + res.errorRows +
            ' row(s) failed to remap; first error:', res.firstError);
    }
    return res ? res.changed : 0;
}

/**
 * Apply the same A<->B swap to the IN-MEMORY instances (luc3d #195).
 *
 * Covers two maps with different lifetimes:
 *  - `instanceGroups` is WHOLE-PROJECT (rebuilt in full on reopen by
 *    `reconstructInstanceGroupsFromSessionLazy`). Its members are lightweight
 *    placeholders whose `trackIdx` came from the store at reconstruction time.
 *    Group-level operations read that field — `ui/track-identity-ops.js`
 *    `deleteTrackAt` decides which groups to DISSOLVE from it — so leaving it
 *    stale after a store rewrite makes a later track delete dissolve the wrong
 *    groups.
 *  - `frameGroups` holds only the RESIDENT 2D frames, and is what the canvas and
 *    info panel read, so it must be updated for the change to be visible now.
 *
 * A `seen` set is mandatory, not defensive: a resident frame's `fg.instances`
 * entries are usually the SAME objects as that frame's `instanceGroups` members
 * (the same sharing that forces `deleteTrackAt`'s own `seen` guard). Swapping such
 * an instance in both passes would swap it TWICE and silently restore the original
 * value — a self-cancelling no-op that looks like the operation never ran.
 *
 * @returns {number} distinct instances whose trackIdx actually changed
 */
function swapTracksInMemory(session, trackA, trackB, frameStart, frameEnd, camName) {
    var seen = new Set();
    var changed = 0;
    function apply(inst) {
        if (!inst || seen.has(inst)) return;
        seen.add(inst);
        if (inst.trackIdx === trackA) { inst.trackIdx = trackB; changed++; }
        else if (inst.trackIdx === trackB) { inst.trackIdx = trackA; changed++; }
    }
    if (session.instanceGroups) {
        for (var [gF, gList] of session.instanceGroups) {
            if (gF < frameStart || gF > frameEnd) continue;
            for (var gi = 0; gi < gList.length; gi++) {
                for (var [gCam, gInst] of gList[gi].instances) {
                    if (camName != null && gCam !== camName) continue;
                    apply(gInst);
                }
            }
        }
    }
    for (var [rF, fg] of session.frameGroups) {
        if (rF < frameStart || rF > frameEnd) continue;
        for (var [rCam, insts] of fg.instances) {
            if (camName != null && rCam !== camName) continue;
            for (var i = 0; i < insts.length; i++) apply(insts[i]);
        }
        if (fg.unlinkedInstances) {
            for (var [uCam, ulList] of fg.unlinkedInstances) {
                if (camName != null && uCam !== camName) continue;
                for (var u = 0; u < ulList.length; u++) apply(ulList[u].instance);
            }
        }
    }
    return changed;
}

/**
 * Swap-assign a track: if another instance on the same frame/camera
 * already has the target track, swap their tracks instead of creating
 * a duplicate. Then propagate the swap forward.
 */
export function swapAssignTrack(frameIdx, camName, instance, newTrack, session) {
    markDirty();
    var oldTrack = instance.trackIdx;
    if (oldTrack === newTrack) return 0;

    var fg = session.getFrameGroup(frameIdx);
    if (!fg) return 0;

    var camInsts = fg.getInstances(camName);
    var ulInsts = fg.getUnlinkedInstances(camName);

    // Swap on current frame
    for (var i = 0; i < camInsts.length; i++) {
        if (camInsts[i] !== instance && camInsts[i].trackIdx === newTrack) {
            camInsts[i].trackIdx = oldTrack;
        }
    }
    for (var u = 0; u < ulInsts.length; u++) {
        if (ulInsts[u].instance !== instance && ulInsts[u].instance.trackIdx === newTrack) {
            ulInsts[u].instance.trackIdx = oldTrack;
        }
    }
    instance.trackIdx = newTrack;

    // DURABLE (luc3d #195): the current-frame swap above and the resident
    // propagation below both mutate `Instance.trackIdx` only, which does NOT
    // survive on a lazily reopened project — the instances are predicted, so
    // their frames are dropped on window release and rebuilt from the columnar
    // store, discarding the edit. (Nor does the resident loop even SEE most
    // frames: 31 of 180,210 were resident in the measured case.)
    //
    // A blanket oldTrack<->newTrack swap on this camera from `frameIdx` forward
    // is exactly equivalent to what the two resident passes compute: when some
    // other instance holds `newTrack` both are exchanged, and when none does the
    // swap degenerates to the one-way `oldTrack -> newTrack` reassign, which is
    // the same result. So one store pass covers the current frame AND the
    // propagation, durably.
    var storeChanged = swapTracksInStore(session, oldTrack, newTrack, frameIdx, Infinity, camName);
    var residentOnly = (storeChanged < 0);

    // Propagate the swap forward IN MEMORY. This covers the resident
    // `frameGroups` (so the canvas and info panel update now) AND the
    // project-wide `instanceGroups` placeholders — the latter matters because
    // group-level operations read `trackIdx` off those members rather than off
    // the store: leaving them stale here makes a later `deleteTrackAt` dissolve
    // the WRONG groups (see `swapTracksInMemory`, and the store-vs-memory
    // divergence it exists to prevent).
    //
    // The range starts at `frameIdx + 1` because the current frame was already
    // swapped explicitly above; re-applying a blanket swap to it would undo that.
    // (The current frame is displayed, hence hydrated, so its group members are
    // the same objects as its `fg.instances` entries and were updated with them.)
    // Rows are already counted by the store pass, so they must not be counted
    // again.
    var memChanged = swapTracksInMemory(session, oldTrack, newTrack, frameIdx + 1, Infinity, camName);
    return residentOnly ? memChanged : storeChanged;
}

export function assignTrackToSelected(trackIdx) {
    markDirty();
    if (!state.session) return;
    var sel = interactionManager ? interactionManager.selectedInstanceGroup : null;
    var selUl = interactionManager ? interactionManager.selectedUnlinked : null;
    if (!sel && !selUl) { setStatus('Select an instance first', 'warning'); return; }

    if (sel) {
        var totalProp = 0;
        for (var [cn, inst] of sel.instances) {
            totalProp += swapAssignTrack(state.currentFrame, cn, inst, trackIdx, state.session);
        }
        sel.trackIdx = trackIdx;
        setStatus('Assigned ' + state.session.tracks[trackIdx] + (totalProp > 0 ? ' (swapped & propagated ' + totalProp + ')' : ''), 'success');
    } else if (selUl) {
        var propagated = swapAssignTrack(state.currentFrame, selUl.cameraName, selUl.instance, trackIdx, state.session);
        setStatus('Assigned ' + state.session.tracks[trackIdx] + (propagated > 0 ? ' (swapped & propagated ' + propagated + ')' : ''), 'success');
    }
    drawAllOverlays(state.currentFrame);
    updateInfoPanel();
    if (timeline) timeline.refreshTracks(state.session, { keepSize: true });
}

/**
 * Propagate identity forward from current frame using per-frame overrides.
 */
export function propagateIdentityForward(trackIdx, identityId, cameraName) {
    var session = state.session;
    if (!session) return 0;
    return session.propagateIdentity(state.currentFrame, cameraName, trackIdx, identityId);
}

/**
 * The identity a selection CURRENTLY reads as on `frameIdx`, resolved exactly
 * the way the canvas does (`ui/overlays.js` `getGroupColor`): the per-frame
 * entry for one of the selection's own live (camera, trackIdx) pairs first, then
 * the group-level field as a fallback for a group with no per-frame entry yet.
 *
 * Reading `group.identityId` FIRST would be wrong here for the same reason it is
 * wrong for coloring: it is only refreshed on the frame where an identity was
 * last assigned, so it is stale on every other frame (issue #155).
 *
 * @param {Array<[string, number]>} camTrackPairs (cameraName, trackIdx) pairs
 * @param {number|null|undefined} groupIdentityId fallback, or null for none
 * @returns {number|null} a real identity id, or null when the selection has none
 */
function resolveCurrentIdentityId(session, frameIdx, camTrackPairs, groupIdentityId) {
    for (var i = 0; i < camTrackPairs.length; i++) {
        var cn = camTrackPairs[i][0], trk = camTrackPairs[i][1];
        if (cn == null || trk == null || trk < 0) continue;
        var v = session.getIdentityIdForTrack(cn, trk, frameIdx);
        if (v != null && v >= 0) return v;
    }
    if (groupIdentityId != null && groupIdentityId >= 0) return groupIdentityId;
    return null;
}

/**
 * Apply a MANUAL identity switch from `frameIdx` through the end of the
 * timeline (luc3d #172).
 *
 * The single entry point for "the user picked a different ID for this
 * instance" — the 1-9 hotkeys, the Linked Instance Groups identity dropdown and
 * the unlinked-row identity dropdown all route here so they cannot drift.
 *
 * Two modes, chosen by whether there is an identity to swap AWAY from:
 *
 *  - **swap** (the normal correction). The selection already reads as identity
 *    A and the user picks B, so A and B are EXCHANGED from this frame to the end
 *    of the project, in every view — `Session.swapIdentitiesForward`. This is
 *    the semantics the issue asks for and the semantics SLEAP's `track_swap`
 *    has for tracks: the correction is a statement about the rest of the video,
 *    not about the current tracklet. Crucially it does not depend on raw track
 *    continuity, so it survives the track fragmentation that made the old
 *    per-track propagation stop after a few hundred frames.
 *
 *  - **propagate** (no identity to swap). The selection has no identity yet
 *    (a fresh project, a just-grouped group, or the user picked "none"), so
 *    there is no value to exchange. Fall back to the per-camera, per-track
 *    forward stamp — the only continuity signal available in that state.
 *
 * ALL VIEWS, deliberately. An identity names a physical animal, which is a 3D
 * fact shared by every camera (`InstanceGroup.identityId` is a single
 * per-group field, not per view). Restricting the swap to the cameras the
 * selected group happens to have an instance in at this instant — what the old
 * `for (cam of sel.instances) propagateIdentityForward(...)` loop did — leaves
 * the other views asserting the opposite identity, which is both visibly wrong
 * and corrupts identity-based grouping. It is also the reporter's observation on
 * #172 verbatim: "the propagation appears limited to tracks visible in the
 * current view". A view where the animal is occluded on exactly this frame got
 * nothing at all.
 *
 * SINGLE-VIEW corrections are the exception, via `scopeCamera` (luc3d #201). An
 * UNGROUPED instance is one 2D detection that belongs to no cross-view bundle,
 * so a correction on its row is a statement about that camera only — and fixing
 * one view is the whole reason to ungroup in the first place (the reported
 * workflow: ungroup, switch the ID on the one view that's wrong, regroup). The
 * all-views argument above applies to a GROUP, which by definition asserts the
 * same animal across cameras; it does not apply to a lone detection. Scoped
 * corrections still swap by identity VALUE, so they stay immune to the raw-track
 * fragmentation that #172 was filed for — see
 * `Session.swapIdentitiesForwardInCamera`.
 *
 * @param {Object} session
 * @param {number} frameIdx the frame the correction was made on (inclusive)
 * @param {Array<[string, number]>} camTrackPairs the selection's live
 *   (cameraName, trackIdx) pairs
 * @param {Object|null} group the selected InstanceGroup, if any
 * @param {number} newIdentityId
 * @param {string} [scopeCamera] restrict the swap to this camera — pass the
 *   unlinked instance's own camera for a single-view correction; omit for a
 *   group (all views).
 * @param {Object} [unlinkedInstance] the unlinked row's own Instance. Needed
 *   for a TRACKLESS instance (luc3d #201): `frameIdentityMap` cannot key a
 *   null track, so its identity lives on the instance
 *   (`Instance.identityId`) and the correction is per-frame by nature — no
 *   track means no linkage to carry it to other frames. Ignored when the
 *   instance has a track.
 * @returns {{mode:string, frames:number, entries:number, oldIdentityId:(number|null), camera:(string|null)}}
 */
export function applyIdentitySwitch(session, frameIdx, camTrackPairs, group, newIdentityId, scopeCamera, unlinkedInstance) {
    // TRACKLESS unlinked row: per-frame instance-level assignment (with an
    // in-frame swap against the row already holding the target identity), not
    // a map operation — there is no track for the map to key or to propagate
    // along. See Session.assignIdentityToUnlinkedTrackless.
    if (unlinkedInstance && unlinkedInstance.trackIdx == null &&
        scopeCamera && newIdentityId != null && newIdentityId >= 0 &&
        session.assignIdentityToUnlinkedTrackless) {
        var tr = session.assignIdentityToUnlinkedTrackless(
            frameIdx, scopeCamera, unlinkedInstance, newIdentityId);
        return {
            mode: 'frame', frames: 1, entries: tr.swappedWithOther ? 2 : 1,
            oldIdentityId: tr.oldIdentityId, camera: scopeCamera,
        };
    }

    var oldIdentityId = resolveCurrentIdentityId(
        session, frameIdx, camTrackPairs, group ? group.identityId : null);

    if (newIdentityId != null && newIdentityId >= 0 &&
        oldIdentityId != null && oldIdentityId >= 0 && oldIdentityId !== newIdentityId) {
        var r;
        if (scopeCamera && session.swapIdentitiesForwardInCamera) {
            r = session.swapIdentitiesForwardInCamera(
                frameIdx, scopeCamera, oldIdentityId, newIdentityId);
            // Deliberately NOT pinning `group.identityId` here: it is one field
            // shared by every view, so writing it would leak a single-view
            // correction into the others. A scoped switch only ever targets an
            // ungrouped instance, which has no group to pin.
            return {
                mode: 'swap', frames: r.frames, entries: r.entries,
                oldIdentityId: oldIdentityId, camera: scopeCamera,
            };
        }
        r = session.swapIdentitiesForward(frameIdx, oldIdentityId, newIdentityId);
        // The swap is by VALUE, so a group whose `identityId` field was stale
        // (or never set) is not caught by it — pin the selected group directly.
        if (group) group.identityId = newIdentityId;
        return {
            mode: 'swap', frames: r.frames, entries: r.entries,
            oldIdentityId: oldIdentityId, camera: null,
        };
    }

    // No identity to swap away from: per-camera, per-track forward stamp.
    // Trackless members are passed through UNCHANGED (a `null` trackIdx keys the
    // "-1" fim slot) — exactly what the per-camera loops this replaced did, so
    // assigning an identity to a trackless group behaves as before.
    if (group) session.assignIdentityToGroup(group, newIdentityId);
    var propagated = 0;
    for (var i = 0; i < camTrackPairs.length; i++) {
        var cn = camTrackPairs[i][0], trk = camTrackPairs[i][1];
        if (cn == null) continue;
        if (scopeCamera && cn !== scopeCamera) continue;
        propagated += session.propagateIdentity(frameIdx, cn, trk, newIdentityId);
    }
    return {
        mode: 'propagate', frames: propagated, entries: propagated,
        oldIdentityId: oldIdentityId, camera: scopeCamera || null,
    };
}

/**
 * Status text for an `applyIdentitySwitch` result. Shared so every call site
 * reports the SAME, honest number: the count is what actually changed, never a
 * per-frame estimate — a plausible-looking count over a silently truncated
 * range is exactly how #172 hid.
 */
export function describeIdentitySwitch(session, result, identityName) {
    var msg = 'Assigned ' + identityName;
    if (!result || !result.frames) return msg;
    if (result.mode === 'swap') {
        var oldName = null;
        var oldIdent = session.getIdentity ? session.getIdentity(result.oldIdentityId) : null;
        if (oldIdent) oldName = oldIdent.name;
        // Name the actual scope — a single-view correction must not claim "all
        // views", which is the kind of plausible-but-wrong report that hid #172.
        msg += ' (swapped ' + result.frames.toLocaleString('en-US') + ' frames to end of timeline, ' +
            (result.camera ? result.camera + ' only' : 'all views') +
            (oldName ? ' — was ' + oldName : '') + ')';
    } else if (result.mode === 'frame') {
        // Trackless: the instance has no track linkage, so the correction is
        // honestly per-frame — say so instead of implying propagation.
        var oldNameF = null;
        var oldIdentF = session.getIdentity ? session.getIdentity(result.oldIdentityId) : null;
        if (oldIdentF) oldNameF = oldIdentF.name;
        msg += ' (this frame, ' + (result.camera ? result.camera + ' only' : 'one view') +
            ' — trackless instance' + (oldNameF ? ', was ' + oldNameF : '') + ')';
    } else {
        msg += ' (propagated to ' + result.frames + ' future instances' +
            (result.camera ? ' in ' + result.camera : '') + ')';
    }
    return msg;
}

/**
 * (cameraName, trackIdx) pairs for every member of a group — INCLUDING trackless
 * members (`trackIdx == null`), which the propagate fallback still needs to
 * stamp. `resolveCurrentIdentityId` skips those itself.
 */
function groupCamTrackPairs(group) {
    var pairs = [];
    if (!group || !group.instances) return pairs;
    for (var [cn, inst] of group.instances) {
        if (inst) pairs.push([cn, inst.trackIdx]);
    }
    return pairs;
}

/**
 * Assign identity to selected instance/group and propagate forward.
 */
export function assignIdentityToSelected(identityId, identityName) {
    var session = state.session;
    if (!session) return;
    var sel = interactionManager ? interactionManager.selectedInstanceGroup : null;
    var selUl = interactionManager ? interactionManager.selectedUnlinked : null;
    if (!sel && !selUl) {
        setStatus('Select an instance first', 'warning');
        return;
    }

    var result = null;
    if (sel) {
        markDirty();
        result = applyIdentitySwitch(session, state.currentFrame, groupCamTrackPairs(sel), sel, identityId);
    } else if (selUl) {
        markDirty();
        // An ungrouped instance is a single view's detection — scope the switch
        // to its own camera (luc3d #201).
        result = applyIdentitySwitch(session, state.currentFrame,
            [[selUl.cameraName, selUl.instance.trackIdx]], null, identityId,
            selUl.cameraName, selUl.instance);
    }

    drawAllOverlays(state.currentFrame);
    updateInfoPanel();
    if (timeline) timeline.refreshTracks(state.session, { keepSize: true });

    setStatus(describeIdentitySwitch(session, result, identityName), 'success');
}


// Detach all reprojection state tied to a group on a given frame.
// Used after unlinking/removing a group so the info panel and
// overlays don't keep showing orphaned reprojection data.
export function purgeTriangulationDataForGroup(frameIdx, group) {
    if (!group) return;
    if (group.reprojectedInstances && typeof group.reprojectedInstances.clear === 'function') {
        group.reprojectedInstances.clear();
    }
    group.reprojections = null;
    group.points3d = null;
    var existing = state.triangulationResults.get(frameIdx);
    if (existing) {
        var filtered = existing.filter(function (r) { return r.group !== group; });
        if (filtered.length === 0) {
            state.triangulationResults.delete(frameIdx);
        } else {
            state.triangulationResults.set(frameIdx, filtered);
        }
    }
}


// ============================================
// Manual Identity Assignment
// ============================================

export var manualAssignState = null; // { toast: HTMLElement }

export function getTotalUnlinkedCount() {
    if (!state.session) return 0;
    var fg = state.session.getFrameGroup(state.currentFrame);
    if (!fg) return 0;
    var total = 0;
    for (var i = 0; i < state.views.length; i++) {
        var ul = fg.getUnlinkedInstances(state.views[i].name);
        if (ul) total += ul.length;
    }
    return total;
}

export function cleanupManualAssignment() {
    if (!manualAssignState) return;
    if (manualAssignState.toast && manualAssignState.toast.parentNode) {
        manualAssignState.toast.parentNode.removeChild(manualAssignState.toast);
    }
    manualAssignState = null;
}

export function startManualAssignment() {
    // Clean up any existing manual assignment
    cleanupManualAssignment();
    // Mutual exclusion: exit edit group mode
    if (editGroupState) finishEditGroup();

    if (!state.session) return;
    var fg = state.session.getFrameGroup(state.currentFrame);
    if (!fg) {
        setStatus('No frame data for manual assignment', 'warning');
        return;
    }

    var totalUnlinked = getTotalUnlinkedCount();
    if (totalUnlinked === 0) {
        setStatus('No unlinked instances available for assignment', 'warning');
        return;
    }

    // Enable assignment mode
    interactionManager.setAssignmentMode(true);

    // Create toast
    var toast = document.createElement('div');
    toast.className = 'auto-assign-toast';
    toast.innerHTML =
        '<span id="manualAssignToastText">Frame ' + state.currentFrame.toLocaleString('en-US') +
        '. Select instances for manual Identity Assignment. Instances Selected: 0/' +
        totalUnlinked + '</span>' +
        '<button id="manualAssignCancel">Cancel</button>' +
        '<button id="manualAssignGroup" class="primary">Group</button>';
    document.getElementById('menuBar').appendChild(toast);

    manualAssignState = { toast: toast };

    toast.querySelector('#manualAssignCancel').addEventListener('click', function () {
        interactionManager.setAssignmentMode(false);
        cleanupManualAssignment();
        drawAllOverlays(state.currentFrame);
    });

    toast.querySelector('#manualAssignGroup').addEventListener('click', function () {
        if (!interactionManager || interactionManager.assignmentSelection.length < 2) {
            setStatus('Select at least two instances first', 'warning');
            return;
        }
        interactionManager._createGroupFromAssignment();
    });
}

// ============================================
// Edit Group Mode
// ============================================

export var editGroupState = null; // { toast, group, originalInstances: Map }

export function startEditGroup(group) {
    // Cleanup any existing assignment/edit state
    cleanupManualAssignment();
    cleanupEditGroup();
    if (interactionManager && interactionManager.assignmentMode) {
        interactionManager.setAssignmentMode(false);
    }

    // Snapshot group.instances (clone Map with cloned instance refs).
    // Also capture whether the group was mixed at edit-start so the
    // "treat mixed groups as user" rule can survive removals that
    // would otherwise leave the group all-predicted (or down to a
    // lone predicted) and lose the mixed signal.
    var originalInstances = new Map();
    var _hasUserOrig = false, _hasPredOrig = false;
    for (var [camName, inst] of group.instances) {
        originalInstances.set(camName, inst);
        if (inst.type === 'user') _hasUserOrig = true;
        else if (inst.type === 'predicted') _hasPredOrig = true;
    }
    var wasMixed = _hasUserOrig && _hasPredOrig;

    interactionManager.setEditGroupMode(true, group);

    // Create toast
    var toast = document.createElement('div');
    toast.className = 'auto-assign-toast';
    toast.innerHTML =
        '<span id="editGroupToastText">Editing Group: ' + group.instances.size + ' Instances Selected</span>' +
        '<button id="editGroupCancel">Cancel</button>' +
        '<button id="editGroupContinue" class="primary">Continue</button>';
    document.getElementById('menuBar').appendChild(toast);

    editGroupState = { toast: toast, group: group, originalInstances: originalInstances, wasMixed: wasMixed };

    toast.querySelector('#editGroupCancel').addEventListener('click', function () {
        cancelEditGroup();
    });
    toast.querySelector('#editGroupContinue').addEventListener('click', function () {
        finishEditGroup();
    });
}

export function cancelEditGroup() {
    if (!editGroupState) return;
    var group = editGroupState.group;
    var originalInstances = editGroupState.originalInstances;
    var frameIdx = state.currentFrame;
    var fg = state.session.getFrameGroup(frameIdx);

    // Remove any instances that were added (not in original)
    for (var [camName, inst] of group.instances) {
        if (!originalInstances.has(camName)) {
            // This was added — remove from group and put back as unlinked
            group.instances.delete(camName);
            if (fg) {
                // Remove from FrameGroup linked instances
                var camInstances = fg.instances.get(camName);
                if (camInstances) {
                    var idx = camInstances.indexOf(inst);
                    if (idx >= 0) camInstances.splice(idx, 1);
                    if (camInstances.length === 0) fg.instances.delete(camName);
                }
                // Add back as unlinked
                var ul = new UnlinkedInstance(inst, camName);
                fg.addUnlinkedInstance(camName, ul);
            }
        }
    }

    // Restore any instances that were removed (in original but not current)
    for (var [camName, inst] of originalInstances) {
        if (!group.instances.has(camName)) {
            // This was removed — add back to group
            group.addInstance(camName, inst);
            if (fg) {
                fg.addInstance(camName, inst);
                // Remove from unlinked if it was put there
                var unlinked = fg.getUnlinkedInstances(camName) || [];
                for (var ui = unlinked.length - 1; ui >= 0; ui--) {
                    if (unlinked[ui].instance === inst) {
                        fg.removeUnlinkedById(unlinked[ui].id);
                        break;
                    }
                }
            }
        }
    }

    cleanupEditGroup();
    drawAllOverlays(state.currentFrame);
    updateInfoPanel();
}

export function finishEditGroup() {
    if (!editGroupState) return;
    var group = editGroupState.group;
    var frameIdx = state.currentFrame;

    if (group.instances.size === 0) {
        // Empty group → remove entirely
        state.session.removeInstanceGroup(frameIdx, group);
        purgeTriangulationDataForGroup(frameIdx, group);
        markDirty();
        if (interactionManager) interactionManager.clearSelection();
    } else if (group.instances.size === 1) {
        // A group must contain ≥2 instances by definition. Demote
        // the lone remaining instance back to the unlinked pool and
        // destroy the group. If the group was mixed at edit-start,
        // promote a now-lone predicted survivor to user — the
        // "mixed = user" rule must survive intermediate removals.
        state.session.unlinkGroup(frameIdx, group, !!(editGroupState && editGroupState.wasMixed));
        purgeTriangulationDataForGroup(frameIdx, group);
        markDirty();
        if (interactionManager) interactionManager.clearSelection();
    }

    cleanupEditGroup();
    updateTimelineForFrame(frameIdx);
    if (viewport3d) viewport3d.setFrame(getInstanceGroupsForFrame(frameIdx));
    drawAllOverlays(state.currentFrame);
    updateInfoPanel();
}

export function cleanupEditGroup() {
    if (editGroupState && editGroupState.toast && editGroupState.toast.parentNode) {
        editGroupState.toast.parentNode.removeChild(editGroupState.toast);
    }
    editGroupState = null;
    if (interactionManager) interactionManager.setEditGroupMode(false);
}

export function updateEditGroupToast() {
    if (!editGroupState) return;
    var textEl = document.getElementById('editGroupToastText');
    if (textEl) {
        textEl.textContent = 'Editing Group: ' + editGroupState.group.instances.size + ' Instances Selected';
    }
}

// ============================================
// Track Swap (Pass 3i-4: moved from app.js)
// ============================================

export function swapTracks(trackA, trackB, frameStart, frameEnd) {
    if (!state.session) return 0;
    var session = state.session;
    // Durable first (the columnar store is what save writes and rehydration
    // reads), then one de-duplicated in-memory pass so `instanceGroups` and the
    // resident `frameGroups` agree with it. See both helpers above.
    var storeSwapped = swapTracksInStore(session, trackA, trackB, frameStart, frameEnd, null);
    var memChanged = swapTracksInMemory(session, trackA, trackB, frameStart, frameEnd, null);
    // Report the durable row count when there is a store; otherwise the in-memory
    // count is all there is.
    return storeSwapped < 0 ? memChanged : storeSwapped;
}
