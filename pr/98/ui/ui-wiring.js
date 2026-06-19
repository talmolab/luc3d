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
         getActiveSession, hasRealVideo } from './app-state.js';
// Block 1 (Prompt 4): the timeline collapse/fit/sync helpers and the
// Ctrl/Cmd+J keyboard shortcut installer live in `timeline-controller.js`.
// Import them explicitly so the local call sites in this file (menu
// items, toolbar button) resolve to the new implementation.
import {
    toggleTimeline,
    fitTimelineToData,
    syncTimelineToggleButton,
    installTimelineShortcuts,
    getCachedTimelineHeight,
    setCachedTimelineHeight,
} from './timeline-controller.js';
import { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, UnlinkedInstance, Identity, Session } from '../pose/pose-data.js';
import { ensureLazyFrameData, batchLoadLazyFrames, getInstanceGroupsForFrame, evictLazyFrames,
         loadAllLazyFrames, updateTimelineForFrame, triangulateAndReproject } from '../pose/triangulation.js';
import { drawAllOverlays, getVisibilitySettings, updateFrameCounters, setReprojErrorVisible } from './rendering.js';
import { updateInfoPanel, updateFrameInfo, updateTriangulationBadge,
         populateVideosTable, populateCamerasTable, populateSkeletonTable,
         setupPanelTabs, setupSkeletonEditing, parseSkeletonJSON, exportSkeletonJSON,
         ensureSession, populateSessionAssignTable, populateUnassignedVideos,
         populateTimelineVisibility } from './info-panel.js';
// Block 2 (Prompt 4): rename migration for the per-session hidden-track
// / hidden-identity Sets when the user renames an entity.
import { renameHiddenTrack, renameHiddenIdentity } from './timeline-visibility.js';
import { newProject, markDirty, clearDirty, quickSave, saveAs, saveProjectSlp, saveProject,
         handleLoadProject, showLoading, hideLoading, setStatus } from '../import-export/save-load.js';
import { handleLoadSlpFile, handleAddSlp, handleLoadPoints3dH5 } from '../import-export/slp-import.js';
import { pickFiles, parseCalibrationJSON, exportCalibrationTOML, downloadTOML, parseSlpH5 } from '../import-export/file-io.js';
import { handleLoadCalibration, handleLoadVideos, handleLoadMultiSession,
         loadSingleSessionFromCache, showSessionModeModal, autoAssignVideosToCameras } from '../loading/session-loader.js';
import { OnDemandVideoDecoder, VideoController } from '../loading/video.js';

// Pass 3i-1: tracker functions moved out of app.js.
import { trackCurrentFrame, trackAll, findMatchForSelected } from '../pose/tracker.js';
// Pass 3i-2: triangulation orchestration moved out of app.js.
import { triangulateCurrentFrame, triangulateAllFrames } from '../pose/triangulation.js';
// User settings: default triangulation method + editable keyboard bindings.
import { getDefaultTriangulationMethod, setHandler, dispatchEvent } from './settings.js';
import { showSettingsModal } from './settings-modal.js';
// Pass 3i-3: addNewInstanceSmart and update3DViewport moved to pose/initialization.js.
import { addNewInstanceSmart, update3DViewport, navigateToFrame } from '../pose/initialization.js';
// Pass 3f / 3i-4: identity-assignment workflow symbols moved out of app.js.
// (`swapTracks` joined this module in 3i-4; `seekToLabeledFrame` is now in-module.)
import {
    assignTrackToSelected, assignIdentityToSelected, propagateIdentityForward, swapAssignTrack,
    startEditGroup, finishEditGroup,
    startManualAssignment, runSingleFrameTriangulation, showMultiFrameModal,
    purgeTriangulationDataForGroup,
    swapTracks,
} from './identity-assignment.js';
// Pass 3g: export-modals workflow symbols moved out of app.js.
import {
    exportLabels, exportPoints3dH5, exportReprojH5,
    showSlpExportModal, showSlpExportAllModal, showSlpExportByCamModal,
    showTriangulateMultiFrameModal,
    showGroupByTrackModal, groupByIdentityAndTriangulateAll, showExport3DVideoModal,
} from './export-modals.js';
// Pass 3h: sessions-panes workflow symbols moved out of app.js.
import {
    panelRenderers, multiSelectViews,
    refreshPaneInteractions, clearMultiSelect, clampRotation, syncRotationUI,
    populateViewStrip, populateSessionsPanel, populateSessionStrip,
    showMoveVideoModal, removeSession, switchSession,
} from './sessions-panes.js';

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
        document.querySelectorAll('.tri-dropdown.open').forEach(function (d) {
            d.classList.remove('open');
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
        // Implicit triangulation (menu/keyboard) uses the Settings default method.
        triangulateCurrentFrame(getDefaultTriangulationMethod());
    });

    // Help menu: Documentation (external docs) and Settings (preferences modal).
    document.getElementById('menuDocumentation').addEventListener('click', function () {
        closeMenus();
        window.open('https://talmolab.github.io/luc3d-docs/', '_blank', 'noopener');
    });
    document.getElementById('menuSettings').addEventListener('click', function () {
        closeMenus();
        showSettingsModal();
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

    // Propagate Tracks → IDs (one-shot): each track label becomes an identity,
    // stamped per-frame on every instance. (Was the "Trust Track Labels"
    // toggle; now a single action.)
    document.getElementById('menuPropagateTracksToIds').addEventListener('click', function () {
        closeMenus();
        if (!state.session) { setStatus('No session loaded', 'warning'); return; }
        var session = state.session;
        var res = session.propagateTracksToIdentities();
        // Mark tracks as trusted (persisted in project metadata) and show IDs.
        session.trustTracks = true;
        state.colorByIdentity = true;
        updateColorByToggle();
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(session, { cap: true });
        setStatus('Propagate Tracks → IDs: ' + res.identities + ' identities from tracks (' +
            res.instances + ' instances)', 'success');
    });

    // Propagate IDs → Tracks (one-shot): identity/grouping is the source of
    // truth — overwrite every instance's track with its identity, rewriting the
    // session track list to one uniquely-named track per used identity.
    document.getElementById('menuPropagateIdsToTracks').addEventListener('click', function () {
        closeMenus();
        if (!state.session) { setStatus('No session loaded', 'warning'); return; }
        var res = state.session.propagateIdentitiesToTracks();
        if (res.tracks === 0) {
            setStatus('Propagate IDs → Tracks: no identities are assigned to any group', 'warning');
            return;
        }
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(state.session, { cap: true });
        setStatus('Propagate IDs → Tracks: ' + res.tracks + ' tracks from identities (' +
            res.instances + ' instances updated)', 'success');
    });

    // Color by Tracks / ID toolbar toggle
    var colorByTracksBtn = document.getElementById('colorByTracks');
    var colorByIdBtn = document.getElementById('colorById');

    function updateColorByToggle() {
        colorByTracksBtn.classList.toggle('active', !state.colorByIdentity);
        colorByIdBtn.classList.toggle('active', state.colorByIdentity);
    }
    updateColorByToggle();

    colorByTracksBtn.addEventListener('click', function () {
        state.colorByIdentity = false;
        updateColorByToggle();
        drawAllOverlays(state.currentFrame);
        update3DViewport(state.currentFrame);  // recolor 3D instances instantly
        setStatus('Coloring by Track', 'success');
    });

    colorByIdBtn.addEventListener('click', function () {
        state.colorByIdentity = true;
        updateColorByToggle();
        drawAllOverlays(state.currentFrame);
        update3DViewport(state.currentFrame);  // recolor 3D instances instantly
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
        // Block 2 (Prompt 4): refresh Visibility-tab toggle lists.
        populateTimelineVisibility(state.session);
    });

    document.getElementById('menuRenameTrack').addEventListener('click', function () {
        closeMenus();
        if (!state.session || state.session.tracks.length === 0) { setStatus('No tracks', 'warning'); return; }
        var trackList = state.session.tracks.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n');
        var idx = parseInt(prompt('Which track to rename?\n\n' + trackList + '\n\nEnter number:')) - 1;
        if (isNaN(idx) || idx < 0 || idx >= state.session.tracks.length) return;
        var oldName = state.session.tracks[idx];
        var newName = prompt('New name for "' + oldName + '":', oldName);
        if (!newName) return;
        state.session.tracks[idx] = newName;
        // Block 2 (Prompt 4): migrate hidden-set membership across rename
        // so the toggle state persists. Identity rename / no-op safe.
        renameHiddenTrack(state.session, oldName, newName);
        setStatus('Renamed track ' + (idx + 1) + ' to: ' + newName, 'success');
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(state.session);
        populateTimelineVisibility(state.session);
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
        // Block 2 (Prompt 4): drop the now-defunct entry from the
        // hidden-tracks Set so a future track with the same name won't
        // start out hidden.
        if (state.session._hiddenTracks) state.session._hiddenTracks.delete(name);
        setStatus('Deleted track: ' + name, 'success');
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(state.session);
        populateTimelineVisibility(state.session);
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
        // Block 2 (Prompt 4): refresh Visibility-tab toggle lists.
        populateTimelineVisibility(state.session);
    });

    document.getElementById('menuRenameIdentity').addEventListener('click', function () {
        closeMenus();
        if (!state.session || state.session.identities.length === 0) { setStatus('No identities', 'warning'); return; }
        var idList = state.session.identities.map(function (id, i) { return (i + 1) + '. ' + id.name; }).join('\n');
        var idx = parseInt(prompt('Which identity to rename?\n\n' + idList + '\n\nEnter number:')) - 1;
        if (isNaN(idx) || idx < 0 || idx >= state.session.identities.length) return;
        var oldIdName = state.session.identities[idx].name;
        var newName = prompt('New name for "' + oldIdName + '":', oldIdName);
        if (!newName) return;
        state.session.identities[idx].name = newName;
        // Block 2 (Prompt 4): migrate hidden-identity Set membership
        // so the toggle state persists across rename.
        renameHiddenIdentity(state.session, oldIdName, newName);
        setStatus('Renamed identity to: ' + newName, 'success');
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(state.session);
        populateTimelineVisibility(state.session);
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
        // Block 2 (Prompt 4): drop the deleted identity name from the
        // hidden-identity Set.
        if (state.session._hiddenIdentities) state.session._hiddenIdentities.delete(identity.name);
        setStatus('Deleted identity: ' + identity.name, 'success');
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(state.session);
        populateTimelineVisibility(state.session);
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

    // Deprecated: "Export 2D SLP (All Views)" was removed from the File menu.
    // The handler and showSlpExportAllModal are retained but no longer wired.
    // document.getElementById('menuExportSlp').addEventListener('click', function () {
    //     closeMenus();
    //     if (state.sessions.length === 0) { setStatus('No sessions to export', 'error'); return; }
    //     showSlpExportAllModal();
    // });

    document.getElementById('menuExportSlpPerCam').addEventListener('click', function () {
        closeMenus();
        if (!state.sessions || state.sessions.length === 0) { setStatus('No sessions to export', 'error'); return; }
        showSlpExportModal();
    });

    document.getElementById('menuExportSlpByCam').addEventListener('click', function () {
        closeMenus();
        if (!state.sessions || state.sessions.length === 0) { setStatus('No sessions to export', 'error'); return; }
        showSlpExportByCamModal();
    });

    document.getElementById('menuExportVideo3d').addEventListener('click', function () {
        closeMenus();
        if (!state.session) { setStatus('No session to export', 'error'); return; }
        showExport3DVideoModal();
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

// --- Video-less playback (skeleton + imported 3D points) ---------------------
// A timer-driven frame stepper used when there is no videoController to drive
// native playback. Steps through [0, totalFrames-1] at state.fps, rendering
// each frame's overlays + 3D viewport via navigateToFrame.
var _noVideoPlayTimer = null;

function stopNoVideoPlayback() {
    if (_noVideoPlayTimer) { clearTimeout(_noVideoPlayTimer); _noVideoPlayTimer = null; }
    state.isPlaying = false;
    onPlaybackStateChange(false);
}

function startNoVideoPlayback() {
    if ((state.totalFrames || 1) <= 1) return;
    state.isPlaying = true;
    onPlaybackStateChange(true);
    var tick = function () {
        if (!state.isPlaying) return;
        var fps = state.fps && state.fps > 0 ? state.fps : 30;  // re-read so FPS edits apply
        var next = state.currentFrame + 1;
        if (next >= state.totalFrames) { stopNoVideoPlayback(); return; }  // stop at last frame
        navigateToFrame(next);
        _noVideoPlayTimer = setTimeout(tick, 1000 / fps);
    };
    var fps0 = state.fps && state.fps > 0 ? state.fps : 30;
    _noVideoPlayTimer = setTimeout(tick, 1000 / fps0);
}

function toggleNoVideoPlayback() {
    if (_noVideoPlayTimer) { stopNoVideoPlayback(); return; }
    if (state.currentFrame >= (state.totalFrames - 1)) navigateToFrame(0);  // restart from 0 at the end
    startNoVideoPlayback();
}

export function setupUI() {
    // Transport controls
    document.getElementById('btnFirst').addEventListener('click', function () { if (!hasRealVideo()) stopNoVideoPlayback(); navigateToFrame(0); });
    document.getElementById('btnPrev').addEventListener('click', function () { if (!hasRealVideo()) stopNoVideoPlayback(); navigateToFrame(state.currentFrame - 1); });
    document.getElementById('btnPlay').addEventListener('click', function () {
        if (!hasRealVideo()) { toggleNoVideoPlayback(); return; }
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
    document.getElementById('btnNext').addEventListener('click', function () { if (!hasRealVideo()) stopNoVideoPlayback(); navigateToFrame(state.currentFrame + 1); });
    document.getElementById('btnLast').addEventListener('click', function () { if (!hasRealVideo()) stopNoVideoPlayback(); navigateToFrame(state.totalFrames - 1); });

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
        if (!hasRealVideo()) {
            // Video-less project (skeleton + imported 3D points): support frame
            // stepping + play/pause over the points3d duration even though
            // there's no decoder.
            switch (e.key) {
                case 'ArrowRight': e.preventDefault(); stopNoVideoPlayback(); navigateToFrame(state.currentFrame + 1); break;
                case 'ArrowLeft': e.preventDefault(); stopNoVideoPlayback(); navigateToFrame(state.currentFrame - 1); break;
                case 'Home': e.preventDefault(); stopNoVideoPlayback(); navigateToFrame(0); break;
                case 'End': e.preventDefault(); stopNoVideoPlayback(); navigateToFrame(state.totalFrames - 1); break;
                case ' ': e.preventDefault(); toggleNoVideoPlayback(); break;
            }
            return;
        }
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

    // Attach runtime handlers for the centrally-dispatched keyboard actions
    // declared in the settings catalog (ui/settings.js). Their bindings are the
    // source of truth and are editable via Settings ▸ Keyboard Shortcuts; the
    // dedicated dispatcher below resolves each keydown to its action.
    function toggleVisCheckbox(id) {
        var cb = document.getElementById(id);
        if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    setHandler('toggleUser', function () { toggleVisCheckbox('visUser'); });
    setHandler('togglePredicted', function () { toggleVisCheckbox('visPredicted'); });
    setHandler('toggleReproj', function () { toggleVisCheckbox('visReprojections'); });
    setHandler('toggleErrors', function () { toggleVisCheckbox('visErrors'); });
    setHandler('cycleViewMode', function () { toggleViewMode(); showViewIndicator(); });
    setHandler('gridMode', function () { setGridMode(); showViewIndicator(); });
    // Triangulate uses the Settings default method (DLT/BA).
    setHandler('triangulate', function () { triangulateCurrentFrame(getDefaultTriangulationMethod()); });
    setHandler('addInstance', function () { if (interactionManager) interactionManager._addNewInstance(); });
    setHandler('ungroup', function () {
        if (interactionManager && interactionManager.selectedInstanceGroup) {
            unlinkGroup(interactionManager.selectedInstanceGroup);
        }
    });
    setHandler('showHotkeys', function () { showHotkeysHelp(); });

    // Single dispatcher for catalog-driven shortcuts. Runs before the structural
    // handlers below; if a catalog action matches it consumes the event.
    document.addEventListener('keydown', function (e) {
        if (dispatchEvent(e)) e.preventDefault();
    });

    // --- New keyboard shortcuts (Prompt 36) ---
    document.addEventListener('keydown', function (e) {
        // Ctrl+S / Cmd+S = Quick Save
        if (e.key === 's' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
            e.preventDefault();
            quickSave();
            return;
        }
        // Cmd/Ctrl+, = open Settings (standard preferences shortcut)
        if (e.key === ',' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            showSettingsModal();
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
        // Block 1 (Prompt 4): plain Ctrl/Cmd+J now toggles the timeline,
        // and Ctrl/Cmd+Shift+J fires the legacy "Change Frame Number"
        // command. Both bindings live in `ui/timeline-controller.js` and
        // are installed once during `setupTimeline()`. Don't return early
        // for those — let them propagate to the timeline handler.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
            switch (e.key) {
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
            // Other plain-key shortcuts (visibility toggles, view modes,
            // triangulate, add-instance, ungroup, help, …) are handled by the
            // catalog dispatcher installed above (ui/settings.js dispatchEvent).
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
            // 3D node style: rebuild the 3D skeleton with the new node geometry.
            if (container.id === 'vis3dNodeStyle') {
                if (viewport3d) {
                    viewport3d.skeletonNodeShape = btn.getAttribute('data-style');
                    var g3d = (typeof getInstanceGroupsForFrame === 'function')
                        ? getInstanceGroupsForFrame(state.currentFrame) : [];
                    viewport3d.setFrame(g3d);
                }
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
        'visUserNodeStyle', 'visPredNodeStyle', 'visReprojNodeStyle', 'vis3dNodeStyle',
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
    // Triangulate / Triangulate All are hover-only dropdowns: hovering the button
    // reveals a menu with DLT (Fast) and BA (Slow & Accurate) (shown purely via
    // CSS :hover). The buttons themselves no longer trigger anything on click —
    // only choosing a menu item runs that method. Implicit triangulation (the
    // keyboard shortcut and the Edit menu) uses the Settings default method.
    function wireTriDropdown(dropdownId, buttonId, onPick) {
        var dropdown = document.getElementById(dropdownId);
        if (!dropdown) return;

        dropdown.querySelectorAll('.tri-dropdown-item').forEach(function (item) {
            item.addEventListener('click', function (e) {
                e.stopPropagation();
                onPick(item.getAttribute('data-method') === 'ba' ? 'ba' : 'dlt');
            });
        });
    }

    // Triangulate current frame with the chosen method.
    wireTriDropdown('triangulateDropdown', 'tbTriangulate', function (method) {
        triangulateCurrentFrame(method);
    });

    // Triangulate all frames. DLT keeps the existing "group by identity first"
    // behavior (grouping always uses DLT); BA triangulates every group with
    // bundle adjustment (auto-grouping from identities as needed).
    wireTriDropdown('triangulateAllDropdown', 'tbTriangulateAll', function (method) {
        if (method === 'ba') {
            triangulateAllFrames('ba');
        } else if (state.session && state.session.identities.length > 0) {
            groupByIdentityAndTriangulateAll();
        } else {
            triangulateAllFrames('dlt');
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

// Block 1 (Prompt 4): toggleTimeline / syncTimelineToggleButton /
// fitTimelineToData moved into `ui/timeline-controller.js`. The
// controller caches the prior height across collapse/expand cycles,
// adds the Ctrl/Cmd+J (and Shift+J) shortcuts, and is bridgeable into
// the test runner (no transitive app.js imports). We re-export the
// public surface here so existing call sites that import from
// `ui-wiring.js` continue to work.
export {
    toggleTimeline,
    fitTimelineToData,
    syncTimelineToggleButton,
    installTimelineShortcuts,
    getCachedTimelineHeight,
    setCachedTimelineHeight,
};


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

// ============================================
// seekToLabeledFrame (Pass 3i-4: moved from app.js)
// ============================================

/**
 * Navigate to the next or previous frame that has labeled data.
 * direction > 0: next labeled frame; direction < 0: previous labeled frame.
 */
export function seekToLabeledFrame(direction) {
    if (!state.session) return;
    var indices = state.session.frameIndices;
    if (!indices || indices.length === 0) return;
    var cur = state.currentFrame;
    var target = null;
    if (direction > 0) {
        for (var i = 0; i < indices.length; i++) {
            if (indices[i] > cur) { target = indices[i]; break; }
        }
    } else {
        for (var i = indices.length - 1; i >= 0; i--) {
            if (indices[i] < cur) { target = indices[i]; break; }
        }
    }
    if (target != null && videoController) {
        // Snap timeline/seekbar synchronously so the bar moves on the
        // same keystroke — videoController.seekToFrame is async
        // (awaits frame decode before calling drawOverlays/timeline),
        // which is noticeable on labeled-frame jumps that skip many
        // frames at once.
        if (timeline) timeline.setCurrentFrame(target);
        updateSeekbarVisual(target);
        videoController.seekToFrame(target);
        setStatus('Frame ' + (target + 1), 'info');
    }
}

// ============================================
// Editable Frame Number / FPS Pill / Speed Control IIFEs
// (Pass 3i-4: moved from app.js)
// ============================================

// ============================================
// Editable Frame Number
// ============================================

(function () {
    var frameEl = document.getElementById('currentFrame');
    if (!frameEl) return;
    frameEl.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        var currentVal = state.currentFrame + 1;
        var input = document.createElement('input');
        input.type = 'text';
        input.value = currentVal;
        input.style.cssText = 'width:60px;font-family:inherit;font-size:inherit;' +
            'color:var(--text-primary);background:var(--bg-tertiary);border:1px solid var(--accent);' +
            'border-radius:3px;padding:0 4px;text-align:center;outline:none;';

        frameEl.textContent = '';
        frameEl.appendChild(input);
        input.focus();
        input.select();

        function commit() {
            var raw = input.value.trim();
            var num = parseInt(raw, 10);
            if (!isNaN(num) && num >= 1 && num <= state.totalFrames) {
                if (videoController) videoController.seekToFrame(num - 1);
            }
            frameEl.textContent = state.currentFrame + 1;
        }

        function cancel() {
            frameEl.textContent = state.currentFrame + 1;
        }

        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
            if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', commit);
    });
})();

// ============================================
// Editable FPS Pill
// ============================================


(function () {
    var fpsEl = document.getElementById('fpsDisplay');
    if (!fpsEl) return;
    fpsEl.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        var currentFps = state.fps || 30;
        var input = document.createElement('input');
        input.type = 'text';
        input.value = currentFps.toFixed(1);
        input.style.cssText = 'width:50px;font-family:inherit;font-size:inherit;' +
            'color:var(--text-primary);background:var(--bg-tertiary);border:1px solid var(--accent);' +
            'border-radius:3px;padding:0 4px;text-align:center;outline:none;';

        fpsEl.textContent = '';
        fpsEl.appendChild(input);
        input.focus();
        input.select();

        function commit() {
            var raw = input.value.trim();
            var num = parseFloat(raw);
            if (raw !== '' && !isNaN(num) && num > 0 && num <= 1000) {
                state.fps = num;
                applyPlaybackRate();
                if (videoController && state.isPlaying) {
                    videoController.stopPlayback();
                    videoController.startPlayback();
                }
            }
            fpsEl.textContent = (state.fps || 30).toFixed(1) + ' fps';
        }

        function cancel() {
            fpsEl.textContent = (state.fps || 30).toFixed(1) + ' fps';
        }

        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
            if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', commit);
    });
})();

// ============================================
// Speed Control
// ============================================

state.speedMultiplier = 1.0;

(function () {
    var speedBtn = document.getElementById('speedBtn');
    var popover = document.getElementById('speedPopover');
    if (!speedBtn || !popover) return;

    function buildPopover() {
        popover.innerHTML = '';

        var label = document.createElement('div');
        label.className = 'speed-label';
        label.textContent = state.speedMultiplier.toFixed(2) + 'x';
        popover.appendChild(label);

        var sliderRow = document.createElement('div');
        sliderRow.className = 'speed-slider-row';

        var minusBtn = document.createElement('button');
        minusBtn.textContent = '\u2212';
        var plusBtn = document.createElement('button');
        plusBtn.textContent = '+';

        var slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0.25';
        slider.max = '4.0';
        slider.step = '0.05';
        slider.value = state.speedMultiplier;

        minusBtn.addEventListener('click', function () {
            var v = Math.max(0.25, parseFloat(slider.value) - 0.05);
            slider.value = v;
            applySpeed(v);
        });
        plusBtn.addEventListener('click', function () {
            var v = Math.min(4.0, parseFloat(slider.value) + 0.05);
            slider.value = v;
            applySpeed(v);
        });
        slider.addEventListener('input', function () {
            applySpeed(parseFloat(slider.value));
        });

        sliderRow.appendChild(minusBtn);
        sliderRow.appendChild(slider);
        sliderRow.appendChild(plusBtn);
        popover.appendChild(sliderRow);

        var presets = document.createElement('div');
        presets.className = 'speed-presets';
        [1.0, 1.25, 1.5, 2.0, 3.0].forEach(function (val) {
            var btn = document.createElement('button');
            btn.textContent = val.toFixed(val % 1 === 0 ? 1 : 2);
            if (Math.abs(state.speedMultiplier - val) < 0.01) btn.classList.add('active');
            btn.addEventListener('click', function () {
                slider.value = val;
                applySpeed(val);
            });
            presets.appendChild(btn);
        });
        popover.appendChild(presets);

        function applySpeed(v) {
            state.speedMultiplier = Math.round(v * 100) / 100;
            label.textContent = state.speedMultiplier.toFixed(2) + 'x';
            var btnVal = document.getElementById('speedBtnValue');
            if (btnVal) btnVal.textContent = state.speedMultiplier.toFixed(2) + 'x';
            presets.querySelectorAll('button').forEach(function (b) {
                b.classList.toggle('active', Math.abs(parseFloat(b.textContent) - state.speedMultiplier) < 0.01);
            });
            applyPlaybackRate();
        }
    }

    speedBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (popover.style.display === 'none') {
            buildPopover();
            popover.style.display = '';
        } else {
            popover.style.display = 'none';
        }
    });

    document.addEventListener('click', function (e) {
        if (popover.style.display !== 'none' && !popover.contains(e.target) && e.target !== speedBtn) {
            popover.style.display = 'none';
        }
    });
})();
