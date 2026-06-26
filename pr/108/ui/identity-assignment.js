// ui/identity-assignment.js — Pass 3f extraction
//
// All workflows for grouping instances into identities: track/identity
// helpers, manual assignment, edit-group mode, automatic assignment,
// single-frame triangulation, and the multi-frame assignment modal.
// Plus purgeTriangulationDataForGroup, the detach-reprojection helper
// every grouping workflow needs after unlinking/removing a group.

import { state, videoController, interactionManager, viewport3d, timeline, paneManager } from './app-state.js';
import { InstanceGroup, UnlinkedInstance } from '../pose/pose-data.js';
import {
    frameHasGroupedUserInstances, getInstanceGroupsForFrame,
    triangulateAndReproject, storeReprojectedInstances,
    reprojectPointsCamera, computeInstanceDistance, hungarianAlgorithm,
    updateTimelineForFrame,
    triangulateCurrentFrame,
} from '../pose/triangulation.js';
import { getDefaultTriangulationMethod } from './settings.js';
import { drawAllOverlays, setReprojErrorVisible } from './rendering.js';
import { updateInfoPanel } from './info-panel.js';
import { markDirty, setStatus } from '../import-export/save-load.js';

// Pass 3i-3: update3DViewport moved to pose/initialization.js.
import { update3DViewport } from '../pose/initialization.js';
// Pass 3h: dockview panel registry now lives in sessions-panes.js.
import { panelRenderers } from './sessions-panes.js';

// ============================================
// Track/Identity helpers (top-level so all code can access)
// ============================================

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

    // Propagate swap to subsequent frames
    var propagated = 0;
    for (var [fIdx, fgP] of session.frameGroups) {
        if (fIdx <= frameIdx) continue;
        var allInsts = [];
        for (var [cn, insts] of fgP.instances) {
            if (cn === camName) for (var j = 0; j < insts.length; j++) allInsts.push(insts[j]);
        }
        for (var [cn2, ulL] of fgP.unlinkedInstances) {
            if (cn2 === camName) for (var k = 0; k < ulL.length; k++) allInsts.push(ulL[k].instance);
        }
        for (var m = 0; m < allInsts.length; m++) {
            if (allInsts[m].trackIdx === oldTrack) { allInsts[m].trackIdx = -99; propagated++; }
        }
        for (var m = 0; m < allInsts.length; m++) {
            if (allInsts[m].trackIdx === newTrack) { allInsts[m].trackIdx = oldTrack; propagated++; }
        }
        for (var m = 0; m < allInsts.length; m++) {
            if (allInsts[m].trackIdx === -99) { allInsts[m].trackIdx = newTrack; }
        }
    }
    return propagated;
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

    var propagated = 0;
    if (sel) {
        session.assignIdentityToGroup(sel, identityId);
        // Use the swap-aware setter on the global map so the per-camera
        // (trackIdx → identity) invariant is preserved when reassigning.
        for (var [cn, inst] of sel.instances) {
            session.assignTrackToIdentity(inst.trackIdx, identityId, cn);
            propagated += propagateIdentityForward(inst.trackIdx, identityId, cn);
        }
    } else if (selUl) {
        session.assignTrackToIdentity(selUl.instance.trackIdx, identityId, selUl.cameraName);
        markDirty();
        propagated = propagateIdentityForward(selUl.instance.trackIdx, identityId, selUl.cameraName);
    }

    drawAllOverlays(state.currentFrame);
    updateInfoPanel();
    if (timeline) timeline.refreshTracks(state.session, { keepSize: true });

    var msg = 'Assigned ' + identityName;
    if (propagated > 0) msg += ' (propagated to ' + propagated + ' future instances)';
    setStatus(msg, 'success');
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
    group.observedPoints = null;
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
    // Clean up any existing manual or auto assignment
    cleanupManualAssignment();
    cleanupAutoAssignment();
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
        '<span id="manualAssignToastText">Frame ' + state.currentFrame +
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
// Automatic Identity Assignment
// ============================================

export var autoAssignState = null; // { selectedViews: Set, toast: HTMLElement }

export function cleanupAutoAssignment() {
    if (!autoAssignState) return;
    // Remove toast
    if (autoAssignState.toast && autoAssignState.toast.parentNode) {
        autoAssignState.toast.parentNode.removeChild(autoAssignState.toast);
    }
    // Remove red highlights and click overlay divs
    document.querySelectorAll('.video-cell').forEach(function (cell) {
        cell.classList.remove('auto-assign-selected');
        if (cell._autoAssignOverlay) {
            cell._autoAssignOverlay.remove();
            delete cell._autoAssignOverlay;
        }
    });
    // Restore yellow selection highlight on active panel
    if (paneManager && paneManager.api) {
        var activePanel = paneManager.api.activePanel;
        if (activePanel) {
            var activeRenderer = panelRenderers.get(activePanel.id);
            if (activeRenderer) {
                activeRenderer.element.classList.add('video-selected');
            }
        }
    }
    autoAssignState = null;
}

export function runAutomaticAssignment(selectedViewNames) {
    if (!state.session) return 0;
    var fg = state.session.getFrameGroup(state.currentFrame);
    if (!fg) return 0;
    var cameras = state.session.cameras;

    if (!cameras || cameras.length < 2) {
        setStatus('Need calibration with at least 2 cameras for automatic assignment', 'warning');
        return 0;
    }

    // First, unlink any existing groups that contain instances in selected views
    // This returns them to the unlinked pool so they can be re-matched
    var existingGroups = state.session.getInstanceGroupsForFrame(state.currentFrame);
    var groupsToUnlink = [];
    for (var egi = 0; egi < existingGroups.length; egi++) {
        var eg = existingGroups[egi];
        for (var svni = 0; svni < selectedViewNames.length; svni++) {
            if (eg.getInstance(selectedViewNames[svni])) {
                groupsToUnlink.push(eg);
                break;
            }
        }
    }
    for (var gui = 0; gui < groupsToUnlink.length; gui++) {
        state.session.unlinkGroup(state.currentFrame, groupsToUnlink[gui]);
    }

    // Now collect unlinked instances per selected view
    // Sort by original trackIdx so instance_0 (trackIdx=0) maps to group 0 (red)
    var viewUnlinked = {}; // viewName -> UnlinkedInstance[]
    for (var vi = 0; vi < selectedViewNames.length; vi++) {
        var vn = selectedViewNames[vi];
        var ul = fg.getUnlinkedInstances(vn);
        if (ul && ul.length > 0) {
            var sorted = ul.slice();
            sorted.sort(function (a, b) {
                var ta = a.instance.trackIdx != null ? a.instance.trackIdx : 9999;
                var tb = b.instance.trackIdx != null ? b.instance.trackIdx : 9999;
                return ta - tb;
            });
            viewUnlinked[vn] = sorted;
        }
    }

    var viewNames = Object.keys(viewUnlinked);
    if (viewNames.length < 2) {
        setStatus('Need instances in at least 2 selected views for matching', 'warning');
        return 0;
    }

    // Use the view with the MINIMUM instance count as the reference.
    // This ensures the number of tracks equals the min across selected views.
    var refView = viewNames[0];
    var minCount = viewUnlinked[refView].length;
    for (var vci = 1; vci < viewNames.length; vci++) {
        if (viewUnlinked[viewNames[vci]].length < minCount) {
            minCount = viewUnlinked[viewNames[vci]].length;
            refView = viewNames[vci];
        }
    }
    var refInstances = viewUnlinked[refView];

    // For each other view, build cost matrix using triangulation reprojection error
    // Then use Hungarian to match reference instances to other view instances
    // Result: groups of matched instances across views

    // Track assignments: refIdx -> { viewName -> UnlinkedInstance }
    var assignments = [];
    for (var ri = 0; ri < refInstances.length; ri++) {
        assignments[ri] = {};
        assignments[ri][refView] = refInstances[ri];
    }

    for (var ovi = 0; ovi < viewNames.length; ovi++) {
        var otherView = viewNames[ovi];
        if (otherView === refView) continue;
        var otherInstances = viewUnlinked[otherView];
        var nRef = refInstances.length;
        var nOther = otherInstances.length;

        // Build cost matrix: cost[refIdx][otherIdx] = reprojection error
        var costMatrix = [];
        for (var a = 0; a < nRef; a++) {
            costMatrix[a] = [];
            for (var b = 0; b < nOther; b++) {
                // Create temporary group with instances from both views
                var tempGroup = new InstanceGroup(-1, -1);
                tempGroup.addInstance(refView, refInstances[a].instance);
                tempGroup.addInstance(otherView, otherInstances[b].instance);
                var result = triangulateAndReproject(tempGroup, cameras);
                costMatrix[a][b] = (result.meanError != null && isFinite(result.meanError))
                    ? result.meanError : 1e6;
            }
        }

        // Run Hungarian algorithm
        var matching = hungarianAlgorithm(costMatrix);
        for (var mi = 0; mi < matching.length; mi++) {
            if (matching[mi] >= 0 && matching[mi] < nOther) {
                // Only accept if reprojection error is reasonable (< 50px)
                if (costMatrix[mi][matching[mi]] < 50) {
                    assignments[mi][otherView] = otherInstances[matching[mi]];
                }
            }
        }
    }

    // Create groups from assignments
    var groupsCreated = 0;
    for (var gi = 0; gi < assignments.length; gi++) {
        var assignedUnlinked = [];
        var viewKeys = Object.keys(assignments[gi]);
        for (var vk = 0; vk < viewKeys.length; vk++) {
            assignedUnlinked.push(assignments[gi][viewKeys[vk]]);
        }
        if (assignedUnlinked.length >= 2) {
            var group = state.session.createGroupFromUnlinked(
                state.currentFrame, assignedUnlinked
            );
            groupsCreated++;
        }
    }

    // Auto-triangulate all groups for this frame
    var allGroups = state.session.getInstanceGroupsForFrame(state.currentFrame);
    for (var tg = 0; tg < allGroups.length; tg++) {
        var group = allGroups[tg];
        var groupCamNames = group.cameraNames;
        var groupCameras = cameras.filter(function (c) {
            return groupCamNames.indexOf(c.name) >= 0;
        });
        if (groupCameras.length >= 2) {
            var result = triangulateAndReproject(group, groupCameras);
            group.points3d = result.points3d;
            group.reprojections = result.reprojections;
            storeReprojectedInstances(group, result, cameras);
            group.observedPoints = {};
            for (var cc = 0; cc < groupCameras.length; cc++) {
                var cam = groupCameras[cc];
                var inst = group.getInstance(cam.name);
                if (inst) group.observedPoints[cam.name] = inst.points;
            }
            group.markClean();
        }
    }

    if (groupsCreated > 0) {
        // Track which views and frame were used for multi-frame support
        state.lastAutoAssignViews = selectedViewNames.slice();
        state.lastAutoAssignFrame = state.currentFrame;
        // Force full overlay redraw so skeleton colors update
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        setReprojErrorVisible(true);
        if (viewport3d) {
            update3DViewport(state.currentFrame);
        }
        setStatus('Auto-assigned ' + groupsCreated + ' identity group(s) across ' + viewNames.length + ' views', 'success');
        updateTimelineForFrame(state.currentFrame);
    } else {
        setStatus('No matching identities found across selected views', 'warning');
    }
    return groupsCreated;
}

/**
 * Temporally-tracked identity assignment for subsequent frames.
 * Uses previous frame's 3D targets to guide assignment via projection matching.
 *
 * Algorithm (inspired by SLEAP 3D):
 * 1. Project previous groups' 3D points to each selected view
 * 2. Build cost matrix: mean 2D distance between projected targets and detections
 * 3. Average cost across views for each (track, detection) pair
 * 4. Hungarian algorithm for optimal assignment
 * 5. Create groups with same track indices as previous frame
 * 6. Triangulate to update 3D positions for next frame
 *
 * @param {string[]} viewNames - Selected camera view names
 * @param {InstanceGroup[]} prevGroups - Previous frame's groups with 3D points
 * @returns {number} Number of groups created
 */
export function runTrackedAssignment(viewNames, prevGroups) {
    if (!state.session) return 0;
    var fg = state.session.getFrameGroup(state.currentFrame);
    if (!fg) return 0;
    var cameras = state.session.cameras;
    if (!cameras || cameras.length < 2) return 0;

    // Build camera lookup: name -> Camera
    var cameraMap = {};
    for (var ci = 0; ci < cameras.length; ci++) {
        cameraMap[cameras[ci].name] = cameras[ci];
    }

    // Unlink existing groups in selected views (return to unlinked pool)
    var existingGroups = state.session.getInstanceGroupsForFrame(state.currentFrame);
    var groupsToUnlink = [];
    for (var egi = 0; egi < existingGroups.length; egi++) {
        var eg = existingGroups[egi];
        for (var svni = 0; svni < viewNames.length; svni++) {
            if (eg.getInstance(viewNames[svni])) {
                groupsToUnlink.push(eg);
                break;
            }
        }
    }
    for (var gui = 0; gui < groupsToUnlink.length; gui++) {
        state.session.unlinkGroup(state.currentFrame, groupsToUnlink[gui]);
    }

    // Collect unlinked instances per view
    var viewUnlinked = {};
    for (var vi = 0; vi < viewNames.length; vi++) {
        var vn = viewNames[vi];
        var ul = fg.getUnlinkedInstances(vn);
        if (ul && ul.length > 0) viewUnlinked[vn] = ul.slice();
    }

    var availableViews = Object.keys(viewUnlinked);
    if (availableViews.length < 2) return 0;

    // Filter to prev groups that have valid 3D points
    var validPrevGroups = [];
    for (var pi = 0; pi < prevGroups.length; pi++) {
        if (prevGroups[pi].points3d) {
            var hasValid = prevGroups[pi].points3d.some(function (p) { return p != null; });
            if (hasValid) validPrevGroups.push(prevGroups[pi]);
        }
    }

    if (validPrevGroups.length === 0) {
        // No 3D targets — fall back to standard assignment
        return runAutomaticAssignment(viewNames);
    }

    // Project each previous group's 3D points to each view
    // projected[groupIdx][viewName] = array of [x,y] or null
    var projected = [];
    for (var gi = 0; gi < validPrevGroups.length; gi++) {
        projected[gi] = {};
        for (var vii = 0; vii < availableViews.length; vii++) {
            var viewName = availableViews[vii];
            var cam = cameraMap[viewName];
            if (cam && cam.projectionMatrix) {
                // Project into native (distorted) pixel space so distances to the
                // raw observed detections are meaningful near the frame edges.
                projected[gi][viewName] = reprojectPointsCamera(
                    validPrevGroups[gi].points3d, cam
                );
            }
        }
    }

    // Build cost matrix: rows = previous tracks, cols = detection indices
    // We match by finding, per view, the distance from projected target to each detection
    // and averaging across views.
    //
    // Determine max detections across views to build a unified index
    // We use per-view matching and sum costs.
    var maxDet = 0;
    for (var vj = 0; vj < availableViews.length; vj++) {
        var uLen = viewUnlinked[availableViews[vj]].length;
        if (uLen > maxDet) maxDet = uLen;
    }

    var nTracks = validPrevGroups.length;

    // Strategy: for each view independently, build per-view cost matrix and run Hungarian.
    // Then combine per-view assignments by track → build groups.

    // perViewAssignment[viewName] = array where [trackIdx] = unlinked instance (or null)
    var perViewAssignment = {};

    for (var vk = 0; vk < availableViews.length; vk++) {
        var vName = availableViews[vk];
        var detections = viewUnlinked[vName];
        var nDet = detections.length;

        // Build cost matrix for this view: nTracks × nDet
        var costMatrix = [];
        for (var ti = 0; ti < nTracks; ti++) {
            costMatrix[ti] = [];
            var proj = projected[ti][vName];
            for (var di = 0; di < nDet; di++) {
                if (proj) {
                    costMatrix[ti][di] = computeInstanceDistance(
                        proj, detections[di].instance.points
                    );
                } else {
                    costMatrix[ti][di] = 1e6;
                }
            }
        }

        // Run Hungarian (minimizing distance)
        var matching = hungarianAlgorithm(costMatrix);
        perViewAssignment[vName] = [];
        for (var mi = 0; mi < matching.length; mi++) {
            if (matching[mi] >= 0 && matching[mi] < nDet) {
                // Accept if distance is reasonable (< 100px mean keypoint distance)
                if (costMatrix[mi][matching[mi]] < 100) {
                    perViewAssignment[vName][mi] = detections[matching[mi]];
                } else {
                    perViewAssignment[vName][mi] = null;
                }
            } else {
                perViewAssignment[vName][mi] = null;
            }
        }
    }

    // Build groups: for each previous track, collect matched detections across views
    var groupsCreated = 0;
    var newGroups = [];
    for (var tgi = 0; tgi < nTracks; tgi++) {
        var assignedUnlinked = [];
        for (var avk = 0; avk < availableViews.length; avk++) {
            var assigned = perViewAssignment[availableViews[avk]][tgi];
            if (assigned) assignedUnlinked.push(assigned);
        }
        if (assignedUnlinked.length >= 2) {
            var prevIdentityId = validPrevGroups[tgi].identityId;
            var group = state.session.createGroupFromUnlinked(
                state.currentFrame, assignedUnlinked, prevIdentityId
            );
            // Preserve identity from previous frame, but route through the
            // swap-aware setter so we don't end up with two groups in the
            // current frame holding the same identityId (the prev frame
            // could legitimately have only one group with this identity,
            // and we want to keep it that way per-frame).
            state.session.assignIdentityToGroup(group, prevIdentityId);

            // Triangulate to get updated 3D points
            var groupCamNames = group.cameraNames;
            var groupCameras = cameras.filter(function (c) {
                return groupCamNames.indexOf(c.name) >= 0;
            });
            if (groupCameras.length >= 2) {
                var result = triangulateAndReproject(group, groupCameras);
                group.points3d = result.points3d;
                group.reprojections = result.reprojections;
                storeReprojectedInstances(group, result, cameras);
                group.observedPoints = {};
                for (var cci = 0; cci < groupCameras.length; cci++) {
                    var cam2 = groupCameras[cci];
                    var inst2 = group.getInstance(cam2.name);
                    if (inst2) group.observedPoints[cam2.name] = inst2.points;
                }
                group.markClean();
            }

            newGroups.push(group);
            groupsCreated++;
        }
    }

    if (groupsCreated > 0) {
        state.lastAutoAssignViews = viewNames.slice();
        state.lastAutoAssignFrame = state.currentFrame;
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (viewport3d) {
            update3DViewport(state.currentFrame);
        }
    }
    return groupsCreated;
}

// ============================================
// Single-Frame Automatic Triangulation
// ============================================

/**
 * Single-frame automatic triangulation.
 * Checks current frame and previous frame for existing identity assignment.
 * If found, reuses those views. Otherwise, shows view selection toast.
 * Runs assignment + triangulation immediately (no progress bar).
 */
export function runSingleFrameTriangulation() {
    if (!state.session || state.views.length === 0) {
        setStatus('No session loaded — load a project first', 'warning');
        return;
    }
    if (!state.session.cameras || state.session.cameras.length < 2) {
        setStatus('Need calibration with at least 2 cameras', 'warning');
        return;
    }

    var frameIdx = state.currentFrame;

    // Check current frame for existing identity assignment
    var existingGroups = state.session.getInstanceGroupsForFrame(frameIdx);
    var hasAssignment = existingGroups && existingGroups.length > 0;

    // Derive views from current frame's groups
    if (hasAssignment) {
        if (!state.lastAutoAssignViews || state.lastAutoAssignViews.length < 2) {
            var viewSet = new Set();
            for (var i = 0; i < existingGroups.length; i++) {
                var cams = existingGroups[i].cameraNames;
                for (var j = 0; j < cams.length; j++) viewSet.add(cams[j]);
            }
            state.lastAutoAssignViews = Array.from(viewSet);
        }
    }

    // Check previous frame for existing identity assignment
    if (!hasAssignment && frameIdx > 0) {
        var prevGroups = state.session.getInstanceGroupsForFrame(frameIdx - 1);
        if (prevGroups && prevGroups.length > 0) {
            hasAssignment = true;
            var viewSet2 = new Set();
            for (var i2 = 0; i2 < prevGroups.length; i2++) {
                var cams2 = prevGroups[i2].cameraNames;
                for (var j2 = 0; j2 < cams2.length; j2++) viewSet2.add(cams2[j2]);
            }
            state.lastAutoAssignViews = Array.from(viewSet2);
        }
    }

    if (hasAssignment && state.lastAutoAssignViews && state.lastAutoAssignViews.length >= 2) {
        // Assignment exists — run immediately
        runAutomaticAssignment(state.lastAutoAssignViews);
        triangulateCurrentFrame(getDefaultTriangulationMethod());
    } else {
        // No assignment — show view selection toast (single frame mode)
        startViewSelectionForFrames(frameIdx, frameIdx, true);
    }
}

// ============================================
// Multi-Frame Assignment Modal
// ============================================

export function showMultiFrameModal() {
    if (!state.session || state.views.length === 0) {
        setStatus('No session loaded — load a project first', 'warning');
        return;
    }
    if (!state.session.cameras || state.session.cameras.length < 2) {
        setStatus('Need calibration with at least 2 cameras', 'warning');
        return;
    }

    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay';

    var modal = document.createElement('div');
    modal.className = 'multi-frame-modal';

    var maxFrame = state.totalFrames - 1;
    var currentFrame = state.currentFrame;

    // Build views list if we have previous assignment views
    var viewsList = '';
    if (state.lastAutoAssignViews && state.lastAutoAssignViews.length > 0) {
        viewsList = '<ul class="modal-view-list">';
        for (var vli = 0; vli < state.lastAutoAssignViews.length; vli++) {
            viewsList += '<li>' + state.lastAutoAssignViews[vli] + '</li>';
        }
        viewsList += '</ul>';
    }

    modal.innerHTML =
        '<h3>Choose Frames for Identity Assignment</h3>' +
        '<div class="range-slider-container">' +
        '  <div class="range-slider-track"></div>' +
        '  <div class="range-slider-fill" id="mfSliderFill"></div>' +
        '  <input type="range" id="mfRangeStart" min="0" max="' + maxFrame + '" value="0">' +
        '  <input type="range" id="mfRangeEnd" min="0" max="' + maxFrame + '" value="' + maxFrame + '">' +
        '</div>' +
        '<div class="modal-range-row">' +
        '<div class="frame-inputs-row">' +
        '  <label>Start</label>' +
        '  <input type="number" id="mfInputStart" min="1" max="' + (maxFrame + 1) + '" value="1">' +
        '  <span class="separator">—</span>' +
        '  <label>End</label>' +
        '  <input type="number" id="mfInputEnd" min="1" max="' + (maxFrame + 1) + '" value="' + (maxFrame + 1) + '">' +
        '</div>' +
        '<div class="modal-views-section" id="mfViewsSection"' +
            (viewsList ? '' : ' style="display:none"') + '>' +
        '  <label>Views</label>' + (viewsList || '<ul class="modal-view-list"></ul>') +
        '</div>' +
        '</div>' +
        '<div class="multi-frame-progress" id="mfProgress" style="display:none;">' +
        '  <div class="progress-label" id="mfProgressLabel">0 / 0 frames</div>' +
        '  <div class="progress-bar-track"><div class="progress-bar-fill" id="mfProgressFill" style="width:0%"></div></div>' +
        '</div>' +
        '<div class="modal-actions" id="mfActions">' +
        '  <button id="mfCancel">Cancel</button>' +
        '  <button class="primary" id="mfContinue">Continue</button>' +
        '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var rangeStart = document.getElementById('mfRangeStart');
    var rangeEnd = document.getElementById('mfRangeEnd');
    var inputStart = document.getElementById('mfInputStart');
    var inputEnd = document.getElementById('mfInputEnd');
    var sliderFill = document.getElementById('mfSliderFill');

    function updateSliderFill() {
        var s = parseInt(rangeStart.value);
        var e = parseInt(rangeEnd.value);
        var max = parseInt(rangeStart.max) || 1;
        var leftPct = (s / max) * 100;
        var rightPct = (e / max) * 100;
        sliderFill.style.left = leftPct + '%';
        sliderFill.style.width = (rightPct - leftPct) + '%';
    }

    function syncSliders() {
        var s = parseInt(rangeStart.value);
        var e = parseInt(rangeEnd.value);
        if (s > e) {
            rangeStart.value = e;
            s = e;
        }
        inputStart.value = s + 1;
        inputEnd.value = e + 1;
        updateSliderFill();
    }

    rangeStart.addEventListener('input', syncSliders);
    rangeEnd.addEventListener('input', syncSliders);

    inputStart.addEventListener('change', function () {
        var v = parseInt(inputStart.value) - 1;
        if (isNaN(v) || v < 0) v = 0;
        if (v > parseInt(rangeEnd.value)) v = parseInt(rangeEnd.value);
        if (v > maxFrame) v = maxFrame;
        rangeStart.value = v;
        syncSliders();
    });

    inputEnd.addEventListener('change', function () {
        var v = parseInt(inputEnd.value) - 1;
        if (isNaN(v) || v < 0) v = 0;
        if (v < parseInt(rangeStart.value)) v = parseInt(rangeStart.value);
        if (v > maxFrame) v = maxFrame;
        rangeEnd.value = v;
        syncSliders();
    });

    updateSliderFill();

    document.getElementById('mfCancel').addEventListener('click', function () {
        overlay.remove();
    });

    document.getElementById('mfContinue').addEventListener('click', function () {
        var startFrame = parseInt(inputStart.value);
        var endFrame = parseInt(inputEnd.value);
        if (isNaN(startFrame) || isNaN(endFrame) || startFrame > endFrame) return;

        if (startFrame === endFrame) {
            setStatus('Start and end frames must differ for multi-frame — use Single Frame for one frame', 'warning');
            return;
        }

        // Check if the first frame already has identity assignment
        var hasAssignment = false;
        var existingGroups = state.session.getInstanceGroupsForFrame(startFrame);
        if (existingGroups && existingGroups.length > 0) {
            hasAssignment = true;
            // Derive views from existing groups if not stored
            if (!state.lastAutoAssignViews || state.lastAutoAssignViews.length < 2) {
                var viewSet = new Set();
                for (var egi = 0; egi < existingGroups.length; egi++) {
                    var cams = existingGroups[egi].cameraNames;
                    for (var ci = 0; ci < cams.length; ci++) viewSet.add(cams[ci]);
                }
                state.lastAutoAssignViews = Array.from(viewSet);
            }
        }
        if (!hasAssignment && state.lastAutoAssignViews &&
            state.lastAutoAssignViews.length >= 2 &&
            state.lastAutoAssignFrame === startFrame) {
            hasAssignment = true;
        }

        if (hasAssignment) {
            // Assignment exists on first frame — proceed with progress bar
            document.getElementById('mfActions').style.display = 'none';
            document.getElementById('mfProgress').style.display = 'block';
            rangeStart.disabled = true;
            rangeEnd.disabled = true;
            inputStart.disabled = true;
            inputEnd.disabled = true;
            runMultiFrameAssignment(startFrame, endFrame, state.lastAutoAssignViews, overlay);
        } else {
            // No assignment on first frame — dismiss modal, enter view selection
            overlay.remove();
            startViewSelectionForFrames(startFrame, endFrame, false);
        }
    });
}

/**
 * View selection toast flow for the assignment modal.
 * After the user selects views and presses Continue:
 * - Single frame: runs assignment + triangulation immediately
 * - Multiple frames: reopens modal with progress bar
 */
export function startViewSelectionForFrames(startFrame, endFrame, isSingleFrame) {
    var fg = state.session.getFrameGroup(startFrame);
    if (!fg) {
        setStatus('No instances on frame ' + (startFrame + 1), 'warning');
        return;
    }

    // Temporarily remove yellow selection highlight
    document.querySelectorAll('.video-cell.video-selected').forEach(function (el) {
        el.classList.remove('video-selected');
    });

    var totalViews = state.views.length;

    // Create toast in menu bar
    var toast = document.createElement('div');
    toast.className = 'auto-assign-toast';
    toast.innerHTML =
        '<span id="autoAssignToastText">Frame ' + startFrame +
        '. Select views for automatic Identity Assignment. Views Selected: 0/' +
        totalViews + '</span>' +
        '<button id="autoAssignCancel">Cancel</button>' +
        '<button id="autoAssignContinue" class="primary">Continue</button>';
    document.getElementById('menuBar').appendChild(toast);

    autoAssignState = { selectedViews: new Set(), toast: toast };

    // Add transparent click overlays on each video cell for view selection
    document.querySelectorAll('.video-cell').forEach(function (cell) {
        var cellOverlay = document.createElement('div');
        cellOverlay.className = 'auto-assign-overlay';
        cellOverlay.style.cssText = 'position:absolute;inset:0;z-index:20;cursor:pointer;';
        cell.appendChild(cellOverlay);
        cell._autoAssignOverlay = cellOverlay;
        cellOverlay.addEventListener('click', function (e) {
            e.stopPropagation();
            var viewName = cell.getAttribute('data-view-name');
            if (!viewName) return;
            if (autoAssignState.selectedViews.has(viewName)) {
                autoAssignState.selectedViews.delete(viewName);
                cell.classList.remove('auto-assign-selected');
            } else {
                autoAssignState.selectedViews.add(viewName);
                cell.classList.add('auto-assign-selected');
            }
            // Update view count in toast
            var textEl = document.getElementById('autoAssignToastText');
            if (textEl) {
                textEl.textContent = 'Frame ' + (startFrame + 1) +
                    '. Select views for automatic Identity Assignment. Views Selected: ' +
                    autoAssignState.selectedViews.size + '/' + totalViews;
            }
        });
    });

    toast.querySelector('#autoAssignCancel').addEventListener('click', function () {
        cleanupAutoAssignment();
    });

    toast.querySelector('#autoAssignContinue').addEventListener('click', function () {
        var selectedViews = Array.from(autoAssignState.selectedViews);
        cleanupAutoAssignment();

        if (selectedViews.length < 2) {
            setStatus('Select at least 2 views for automatic assignment', 'warning');
            return;
        }

        // Store views for future reference
        state.lastAutoAssignViews = selectedViews.slice();
        state.lastAutoAssignFrame = startFrame;

        if (isSingleFrame) {
            // Single frame: run assignment + triangulation immediately
            runAutomaticAssignment(selectedViews);
        } else {
            // Multiple frames: reopen modal with progress bar
            showMultiFrameProgressModal(startFrame, endFrame, selectedViews);
        }
    });
}

/**
 * Shows a progress-only modal for multi-frame assignment
 * (used after view selection when first frame had no prior assignment).
 */
export function showMultiFrameProgressModal(startFrame, endFrame, viewNames) {
    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay';

    var modal = document.createElement('div');
    modal.className = 'multi-frame-modal';

    var totalFrames = endFrame - startFrame + 1;
    var viewsList = '<ul class="modal-view-list">';
    for (var vli = 0; vli < viewNames.length; vli++) {
        viewsList += '<li>' + viewNames[vli] + '</li>';
    }
    viewsList += '</ul>';

    modal.innerHTML =
        '<h3>Identity Assignment — Frames ' + startFrame + ' to ' + endFrame + '</h3>' +
        '<div class="modal-views-section">' +
        '  <label>Views</label>' + viewsList +
        '</div>' +
        '<div class="multi-frame-progress" id="mfProgress">' +
        '  <div class="progress-label" id="mfProgressLabel">0 / ' + totalFrames + ' frames</div>' +
        '  <div class="progress-bar-track"><div class="progress-bar-fill" id="mfProgressFill" style="width:0%"></div></div>' +
        '</div>' +
        '<div class="modal-actions" id="mfActions" style="display:none;"></div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    runMultiFrameAssignment(startFrame, endFrame, viewNames, overlay);
}

export async function runMultiFrameAssignment(startFrame, endFrame, viewNames, overlayEl) {
    var totalFrames = endFrame - startFrame + 1;
    var progressLabel = document.getElementById('mfProgressLabel');
    var progressFill = document.getElementById('mfProgressFill');
    var completed = 0;
    var assigned = 0;
    var cameras = state.session.cameras;

    // Track previous frame's groups for temporal consistency
    var prevGroups = null;

    for (var f = startFrame; f <= endFrame; f++) {
        // Seek to frame
        await videoController.seekToFrame(f);

        var groupsCreated = 0;

        if (prevGroups && prevGroups.length > 0) {
            // Subsequent frames: use temporal tracking with previous 3D targets
            groupsCreated = runTrackedAssignment(viewNames, prevGroups);
        } else {
            // First frame (or no previous targets): use standard assignment
            // (runAutomaticAssignment auto-triangulates all groups)
            groupsCreated = runAutomaticAssignment(viewNames);
        }

        // Store current frame's groups as reference for next frame
        if (groupsCreated > 0) {
            prevGroups = state.session.getInstanceGroupsForFrame(state.currentFrame);
            assigned++;
        }
        // If no groups created, keep prevGroups from last successful frame
        // so tracking can recover

        completed++;
        var pct = Math.round((completed / totalFrames) * 100);
        if (progressLabel) progressLabel.textContent = completed + ' / ' + totalFrames + ' frames';
        if (progressFill) progressFill.style.width = pct + '%';

        // Yield to UI for progress bar updates
        await new Promise(function (r) { setTimeout(r, 0); });
    }

    // Done — show summary and close button
    if (progressLabel) {
        progressLabel.textContent = 'Done — assigned identities on ' + assigned + ' of ' + totalFrames + ' frames';
    }

    // Replace progress with close button
    var actionsEl = document.getElementById('mfActions');
    if (actionsEl) {
        actionsEl.innerHTML = '<button class="primary" id="mfClose">Close</button>';
        actionsEl.style.display = 'flex';
        document.getElementById('mfClose').addEventListener('click', function () {
            overlayEl.remove();
        });
    }

    setStatus('Multi-frame assignment complete: ' + assigned + '/' + totalFrames + ' frames assigned', 'success');

    // Update timeline: mark frames with grouped UserInstances, refresh track
    // bars, and re-apply the 30% cap (a bulk assignment can add many rows).
    if (timeline) {
        for (var [fIdx] of state.triangulationResults) {
            timeline.setFrameModified(fIdx, frameHasGroupedUserInstances(fIdx));
        }
        timeline.refreshTracks(state.session, { cap: true });
    }
}

// ============================================
// Track Swap (Pass 3i-4: moved from app.js)
// ============================================

export function swapTracks(trackA, trackB, frameStart, frameEnd) {
    if (!state.session) return 0;
    var swapped = 0;
    for (var [frameIdx, fg] of state.session.frameGroups) {
        if (frameIdx < frameStart || frameIdx > frameEnd) continue;
        for (var [camName, instances] of fg.instances) {
            for (var i = 0; i < instances.length; i++) {
                if (instances[i].trackIdx === trackA) { instances[i].trackIdx = trackB; swapped++; }
                else if (instances[i].trackIdx === trackB) { instances[i].trackIdx = trackA; swapped++; }
            }
        }
        for (var [camName2, ulList] of fg.unlinkedInstances) {
            for (var u = 0; u < ulList.length; u++) {
                var inst = ulList[u].instance;
                if (inst.trackIdx === trackA) { inst.trackIdx = trackB; swapped++; }
                else if (inst.trackIdx === trackB) { inst.trackIdx = trackA; swapped++; }
            }
        }
    }
    return swapped;
}
