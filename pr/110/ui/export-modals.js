// ui/export-modals.js — Pass 3g extraction
//
// Hosts:
//   - Group-by-Track / Group-by-Identity bulk-triangulation flows.
//   - SLP per-session and SLP all-sessions export modals.
//   - Multi-frame triangulation modal + worker.
//   - JSON labels export + H5 export wrappers.
//
// Extracted from app.js per the consolidated Pass 3 plan, Module 13.

import { state, viewport3d, timeline, getActiveSession } from './app-state.js';
import { InstanceGroup, UnlinkedInstance } from '../pose/pose-data.js';
import {
    triangulateAndReproject,
    storeReprojectedInstances,
    frameHasGroupedUserInstances,
    loadAllLazyFrames,
    triangulateMultiFrameInstances,
    sessionHasCalibration,
    showCalibrationRequiredPopup,
    getInstanceGroupsForFrame,
} from '../pose/triangulation.js';
import { Viewport3D } from './viewport3d.js';
import { getTrackColor, getGroupColor } from './overlays.js';
import { drawAllOverlays, setReprojErrorVisible } from './rendering.js';
import { updateInfoPanel } from './info-panel.js';
import { showLoading, hideLoading, setStatus } from '../import-export/save-load.js';
import {
    exportSlpClientSide,
    exportSlpMultiSession,
    findSkeletonMismatch,
    buildPoints3dH5,
    buildReprojH5,
} from '../import-export/file-io.js';

// Pass 3i-3: update3DViewport moved to pose/initialization.js.
import { update3DViewport } from '../pose/initialization.js';

// ============================================
// Group by Track & Triangulate All
// ============================================

/**
 * Group all instances by trackIdx across cameras, then triangulate.
 * For each frame:
 *   1. Collect all instances (grouped + unlinked) across all cameras
 *   2. Group by trackIdx — same trackIdx from different cameras = same identity
 *   3. Replace existing InstanceGroups with the track-based groups
 *   4. Triangulate each group
 */
export function showGroupByTrackModal() {
    if (!state.session) {
        setStatus('No session loaded', 'warning');
        return;
    }
    if (state.session.cameras.length < 2) {
        setStatus('Need at least 2 cameras for triangulation', 'warning');
        return;
    }

    var session = state.session;

    if (!session.trustTracks) {
        console.log('[group-by-track] Running with trustTracks OFF — tracks used for grouping but not marked as trusted');
    }

    // Scan all frames to gather per-track stats
    var trackStats = {};  // trackIdx -> { frames: Set, cameras: Set, nodeCount }
    var numNodes = session.skeleton.nodes.length;
    for (var [frameIdx, fg] of session.frameGroups) {
        // Grouped instances
        for (var [camName, instances] of fg.instances) {
            for (var ii = 0; ii < instances.length; ii++) {
                var tid = instances[ii].trackIdx;
                if (tid == null || tid < 0) continue;
                if (!trackStats[tid]) trackStats[tid] = { frames: new Set(), cameras: new Set(), nodeCount: numNodes };
                trackStats[tid].frames.add(frameIdx);
                trackStats[tid].cameras.add(camName);
            }
        }
        // Unlinked instances
        for (var [camName2, ulList] of fg.unlinkedInstances) {
            for (var ui = 0; ui < ulList.length; ui++) {
                var tid2 = ulList[ui].instance.trackIdx;
                if (tid2 == null || tid2 < 0) continue;
                if (!trackStats[tid2]) trackStats[tid2] = { frames: new Set(), cameras: new Set(), nodeCount: numNodes };
                trackStats[tid2].frames.add(frameIdx);
                trackStats[tid2].cameras.add(camName2);
            }
        }
    }

    var trackIndices = Object.keys(trackStats).map(Number).sort(function (a, b) { return a - b; });
    if (trackIndices.length === 0) {
        setStatus('No tracks found in session', 'warning');
        return;
    }

    // Build modal
    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay';

    var modal = document.createElement('div');
    modal.className = 'multi-frame-modal';
    modal.style.minWidth = '500px';

    // Track rows
    var trackRows = '';
    for (var ti = 0; ti < trackIndices.length; ti++) {
        var tIdx = trackIndices[ti];
        var tName = session.tracks[tIdx] || ('track_' + tIdx);
        var stats = trackStats[tIdx];
        trackRows +=
            '<tr class="gbt-track-row" data-idx="' + tIdx + '">' +
            '<td><input type="checkbox" class="gbt-track-cb" data-idx="' + tIdx + '" checked></td>' +
            '<td>' + tName + '</td>' +
            '<td>' + stats.nodeCount + ' nodes</td>' +
            '<td>' + stats.frames.size + '</td>' +
            '<td>' + stats.cameras.size + '</td>' +
            '</tr>';
    }

    // Camera rows
    var camRows = '';
    for (var ci = 0; ci < session.cameras.length; ci++) {
        var cam = session.cameras[ci];
        camRows +=
            '<tr class="gbt-cam-row" data-name="' + cam.name + '">' +
            '<td><input type="checkbox" class="gbt-cam-cb" data-name="' + cam.name + '" checked></td>' +
            '<td>' + cam.name + '</td>' +
            '</tr>';
    }

    modal.innerHTML =
        '<h3>Group by Track &amp; Triangulate</h3>' +
        '<div style="margin-bottom:12px;">' +
        '<label style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Tracks</label>' +
        '<div class="slp-export-table-container" style="max-height:200px;margin-top:4px;">' +
        '<table class="data-table">' +
        '<thead><tr><th style="width:30px;"></th><th>Name</th><th>Skeleton</th><th>Frames</th><th>Cameras</th></tr></thead>' +
        '<tbody>' + trackRows + '</tbody>' +
        '</table>' +
        '</div>' +
        '</div>' +
        '<div style="margin-bottom:12px;">' +
        '<label style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Cameras</label>' +
        '<div class="slp-export-table-container" style="max-height:160px;margin-top:4px;">' +
        '<table class="data-table">' +
        '<thead><tr><th style="width:30px;"></th><th>Name</th></tr></thead>' +
        '<tbody>' + camRows + '</tbody>' +
        '</table>' +
        '</div>' +
        '</div>' +
        '<div class="gbt-progress" style="display:none;margin-bottom:12px;">' +
        '<div class="progress-label" id="gbtProgressLabel">0 / 0 frames</div>' +
        '<div class="progress-bar-track"><div class="progress-bar-fill" id="gbtProgressFill" style="width:0%"></div></div>' +
        '</div>' +
        '<div class="modal-actions">' +
        '<button id="gbtCancel">Cancel</button>' +
        '<button class="primary" id="gbtGo">Triangulate</button>' +
        '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Row click toggles checkbox
    modal.querySelectorAll('.gbt-track-row').forEach(function (row) {
        row.addEventListener('click', function (ev) {
            if (ev.target.tagName === 'INPUT') return;
            var cb = row.querySelector('.gbt-track-cb');
            cb.checked = !cb.checked;
        });
    });
    modal.querySelectorAll('.gbt-cam-row').forEach(function (row) {
        row.addEventListener('click', function (ev) {
            if (ev.target.tagName === 'INPUT') return;
            var cb = row.querySelector('.gbt-cam-cb');
            cb.checked = !cb.checked;
        });
    });

    // Cancel
    document.getElementById('gbtCancel').addEventListener('click', function () {
        overlay.remove();
    });

    // Go
    document.getElementById('gbtGo').addEventListener('click', async function () {
        var selTracks = [];
        modal.querySelectorAll('.gbt-track-cb:checked').forEach(function (cb) {
            selTracks.push(parseInt(cb.getAttribute('data-idx')));
        });
        var selCams = [];
        modal.querySelectorAll('.gbt-cam-cb:checked').forEach(function (cb) {
            selCams.push(cb.getAttribute('data-name'));
        });

        if (selTracks.length === 0) {
            setStatus('Select at least one track', 'warning');
            return;
        }
        if (selCams.length < 2) {
            setStatus('Select at least 2 cameras for triangulation', 'warning');
            return;
        }

        // Disable controls, show progress
        document.getElementById('gbtGo').disabled = true;
        document.getElementById('gbtGo').textContent = 'Working...';
        modal.querySelector('.gbt-progress').style.display = '';

        try {
            await groupByTrackAndTriangulateAll(selTracks, selCams);
        } catch (err) {
            console.error('[group-by-track] Error:', err);
            setStatus('Triangulation error: ' + err.message, 'error');
        }

        overlay.remove();
    });
}

// ============================================
// Group by Identity & Triangulate All
// ============================================

/**
 * Group instances by their assigned Identity (from tracker), then triangulate.
 * Uses session.getIdentityIdForTrack (per-frame identity) per camera:trackIdx.
 * For each frame, groups instances that share the same identity into InstanceGroups,
 * then triangulates each group.
 */
export async function groupByIdentityAndTriangulateAll() {
    if (!sessionHasCalibration()) {
        showCalibrationRequiredPopup();
        return;
    }
    var session = getActiveSession();
    if (!session) {
        setStatus('No session loaded', 'warning');
        return;
    }
    if (session.cameras.length < 2) {
        setStatus('Need at least 2 cameras', 'warning');
        return;
    }
    if (session.identities.length === 0) {
        setStatus('No identities assigned yet — run Track Frame or Track All first', 'warning');
        return;
    }

    // Lazy sessions: load all frames before bulk operation
    if (session.lazyLoader) {
        await loadAllLazyFrames(showLoading);
    }

    var cameras = session.cameras;
    var allFrameIndices = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });
    if (allFrameIndices.length === 0) {
        setStatus('No frames', 'warning');
        return;
    }

    showLoading('Grouping by identity & triangulating 0/' + allFrameIndices.length + ' frames...');

    var totalGrouped = 0;
    var totalTriangulated = 0;
    var YIELD_EVERY = 100;

    for (var fi = 0; fi < allFrameIndices.length; fi++) {
        var frameIdx = allFrameIndices[fi];
        var fg = session.frameGroups.get(frameIdx);
        if (!fg) continue;

        // 1. Collect all instances, bucket by identityId
        //    identityId -> { camName -> Instance }
        var idBuckets = {};

        // Collect ALL instances (with or without identity)
        var allInstancesByCam = {};  // camName -> Instance[]

        // From grouped instances
        for (var [camName, instances] of fg.instances) {
            for (var ii = 0; ii < instances.length; ii++) {
                var inst = instances[ii];
                if (!allInstancesByCam[camName]) allInstancesByCam[camName] = [];
                allInstancesByCam[camName].push(inst);

                var identityId = session.getIdentityIdForTrack(camName, inst.trackIdx, frameIdx);
                if (identityId == null) continue;
                if (!idBuckets[identityId]) idBuckets[identityId] = {};
                if (!idBuckets[identityId][camName]) idBuckets[identityId][camName] = inst;
            }
        }

        // From unlinked instances
        for (var [camName2, ulList] of fg.unlinkedInstances) {
            for (var ui = 0; ui < ulList.length; ui++) {
                var ulInst = ulList[ui].instance;
                if (!allInstancesByCam[camName2]) allInstancesByCam[camName2] = [];
                allInstancesByCam[camName2].push(ulInst);

                var identityId2 = session.getIdentityIdForTrack(camName2, ulInst.trackIdx, frameIdx);
                if (identityId2 == null) continue;
                if (!idBuckets[identityId2]) idBuckets[identityId2] = {};
                if (!idBuckets[identityId2][camName2]) idBuckets[identityId2][camName2] = ulInst;
            }
        }

        // 2. Clear existing groups and instances for this frame
        session.instanceGroups.delete(frameIdx);
        for (var [cn] of fg.instances) fg.instances.set(cn, []);
        for (var [cn2] of fg.unlinkedInstances) fg.unlinkedInstances.set(cn2, []);

        // Re-add instances. Grouping is by identity, so instances the tracker
        // explicitly marked "no identity" (-1) cannot join a group — they stay
        // in the unlinked/ungrouped pool (visible under "Ungrouped Instances")
        // rather than being silently re-linked. Everything else is re-added as
        // linked so the identity buckets below can form their groups.
        for (var cn3 in allInstancesByCam) {
            for (var ai = 0; ai < allInstancesByCam[cn3].length; ai++) {
                var reInst = allInstancesByCam[cn3][ai];
                if (session.isExplicitNoIdentity &&
                    session.isExplicitNoIdentity(cn3, reInst.trackIdx, frameIdx)) {
                    fg.addUnlinkedInstance(cn3, new UnlinkedInstance(reInst, cn3));
                } else {
                    fg.addInstance(cn3, reInst);
                }
            }
        }

        // 3. Create InstanceGroups from identity buckets
        for (var idStr in idBuckets) {
            var identityId3 = parseInt(idStr);
            var bucket = idBuckets[idStr];
            var camNames = Object.keys(bucket);

            if (camNames.length < 2) continue;

            // Create InstanceGroup
            var groupId = session.instanceGroups.size + totalGrouped;
            var trackIdx = bucket[camNames[0]].trackIdx;
            var group = new InstanceGroup(groupId, identityId3);

            for (var ci2 = 0; ci2 < camNames.length; ci2++) {
                group.addInstance(camNames[ci2], bucket[camNames[ci2]]);
            }

            // Add to session
            if (!session.instanceGroups.has(frameIdx)) {
                session.instanceGroups.set(frameIdx, []);
            }
            session.instanceGroups.get(frameIdx).push(group);

            // Triangulate — store only points3d (compact).
            // Reprojections are computed on-the-fly when drawing.
            // Grouping always uses fast DLT.
            var triResult = triangulateAndReproject(group, cameras, { triangulateOnly: true });
            group.points3d = triResult.points3d;
            group.triangulationMethod = triResult.method;
            group.observedPoints = {};
            for (var _oci = 0; _oci < camNames.length; _oci++) {
                group.observedPoints[camNames[_oci]] = bucket[camNames[_oci]].points;
            }
            group.markClean();

            totalGrouped++;
            totalTriangulated++;
        }

        // Yield to UI
        if (fi % YIELD_EVERY === 0) {
            document.getElementById('loadingStatus').textContent =
                'Grouping by identity & triangulating ' + (fi + 1) + '/' + allFrameIndices.length + ' frames...';
            await new Promise(function (r) { setTimeout(r, 0); });
        }
    }

    hideLoading();
    setReprojErrorVisible(true);
    drawAllOverlays(state.currentFrame);
    // Populate the 3D viewer for the current frame. Without this, "Triangulate
    // All" (which routes here when identities exist) triangulated every frame
    // but never refreshed the 3D viewport, leaving it empty — unlike single
    // "Triangulate", which calls update3DViewport(frameIdx) at its tail.
    update3DViewport(state.currentFrame);
    updateInfoPanel();
    setStatus('Grouped ' + totalGrouped + ' identity groups, triangulated ' +
        totalTriangulated + ' across ' + allFrameIndices.length + ' frames', 'success');
}


async function groupByTrackAndTriangulateAll(selectedTrackIndices, selectedCameraNames) {
    if (!state.session) {
        setStatus('No session loaded', 'warning');
        return;
    }
    if (!sessionHasCalibration()) {
        showCalibrationRequiredPopup();
        return;
    }

    var allCameras = state.session.cameras;
    // Filter cameras if specified
    var cameras = selectedCameraNames
        ? allCameras.filter(function (c) { return selectedCameraNames.indexOf(c.name) >= 0; })
        : allCameras;
    if (cameras.length < 2) {
        setStatus('Need at least 2 cameras for triangulation', 'warning');
        return;
    }

    var session = state.session;
    var allFrameIndices = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });

    if (allFrameIndices.length === 0) {
        setStatus('No frames with instances', 'warning');
        return;
    }

    showLoading('Grouping & triangulating 0/' + allFrameIndices.length + ' frames...');

    var totalGrouped = 0;
    var totalTriangulated = 0;
    var totalErrors = [];
    var YIELD_EVERY = 100;

    for (var fi = 0; fi < allFrameIndices.length; fi++) {
        var frameIdx = allFrameIndices[fi];
        var fg = session.frameGroups.get(frameIdx);
        if (!fg) continue;

        // 1. Collect ALL instances across all cameras, keyed by trackIdx
        //    trackIdx -> { camName -> Instance }
        var trackBuckets = {};

        // From grouped instances (fg.instances)
        for (var [camName, instances] of fg.instances) {
            if (selectedCameraNames && selectedCameraNames.indexOf(camName) < 0) continue;
            for (var ii = 0; ii < instances.length; ii++) {
                var inst = instances[ii];
                var tid = inst.trackIdx;
                if (tid == null || tid < 0) continue;
                if (selectedTrackIndices && selectedTrackIndices.indexOf(tid) < 0) continue;
                if (!trackBuckets[tid]) trackBuckets[tid] = {};
                // One instance per camera per track — keep first or best
                if (!trackBuckets[tid][camName]) {
                    trackBuckets[tid][camName] = inst;
                }
            }
        }

        // From unlinked instances
        for (var [camName2, ulList] of fg.unlinkedInstances) {
            if (selectedCameraNames && selectedCameraNames.indexOf(camName2) < 0) continue;
            for (var ui = 0; ui < ulList.length; ui++) {
                var ulInst = ulList[ui].instance;
                var tid2 = ulInst.trackIdx;
                if (tid2 == null || tid2 < 0) continue;
                if (selectedTrackIndices && selectedTrackIndices.indexOf(tid2) < 0) continue;
                if (!trackBuckets[tid2]) trackBuckets[tid2] = {};
                if (!trackBuckets[tid2][camName2]) {
                    trackBuckets[tid2][camName2] = ulInst;
                }
            }
        }

        // 2. Clear existing groups and instances for this frame
        //    Remove old InstanceGroups
        session.instanceGroups.delete(frameIdx);
        //    Clear grouped instances (will be re-added from track buckets)
        for (var [cn] of fg.instances) {
            fg.instances.set(cn, []);
        }
        //    Clear unlinked instances (they're being regrouped)
        for (var [cn2] of fg.unlinkedInstances) {
            fg.unlinkedInstances.set(cn2, []);
        }

        // 3. Create new InstanceGroups from track buckets
        var frameResults = [];

        for (var trackIdxStr in trackBuckets) {
            var trackIdx = parseInt(trackIdxStr);
            var bucket = trackBuckets[trackIdx];
            var camNames = Object.keys(bucket);

            // Add all instances to fg.instances for overlay rendering
            for (var ci = 0; ci < camNames.length; ci++) {
                fg.addInstance(camNames[ci], bucket[camNames[ci]]);
            }

            // Skip tracks that appear in only 1 camera (can't triangulate)
            if (camNames.length < 2) continue;

            // Create InstanceGroup
            // Auto-assign identity from track. getOrCreateIdentityForTrack only
            // creates/returns the identity, so stamp the per-frame identity for
            // each grouped instance here (no global default map exists).
            var identity = session.getOrCreateIdentityForTrack(trackIdx);
            var group = new InstanceGroup(Date.now() + trackIdx, identity.id);
            for (var ci2 = 0; ci2 < camNames.length; ci2++) {
                group.addInstance(camNames[ci2], bucket[camNames[ci2]]);
                if (session.setFrameIdentity) {
                    session.setFrameIdentity(frameIdx, camNames[ci2], bucket[camNames[ci2]].trackIdx, identity.id);
                }
            }

            // Store in session.instanceGroups
            if (!session.instanceGroups.has(frameIdx)) {
                session.instanceGroups.set(frameIdx, []);
            }
            session.instanceGroups.get(frameIdx).push(group);

            totalGrouped++;

            // 4. Triangulate
            var groupCamNames = group.cameraNames;
            var groupCameras = cameras.filter(function (c) { return groupCamNames.indexOf(c.name) >= 0; });

            // Count views with actual labels
            var viewsWithLabels = 0;
            for (var cj = 0; cj < groupCameras.length; cj++) {
                var gInst = group.getInstance(groupCameras[cj].name);
                if (gInst && gInst.points && gInst.points.some(function (p, idx) {
                    return p != null && !(gInst.nulledNodes && gInst.nulledNodes.has(idx));
                })) {
                    viewsWithLabels++;
                }
            }
            if (viewsWithLabels < 2) continue;

            var result = triangulateAndReproject(group, groupCameras);
            group.triangulationMethod = result.method;

            group.reprojections = result.reprojections;
            group.points3d = result.points3d;
            // Reproject to ALL cameras (including excluded ones) so they show reprojections
            storeReprojectedInstances(group, result, allCameras);
            group.observedPoints = {};
            group.usedCameras = new Set();
            for (var ck = 0; ck < groupCameras.length; ck++) {
                var camInst = group.getInstance(groupCameras[ck].name);
                if (camInst) {
                    group.observedPoints[groupCameras[ck].name] = camInst.points;
                    if (camInst.points.some(function (p) { return p != null; })) {
                        group.usedCameras.add(groupCameras[ck].name);
                    }
                }
            }
            group.markClean();

            frameResults.push({
                group: group,
                points3d: result.points3d,
                reprojections: result.reprojections,
                errors: result.errors,
                meanError: result.meanError,
            });

            if (result.meanError != null) {
                totalErrors.push(result.meanError);
            }
        }

        if (frameResults.length > 0) {
            state.triangulationResults.set(frameIdx, frameResults);
            totalTriangulated++;
        }

        // Yield to UI periodically
        if (fi % YIELD_EVERY === 0) {
            showLoading('Triangulating... ' + (fi + 1) + '/' + allFrameIndices.length + ' frames');
            await new Promise(function (r) { setTimeout(r, 0); });
        }
    }

    // Post-triangulation updates — hide loading first so user sees results
    hideLoading();
    setReprojErrorVisible(true);
    drawAllOverlays(state.currentFrame);
    update3DViewport(state.currentFrame);
    if (viewport3d) viewport3d.fitToScene();
    var avgError = totalErrors.length > 0
        ? (totalErrors.reduce(function (a, b) { return a + b; }, 0) / totalErrors.length).toFixed(2)
        : 'N/A';
    setStatus('Grouped ' + totalGrouped + ' track-groups, triangulated ' + totalTriangulated +
        ' frames (avg error: ' + avgError + 'px)', 'success');
    console.log('[group-by-track] Done:', totalGrouped, 'groups across', totalTriangulated, 'frames, avg error:', avgError);

    // Update timeline
    if (timeline) {
        for (var [fIdx] of state.triangulationResults) {
            timeline.setFrameModified(fIdx, frameHasGroupedUserInstances(fIdx));
        }
        timeline.refreshTracks(session, { cap: true });
    }

    // Update info panel
    updateInfoPanel();
}
// ============================================
// SLP Per-Camera Export Modal
// ============================================

/**
 * Compute per-camera stats (labeled frames, instances, triangulated frames)
 * for a given session + camera name.
 */
function _computeCameraStats(sess, camName) {
    var labeledFrames = 0, instanceCount = 0, triangulatedFrames = 0;
    var hasEdits = false;
    for (var [sfIdx, sfg] of sess.frameGroups) {
        var sfHasLabeled = false;
        var sfCamInsts = sfg.instances.get(camName) || [];
        for (var sci = 0; sci < sfCamInsts.length; sci++) {
            var sft = sfCamInsts[sci].type || 'user';
            if (sft === 'user') { sfHasLabeled = true; instanceCount++; }
            else if (sft === 'predicted') { sfHasLabeled = true; }
            if (sfCamInsts[sci].modified === true) hasEdits = true;
        }
        var sfUl = sfg.getUnlinkedInstances(camName);
        for (var sui = 0; sui < sfUl.length; sui++) {
            if ((sfUl[sui].instance.type || 'user') === 'user') {
                sfHasLabeled = true; instanceCount++;
            }
            if (sfUl[sui].instance.modified === true) hasEdits = true;
        }
        if (sfHasLabeled) labeledFrames++;
        var sfGroups = sess.instanceGroups.get(sfIdx) || [];
        for (var sfgi = 0; sfgi < sfGroups.length; sfgi++) {
            if (sfGroups[sfgi].points3d) { triangulatedFrames++; break; }
        }
    }
    return {
        labeledFrames: labeledFrames,
        instanceCount: instanceCount,
        triangulatedFrames: triangulatedFrames,
        hasEdits: hasEdits,
    };
}

/**
 * Build the list of camera-view entries for a given session index.
 * One row per camera; falls back to session.cameras when the session's
 * videos haven't been loaded into state.videoFiles yet (lazy sessions).
 */
function _buildCameraEntriesForSession(sessIdx) {
    var sess = state.sessions[sessIdx];
    if (!sess) return [];
    var entries = [];
    var seenCams = {};

    for (var i = 0; i < state.videoFiles.length; i++) {
        var vf = state.videoFiles[i];
        var vfSessIdx = (typeof vf.sessionIdx === 'number') ? vf.sessionIdx : 0;
        if (vfSessIdx !== sessIdx) continue;
        var camName = vf.assignedCamera || vf.name;
        if (!camName) continue;
        seenCams[camName] = true;

        var sourceLabel;
        if (vf.slpFilename) {
            sourceLabel = vf.slpFilename;
        } else {
            sourceLabel = (vf.file && vf.file.name) ? vf.file.name : (vf.name || camName);
        }

        var stats = _computeCameraStats(sess, camName);
        entries.push({
            camName: camName,
            sourceLabel: sourceLabel,
            videoFile: vf,
            labeledFrames: stats.labeledFrames,
            instanceCount: stats.instanceCount,
            triangulatedFrames: stats.triangulatedFrames,
            hasEdits: stats.hasEdits,
        });
    }

    // Lazy fallback — sessions whose videos aren't loaded still have
    // session.cameras. Build a stub videoFileInfo so the export path
    // has the camera name; width/height/frameCount default to 0.
    var sessCams = sess.cameras || [];
    for (var ci = 0; ci < sessCams.length; ci++) {
        var cn = sessCams[ci].name;
        if (seenCams[cn]) continue;
        var stats2 = _computeCameraStats(sess, cn);
        entries.push({
            camName: cn,
            sourceLabel: cn,
            videoFile: { name: cn, videoWidth: 0, videoHeight: 0, frameCount: 0 },
            labeledFrames: stats2.labeledFrames,
            instanceCount: stats2.instanceCount,
            triangulatedFrames: stats2.triangulatedFrames,
            hasEdits: stats2.hasEdits,
        });
    }

    return entries;
}

export function showSlpExportModal() {
    if (!state.sessions || state.sessions.length === 0) {
        setStatus('No sessions to export', 'warning');
        return;
    }

    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay';

    var modal = document.createElement('div');
    modal.className = 'multi-frame-modal slp-export-modal slp-export-multi';

    // selectedBySession: Map<sessionIdx, { camName, videoFile, entry }>
    var selectedBySession = new Map();
    var activeSessIdx = (typeof state.activeSessionIdx === 'number' && state.activeSessionIdx >= 0)
        ? state.activeSessionIdx : 0;
    var currentSessIdx = activeSessIdx;

    // Build left-panel session rows
    var sessionRowsHtml = '';
    for (var si = 0; si < state.sessions.length; si++) {
        var sname = state.sessions[si].name || ('Session ' + (si + 1));
        var rowCls = 'slp-session-row' + (si === activeSessIdx ? ' slp-session-active' : '');
        sessionRowsHtml +=
            '<tr class="' + rowCls + '" data-sess-idx="' + si + '">' +
            '<td class="slp-session-name">' + sname + '</td>' +
            '<td class="slp-session-selcam" data-sess-idx="' + si + '">—</td>' +
            '</tr>';
    }

    modal.innerHTML =
        '<h3>Export SLEAP File</h3>' +
        '<div class="slp-export-multi-body">' +
        '<div class="slp-export-multi-left">' +
        '<div class="slp-export-panel-label">Sessions</div>' +
        '<div class="slp-export-table-container">' +
        '<table class="data-table slp-export-table slp-session-table">' +
        '<thead><tr><th>Name</th><th>Selected Camera</th></tr></thead>' +
        '<tbody id="slpSessionTbody">' + sessionRowsHtml + '</tbody>' +
        '</table>' +
        '</div>' +
        '</div>' +
        '<div class="slp-export-multi-right">' +
        '<div class="slp-export-panel-label" id="slpCamPanelLabel">Camera Views</div>' +
        '<div class="slp-export-table-container slp-cam-table-container" id="slpCamTableContainer">' +
        '<table class="data-table slp-export-table slp-cam-table">' +
        '<thead><tr><th>Source</th><th>Labeled</th><th>Instances</th><th>Triangulated</th></tr></thead>' +
        '<tbody id="slpCamTbody"></tbody>' +
        '</table>' +
        '</div>' +
        '</div>' +
        '</div>' +
        '<div class="slp-export-options">' +
        '<label><input type="checkbox" id="slpExportReproj"> Save Reprojections</label>' +
        '<span class="slp-reproj-toggle" id="slpReprojToggle">' +
        '<span class="slp-toggle-option slp-toggle-active" data-value="user">UserInstance</span>' +
        '<span class="slp-toggle-option" data-value="predicted">PredictedInstance</span>' +
        '</span>' +
        '</div>' +
        '<div class="slp-export-filename-row">' +
        '<label>Output Filename</label>' +
        '<input type="text" id="slpExportFilename" value="view.slp">' +
        '</div>' +
        '<div class="slp-export-error" id="slpExportError"></div>' +
        '<div class="modal-actions">' +
        '<button id="slpExportCancel">Cancel</button>' +
        '<button class="primary" id="slpExportBtn" disabled>Export</button>' +
        '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var camTbody = document.getElementById('slpCamTbody');
    var camPanelLabel = document.getElementById('slpCamPanelLabel');
    var camTableContainer = document.getElementById('slpCamTableContainer');
    var filenameInput = document.getElementById('slpExportFilename');
    var exportBtn = document.getElementById('slpExportBtn');
    var errorDiv = document.getElementById('slpExportError');

    function clearError() { errorDiv.textContent = ''; }
    function showError(msg) { errorDiv.textContent = msg; }

    // Pin right-panel height to the maximum camera count across all
    // sessions so switching sessions in the left panel doesn't make
    // the right panel resize. Cap at MAX_VISIBLE_ROWS and enable
    // vertical scroll above that.
    var MAX_VISIBLE_ROWS = 10;
    var ROW_HEIGHT = 24;
    var HEADER_HEIGHT = 24;
    function _countCamerasForSession(sessIdx) {
        var sess = state.sessions[sessIdx];
        if (!sess) return 0;
        var seen = {};
        for (var vi = 0; vi < state.videoFiles.length; vi++) {
            var vf = state.videoFiles[vi];
            var vsi = (typeof vf.sessionIdx === 'number') ? vf.sessionIdx : 0;
            if (vsi !== sessIdx) continue;
            var cn = vf.assignedCamera || vf.name;
            if (cn) seen[cn] = true;
        }
        var sessCams = sess.cameras || [];
        for (var ci = 0; ci < sessCams.length; ci++) seen[sessCams[ci].name] = true;
        return Object.keys(seen).length;
    }
    var maxCams = 0;
    for (var mi = 0; mi < state.sessions.length; mi++) {
        var n = _countCamerasForSession(mi);
        if (n > maxCams) maxCams = n;
    }
    var visibleRows = Math.min(Math.max(maxCams, 1), MAX_VISIBLE_ROWS);
    var panelHeight = HEADER_HEIGHT + visibleRows * ROW_HEIGHT;
    camTableContainer.style.minHeight = panelHeight + 'px';
    camTableContainer.style.maxHeight = panelHeight + 'px';

    // Cache per-session entries so we don't recompute on each click
    var sessionEntriesCache = new Map();
    function getSessionEntries(idx) {
        if (!sessionEntriesCache.has(idx)) {
            sessionEntriesCache.set(idx, _buildCameraEntriesForSession(idx));
        }
        return sessionEntriesCache.get(idx);
    }

    function refreshExportBtnState() {
        exportBtn.disabled = selectedBySession.size === 0;
    }

    function refreshSelCamCell(sessIdx) {
        var cell = modal.querySelector('.slp-session-selcam[data-sess-idx="' + sessIdx + '"]');
        if (!cell) return;
        var sel = selectedBySession.get(sessIdx);
        cell.textContent = sel ? sel.camName : '—';
    }

    function renderCamTableFor(sessIdx) {
        var sess = state.sessions[sessIdx];
        camPanelLabel.textContent = 'Camera Views: ' + (sess.name || ('Session ' + (sessIdx + 1)));

        var entries = getSessionEntries(sessIdx);
        if (entries.length === 0) {
            camTbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted);padding:12px;text-align:center;">No cameras in this session</td></tr>';
            return;
        }

        var html = '';
        var sel = selectedBySession.get(sessIdx);
        for (var ei = 0; ei < entries.length; ei++) {
            var e = entries[ei];
            var isSel = sel && sel.camName === e.camName;
            var rowCls = 'slp-export-row slp-cam-row';
            if (e.hasEdits) rowCls += ' slp-has-edits';
            if (isSel) rowCls += ' slp-export-selected';
            html +=
                '<tr class="' + rowCls + '" data-idx="' + ei + '">' +
                '<td>' + e.sourceLabel + '</td>' +
                '<td>' + e.labeledFrames + '</td>' +
                '<td>' + e.instanceCount + '</td>' +
                '<td>' + e.triangulatedFrames + '</td>' +
                '</tr>';
        }
        camTbody.innerHTML = html;

        var camRows = camTbody.querySelectorAll('.slp-cam-row');
        camRows.forEach(function (row) {
            row.addEventListener('click', function () {
                var ci = parseInt(row.getAttribute('data-idx'));
                var entry = entries[ci];
                var existing = selectedBySession.get(sessIdx);
                if (existing && existing.camName === entry.camName) {
                    selectedBySession.delete(sessIdx);
                } else {
                    selectedBySession.set(sessIdx, {
                        camName: entry.camName,
                        videoFile: entry.videoFile,
                        entry: entry,
                    });
                }
                // Toggle row visuals
                camRows.forEach(function (r) { r.classList.remove('slp-export-selected'); });
                if (selectedBySession.has(sessIdx)) row.classList.add('slp-export-selected');
                refreshSelCamCell(sessIdx);
                refreshExportBtnState();
                clearError();
            });
        });
    }

    // Session row click
    var sessionRows = modal.querySelectorAll('.slp-session-row');
    sessionRows.forEach(function (row) {
        row.addEventListener('click', function () {
            sessionRows.forEach(function (r) { r.classList.remove('slp-session-active'); });
            row.classList.add('slp-session-active');
            currentSessIdx = parseInt(row.getAttribute('data-sess-idx'));
            renderCamTableFor(currentSessIdx);
        });
    });

    // Initial render: active session's cameras
    renderCamTableFor(currentSessIdx);

    // Reprojection toggle
    var reprojCheckbox = document.getElementById('slpExportReproj');
    var reprojToggle = document.getElementById('slpReprojToggle');
    var toggleOptions = reprojToggle.querySelectorAll('.slp-toggle-option');

    function updateReprojToggleState() {
        if (reprojCheckbox.checked) {
            reprojToggle.classList.remove('slp-toggle-disabled');
        } else {
            reprojToggle.classList.add('slp-toggle-disabled');
        }
    }
    reprojCheckbox.addEventListener('change', updateReprojToggleState);
    updateReprojToggleState();

    toggleOptions.forEach(function (opt) {
        opt.addEventListener('click', function () {
            if (reprojCheckbox.checked) {
                toggleOptions.forEach(function (o) { o.classList.remove('slp-toggle-active'); });
                opt.classList.add('slp-toggle-active');
            }
        });
    });

    // Cancel
    document.getElementById('slpExportCancel').addEventListener('click', function () {
        overlay.remove();
    });

    // Export
    exportBtn.addEventListener('click', async function () {
        if (selectedBySession.size === 0) return;

        var saveReproj = reprojCheckbox.checked;
        var activeToggle = document.querySelector('#slpReprojToggle .slp-toggle-active');
        var reprojAsUser = saveReproj ? (activeToggle && activeToggle.getAttribute('data-value') === 'user') : null;

        var outputFilename = filenameInput.value.trim() || 'view.slp';
        if (!outputFilename.endsWith('.slp')) outputFilename += '.slp';

        // Build selections array in session order
        var selections = [];
        var sortedKeys = Array.from(selectedBySession.keys()).sort(function (a, b) { return a - b; });
        for (var k = 0; k < sortedKeys.length; k++) {
            var sIdx = sortedKeys[k];
            var sel = selectedBySession.get(sIdx);
            selections.push({
                session: state.sessions[sIdx],
                cameraName: sel.camName,
                videoFileInfo: sel.videoFile,
            });
        }

        exportBtn.disabled = true;
        exportBtn.textContent = 'Exporting...';
        clearError();

        try {
            var slpBlob = await exportSlpMultiSession(selections, reprojAsUser);
            downloadBlob(slpBlob, outputFilename);
            setStatus('Exported ' + outputFilename, 'success');
            overlay.remove();
        } catch (err) {
            console.error('[slp-export]', err);
            showError(err.message || String(err));
            exportBtn.disabled = false;
            exportBtn.textContent = 'Export';
        }
    });
}

// ============================================
// Export SLEAP by Camera Modal
// ============================================

/**
 * Modal warning popup for a skeleton mismatch during a per-camera download.
 * Styled after showCalibrationRequiredPopup.
 */
function showSkeletonMismatchPopup(detail) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10001;display:flex;align-items:center;justify-content:center;';

    var card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-secondary,#1e1e1e);border-radius:8px;padding:24px;max-width:460px;width:90%;text-align:center;';

    var icon = document.createElement('div');
    icon.style.cssText = 'font-size:36px;margin-bottom:12px;';
    icon.textContent = '⚠';
    card.appendChild(icon);

    var title = document.createElement('div');
    title.style.cssText = 'color:#fff;font-size:16px;font-weight:600;margin-bottom:8px;';
    title.textContent = 'Cannot Export — Skeletons Differ';
    card.appendChild(title);

    var msg = document.createElement('div');
    msg.style.cssText = 'color:#aaa;font-size:13px;margin-bottom:16px;line-height:1.5;';
    msg.textContent = 'The selected views belong to sessions with different skeletons. '
        + 'A single SLEAP file requires one shared skeleton, so these views cannot be exported together. '
        + 'Deselect the mismatched sessions and try again.';
    card.appendChild(msg);

    if (detail) {
        var det = document.createElement('div');
        det.style.cssText = 'color:#888;font-size:11px;margin-bottom:16px;font-family:monospace;word-break:break-word;';
        det.textContent = detail;
        card.appendChild(det);
    }

    var btn = document.createElement('button');
    btn.style.cssText = 'padding:8px 24px;font-size:14px;font-weight:600;cursor:pointer;background:var(--accent,#4a9eff);color:#fff;border:none;border-radius:6px;';
    btn.textContent = 'OK';
    function dismiss() {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
    }
    btn.addEventListener('click', dismiss);
    function onKey(e) {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); dismiss(); }
    }
    document.addEventListener('keydown', onKey);

    card.appendChild(btn);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
}

/**
 * Build the camera matrix for the "Export SLEAP by Camera" modal.
 *
 * Columns are camera-view names found across ALL sessions, ordered left→right by:
 *   1. Session frequency (primary) — views appearing in more sessions rank higher.
 *   2. Earliest session (tie-breaker 1) — when frequencies tie, the view whose first
 *      session is earlier (higher in the table) ranks higher, so each session's full
 *      camera set stays grouped before the next session's (no interleaving when
 *      sessions don't overlap).
 *   3. Within-session order in that first session (tie-breaker 2).
 * A stable alphabetical fallback breaks any remaining ties deterministically.
 *
 * @returns {{ camNames: string[], info: Object, cellLookup: Object[] }}
 */
/** True when a session holds any instance (grouped or unlinked) for a camera. */
function _sessionCameraHasData(sess, camName) {
    if (!sess || !sess.frameGroups) return false;
    for (var pair of sess.frameGroups) {
        var fg = pair[1];
        if ((fg.instances.get(camName) || []).length > 0) return true;
        if (fg.getUnlinkedInstances(camName).length > 0) return true;
    }
    return false;
}

function _buildByCamMatrix() {
    var sessions = state.sessions || [];
    var videoFiles = state.videoFiles || [];
    // cellLookup[sessionIdx] = { camName: videoFileInfo } — a camera is present
    // in a session ONLY when it has a real view here (a loaded video, or labeled
    // data for SLP-only projects). session.cameras is the full *calibration*
    // list and must NOT imply existence: a calibrated-but-unrecorded camera has
    // no view in that session and is shown as a red ✗, not a toggle.
    var cellLookup = sessions.map(function () { return {}; });
    var orderInSession = sessions.map(function () { return {}; });
    var counters = sessions.map(function () { return 0; });

    // 1. Real camera views = loaded video files (one per recorded camera, incl.
    //    deferred multi-session loads). Authoritative existence signal.
    for (var vi = 0; vi < videoFiles.length; vi++) {
        var vf = videoFiles[vi];
        var si = (typeof vf.sessionIdx === 'number') ? vf.sessionIdx : 0;
        if (si < 0 || si >= sessions.length) continue;
        var cam = vf.assignedCamera || vf.name;
        if (!cam || cellLookup[si][cam]) continue;
        cellLookup[si][cam] = vf;
        orderInSession[si][cam] = counters[si]++;
    }

    // 2. Cameras with labeled data but no loaded video still exist (SLP-only
    //    projects). Stub videoFileInfo so the export path has the camera name.
    for (var s2 = 0; s2 < sessions.length; s2++) {
        var sessCams = sessions[s2].cameras || [];
        for (var ci = 0; ci < sessCams.length; ci++) {
            var cn = sessCams[ci].name;
            if (!cn || cellLookup[s2][cn]) continue;
            if (_sessionCameraHasData(sessions[s2], cn)) {
                cellLookup[s2][cn] = { name: cn, videoWidth: 0, videoHeight: 0, frameCount: 0 };
                orderInSession[s2][cn] = counters[s2]++;
            }
        }
    }

    // 3. Aggregate per camera for column ordering. firstSession/orderInFirst are
    //    captured on first encounter — sessions are iterated in ascending order,
    //    so the first session that holds a camera is its earliest.
    var info = {};   // camName -> { name, count, firstSession, orderInFirst }
    for (var s3 = 0; s3 < sessions.length; s3++) {
        for (var cn3 in cellLookup[s3]) {
            if (!info[cn3]) {
                info[cn3] = { name: cn3, count: 0, firstSession: s3, orderInFirst: orderInSession[s3][cn3] };
            }
            info[cn3].count++;
        }
    }

    // Ordering (left → right):
    //   1. Session frequency (primary) — a camera in more sessions ranks higher.
    //   2. Earliest session (tie-breaker) — when frequencies tie, the camera
    //      whose first session is earlier (higher in the table) ranks higher, so
    //      a session's whole camera set stays grouped left-to-right before the
    //      next session's. (Non-overlapping sessions never interleave.)
    //   3. Within-session order in that first session.
    var camNames = Object.keys(info);
    camNames.sort(function (a, b) {
        var ra = info[a], rb = info[b];
        if (rb.count !== ra.count) return rb.count - ra.count;
        if (ra.firstSession !== rb.firstSession) return ra.firstSession - rb.firstSession;
        if (ra.orderInFirst !== rb.orderInFirst) return ra.orderInFirst - rb.orderInFirst;
        return a < b ? -1 : (a > b ? 1 : 0);
    });

    return { camNames: camNames, info: info, cellLookup: cellLookup };
}

export function showSlpExportByCamModal() {
    if (!state.sessions || state.sessions.length === 0) {
        setStatus('No sessions to export', 'warning');
        return;
    }

    var sessions = state.sessions;
    var matrix = _buildByCamMatrix();
    var camNames = matrix.camNames;
    var cellLookup = matrix.cellLookup;

    // Toggle state: keyed "sessionIdx|camName". Default ON for every present cell.
    var cellOn = {};
    for (var si0 = 0; si0 < sessions.length; si0++) {
        for (var ci0 = 0; ci0 < camNames.length; ci0++) {
            if (cellLookup[si0][camNames[ci0]]) cellOn[si0 + '|' + camNames[ci0]] = true;
        }
    }

    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'multi-frame-modal slp-export-modal slp-bycam-modal';

    function cellKey(si, cn) { return si + '|' + cn; }

    // ---- Build markup ----
    // Two separate, independently-scrollable panels (session names | camera
    // grid) with a small gap. Row heights are pinned in CSS so the two stay
    // vertically aligned; vertical scroll is mirrored between them in JS. The
    // session side is a div-list (not a table) so width:max-content lets long
    // names widen it and scroll horizontally — a <table> won't grow its cell to
    // overflowing content for scroll purposes.
    var sessHtml = '<div class="slp-bycam-sess-inner">'
        + '<div class="slp-bycam-sess-cell-d slp-bycam-sess-h-row">Session</div>';
    for (var br = 0; br < sessions.length; br++) {
        var sname = sessions[br].name || ('Session ' + (br + 1));
        sessHtml += '<div class="slp-bycam-sess-cell-d slp-bycam-sess-row" title="' + sname + '">' + sname + '</div>';
    }
    sessHtml += '<div class="slp-bycam-sess-cell-d slp-bycam-sess-foot-row"></div></div>';

    // Right: camera grid table (header = camera names, footer = Download).
    var camHead = '<thead><tr>';
    for (var hc = 0; hc < camNames.length; hc++) {
        camHead += '<th class="slp-bycam-cam-head" title="' + camNames[hc] + '">'
            + '<div class="slp-bycam-cam-name">' + camNames[hc] + '</div></th>';
    }
    camHead += '</tr></thead>';

    var camBody = '<tbody>';
    for (var cbr = 0; cbr < sessions.length; cbr++) {
        camBody += '<tr>';
        for (var bc = 0; bc < camNames.length; bc++) {
            var cn2 = camNames[bc];
            var vfInfo = cellLookup[cbr][cn2];
            if (vfInfo) {
                var cellLabel = vfInfo.slpFilename
                    || (vfInfo.file && vfInfo.file.name) || vfInfo.name || cn2;
                camBody += '<td class="slp-bycam-cell on" data-sess="' + cbr + '" data-cam="' + bc + '" '
                    + 'title="' + cellLabel + '">✓</td>';
            } else {
                camBody += '<td class="slp-bycam-missing" title="' + cn2 + ' not in this session">✗</td>';
            }
        }
        camBody += '</tr>';
    }
    camBody += '</tbody>';

    var camFoot = '<tfoot><tr>';
    for (var fc = 0; fc < camNames.length; fc++) {
        camFoot += '<td class="slp-bycam-dl-cell">'
            + '<button class="slp-bycam-dl-btn" data-cam="' + fc + '">Download</button></td>';
    }
    camFoot += '</tr></tfoot>';

    var emptyNote = camNames.length === 0
        ? '<div class="slp-export-note">No camera views found across sessions.</div>'
        : '';

    modal.innerHTML =
        '<h3>Export SLEAP by Camera</h3>' +
        '<div class="slp-export-note">Each column is a camera view found across sessions. '
        + 'A green ✓ marks a session that has that view (toggle on/off); a red ✗ marks a session '
        + 'where the view does not exist. Download a column to export that camera across every '
        + 'selected session into one SLEAP file.</div>' +
        emptyNote +
        '<div class="slp-bycam-body">' +
        '<div class="slp-bycam-scroll slp-bycam-sess-scroll">' + sessHtml + '</div>' +
        '<div class="slp-bycam-scroll slp-bycam-cam-scroll">' +
        '<table class="slp-bycam-table slp-bycam-cam-table">' + camHead + camBody + camFoot + '</table>' +
        '</div>' +
        '</div>' +
        '<div class="slp-bycam-skel-warning" id="slpByCamSkelWarning" style="display:none"></div>' +
        '<div class="slp-export-options">' +
        '<label><input type="checkbox" id="slpByCamReproj"> Save Reprojections</label>' +
        '<span class="slp-reproj-toggle" id="slpByCamReprojToggle">' +
        '<span class="slp-toggle-option slp-toggle-active" data-value="user">UserInstance</span>' +
        '<span class="slp-toggle-option" data-value="predicted">PredictedInstance</span>' +
        '</span>' +
        '</div>' +
        '<div class="slp-export-error" id="slpByCamError"></div>' +
        '<div class="modal-actions">' +
        '<button id="slpByCamClose">Close</button>' +
        '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Start both tables scrolled to the very left.
    var sessScroll = modal.querySelector('.slp-bycam-sess-scroll');
    var camScroll = modal.querySelector('.slp-bycam-cam-scroll');
    if (sessScroll) sessScroll.scrollLeft = 0;
    if (camScroll) camScroll.scrollLeft = 0;

    // Keep the two tables row-aligned: mirror vertical scroll between them
    // (horizontal scroll stays independent per the table's own width).
    if (sessScroll && camScroll) {
        var _syncing = false;
        function mirrorV(src, dst) {
            src.addEventListener('scroll', function () {
                if (_syncing) return;
                if (dst.scrollTop !== src.scrollTop) {
                    _syncing = true;
                    dst.scrollTop = src.scrollTop;
                    _syncing = false;
                }
            });
        }
        mirrorV(sessScroll, camScroll);
        mirrorV(camScroll, sessScroll);
    }

    var errorDiv = document.getElementById('slpByCamError');
    function clearError() { errorDiv.textContent = ''; }
    function showError(msg) { errorDiv.textContent = msg; }

    // ---- Cell toggling ----
    modal.querySelectorAll('.slp-bycam-cell').forEach(function (cell) {
        cell.addEventListener('click', function () {
            var si = parseInt(cell.getAttribute('data-sess'));
            var cn = camNames[parseInt(cell.getAttribute('data-cam'))];
            var key = cellKey(si, cn);
            cellOn[key] = !cellOn[key];
            if (cellOn[key]) {
                cell.classList.add('on'); cell.classList.remove('off');
                cell.textContent = '✓';
            } else {
                cell.classList.remove('on'); cell.classList.add('off');
                cell.textContent = '';
            }
            clearError();
            updateDownloadStates();
        });
    });

    // Proactively enable/disable per-column download buttons based on whether
    // the currently toggled-on sessions for a column have compatible skeletons.
    // Hoisted declaration so the cell-toggle handlers above can call it.
    function updateDownloadStates() {
        var blocked = [];
        modal.querySelectorAll('.slp-bycam-dl-btn').forEach(function (btn) {
            // Don't clobber the transient state of an in-progress export.
            if (btn.textContent === 'Exporting...') return;
            var camName = camNames[parseInt(btn.getAttribute('data-cam'))];
            var selections = buildColumnSelections(camName);
            var mismatch = selections.length >= 2 ? findSkeletonMismatch(selections) : null;
            if (mismatch) {
                btn.disabled = true;
                btn.title = mismatch;
                blocked.push({ cam: camName, detail: mismatch });
            } else {
                btn.disabled = false;
                btn.removeAttribute('title');
            }
        });

        // Surface a red message under the tables explaining any blocked columns.
        var warn = document.getElementById('slpByCamSkelWarning');
        if (warn) {
            if (blocked.length) {
                warn.textContent = 'Skeleton Mismatch Across Sessions. Download Blocked';
                warn.style.display = '';
            } else {
                warn.textContent = '';
                warn.style.display = 'none';
            }
        }
    }

    // ---- Reprojection toggle (mirrors showSlpExportModal) ----
    var reprojCheckbox = document.getElementById('slpByCamReproj');
    var reprojToggle = document.getElementById('slpByCamReprojToggle');
    var toggleOptions = reprojToggle.querySelectorAll('.slp-toggle-option');
    function updateReprojToggleState() {
        if (reprojCheckbox.checked) reprojToggle.classList.remove('slp-toggle-disabled');
        else reprojToggle.classList.add('slp-toggle-disabled');
    }
    reprojCheckbox.addEventListener('change', updateReprojToggleState);
    updateReprojToggleState();
    toggleOptions.forEach(function (opt) {
        opt.addEventListener('click', function () {
            if (reprojCheckbox.checked) {
                toggleOptions.forEach(function (o) { o.classList.remove('slp-toggle-active'); });
                opt.classList.add('slp-toggle-active');
            }
        });
    });

    function buildColumnSelections(camName) {
        var selections = [];
        for (var s = 0; s < sessions.length; s++) {
            if (!cellOn[cellKey(s, camName)]) continue;
            var vfInfo = cellLookup[s][camName];
            if (!vfInfo) continue;
            selections.push({
                session: sessions[s],
                cameraName: camName,
                videoFileInfo: vfInfo,
            });
        }
        return selections;
    }

    function sanitizeFilename(name) {
        var base = String(name).replace(/\.[^.\/]+$/, '');      // drop a trailing extension
        base = base.replace(/[\\\/:*?"<>|]+/g, '_').trim();       // strip path-unsafe chars
        return (base || 'view') + '.slp';
    }

    // ---- Per-column download ----
    modal.querySelectorAll('.slp-bycam-dl-btn').forEach(function (btn) {
        btn.addEventListener('click', async function () {
            clearError();
            var camName = camNames[parseInt(btn.getAttribute('data-cam'))];
            var selections = buildColumnSelections(camName);
            if (selections.length === 0) {
                showError('No sessions selected for "' + camName + '".');
                return;
            }

            // Pre-flight skeleton compatibility — pop up on mismatch.
            var mismatch = findSkeletonMismatch(selections);
            if (mismatch) {
                showSkeletonMismatchPopup(mismatch);
                return;
            }

            var saveReproj = reprojCheckbox.checked;
            var activeToggle = reprojToggle.querySelector('.slp-toggle-active');
            var reprojAsUser = saveReproj
                ? (activeToggle && activeToggle.getAttribute('data-value') === 'user')
                : null;

            var outName = sanitizeFilename(camName);
            var origText = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Exporting...';
            try {
                var blob = await exportSlpMultiSession(selections, reprojAsUser);
                downloadBlob(blob, outName);
                setStatus('Exported ' + outName + ' (' + selections.length + ' session'
                    + (selections.length === 1 ? '' : 's') + ')', 'success');
            } catch (err) {
                console.error('[slp-export-bycam]', err);
                showError(err.message || String(err));
            } finally {
                btn.disabled = false;
                btn.textContent = origText;
            }
        });
    });

    // Set initial disabled state for all download buttons.
    updateDownloadStates();

    document.getElementById('slpByCamClose').addEventListener('click', function () {
        overlay.remove();
    });
}

// ============================================
// Export SLP (All Views) Modal
// ============================================

export function showSlpExportAllModal() {
    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay';

    var modal = document.createElement('div');
    modal.className = 'multi-frame-modal slp-export-modal slp-export-all-modal';

    // Build entries from ALL sessions, grouped by session
    var entries = [];
    var multiSession = state.sessions.length > 1;

    for (var sessIdx = 0; sessIdx < state.sessions.length; sessIdx++) {
        var sess = state.sessions[sessIdx];
        for (var i = 0; i < state.videoFiles.length; i++) {
            var vf = state.videoFiles[i];
            if (!vf.assignedCamera) continue;
            if (vf.sessionIdx !== sessIdx) continue;
            var camName = vf.assignedCamera || vf.name;
            var outputName;
            if (vf.slpFilename) {
                var stem = vf.slpFilename.replace(/\.[^.]+$/, '');
                var vm = stem.match(/_(?:3D_)?v(\d+)$/);
                var nv = vm ? parseInt(vm[1]) + 1 : 1;
                var bs = vm ? stem.replace(/_(?:3D_)?v\d+$/, '') : stem;
                outputName = bs + '_v' + nv + '.slp';
            } else {
                var vn = (vf.file && vf.file.name) ? vf.file.name : (vf.name || 'video');
                outputName = vn.replace(/\.[^.]+$/, '') + '_v1.slp';
            }

            // Per-camera stats using this entry's session
            var labeledFrames = 0, instanceCount = 0, triangulatedFrames = 0;
            for (var [sfIdx, sfg] of sess.frameGroups) {
                var sfHasLabeled = false;
                var sfCamInsts = sfg.instances.get(camName) || [];
                for (var sci = 0; sci < sfCamInsts.length; sci++) {
                    var sft = sfCamInsts[sci].type || 'user';
                    if (sft === 'user') { sfHasLabeled = true; instanceCount++; }
                    else if (sft === 'predicted') { sfHasLabeled = true; }
                }
                var sfUl = sfg.getUnlinkedInstances(camName);
                for (var sui = 0; sui < sfUl.length; sui++) {
                    if ((sfUl[sui].instance.type || 'user') === 'user') { sfHasLabeled = true; instanceCount++; }
                }
                if (sfHasLabeled) labeledFrames++;
                var sfGroups = sess.instanceGroups.get(sfIdx) || [];
                for (var sfgi = 0; sfgi < sfGroups.length; sfgi++) {
                    if (sfGroups[sfgi].points3d) { triangulatedFrames++; break; }
                }
            }

            entries.push({
                camName: camName,
                sessionIdx: sessIdx,
                sessionName: sess.name || ('Session ' + (sessIdx + 1)),
                session: sess,
                outputName: outputName,
                videoFile: vf,
                labeledFrames: labeledFrames,
                instanceCount: instanceCount,
                triangulatedFrames: triangulatedFrames,
                selected: true,
                reprojMode: 'none', // 'none', 'user', 'predicted'
            });
        }
    }

    if (entries.length === 0) {
        setStatus('No video files loaded', 'warning');
        return;
    }

    // Build table rows, grouped by session
    var tableRows = '';
    var lastSessionIdx = -1;
    for (var ei = 0; ei < entries.length; ei++) {
        var e = entries[ei];
        // Session header row when session changes (multi-session only)
        if (multiSession && e.sessionIdx !== lastSessionIdx) {
            lastSessionIdx = e.sessionIdx;
            tableRows +=
                '<tr class="slp-export-session-header">' +
                '<td colspan="6" style="font-weight:bold; background:#2a2a3a; padding:6px 8px;">' +
                e.sessionName +
                '</td></tr>';
        }
        tableRows +=
            '<tr class="slp-export-row slp-all-row slp-all-selected" data-idx="' + ei + '">' +
            '<td>' + e.camName + '</td>' +
            '<td><input type="text" class="slp-all-filename" value="' + e.outputName + '" data-idx="' + ei + '"></td>' +
            '<td>' + e.labeledFrames + '</td>' +
            '<td>' + e.instanceCount + '</td>' +
            '<td>' + e.triangulatedFrames + '</td>' +
            '<td class="slp-all-reproj-cell">' +
            '<span class="slp-reproj-toggle slp-all-reproj" data-idx="' + ei + '">' +
            '<span class="slp-toggle-option slp-toggle-active" data-value="none">None</span>' +
            '<span class="slp-toggle-option" data-value="user">User</span>' +
            '<span class="slp-toggle-option" data-value="predicted">Predicted</span>' +
            '</span>' +
            '</td>' +
            '</tr>';
    }

    modal.innerHTML =
        '<h3>Export SLP (All Sessions)</h3>' +
        '<div class="slp-export-table-container">' +
        '<table class="data-table slp-export-table">' +
        '<thead><tr><th>Camera</th><th>Output Filename</th><th>Labeled</th><th>Instances</th><th>Triangulated</th><th>Reprojections</th></tr></thead>' +
        '<tbody>' + tableRows + '</tbody>' +
        '</table>' +
        '</div>' +
        '<div class="slp-export-options" style="margin-top:10px;">' +
        '<label style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);display:block;margin-bottom:6px;">Include</label>' +
        '<label style="margin-right:14px;cursor:pointer;"><input type="checkbox" id="slpAllIncUser" checked> User Labels</label>' +
        '<label style="margin-right:14px;cursor:pointer;"><input type="checkbox" id="slpAllIncPred" checked> Predictions</label>' +
        '<label style="margin-right:14px;cursor:pointer;"><input type="checkbox" id="slpAllIncReproj" checked> Reprojections</label>' +
        '</div>' +
        '<div class="modal-actions">' +
        '<button id="slpAllCancel">Cancel</button>' +
        '<button class="primary" id="slpAllExport">Export</button>' +
        '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Row click toggles selection (click on row itself, not inputs)
    var rows = modal.querySelectorAll('.slp-all-row');
    rows.forEach(function (row) {
        row.addEventListener('click', function (ev) {
            if (ev.target.tagName === 'INPUT' || ev.target.closest('.slp-reproj-toggle')) return;
            var idx = parseInt(row.getAttribute('data-idx'));
            entries[idx].selected = !entries[idx].selected;
            row.classList.toggle('slp-all-selected', entries[idx].selected);
        });
    });

    // Filename inputs update entries
    modal.querySelectorAll('.slp-all-filename').forEach(function (input) {
        input.addEventListener('change', function () {
            var idx = parseInt(input.getAttribute('data-idx'));
            entries[idx].outputName = input.value.trim() || entries[idx].outputName;
        });
        input.addEventListener('click', function (ev) { ev.stopPropagation(); });
    });

    // Per-row reproj toggle
    modal.querySelectorAll('.slp-all-reproj').forEach(function (toggle) {
        var opts = toggle.querySelectorAll('.slp-toggle-option');
        opts.forEach(function (opt) {
            opt.addEventListener('click', function (ev) {
                ev.stopPropagation();
                var idx = parseInt(toggle.getAttribute('data-idx'));
                opts.forEach(function (o) { o.classList.remove('slp-toggle-active'); });
                opt.classList.add('slp-toggle-active');
                entries[idx].reprojMode = opt.getAttribute('data-value');
            });
        });
    });

    // Cancel
    document.getElementById('slpAllCancel').addEventListener('click', function () {
        overlay.remove();
    });

    // Export
    document.getElementById('slpAllExport').addEventListener('click', async function () {
        var selected = entries.filter(function (e) { return e.selected; });
        if (selected.length === 0) {
            setStatus('No views selected for export', 'warning');
            return;
        }

        var SIO = window.SleapIO;
        if (!SIO) { setStatus('sleap-io.js not loaded yet', 'error'); return; }

        var exportBtn = document.getElementById('slpAllExport');
        exportBtn.disabled = true;
        exportBtn.textContent = 'Exporting...';

        try {
            // Get directory handle (reuse cached or prompt)
            var dirHandle = state.exportDirHandle;
            if (!dirHandle) {
                dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                state.exportDirHandle = dirHandle;
            }

            // Build instance type filter from checkboxes
            var instanceFilter = {
                user: document.getElementById('slpAllIncUser').checked,
                predicted: document.getElementById('slpAllIncPred').checked,
                reprojected: document.getElementById('slpAllIncReproj').checked,
            };

            var exported = 0;
            for (var si = 0; si < selected.length; si++) {
                var entry = selected[si];
                // reprojAsUser: null skips reprojections, true = UserInstance,
                // false = PredictedInstance. Both the global Include
                // toggle AND per-row "None" must skip — a prior version
                // dropped only on the global toggle, so rows marked None
                // still got their reprojections emitted as PredictedInstance
                // (since 'none' !== 'user' evaluates to false, not null).
                var reprojAsUser;
                if (!instanceFilter.reprojected || entry.reprojMode === 'none') {
                    reprojAsUser = null;
                } else {
                    reprojAsUser = entry.reprojMode === 'user';
                }
                var slpFilename = entry.outputName;
                if (!slpFilename.endsWith('.slp')) slpFilename += '.slp';

                // Use this entry's session for export
                var slpBlob = await exportSlpClientSide(
                    entry.session, entry.camName, reprojAsUser, entry.videoFile, slpFilename, instanceFilter
                );

                // Build directory path: session/camera (multi-session) or camera (single)
                var targetDir = dirHandle;
                if (multiSession) {
                    var sessionDirName = entry.sessionName;
                    try {
                        targetDir = await dirHandle.getDirectoryHandle(sessionDirName, { create: true });
                    } catch (e) {
                        console.warn('[export-all] Could not create session dir ' + sessionDirName + ':', e);
                        setStatus('Cannot create ' + sessionDirName + '/ — skipping', 'warning');
                        continue;
                    }
                }

                var subDirName = state.cameraDirMap[entry.camName] || entry.camName;
                var subDir;
                try {
                    subDir = await targetDir.getDirectoryHandle(subDirName, { create: false });
                } catch (e) {
                    try {
                        subDir = await targetDir.getDirectoryHandle(subDirName, { create: true });
                    } catch (e2) {
                        console.warn('[export-all] Could not access/create dir ' + subDirName + ':', e2);
                        setStatus('Cannot write to ' + subDirName + '/ — skipping ' + entry.camName, 'warning');
                        continue;
                    }
                }

                var fileHandle = await subDir.getFileHandle(slpFilename, { create: true });
                var writable = await fileHandle.createWritable();
                await writable.write(slpBlob);
                await writable.close();
                exported++;

                exportBtn.textContent = 'Exporting... (' + (si + 1) + '/' + selected.length + ')';
            }

            setStatus('Exported ' + exported + ' SLP file(s)', 'success');
            overlay.remove();
        } catch (err) {
            if (err.name === 'AbortError') {
                // User cancelled directory picker
                exportBtn.disabled = false;
                exportBtn.textContent = 'Export';
                return;
            }
            console.error('[slp-export-all]', err);
            setStatus('Export failed: ' + err.message, 'error');
            exportBtn.disabled = false;
            exportBtn.textContent = 'Export';
        }
    });
}

// ============================================
// Multi-Frame Triangulation Modal
// ============================================

/**
 * Condense an array of frame indices into human-readable ranges.
 * e.g. [10,11,12,13,15,23,40,41,42] -> "10–13, 15, 23, 40–42"
 */
function condenseMissingFrames(frames) {
    if (frames.length === 0) return '';
    frames.sort(function (a, b) { return a - b; });
    var ranges = [];
    var start = frames[0];
    var end = frames[0];
    for (var i = 1; i < frames.length; i++) {
        if (frames[i] === end + 1) {
            end = frames[i];
        } else {
            ranges.push(start === end ? '' + start : start + '–' + end);
            start = frames[i];
            end = frames[i];
        }
    }
    ranges.push(start === end ? '' + start : start + '–' + end);
    return ranges.join(', ');
}

export function showTriangulateMultiFrameModal() {
    if (!state.session) {
        setStatus('No session loaded', 'warning');
        return;
    }
    if (!sessionHasCalibration()) {
        showCalibrationRequiredPopup();
        return;
    }
    if (state.session.cameras.length < 2) {
        setStatus('Need at least 2 cameras for triangulation', 'warning');
        return;
    }

    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay';

    var modal = document.createElement('div');
    modal.className = 'multi-frame-modal';

    var maxFrame = state.totalFrames - 1;

    // Build camera views list from session cameras
    var viewsList = '<ul class="modal-view-list">';
    for (var ci = 0; ci < state.session.cameras.length; ci++) {
        viewsList += '<li>' + state.session.cameras[ci].name + '</li>';
    }
    viewsList += '</ul>';

    modal.innerHTML =
        '<h3>Choose Frames for Triangulation</h3>' +
        '<div class="range-slider-container">' +
        '  <div class="range-slider-track"></div>' +
        '  <div class="range-slider-fill" id="tfSliderFill"></div>' +
        '  <input type="range" id="tfRangeStart" min="0" max="' + maxFrame + '" value="0">' +
        '  <input type="range" id="tfRangeEnd" min="0" max="' + maxFrame + '" value="' + maxFrame + '">' +
        '</div>' +
        '<div class="modal-range-row">' +
        '<div class="frame-inputs-row">' +
        '  <label>Start</label>' +
        '  <input type="number" id="tfInputStart" min="1" max="' + (maxFrame + 1) + '" value="1">' +
        '  <span class="separator">—</span>' +
        '  <label>End</label>' +
        '  <input type="number" id="tfInputEnd" min="1" max="' + (maxFrame + 1) + '" value="' + (maxFrame + 1) + '">' +
        '</div>' +
        '<div class="modal-views-section">' +
        '  <label>Cameras</label>' + viewsList +
        '</div>' +
        '</div>' +
        '<div class="multi-frame-error" id="tfError" style="display:none;"></div>' +
        '<div class="multi-frame-progress" id="tfProgress" style="display:none;">' +
        '  <div class="progress-label" id="tfProgressLabel">0 / 0 frames</div>' +
        '  <div class="progress-bar-track"><div class="progress-bar-fill" id="tfProgressFill" style="width:0%"></div></div>' +
        '</div>' +
        '<div class="modal-actions" id="tfActions">' +
        '  <button id="tfCancel">Cancel</button>' +
        '  <button class="primary" id="tfContinue">Continue</button>' +
        '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var rangeStart = document.getElementById('tfRangeStart');
    var rangeEnd = document.getElementById('tfRangeEnd');
    var inputStart = document.getElementById('tfInputStart');
    var inputEnd = document.getElementById('tfInputEnd');
    var sliderFill = document.getElementById('tfSliderFill');

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
        // Clear error when range changes
        document.getElementById('tfError').style.display = 'none';
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

    document.getElementById('tfCancel').addEventListener('click', function () {
        overlay.remove();
    });

    document.getElementById('tfContinue').addEventListener('click', function () {
        var startFrame = parseInt(inputStart.value);
        var endFrame = parseInt(inputEnd.value);
        if (isNaN(startFrame) || isNaN(endFrame) || startFrame > endFrame) {
            return;
        }

        // Validate: check all frames in range have identity assignment
        var missingFrames = [];
        for (var f = startFrame; f <= endFrame; f++) {
            var frameGroupsList = state.session.instanceGroups.get(f);
            if (!frameGroupsList || frameGroupsList.length === 0) {
                missingFrames.push(f);
            }
        }

        if (missingFrames.length > 0) {
            var errorEl = document.getElementById('tfError');
            if (missingFrames.length === 1) {
                errorEl.textContent = 'Frame ' + (missingFrames[0] + 1) + ' does not have identity assignment.';
            } else {
                errorEl.textContent = 'Frames [' + condenseMissingFrames(missingFrames.map(function(f) { return f + 1; })) + '] do not have identity assignment.';
            }
            errorEl.style.display = 'block';
            return;
        }

        // Hide error, action buttons; show progress
        document.getElementById('tfError').style.display = 'none';
        document.getElementById('tfActions').style.display = 'none';
        document.getElementById('tfProgress').style.display = 'block';
        rangeStart.disabled = true;
        rangeEnd.disabled = true;
        inputStart.disabled = true;
        inputEnd.disabled = true;

        runMultiFrameTriangulation(startFrame, endFrame, overlay);
    });
}

async function runMultiFrameTriangulation(startFrame, endFrame, overlayEl) {
    var totalFrames = endFrame - startFrame + 1;
    var progressLabel = document.getElementById('tfProgressLabel');
    var progressFill = document.getElementById('tfProgressFill');

    var result = await triangulateMultiFrameInstances(startFrame, endFrame, function (completed, total) {
        var pct = Math.round((completed / total) * 100);
        if (progressLabel) progressLabel.textContent = completed + ' / ' + total + ' frames';
        if (progressFill) progressFill.style.width = pct + '%';
    });

    // Update display for current frame
    drawAllOverlays(state.currentFrame);
    update3DViewport(state.currentFrame);
    if (viewport3d) viewport3d.fitToScene();

    var avgError = result.totalErrors.length > 0
        ? (result.totalErrors.reduce(function (a, b) { return a + b; }, 0) / result.totalErrors.length).toFixed(2)
        : 'N/A';

    // Show summary and close button
    if (progressLabel) {
        progressLabel.textContent = 'Done — triangulated ' + result.triangulated + ' frames (' + result.totalGroups + ' groups, avg error: ' + avgError + 'px)';
    }

    var actionsEl = document.getElementById('tfActions');
    if (actionsEl) {
        actionsEl.innerHTML = '<button class="primary" id="tfClose">Close</button>';
        actionsEl.style.display = 'flex';
        document.getElementById('tfClose').addEventListener('click', function () {
            overlayEl.remove();
        });
    }

    setStatus('Multi-frame triangulation complete: ' + result.triangulated + '/' + totalFrames + ' frames, avg error: ' + avgError + 'px', 'success');

    // Update timeline: mark frames with grouped UserInstances, refresh track bars
    if (timeline) {
        for (var [fIdx] of state.triangulationResults) {
            timeline.setFrameModified(fIdx, frameHasGroupedUserInstances(fIdx));
        }
        timeline.refreshTracks(state.session);
    }
}

// ============================================
// Export Labels (simple JSON dump)
// ============================================

export function exportLabels() {
    if (!state.session) {
        setStatus('No session to export', 'error');
        return;
    }

    const exportData = {
        skeleton: {
            name: state.session.skeleton.name,
            nodes: state.session.skeleton.nodes,
            edges: state.session.skeleton.edges,
        },
        cameras: state.session.cameras.map(function (c) {
            return { name: c.name, matrix: c.matrix, dist: c.dist, rvec: c.rvec, tvec: c.tvec, size: c.size };
        }),
        tracks: state.session.tracks,
        frames: {},
    };

    for (const [frameIdx, fg] of state.session.frameGroups) {
        const frameData = {};
        for (const [camName, instances] of fg.instances) {
            frameData[camName] = instances.map(function (inst) {
                return {
                    points: inst.points,
                    trackIdx: inst.trackIdx,
                    type: inst.type,
                    score: inst.score,
                    modified: inst.modified,
                };
            });
        }
        exportData.frames[frameIdx] = frameData;
    }

    // Download as JSON
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'labels_export.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    setStatus('Labels exported', 'success');
}


// ============================================
// H5 Export wrappers
// ============================================

export async function exportPoints3dH5() {
    try {
        setStatus('Building points3d H5...', 'warning');
        const blob = await buildPoints3dH5(state.session);
        downloadBlob(blob, 'points3d.h5');
        setStatus('Points3d H5 exported', 'success');
    } catch (err) {
        console.error('Points3d H5 export failed:', err);
        setStatus('Points3d H5 error: ' + err.message, 'error');
    }
}

export async function exportReprojH5() {
    try {
        setStatus('Building reprojections H5...', 'warning');
        const blob = await buildReprojH5(state.session);
        downloadBlob(blob, 'reprojections.h5');
        setStatus('Reprojections H5 exported', 'success');
    } catch (err) {
        console.error('Reprojections H5 export failed:', err);
        setStatus('Reprojections H5 error: ' + err.message, 'error');
    }
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

// ============================================
// Export 3D Video
// ============================================

/**
 * Format a number of seconds as M:SS.
 */
function _fmtDuration(totalSeconds) {
    var s = Math.max(0, Math.round(totalSeconds));
    var m = Math.floor(s / 60);
    var rem = s % 60;
    return m + ':' + (rem < 10 ? '0' : '') + rem;
}

// Target H.264 bitrate (bits/sec) for the 3D-video encoder — must match the
// encoder.configure() call so the size estimate and the real output agree.
function _v3dBitrate(W, H, fps) {
    return Math.min(24000000, Math.max(2000000, Math.round(W * H * fps * 0.12)));
}

function _fmtBytes(bytes) {
    if (!isFinite(bytes) || bytes <= 0) return '—';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return (bytes >= 100 ? Math.round(bytes) : bytes.toFixed(1)) + ' ' + units[i];
}

/**
 * "Export 3D Video" modal. Reuses the existing Viewport3D panel (a second
 * instance mounted in the modal) so the user can orbit/zoom to choose the
 * camera angle. Controls: prev/play/next transport, a progress bar with two
 * draggable start/end nodes (defaulted to the first/last frame) backed by two
 * editable, validated Start/End number fields, an editable FPS, a resolution
 * picker (360p / 720p / 1080p / 2K — sets output dims and the matching H.264
 * level), and a live duration readout. On Export, the chosen frame range is
 * rendered into the modal viewport at the chosen resolution and encoded to an
 * .mp4 via WebCodecs VideoEncoder + mp4-muxer.
 */
export function showExport3DVideoModal() {
    var session = getActiveSession();
    if (!session) { setStatus('No session to export', 'error'); return; }

    // Resolve the frame count to render (every frame, 0..N-1).
    var frameCount = (state.totalFrames && state.totalFrames > 0) ? state.totalFrames : 0;
    if (!frameCount) {
        var maxF = -1;
        if (session.frameGroups) for (var k of session.frameGroups.keys()) if (k > maxF) maxF = k;
        if (session.instanceGroups) for (var k2 of session.instanceGroups.keys()) if (k2 > maxF) maxF = k2;
        frameCount = maxF + 1;
    }
    if (frameCount <= 0) { setStatus('No frames to export', 'error'); return; }

    var V3D_TBTN = 'padding:4px 9px;font-size:13px;line-height:1;cursor:pointer;background:var(--bg-tertiary,#2a2a2a);color:#ddd;border:1px solid var(--border-color,#444);border-radius:4px;';
    var V3D_FIELD = 'background:var(--bg-tertiary,#2a2a2a);color:var(--text-primary,#e0e0e0);border:1px solid var(--border-color,#444);border-radius:4px;font-size:13px;padding:4px 6px;';
    var V3D_NUMF = 'width:66px;text-align:center;margin-left:4px;' + V3D_FIELD;
    var V3D_HANDLE = 'position:absolute;top:5px;width:15px;height:15px;margin-left:-8px;border-radius:50%;background:var(--accent,#4a9eff);border:2px solid #fff;box-sizing:border-box;cursor:ew-resize;touch-action:none;z-index:2;';

    // Standard output resolutions (16:9). The H.264 level in `codec` is bumped
    // to match the resolution so the decoder advertises the right capability.
    var V3D_RES = {
        '360':  { w: 640,  h: 360,  codec: 'avc1.42001E', label: '360p (640×360)' },
        '720':  { w: 1280, h: 720,  codec: 'avc1.42001F', label: '720p (1280×720)' },
        '1080': { w: 1920, h: 1080, codec: 'avc1.420028', label: '1080p (1920×1080)' },
        '2k':   { w: 2560, h: 1440, codec: 'avc1.420032', label: '2K (2560×1440)' },
    };

    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'multi-frame-modal';
    modal.style.cssText = 'width:860px;max-width:95vw;box-sizing:border-box;';
    modal.innerHTML =
        '<h3>Export 3D Video</h3>' +
        '<div style="display:flex;gap:14px;align-items:stretch;">' +
        '  <div id="v3dExportViewport" style="width:500px;height:340px;background:#1a1a1a;border-radius:6px;position:relative;overflow:hidden;flex:0 0 auto;"></div>' +
        '  <div style="flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:12px;">' +
        '    <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;">Orbit and zoom the view to set the camera angle for the exported video.</div>' +
        '    <div style="display:flex;align-items:center;gap:8px;">' +
        '      <label style="font-size:13px;width:34px;">FPS</label>' +
        '      <input type="number" id="v3dExportFps" min="1" max="240" step="1" style="width:74px;text-align:center;' + V3D_FIELD + '">' +
        '    </div>' +
        '    <div style="display:flex;align-items:center;gap:8px;">' +
        '      <label style="font-size:13px;width:34px;">Res</label>' +
        '      <select id="v3dExportRes" style="width:190px;max-width:100%;box-sizing:border-box;' + V3D_FIELD + '">' +
        '        <option value="360">' + V3D_RES['360'].label + '</option>' +
        '        <option value="720" selected>' + V3D_RES['720'].label + '</option>' +
        '        <option value="1080">' + V3D_RES['1080'].label + '</option>' +
        '        <option value="2k">' + V3D_RES['2k'].label + '</option>' +
        '      </select>' +
        '    </div>' +
        '    <div style="font-size:12px;color:var(--text-secondary);">Duration: <span id="v3dExportDuration">0:00</span></div>' +
        '    <div style="font-size:12px;color:var(--text-secondary);">Exported Frames: <span id="v3dExportSelCount">' + frameCount + '</span></div>' +
        '    <div style="font-size:12px;color:var(--text-secondary);">Estimated File Size: <span id="v3dExportSize">—</span></div>' +
        '  </div>' +
        '</div>' +
        '<div style="margin-top:12px;">' +
        '  <div style="display:flex;align-items:center;gap:6px;">' +
        '    <button id="v3dExportPrev" title="Previous frame" style="' + V3D_TBTN + '">⏮</button>' +
        '    <button id="v3dExportPlay" title="Play / Pause" style="' + V3D_TBTN + '">▶</button>' +
        '    <button id="v3dExportNext" title="Next frame" style="' + V3D_TBTN + '">⏭</button>' +
        '    <div id="v3dExportTrack" style="position:relative;flex:1;height:26px;margin:0 10px;cursor:pointer;">' +
        '      <div style="position:absolute;top:11px;left:0;right:0;height:4px;background:#444;border-radius:2px;"></div>' +
        '      <div id="v3dExportRangeFill" style="position:absolute;top:11px;height:4px;background:var(--accent,#4a9eff);border-radius:2px;"></div>' +
        '      <div id="v3dExportPlayhead" style="position:absolute;top:3px;width:2px;height:20px;background:#fff;opacity:0.8;margin-left:-1px;pointer-events:none;z-index:1;"></div>' +
        '      <div id="v3dExportHandleStart" title="Start frame" style="' + V3D_HANDLE + '"></div>' +
        '      <div id="v3dExportHandleEnd" title="End frame" style="' + V3D_HANDLE + '"></div>' +
        '    </div>' +
        '    <span id="v3dExportScrubVal" style="font-size:12px;min-width:48px;text-align:right;">0</span>' +
        '  </div>' +
        '  <div style="display:flex;align-items:center;gap:14px;margin-top:8px;font-size:12px;color:var(--text-secondary);">' +
        '    <label>Start <input type="number" id="v3dExportStart" min="0" max="' + (frameCount - 1) + '" step="1" style="' + V3D_NUMF + '"></label>' +
        '    <label>End <input type="number" id="v3dExportEnd" min="0" max="' + (frameCount - 1) + '" step="1" style="' + V3D_NUMF + '"></label>' +
        '  </div>' +
        '  <div id="v3dExportProgressWrap" style="display:none;margin-top:10px;">' +
        '    <div style="background:#333;border-radius:4px;height:8px;overflow:hidden;">' +
        '      <div id="v3dExportProgressFill" style="width:0%;height:100%;background:var(--accent,#4a9eff);transition:width 0.1s;"></div>' +
        '    </div>' +
        '    <div id="v3dExportProgressLabel" style="font-size:11px;color:var(--text-secondary);margin-top:4px;">Encoding 0 / ' + frameCount + '</div>' +
        '  </div>' +
        '</div>' +
        '<div class="modal-actions" style="margin-top:14px;display:flex;justify-content:flex-end;gap:10px;">' +
        '  <button id="v3dExportCancel">Cancel</button>' +
        '  <button class="primary" id="v3dExportBtn">Export</button>' +
        '</div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // --- Instantiate a second Viewport3D into the modal (reuse existing panel
    //     code; preserveDrawingBuffer so the canvas can be captured). ---
    var containerEl = modal.querySelector('#v3dExportViewport');
    function read3dNum(id, dflt) { var e = document.getElementById(id); return e ? (parseFloat(e.value) || dflt) : dflt; }
    function read3dBool(id, dflt) { var e = document.getElementById(id); return e ? e.checked : dflt; }
    var vp;
    try {
        vp = new Viewport3D(containerEl, {
            cameras: session.cameras,
            skeleton: session.skeleton,
            getTrackColor: getTrackColor,
            getGroupColor: function (group) {
                return getGroupColor(group, session, state.colorByIdentity || false, state.currentFrame);
            },
            cameraLabelSize: read3dNum('vis3dLabelSize', 28),
            cameraSphereSize: read3dNum('vis3dSphereSize', 3),
            pyramidLength: read3dNum('vis3dPyramidLength', 40),
            skeletonNodeSize: read3dNum('vis3dNodeSize', 2),
            skeletonEdgeWeight: read3dNum('vis3dEdgeWeight', 0.8),
            showCameraLabels: read3dBool('vis3dLabelShow', true),
            showCameraSpheres: read3dBool('vis3dSphereShow', true),
            showCameraPyramids: read3dBool('vis3dPyramidShow', true),
            showSkeletonNodes: read3dBool('vis3dNodeShow', true),
            showSkeletonEdges: read3dBool('vis3dEdgeShow', true),
            skeletonNodeShape: (function () { var e = document.getElementById('vis3dNodeStyle'); return e ? (e.getAttribute('data-value') || 'circle') : 'circle'; })(),
            preserveDrawingBuffer: true,
        });
    } catch (err) {
        console.error('[3D video] failed to create viewport:', err);
        overlay.remove();
        setStatus('3D viewport unavailable (WebGL required) — cannot export 3D video', 'error');
        return;
    }
    var startFrame = Math.min(state.currentFrame || 0, frameCount - 1);
    vp.setFrame(getInstanceGroupsForFrame(startFrame));
    setTimeout(function () { try { vp.fitToScene(); } catch (e) {} }, 150);

    // --- Controls ---
    var fpsInput = modal.querySelector('#v3dExportFps');
    var resSelect = modal.querySelector('#v3dExportRes');
    var durationEl = modal.querySelector('#v3dExportDuration');
    var track = modal.querySelector('#v3dExportTrack');
    var rangeFill = modal.querySelector('#v3dExportRangeFill');
    var playhead = modal.querySelector('#v3dExportPlayhead');
    var handleStart = modal.querySelector('#v3dExportHandleStart');
    var handleEnd = modal.querySelector('#v3dExportHandleEnd');
    var startField = modal.querySelector('#v3dExportStart');
    var endField = modal.querySelector('#v3dExportEnd');
    var selCountEl = modal.querySelector('#v3dExportSelCount');
    var sizeEl = modal.querySelector('#v3dExportSize');
    var previewValEl = modal.querySelector('#v3dExportScrubVal');
    var prevBtn = modal.querySelector('#v3dExportPrev');
    var playBtn = modal.querySelector('#v3dExportPlay');
    var nextBtn = modal.querySelector('#v3dExportNext');
    var cancelBtn = modal.querySelector('#v3dExportCancel');
    var exportBtn = modal.querySelector('#v3dExportBtn');
    var progressWrap = modal.querySelector('#v3dExportProgressWrap');
    var progressFill = modal.querySelector('#v3dExportProgressFill');
    var progressLabel = modal.querySelector('#v3dExportProgressLabel');

    fpsInput.value = Math.round(state.fps || 30);

    var lastIdx = frameCount - 1;
    // Export range (inclusive) + the current preview frame.
    var rangeStart = 0, rangeEnd = lastIdx, previewFrame = startFrame;
    var playTimer = null;

    function currentFps() {
        var f = parseFloat(fpsInput.value);
        if (isNaN(f) || f <= 0) f = 30;
        if (f > 240) f = 240;
        return f;
    }
    function selectedCount() { return rangeEnd - rangeStart + 1; }
    function refreshDuration() {
        durationEl.textContent = _fmtDuration(selectedCount() / currentFps());
        refreshSize();
    }
    function refreshSize() {
        var res = V3D_RES[resSelect.value] || V3D_RES['720'];
        var fps = currentFps();
        // bytes = bitrate(bits/s) × duration(s) / 8 — same bitrate the encoder uses.
        var bytes = _v3dBitrate(res.w, res.h, fps) * (selectedCount() / fps) / 8;
        sizeEl.textContent = _fmtBytes(bytes);
    }
    function pctOf(f) { return lastIdx > 0 ? (f / lastIdx) * 100 : 0; }

    // Sync the track handles / fill / fields to the current range + preview.
    function layoutTrack() {
        handleStart.style.left = pctOf(rangeStart) + '%';
        handleEnd.style.left = pctOf(rangeEnd) + '%';
        rangeFill.style.left = pctOf(rangeStart) + '%';
        rangeFill.style.width = (pctOf(rangeEnd) - pctOf(rangeStart)) + '%';
        playhead.style.left = pctOf(previewFrame) + '%';
        startField.value = rangeStart;
        endField.value = rangeEnd;
        selCountEl.textContent = selectedCount();
        previewValEl.textContent = previewFrame;
        refreshDuration();
    }

    // Render frame f into the modal viewport and move the playhead.
    function showFrame(f) {
        if (f < 0) f = 0;
        if (f > lastIdx) f = lastIdx;
        previewFrame = f;
        playhead.style.left = pctOf(f) + '%';
        previewValEl.textContent = f;
        vp.setFrame(getInstanceGroupsForFrame(f));
    }

    function setRange(s, e) {
        // Clamp into bounds and keep start <= end.
        s = Math.max(0, Math.min(lastIdx, Math.round(s)));
        e = Math.max(0, Math.min(lastIdx, Math.round(e)));
        if (s > e) { var t = s; s = e; e = t; }
        rangeStart = s; rangeEnd = e;
        layoutTrack();
    }

    fpsInput.addEventListener('input', refreshDuration);
    fpsInput.addEventListener('change', function () { fpsInput.value = Math.round(currentFps()); refreshDuration(); });
    resSelect.addEventListener('change', refreshSize);

    // --- Preview transport (play / prev / next) — plays across the range ---
    function setPlaying(on) {
        if (playTimer) { clearTimeout(playTimer); playTimer = null; }
        playBtn.textContent = on ? '⏸' : '▶';
        if (!on) return;
        var tick = function () {  // self-rescheduling so FPS edits take effect
            if (previewFrame >= rangeEnd) { setPlaying(false); return; }
            showFrame(previewFrame + 1);
            playTimer = setTimeout(tick, 1000 / currentFps());
        };
        playTimer = setTimeout(tick, 1000 / currentFps());
    }
    function togglePlay() {
        if (playTimer) { setPlaying(false); return; }
        if (previewFrame >= rangeEnd || previewFrame < rangeStart) showFrame(rangeStart);
        setPlaying(true);
    }
    playBtn.addEventListener('click', togglePlay);
    prevBtn.addEventListener('click', function () { setPlaying(false); showFrame(previewFrame - 1); });
    nextBtn.addEventListener('click', function () { setPlaying(false); showFrame(previewFrame + 1); });

    // --- Draggable start/end nodes on the progress bar ---
    var dragging = null;  // 'start' | 'end' | null
    function frameFromClientX(clientX) {
        var rect = track.getBoundingClientRect();
        if (rect.width <= 0) return 0;
        var pct = (clientX - rect.left) / rect.width;
        pct = Math.max(0, Math.min(1, pct));
        return Math.round(pct * lastIdx);
    }
    function onDragMove(ev) {
        if (!dragging) return;
        var f = frameFromClientX(ev.clientX);
        // While dragging, move only the active node's bound; render on release.
        if (dragging === 'start') setRange(Math.min(f, rangeEnd), rangeEnd);
        else setRange(rangeStart, Math.max(f, rangeStart));
        if (ev.cancelable) ev.preventDefault();
    }
    function onDragEnd() {
        if (!dragging) return;
        // Render the boundary frame the user just set (mouse-release only).
        showFrame(dragging === 'start' ? rangeStart : rangeEnd);
        dragging = null;
        document.removeEventListener('pointermove', onDragMove);
        document.removeEventListener('pointerup', onDragEnd);
    }
    function beginDrag(which, ev) {
        if (exporting) return;
        setPlaying(false);
        dragging = which;
        document.addEventListener('pointermove', onDragMove);
        document.addEventListener('pointerup', onDragEnd);
        if (ev.cancelable) ev.preventDefault();
    }
    handleStart.addEventListener('pointerdown', function (ev) { beginDrag('start', ev); });
    handleEnd.addEventListener('pointerdown', function (ev) { beginDrag('end', ev); });
    // Clicking the track grabs whichever node is nearer, then drags it.
    track.addEventListener('pointerdown', function (ev) {
        if (exporting) return;
        if (ev.target === handleStart || ev.target === handleEnd) return;
        var f = frameFromClientX(ev.clientX);
        var which = Math.abs(f - rangeStart) <= Math.abs(f - rangeEnd) ? 'start' : 'end';
        if (which === 'start') setRange(f, rangeEnd); else setRange(rangeStart, f);
        beginDrag(which, ev);
    });

    // --- Editable Start/End fields — reject illegal input (revert on invalid) ---
    function commitField(field, which) {
        var raw = field.value.trim();
        var v = Number(raw);
        var ok = raw !== '' && Number.isInteger(v) && v >= 0 && v <= lastIdx &&
            (which === 'start' ? v <= rangeEnd : v >= rangeStart);
        if (!ok) {
            // Illegal — revert to the last valid value, accept nothing.
            field.value = (which === 'start') ? rangeStart : rangeEnd;
            return;
        }
        if (which === 'start') setRange(v, rangeEnd); else setRange(rangeStart, v);
        showFrame(v);
    }
    startField.addEventListener('change', function () { commitField(startField, 'start'); });
    endField.addEventListener('change', function () { commitField(endField, 'end'); });

    layoutTrack();
    showFrame(startFrame);

    var exporting = false;
    var cancelled = false;

    function cleanup() {
        setPlaying(false);
        document.removeEventListener('keydown', onKey);
        try { vp.dispose(); } catch (e) {}
        overlay.remove();
    }

    cancelBtn.addEventListener('click', function () {
        if (exporting) { cancelled = true; return; }
        cleanup();
    });

    // Esc closes the modal (or stops an in-progress export), per the app-wide
    // modal convention (CLAUDE.md › Modals).
    function onKey(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        if (exporting) { cancelled = true; return; }
        cleanup();
    }
    document.addEventListener('keydown', onKey);

    exportBtn.addEventListener('click', async function () {
        if (exporting) return;

        if (typeof VideoEncoder === 'undefined' || typeof window.Mp4Muxer === 'undefined') {
            setStatus('3D video export needs a Chromium-based browser (WebCodecs)', 'error');
            return;
        }

        setPlaying(false);
        exporting = true;
        cancelled = false;
        exportBtn.disabled = true;
        fpsInput.disabled = true;
        resSelect.disabled = true;
        startField.disabled = true;
        endField.disabled = true;
        track.style.pointerEvents = 'none';
        prevBtn.disabled = true;
        playBtn.disabled = true;
        nextBtn.disabled = true;
        cancelBtn.textContent = 'Stop';
        progressWrap.style.display = '';

        var fps = currentFps();
        var expStart = rangeStart, expEnd = rangeEnd;
        var nFrames = expEnd - expStart + 1;

        // Output at the chosen standard resolution. Render the viewport at that
        // size (pixelRatio 1 so the buffer is exactly W×H) and match the camera
        // aspect so the 3D content isn't distorted.
        var res = V3D_RES[resSelect.value] || V3D_RES['720'];
        var W = res.w, H = res.h;
        try {
            vp.renderer.setPixelRatio(1);
            vp.renderer.setSize(W, H, false);
            vp.threeCamera.aspect = W / H;
            vp.threeCamera.updateProjectionMatrix();
        } catch (e) { console.warn('[3D video] resize failed:', e); }
        var src = vp.renderer.domElement;
        var cap = document.createElement('canvas');
        cap.width = W; cap.height = H;
        var capCtx = cap.getContext('2d');

        // Lazy sessions: ensure all frames are available before sweeping.
        if (session.lazyLoader) {
            try { await loadAllLazyFrames(showLoading); hideLoading(); } catch (e) {}
        }

        var muxer, encoder;
        try {
            muxer = new window.Mp4Muxer.Muxer({
                target: new window.Mp4Muxer.ArrayBufferTarget(),
                video: { codec: 'avc', width: W, height: H, frameRate: fps },
                fastStart: 'in-memory',
            });
            encoder = new VideoEncoder({
                output: function (chunk, meta) { muxer.addVideoChunk(chunk, meta); },
                error: function (e) { console.error('[3D video] encoder error:', e); },
            });
            encoder.configure({
                codec: res.codec,  // H.264 level matched to the chosen resolution
                width: W, height: H,
                bitrate: _v3dBitrate(W, H, fps),
                framerate: fps,
            });
        } catch (err) {
            console.error('[3D video] setup failed:', err);
            setStatus('3D video export setup failed: ' + err.message, 'error');
            exporting = false;
            cleanup();
            return;
        }

        var frameDurUs = Math.round(1e6 / fps);
        var encodedOk = true;
        try {
            // Encode only the selected [expStart, expEnd] range; timestamps are
            // relative to expStart so the clip starts at t=0.
            for (var i = expStart; i <= expEnd; i++) {
                if (cancelled) break;
                var out = i - expStart;

                vp.setFrame(getInstanceGroupsForFrame(i));
                // Force a render of the chosen camera view, then snapshot it.
                vp.renderer.render(vp.scene, vp.threeCamera);
                capCtx.drawImage(src, 0, 0, W, H);

                var vframe = new VideoFrame(cap, {
                    timestamp: Math.round(out * 1e6 / fps),
                    duration: frameDurUs,
                });
                encoder.encode(vframe, { keyFrame: (out % 60 === 0) });
                vframe.close();

                // Update progress + relieve encoder backpressure periodically.
                if (out % 5 === 0 || i === expEnd) {
                    var pct = Math.round(((out + 1) / nFrames) * 100);
                    progressFill.style.width = pct + '%';
                    progressLabel.textContent = 'Encoding ' + (out + 1) + ' / ' + nFrames;
                    await new Promise(function (r) { setTimeout(r, 0); });
                }
                while (encoder.encodeQueueSize > 12 && !cancelled) {
                    await new Promise(function (r) { setTimeout(r, 0); });
                }
            }

            if (!cancelled) {
                progressLabel.textContent = 'Finalizing...';
                await encoder.flush();
                muxer.finalize();
                var buffer = muxer.target.buffer;
                var blob = new Blob([buffer], { type: 'video/mp4' });
                var fname = (session.name || 'session').replace(/[^\w.-]+/g, '_') +
                    '_3d_' + resSelect.value + '_f' + expStart + '-' + expEnd + '.mp4';
                downloadBlob(blob, fname);
                setStatus('3D video exported: ' + fname + ' (' + nFrames + ' frames @ ' + fps +
                    ' fps, ' + W + '×' + H + ')', 'success');
            } else {
                setStatus('3D video export cancelled', 'warning');
            }
        } catch (err) {
            encodedOk = false;
            console.error('[3D video] export failed:', err);
            setStatus('3D video export failed: ' + err.message, 'error');
        }

        try { if (encoder.state !== 'closed') encoder.close(); } catch (e) {}
        exporting = false;
        cleanup();
    });
}
