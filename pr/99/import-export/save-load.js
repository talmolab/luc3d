// import-export/save-load.js — project save/load/restore/serialization + status UI
// Pass 3c-1 extraction. Holds the project lifecycle (newProject), save paths
// (quickSave, saveAs, saveProjectSlp, saveProject), load dispatcher
// (handleLoadProject + _restore* helpers), serialization (serializeSessionFrames,
// buildSlpBytes), and the loading-overlay/status-text UI helpers
// (showLoading, hideLoading, setStatus).

import {
    Skeleton, Camera, Instance, UnlinkedInstance, FrameGroup, Identity,
    InstanceGroup, Session,
} from '../pose/pose-data.js';
import {
    getInstanceGroupsForFrame, storeReprojectedInstances,
} from '../pose/triangulation.js';
import { OnDemandVideoDecoder } from '../loading/video.js';
import { createDemoSkeleton } from '../demo-data.js';
import {
    pickFiles, parseCalibrationJSON, buildSlpLabelsAllViews,
    convertSlpToV06Compatible,
} from './file-io.js';
import {
    state,
    videoController, interactionManager, viewport3d, timeline, paneManager,
    setVideoController, setInteractionManager,
} from '../ui/app-state.js';
import {
    autoAssignVideosToCameras, forceVideoSelection, showParentDirMatchSummary,
    forceVideoSelectionWithFolder, createViewForVideoFile, updateTotalFrames,
    rebuildVideoController, fitCanvasesToCells,
} from '../loading/session-loader.js';
import { drawAllOverlays, setReprojErrorVisible } from '../ui/rendering.js';
import { updateInfoPanel } from '../ui/info-panel.js';
// Pass 3i-3: setupInteraction / setup3DViewport / hideWelcomeOverlay moved to pose/initialization.js.
import {
    setupInteraction, setup3DViewport, hideWelcomeOverlay,
} from '../pose/initialization.js';
// Pass 3h: populateViewStrip / populateSessionStrip moved to sessions-panes.js.
import { populateViewStrip, populateSessionStrip } from '../ui/sessions-panes.js';
import { handleLoadSlpFile } from './slp-import.js';
import { getLoadingProgressModal } from '../ui/loading-progress-modal.js';

/**
 * Confirmation modal shown when the user starts loading a real session while
 * 3D points were imported into a skeleton-only project. Resolves true to
 * proceed (and discard), false to cancel. Styled like
 * showCalibrationRequiredPopup but with two buttons.
 */
export function confirmDiscardImported3D() {
    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10000;display:flex;align-items:center;justify-content:center;';
        var card = document.createElement('div');
        card.style.cssText = 'background:var(--bg-secondary,#1e1e1e);border-radius:8px;padding:24px;max-width:440px;width:90%;text-align:center;';
        var icon = document.createElement('div');
        icon.style.cssText = 'font-size:36px;margin-bottom:12px;';
        icon.textContent = '⚠';
        card.appendChild(icon);
        var title = document.createElement('div');
        title.style.cssText = 'color:#fff;font-size:16px;font-weight:600;margin-bottom:8px;';
        title.textContent = 'Discard imported 3D points?';
        card.appendChild(title);
        var msg = document.createElement('div');
        msg.style.cssText = 'color:#aaa;font-size:13px;margin-bottom:18px;line-height:1.5;';
        msg.textContent = 'Importing a session will remove all imported 3D point information, including the loaded skeleton. This cannot be undone. Continue and load the session?';
        card.appendChild(msg);
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;justify-content:center;';
        var cancelBtn = document.createElement('button');
        cancelBtn.style.cssText = 'padding:8px 20px;font-size:14px;cursor:pointer;background:var(--bg-tertiary,#2a2a2a);color:#ddd;border:1px solid var(--border-color,#444);border-radius:6px;';
        cancelBtn.textContent = 'Cancel';
        var okBtn = document.createElement('button');
        okBtn.style.cssText = 'padding:8px 20px;font-size:14px;font-weight:600;cursor:pointer;background:var(--accent,#4a9eff);color:#fff;border:none;border-radius:6px;';
        okBtn.textContent = 'Load Session';
        row.appendChild(cancelBtn);
        row.appendChild(okBtn);
        card.appendChild(row);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        function done(result) {
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            resolve(result);
        }
        function onKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); done(false); }
            else if (e.key === 'Enter') { e.preventDefault(); done(true); }
        }
        document.addEventListener('keydown', onKey);
        cancelBtn.addEventListener('click', function () { done(false); });
        okBtn.addEventListener('click', function () { done(true); });
    });
}

/**
 * Guard for session-load entry points. If the project holds 3D points imported
 * without a session, prompt the user; on confirm, fully reset the project
 * (nothing survives, not even the skeleton) and return true so the caller can
 * proceed with the load. Returns false if the user cancels.
 */
export async function ensureNo3dImportBlockingLoad() {
    if (!state.has3dImportWithoutSession) return true;
    var ok = await confirmDiscardImported3D();
    if (!ok) return false;
    newProject(true);  // full reset, no extra confirm
    return true;
}

export function newProject(force) {
    if (!force && (state.session || state.views.length > 0)) {
        if (!confirm('Unsaved changes will be lost. Start a new project?')) return;
    }

    // Drop the "imported 3D points without a session" marker — a full reset
    // erases any such overlay (including the skeleton) by design.
    state.has3dImportWithoutSession = false;

    // Detach interaction handlers from old canvases
    if (interactionManager) {
        interactionManager.detach();
        setInteractionManager(null);
    }

    // Stop playback
    if (videoController && state.isPlaying) {
        videoController.pause();
    }
    state.isPlaying = false;
    setVideoController(null);

    // Close lazy loader if active
    if (state.session && state.session.lazyLoader) {
        state.session.lazyLoader.close();
    }

    // Clear session and annotation data
    state.session = null;
    state.currentFrame = 0;
    state.totalFrames = 0;
    state.fps = 30;
    state.keypoints3d = null;
    state.triangulationResults = new Map();
    state.lastUserPoints = new Map();
    state.viewMode = 'grid';
    state.singleViewIndex = 0;

    // Clear views and video files
    state.views = [];
    state.videoFiles = [];

    // Clear 3D viewport (remove skeletons and camera pyramids)
    if (viewport3d) {
        viewport3d.setFrame([]);
        viewport3d.cameras = [];
        viewport3d.skeleton = null;
        viewport3d.addCameraPyramids();
    }

    // Clear the dock panels and view strip, show empty state
    paneManager.clearAll();
    var stripList = document.getElementById('viewStripList');
    if (stripList) stripList.innerHTML = '';

    // Reset frame counter display
    var curFrameEl = document.getElementById('currentFrame');
    if (curFrameEl) curFrameEl.textContent = '0';
    var totalFramesEl = document.getElementById('totalFrames');
    if (totalFramesEl) totalFramesEl.textContent = '0';
    var fpsEl = document.getElementById('fpsDisplay');
    if (fpsEl) fpsEl.textContent = '30.0 fps';

    // Reset seekbar
    var seekbar = document.getElementById('seekbar');
    if (seekbar) { seekbar.value = 0; seekbar.max = 0; }

    // Reset play button
    var playBtn = document.getElementById('btnPlay');
    if (playBtn) { playBtn.textContent = '\u25B6'; playBtn.classList.remove('active'); }

    // Reset status bar selection
    var selEl = document.getElementById('statusSelection');
    if (selEl) selEl.textContent = 'Selection: none';
    var selInfo = document.getElementById('selectedInfo');
    if (selInfo) selInfo.textContent = 'None';

    // Reset triangulation badge
    var badge = document.getElementById('triangulationBadge');
    if (badge) { badge.style.display = 'none'; badge.textContent = ''; }

    // Clear linked groups and unlinked instances panels
    var groupsTbody = document.querySelector('#instanceGroupsTable tbody');
    if (groupsTbody) groupsTbody.innerHTML = '';
    var groupsTable = document.getElementById('instanceGroupsTable');
    if (groupsTable) groupsTable.style.display = 'none';
    var groupsEmpty = document.getElementById('instanceGroupsEmpty');
    if (groupsEmpty) groupsEmpty.style.display = '';
    var ulTbody = document.querySelector('#unlinkedTable tbody');
    if (ulTbody) ulTbody.innerHTML = '';
    var ulTable = document.getElementById('unlinkedTable');
    if (ulTable) ulTable.style.display = 'none';
    var ulEmpty = document.getElementById('unlinkedEmpty');
    if (ulEmpty) ulEmpty.style.display = '';

    // Clear error display
    var errorDisplay = document.getElementById('errorDisplay');
    if (errorDisplay) { errorDisplay.textContent = '-'; errorDisplay.className = 'error-display'; }
    var perCamErrors = document.getElementById('perCameraErrors');
    if (perCamErrors) perCamErrors.innerHTML = '';

    // Clear skeleton editing tables and dropdowns
    var skelBody = document.querySelector('#skeletonNodesTable tbody');
    if (skelBody) skelBody.innerHTML = '';
    var edgesBody = document.querySelector('#skeletonEdgesTable tbody');
    if (edgesBody) edgesBody.innerHTML = '';
    var srcSelect = document.getElementById('edgeSrcSelect');
    if (srcSelect) srcSelect.innerHTML = '';
    var dstSelect = document.getElementById('edgeDstSelect');
    if (dstSelect) dstSelect.innerHTML = '';
    var newNodeInput = document.getElementById('nodeNameInput');
    if (newNodeInput) newNodeInput.value = '';

    // Clear videos table
    var vidBody = document.querySelector('#videosTable tbody');
    if (vidBody) vidBody.innerHTML = '';

    // Clear cameras table
    var camBody = document.querySelector('#camerasTable tbody');
    if (camBody) camBody.innerHTML = '';

    // Clear session assignment table
    var sessBody = document.querySelector('#sessionAssignTable tbody');
    if (sessBody) sessBody.innerHTML = '';

    // Update panels
    updateInfoPanel();
    if (timeline) {
        timeline.setData(null);
    }

    // Re-create interaction manager so keyboard shortcuts work immediately
    setupInteraction();

    setStatus('New project started', 'success');
}

function serializeSessionFrames(session) {
    var frames = {};
    for (var [frameIdx, fg] of session.frameGroups) {
        var frameData = { instanceGroups: [], unlinkedInstances: [] };
        var groups = session.instanceGroups.get(frameIdx) || [];
        for (var gi = 0; gi < groups.length; gi++) {
            var group = groups[gi];
            var groupData = {
                id: group.id,
                identityId: group.identityId != null ? group.identityId : -1,
                instances: {},
                points3d: group.points3d || null,
                reprojections: group.reprojections || null,
                observedPoints: group.observedPoints || null,
                dirty: group.dirty || false,
            };
            if (group.usedCameras) {
                groupData.usedCameras = Array.from(group.usedCameras);
            }
            for (var [camName, inst] of group.instances) {
                var instData = {
                    points: inst.points,
                    trackIdx: inst.trackIdx,
                    type: inst.type,
                    score: inst.score,
                    modified: inst.modified,
                    occluded: inst.occluded,
                };
                if (inst.nulledNodes && inst.nulledNodes.size > 0) {
                    instData.nulledNodes = Array.from(inst.nulledNodes);
                }
                groupData.instances[camName] = instData;
            }
            frameData.instanceGroups.push(groupData);
        }
        for (var [camName2, unlinkedList] of fg.unlinkedInstances) {
            for (var unlinked of unlinkedList) {
                var ulType = unlinked.instance.type || 'user';
                var ulData = {
                    cameraName: camName2,
                    points: unlinked.instance.points,
                    trackIdx: unlinked.instance.trackIdx,
                    type: ulType,
                    score: unlinked.instance.score || 1.0,
                    modified: unlinked.instance.modified || false,
                    occluded: unlinked.instance.occluded,
                };
                if (unlinked.instance.nulledNodes && unlinked.instance.nulledNodes.size > 0) {
                    ulData.nulledNodes = Array.from(unlinked.instance.nulledNodes);
                }
                frameData.unlinkedInstances.push(ulData);
            }
        }
        // Skip empty frames
        if (frameData.instanceGroups.length === 0 && frameData.unlinkedInstances.length === 0) continue;
        frames[frameIdx] = frameData;
    }
    return frames;
}

async function ensureSleapIO() {
    if (window.SleapIO) return window.SleapIO;
    var mod = await import('./lib/sleap-io/index.browser.js');
    window.SleapIO = mod;
    return mod;
}

export function markDirty() {
    if (state.isDirty) return;
    state.isDirty = true;
    document.title = '\u2022 Lucid';
    var saveDot = document.getElementById('saveDirtyDot');
    if (saveDot) saveDot.style.display = 'inline-block';
}

export function clearDirty() {
    state.isDirty = false;
    document.title = 'Lucid';
    var saveDot = document.getElementById('saveDirtyDot');
    if (saveDot) saveDot.style.display = 'none';
}

async function buildSlpBytes() {
    await ensureSleapIO();
    var SIO = window.SleapIO;

    var allLabeledFrames = [];
    var allVideos = [];
    var allSessions = [];
    var allSkeletons = [];
    var allTracks = [];
    var allIdentities = [];
    var seenSkeletonNames = new Set();
    var seenTrackNames = new Set();

    var sessionsToExport = state.sessions.length > 0 ? state.sessions : [state.session];
    var calibSessions = []; // main-format sessions_json entries, injected by post-pass
    var videoOffset = 0;    // cumulative video count across prior sessions
    for (var si = 0; si < sessionsToExport.length; si++) {
        var sess = sessionsToExport[si];

        // Debug: count 3D data in this session
        var dbgGroupCount = 0, dbgWith3d = 0;
        for (var [_dbgFi, _dbgGroups] of sess.instanceGroups) {
            for (var _dbgG of _dbgGroups) {
                dbgGroupCount++;
                if (_dbgG.points3d && _dbgG.points3d.some(function(p) { return p != null; })) dbgWith3d++;
            }
        }
        console.log('[save-slp] Session', si, '(' + sess.name + '):', sess.frameGroups.size, 'frames,',
            dbgGroupCount, 'instance groups,', dbgWith3d, 'with 3D points,',
            sess.cameras.length, 'cameras:', sess.cameras.map(function(c){return c.name;}).join(', '));

        // Find views and videoFiles for this session
        var sessViews = state.views.filter(function (v) {
            return sess.cameras.some(function (c) { return c.name === v.name; });
        });
        var sessVideoFiles = state.videoFiles.filter(function (vf) {
            return sess.cameras.some(function (c) { return c.name === vf.assignedCamera; });
        });

        var sessLabels = buildSlpLabelsAllViews(sess, sessViews, sessVideoFiles);

        // Build sessions_json payload for this session. Written into
        // sessions_json by the v0.6 post-pass so the saved SLP
        // round-trips calibration, InstanceGroup/points3d, and lucid
        // session metadata through load. Camera keys are stringified
        // integer indices ("0", "1", ...) because sleap-io v0.6.5's
        // `make_session` calls `int(cam_idx)` on camcorder_to_*_idx_map
        // keys — "camera_0" raises ValueError and aborts the SLEAP GUI
        // load. LUCID's loader handles both camera names and numeric
        // indices, so this stays round-trip-compatible.
        var calibration = {};
        var camcorderMap = {};
        var camNameToKey = {};
        for (var ci = 0; ci < sess.cameras.length; ci++) {
            var cam = sess.cameras[ci];
            var camKey = String(ci);
            calibration[camKey] = {
                name: cam.name,
                matrix: cam.matrix,
                distortions: cam.dist,
                rotation: cam.rvec,
                translation: cam.tvec,
                size: cam.size,
            };
            camcorderMap[camKey] = videoOffset + ci;
            camNameToKey[cam.name] = camKey;
        }

        // Serialize InstanceGroups + 3D points per frame. The load path
        // at handleLoadSlpFile (~index.html:13084+) expects:
        //   instance_groups[i] = {
        //     identity_idx?, points: [[x,y,z]|null, ...],
        //     instances: {camera_N: {nodeName: [x,y] | [x,y,0 if occluded]}},
        //     metadata: {lucid: {instanceMeta: {camName: {trackIdx,type,score,modified,nulledNodes?}}}}
        //   }
        var sessNodeNames = sess.skeleton.nodes.map(function (n) {
            return typeof n === 'string' ? n : (n.name || '');
        });
        var sessNumNodes = sessNodeNames.length;
        var frameGroupDicts = [];
        for (var [fgFrameIdx, fgGroups] of sess.instanceGroups) {
            if (!fgGroups || fgGroups.length === 0) continue;
            var igDicts = [];
            for (var fgi = 0; fgi < fgGroups.length; fgi++) {
                var grp = fgGroups[fgi];
                var igDict = {};
                if (grp.identityId != null && grp.identityId >= 0) {
                    igDict.identity_idx = grp.identityId;
                }
                if (grp.points3d && grp.points3d.length > 0) {
                    igDict.points = grp.points3d;
                }
                var igInstances = {};
                var igInstanceMeta = {};
                // Stub required by sleap-io v0.6.5 make_instance_group —
                // the loader pops this key unconditionally and int-casts
                // both the outer key and lf_idx/inst_idx. LUCID itself
                // does not use this map (it reads `instances` + metadata
                // below instead), so pointing all cameras at
                // labeled_frames[0].instances[0] is a safe no-op; the
                // file is guaranteed to have at least one labeled frame
                // with one instance whenever it has InstanceGroups.
                var lfAndInstMap = {};
                for (var [grpCamName, grpInst] of grp.instances) {
                    var grpCamKey = camNameToKey[grpCamName];
                    if (!grpCamKey) continue;
                    var pointDict = {};
                    var pts = grpInst.points || [];
                    for (var ni = 0; ni < sessNumNodes && ni < pts.length; ni++) {
                        var pt = pts[ni];
                        if (!pt || pt[0] == null || pt[1] == null || !isFinite(pt[0])) continue;
                        var isOcc = Array.isArray(grpInst.occluded) && grpInst.occluded[ni];
                        pointDict[sessNodeNames[ni]] = isOcc ? [pt[0], pt[1], 0] : [pt[0], pt[1]];
                    }
                    igInstances[grpCamKey] = pointDict;
                    lfAndInstMap[grpCamKey] = [0, 0];
                    var meta = {
                        trackIdx: grpInst.trackIdx,
                        type: grpInst.type || 'user',
                        score: grpInst.score || 0,
                        modified: grpInst.modified || false,
                    };
                    if (grpInst.nulledNodes && grpInst.nulledNodes.size > 0) {
                        meta.nulledNodes = Array.from(grpInst.nulledNodes);
                    }
                    igInstanceMeta[grpCamName] = meta;
                }
                igDict.instances = igInstances;
                igDict.camcorder_to_lf_and_inst_idx_map = lfAndInstMap;
                igDict.metadata = { lucid: { instanceMeta: igInstanceMeta } };
                igDicts.push(igDict);
            }
            if (igDicts.length > 0) {
                frameGroupDicts.push({ frame_idx: fgFrameIdx, instance_groups: igDicts });
            }
        }

        calibSessions.push({
            calibration: calibration,
            camcorder_to_video_idx_map: camcorderMap,
            frame_group_dicts: frameGroupDicts,
            metadata: {
                lucid: {
                    sessionName: sess.name || null,
                    trustTracks: sess.trustTracks || false,
                    frameIdentityMap: sess.frameIdentityMap ? Array.from(sess.frameIdentityMap.entries()) : [],
                    skeleton: {
                        name: sess.skeleton.name || 'skeleton',
                        nodes: sess.skeleton.nodes,
                        edges: sess.skeleton.edges,
                    },
                    tracks: sess.tracks,
                },
            },
        });
        videoOffset += (sessLabels.videos || []).length;

        // Merge into combined Labels
        allLabeledFrames = allLabeledFrames.concat(sessLabels.labeledFrames || []);
        allVideos = allVideos.concat(sessLabels.videos || []);
        for (var sk = 0; sk < (sessLabels.skeletons || []).length; sk++) {
            var skel = sessLabels.skeletons[sk];
            if (!seenSkeletonNames.has(skel.name)) {
                allSkeletons.push(skel);
                seenSkeletonNames.add(skel.name);
            }
        }
        for (var ti = 0; ti < (sessLabels.tracks || []).length; ti++) {
            var trk = sessLabels.tracks[ti];
            if (!seenTrackNames.has(trk.name)) {
                allTracks.push(trk);
                seenTrackNames.add(trk.name);
            }
        }
        allIdentities = allIdentities.concat(sessLabels.identities || []);
        allSessions = allSessions.concat(sessLabels.sessions || []);
    }

    var labels = new SIO.Labels({
        labeledFrames: allLabeledFrames,
        videos: allVideos,
        skeletons: allSkeletons,
        tracks: allTracks,
        identities: allIdentities,
        sessions: allSessions,
        provenance: { source: 'lucid', exported_at: new Date().toISOString() },
    });

    var rawBytes = await SIO.saveSlpToBytes(labels);
    return await convertSlpToV06Compatible(rawBytes, calibSessions);
}

export async function quickSave() {
    if (!state.session) {
        setStatus('No session to save', 'error');
        return;
    }
    if (state.isSaving) {
        setStatus('Save already in progress...', 'warning');
        return;
    }

    try {
        // If no file handle yet, prompt for one
        if (!state.slpFileHandle) {
            if (!window.showSaveFilePicker) {
                // Fallback: use old download-based save
                saveProjectSlp();
                return;
            }
            var filename = 'project.slp';
            if (state.sessions.length === 1 && state.session.name) {
                filename = state.session.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.slp';
            }
            try {
                state.slpFileHandle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description: 'SLEAP Labels',
                        accept: { 'application/x-hdf5': ['.slp'] }
                    }]
                });
            } catch (pickErr) {
                if (pickErr.name === 'AbortError') {
                    setStatus('Save cancelled', 'warning');
                    return;
                }
                throw pickErr;
            }
        }

        state.isSaving = true;
        setStatus('Saving...', 'warning');

        var bytes = await buildSlpBytes();

        // Write to file handle
        var writable = await state.slpFileHandle.createWritable();
        await writable.write(bytes);
        await writable.close();

        state.isSaving = false;
        clearDirty();
        var sizeMB = (bytes.byteLength / 1024 / 1024).toFixed(1);
        setStatus('Saved (' + sizeMB + ' MB)', 'success');
    } catch (err) {
        state.isSaving = false;
        console.error('Quick save failed:', err);
        setStatus('Save failed: ' + err.message, 'error');
    }
}

export async function saveAs() {
    // Force a new file picker regardless of existing handle
    state.slpFileHandle = null;
    await quickSave();
}

export async function saveProjectSlp() {
    if (!state.session) {
        setStatus('No session to save', 'error');
        return;
    }
    try {
        setStatus('Building SLP...', 'warning');

        var bytes = await buildSlpBytes();
        var blob = new Blob([bytes], { type: 'application/x-hdf5' });

        var filename = 'project.slp';
        if (state.sessions.length === 1 && state.session.name) {
            filename = state.session.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.slp';
        }

        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

        setStatus('Project saved as SLP (' + (blob.size / 1024 / 1024).toFixed(1) + ' MB)', 'success');
    } catch (err) {
        console.error('Save project SLP failed:', err);
        setStatus('Save failed: ' + err.message, 'error');
    }
}

export function saveProject() {
    if (!state.session) {
        setStatus('No session to save', 'error');
        return;
    }

    try {

    if (state.sessions.length > 1) {
        // V3: multi-session format
        // First, make sure active session's triangulationResults are saved
        state.sessions[state.activeSessionIdx].triangulationResults = state.triangulationResults;

        var projectData = {
            version: 3,
            sessions: state.sessions.map(function(sess, si) {
                return {
                    name: sess.name,
                    skeleton: {
                        name: sess.skeleton.name,
                        nodes: sess.skeleton.nodes,
                        edges: sess.skeleton.edges,
                    },
                    cameras: sess.cameras.map(function(c) {
                        return { name: c.name, matrix: c.matrix, dist: c.dist, rvec: c.rvec, tvec: c.tvec, size: c.size };
                    }),
                    tracks: sess.tracks,
                    identities: sess.identities.map(function (id) {
                        return { id: id.id, name: id.name, color: id.color };
                    }),
                    trustTracks: sess.trustTracks || false,
                    frameIdentityMap: sess.frameIdentityMap
                        ? Array.from(sess.frameIdentityMap.entries())
                        : [],
                    videoManifest: sess.videoFileIndices.map(function(vfIdx) {
                        var vf = state.videoFiles[vfIdx];
                        return vf ? {
                            filename: vf.name,
                            assignedCamera: vf.assignedCamera || null,
                            videoPath: vf.videoPath || null,
                        } : null;
                    }).filter(Boolean),
                    frames: serializeSessionFrames(sess),
                };
            }),
        };

        // Build blob (same chunked approach)
        var blob = new Blob([JSON.stringify(projectData)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'project.mvgui.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
        setStatus('Project saved (v3, ' + state.sessions.length + ' sessions)', 'success');
        return;
    }
    // else: fall through to existing v2 save code below...

    var projectData = {
        version: 2,
        skeleton: {
            name: state.session.skeleton.name,
            nodes: state.session.skeleton.nodes,
            edges: state.session.skeleton.edges,
        },
        cameras: state.session.cameras.map(function (c) {
            return { name: c.name, matrix: c.matrix, dist: c.dist, rvec: c.rvec, tvec: c.tvec, size: c.size };
        }),
        tracks: state.session.tracks,
        identities: state.session.identities.map(function (id) {
            return { id: id.id, name: id.name, color: id.color };
        }),
        trustTracks: state.session.trustTracks || false,
        frameIdentityMap: state.session.frameIdentityMap
            ? Array.from(state.session.frameIdentityMap.entries())
            : [],
        videoManifest: (state.videoFiles || []).map(function (vf) {
            return { filename: vf.name, assignedCamera: vf.assignedCamera || null };
        }),
        frames: {},
    };

    // Serialize each frame
    for (const [frameIdx, fg] of state.session.frameGroups) {
        const frameData = {
            instanceGroups: [],
            unlinkedInstances: [],
        };

        // Serialize instance groups
        const groups = state.session.instanceGroups.get(frameIdx) || [];
        for (const group of groups) {
            const groupData = {
                id: group.id,
                identityId: group.identityId != null ? group.identityId : -1,
                instances: {},
                points3d: group.points3d || null,
                reprojections: group.reprojections || null,
                observedPoints: group.observedPoints || null,
                dirty: group.dirty || false,
            };
            if (group.usedCameras) {
                groupData.usedCameras = Array.from(group.usedCameras);
            }
            for (const [camName, inst] of group.instances) {
                const instData = {
                    points: inst.points,
                    trackIdx: inst.trackIdx,
                    type: inst.type,
                    score: inst.score,
                    modified: inst.modified,
                    occluded: inst.occluded,
                };
                if (inst.nulledNodes && inst.nulledNodes.size > 0) {
                    instData.nulledNodes = Array.from(inst.nulledNodes);
                }
                groupData.instances[camName] = instData;
            }
            frameData.instanceGroups.push(groupData);
        }

        // Serialize unlinked instances
        for (const [camName, unlinkedList] of fg.unlinkedInstances) {
            for (const unlinked of unlinkedList) {
                const ulData = {
                    cameraName: camName,
                    points: unlinked.instance.points,
                    trackIdx: unlinked.instance.trackIdx,
                    type: unlinked.instance.type || 'user',
                    score: unlinked.instance.score || 1.0,
                    modified: unlinked.instance.modified || false,
                    occluded: unlinked.instance.occluded,
                };
                if (unlinked.instance.nulledNodes && unlinked.instance.nulledNodes.size > 0) {
                    ulData.nulledNodes = Array.from(unlinked.instance.nulledNodes);
                }
                frameData.unlinkedInstances.push(ulData);
            }
        }

        projectData.frames[frameIdx] = frameData;
    }

    // Build blob in chunks to avoid "invalid string length" on large sessions
    var header = Object.assign({}, projectData);
    delete header.frames;
    var headerJson = JSON.stringify(header);
    // Strip closing "}" so we can append frames
    headerJson = headerJson.slice(0, -1) + ',"frames":{';

    var blobParts = [headerJson];
    var frameKeys = Object.keys(projectData.frames);
    for (var bfi = 0; bfi < frameKeys.length; bfi++) {
        var fk = frameKeys[bfi];
        var prefix = bfi > 0 ? ',' : '';
        blobParts.push(prefix + JSON.stringify(fk) + ':' + JSON.stringify(projectData.frames[fk]));
    }
    blobParts.push('}}');

    var blob = new Blob(blobParts, { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'project.mvgui.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    setStatus('Project saved (' + (blob.size / 1024 / 1024).toFixed(1) + ' MB)', 'success');

    } catch (err) {
        console.error('Save project failed:', err);
        setStatus('Save failed: ' + err.message, 'error');
    }
}

export async function handleLoadProject(prePickedFile) {
    try {
        // Warn + reset if 3D points were imported into a skeleton-only project.
        if (!(await ensureNo3dImportBlockingLoad())) {
            setStatus('Load cancelled', 'warning');
            return;
        }
        var file;
        if (prePickedFile) {
            file = prePickedFile;
        } else {
            setStatus('Picking project file...', 'warning');
            const files = await pickFiles({ accept: '.slp,.json,.h5' });
            if (files.length === 0) {
                setStatus('No file selected', 'warning');
                return;
            }
            file = files[0];
        }

        // Route SLP/H5 files to the SLP loader
        var ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'slp' || ext === 'h5') {
            return handleLoadSlpFile(file);
        }

        var fileSize = file.size;
        if (fileSize > 50 * 1024 * 1024) {
            if (!confirm('Project file is ' + (fileSize / 1024 / 1024).toFixed(0) + 'MB — this may be slow. Continue?')) {
                setStatus('Load cancelled', 'warning');
                return;
            }
        }
        showLoading('Loading project (' + (fileSize / 1024 / 1024).toFixed(1) + ' MB)...');

        const text = await file.text();
        showLoading('Parsing project...');
        const data = JSON.parse(text);

        // 1. Restore session data (cameras, skeleton, instances, groups)
        var cameras;
        if (data.version === 3) {
            cameras = _restoreProjectV3(data);
        } else if (data.version === 2) {
            cameras = _restoreProjectV2(data);
        } else {
            cameras = _restoreLegacySession(data);
        }


        // 2. Load videos — check if already loaded, only prompt for missing ones
        hideLoading();

        // For V3 projects, collect video manifests from all sessions
        var videoManifest = data.videoManifest || [];
        if (data.version === 3 && data.sessions) {
            videoManifest = [];
            for (var vsi = 0; vsi < data.sessions.length; vsi++) {
                var sessManifest = data.sessions[vsi].videoManifest || [];
                for (var vmi = 0; vmi < sessManifest.length; vmi++) {
                    sessManifest[vmi]._sessionIdx = vsi;
                    videoManifest.push(sessManifest[vmi]);
                }
            }
        }

        // For V3, use active session's cameras; for V2, use the single session's cameras
        var activeCameras = (data.version === 3 && state.sessions[state.activeSessionIdx])
            ? state.sessions[state.activeSessionIdx].cameras
            : cameras;
        var cameraNames = activeCameras.map(function (c) { return c.name; });
        var manifestFilenames = videoManifest.map(function (m) { return m.filename; }).filter(Boolean);

        // Check which manifest videos are already loaded in state.videoFiles
        var alreadyLoaded = [];
        var missingFilenames = [];
        for (var mfi = 0; mfi < manifestFilenames.length; mfi++) {
            var mfName = manifestFilenames[mfi];
            var found = (state.videoFiles || []).find(function (vf) { return vf.name === mfName; });
            if (found) {
                alreadyLoaded.push(found);
            } else {
                missingFilenames.push(mfName);
            }
        }

        var needsVideoPrompt = missingFilenames.length > 0 || manifestFilenames.length === 0;

        // Clear stale views
        if (videoController) {
            if (state.isPlaying) videoController.pause();
            setVideoController(null);
        }
        state.views = [];
        // Reset decoder pool + cold reserve on V3 project load. Old decoders
        // point at the previous project's files and must be released to
        // avoid dangling mp4box references / leaked file handles. Mirrors
        // the equivalent reset at the top of handleLoadSlpFile.
        if (data.version === 3) {
            if (Array.isArray(state.decoderPool)) {
                for (var _dpi = 0; _dpi < state.decoderPool.length; _dpi++) {
                    var _dp = state.decoderPool[_dpi];
                    if (_dp && typeof _dp.close === 'function') {
                        try { _dp.close(); } catch (_e) {}
                    }
                }
            }
            state.decoderPool = [];
            if (Array.isArray(state._decoderPoolCold)) {
                for (var _dci = 0; _dci < state._decoderPoolCold.length; _dci++) {
                    var _dc = state._decoderPoolCold[_dci];
                    if (_dc && _dc._coldTimer) {
                        clearTimeout(_dc._coldTimer);
                        _dc._coldTimer = null;
                    }
                    if (_dc && typeof _dc.close === 'function') {
                        try { _dc.close(); } catch (_e) {}
                    }
                }
            }
            state._decoderPoolCold = [];
        }
        paneManager.clearAll();

        if (data.version === 3 && data.sessions && needsVideoPrompt) {
            // V3: prompt for session folders — with parent directory option
            var v3AllSessionNames = data.sessions.map(function (sd, idx) { return sd.name || ('Session ' + (idx + 1)); });
            var v3ParentFilesMap = null; // Map<sessionName, File[]> from parent dir pick

            var v3Modal = getLoadingProgressModal({ title: 'Loading videos' });
            v3Modal.reset();
            v3Modal.show();

            for (var psi = 0; psi < data.sessions.length; psi++) {
                var sessData = data.sessions[psi];
                var sessName = sessData.name || ('Session ' + (psi + 1));
                var sessCameras = (sessData.videoManifest || []).map(function (m) { return m.assignedCamera; }).filter(Boolean);

                var folderFiles;
                if (v3ParentFilesMap && v3ParentFilesMap.has(sessName)) {
                    // Already resolved from parent directory pick
                    folderFiles = v3ParentFilesMap.get(sessName);
                } else if (v3ParentFilesMap) {
                    // Parent dir was picked but this session wasn't matched — prompt individually
                    folderFiles = await forceVideoSelectionWithFolder(
                        'Cameras: ' + sessCameras.join(', '),
                        sessName
                    );
                    if (folderFiles && folderFiles.parentResult) folderFiles = []; // shouldn't happen here
                } else {
                    // First session — offer parent directory option
                    var promptResult = await forceVideoSelectionWithFolder(
                        'Cameras: ' + sessCameras.join(', '),
                        sessName,
                        { allSessionNames: v3AllSessionNames }
                    );

                    if (promptResult && promptResult.parentResult) {
                        // User picked parent directory
                        v3ParentFilesMap = promptResult.parentResult.matched;
                        var v3Unmatched = promptResult.parentResult.unmatched;
                        await showParentDirMatchSummary(v3ParentFilesMap, v3Unmatched);

                        // Use matched files for this session
                        folderFiles = v3ParentFilesMap.has(sessName) ? v3ParentFilesMap.get(sessName) : [];
                    } else {
                        folderFiles = promptResult;
                    }
                }

                if (folderFiles && folderFiles.length > 0) {
                    var videoExtensions = ['.mp4', '.avi', '.webm', '.mov', '.mkv'];
                    for (var ffi = 0; ffi < folderFiles.length; ffi++) {
                        var file = folderFiles[ffi];
                        var fnLower = file.name.toLowerCase();
                        var ext = fnLower.substring(fnLower.lastIndexOf('.'));
                        if (videoExtensions.indexOf(ext) < 0) continue;

                        var stem = file.name.replace(/\.[^.]+$/, '');
                        if (state.videoFiles.find(function (vf) { return vf.name === stem; })) continue;

                        showLoading('Loading ' + file.name + '...');
                        var v3TaskId = v3Modal.addTask({ label: file.name || ('camera ' + ffi) });
                        var v3OnProgress = (function (tid) {
                            return function (ev) {
                                if (ev && ev.error) v3Modal.failTask(tid, ev.error);
                                else v3Modal.updateTask(tid, ev);
                            };
                        })(v3TaskId);
                        try {
                            var decoder = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10, onProgress: v3OnProgress });
                            await decoder.init(file);
                            var vw = decoder.videoTrack.video.width;
                            var vh = decoder.videoTrack.video.height;

                            // Figure out camera from subdirectory path
                            var relPath = file.webkitRelativePath || file.name;
                            var pathParts = relPath.split('/');
                            var dirCam = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : null;

                            // Match to manifest camera
                            var assignedCam = null;
                            if (dirCam) {
                                var dirCamLower = dirCam.toLowerCase();
                                for (var sci = 0; sci < sessCameras.length; sci++) {
                                    if (sessCameras[sci].toLowerCase() === dirCamLower) {
                                        assignedCam = sessCameras[sci];
                                        break;
                                    }
                                }
                            }

                            var vfIdx = state.videoFiles.length;
                            state.videoFiles.push({
                                file: file,
                                name: stem,
                                decoder: decoder,
                                videoWidth: vw,
                                videoHeight: vh,
                                frameCount: decoder.samples.length,
                                assignedCamera: assignedCam,
                                videoPath: relPath,
                                sessionIdx: psi,
                            });

                            if (state.sessions[psi] && state.sessions[psi].videoFileIndices.indexOf(vfIdx) < 0) {
                                state.sessions[psi].videoFileIndices.push(vfIdx);
                            }
                            v3Modal.completeTask(v3TaskId);
                        } catch (vidErr) {
                            console.error('Failed to load ' + file.name + ':', vidErr);
                            v3Modal.failTask(v3TaskId, vidErr);
                        }
                    }
                }
            }
            hideLoading();

        } else if (needsVideoPrompt) {
            // V2 / legacy: single prompt for video files
            var manifestInfo = missingFilenames.length > 0
                ? 'Need: ' + missingFilenames.join(', ')
                : (manifestFilenames.join(', ') || '(unknown)');
            var videoFiles = await forceVideoSelection(manifestInfo);

            if (videoFiles.length > 0) {
                for (var i = 0; i < videoFiles.length; i++) {
                    var file2 = videoFiles[i];
                    var stem2 = file2.name.replace(/\.[^.]+$/, '');
                    if (state.videoFiles.find(function (vf) { return vf.name === stem2; })) continue;

                    showLoading('Loading ' + file2.name + ' (' + (i + 1) + '/' + videoFiles.length + ')...');
                    try {
                        var decoder2 = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
                        await decoder2.init(file2);
                        state.videoFiles.push({
                            file: file2,
                            name: stem2,
                            decoder: decoder2,
                            videoWidth: decoder2.videoTrack.video.width,
                            videoHeight: decoder2.videoTrack.video.height,
                            frameCount: decoder2.samples.length,
                            assignedCamera: null,
                            videoPath: file2.webkitRelativePath || file2.name,
                        });
                    } catch (videoErr) {
                        console.error('Failed to load ' + file2.name + ':', videoErr);
                    }
                }
            }
            hideLoading();

            // Match videos to cameras using manifest (V2 path)
            for (var mi = 0; mi < videoManifest.length; mi++) {
                var entry = videoManifest[mi];
                if (!entry.filename || !entry.assignedCamera) continue;
                for (var vfi = 0; vfi < state.videoFiles.length; vfi++) {
                    var vf = state.videoFiles[vfi];
                    if (!vf.assignedCamera && vf.name === entry.filename) {
                        vf.assignedCamera = entry.assignedCamera;
                        break;
                    }
                }
            }
        }

        // Resolve stale manifest camera names (active session only for V3)
        for (var ri = 0; ri < state.videoFiles.length; ri++) {
            var rvf = state.videoFiles[ri];
            if (data.version === 3 && rvf.sessionIdx != null && rvf.sessionIdx !== state.activeSessionIdx) continue;
            if (rvf.assignedCamera && cameraNames.indexOf(rvf.assignedCamera) < 0) {
                var rvfLower = rvf.assignedCamera.toLowerCase();
                for (var rci = 0; rci < cameraNames.length; rci++) {
                    var rcamLower = cameraNames[rci].toLowerCase();
                    var rUsed = state.videoFiles.some(function (other) {
                        return other !== rvf && other.assignedCamera === cameraNames[rci];
                    });
                    if (rUsed) continue;
                    if (rvfLower === rcamLower || rvfLower.indexOf(rcamLower) >= 0 || rcamLower.indexOf(rvfLower) >= 0) {
                        console.log('[load-project] Resolved manifest camera "' + rvf.assignedCamera + '" -> "' + cameraNames[rci] + '"');
                        rvf.assignedCamera = cameraNames[rci];
                        break;
                    }
                }
            }
        }

        autoAssignVideosToCameras();

        // For any still-unassigned video, try exact camera name match (active session only for V3)
        for (var vi = 0; vi < state.videoFiles.length; vi++) {
            var vf2 = state.videoFiles[vi];
            if (data.version === 3 && vf2.sessionIdx != null && vf2.sessionIdx !== state.activeSessionIdx) continue;
            if (!vf2.assignedCamera && cameraNames.indexOf(vf2.name) >= 0) {
                vf2.assignedCamera = vf2.name;
            }
        }

        // Create views for assigned videos (active session only for V3)
        showLoading('Creating views...');
        for (var vi2 = 0; vi2 < state.videoFiles.length; vi2++) {
            var vf3 = state.videoFiles[vi2];
            // For V3 projects, only create views for the active session
            if (data.version === 3 && vf3.sessionIdx != null && vf3.sessionIdx !== state.activeSessionIdx) {
                continue;
            }
            if (vf3.assignedCamera) {
                var hasView = state.views.some(function (v) { return v.name === vf3.assignedCamera; });
                if (!hasView) {
                    createViewForVideoFile(vf3);
                }
            }
        }

        updateTotalFrames();
        if (state.views.length > 0) {
            hideWelcomeOverlay();
            populateViewStrip();
            populateSessionStrip();
            paneManager.addAllViewsAsGrid();
            rebuildVideoController();
            fitCanvasesToCells();
        }

        // Seek to first labeled frame or frame 0
        if (videoController && state.views.length > 0) {
            var firstFrame = 0;
            for (var [fIdx] of state.session.frameGroups) {
                firstFrame = fIdx;
                break;
            }
            state.currentFrame = firstFrame;
            await videoController.seekToFrame(firstFrame);
        }

        // 3. Set up 3D viewport (use active session's cameras)
        if (viewport3d) {
            viewport3d.cameras = state.session.cameras;
            viewport3d.skeleton = state.session.skeleton;
            viewport3d.addCameraPyramids();
            viewport3d.setFrame(getInstanceGroupsForFrame(state.currentFrame));
            viewport3d.fitToScene();
        } else {
            setup3DViewport();
        }

        // 4. Draw overlays and update UI
        if (state.triangulationResults.size > 0) {
            setReprojErrorVisible(true);
        }
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.setData(state.session);

        hideLoading();

        var statusParts = [cameras.length + ' cameras', state.session.numFrames + ' labeled frames'];
        if (state.views.length > 0) {
            statusParts.push(state.views.length + ' views');
        }
        setStatus('Project loaded (' + statusParts.join(', ') + ')', 'success');
    } catch (err) {
        console.error('Failed to load project:', err);
        hideLoading();
        setStatus('Load error: ' + err.message, 'error');
    }
}

function _restoreProjectV3(data) {
    state.sessions = [];
    state.triangulationResults = new Map();
    var allCameras = null;

    for (var si = 0; si < data.sessions.length; si++) {
        var sd = data.sessions[si];
        // Reuse _restoreProjectV2 logic per session
        var sessionData = Object.assign({}, sd, { version: 2 });
        var cameras = _restoreProjectV2(sessionData);
        // _restoreProjectV2 sets state.session and pushes to state.sessions
        state.session.name = sd.name || ('Session ' + (si + 1));

        // Store triangulation results on session object
        state.session.triangulationResults = state.triangulationResults;
        state.triangulationResults = new Map();

        if (si === 0) allCameras = cameras;
    }

    // Activate first session
    state.activeSessionIdx = 0;
    state.session = state.sessions[0];
    state.triangulationResults = state.sessions[0].triangulationResults || new Map();

    return allCameras;
}

/**
 * Restore session data from a v2 project JSON. Sets state.session.
 * @returns {Camera[]} parsed cameras
 */
function _restoreProjectV2(data) {
    var cameras = [];
    if (data.cameras) {
        cameras = parseCalibrationJSON(JSON.stringify({ cameras: data.cameras }));
    }

    var skeleton;
    if (data.skeleton) {
        skeleton = new Skeleton(
            data.skeleton.name || 'skeleton',
            data.skeleton.nodes || [],
            data.skeleton.edges || []
        );
    } else {
        skeleton = createDemoSkeleton();
    }

    var tracks = data.tracks || ['track_0'];
    var session = new Session(cameras, skeleton, tracks);

    if (data.identities) {
        for (var idi = 0; idi < data.identities.length; idi++) {
            var idData = data.identities[idi];
            session.identities.push(new Identity(idData.id, idData.name, idData.color));
        }
    }
    if (data.trustTracks != null) session.trustTracks = data.trustTracks;
    // Legacy global identity map (removed). Captured here and migrated to
    // per-frame entries after frame groups load (see end of this function).
    var legacyGlobalIdentities = data.trackIdentityMap || null;
    if (data.frameIdentityMap && data.frameIdentityMap.length > 0) {
        if (!session.frameIdentityMap) session.frameIdentityMap = new Map();
        for (var fmi = 0; fmi < data.frameIdentityMap.length; fmi++) {
            session.frameIdentityMap.set(data.frameIdentityMap[fmi][0], data.frameIdentityMap[fmi][1]);
        }
    }

    if (data.frames) {
        for (var frameIdxStr in data.frames) {
            var frameIdx = parseInt(frameIdxStr);
            var frameData = data.frames[frameIdxStr];
            var fg = new FrameGroup(frameIdx);

            if (frameData.instanceGroups) {
                if (!session.instanceGroups.has(frameIdx)) {
                    session.instanceGroups.set(frameIdx, []);
                }

                for (var gi = 0; gi < frameData.instanceGroups.length; gi++) {
                    var groupData = frameData.instanceGroups[gi];
                    // Backwards compat: if groupData has trackIdx but no identityId, use trackIdx as identityId
                    var loadedIdentityId = groupData.identityId != null ? groupData.identityId
                        : (groupData.trackIdx != null ? groupData.trackIdx : -1);
                    var group = new InstanceGroup(groupData.id || Date.now(), loadedIdentityId);
                    if (groupData.points3d) {
                        group.points3d = groupData.points3d;
                    }
                    if (groupData.reprojections) {
                        group.reprojections = groupData.reprojections;
                    }
                    if (groupData.observedPoints) {
                        group.observedPoints = groupData.observedPoints;
                    }

                    for (var camName in groupData.instances) {
                        var instData = groupData.instances[camName];
                        var inst = new Instance(
                            instData.points,
                            instData.trackIdx != null ? instData.trackIdx : (groupData.trackIdx != null ? groupData.trackIdx : 0),
                            instData.type || 'user',
                            instData.score || 1.0
                        );
                        inst.modified = instData.modified || false;
                        if (instData.occluded) inst.occluded = instData.occluded;
                        if (instData.nulledNodes && instData.nulledNodes.length > 0) {
                            inst.nulledNodes = new Set(instData.nulledNodes);
                        }
                        group.addInstance(camName, inst);
                        fg.addInstance(camName, inst);
                    }

                    if (groupData.usedCameras) {
                        group.usedCameras = new Set(groupData.usedCameras);
                    }
                    if (groupData.dirty) {
                        group.markDirty();
                    } else if (group.points3d) {
                        group.markClean();
                    }

                    // Rebuild reprojectedInstances from saved reprojections
                    if (group.reprojections) {
                        for (var rCamName in group.reprojections) {
                            var rPts = group.reprojections[rCamName];
                            if (rPts) {
                                var rInst = new Instance(rPts, group.identityId, 'reprojected', 0);
                                group.addReprojectedInstance(rCamName, rInst);
                            }
                        }
                    }

                    session.instanceGroups.get(frameIdx).push(group);
                }
            }

            if (frameData.unlinkedInstances) {
                for (var ui = 0; ui < frameData.unlinkedInstances.length; ui++) {
                    var ulData = frameData.unlinkedInstances[ui];
                    var ulInst = new Instance(
                        ulData.points,
                        ulData.trackIdx != null ? ulData.trackIdx : 0,
                        ulData.type || 'user',
                        ulData.score || 1.0
                    );
                    ulInst.modified = ulData.modified || false;
                    if (ulData.occluded) ulInst.occluded = ulData.occluded;
                    if (ulData.nulledNodes && ulData.nulledNodes.length > 0) {
                        ulInst.nulledNodes = new Set(ulData.nulledNodes);
                    }
                    var unlinked = new UnlinkedInstance(ulInst, ulData.cameraName);
                    fg.addUnlinkedInstance(ulData.cameraName, unlinked);
                }
            }

            session.addFrameGroup(fg);
        }
    }

    // Migrate any legacy global identities into per-frame entries now that
    // frame groups exist (preserves identities from pre-per-frame projects).
    if (legacyGlobalIdentities && legacyGlobalIdentities.length) {
        var migrated = session.migrateGlobalIdentitiesToPerFrame(legacyGlobalIdentities);
        if (migrated) console.log('[load] migrated', migrated, 'legacy global identities to per-frame');
    }

    state.session = session;
    if (state.sessions.indexOf(state.session) < 0) {
        state.sessions.push(state.session);
        state.activeSessionIdx = state.sessions.length - 1;
    }
    state.triangulationResults = new Map();

    // Rebuild triangulationResults from saved reprojection/error data
    for (var [trFrameIdx, trGroups] of session.instanceGroups) {
        var trFrameResults = [];
            for (var trgi = 0; trgi < trGroups.length; trgi++) {
                var trGroup = trGroups[trgi];
                if (trGroup.points3d && trGroup.reprojections) {
                    // Recompute errors from saved observed + reprojected points
                    var trErrors = {};
                    var trTotalErr = 0, trTotalCount = 0;
                    for (var trCamName in trGroup.reprojections) {
                        var trObs = trGroup.observedPoints ? trGroup.observedPoints[trCamName] : null;
                        var trRep = trGroup.reprojections[trCamName];
                        if (!trObs || !trRep) continue;
                        trErrors[trCamName] = [];
                        for (var trni = 0; trni < trRep.length; trni++) {
                            if (trObs[trni] && trRep[trni]) {
                                var dx = trRep[trni][0] - trObs[trni][0];
                                var dy = trRep[trni][1] - trObs[trni][1];
                                var err = Math.sqrt(dx * dx + dy * dy);
                                trErrors[trCamName].push(err);
                                trTotalErr += err;
                                trTotalCount++;
                            } else {
                                trErrors[trCamName].push(null);
                            }
                        }
                    }
                    trFrameResults.push({
                        group: trGroup,
                        points3d: trGroup.points3d,
                        reprojections: trGroup.reprojections,
                        errors: trErrors,
                        meanError: trTotalCount > 0 ? trTotalErr / trTotalCount : null
                    });
                    // Also store reprojected instances for overlay rendering
                    storeReprojectedInstances(trGroup, { reprojections: trGroup.reprojections, points3d: trGroup.points3d }, cameras);
                }
            }
        if (trFrameResults.length > 0) {
            state.triangulationResults.set(trFrameIdx, trFrameResults);
        }
    }

    // Fix camera name mismatches: instance keys may differ from camera names
    // (e.g., instances keyed by video name "CamA" but camera named "A")
    _resolveInstanceCameraNames(session, cameras, data.videoManifest || []);

    return cameras;
}

/**
 * Resolve camera name mismatches between instance keys and calibration camera names.
 * Uses the videoManifest to build old→new name mapping, then renames all instance data.
 */
function _resolveInstanceCameraNames(session, cameras, videoManifest) {
    var cameraNames = cameras.map(function (c) { return c.name; });

    // Collect all instance keys actually used in the data
    var usedKeys = new Set();
    for (var [fIdx, groups] of session.instanceGroups) {
        for (var g of groups) {
            for (var key of g.instances.keys()) usedKeys.add(key);
        }
    }
    for (var [fIdx2, fg] of session.frameGroups) {
        for (var fgKey of fg.instances.keys()) usedKeys.add(fgKey);
        for (var ulKey of fg.unlinkedInstances.keys()) usedKeys.add(ulKey);
    }

    // Check if all used keys already match camera names
    var allMatch = true;
    for (var usedKey of usedKeys) {
        if (cameraNames.indexOf(usedKey) < 0) { allMatch = false; break; }
    }
    if (allMatch) return; // No mismatch

    console.log('[project] Instance keys', Array.from(usedKeys), 'do not match camera names', cameraNames);

    // Build mapping from old names to new names
    // Strategy 1: Use videoManifest (filename → assignedCamera → camera name)
    var renameMap = {};
    for (var mi = 0; mi < videoManifest.length; mi++) {
        var entry = videoManifest[mi];
        var oldKey = entry.assignedCamera || entry.filename;
        if (!oldKey || cameraNames.indexOf(oldKey) >= 0) continue; // Already matches
        // Try to match this old key to a camera by substring
        var oldLower = oldKey.toLowerCase();
        for (var ci = 0; ci < cameraNames.length; ci++) {
            var camLower = cameraNames[ci].toLowerCase();
            var alreadyMapped = false;
            for (var mk in renameMap) {
                if (renameMap[mk] === cameraNames[ci]) { alreadyMapped = true; break; }
            }
            if (alreadyMapped) continue;
            if (oldLower === camLower || oldLower.indexOf(camLower) >= 0 || camLower.indexOf(oldLower) >= 0) {
                renameMap[oldKey] = cameraNames[ci];
                break;
            }
        }
    }

    // Strategy 2: For any used key not in renameMap, try direct substring match
    for (var usedKey2 of usedKeys) {
        if (cameraNames.indexOf(usedKey2) >= 0) continue; // Already matches
        if (renameMap[usedKey2]) continue; // Already mapped
        var usedLower = usedKey2.toLowerCase();
        for (var ci2 = 0; ci2 < cameraNames.length; ci2++) {
            var camLower2 = cameraNames[ci2].toLowerCase();
            var alreadyMapped2 = false;
            for (var mk2 in renameMap) {
                if (renameMap[mk2] === cameraNames[ci2]) { alreadyMapped2 = true; break; }
            }
            if (alreadyMapped2) continue;
            if (usedLower === camLower2 || usedLower.indexOf(camLower2) >= 0 || camLower2.indexOf(usedLower) >= 0) {
                renameMap[usedKey2] = cameraNames[ci2];
                break;
            }
        }
    }

    // Apply renames
    for (var oldName in renameMap) {
        console.log('[project] Renaming instance key "' + oldName + '" -> "' + renameMap[oldName] + '"');
        session.renameCameraInAllData(oldName, renameMap[oldName]);
    }
}

/**
 * Restore session data from a legacy (flat) project JSON. Sets state.session.
 * @returns {Camera[]} parsed cameras
 */
function _restoreLegacySession(data) {
    var cameras = [];
    if (data.cameras) {
        cameras = parseCalibrationJSON(JSON.stringify({ cameras: data.cameras }));
    }

    var skeleton;
    if (data.skeleton) {
        skeleton = new Skeleton(
            data.skeleton.name || 'skeleton',
            data.skeleton.nodes || [],
            data.skeleton.edges || []
        );
    } else {
        skeleton = createDemoSkeleton();
    }

    var tracks = data.tracks || ['track_0'];
    var session = new Session(cameras, skeleton, tracks);

    if (data.frames) {
        for (var frameIdxStr in data.frames) {
            var frameIdx = parseInt(frameIdxStr);
            var frameData = data.frames[frameIdxStr];
            var fg = new FrameGroup(frameIdx);

            for (var camName in frameData) {
                if (camName === 'instanceGroups' || camName === 'unlinkedInstances') continue;
                var instances = frameData[camName];
                if (!Array.isArray(instances)) continue;
                for (var i = 0; i < instances.length; i++) {
                    var instData = instances[i];
                    var inst = new Instance(
                        instData.points,
                        instData.trackIdx || 0,
                        instData.type || 'user',
                        instData.score || 1.0
                    );
                    inst.modified = instData.modified || false;
                    fg.addInstance(camName, inst);
                }
            }

            session.addFrameGroup(fg);
        }
    }

    // Reconstruct InstanceGroups by grouping instances with the same trackIdx
    for (var [frameIdx2, fg2] of session.frameGroups) {
        var trackInstances = new Map();
        for (var [cn, insts] of fg2.instances) {
            for (var ii = 0; ii < insts.length; ii++) {
                var tIdx = insts[ii].trackIdx || 0;
                if (!trackInstances.has(tIdx)) trackInstances.set(tIdx, []);
                trackInstances.get(tIdx).push({ camName: cn, instance: insts[ii] });
            }
        }
        if (!session.instanceGroups.has(frameIdx2)) session.instanceGroups.set(frameIdx2, []);
        for (var [trkIdx, entries] of trackInstances) {
            var grp = new InstanceGroup(Date.now() + trkIdx, trkIdx); // identityId = trackIdx for backwards compat
            for (var ei = 0; ei < entries.length; ei++) grp.addInstance(entries[ei].camName, entries[ei].instance);
            session.instanceGroups.get(frameIdx2).push(grp);
        }
    }

    state.session = session;
    if (state.sessions.indexOf(state.session) < 0) {
        state.sessions.push(state.session);
        state.activeSessionIdx = state.sessions.length - 1;
    }
    state.triangulationResults = new Map();

    // Fix camera name mismatches
    _resolveInstanceCameraNames(session, cameras, data.videoManifest || []);

    return cameras;
}

// ============================================
// Loading / Status
// ============================================

export function showLoading(msg) {
    document.getElementById('loadingOverlay').classList.remove('hidden');
    document.getElementById('loadingStatus').textContent = msg || 'Loading...';
}

export function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
}

export function setStatus(text, type) {
    document.getElementById('statusText').textContent = text;
    const dot = document.getElementById('statusDot');
    dot.className = 'status-dot';
    if (type === 'error') dot.classList.add('error');
    else if (type === 'warning') dot.classList.add('warning');
    else if (type === 'success') dot.classList.add('success');
}
