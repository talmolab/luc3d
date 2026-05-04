// ui/ui-wiring.js — Pass 3e-1 extraction
//
// Hosts the main UI wiring layer: menu setup, top-level UI setup
// (transport controls, keyboard handlers, visibility tab), UI update
// helpers (seekbar, playback state, info-panel/3D/timeline toggles,
// fitTimelineToData), grid/single view-mode switching, and the
// playback-rate helper. Extracted from app.js per the consolidated
// Pass 3 plan, Module 9.

import { state, videoController, interactionManager, viewport3d, timeline, paneManager,
         setVideoController, setInteractionManager, setViewport3D, setTimeline, VIEW_NAMES,
         getActiveSession } from './app-state.js';
import { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, UnlinkedInstance, Identity, Session } from '../pose/pose-data.js';
import { ensureLazyFrameData, batchLoadLazyFrames, getInstanceGroupsForFrame, evictLazyFrames,
         loadAllLazyFrames, updateTimelineForFrame, triangulateAndReproject } from '../pose/triangulation.js';
import { drawAllOverlays, getVisibilitySettings, updateFrameCounters, setReprojErrorVisible } from './rendering.js';
import { updateInfoPanel, updateFrameInfo, updateTriangulationBadge,
         populateVideosTable, populateCamerasTable, populateSkeletonTable,
         setupPanelTabs, setupSkeletonEditing, parseSkeletonJSON, exportSkeletonJSON,
         ensureSession, populateSessionAssignTable, populateUnassignedVideos } from './info-panel.js';
import { newProject, markDirty, clearDirty, quickSave, saveAs, saveProjectSlp, saveProject,
         handleLoadProject, showLoading, hideLoading, setStatus } from '../import-export/save-load.js';
import { handleLoadSlpFile, handleAddSlp, handleLoadPoints3dH5 } from '../import-export/slp-import.js';
import { pickFiles, parseCalibrationJSON, exportCalibrationTOML, downloadTOML, parseSlpH5 } from '../import-export/file-io.js';
import { handleLoadCalibration, handleLoadVideos, handleLoadMultiSession,
         loadSingleSessionFromCache, showSessionModeModal, autoAssignVideosToCameras } from '../loading/session-loader.js';
import { OnDemandVideoDecoder, VideoController } from '../loading/video.js';

// Circular imports back to app.js for symbols destined for later passes.
// These will be retargeted as Passes 3h / 3i land.
//   - assign* / startEditGroup / finishEditGroup / startManualAssignment /
//     runSingleFrameTriangulation / showMultiFrameModal / propagateIdentityForward /
//     swapAssignTrack / purgeTriangulationDataForGroup → ui/identity-assignment.js (Pass 3f)
//   - showSlp* / showTriangulateMultiFrameModal / exportLabels / exportPoints3dH5 /
//     exportReprojH5 / showGroupByTrackModal / groupByIdentityAndTriangulateAll
//     → ui/export-modals.js (Pass 3g)
//   - removeSession / showMoveVideoModal / switchSession / populateViewStrip /
//     populateSessionStrip / populateSessionsPanel / clearMultiSelect /
//     refreshPaneInteractions / syncRotationUI → ui/sessions-panes.js (Pass 3h)
//   - trackCurrentFrame / trackAll / findMatchForSelected → pose/tracker.js (Pass 3i)
//   - addNewInstanceSmart / triangulateCurrentFrame / triangulateAllFrames /
//     update3DViewport → may end up in pose/initialization.js (3i) or stay in app.js
import {
    addNewInstanceSmart,
    triangulateCurrentFrame, triangulateAllFrames,
    update3DViewport,
    syncRotationUI, clearMultiSelect, refreshPaneInteractions,
    trackCurrentFrame, trackAll, findMatchForSelected,
    removeSession, showMoveVideoModal,
    switchSession,
    populateViewStrip, populateSessionStrip, populateSessionsPanel,
    // Symbols caught by Subagent B that ui-wiring needs but app.js hadn't exported:
    swapTracks, clampRotation, seekToLabeledFrame,
    panelRenderers, multiSelectViews,
} from '../app.js';
// Pass 3f: identity-assignment workflow symbols moved out of app.js.
import {
    assignTrackToSelected, assignIdentityToSelected, propagateIdentityForward, swapAssignTrack,
    startEditGroup, finishEditGroup,
    startManualAssignment, runSingleFrameTriangulation, showMultiFrameModal,
    purgeTriangulationDataForGroup,
} from './identity-assignment.js';
// Pass 3g: export-modals workflow symbols moved out of app.js.
import {
    exportLabels, exportPoints3dH5, exportReprojH5,
    showSlpExportModal, showSlpExportAllModal, showTriangulateMultiFrameModal,
    showGroupByTrackModal, groupByIdentityAndTriangulateAll,
} from './export-modals.js';

// ============================================
// Menu Setup
// ============================================

export function setupMenus() {
    // Menu bar toggle behavior
    const menuItems = document.querySelectorAll('.menu-item');
    let activeMenu = null;

    menuItems.forEach(function (item) {
        item.addEventListener('click', function (e) {
            e.stopPropagation();
            const dropdown = item.querySelector('.menu-dropdown');
            if (!dropdown) return;

            if (activeMenu === dropdown) {
                dropdown.style.display = 'none';
                activeMenu = null;
            } else {
                // Close any open menu
                document.querySelectorAll('.menu-dropdown').forEach(function (d) {
                    d.style.display = 'none';
                });
                dropdown.style.display = 'block';
                activeMenu = dropdown;
            }
        });
    });

    // Close menus when clicking elsewhere
    document.addEventListener('click', function (e) {
        document.querySelectorAll('.menu-dropdown').forEach(function (d) {
            d.style.display = 'none';
        });
        document.querySelectorAll('.toolbar-dropdown').forEach(function (d) {
            d.style.display = 'none';
        });
        hideGroupContextMenu();
        activeMenu = null;
        // Clear multi-select when clicking outside the view strip
        if (typeof multiSelectViews !== 'undefined' && multiSelectViews.size > 0) {
            var viewStrip = document.getElementById('viewStripList');
            if (viewStrip && !viewStrip.contains(e.target)) {
                clearMultiSelect();
            }
        }
    });

    // Prevent dropdown clicks from closing the menu immediately
    document.querySelectorAll('.menu-dropdown').forEach(function (d) {
        d.addEventListener('click', function (e) { e.stopPropagation(); });
    });

    // Menu actions
    document.getElementById('menuAddInstance').addEventListener('click', function () {
        closeMenus();
        if (interactionManager) interactionManager._addNewInstance();
    });

    document.getElementById('menuDeleteInstance').addEventListener('click', function () {
        closeMenus();
        if (interactionManager) interactionManager._deleteSelected();
    });

    document.getElementById('menuUnlinkGroup').addEventListener('click', function () {
        closeMenus();
        if (interactionManager && interactionManager.selectedInstanceGroup) {
            unlinkGroup(interactionManager.selectedInstanceGroup);
        }
    });

    document.getElementById('menuTriangulate').addEventListener('click', function () {
        closeMenus();
        triangulateCurrentFrame();
    });

    document.getElementById('menuTriangulateMulti').addEventListener('click', function () {
        closeMenus();
        showTriangulateMultiFrameModal();
    });

    document.getElementById('menuGroupByTrack').addEventListener('click', function () {
        closeMenus();
        showGroupByTrackModal();
    });
    document.getElementById('menuGroupByIdentity').addEventListener('click', function () {
        closeMenus();
        groupByIdentityAndTriangulateAll();
    });

    document.getElementById('menuTrustTracks').addEventListener('click', function () {
        closeMenus();
        if (!state.session) return;
        state.session.trustTracks = !state.session.trustTracks;
        var check = document.getElementById('menuTrustTracksCheck');
        check.textContent = state.session.trustTracks ? '☑' : '☐';

        // When trusting tracks, propagate track numbers to identities
        if (state.session.trustTracks) {
            // Create identity for each track name (fast — just uses tracks array)
            for (var ti = 0; ti < state.session.tracks.length; ti++) {
                state.session.getOrCreateIdentityForTrack(ti);
            }
            // Assign identities to existing groups by track
            for (var [fIdx2, groups] of state.session.instanceGroups) {
                for (var gi = 0; gi < groups.length; gi++) {
                    var identity = state.session.getOrCreateIdentityForTrack(groups[gi].identityId);
                    state.session.assignIdentityToGroup(groups[gi], identity.id);
                }
            }
            // Auto-switch to Color by Identity
            state.colorByIdentity = true;
            updateColorByChecks();
            setStatus('Trust Track Labels: ON — ' + state.session.tracks.length + ' identities from tracks', 'success');
            drawAllOverlays(state.currentFrame);
            updateInfoPanel();
            if (timeline) timeline.refreshTracks(state.session);
        } else {
            setStatus('Trust Track Labels: OFF — tracks and identities are independent', 'success');
        }
    });

    // Color by Track / Color by Identity toggles
    function updateColorByChecks() {
        document.getElementById('menuColorByTrackCheck').textContent = state.colorByIdentity ? '☐' : '☑';
        document.getElementById('menuColorByIdCheck').textContent = state.colorByIdentity ? '☑' : '☐';
    }

    document.getElementById('menuColorByTrack').addEventListener('click', function () {
        closeMenus();
        state.colorByIdentity = false;
        updateColorByChecks();
        drawAllOverlays(state.currentFrame);
        setStatus('Coloring by Track', 'success');
    });

    document.getElementById('menuColorById').addEventListener('click', function () {
        closeMenus();
        state.colorByIdentity = true;
        updateColorByChecks();
        drawAllOverlays(state.currentFrame);
        setStatus('Coloring by Identity', 'success');
    });

    // ============================================
    // Tracks Menu Handlers
    // ============================================

    document.getElementById('menuNewTrack').addEventListener('click', function () {
        closeMenus();
        if (!state.session) { setStatus('No session', 'warning'); return; }
        var name = prompt('New track name:', 'track_' + state.session.tracks.length);
        if (!name) return;
        if (state.session.tracks.indexOf(name) >= 0) {
            setStatus('Track "' + name + '" already exists', 'warning');
            return;
        }
        state.session.tracks.push(name);
        setStatus('Created track: ' + name, 'success');
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(state.session);
    });

    document.getElementById('menuRenameTrack').addEventListener('click', function () {
        closeMenus();
        if (!state.session || state.session.tracks.length === 0) { setStatus('No tracks', 'warning'); return; }
        var trackList = state.session.tracks.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n');
        var idx = parseInt(prompt('Which track to rename?\n\n' + trackList + '\n\nEnter number:')) - 1;
        if (isNaN(idx) || idx < 0 || idx >= state.session.tracks.length) return;
        var newName = prompt('New name for "' + state.session.tracks[idx] + '":', state.session.tracks[idx]);
        if (!newName) return;
        state.session.tracks[idx] = newName;
        setStatus('Renamed track ' + (idx + 1) + ' to: ' + newName, 'success');
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(state.session);
    });

    document.getElementById('menuDeleteTrack').addEventListener('click', function () {
        closeMenus();
        if (!state.session || state.session.tracks.length === 0) { setStatus('No tracks', 'warning'); return; }
        var trackList = state.session.tracks.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n');
        var idx = parseInt(prompt('Which track to delete?\n\n' + trackList + '\n\nEnter number:')) - 1;
        if (isNaN(idx) || idx < 0 || idx >= state.session.tracks.length) return;
        var name = state.session.tracks[idx];
        if (!confirm('Delete track "' + name + '"? Instances will become trackless.')) return;
        state.session.tracks.splice(idx, 1);
        // Shift trackIdx on all instances
        for (var [fIdx, fg] of state.session.frameGroups) {
            for (var [cn, insts] of fg.instances) {
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].trackIdx === idx) insts[i].trackIdx = -1;
                    else if (insts[i].trackIdx > idx) insts[i].trackIdx--;
                }
            }
            for (var [cn2, ulList] of fg.unlinkedInstances) {
                for (var u = 0; u < ulList.length; u++) {
                    if (ulList[u].instance.trackIdx === idx) ulList[u].instance.trackIdx = -1;
                    else if (ulList[u].instance.trackIdx > idx) ulList[u].instance.trackIdx--;
                }
            }
        }
        setStatus('Deleted track: ' + name, 'success');
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(state.session);
    });

    // Track/identity helpers are now top-level functions (above setupMenus)

    // Populate Assign Track submenu on hover
    document.getElementById('menuAssignTrack').addEventListener('mouseenter', function () {
        var sub = document.getElementById('menuAssignTrackSub');
        sub.innerHTML = '';
        if (!state.session) return;
        for (var i = 0; i < state.session.tracks.length; i++) {
            var item = document.createElement('div');
            item.className = 'menu-submenu-item';
            item.textContent = state.session.tracks[i];
            item.setAttribute('data-idx', i);
            item.addEventListener('click', function (ev) {
                ev.stopPropagation();
                closeMenus();
                assignTrackToSelected(parseInt(this.getAttribute('data-idx')));
            });
            sub.appendChild(item);
        }
        // "New Track..." option at bottom
        var newItem = document.createElement('div');
        newItem.className = 'menu-submenu-item menu-submenu-new';
        newItem.textContent = '+ New Track...';
        newItem.addEventListener('click', function (ev) {
            ev.stopPropagation();
            closeMenus();
            var name = prompt('New track name:', 'track_' + state.session.tracks.length);
            if (!name) return;
            if (state.session.tracks.indexOf(name) < 0) state.session.tracks.push(name);
            var idx = state.session.tracks.indexOf(name);
            assignTrackToSelected(idx);
            // Always refresh UI (assignTrackToSelected may return early if nothing selected)
            drawAllOverlays(state.currentFrame);
            updateInfoPanel();
            if (timeline) timeline.refreshTracks(state.session);
        });
        sub.appendChild(newItem);
    });

    document.getElementById('menuSwapTracks').addEventListener('click', function () {
        closeMenus();
        if (!state.session || state.session.tracks.length < 2) { setStatus('Need at least 2 tracks', 'warning'); return; }
        var trackList = state.session.tracks.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n');
        var a = parseInt(prompt('Swap track A?\n\n' + trackList + '\n\nEnter number:')) - 1;
        if (isNaN(a) || a < 0 || a >= state.session.tracks.length) return;
        var b = parseInt(prompt('Swap with track B?\n\n' + trackList + '\n\nEnter number:')) - 1;
        if (isNaN(b) || b < 0 || b >= state.session.tracks.length || b === a) return;

        var frameStart = parseInt(prompt('Start frame (1-indexed):', state.currentFrame + 1)) - 1;
        var frameEnd = parseInt(prompt('End frame (1-indexed, or 0 for all):', 0)) - 1;
        if (frameEnd < 0) frameEnd = state.totalFrames;

        var count = swapTracks(a, b, frameStart, frameEnd);
        setStatus('Swapped ' + state.session.tracks[a] + ' ↔ ' + state.session.tracks[b] +
            ' (' + count + ' instances, frames ' + (frameStart + 1) + '–' + (frameEnd + 1) + ')', 'success');
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(state.session);
    });

    // ============================================
    // Identity Menu Handlers
    // ============================================

    document.getElementById('menuNewIdentity').addEventListener('click', function () {
        closeMenus();
        if (!state.session) { setStatus('No session', 'warning'); return; }
        var name = prompt('New identity name:', 'identity_' + state.session.identities.length);
        if (!name) return;
        var existing = state.session.identities.find(function (id) { return id.name === name; });
        if (existing) { setStatus('Identity "' + name + '" already exists', 'warning'); return; }
        state.session.addIdentity(name);
        setStatus('Created identity: ' + name, 'success');
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(state.session);
    });

    document.getElementById('menuRenameIdentity').addEventListener('click', function () {
        closeMenus();
        if (!state.session || state.session.identities.length === 0) { setStatus('No identities', 'warning'); return; }
        var idList = state.session.identities.map(function (id, i) { return (i + 1) + '. ' + id.name; }).join('\n');
        var idx = parseInt(prompt('Which identity to rename?\n\n' + idList + '\n\nEnter number:')) - 1;
        if (isNaN(idx) || idx < 0 || idx >= state.session.identities.length) return;
        var newName = prompt('New name for "' + state.session.identities[idx].name + '":', state.session.identities[idx].name);
        if (!newName) return;
        state.session.identities[idx].name = newName;
        setStatus('Renamed identity to: ' + newName, 'success');
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(state.session);
    });

    document.getElementById('menuDeleteIdentity').addEventListener('click', function () {
        closeMenus();
        if (!state.session || state.session.identities.length === 0) { setStatus('No identities', 'warning'); return; }
        var idList = state.session.identities.map(function (id, i) { return (i + 1) + '. ' + id.name; }).join('\n');
        var idx = parseInt(prompt('Which identity to delete?\n\n' + idList + '\n\nEnter number:')) - 1;
        if (isNaN(idx) || idx < 0 || idx >= state.session.identities.length) return;
        var identity = state.session.identities[idx];
        if (!confirm('Delete identity "' + identity.name + '"? Groups will become unassigned.')) return;
        // Unassign all groups with this identity
        for (var [fIdx, groups] of state.session.instanceGroups) {
            for (var gi = 0; gi < groups.length; gi++) {
                if (groups[gi].identityId === identity.id) groups[gi].identityId = -1;
            }
        }
        state.session.identities.splice(idx, 1);
        setStatus('Deleted identity: ' + identity.name, 'success');
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(state.session);
    });

    // Populate Assign Identity submenu on hover
    document.getElementById('menuAssignIdentity').addEventListener('mouseenter', function () {
        var sub = document.getElementById('menuAssignIdentitySub');
        sub.innerHTML = '';
        if (!state.session) return;
        for (var i = 0; i < state.session.identities.length; i++) {
            var item = document.createElement('div');
            item.className = 'menu-submenu-item';
            item.textContent = state.session.identities[i].name;
            item.setAttribute('data-id', state.session.identities[i].id);
            item.addEventListener('click', function (ev) {
                ev.stopPropagation();
                closeMenus();
                var newId = parseInt(this.getAttribute('data-id'));
                var idName = this.textContent;
                assignIdentityToSelected(newId, idName);
            });
            sub.appendChild(item);
        }
        // "New Identity..." at bottom
        var newItem = document.createElement('div');
        newItem.className = 'menu-submenu-item menu-submenu-new';
        newItem.textContent = '+ New Identity...';
        newItem.addEventListener('click', function (ev) {
            ev.stopPropagation();
            closeMenus();
            var name = prompt('New identity name:', 'identity_' + state.session.identities.length);
            if (!name) return;
            var identity = state.session.addIdentity(name);
            assignIdentityToSelected(identity.id, name);
            // Always refresh UI (assignIdentityToSelected may return early if nothing selected)
            drawAllOverlays(state.currentFrame);
            updateInfoPanel();
            if (timeline) timeline.refreshTracks(state.session);
        });
        sub.appendChild(newItem);
    });

    // Set Env / Clear Env buttons on 3D viewport
    document.getElementById('btnSetEnv').addEventListener('click', async function (e) {
        e.stopPropagation();
        if (!viewport3d || !state.session) return;

        var session = state.session;
        var cameras = session.cameras;

        // Use cached env groups if available (skip re-parse + re-triangulate)
        if (session._envGroups && session._envGroups.length > 0) {
            if (session.envSkeleton) {
                var saved = viewport3d.skeleton;
                viewport3d.skeleton = session.envSkeleton;
                viewport3d.setEnvironment(session._envGroups);
                viewport3d.skeleton = saved;
            } else {
                viewport3d.setEnvironment(session._envGroups);
            }
            document.getElementById('btnClearEnv').style.display = '';
            setStatus('Environment restored (' + session._envGroups.length + ' group(s))', 'success');
            return;
        }

        var envFiles = session._envFiles;
        if (!envFiles || Object.keys(envFiles).length === 0) {
            setStatus('No environment (.externals.) files found in session folder', 'warning');
            return;
        }
        if (cameras.length < 2) {
            setStatus('Need at least 2 cameras for env triangulation', 'warning');
            return;
        }

        showLoading('Loading environment...');

        // 1. Parse all env files, collecting instances per frame per camera
        var envSkeleton = null;
        var envFrames = new Map();
        var totalInstances = 0;

        for (var camName in envFiles) {
            var files = envFiles[camName];
            for (var fi = 0; fi < files.length; fi++) {
                try {
                    var envData = await parseSlpH5(files[fi]);
                    if (envData.skeleton && !envSkeleton) envSkeleton = envData.skeleton;
                    if (envData.frames) {
                        for (var fri = 0; fri < envData.frames.length; fri++) {
                            var eFrame = envData.frames[fri];
                            var frameIdx = eFrame.frameIdx !== undefined ? eFrame.frameIdx : fri;
                            if (!envFrames.has(frameIdx)) envFrames.set(frameIdx, {});
                            var ef = envFrames.get(frameIdx);
                            if (!ef[camName]) ef[camName] = [];
                            if (eFrame.instances) {
                                for (var ii = 0; ii < eFrame.instances.length; ii++) {
                                    ef[camName].push(eFrame.instances[ii]);
                                    totalInstances++;
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.error('[set-env] Failed to parse', files[fi].name, err);
                }
            }
        }

        if (totalInstances === 0) {
            hideLoading();
            setStatus('No instances found in env files', 'warning');
            return;
        }

        // 2. Group by track on first frame with 2+ cameras, triangulate
        var envGroups = [];
        var bestFrameIdx = null;
        for (var [fIdx, camMap] of envFrames) {
            if (Object.keys(camMap).length >= 2) { bestFrameIdx = fIdx; break; }
        }

        if (bestFrameIdx === null) {
            hideLoading();
            setStatus('Env instances need 2+ cameras on same frame', 'warning');
            return;
        }

        var frameCamMap = envFrames.get(bestFrameIdx);
        var trackBuckets = {};
        for (var cn in frameCamMap) {
            var insts = frameCamMap[cn];
            for (var i = 0; i < insts.length; i++) {
                var tid = insts[i].trackIdx !== undefined ? insts[i].trackIdx : 0;
                if (!trackBuckets[tid]) trackBuckets[tid] = {};
                if (!trackBuckets[tid][cn]) {
                    trackBuckets[tid][cn] = new Instance(insts[i].points || [], tid, 'predicted', insts[i].score || 1.0);
                }
            }
        }

        for (var tidStr in trackBuckets) {
            var bucket = trackBuckets[tidStr];
            var bucketCamNames = Object.keys(bucket);
            if (bucketCamNames.length < 2) continue;
            var group = new InstanceGroup(Date.now() + parseInt(tidStr), parseInt(tidStr)); // identityId = trackIdx for backwards compat
            for (var bci = 0; bci < bucketCamNames.length; bci++) {
                group.addInstance(bucketCamNames[bci], bucket[bucketCamNames[bci]]);
            }
            var groupCams = cameras.filter(function (c) { return bucketCamNames.indexOf(c.name) >= 0; });
            if (groupCams.length < 2) continue;
            var result = triangulateAndReproject(group, groupCams);
            group.points3d = result.points3d;
            if (group.points3d && group.points3d.some(function (p) { return p != null; })) {
                envGroups.push(group);
            }
        }

        hideLoading();

        if (envGroups.length === 0) {
            setStatus('Could not triangulate environment', 'warning');
            return;
        }

        // Cache on session for instant re-use
        session._envGroups = envGroups;
        if (envSkeleton) {
            session.envSkeleton = new Skeleton(
                envSkeleton.name || 'env_skeleton',
                envSkeleton.nodes || [],
                envSkeleton.edges || []
            );
        }

        // 3. Set env skeleton on viewport and display
        if (session.envSkeleton) {
            var savedSkeleton = viewport3d.skeleton;
            viewport3d.skeleton = session.envSkeleton;
            viewport3d.setEnvironment(envGroups);
            viewport3d.skeleton = savedSkeleton;
        } else {
            viewport3d.setEnvironment(envGroups);
        }

        document.getElementById('btnClearEnv').style.display = '';
        setStatus('Environment set: ' + envGroups.length + ' group(s) from ' +
            Object.keys(envFiles).length + ' cameras', 'success');
    });

    document.getElementById('btnClearEnv').addEventListener('click', function (e) {
        e.stopPropagation();
        if (viewport3d) viewport3d.clearEnvironment();
        document.getElementById('btnClearEnv').style.display = 'none';
        setStatus('Environment cleared', 'success');
    });

    document.getElementById('menuToggle3D').addEventListener('click', function () {
        closeMenus();
        toggle3DViewport();
    });

    document.getElementById('menuToggleTimeline').addEventListener('click', function () {
        closeMenus();
        toggleTimeline();
    });

    document.getElementById('menuToggleInfo').addEventListener('click', function () {
        closeMenus();
        toggleInfoPanel();
    });

    document.getElementById('menuResetView').addEventListener('click', function () {
        closeMenus();
        if (viewport3d) viewport3d.resetCamera();
    });

    document.getElementById('menuFitScene').addEventListener('click', function () {
        closeMenus();
        if (viewport3d) viewport3d.fitToScene();
    });

    document.getElementById('menuNewProject').addEventListener('click', function () {
        closeMenus();
        newProject();
    });

    document.getElementById('menuSaveProject').addEventListener('click', function () {
        closeMenus();
        quickSave();
    });

    document.getElementById('menuSaveAs').addEventListener('click', function () {
        closeMenus();
        saveAs();
    });

    document.getElementById('menuLoadProject').addEventListener('click', async function () {
        closeMenus();
        if (window.showOpenFilePicker) {
            try {
                var handles = await window.showOpenFilePicker({
                    types: [{
                        description: 'Project Files',
                        accept: {
                            'application/x-hdf5': ['.slp', '.h5'],
                            'application/json': ['.json']
                        }
                    }]
                });
                if (handles.length === 0) { setStatus('No file selected', 'warning'); return; }
                var file = await handles[0].getFile();
                if (file.name.endsWith('.slp')) {
                    state.slpFileHandle = handles[0];
                }
                handleLoadProject(file);
            } catch (e) {
                if (e.name === 'AbortError') { setStatus('Cancelled', 'warning'); return; }
                handleLoadProject();
            }
        } else {
            handleLoadProject();
        }
    });

    document.getElementById('menuSessionFolderWizard').addEventListener('click', function () {
        closeMenus();
        showSessionModeModal(true).then(function (mode) {
            if (!mode) return;
            localStorage.setItem('sessionFolderType', mode);
            setStatus('Session folder type set to: ' + mode, 'success');
        });
    });

    document.getElementById('menuLoadVideos').addEventListener('click', function () {
        closeMenus();
        handleLoadVideos();
    });

    document.getElementById('menuLoadCalibration').addEventListener('click', function () {
        closeMenus();
        handleLoadCalibration();
    });

    document.getElementById('menuLoadSessionFolder').addEventListener('click', function () {
        closeMenus();
        loadSingleSessionFromCache();
    });

    document.getElementById('menuLoadMultiSessionFolder').addEventListener('click', function () {
        closeMenus();
        handleLoadMultiSession();
    });

    document.getElementById('menuLoadSlp').addEventListener('click', async function () {
        closeMenus();
        if (state.session) {
            handleAddSlp();
        } else {
            setStatus('Pick SLP file...', 'warning');
            // Use File System Access API if available to get a handle for save-back
            if (window.showOpenFilePicker) {
                try {
                    var handles = await window.showOpenFilePicker({
                        types: [{
                            description: 'SLEAP Labels',
                            accept: { 'application/x-hdf5': ['.slp', '.h5'] }
                        }]
                    });
                    if (handles.length === 0) { setStatus('No file selected', 'warning'); return; }
                    state.slpFileHandle = handles[0];
                    var file = await handles[0].getFile();
                    handleLoadSlpFile(file);
                } catch (e) {
                    if (e.name === 'AbortError') { setStatus('Cancelled', 'warning'); return; }
                    // Fallback to input picker
                    var slpFiles = await pickFiles({ accept: '.slp,.h5' });
                    if (slpFiles.length === 0) { setStatus('No file selected', 'warning'); return; }
                    handleLoadSlpFile(slpFiles[0]);
                }
            } else {
                var slpFiles = await pickFiles({ accept: '.slp,.h5' });
                if (slpFiles.length === 0) { setStatus('No file selected', 'warning'); return; }
                handleLoadSlpFile(slpFiles[0]);
            }
        }
    });

    document.getElementById('menuLoadPoints3dH5').addEventListener('click', function () {
        closeMenus();
        handleLoadPoints3dH5();
    });

    document.getElementById('menuLoadSkeletonMenu').addEventListener('click', function () {
        closeMenus();
        document.getElementById('btnLoadSkeleton').click();
    });

    document.getElementById('menuHotkeys').addEventListener('click', showHotkeysHelp);

    function showHotkeysHelp() {
        var overlay = document.createElement('div');
        overlay.className = 'multi-frame-modal-overlay';
        var modal = document.createElement('div');
        modal.className = 'multi-frame-modal';
        modal.style.maxWidth = '550px';
        modal.innerHTML =
            '<h3>Keyboard Shortcuts</h3>' +
            '<div style="max-height:60vh;overflow-y:auto;">' +
            '<table class="data-table" style="font-size:12px;">' +
            '<thead><tr><th>Key</th><th>Action</th></tr></thead>' +
            '<tbody>' +
            '<tr><td><b>Navigation</b></td><td></td></tr>' +
            '<tr><td><code>←</code> / <code>→</code></td><td>Previous / Next frame</td></tr>' +
            '<tr><td><code>Option+←</code> / <code>Option+→</code></td><td>Previous / Next frame with user annotation</td></tr>' +
            '<tr><td><code>Home</code> / <code>End</code></td><td>First / Last frame</td></tr>' +
            '<tr><td><code>Space</code></td><td>Play / Pause</td></tr>' +
            '<tr><td colspan="2" style="height:8px;"></td></tr>' +
            '<tr><td><b>Editing</b></td><td></td></tr>' +
            '<tr><td><code>N</code></td><td>Add new instance</td></tr>' +
            '<tr><td><code>Delete</code></td><td>Delete selected instance</td></tr>' +
            '<tr><td><code>U</code></td><td>Ungroup selected</td></tr>' +
            '<tr><td><code>T</code></td><td>Triangulate current frame</td></tr>' +
            '<tr><td><code>Tab</code> / <code>Shift+Tab</code></td><td>Cycle selection</td></tr>' +
            '<tr><td><code>Double-click</code></td><td>Convert predicted → user label</td></tr>' +
            '<tr><td colspan="2" style="height:8px;"></td></tr>' +
            '<tr><td><b>Identity (select group first)</b></td><td></td></tr>' +
            '<tr><td><code>1</code> – <code>9</code></td><td>Assign identity 1–9 to selected instance</td></tr>' +
            '<tr><td colspan="2" style="height:8px;"></td></tr>' +
            '<tr><td><b>Tracks (select group first)</b></td><td></td></tr>' +
            '<tr><td><code>Shift+1</code> – <code>Shift+9</code></td><td>Assign track 1–9 (propagates forward)</td></tr>' +
            '<tr><td colspan="2" style="height:8px;"></td></tr>' +
            '<tr><td><b>View</b></td><td></td></tr>' +
            '<tr><td><code>\\</code></td><td>Toggle 3D viewport</td></tr>' +
            '<tr><td><code>I</code></td><td>Toggle info panel</td></tr>' +
            '<tr><td><code>Shift+R+\u2192</code> / <code>Shift+R+\u2190</code></td><td>Rotate video CW / CCW (hold for continuous)</td></tr>' +
            '<tr><td><code>?</code></td><td>Show this help</td></tr>' +
            '</tbody></table></div>' +
            '<div class="modal-actions"><button id="hotkeysClose" class="primary">Close</button></div>';
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        document.getElementById('hotkeysClose').addEventListener('click', function () { overlay.remove(); });
        overlay.addEventListener('click', function (ev) { if (ev.target === overlay) overlay.remove(); });
    }

    document.getElementById('menuSaveSkeleton').addEventListener('click', function () {
        closeMenus();
        document.getElementById('btnSaveSkeleton').click();
    });

    document.getElementById('menuExportLabels').addEventListener('click', function () {
        closeMenus();
        exportLabels();
    });

    document.getElementById('menuExportSlp').addEventListener('click', function () {
        closeMenus();
        if (state.sessions.length === 0) { setStatus('No sessions to export', 'error'); return; }
        showSlpExportAllModal();
    });

    document.getElementById('menuExportSlpPerCam').addEventListener('click', function () {
        closeMenus();
        if (!state.sessions || state.sessions.length === 0) { setStatus('No sessions to export', 'error'); return; }
        showSlpExportModal();
    });

    document.getElementById('menuExportPoints3dH5').addEventListener('click', function () {
        closeMenus();
        if (!state.session) { setStatus('No session to export', 'error'); return; }
        exportPoints3dH5();
    });

    document.getElementById('menuExportReprojH5').addEventListener('click', function () {
        closeMenus();
        if (!state.session) { setStatus('No session to export', 'error'); return; }
        exportReprojH5();
    });

    document.getElementById('menuExportCalib').addEventListener('click', function () {
        closeMenus();
        if (!state.session) { setStatus('No session to export', 'error'); return; }
        const toml = exportCalibrationTOML(state.session.cameras);
        downloadTOML(toml, 'calibration.toml');
        setStatus('Calibration exported', 'success');
    });

    function closeMenus() {
        document.querySelectorAll('.menu-dropdown').forEach(function (d) {
            d.style.display = 'none';
        });
        document.querySelectorAll('.toolbar-dropdown').forEach(function (d) {
            d.style.display = 'none';
        });
        activeMenu = null;
    }
}

export function unlinkGroup(group) {
    if (!state.session) return;
    var frameIdx = state.currentFrame;

    if (!group) {
        if (interactionManager && interactionManager.selectedInstanceGroup) {
            group = interactionManager.selectedInstanceGroup;
        } else {
            return;
        }
    }

    // Clear selection if this group is selected
    if (interactionManager && interactionManager.selectedInstanceGroup === group) {
        interactionManager.clearSelection();
    }

    var trackName = state.session.tracks[group.identityId] || 'Track ' + group.identityId;
    state.session.unlinkGroup(frameIdx, group);
    purgeTriangulationDataForGroup(frameIdx, group);
    setStatus('Unlinked ' + trackName, 'success');

    // Refresh everything
    updateTimelineForFrame(frameIdx);
    if (viewport3d) {
        var groups = getInstanceGroupsForFrame(frameIdx);
        viewport3d.setFrame(groups);
    }
    drawAllOverlays(state.currentFrame);
    updateInfoPanel();
}

/**
 * Show context menu for an InstanceGroup row.
 */
export function showGroupContextMenu(x, y, group) {
    var menu = document.getElementById('groupContextMenu');
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.display = 'block';
    menu._targetGroup = group;
}

export function hideGroupContextMenu() {
    var menu = document.getElementById('groupContextMenu');
    menu.style.display = 'none';
    menu._targetGroup = null;
}

// ============================================
// UI Setup
// ============================================

export function setupUI() {
    // Transport controls
    document.getElementById('btnFirst').addEventListener('click', function () { if (videoController) videoController.seekToFrame(0); });
    document.getElementById('btnPrev').addEventListener('click', function () { if (videoController) videoController.seekToFrame(state.currentFrame - 1); });
    document.getElementById('btnPlay').addEventListener('click', function () {
        if (!videoController) return;
        if (state.isPlaying) { videoController.stopPlayback(); return; }
        // Pre-load frames before starting playback for lazy sessions
        if (state.session && state.session.lazyLoader) {
            showLoading('Loading frames...');
            batchLoadLazyFrames(state.currentFrame, 5000).then(function () {
                hideLoading();
                if (videoController) videoController.startPlayback();
            }).catch(function(e) { hideLoading(); });
        } else {
            videoController.togglePlayback();
        }
    });
    document.getElementById('btnNext').addEventListener('click', function () { if (videoController) videoController.seekToFrame(state.currentFrame + 1); });
    document.getElementById('btnLast').addEventListener('click', function () { if (videoController) videoController.seekToFrame(state.totalFrames - 1); });

    // Timeline toggle button — fully collapse / expand the timeline.
    document.getElementById('timelineToggleBtn').addEventListener('click', function () {
        toggleTimeline();
    });

    // Seekbar scrubbing (delegates to current videoController)
    (function () {
        var isDragging = false;
        var seekbar = document.getElementById('seekbar');

        var getFrameFromEvent = function (e) {
            var rect = seekbar.getBoundingClientRect();
            var fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            return Math.round(fraction * (state.totalFrames - 1));
        };

        var _seekThrottle = { lastRender: 0, timer: null, pendingFrame: null };

        seekbar.addEventListener('mousedown', function (e) {
            isDragging = true;
            var frame = getFrameFromEvent(e);
            updateSeekbarVisual(frame);
            _seekThrottle.lastRender = performance.now();
            if (videoController) videoController.scrubToFrame(frame);
            e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
            if (!isDragging) return;
            var frame = getFrameFromEvent(e);
            updateSeekbarVisual(frame);
            _seekThrottle.pendingFrame = frame;
            var now = performance.now();
            if (now - _seekThrottle.lastRender >= 100) {
                _seekThrottle.lastRender = now;
                if (_seekThrottle.timer) { clearTimeout(_seekThrottle.timer); _seekThrottle.timer = null; }
                if (videoController) videoController.scrubToFrame(frame);
            } else if (!_seekThrottle.timer) {
                _seekThrottle.timer = setTimeout(function () {
                    _seekThrottle.timer = null;
                    _seekThrottle.lastRender = performance.now();
                    if (videoController && _seekThrottle.pendingFrame !== null) {
                        videoController.scrubToFrame(_seekThrottle.pendingFrame);
                    }
                }, 100 - (now - _seekThrottle.lastRender));
            }
            e.preventDefault();
        });

        document.addEventListener('mouseup', function () {
            if (isDragging) {
                isDragging = false;
                // Cancel any pending throttled render and immediately render final frame
                if (_seekThrottle.timer) { clearTimeout(_seekThrottle.timer); _seekThrottle.timer = null; }
                if (_seekThrottle.pendingFrame !== null && videoController) {
                    videoController.scrubToFrame(_seekThrottle.pendingFrame);
                    _seekThrottle.pendingFrame = null;
                }
            }
        });
    })();

    // Video navigation keyboard shortcuts (delegates to current videoController)
    // Enter key dismisses any visible dismiss button
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        var btn = document.querySelector('button[data-dismiss]:not([style*="display:none"])');
        if (btn && btn.offsetParent !== null) {
            e.preventDefault();
            btn.click();
        }
    });

    // --- Video Rotation (Shift + R + Arrow chord) ---
    var _rotState = { active: false, direction: 0, lastTime: 0, rafId: 0 };
    var _rKeyDown = false; // tracks the `R` modifier for the rotation chord

    document.addEventListener('keydown', function (e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        if (e.code === 'KeyR') _rKeyDown = true;
    });
    document.addEventListener('keyup', function (e) {
        if (e.code === 'KeyR') _rKeyDown = false;
    });

    function getActiveView() {
        if (!paneManager || !paneManager.api) return null;
        var ap = paneManager.api.activePanel;
        if (!ap) return null;
        var r = panelRenderers.get(ap.id);
        if (!r) return null;
        var vn = r.getViewName();
        for (var i = 0; i < state.views.length; i++) {
            if (state.views[i].name === vn) return state.views[i];
        }
        return null;
    }

    function rotationLoop(now) {
        if (!_rotState.active) return;
        var view = getActiveView();
        if (!view) { _rotState.active = false; return; }
        var dt = (now - _rotState.lastTime) / 1000;
        var degrees = 60 * dt * _rotState.direction;
        view.rotation = clampRotation((view.rotation || 0) + degrees);
        _rotState.lastTime = now;
        // Only update the CSS transform — don't redraw overlays during animation
        if (videoController) videoController.applyZoom(view);
        syncRotationUI(view);
        _rotState.rafId = requestAnimationFrame(rotationLoop);
    }

    document.addEventListener('keydown', function (e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        if (e.shiftKey && _rKeyDown && !e.ctrlKey && !e.metaKey && !e.altKey &&
            (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
            e.preventDefault();
            var view = getActiveView();
            if (!view) return;
            var dir = e.key === 'ArrowRight' ? 1 : -1;
            if (!_rotState.active) {
                view.rotation = clampRotation((view.rotation || 0) + dir);
                if (videoController) videoController.applyZoom(view);
                syncRotationUI(view);
                _rotState.active = true;
                _rotState.direction = dir;
                _rotState.lastTime = performance.now();
                _rotState.rafId = requestAnimationFrame(rotationLoop);
            }
            return;
        }
    });

    document.addEventListener('keyup', function (e) {
        if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Shift' || e.code === 'KeyR') && _rotState.active) {
            _rotState.active = false;
            if (_rotState.rafId) { cancelAnimationFrame(_rotState.rafId); _rotState.rafId = 0; }
            // Redraw overlays once at the final rotation angle
            drawAllOverlays(state.currentFrame);
        }
    });

    document.addEventListener('keydown', function (e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        if (!videoController) return;
        // Shift+R+Arrow is the rotation chord — don't also step frames.
        if (e.shiftKey && _rKeyDown) return;

        switch (e.key) {
            case 'ArrowRight':
                if (e.shiftKey) return; // Shift+Arrow is unbound
                e.preventDefault();
                if (e.altKey) { seekToLabeledFrame(1); }
                else { videoController.seekToFrame(state.currentFrame + 1); }
                break;
            case 'ArrowLeft':
                if (e.shiftKey) return; // Shift+Arrow is unbound
                e.preventDefault();
                if (e.altKey) { seekToLabeledFrame(-1); }
                else { videoController.seekToFrame(state.currentFrame - 1); }
                break;
            case ' ':
                e.preventDefault();
                if (state.isPlaying) { videoController.stopPlayback(); }
                else if (state.session && state.session.lazyLoader) {
                    batchLoadLazyFrames(state.currentFrame, 5000).then(function () {
                        if (videoController) videoController.startPlayback();
                    });
                } else { videoController.togglePlayback(); }
                break;
            case 'Home':
                e.preventDefault();
                videoController.seekToFrame(0);
                break;
            case 'End':
                e.preventDefault();
                videoController.seekToFrame(state.totalFrames - 1);
                break;
            case '+':
            case '=':
                e.preventDefault();
                videoController.zoomAllVideos(1.2);
                break;
            case '-':
            case '_':
                e.preventDefault();
                videoController.zoomAllVideos(1 / 1.2);
                break;
            case '0':
                e.preventDefault();
                videoController.resetAllZoom();
                break;
        }
    });

    // Additional keyboard shortcuts
    document.addEventListener('keydown', function (e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.key) {
            case 'i':
            case 'I':
                if (!e.ctrlKey && !e.metaKey) {
                    toggleInfoPanel();
                    e.preventDefault();
                }
                break;
            case '\\':
                if (!e.ctrlKey && !e.metaKey) {
                    toggle3DViewport();
                    e.preventDefault();
                }
                break;
        }
    });

    // --- Identity & Track hotkeys ---
    document.addEventListener('keydown', function (e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        // Identity assignment: 1-9 (no modifier) — works on groups AND unlinked
        if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
            if (!state.session || !interactionManager) return;
            var selectedGroup = interactionManager.selectedInstanceGroup;
            var selectedUl = interactionManager.selectedUnlinked;
            if (!selectedGroup && !selectedUl) return; // Nothing selected
            e.preventDefault();
            var identityNum = parseInt(e.key) - 1;
            while (state.session.identities.length <= identityNum) {
                state.session.addIdentity('id_' + state.session.identities.length);
            }
            var identity = state.session.identities[identityNum];
            assignIdentityToSelected(identity.id, identity.name);
            return;
        }

        // Track assignment: Shift+1 through Shift+9 — works on groups AND unlinked
        if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.code >= 'Digit1' && e.code <= 'Digit9') {
            e.preventDefault();
            if (!state.session || !interactionManager) return;
            var selectedGroup = interactionManager.selectedInstanceGroup;
            var selectedUl = interactionManager.selectedUnlinked;
            if (!selectedGroup && !selectedUl) {
                setStatus('Select an instance first', 'warning');
                return;
            }
            var newTrackIdx = parseInt(e.code.replace('Digit', '')) - 1;
            var trackName = state.session.tracks[newTrackIdx] || 'track_' + newTrackIdx;
            if (selectedGroup) {
                // Swap-assign per camera with propagation
                var totalProp = 0;
                for (var [camName, inst] of selectedGroup.instances) {
                    totalProp += swapAssignTrack(state.currentFrame, camName, inst, newTrackIdx, state.session);
                }
                state.session.assignIdentityToGroup(selectedGroup, newTrackIdx);
                setStatus('Set track to ' + trackName + (totalProp > 0 ? ' (swapped ' + totalProp + ')' : ''), 'success');
            } else if (selectedUl) {
                // Swap-assign with propagation (same as assignTrackToSelected)
                var propagated = swapAssignTrack(state.currentFrame, selectedUl.cameraName, selectedUl.instance, newTrackIdx, state.session);
                setStatus('Set track to ' + trackName + (propagated > 0 ? ' (propagated ' + propagated + ')' : ''), 'success');
            }
            drawAllOverlays(state.currentFrame);
            updateInfoPanel();
            if (timeline) timeline.refreshTracks(state.session);
            return;
        }
    });

    // --- New keyboard shortcuts (Prompt 36) ---
    document.addEventListener('keydown', function (e) {
        // Ctrl+S / Cmd+S = Quick Save
        if (e.key === 's' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
            e.preventDefault();
            quickSave();
            return;
        }
        // --- Ctrl+Shift+T = Track All ---
        if (e.key === 'T' && e.shiftKey && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            trackAll();
            return;
        }
        // --- Shift+T = Track Frame ---
        if (e.key === 'T' && e.shiftKey && !e.ctrlKey && !e.metaKey) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
            e.preventDefault();
            trackCurrentFrame();
            return;
        }
        // F = Find Match for selected instance
        if (e.key === 'f' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
            if (interactionManager && (interactionManager.selectedUnlinked || interactionManager.selectedInstanceGroup)) {
                e.preventDefault();
                findMatchForSelected();
            }
        }
        // --- Cmd/Ctrl shortcuts (work even in inputs) ---
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
            switch (e.key) {
                case 'j':
                case 'J': {
                    // Focus frame index input
                    e.preventDefault();
                    var frameEl = document.getElementById('currentFrame');
                    if (frameEl) frameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                    break;
                }
                case 'o':
                case 'O': {
                    // Load single session folder using cached type
                    e.preventDefault();
                    loadSingleSessionFromCache();
                    break;
                }
                case 'i':
                case 'I': {
                    // Add new instance with smart initialization
                    e.preventDefault();
                    addNewInstanceSmart();
                    break;
                }
            }
            return;
        }

        // --- Plain key shortcuts (skip when typing in inputs or any modifier held) ---
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

        switch (e.key) {
            case 'Enter': {
                // Click the visible Continue/Group button in any active modal/toast
                var continueBtn = null;
                ['mfContinue', 'tfContinue', 'autoAssignContinue', 'manualAssignGroup'].forEach(function (id) {
                    if (continueBtn) return;
                    var btn = document.getElementById(id);
                    if (btn && btn.offsetParent !== null) continueBtn = btn;
                });
                if (continueBtn) {
                    e.preventDefault();
                    continueBtn.click();
                }
                break;
            }
            case '?':
                showHotkeysHelp();
                e.preventDefault();
                break;

            case 'Escape': {
                // Click the visible Cancel button in any active modal/toast
                var cancelBtn = null;
                ['mfCancel', 'tfCancel', 'autoAssignCancel', 'manualAssignCancel'].forEach(function (id) {
                    if (cancelBtn) return;
                    var btn = document.getElementById(id);
                    if (btn && btn.offsetParent !== null) cancelBtn = btn;
                });
                if (cancelBtn) {
                    e.preventDefault();
                    cancelBtn.click();
                }
                break;
            }
            case 'u': {
                e.preventDefault();
                var visUser = document.getElementById('visUser');
                if (visUser) { visUser.checked = !visUser.checked; visUser.dispatchEvent(new Event('change', { bubbles: true })); }
                break;
            }
            case 'p': {
                e.preventDefault();
                var visPred = document.getElementById('visPredicted');
                if (visPred) { visPred.checked = !visPred.checked; visPred.dispatchEvent(new Event('change', { bubbles: true })); }
                break;
            }
            case 'r': {
                e.preventDefault();
                var visReproj = document.getElementById('visReprojections');
                if (visReproj) { visReproj.checked = !visReproj.checked; visReproj.dispatchEvent(new Event('change', { bubbles: true })); }
                break;
            }
            case 'e': {
                e.preventDefault();
                var visErrors = document.getElementById('visErrors');
                if (visErrors) { visErrors.checked = !visErrors.checked; visErrors.dispatchEvent(new Event('change', { bubbles: true })); }
                break;
            }
            case 'v': {
                e.preventDefault();
                toggleViewMode();
                showViewIndicator();
                break;
            }
            case 'g': {
                e.preventDefault();
                setGridMode();
                showViewIndicator();
                break;
            }
            case 't': {
                e.preventDefault();
                triangulateCurrentFrame();
                break;
            }
        }
    });

    // Zoom handlers for each view (track to avoid duplicates)
    if (videoController) {
        for (const view of state.views) {
            if (!view._zoomSetup) {
                view._zoomSetup = true;
                videoController.initZoom(view);
                const cell = view.canvas.closest('.video-cell');
                if (cell) videoController.setupZoomHandlers(view, cell);
            }
        }
    }

    // ============================================
    // Visibility Tab
    // ============================================

    // Slider value display + redraw (throttled to ~10fps during drag)
    function setupVisSlider(sliderId, valId, format) {
        var slider = document.getElementById(sliderId);
        var val = document.getElementById(valId);
        if (!slider || !val) return;
        var lastRender = 0;
        var throttleTimer = null;
        function updateLabel() {
            if (format === 'alpha') {
                val.textContent = (parseInt(slider.value) / 100).toFixed(1);
            } else if (format === 'pct') {
                val.textContent = slider.value + '%';
            } else if (format === 'float') {
                val.textContent = parseFloat(slider.value).toFixed(2);
            } else {
                val.textContent = slider.value;
            }
        }
        slider.addEventListener('input', function() {
            updateLabel();
            var now = performance.now();
            if (now - lastRender >= 100) {
                lastRender = now;
                drawAllOverlays(state.currentFrame);
            } else if (!throttleTimer) {
                throttleTimer = setTimeout(function() {
                    throttleTimer = null;
                    lastRender = performance.now();
                    drawAllOverlays(state.currentFrame);
                }, 100 - (now - lastRender));
            }
        });
        slider.addEventListener('change', function() {
            updateLabel();
            if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
            drawAllOverlays(state.currentFrame);
        });
    }

    setupVisSlider('visUserNodeSize', 'visUserNodeSizeVal');
    setupVisSlider('visUserEdgeWeight', 'visUserEdgeWeightVal');
    setupVisSlider('visUserEdgeTrans', 'visUserEdgeTransVal', 'alpha');
    setupVisSlider('visUserLabelSize', 'visUserLabelSizeVal');
    setupVisSlider('visUserLabelAlpha', 'visUserLabelAlphaVal', 'float');
    setupVisSlider('visPredNodeSize', 'visPredNodeSizeVal');
    setupVisSlider('visPredEdgeWeight', 'visPredEdgeWeightVal');
    setupVisSlider('visPredEdgeTrans', 'visPredEdgeTransVal', 'alpha');
    setupVisSlider('visReprojNodeSize', 'visReprojNodeSizeVal');
    setupVisSlider('visReprojEdgeWeight', 'visReprojEdgeWeightVal');
    setupVisSlider('visReprojEdgeTrans', 'visReprojEdgeTransVal', 'alpha');
    setupVisSlider('visReprojBrightness', 'visReprojBrightnessVal', 'pct');
    setupVisSlider('visReprojLabelSize', 'visReprojLabelSizeVal');
    setupVisSlider('visReprojLabelAlpha', 'visReprojLabelAlphaVal', 'float');

    // Checkbox toggles
    ['visLegend', 'visUser', 'visPredicted', 'visReprojections', 'visErrors'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', function() {
                // Deselect if selected instance type is now hidden
                if (interactionManager && interactionManager.selectedInstanceGroup) {
                    var showUser = document.getElementById('visUser').checked;
                    var showPredicted = document.getElementById('visPredicted').checked;
                    var showReproj = document.getElementById('visReprojections').checked;
                    if (interactionManager.selectedReprojected && !showReproj) {
                        interactionManager.clearSelection();
                    } else if (!interactionManager.selectedReprojected) {
                        var firstInst = interactionManager.selectedInstanceGroup.instances.values().next().value;
                        if (firstInst) {
                            var t = firstInst.type || 'user';
                            if ((t === 'user' && !showUser) || (t === 'predicted' && !showPredicted)) {
                                interactionManager.clearSelection();
                            }
                        }
                    }
                }
                drawAllOverlays(state.currentFrame);
            });
        }
    });

    // Line style buttons
    document.querySelectorAll('.line-style-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var container = btn.closest('.line-style-options');
            container.querySelectorAll('.line-style-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            container.setAttribute('data-value', btn.getAttribute('data-style'));
            // Brightness slider only enabled when reprojections use track color
            if (container.id === 'visReprojNodeColor') {
                updateReprojBrightnessEnabled();
            }
            drawAllOverlays(state.currentFrame);
        });
    });

    function updateReprojBrightnessEnabled() {
        var nodeColor = document.getElementById('visReprojNodeColor').getAttribute('data-value') || 'white';
        var slider = document.getElementById('visReprojBrightness');
        var val = document.getElementById('visReprojBrightnessVal');
        if (slider) {
            var enabled = nodeColor === 'track';
            slider.disabled = !enabled;
            slider.style.opacity = enabled ? '1' : '0.35';
            if (val) val.style.opacity = enabled ? '1' : '0.35';
        }
    }
    updateReprojBrightnessEnabled();

    // --- Visibility settings cache (localStorage) ---
    var VIS_CACHE_KEY = 'visibilitySettings';
    var visSliderIds = [
        'visUserNodeSize', 'visUserEdgeWeight', 'visUserEdgeTrans',
        'visUserLabelSize', 'visUserLabelAlpha',
        'visPredNodeSize', 'visPredEdgeWeight', 'visPredEdgeTrans',
        'visReprojNodeSize', 'visReprojEdgeWeight', 'visReprojEdgeTrans',
        'visReprojBrightness', 'visReprojLabelSize', 'visReprojLabelAlpha',
        'vis3dLabelSize', 'vis3dSphereSize', 'vis3dPyramidLength',
        'vis3dNodeSize', 'vis3dEdgeWeight',
    ];
    var visCheckIds = ['visLegend', 'visUser', 'visPredicted', 'visReprojections', 'visErrors',
        'vis3dLabelShow', 'vis3dSphereShow', 'vis3dPyramidShow',
        'vis3dNodeShow', 'vis3dEdgeShow'];
    var visStyleIds = [
        'visUserPreLineStyle', 'visUserPostLineStyle',
        'visPredPreLineStyle', 'visPredPostLineStyle',
        'visReprojLineStyle', 'visReprojNodeColor',
    ];

    function saveVisSettings() {
        var data = {};
        visSliderIds.forEach(function(id) {
            var el = document.getElementById(id);
            if (el) data[id] = el.value;
        });
        visCheckIds.forEach(function(id) {
            var el = document.getElementById(id);
            if (el) data[id] = el.checked;
        });
        visStyleIds.forEach(function(id) {
            var el = document.getElementById(id);
            if (el) data[id] = el.getAttribute('data-value');
        });
        localStorage.setItem(VIS_CACHE_KEY, JSON.stringify(data));
    }

    function restoreVisSettings() {
        var raw = localStorage.getItem(VIS_CACHE_KEY);
        if (!raw) return;
        try { var data = JSON.parse(raw); } catch(e) { return; }
        visSliderIds.forEach(function(id) {
            if (data[id] == null) return;
            var el = document.getElementById(id);
            if (el) {
                el.value = data[id];
                // Update paired display label
                var valEl = document.getElementById(id + 'Val');
                if (valEl) {
                    if (id.indexOf('LabelAlpha') >= 0) valEl.textContent = parseFloat(data[id]).toFixed(2);
                    else if (id.indexOf('Trans') >= 0) valEl.textContent = (parseInt(data[id]) / 100).toFixed(1);
                    else if (id.indexOf('Brightness') >= 0) valEl.textContent = data[id] + '%';
                    else valEl.textContent = data[id];
                }
            }
        });
        visCheckIds.forEach(function(id) {
            if (data[id] == null) return;
            var el = document.getElementById(id);
            if (el) el.checked = data[id];
        });
        visStyleIds.forEach(function(id) {
            if (!data[id]) return;
            var container = document.getElementById(id);
            if (!container) return;
            container.setAttribute('data-value', data[id]);
            container.querySelectorAll('.line-style-btn').forEach(function(b) {
                b.classList.toggle('active', b.getAttribute('data-style') === data[id]);
            });
        });
        updateReprojBrightnessEnabled();
    }

    restoreVisSettings();

    // --- 3D Viewer visibility controls ---
    (function() {
        var camSizeIds = {
            'vis3dLabelSize': { prop: 'cameraLabelSize', parse: parseInt },
            'vis3dSphereSize': { prop: 'cameraSphereSize', parse: parseFloat },
            'vis3dPyramidLength': { prop: 'pyramidLength', parse: parseFloat },
        };
        var skelSizeIds = {
            'vis3dNodeSize': { prop: 'skeletonNodeSize', parse: parseFloat },
            'vis3dEdgeWeight': { prop: 'skeletonEdgeWeight', parse: parseFloat },
        };
        var showIds = {
            'vis3dLabelShow': { prop: 'showCameraLabels' },
            'vis3dSphereShow': { prop: 'showCameraSpheres' },
            'vis3dPyramidShow': { prop: 'showCameraPyramids' },
            'vis3dNodeShow': { prop: 'showSkeletonNodes' },
            'vis3dEdgeShow': { prop: 'showSkeletonEdges' },
        };
        function rebuildCams() {
            if (viewport3d) viewport3d.addCameraPyramids();
        }
        function rebuildSkel() {
            if (!viewport3d) return;
            var groups = typeof getInstanceGroupsForFrame === 'function'
                ? getInstanceGroupsForFrame(state.currentFrame) : [];
            viewport3d.setFrame(groups);
        }
        function parseVal(el, parseFn) {
            var v = el.value.trim() === '' ? 0 : parseFn(el.value);
            if (isNaN(v) || v < 0) v = 0;
            var step = parseFloat(el.step) || 1;
            v = Math.round(v / step) * step;
            // Fix floating-point noise
            var decimals = (step.toString().split('.')[1] || '').length;
            v = parseFloat(v.toFixed(decimals));
            el.value = v;
            return v;
        }
        // Enter to blur + stepper arrows on all 3D number inputs
        document.querySelectorAll('#tabVisibility table input[type="number"]').forEach(function(el) {
            if (!el.id.startsWith('vis3d')) return;
            el.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
            });
        });
        document.querySelectorAll('.vis3d-stepper button').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                var input = btn.closest('span').parentElement.querySelector('input[type="number"]');
                if (!input) return;
                var step = parseFloat(input.step) || 1;
                var min = input.min !== '' ? parseFloat(input.min) : -Infinity;
                var max = input.max !== '' ? parseFloat(input.max) : Infinity;
                var cur = parseFloat(input.value) || 0;
                var val = btn.dataset.dir === 'up' ? cur + step : cur - step;
                if (val < min) val = min;
                if (val > max) val = max;
                if (val < 0) val = 0;
                var decimals = (step.toString().split('.')[1] || '').length;
                input.value = parseFloat(val.toFixed(decimals));
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
        });
        Object.keys(camSizeIds).forEach(function(id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', function() {
                var val = parseVal(el, camSizeIds[id].parse);
                if (viewport3d) viewport3d[camSizeIds[id].prop] = val;
                rebuildCams();
                saveVisSettings();
            });
        });
        Object.keys(skelSizeIds).forEach(function(id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', function() {
                var val = parseVal(el, skelSizeIds[id].parse);
                if (viewport3d) viewport3d[skelSizeIds[id].prop] = val;
                rebuildSkel();
                saveVisSettings();
            });
        });
        Object.keys(showIds).forEach(function(id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', function() {
                if (viewport3d) viewport3d[showIds[id].prop] = el.checked;
                if (id.indexOf('Node') >= 0 || id.indexOf('Edge') >= 0) rebuildSkel();
                else rebuildCams();
                saveVisSettings();
            });
        });
    })();

    // Hook save into all vis controls
    var visTab = document.getElementById('tabVisibility');
    if (visTab) {
        visTab.addEventListener('change', saveVisSettings);
        visTab.addEventListener('input', saveVisSettings);
    }
    document.querySelectorAll('.line-style-btn').forEach(function(btn) {
        btn.addEventListener('click', saveVisSettings);
    });

    // Sessions sidebar toggle
    var _sessionStripSavedWidth = null;
    document.getElementById('tbSessions').addEventListener('click', function () {
        var strip = document.getElementById('sessionStrip');
        var btn = document.getElementById('tbSessions');
        if (strip.classList.contains('session-strip-hidden')) {
            // Reveal: restore saved width
            strip.classList.remove('session-strip-hidden');
            if (_sessionStripSavedWidth) strip.style.width = _sessionStripSavedWidth;
            btn.classList.add('active');
        } else {
            // Hide: save current width, clear inline style so CSS class takes effect
            _sessionStripSavedWidth = strip.style.width || null;
            strip.style.width = '';
            strip.classList.add('session-strip-hidden');
            btn.classList.remove('active');
        }
    });

    // Hover-to-reveal: show sidebar when cursor hits left edge
    (function () {
        var hoverZone = document.createElement('div');
        hoverZone.id = 'sessionHoverZone';
        document.body.appendChild(hoverZone);
        hoverZone.addEventListener('mouseenter', function () {
            var strip = document.getElementById('sessionStrip');
            if (strip.classList.contains('session-strip-hidden')) {
                strip.classList.remove('session-strip-hidden');
                if (_sessionStripSavedWidth) strip.style.width = _sessionStripSavedWidth;
                document.getElementById('tbSessions').classList.add('active');
            }
        });
    })();

    // Session strip resize handle
    (function () {
        var handle = document.getElementById('sessionStripResize');
        var strip = document.getElementById('sessionStrip');
        var startX, startW;
        handle.addEventListener('mousedown', function (e) {
            e.preventDefault();
            startX = e.clientX;
            startW = strip.offsetWidth;
            handle.classList.add('dragging');
            strip.style.transition = 'none';
            function onMove(ev) {
                var newW = Math.max(40, startW + (ev.clientX - startX));
                strip.style.width = newW + 'px';
            }
            function onUp() {
                handle.classList.remove('dragging');
                strip.style.transition = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    })();

    // Toolbar buttons
    document.getElementById('tbAddInstance').addEventListener('click', function () {
        // Sync selected view from active panel before creating instance
        if (interactionManager && paneManager && paneManager.api) {
            var ap = paneManager.api.activePanel;
            if (ap) {
                var r = panelRenderers.get(ap.id);
                if (r) interactionManager.lastInteractedView = r.getViewName();
            }
        }
        addNewInstanceSmart();
    });
    document.getElementById('tbDeleteInstance').addEventListener('click', function () {
        if (interactionManager) interactionManager._deleteSelected();
    });
    document.getElementById('btnPrevLabeled').addEventListener('click', function() { seekToLabeledFrame(-1); });
    document.getElementById('btnNextLabeled').addEventListener('click', function() { seekToLabeledFrame(1); });
    // Group button: toggle assignment mode, create group, or ungroup
    document.getElementById('tbGroup').addEventListener('click', function () {
        if (!interactionManager) return;
        // Ungroup mode: grouped instance selected and not in assignment mode
        if (interactionManager.selectedInstanceGroup && !interactionManager.selectedReprojected && !interactionManager.assignmentMode) {
            unlinkGroup(interactionManager.selectedInstanceGroup);
            return;
        }
        if (interactionManager.assignmentMode && interactionManager.assignmentSelection.length >= 2) {
            interactionManager._createGroupFromAssignment();
        } else if (interactionManager.assignmentMode) {
            interactionManager.setAssignmentMode(false);
        } else {
            interactionManager.setAssignmentMode(true);
        }
    });
    // Edit Group button
    document.getElementById('tbEditGroup').addEventListener('click', function () {
        if (!interactionManager) return;
        // If already in edit mode, finish
        if (interactionManager.editGroupMode) {
            finishEditGroup();
            return;
        }
        // Need a grouped instance selected
        var selectedGroup = interactionManager.selectedInstanceGroup;
        if (!selectedGroup) {
            setStatus('Error: No Grouped Instance Selected to Edit.', 'error');
            return;
        }
        // Block editing when a reprojected instance is selected
        if (interactionManager.selectedReprojected) {
            setStatus('Error: Cannot edit a reprojected instance.', 'error');
            return;
        }
        startEditGroup(selectedGroup);
    });
    // Triangulate current frame
    document.getElementById('tbTriangulate').addEventListener('click', function () {
        triangulateCurrentFrame();
    });
    // Triangulate all: group by identity first, then triangulate
    document.getElementById('tbTriangulateAll').addEventListener('click', function () {
        // If identities exist, group by identity first then triangulate
        if (state.session && state.session.identities.length > 0) {
            groupByIdentityAndTriangulateAll();
        } else {
            // No identities — fall back to triangulating existing groups
            triangulateAllFrames();
        }
    });

    // Context menu for instance groups
    document.getElementById('ctxUnlinkGroup').addEventListener('click', function () {
        var menu = document.getElementById('groupContextMenu');
        var group = menu._targetGroup;
        hideGroupContextMenu();
        if (group) unlinkGroup(group);
    });
    document.getElementById('ctxDeleteGroup').addEventListener('click', function () {
        var menu = document.getElementById('groupContextMenu');
        var group = menu._targetGroup;
        hideGroupContextMenu();
        if (group && state.session) {
            if (interactionManager && interactionManager.selectedInstanceGroup === group) {
                interactionManager.clearSelection();
            }
            state.session.removeInstanceGroup(state.currentFrame, group);
            markDirty();
            setStatus('Deleted group', 'success');
            updateTimelineForFrame(state.currentFrame);
            if (viewport3d) viewport3d.setFrame(getInstanceGroupsForFrame(state.currentFrame));
            drawAllOverlays(state.currentFrame);
            updateInfoPanel();
        }
    });

    // Add session button
    document.getElementById('btnAddSession').addEventListener('click', function() {
        loadSingleSessionFromCache();
    });
    // Remove session button
    document.getElementById('btnRemoveSession').addEventListener('click', function() {
        removeSession(state.activeSessionIdx);
    });

    // Frame counter and FPS
    document.getElementById('totalFrames').textContent = state.totalFrames;
    document.getElementById('fpsDisplay').textContent = state.fps.toFixed(1) + ' fps';

    window.addEventListener('beforeunload', function(e) {
        if (state.isDirty) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
}


// ============================================
// UI Updates
// ============================================

export function updateSeekbar(frameIdx) {
    if (frameIdx === undefined) frameIdx = state.currentFrame;
    updateSeekbarVisual(frameIdx);
    document.getElementById('currentFrame').textContent = frameIdx + 1;

    // Update 3D viewport on frame change
    update3DViewport(frameIdx);
}

export function updateSeekbarVisual(frameIdx) {
    const pct = state.totalFrames > 1 ? (frameIdx / (state.totalFrames - 1)) * 100 : 0;
    document.getElementById('seekbarProgress').style.width = pct + '%';
    document.getElementById('seekbarThumb').style.left = pct + '%';
    document.getElementById('currentFrame').textContent = frameIdx + 1;
}

export function onPlaybackStateChange(isPlaying) {
    const btn = document.getElementById('btnPlay');
    btn.textContent = isPlaying ? '\u275A\u275A' : '\u25B6';
    btn.classList.toggle('active', isPlaying);

    // Lazy H5: batch-load frames during playback
    if (state.session && state.session.lazyLoader) {
        if (isPlaying) {
            // Background batch loader — loads 500 frames at a time ahead of playback
            (async function lazyPlaybackLoader() {
                var session = state.session;
                if (!session || !session.lazyLoader) return;
                while (state.isPlaying && state.session === session) {
                    var cur = state.currentFrame;
                    var loaded = await batchLoadLazyFrames(cur, 5000);
                    if (loaded === 0) {
                        // All nearby frames loaded, wait before checking again
                        await new Promise(function(r) { setTimeout(r, 100); });
                    }
                }
            })();
        } else {
            // Stopped — ensure current frame data is loaded and overlays drawn
            ensureLazyFrameData(state.currentFrame).then(function () {
                drawAllOverlays(state.currentFrame);
            });
        }
    }
}

export function toggleInfoPanel() {
    var wrapper = document.getElementById('infoPanelWrapper');
    var viewport3dEl = document.getElementById('viewport3dContainer');
    var infoPanel = document.getElementById('infoPanel');
    var videoGridSection = document.querySelector('.video-grid-section');
    var isCollapsing = !wrapper.classList.contains('collapsed');

    if (isCollapsing) {
        // Record info panel width before collapsing
        var infoPanelWidth = infoPanel.offsetWidth + 1; // +1 for border
        wrapper.classList.add('collapsed');
        // Expand viewport3d to absorb the freed space
        var currentVpWidth = viewport3dEl.offsetWidth;
        viewport3dEl.style.width = (currentVpWidth + infoPanelWidth) + 'px';
    } else {
        // Lock video-grid-section at current width to prevent flex shrinkage
        var gridWidth = videoGridSection.offsetWidth;
        videoGridSection.style.flex = '0 0 ' + gridWidth + 'px';

        // Read the target info panel width from CSS before expanding
        var infoPanelTarget = parseInt(getComputedStyle(document.documentElement)
            .getPropertyValue('--info-panel-width')) || 300;
        infoPanelTarget += 1; // +1 for border

        // Shrink viewport3d immediately (before transition starts)
        var currentVpWidth = viewport3dEl.offsetWidth;
        viewport3dEl.style.width = Math.max(150, currentVpWidth - infoPanelTarget) + 'px';

        wrapper.classList.remove('collapsed');
        // Unlock video grid after the CSS transition completes (250ms)
        setTimeout(function () {
            videoGridSection.style.flex = '';
        }, 300);
    }

    updateInfoPanelToggleBtn();
    if (viewport3d) {
        setTimeout(function () { viewport3d.resize(); }, 350);
    }
}

export function updateInfoPanelToggleBtn() {
    var wrapper = document.getElementById('infoPanelWrapper');
    var btn = document.getElementById('infoPanelToggleBtn');
    if (btn) {
        btn.textContent = wrapper.classList.contains('collapsed') ? 'Show Panel' : 'Hide Panel';
    }
}

export function toggle3DViewport() {
    const container = document.getElementById('viewport3dContainer');
    var isCollapsing = !container.classList.contains('collapsed');
    if (isCollapsing) {
        // Save current width so we can restore it when expanding
        container._savedWidth = container.style.width || '';
        // Clear inline width so the CSS .collapsed { width: 0 } rule takes effect
        container.style.width = '';
        container.classList.add('collapsed');
    } else {
        container.classList.remove('collapsed');
        // Restore the inline width that was set before collapsing
        if (container._savedWidth) {
            container.style.width = container._savedWidth;
        }
        if (viewport3d) {
            setTimeout(function () { viewport3d.resize(); }, 300);
        }
    }
}

export function toggleTimeline() {
    const container = document.getElementById('timelineContainer');
    const willCollapse = !container.classList.contains('collapsed');
    container.classList.toggle('collapsed');
    if (!willCollapse && timeline) {
        // Expanding: if container has no explicit inline height
        // (e.g., first expand, or after a prior full hide), size
        // it to fit loaded tracks so the user can see them.
        if (!container.style.height) {
            var preferred = timeline.getPreferredHeight();
            container.style.height = preferred + 'px';
        }
        setTimeout(function () { timeline.resize(); }, 300);
    }
    syncTimelineToggleButton();
}

export function syncTimelineToggleButton() {
    var btn = document.getElementById('timelineToggleBtn');
    if (!btn) return;
    var container = document.getElementById('timelineContainer');
    btn.classList.toggle('active', !container.classList.contains('collapsed'));
}

// Resize the timeline container to fit the currently loaded tracks
// (called after a session is imported or switched). Skips when the
// user has explicitly collapsed the timeline via the toolbar button.
export function fitTimelineToData() {
    if (!timeline) return;
    var container = document.getElementById('timelineContainer');
    if (!container) return;
    if (container.classList.contains('collapsed')) return;
    var preferred = timeline.getPreferredHeight();
    container.style.height = preferred + 'px';
    timeline.resize();
}


// ============================================
// View Mode Switching (grid / single)
// ============================================

var savedGridLayout = null; // cached dockview layout JSON from grid mode

export function toggleViewMode() {
    if (state.views.length === 0) return;
    if (state.viewMode === 'grid') {
        // Save grid layout before switching to single view
        if (paneManager.api) {
            savedGridLayout = paneManager.api.toJSON();
        }
        state.viewMode = 'single';
        // Start at the last-interacted view
        var startIdx = 0;
        if (interactionManager && interactionManager.lastInteractedView) {
            for (var i = 0; i < state.views.length; i++) {
                if (state.views[i].name === interactionManager.lastInteractedView) {
                    startIdx = i;
                    break;
                }
            }
        }
        state.singleViewIndex = startIdx;
    } else {
        // Cycle to next camera
        state.singleViewIndex = (state.singleViewIndex + 1) % state.views.length;
    }
    updateVideoGridDisplay();
}

export function cycleSingleView(direction) {
    if (state.views.length === 0) return;
    if (state.viewMode !== 'single') {
        state.viewMode = 'single';
        state.singleViewIndex = direction > 0 ? 0 : state.views.length - 1;
    } else {
        state.singleViewIndex = (state.singleViewIndex + direction + state.views.length) % state.views.length;
    }
    updateVideoGridDisplay();
}

export function setGridMode() {
    state.viewMode = 'grid';
    if (savedGridLayout && paneManager.api) {
        // Restore saved grid layout
        var savedZoom = {};
        for (var zi = 0; zi < state.views.length; zi++) {
            var zv = state.views[zi];
            if (zv.zoom) {
                savedZoom[zv.name] = { scale: zv.zoom.scale, offsetX: zv.zoom.offsetX, offsetY: zv.zoom.offsetY };
            }
        }
        paneManager.clearAll();
        paneManager.api.fromJSON(savedGridLayout);
        var emptyMsg = document.getElementById('videoDockEmpty');
        if (emptyMsg) emptyMsg.classList.add('hidden');
        refreshPaneInteractions();
        // Restore zoom state
        for (var ri = 0; ri < state.views.length; ri++) {
            var rv = state.views[ri];
            if (savedZoom[rv.name] && rv.zoom) {
                rv.zoom.scale = savedZoom[rv.name].scale;
                rv.zoom.offsetX = savedZoom[rv.name].offsetX;
                rv.zoom.offsetY = savedZoom[rv.name].offsetY;
                if (videoController) videoController.applyZoom(rv);
            }
        }
    } else {
        updateVideoGridDisplay();
    }
}

export function updateVideoGridDisplay() {
    if (state.views.length === 0) return;
    // Preserve zoom state across panel recreation
    var savedZoom = {};
    for (var zi = 0; zi < state.views.length; zi++) {
        var zv = state.views[zi];
        if (zv.zoom) {
            savedZoom[zv.name] = { scale: zv.zoom.scale, offsetX: zv.zoom.offsetX, offsetY: zv.zoom.offsetY };
        }
    }
    if (state.viewMode === 'single') {
        // Show only the selected view
        var targetView = state.views[state.singleViewIndex];
        if (targetView) {
            paneManager.clearAll();
            paneManager.addVideoPanel(targetView.name);
            refreshPaneInteractions();
        }
    } else {
        // Grid mode: show all views
        paneManager.clearAll();
        paneManager.addAllViewsAsGrid();
        refreshPaneInteractions();
    }
    // Restore zoom state
    for (var ri = 0; ri < state.views.length; ri++) {
        var rv = state.views[ri];
        if (savedZoom[rv.name] && rv.zoom) {
            rv.zoom.scale = savedZoom[rv.name].scale;
            rv.zoom.offsetX = savedZoom[rv.name].offsetX;
            rv.zoom.offsetY = savedZoom[rv.name].offsetY;
            if (videoController) videoController.applyZoom(rv);
        }
    }
}

export function showViewIndicator() {
    var existing = document.getElementById('viewModeIndicator');
    if (existing) existing.remove();
    if (state.viewMode !== 'single' || state.views.length === 0) return;

    var indicator = document.createElement('div');
    indicator.id = 'viewModeIndicator';
    indicator.style.cssText = 'position:absolute;top:8px;right:8px;z-index:20;background:rgba(0,0,0,0.7);color:#fff;padding:4px 10px;border-radius:4px;font-size:12px;pointer-events:none;';
    indicator.textContent = state.views[state.singleViewIndex].name +
        ' (' + (state.singleViewIndex + 1) + '/' + state.views.length + ')';

    var dockEl = document.getElementById('videoDock');
    if (dockEl) {
        dockEl.style.position = 'relative';
        dockEl.appendChild(indicator);
    }
}



export function applyPlaybackRate() {
    var speedMult = state.speedMultiplier || 1.0;
    var views = state.views.filter(function (v) { return v.decoder; });
    var nativeFps = (views.length > 0 && views[0].decoder.videoTrack && views[0].decoder.videoTrack.duration > 0)
        ? views[0].decoder.samples.length / (views[0].decoder.videoTrack.duration / views[0].decoder.videoTrack.timescale)
        : (state.fps || 30);
    var rate = ((state.fps || 30) / nativeFps) * speedMult;
    for (var i = 0; i < views.length; i++) {
        var d = views[i].decoder;
        if (d._videoEl) {
            d._videoEl.playbackRate = rate;
        }
    }
}
