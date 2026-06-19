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
} from '../pose/triangulation.js';
import { drawAllOverlays, setReprojErrorVisible } from './rendering.js';
import { updateInfoPanel } from './info-panel.js';
import { showLoading, hideLoading, setStatus } from '../import-export/save-load.js';
import {
    exportSlpClientSide,
    exportSlpMultiSession,
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
        '<h3>Export 2D SLP File</h3>' +
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
