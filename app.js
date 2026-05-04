        import { DockviewComponent, themeDark } from 'https://cdn.jsdelivr.net/npm/dockview-core/+esm';
        import { Skeleton, Camera, Instance, UnlinkedInstance, FrameGroup, Identity, InstanceGroup, Session } from './pose/pose-data.js';
        import {
            reprojectPoints, computeReprojectionErrors, computeInstanceDistance,
            triangulateAndReproject, hungarianAlgorithm,
            storeReprojectedInstances, LazyFrameLoader, shouldUseLazyH5,
            getInstanceGroupsForFrame, frameHasGroupedUserInstances,
            ensureLazyFrameData, buildLazyFrameGroupSync, batchLoadLazyFrames,
            loadAllLazyFrames, evictLazyFrames, updateTimelineForFrame,
            triangulateMultiFrameInstances,
        } from './pose/triangulation.js';
        import { matchFrameInstances } from './pose/tracker.js';
        import { REPROJECTION_COLOR, getTrackColor, getGroupColor, drawFrameOverlays } from './ui/overlays.js';
        import { InteractionManager, isInteractiveClickTarget } from './ui/interaction.js';
        import { Viewport3D } from './ui/viewport3d.js';
        import { Timeline } from './ui/timeline.js';
        import { validateSkeletonCompatibility, mergeTracksIntoSession, mergeSlpFramesIntoSession, rebuildInstanceGroupsForFrames } from './import-export/slp-merge.js';
        import {
            pickFiles, pickFolder, parseCalibrationTOML, parseCalibrationJSON,
            matchVideosToCameras, buildVideoGrid, exportCalibrationTOML,
            serializeSkeleton, buildSlpExportData, buildPoints3dExportData,
            downloadJSON, downloadTOML, h5FileToBlob, buildPerCameraSlpJson,
            buildSlpLabels, buildSlpLabelsMultiSession, buildSlpLabelsAllViews,
            parseSlpH5, instancePointsMatch, convertSlpToV06Compatible,
            loadCalibrationFile, pickVideoFiles, exportSlpClientSide, exportSlpMultiSession,
            buildPoints3dH5, buildReprojH5, parsePoints3dH5
        } from './import-export/file-io.js';
        import { OnDemandVideoDecoder, EmbeddedVideoDecoder, VideoController, videoLog } from './loading/video.js';
        import { createDemoCalibration, createDemoSkeleton, generateDemoKeypoints3D, createDemoSession } from './demo-data.js';
        import {
            state,
            videoController, interactionManager, viewport3d, timeline, paneManager,
            setVideoController, setInteractionManager, setViewport3D, setTimeline, setPaneManager,
            getActiveSession, setActiveSession,
            VIEW_NAMES,
        } from './ui/app-state.js';
        import {
            handleLoadCalibration, handleLoadVideos, autoAssignVideosToCameras,
            forceVideoSelection, showParentDirMatchSummary, forceVideoSelectionWithFolder,
            createViewForVideoFile, updateGridLayout, createVideoPromptCell,
            fitCanvasesToCells, rebuildVideoController, updateTotalFrames,
            handleLoadMultiSession, showSessionModeModal, loadSingleSessionFromCache,
            handleLoadSessionFolderPerCamera,
            resolveImportTrackIdx, cellResizeObserver,
        } from './loading/session-loader.js';
        import {
            newProject, markDirty, clearDirty,
            quickSave, saveAs, saveProjectSlp, saveProject,
            handleLoadProject,
            showLoading, hideLoading, setStatus,
        } from './import-export/save-load.js';
        import {
            handleLoadSlpFile, handleAddSlp, handleLoadPoints3dH5,
        } from './import-export/slp-import.js';
        import {
            setReprojErrorVisible, getVisibilitySettings,
            drawAllOverlays, updateFrameCounters,
        } from './ui/rendering.js';
        import {
            setupPanelTabs, populateVideosTable, populateCamerasTable,
            populateSkeletonTable, setupSkeletonEditing, parseSkeletonJSON,
            updateInfoPanel, updateFrameInfo, updateTriangulationBadge,
        } from './ui/info-panel.js';
        import {
            setupMenus, setupUI,
            unlinkGroup, showGroupContextMenu, hideGroupContextMenu,
            updateSeekbar, updateSeekbarVisual, onPlaybackStateChange,
            toggleInfoPanel, updateInfoPanelToggleBtn, toggle3DViewport,
            toggleTimeline, syncTimelineToggleButton, fitTimelineToData,
            toggleViewMode, cycleSingleView, setGridMode,
            updateVideoGridDisplay, showViewIndicator, applyPlaybackRate,
        } from './ui/ui-wiring.js';
        import { setupDragHandle, setupSplitHandles } from './ui/layout-controls.js';
        import {
            swapAssignTrack, assignTrackToSelected, propagateIdentityForward, assignIdentityToSelected,
            purgeTriangulationDataForGroup,
            manualAssignState, getTotalUnlinkedCount, cleanupManualAssignment, startManualAssignment,
            editGroupState, startEditGroup, cancelEditGroup, finishEditGroup, cleanupEditGroup, updateEditGroupToast,
            autoAssignState, cleanupAutoAssignment, runAutomaticAssignment, runTrackedAssignment,
            runSingleFrameTriangulation,
            showMultiFrameModal, startViewSelectionForFrames, showMultiFrameProgressModal, runMultiFrameAssignment,
        } from './ui/identity-assignment.js';
        import {
            showGroupByTrackModal, groupByIdentityAndTriangulateAll,
            showSlpExportModal, showSlpExportAllModal, showTriangulateMultiFrameModal,
            exportLabels, exportPoints3dH5, exportReprojH5,
        } from './ui/export-modals.js';

        // ============================================
        // Logging
        // ============================================

        window.logMessage = function (msg, level) {
            if (level === 'error') console.error(msg);
            else if (level === 'warn') console.warn(msg);
            else console.log(msg);
        };

        // ============================================
        // Initialization
        // ============================================

        async function init() {
            try {
                // Setup UI components (no data needed)
                setupEmptyVideoController();
                setupUI();
                setupPanelTabs();
                setupSkeletonEditing();
                setupInteraction();
                try {
                    paneManager.init(document.getElementById('videoDock'));
                } catch (dockErr) {
                    console.error('Dockview init failed:', dockErr);
                }
                setupSplitHandles();
                setupTimeline();
                setupMenus();

                hideLoading();
                setStatus('Ready - load session via File menu', 'success');

            } catch (err) {
                console.error('Initialization failed:', err);
                showLoadingError('Error: ' + err.message);
                setStatus('Error', 'error');
            }
        }

        /**
         * Create a minimal video controller for empty state (no views loaded yet).
         */
        var _zoomRedrawTimer = null;
        function setupEmptyVideoController() {
            setVideoController(new VideoController(state, {
                updateSeekbar: updateSeekbar,
                drawOverlays: drawAllOverlays,
                onPlaybackStateChange: onPlaybackStateChange,
                log: window.logMessage,
                onZoomChange: function () {
                    clearTimeout(_zoomRedrawTimer);
                    _zoomRedrawTimer = setTimeout(function () {
                        drawAllOverlays(state.currentFrame);
                    }, 200);
                },
            }));
        }

        /**
         * Show/hide loading overlay helpers
         */
        /**
         * Hide the welcome/empty overlay (dock empty state is handled by paneManager).
         */
        export function hideWelcomeOverlay() {
            var emptyMsg = document.getElementById('videoDockEmpty');
            if (emptyMsg) emptyMsg.classList.add('hidden');
        }

        function showLoadingError(msg) {
            var overlay = document.getElementById('loadingOverlay');
            var spinner = document.getElementById('loadingSpinner');
            var status = document.getElementById('loadingStatus');
            var dismiss = document.getElementById('loadingDismiss');
            if (overlay) overlay.style.display = '';
            if (spinner) spinner.style.display = 'none';
            if (status) status.textContent = msg;
            if (dismiss) {
                dismiss.style.display = '';
                dismiss.onclick = function () { hideLoading(); };
            }
        }

        /**
         * Load the demo session (synthetic data for testing).
         * Available as File → Load Demo Session.
         */
        async function loadDemoSession() {
            showLoading('Loading demo videos...');
            try {
                // Clear existing state
                if (videoController && state.isPlaying) videoController.stopPlayback();
                setVideoController(null);
                state.views = [];
                state.videoFiles = [];
                state.session = null;
                state.sessions = [];
                state.triangulationResults = new Map();
                paneManager.clearAll();

                // Load videos and create view objects (no grid cells needed - dockview creates them)
                const basePath = 'sample_session/';
                for (let i = 0; i < VIEW_NAMES.length; i++) {
                    const name = VIEW_NAMES[i];
                    const url = basePath + name + '.mp4';
                    showLoading('Loading ' + name + '.mp4...');

                    const decoder = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
                    await decoder.init(url);

                    const vw = decoder.videoTrack.video.width;
                    const vh = decoder.videoTrack.video.height;

                    const view = {
                        name: name,
                        decoder: decoder,
                        canvas: null,     // Will be created by VideoPaneRenderer
                        ctx: null,
                        overlayCanvas: null,
                        overlayCtx: null,
                        videoWidth: vw,
                        videoHeight: vh,
                        wrapper: null,
                    };

                    state.views.push(view);
                    state.videoFiles.push({
                        file: null,
                        name: name,
                        decoder: decoder,
                        videoWidth: vw,
                        videoHeight: vh,
                        frameCount: decoder.samples.length,
                        assignedCamera: name,
                        videoPath: name + '.mp4',
                    });

                    if (i === 0) {
                        state.totalFrames = decoder.samples.length;
                        state.fps = decoder.videoTrack.duration > 0
                            ? decoder.samples.length / (decoder.videoTrack.duration / decoder.videoTrack.timescale)
                            : 30;
                    }
                }

                showLoading('Generating demo data...');
                const numFrames = Math.min(state.totalFrames, 100);
                const demoResult = createDemoSession(numFrames);
                state.session = demoResult.session;
                if (state.sessions.indexOf(state.session) < 0) {
                    state.sessions.push(state.session);
                    state.activeSessionIdx = state.sessions.length - 1;
                }
                state.keypoints3d = demoResult.keypoints3d;

                // Triangulation is NOT run automatically — user must trigger it
                // after identity assignment via Edit > Triangulate

                // Populate view strip and auto-arrange in grid
                populateViewStrip();
                populateSessionStrip();
                paneManager.addAllViewsAsGrid();

                rebuildVideoController();
                setup3DViewport();
                updateInfoPanel();
                updateFpsDisplay();

                hideLoading();
                setStatus('Demo session loaded', 'success');
            } catch (err) {
                console.error('Demo load failed:', err);
                hideLoading();
                setStatus('Demo error: ' + err.message, 'error');
            }
        }

        // initVideos() removed — loadDemoSession() handles demo data with dockview

        // ============================================
        // Triangulation
        // ============================================

        function precomputeTriangulation() {
            if (!state.session) return;

            const cameras = state.session.cameras;

            for (const [frameIdx, frameGroups] of state.session.instanceGroups) {
                const frameResults = [];

                for (const group of frameGroups) {
                        const result = triangulateAndReproject(group, cameras);

                        // Store reprojections and observed points on the group for overlay rendering
                        group.reprojections = result.reprojections;
                        group.points3d = result.points3d;
                        storeReprojectedInstances(group, result, cameras);
                        group.observedPoints = {};
                        for (const cam of cameras) {
                            const inst = group.getInstance(cam.name);
                            if (inst) {
                                group.observedPoints[cam.name] = inst.points;
                            }
                        }

                    frameResults.push({
                        group: group,
                        points3d: result.points3d,
                        reprojections: result.reprojections,
                        errors: result.errors,
                        meanError: result.meanError,
                    });
                }

                state.triangulationResults.set(frameIdx, frameResults);
            }
        }

        /**
         * Re-triangulate a single instance group if it was previously triangulated.
         * Called automatically when a node is moved or nulled to keep reprojections in sync.
         */
        function reTriangulateGroup(instanceGroup) {
            if (!instanceGroup) return;
            if (!state.session || state.session.cameras.length < 2) return;

            var cameras = state.session.cameras;
            var groupCamNames = instanceGroup.cameraNames;
            var groupCameras = cameras.filter(function (c) { return groupCamNames.indexOf(c.name) >= 0; });
            if (groupCameras.length < 2) return;

            // Save old reprojections in case re-triangulation fails
            var oldReprojInstances = instanceGroup.reprojectedInstances
                ? new Map(instanceGroup.reprojectedInstances) : null;
            var oldReprojections = instanceGroup.reprojections;
            var oldPoints3d = instanceGroup.points3d;

            var result = triangulateAndReproject(instanceGroup, groupCameras);

            // Only update if we got valid results
            var validPts = result.points3d && result.points3d.some(function (p) { return p != null; });
            if (validPts) {
                instanceGroup.points3d = result.points3d;
                instanceGroup.reprojections = result.reprojections;
                storeReprojectedInstances(instanceGroup, result, cameras);
            } else {
                // Restore old data
                console.warn('[reTriangulate] Failed — keeping old reprojections');
                instanceGroup.points3d = oldPoints3d;
                instanceGroup.reprojections = oldReprojections;
                if (oldReprojInstances) instanceGroup.reprojectedInstances = oldReprojInstances;
            }
            instanceGroup.observedPoints = {};
            for (var ci = 0; ci < groupCameras.length; ci++) {
                var cam = groupCameras[ci];
                var inst = instanceGroup.getInstance(cam.name);
                if (inst) {
                    instanceGroup.observedPoints[cam.name] = inst.points;
                }
            }
            instanceGroup.markClean();

            // Update triangulation results for error display
            var frameIdx = state.currentFrame;
            var frameResults = state.triangulationResults.get(frameIdx) || [];
            var newEntry = { group: instanceGroup, points3d: result.points3d,
                reprojections: result.reprojections, errors: result.errors,
                meanError: result.meanError };
            var replaced = false;
            for (var ri = 0; ri < frameResults.length; ri++) {
                if (frameResults[ri].group === instanceGroup) {
                    frameResults[ri] = newEntry;
                    replaced = true;
                    break;
                }
            }
            if (!replaced) frameResults.push(newEntry);
            state.triangulationResults.set(frameIdx, frameResults);

            // Update 3D viewport
            if (viewport3d) {
                var groups = getInstanceGroupsForFrame(state.currentFrame);
                viewport3d.setFrame(groups);
            }
        }

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

        /**
         * On-demand triangulation for the current frame's selected instance group.
         * Re-triangulates from whatever views have labels and updates reprojections.
         */
        export function triangulateCurrentFrame() {
            if (!state.session) return;

            if (!sessionHasCalibration()) {
                showCalibrationRequiredPopup();
                return;
            }

            const frameIdx = state.currentFrame;
            const cameras = state.session.cameras;
            var session = state.session;
            var frameGroupsList = session.instanceGroups.get(frameIdx);

            // If no InstanceGroups exist but identities are assigned, create groups from identity buckets
            if ((!frameGroupsList || frameGroupsList.length === 0) && session.identities.length > 0) {
                var fg = session.getFrameGroup(frameIdx);
                if (fg) {
                    var idBuckets = {};
                    var allInstancesByCam = {};

                    // Collect from grouped instances
                    for (var [_cn, _insts] of fg.instances) {
                        for (var _i = 0; _i < _insts.length; _i++) {
                            var _inst = _insts[_i];
                            if (!allInstancesByCam[_cn]) allInstancesByCam[_cn] = [];
                            allInstancesByCam[_cn].push(_inst);
                            var _idId = session.getIdentityIdForTrack
                                ? session.getIdentityIdForTrack(_cn, _inst.trackIdx, frameIdx)
                                : session.trackIdentityMap.get(_cn + ':' + _inst.trackIdx);
                            if (_idId == null) continue;
                            if (!idBuckets[_idId]) idBuckets[_idId] = {};
                            if (!idBuckets[_idId][_cn]) idBuckets[_idId][_cn] = _inst;
                        }
                    }
                    // Collect from unlinked instances
                    for (var [_cn2, _ulList] of fg.unlinkedInstances) {
                        for (var _u = 0; _u < _ulList.length; _u++) {
                            var _ulInst = _ulList[_u].instance;
                            if (!allInstancesByCam[_cn2]) allInstancesByCam[_cn2] = [];
                            allInstancesByCam[_cn2].push(_ulInst);
                            var _idId2 = session.getIdentityIdForTrack
                                ? session.getIdentityIdForTrack(_cn2, _ulInst.trackIdx, frameIdx)
                                : session.trackIdentityMap.get(_cn2 + ':' + _ulInst.trackIdx);
                            if (_idId2 == null) continue;
                            if (!idBuckets[_idId2]) idBuckets[_idId2] = {};
                            if (!idBuckets[_idId2][_cn2]) idBuckets[_idId2][_cn2] = _ulInst;
                        }
                    }

                    // Clear and re-add instances as linked
                    session.instanceGroups.delete(frameIdx);
                    for (var _cn3 in allInstancesByCam) fg.instances.set(_cn3, []);
                    for (var _cn4 of fg.unlinkedInstances.keys()) fg.unlinkedInstances.set(_cn4, []);
                    for (var _cn5 in allInstancesByCam) {
                        for (var _ai = 0; _ai < allInstancesByCam[_cn5].length; _ai++) {
                            fg.addInstance(_cn5, allInstancesByCam[_cn5][_ai]);
                        }
                    }

                    // Create InstanceGroups from identity buckets
                    for (var _idStr in idBuckets) {
                        var _identityId = parseInt(_idStr);
                        var _bucket = idBuckets[_idStr];
                        var _camNames = Object.keys(_bucket);
                        if (_camNames.length < 2) continue;
                        var _group = new InstanceGroup(Date.now() + _identityId, _identityId);
                        for (var _ci = 0; _ci < _camNames.length; _ci++) {
                            _group.addInstance(_camNames[_ci], _bucket[_camNames[_ci]]);
                        }
                        _group.observedPoints = {};
                        for (var _ci2 = 0; _ci2 < _camNames.length; _ci2++) {
                            _group.observedPoints[_camNames[_ci2]] = _bucket[_camNames[_ci2]].points;
                        }
                        if (!session.instanceGroups.has(frameIdx)) {
                            session.instanceGroups.set(frameIdx, []);
                        }
                        session.instanceGroups.get(frameIdx).push(_group);
                    }
                    frameGroupsList = session.instanceGroups.get(frameIdx);
                    console.log('[triangulate] Auto-created', (frameGroupsList ? frameGroupsList.length : 0), 'groups from identity assignments');
                }
            }

            if (!frameGroupsList || frameGroupsList.length === 0) {
                console.warn('[triangulate] No instanceGroups for frame', frameIdx);
                setStatus('No instance groups on frame ' + (frameIdx + 1) + ' - assign instances to groups first (A key)', 'warning');
                updateTriangulationBadge('needs-triangulation', 'No groups');
                return;
            }

            markDirty();
            console.log('[triangulate] Frame', frameIdx, '| cameras:', cameras.map(c => c.name),
                '| views:', state.views.map(v => v.name));

            const frameResults = [];

            for (const group of frameGroupsList) {
                    // Resolve any camera name mismatches in this group
                    // (e.g., instances keyed by video name "CamA" but camera named "A")
                    const groupKeys = group.cameraNames;
                    for (const gk of groupKeys) {
                        if (!cameras.some(c => c.name === gk)) {
                            // This key doesn't match any camera - try to resolve
                            const gkLower = gk.toLowerCase();
                            for (const cam of cameras) {
                                const camLower = cam.name.toLowerCase();
                                if (gkLower === camLower || gkLower.indexOf(camLower) >= 0 || camLower.indexOf(gkLower) >= 0) {
                                    if (!group.getInstance(cam.name)) {
                                        const inst = group.getInstance(gk);
                                        group.instances.delete(gk);
                                        group.instances.set(cam.name, inst);
                                        console.log('[triangulate] Resolved instance key "' + gk + '" -> "' + cam.name + '"');
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    // Count how many views have at least one non-null point
                    let viewsWithLabels = 0;
                    const camStatus = {};
                    for (const cam of cameras) {
                        const inst = group.getInstance(cam.name);
                        if (inst && inst.points) {
                            const hasAny = inst.points.some((p, idx) => p != null && !(inst.nulledNodes && inst.nulledNodes.has(idx)));
                            if (hasAny) viewsWithLabels++;
                            camStatus[cam.name] = hasAny ? 'labeled' : 'empty';
                        } else {
                            camStatus[cam.name] = inst ? 'no-points' : 'missing';
                        }
                    }
                    console.log('[triangulate] Identity', group.identityId, '| views with labels:', viewsWithLabels,
                        '| cam status:', camStatus);

                    if (viewsWithLabels < 2) {
                        // Not enough views for triangulation
                        updateTriangulationBadge('needs-triangulation', viewsWithLabels + '/2+ views needed');
                        continue;
                    }

                    // Only use cameras that have instances in this group (assigned views)
                    const groupCamNames = group.cameraNames;
                    const groupCameras = cameras.filter(c => groupCamNames.indexOf(c.name) >= 0);

                    const result = triangulateAndReproject(group, groupCameras);

                    // Check for NaN in points3d
                    const hasNaN = result.points3d.some(p => p && (isNaN(p[0]) || isNaN(p[1]) || isNaN(p[2])));
                    const validPts = result.points3d.filter(p => p != null).length;
                    console.log('[triangulate] points3d:', validPts, 'valid /', result.points3d.length,
                        '| hasNaN:', hasNaN, '| meanError:', result.meanError,
                        '| cameras used:', groupCamNames,
                        '| sample:', result.points3d.find(p => p != null));
                    if (hasNaN) {
                        console.error('[triangulate] WARNING: NaN in 3D points! Check calibration matrices.');
                        for (const cam of groupCameras) {
                            console.log('[triangulate] Camera', cam.name, 'P=', cam.projectionMatrix);
                        }
                    }

                    // Log reprojections per camera
                    for (const cam of groupCameras) {
                        const reproj = result.reprojections[cam.name];
                        const validReproj = reproj ? reproj.filter(p => p != null).length : 0;
                        console.log('[triangulate] Reprojection', cam.name, ':', validReproj, 'pts',
                            '| sample:', reproj ? reproj.find(p => p != null) : null);
                    }

                    group.reprojections = result.reprojections;
                    group.points3d = result.points3d;
                    storeReprojectedInstances(group, result, cameras);
                    group.observedPoints = {};
                    group.usedCameras = new Set();
                    for (const cam of groupCameras) {
                        const inst = group.getInstance(cam.name);
                        if (inst) {
                            group.observedPoints[cam.name] = inst.points;
                            const hasAny = inst.points.some(function (p) { return p != null; });
                            if (hasAny) group.usedCameras.add(cam.name);
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
                }

            state.triangulationResults.set(frameIdx, frameResults);

            console.log('[triangulate] viewport3d exists:', !!viewport3d,
                '| frameResults:', frameResults.length,
                '| views:', state.views.map(v => v.name));

            // Log what each group has after triangulation
            for (const fr of frameResults) {
                console.log('[triangulate] Group result:',
                    '| cameras in group:', fr.group.cameraNames,
                    '| has reprojections:', Object.keys(fr.group.reprojections || {}),
                    '| points3d valid:', (fr.points3d || []).filter(p => p != null).length);
            }

            // Show reproj/error UI elements now that triangulation has been run
            setReprojErrorVisible(true);

            // Update displays
            drawAllOverlays(frameIdx);
            update3DViewport(frameIdx);

            // Re-fit the 3D camera so the new skeleton points are visible
            if (viewport3d && frameResults.length > 0) {
                viewport3d.fitToScene();
            }

            if (frameResults.length > 0 && frameResults[0].meanError != null) {
                updateTriangulationBadge('triangulated',
                    'Error: ' + frameResults[0].meanError.toFixed(2) + 'px');
                setStatus('Triangulated frame ' + (frameIdx + 1) + ' (' + frameResults.length + ' group(s), error: ' +
                    frameResults[0].meanError.toFixed(2) + 'px)', 'success');
            } else if (frameResults.length > 0) {
                updateTriangulationBadge('triangulated', 'Triangulated');
                setStatus('Triangulated frame ' + (frameIdx + 1) + ' (' + frameResults.length + ' group(s))', 'success');
            } else {
                updateTriangulationBadge('needs-triangulation', 'No groups triangulated');
                setStatus('No groups could be triangulated on frame ' + (frameIdx + 1) +
                    ' - check that instance groups have labels in 2+ camera views', 'warning');
            }

            // Update timeline: mark frame only if it has grouped UserInstances
            updateTimelineForFrame(frameIdx);
        }

        /**
         * Triangulate all frames in the session.
         * Uses the same logic as triangulateCurrentFrame but batched across all frames.
         */
        export async function triangulateAllFrames() {
            if (!state.session) {
                setStatus('No session loaded', 'warning');
                return;
            }
            if (!sessionHasCalibration()) {
                showCalibrationRequiredPopup();
                return;
            }

            var cameras = state.session.cameras;
            if (cameras.length < 2) {
                setStatus('Need at least 2 cameras for triangulation', 'warning');
                return;
            }

            var frameIndices = [];
            for (var [fIdx] of state.session.instanceGroups) {
                frameIndices.push(fIdx);
            }
            if (frameIndices.length === 0) {
                setStatus('No instance groups to triangulate', 'warning');
                return;
            }

            markDirty();
            showLoading('Triangulating ' + frameIndices.length + ' frames...');
            var totalTriangulated = 0;
            var totalGroups = 0;
            var totalErrors = [];
            var YIELD_EVERY = 100;

            for (var fi = 0; fi < frameIndices.length; fi++) {
                var frameIdx = frameIndices[fi];
                var frameGroupsList = state.session.instanceGroups.get(frameIdx);
                if (!frameGroupsList || frameGroupsList.length === 0) continue;

                var frameResults = [];

                for (var gi = 0; gi < frameGroupsList.length; gi++) {
                        var group = frameGroupsList[gi];

                        // Resolve camera name mismatches
                        var groupKeys = group.cameraNames;
                        for (var ki = 0; ki < groupKeys.length; ki++) {
                            var gk = groupKeys[ki];
                            if (!cameras.some(function (c) { return c.name === gk; })) {
                                var gkLower = gk.toLowerCase();
                                for (var ci = 0; ci < cameras.length; ci++) {
                                    var camLower = cameras[ci].name.toLowerCase();
                                    if (gkLower === camLower || gkLower.indexOf(camLower) >= 0 || camLower.indexOf(gkLower) >= 0) {
                                        if (!group.getInstance(cameras[ci].name)) {
                                            var inst = group.getInstance(gk);
                                            group.instances.delete(gk);
                                            group.instances.set(cameras[ci].name, inst);
                                            break;
                                        }
                                    }
                                }
                            }
                        }

                        // Count views with labels
                        var viewsWithLabels = 0;
                        for (var cj = 0; cj < cameras.length; cj++) {
                            var inst2 = group.getInstance(cameras[cj].name);
                            if (inst2 && inst2.points && inst2.points.some(function (p, idx) { return p != null && !(inst2.nulledNodes && inst2.nulledNodes.has(idx)); })) {
                                viewsWithLabels++;
                            }
                        }

                        if (viewsWithLabels < 2) continue;

                        // Only use cameras that have instances in this group (assigned views)
                        var groupCamNames2 = group.cameraNames;
                        var groupCameras2 = cameras.filter(function (c) { return groupCamNames2.indexOf(c.name) >= 0; });

                        var result = triangulateAndReproject(group, groupCameras2);

                        group.reprojections = result.reprojections;
                        group.points3d = result.points3d;
                        storeReprojectedInstances(group, result, cameras);
                        group.observedPoints = {};
                        group.usedCameras = new Set();
                        for (var ck = 0; ck < groupCameras2.length; ck++) {
                            var camInst = group.getInstance(groupCameras2[ck].name);
                            if (camInst) {
                                group.observedPoints[groupCameras2[ck].name] = camInst.points;
                                if (camInst.points.some(function (p) { return p != null; })) {
                                    group.usedCameras.add(groupCameras2[ck].name);
                                }
                            }
                        }

                        group.markClean();
                        totalGroups++;

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
                if (fi > 0 && fi % YIELD_EVERY === 0) {
                    showLoading('Triangulating... ' + fi + '/' + frameIndices.length + ' frames');
                    await new Promise(function (r) { setTimeout(r, 0); });
                }
            }

            // Show reproj/error UI elements
            setReprojErrorVisible(true);

            // Update display for current frame
            drawAllOverlays(state.currentFrame);
            update3DViewport(state.currentFrame);
            if (viewport3d) viewport3d.fitToScene();

            hideLoading();
            var avgError = totalErrors.length > 0
                ? (totalErrors.reduce(function (a, b) { return a + b; }, 0) / totalErrors.length).toFixed(2)
                : 'N/A';
            setStatus('Triangulated ' + totalTriangulated + ' frames (' + totalGroups + ' groups, avg error: ' + avgError + 'px)', 'success');
            console.log('[triangulate-all] Done:', totalTriangulated, 'frames,', totalGroups, 'groups, avg error:', avgError);

            // Update timeline: mark frames with grouped UserInstances, refresh track bars
            if (timeline) {
                for (var [fIdx] of state.triangulationResults) {
                    timeline.setFrameModified(fIdx, frameHasGroupedUserInstances(fIdx));
                }
                timeline.refreshTracks(state.session);
            }
        }

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

        // ============================================
        // Smart Instance Creation
        // ============================================

        /**
         * Record the most recent UserInstance points for a view.
         * Called whenever a UserInstance is created or modified so that
         * addNewInstanceSmart() can do an O(1) lookup instead of scanning frames.
         */
        function recordUserPoints(viewName, points) {
            if (!viewName || !points) return;
            state.lastUserPoints.set(viewName, points.map(function(p) {
                return p ? [p[0], p[1]] : null;
            }));
        }

        export function addNewInstanceSmart() {
            if (!interactionManager || !state.session) return;
            markDirty();
            var viewName = interactionManager.lastInteractedView || (state.views.length > 0 ? state.views[0].name : null);
            if (!viewName) return;
            var frameIdx = state.currentFrame;
            var cursorPos = interactionManager.lastCursorPos; // [vx, vy] or null
            var points = null;

            // Priority 1: Cached UserInstance points for this view
            var cached = state.lastUserPoints.get(viewName);
            if (!cached) {
                // Cache miss — scan current frame for an existing UserInstance in this view
                var scanGroups = getInstanceGroupsForFrame(frameIdx);
                for (var sg = 0; sg < scanGroups.length && !cached; sg++) {
                    var si = scanGroups[sg].getInstance(viewName);
                    if (si && si.type === 'user' && si.points) {
                        recordUserPoints(viewName, si.points);
                        cached = state.lastUserPoints.get(viewName);
                    }
                }
                if (!cached) {
                    var scanFg = state.session.getFrameGroup(frameIdx);
                    if (scanFg) {
                        var scanUl = scanFg.getUnlinkedInstances(viewName) || [];
                        for (var su = 0; su < scanUl.length && !cached; su++) {
                            if (scanUl[su].instance.type === 'user' && scanUl[su].instance.points) {
                                recordUserPoints(viewName, scanUl[su].instance.points);
                                cached = state.lastUserPoints.get(viewName);
                            }
                        }
                    }
                }
            }
            if (cached) {
                points = cached.map(function(p) { return p ? [p[0], p[1]] : null; });
            }

            // Priority 2: Nearest PredictedInstance to cursor (by centroid distance)
            if (!points) {
                var allPredicted = [];
                // Collect grouped predicted instances
                var curGroups = getInstanceGroupsForFrame(frameIdx);
                for (var g of curGroups) {
                    var inst = g.getInstance(viewName);
                    if (inst && inst.type === 'predicted' && inst.points) {
                        allPredicted.push(inst);
                    }
                }
                // Collect unlinked predicted instances
                var fg = state.session.getFrameGroup(frameIdx);
                if (fg) {
                    var unlinked = fg.getUnlinkedInstances(viewName) || [];
                    for (var ul of unlinked) {
                        if (ul.instance.type === 'predicted' && ul.instance.points) {
                            allPredicted.push(ul.instance);
                        }
                    }
                }
                if (allPredicted.length > 0) {
                    // Find the predicted instance whose centroid is closest to cursor
                    var bestPred = null;
                    var bestDist = Infinity;
                    for (var pi = 0; pi < allPredicted.length; pi++) {
                        var pred = allPredicted[pi];
                        // Compute centroid
                        var sx = 0, sy = 0, count = 0;
                        for (var ni = 0; ni < pred.points.length; ni++) {
                            if (pred.points[ni]) {
                                sx += pred.points[ni][0];
                                sy += pred.points[ni][1];
                                count++;
                            }
                        }
                        if (count === 0) continue;
                        var cx = sx / count, cy = sy / count;
                        if (cursorPos) {
                            var dx = cx - cursorPos[0], dy = cy - cursorPos[1];
                            var dist = Math.sqrt(dx * dx + dy * dy);
                            if (dist < bestDist) {
                                bestDist = dist;
                                bestPred = pred;
                            }
                        } else {
                            // No cursor — use first available
                            if (!bestPred) bestPred = pred;
                        }
                    }
                    if (bestPred) {
                        points = bestPred.points.map(function(p) { return p ? [p[0], p[1]] : null; });
                    }
                }
            }

            // Priority 3: Topology-based layout centered at cursor
            // _addNewInstance handles this when points is null, using cursorPos
            interactionManager._addNewInstance(points, cursorPos);
        }

        // ============================================
        // Interaction Manager Setup
        // ============================================

        export function setupInteraction() {
            setInteractionManager(new InteractionManager({
                getState: function () { return state; },

                getInstanceGroups: function (frameIdx) {
                    return getInstanceGroupsForFrame(frameIdx);
                },

                onSelectionChanged: function (selectedGroup, selectedNodeIdx) {
                    // Update status bar
                    if (selectedGroup) {
                        const trackName = (selectedGroup.identityId >= 0 && state.session.tracks[selectedGroup.identityId]) || ('Group ' + selectedGroup.identityId);
                        const identity = selectedGroup.identityId >= 0 ? state.session.getIdentity(selectedGroup.identityId) : null;
                        const identityLabel = identity ? ' [' + identity.name + ']' : '';
                        const nodeName = selectedNodeIdx >= 0 && state.session.skeleton.nodes[selectedNodeIdx]
                            ? state.session.skeleton.nodes[selectedNodeIdx]
                            : '';
                        document.getElementById('statusSelection').textContent =
                            'Selection: ' + trackName + identityLabel + (nodeName ? ' / ' + nodeName : '');
                        document.getElementById('selectedInfo').textContent =
                            trackName + identityLabel + ' (' + selectedGroup.cameraNames.length + ' views)' +
                            (nodeName ? ' - node: ' + nodeName : '');

                        // Update 3D viewport selection
                        if (viewport3d) {
                            const groups = getInstanceGroupsForFrame(state.currentFrame);
                            const idx = groups.indexOf(selectedGroup);
                            viewport3d.setSelectedInstance(idx >= 0 ? idx : null, groups);
                        }
                    } else {
                        document.getElementById('statusSelection').textContent = 'Selection: none';
                        document.getElementById('selectedInfo').textContent = 'None';
                        if (viewport3d) {
                            viewport3d.setSelectedInstance(null, getInstanceGroupsForFrame(state.currentFrame));
                        }
                    }

                    drawAllOverlays(state.currentFrame);
                },

                onNodeMoved: function (viewName, instanceGroup, nodeIdx, newPos) {
                    markDirty();
                    // Mark instance as modified
                    const inst = instanceGroup.getInstance(viewName);
                    if (inst) {
                        inst.modified = true;
                        recordUserPoints(viewName, inst.points);
                    }
                    instanceGroup.markDirty();

                    // Mark frame as modified in timeline
                    if (timeline) {
                        timeline.setFrameModified(state.currentFrame, true);
                    }

                    // Update 3D viewport
                    update3DViewport(state.currentFrame);

                    setStatus('Node moved in ' + viewName, 'success');
                },

                onUnlinkedNodeMoved: function (viewName, instance) {
                    markDirty();
                    if (instance && instance.points) {
                        recordUserPoints(viewName, instance.points);
                    }
                    if (timeline) {
                        timeline.setFrameModified(state.currentFrame, true);
                    }
                    setStatus('Node moved in ' + viewName, 'success');
                },

                onInstanceConverted: function (instanceGroup) {
                    const trackName = state.session.tracks[instanceGroup.trackIdx] || 'Track ' + instanceGroup.trackIdx;
                    setStatus('Converted ' + trackName + ' to user instance', 'success');
                    // Record all view points from the converted group
                    for (var [vn, inst] of instanceGroup.instances) {
                        if (inst.type === 'user' && inst.points) recordUserPoints(vn, inst.points);
                    }

                    if (timeline) {
                        timeline.setFrameModified(state.currentFrame, true);
                    }
                    drawAllOverlays(state.currentFrame);
                    updateInfoPanel();
                    update3DViewport(state.currentFrame);
                },

                onUserInstanceCreated: function (viewName, points) {
                    recordUserPoints(viewName, points);
                    // Refresh timeline track bars so the new user instance is
                    // visible immediately (Prompt 66: update bars in real time).
                    updateTimelineForFrame(state.currentFrame);
                },

                onDoubleClickReprojected: function (group, viewName) {
                    var frameIdx = state.currentFrame;
                    var identityId = group.identityId;
                    var trackName = state.session.tracks[identityId] || 'Track ' + identityId;

                    // Search all groups for an existing UserInstance group with this track
                    // Find the existing group for this track (user or predicted)
                    var existingGroup = null;
                    var allGroups = getInstanceGroupsForFrame(frameIdx);
                    for (var gi = 0; gi < allGroups.length; gi++) {
                        if (allGroups[gi].identityId === identityId) {
                            existingGroup = allGroups[gi];
                            break;
                        }
                    }

                    // Case 1: Group already has an instance in this view — select it
                    if (existingGroup && existingGroup.getInstance(viewName)) {
                        if (interactionManager) interactionManager.select(existingGroup, -1);
                        drawAllOverlays(frameIdx);
                        updateInfoPanel();
                        return;
                    }

                    // Get reprojected points to use as initial position
                    var reprojInst = group.getReprojectedInstance(viewName);
                    if (!reprojInst) return;
                    var clonedPoints = reprojInst.points.map(function(pt) {
                        return pt != null ? [pt[0], pt[1]] : null;
                    });

                    var fg = state.session.getFrameGroup(frameIdx);

                    console.log('[dblclick-reproj] existingGroup:', !!existingGroup,
                        '| group === existingGroup:', group === existingGroup,
                        '| identityId:', identityId, '| viewName:', viewName,
                        '| reprojInstances:', group.reprojectedInstances ? group.reprojectedInstances.size : 0);

                    if (existingGroup) {
                        // Case 2: Group exists but not in this view — add user instance to it
                        // Use the prediction's trackIdx so colors stay consistent
                        var srcTrackIdx = group.getInstance(viewName) ? group.getInstance(viewName).trackIdx : identityId;
                        var newInst = new Instance(clonedPoints, srcTrackIdx, 'user', 1.0);
                        newInst.modified = true;
                        existingGroup.addInstance(viewName, newInst);
                        if (fg) fg.addInstance(viewName, newInst);
                        recordUserPoints(viewName, clonedPoints);
                        existingGroup.markDirty();
                        group = existingGroup;
                        setStatus('Added UserInstance to ' + viewName + ' for ' + trackName, 'success');
                    } else {
                        // Case 3: No UserInstance group — create a new UserInstance group
                        // from all PredictedInstance views + clicked view.
                        // The original PredictedInstance group is left intact.
                        var predGroup = group;
                        var unlinkedList = [];
                        for (var [camName, inst] of predGroup.instances) {
                            if (inst.type === 'predicted') {
                                var userClone = new Instance(
                                    inst.points.map(function(pt) { return pt != null ? [pt[0], pt[1]] : null; }),
                                    inst.trackIdx, 'user', 1.0
                                );
                                userClone.modified = true;
                                recordUserPoints(camName, userClone.points);
                                var ul = state.session.addUnlinkedInstance(frameIdx, camName, userClone);
                                unlinkedList.push(ul);
                            }
                        }
                        // Add clicked view if not already a PredictedInstance view
                        if (!predGroup.getInstance(viewName)) {
                            // Use reprojected instance's source trackIdx if available
                            var clickTrackIdx = reprojInst.trackIdx != null ? reprojInst.trackIdx : identityId;
                            var newInst = new Instance(clonedPoints, clickTrackIdx, 'user', 1.0);
                            newInst.modified = true;
                            recordUserPoints(viewName, clonedPoints);
                            var ul = state.session.addUnlinkedInstance(frameIdx, viewName, newInst);
                            unlinkedList.push(ul);
                        }
                        if (unlinkedList.length > 0) {
                            group = state.session.createGroupFromUnlinked(frameIdx, unlinkedList, identityId);
                            // Transfer all reprojected instances from predicted group to new user group
                            // (kept until next re-triangulation replaces them)
                            if (predGroup.reprojectedInstances && predGroup.reprojectedInstances.size > 0) {
                                for (var [cn, ri] of predGroup.reprojectedInstances) {
                                    group.addReprojectedInstance(cn, ri);
                                }
                                predGroup.reprojectedInstances.clear();
                            }
                            group.reprojections = predGroup.reprojections || {};
                            group.points3d = predGroup.points3d;
                            group.observedPoints = predGroup.observedPoints;
                            predGroup.reprojections = null;
                            predGroup.points3d = null;
                        }
                        // Remove old predicted group's triangulation results
                        var oldFrameResults = state.triangulationResults.get(frameIdx);
                        if (oldFrameResults) {
                            state.triangulationResults.set(frameIdx,
                                oldFrameResults.filter(function(r) { return r.group !== predGroup; }));
                        }

                        setStatus('Created UserInstance group for ' + trackName, 'success');
                    }

                    // Don't re-triangulate automatically — keep old reprojections visible.
                    // User presses Triangulate (T) when ready to update.
                    group.markDirty();
                    setReprojErrorVisible(true);

                    if (interactionManager) interactionManager.select(group, -1);
                    if (timeline) timeline.setFrameModified(frameIdx, true);
                    drawAllOverlays(frameIdx);
                    updateInfoPanel();
                },

                onClonePredictedGroup: function (predGroup) {
                    var frameIdx = state.currentFrame;
                    var trackIdx = predGroup.identityId;
                    var trackName = (trackIdx >= 0 && state.session.tracks[trackIdx]) || ('Group ' + trackIdx);

                    // Convert predicted instances to user IN PLACE — no new group
                    // Fill null points from reprojection and mark as occluded
                    for (var [camName, inst] of predGroup.instances) {
                        var reprojInst = predGroup.getReprojectedInstance
                            ? predGroup.getReprojectedInstance(camName) : null;
                        var nulled = inst.nulledNodes || new Set();
                        // Centroid of visible points as fallback for missing nodes
                        var cx = 0, cy = 0, cCount = 0;
                        for (var ci = 0; ci < inst.points.length; ci++) {
                            if (inst.points[ci] != null) {
                                cx += inst.points[ci][0];
                                cy += inst.points[ci][1];
                                cCount++;
                            }
                        }
                        if (cCount > 0) { cx = Math.round(cx / cCount); cy = Math.round(cy / cCount); }
                        var nullTotal = 0, nullSeq = 0;
                        for (var nci = 0; nci < inst.points.length; nci++) {
                            if (inst.points[nci] == null) nullTotal++;
                        }
                        inst.points = inst.points.map(function (pt, idx) {
                            if (pt != null) return [pt[0], pt[1]];
                            if (reprojInst && reprojInst.points && reprojInst.points[idx] != null) {
                                nulled.add(idx);
                                return [reprojInst.points[idx][0], reprojInst.points[idx][1]];
                            }
                            if (cCount > 0) {
                                nulled.add(idx);
                                var angle = (2 * Math.PI * nullSeq) / Math.max(nullTotal, 1);
                                var spread = 20;
                                nullSeq++;
                                return [Math.round(cx + Math.cos(angle) * spread),
                                        Math.round(cy + Math.sin(angle) * spread)];
                            }
                            return null;
                        });
                        if (nulled.size > 0) inst.nulledNodes = nulled;
                        inst.type = 'user';
                        inst.modified = true;
                        recordUserPoints(camName, inst.points);
                    }
                    // Reprojections stay — they'll update on next triangulate
                    predGroup.markDirty();

                    if (interactionManager) interactionManager.select(predGroup, -1);
                    setStatus('Converted ' + trackName + ' to user labels', 'success');
                    if (timeline) timeline.setFrameModified(frameIdx, true);
                    drawAllOverlays(frameIdx);
                    updateInfoPanel();
                    update3DViewport(frameIdx);
                },

                onNodeSetNull: function (viewName, instanceGroup, nodeIdx) {
                    const inst = instanceGroup.getInstance(viewName);
                    const isNulled = inst && inst.nulledNodes && inst.nulledNodes.has(nodeIdx);
                    const nodeName = state.session.skeleton.nodes[nodeIdx] || 'node ' + nodeIdx;
                    setStatus((isNulled ? 'Nulled ' : 'Restored ') + nodeName + ' in ' + viewName);
                    instanceGroup.markDirty();

                    if (timeline) {
                        timeline.setFrameModified(state.currentFrame, true);
                    }
                },

                onInstanceDeleted: function (frameIdx, group, deletedViews) {
                    var trackName = group ? (state.session.tracks[group.identityId] || 'Track ' + group.identityId) : 'unlinked instance';
                    setStatus('Deleted ' + trackName, 'success');

                    // Clear per-view cache only for the views whose instance was deleted
                    if (deletedViews) {
                        for (var dvi = 0; dvi < deletedViews.length; dvi++) {
                            state.lastUserPoints.delete(deletedViews[dvi]);
                        }
                    }

                    // If the group was removed entirely (full delete or
                    // size===1 auto-ungroup), purge its reprojection state
                    // so the info panel and overlays don't keep showing
                    // orphaned data. Idempotent: safe when group is null
                    // or still in instanceGroups.
                    if (group) {
                        var stillThere = (state.session.instanceGroups.get(frameIdx) || []).indexOf(group) >= 0;
                        if (!stillThere) {
                            purgeTriangulationDataForGroup(frameIdx, group);
                        }
                    }

                    // Update timeline: clear tick if no grouped users remain, update track bars
                    updateTimelineForFrame(frameIdx);

                    // Update 3D viewport
                    if (viewport3d) {
                        const groups = getInstanceGroupsForFrame(frameIdx);
                        viewport3d.setFrame(groups);
                    }

                    // Refresh info panel
                    updateInfoPanel();
                },

                requestRedraw: function () {
                    drawAllOverlays(state.currentFrame);
                },

                onAssignmentSelectionChanged: function (count) {
                    updateInfoPanel();
                    if (!manualAssignState) return;
                    var textEl = document.getElementById('manualAssignToastText');
                    if (textEl) {
                        var totalUnlinked = getTotalUnlinkedCount();
                        textEl.textContent = 'Frame ' + (state.currentFrame + 1) +
                            '. Select instances for manual Identity Assignment. Instances Selected: ' +
                            count + '/' + totalUnlinked;
                    }
                },

                onAssignmentError: function (message) {
                    setStatus(message, 'error');
                },

                onAssignmentGroupCreated: function (group) {
                    cleanupManualAssignment();
                    var trackName = state.session.tracks[group.identityId] || 'Track ' + group.identityId;

                    // Auto-triangulate the new group
                    reTriangulateGroup(group);
                    setReprojErrorVisible(true);

                    setStatus('Created group: ' + trackName, 'success');
                    updateTimelineForFrame(state.currentFrame);
                    if (viewport3d) viewport3d.setFrame(getInstanceGroupsForFrame(state.currentFrame));
                    drawAllOverlays(state.currentFrame);
                    updateInfoPanel();
                },

                onAssignmentCancelled: function () {
                    cleanupManualAssignment();
                    drawAllOverlays(state.currentFrame);
                },

                onAssignmentRequested: function () {
                    startManualAssignment();
                },

                // Edit Group mode callbacks
                onEditGroupRemove: function (group, viewName) {
                    var frameIdx = state.currentFrame;
                    var fg = state.session.getFrameGroup(frameIdx);
                    var inst = group.getInstance(viewName);
                    if (!inst) return;

                    // Mixed group → promote a removed predicted to user.
                    // Detection happens BEFORE the removal so the removed
                    // instance still counts toward the mixed check, AND
                    // honors the edit-start mixed snapshot so the "mixed
                    // = user" rule survives intermediate removals that
                    // leave the group all-predicted.
                    var hasUser = false, hasPred = false;
                    for (var [, _gInst] of group.instances) {
                        if (_gInst.type === 'user') hasUser = true;
                        else if (_gInst.type === 'predicted') hasPred = true;
                    }
                    var srcMixed = (hasUser && hasPred) ||
                        !!(editGroupState && editGroupState.wasMixed);
                    if (srcMixed && inst.type === 'predicted') {
                        inst.type = 'user';
                        inst.modified = true;
                    }

                    // Remove from group
                    group.instances.delete(viewName);

                    // Keep observedPoints in sync so the reprojection error
                    // vector for this view stops drawing immediately.
                    if (group.observedPoints) {
                        delete group.observedPoints[viewName];
                    }

                    // Remove from FrameGroup linked instances
                    if (fg) {
                        var camInstances = fg.instances.get(viewName);
                        if (camInstances) {
                            var idx = camInstances.indexOf(inst);
                            if (idx >= 0) camInstances.splice(idx, 1);
                            if (camInstances.length === 0) fg.instances.delete(viewName);
                        }
                        // Add as unlinked
                        var ul = new UnlinkedInstance(inst, viewName);
                        fg.addUnlinkedInstance(viewName, ul);
                    }

                    updateEditGroupToast();
                    drawAllOverlays(frameIdx);
                    updateInfoPanel();
                },

                onEditGroupAdd: function (group, viewName, unlinkedInstance) {
                    var frameIdx = state.currentFrame;
                    var fg = state.session.getFrameGroup(frameIdx);
                    var inst = unlinkedInstance.instance;

                    // Add to group (keep instance's original trackIdx for color consistency)
                    group.addInstance(viewName, inst);

                    // Record the new instance's points as observed so the
                    // reprojection error vector connecting this view to its
                    // (existing) reprojected projection draws immediately.
                    group.observedPoints = group.observedPoints || {};
                    group.observedPoints[viewName] = inst.points;

                    // If the add introduces mixed state (e.g., a user added
                    // to an all-predicted group, or a predicted added to a
                    // group that already had a user), promote every
                    // predicted member to user so the group becomes
                    // uniformly user. Once mixed = user-typed.
                    if (typeof state.session._promoteIfMixed === 'function') {
                        var didPromote = state.session._promoteIfMixed(group);
                        if (didPromote && editGroupState) editGroupState.wasMixed = true;
                    }

                    // Remove from unlinked list in FrameGroup
                    if (fg) {
                        fg.removeUnlinkedById(unlinkedInstance.id);
                        fg.addInstance(viewName, inst);
                    }

                    updateEditGroupToast();
                    drawAllOverlays(frameIdx);
                    updateInfoPanel();
                },

                onEditGroupError: function (msg) {
                    setStatus(msg, 'error');
                },

                onEditGroupCancelled: function () {
                    cancelEditGroup();
                },

                onEditGroupFinished: function () {
                    finishEditGroup();
                },

                onDoubleClickEmpty: function (viewName) {
                    if (!videoController) return;
                    var view = state.views.find(function (v) { return v.name === viewName; });
                    if (view) {
                        videoController.resetZoom(view);
                    }
                },
            }));

            // Attach to all overlay canvases
            interactionManager.attach(state.views);
        }

        // ============================================
        // 3D Viewport Setup
        // ============================================

        export function setup3DViewport() {
            const container = document.getElementById('viewport3dCanvas');
            if (!container || !state.session) {
                console.warn('[3D] setup3DViewport: skipping -', !container ? 'no container' : 'no session');
                return;
            }

            // Make sure the viewport3d container is visible
            var vp3dContainer = document.getElementById('viewport3dContainer');
            if (vp3dContainer) {
                vp3dContainer.classList.remove('collapsed');
                vp3dContainer.style.display = '';
            }
            var vp3dMsg = document.getElementById('viewport3dMessage');
            if (vp3dMsg) vp3dMsg.classList.add('hidden');

            // Dispose old viewport to avoid orphaned renderers in the DOM
            if (viewport3d) {
                try { viewport3d.dispose(); } catch (e) { console.warn('[3D] dispose error:', e); }
                setViewport3D(null);
            }

            try {
                console.log('[3D] Creating Viewport3D with', state.session.cameras.length, 'cameras,',
                    'skeleton:', state.session.skeleton.nodes.length, 'nodes');

                var _3dLabel = document.getElementById('vis3dLabelSize');
                var _3dSphere = document.getElementById('vis3dSphereSize');
                var _3dPyramid = document.getElementById('vis3dPyramidLength');
                var _3dLabelShow = document.getElementById('vis3dLabelShow');
                var _3dSphereShow = document.getElementById('vis3dSphereShow');
                var _3dPyramidShow = document.getElementById('vis3dPyramidShow');
                setViewport3D(new Viewport3D(container, {
                    cameras: state.session.cameras,
                    skeleton: state.session.skeleton,
                    getTrackColor: getTrackColor,
                    getGroupColor: function (group) {
                        var useIdentity = state.colorByIdentity || false;
                        return getGroupColor(group, state.session, useIdentity, state.currentFrame);
                    },
                    onCameraClicked: highlightVideoCell,
                    cameraLabelSize: _3dLabel ? parseInt(_3dLabel.value) || 28 : 28,
                    cameraSphereSize: _3dSphere ? parseFloat(_3dSphere.value) || 3 : 3,
                    pyramidLength: _3dPyramid ? parseFloat(_3dPyramid.value) || 40 : 40,
                    showCameraLabels: _3dLabelShow ? _3dLabelShow.checked : true,
                    showCameraSpheres: _3dSphereShow ? _3dSphereShow.checked : true,
                    showCameraPyramids: _3dPyramidShow ? _3dPyramidShow.checked : true,
                    skeletonNodeSize: (function() { var e = document.getElementById('vis3dNodeSize'); return e ? parseFloat(e.value) || 2 : 2; })(),
                    skeletonEdgeWeight: (function() { var e = document.getElementById('vis3dEdgeWeight'); return e ? parseFloat(e.value) || 0.8 : 0.8; })(),
                    showSkeletonNodes: (function() { var e = document.getElementById('vis3dNodeShow'); return e ? e.checked : true; })(),
                    showSkeletonEdges: (function() { var e = document.getElementById('vis3dEdgeShow'); return e ? e.checked : true; })(),
                }));

                // Wire up "Show Camera View" button
                document.getElementById('btnShowCameraView').addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (viewport3d) viewport3d.showSelectedCameraView();
                });

                // Wire up "Show Initial View" button
                document.getElementById('btnShowInitialView').addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (viewport3d) viewport3d.showInitialView();
                });

                // Toggle "Show Initial View" button visibility
                viewport3d.onCameraViewChanged = function (viewing) {
                    document.getElementById('btnShowInitialView').style.display = viewing ? '' : 'none';
                };

                // Show initial frame's 3D points
                update3DViewport(state.currentFrame);

                // Fit after a short delay to ensure skeleton meshes are in the scene
                setTimeout(function () {
                    if (viewport3d) {
                        viewport3d.fitToScene();
                        console.log('[3D] fitToScene complete (deferred)');
                    }
                }, 200);
            } catch (err) {
                console.error('[3D] Failed to initialize 3D viewport:', err);
                // Hide the container if Three.js fails
                document.getElementById('viewport3dContainer').style.display = 'none';
            }
        }

        export function sessionHasCalibration() {
            if (!state.session || state.session.cameras.length === 0) return false;
            // Check if any camera has non-zero rotation or translation (real calibration)
            for (var ci = 0; ci < state.session.cameras.length; ci++) {
                var cam = state.session.cameras[ci];
                var r = cam.rotation || cam.rvec;
                var t = cam.translation || cam.tvec;
                if (r && (r[0] !== 0 || r[1] !== 0 || r[2] !== 0)) return true;
                if (t && (t[0] !== 0 || t[1] !== 0 || t[2] !== 0)) return true;
            }
            return false;
        }

        export function showCalibrationRequiredPopup() {
            var overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10000;display:flex;align-items:center;justify-content:center;';

            var card = document.createElement('div');
            card.style.cssText = 'background:var(--bg-secondary,#1e1e1e);border-radius:8px;padding:24px;max-width:420px;width:90%;text-align:center;';

            var icon = document.createElement('div');
            icon.style.cssText = 'font-size:36px;margin-bottom:12px;';
            icon.textContent = '\u26A0';
            card.appendChild(icon);

            var title = document.createElement('div');
            title.style.cssText = 'color:#fff;font-size:16px;font-weight:600;margin-bottom:8px;';
            title.textContent = 'Calibration Required';
            card.appendChild(title);

            var msg = document.createElement('div');
            msg.style.cssText = 'color:#aaa;font-size:13px;margin-bottom:16px;line-height:1.5;';
            msg.textContent = 'Triangulation, reprojection, and 3D features require a calibration file. Load a calibration.toml via File \u2192 Load Calibration or by loading a session folder that includes one.';
            card.appendChild(msg);

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

        export function update3DViewport(frameIdx) {
            if (!viewport3d) {
                if (state.session && sessionHasCalibration()) {
                    console.log('[3D] Auto-initializing 3D viewport');
                    setup3DViewport();
                }
                if (!viewport3d) {
                    console.warn('[3D] viewport3d still null after auto-init attempt');
                    return;
                }
            }
            const groups = getInstanceGroupsForFrame(frameIdx);
            const groupsWithPts = groups.filter(g => g.points3d && g.points3d.length > 0);
            console.log('[3D] update3DViewport frame', frameIdx,
                '| groups:', groups.length, '| with points3d:', groupsWithPts.length);
            if (groupsWithPts.length > 0) {
                var samplePt = groupsWithPts[0].points3d.find(function(p) { return p != null; });
                console.log('[3D] Sample 3D point:', samplePt);
            }
            viewport3d.setFrame(groups);
        }

        // ============================================
        // Timeline Setup
        // ============================================

        export function setupTimeline() {
            const container = document.getElementById('timelineContainer');
            if (!container) return;

            // If no session yet, use a compact initial height that does
            // not allocate space for non-existent track rows. Session load
            // will later grow this to fit actual tracks.
            if (!state.session && !container.style.height) {
                container.style.height = '96px';
            }

            setTimeline(new Timeline(container, {
                totalFrames: state.totalFrames,
                onFrameChange: (function () {
                    var lastRender = 0, timer = null, pending = null;
                    return function (frameIdx) {
                        if (!videoController) return;
                        if (state.isPlaying) videoController.stopPlayback();
                        pending = frameIdx;
                        var now = performance.now();
                        if (now - lastRender >= 100) {
                            lastRender = now;
                            if (timer) { clearTimeout(timer); timer = null; }
                            videoController.seekToFrame(frameIdx);
                        } else if (!timer) {
                            timer = setTimeout(function () {
                                timer = null;
                                lastRender = performance.now();
                                if (videoController && pending !== null) videoController.seekToFrame(pending);
                            }, 100 - (now - lastRender));
                        }
                    };
                })(),
                onDragEnd: function (frameIdx) {
                    if (videoController) videoController.seekToFrame(frameIdx);
                },
                onRangeSelect: function (startFrame, endFrame) {
                    setStatus('Selected range: ' + startFrame + '-' + endFrame);
                },
            }));

            // Populate with session data. When tracks are loaded, resize
            // the container to the preferred height so every track row is
            // visible without clipping, with a small gap below the lowest
            // row before the frame numbers.
            if (state.session) {
                timeline.setData(state.session);
                fitTimelineToData();
            }

            // Timeline display mode toggles
            var modeToggle = document.getElementById('timelineModeToggle');
            if (modeToggle) {
                modeToggle.querySelectorAll('.timeline-mode-btn').forEach(function (btn) {
                    btn.addEventListener('click', function () {
                        modeToggle.querySelectorAll('.timeline-mode-btn').forEach(function (b) { b.classList.remove('active'); });
                        btn.classList.add('active');
                        if (timeline) timeline.setDisplayMode(btn.getAttribute('data-mode'));
                    });
                });
            }
        }

        function highlightVideoCell(cameraName) {
            // Remove previous highlights
            document.querySelectorAll('.video-cell.camera-highlighted').forEach(function (el) {
                el.classList.remove('camera-highlighted');
            });
            if (!cameraName) return;
            // Add persistent highlight to matching cell(s) by data attribute
            var cells = document.querySelectorAll('.video-cell[data-view-name="' + cameraName + '"]');
            cells.forEach(function (cell) {
                cell.classList.add('camera-highlighted');
            });
        }

        // ============================================
        // Dockview Pane Manager
        // ============================================

        export const panelRenderers = new Map(); // panelId -> VideoPaneRenderer

        class VideoPaneRenderer {
            constructor() {
                this.element = document.createElement('div');
                this.element.className = 'video-cell';
                this.element.style.cssText = 'position:relative;width:100%;height:100%;';
                this.viewName = null;
                this.panelId = '';
                this._panelApi = null;
                this._zoomProxy = null;
                this._unzoomBtn = null;
            }

            init(params) {
                this.viewName = params.params?.viewName ?? null;
                this.panelId = params.api.id;
                this._panelApi = params.api;

                this.element.id = 'cell-' + this.panelId;
                this.element.setAttribute('data-view-name', this.viewName || '');

                var self = this;

                // Unzoom button (shown when view is zoomed)
                var unzoomBtn = document.createElement('button');
                unzoomBtn.className = 'unzoom-btn';
                unzoomBtn.textContent = 'Zoomed';
                unzoomBtn.title = 'Click to reset zoom';
                unzoomBtn.style.display = 'none';
                unzoomBtn.addEventListener('mouseenter', function () { unzoomBtn.textContent = 'Unzoom'; });
                unzoomBtn.addEventListener('mouseleave', function () { unzoomBtn.textContent = 'Zoomed'; });
                unzoomBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var view = state.views.find(function (v) { return v.name === self.viewName; });
                    if (view && videoController) {
                        videoController.resetZoom(view);
                    }
                });
                this.element.appendChild(unzoomBtn);
                this._unzoomBtn = unzoomBtn;

                // Canvas wrapper
                var view = state.views.find(function (v) { return v.name === self.viewName; });
                if (view) {
                    var wrapper = document.createElement('div');
                    wrapper.className = 'canvas-wrapper';

                    var canvas = document.createElement('canvas');
                    canvas.id = 'canvas-' + this.panelId;
                    canvas.width = view.videoWidth;
                    canvas.height = view.videoHeight;

                    var overlayCanvas = document.createElement('canvas');
                    overlayCanvas.className = 'overlay-canvas';
                    overlayCanvas.id = 'overlay-' + this.panelId;
                    overlayCanvas.width = view.videoWidth;
                    overlayCanvas.height = view.videoHeight;

                    wrapper.appendChild(canvas);
                    wrapper.appendChild(overlayCanvas);
                    this.element.appendChild(wrapper);

                    // Update view references
                    view.canvas = canvas;
                    view.ctx = canvas.getContext('2d');
                    view.overlayCanvas = overlayCanvas;
                    view.overlayCtx = overlayCanvas.getContext('2d');
                    view.wrapper = wrapper;
                }

                panelRenderers.set(this.panelId, this);
                cellResizeObserver.observe(this.element);
                requestAnimationFrame(function () { refreshPaneInteractions(); });
            }

            update(event) {
                if (event.params.viewName !== undefined && event.params.viewName !== this.viewName) {
                    this.viewName = event.params.viewName;
                    this.element.setAttribute('data-view-name', this.viewName);

                    var oldWrapper = this.element.querySelector('.canvas-wrapper');
                    if (oldWrapper) oldWrapper.remove();

                    var self = this;
                    var view = state.views.find(function (v) { return v.name === self.viewName; });
                    if (view) {
                        var wrapper = document.createElement('div');
                        wrapper.className = 'canvas-wrapper';
                        var canvas = document.createElement('canvas');
                        canvas.id = 'canvas-' + this.panelId;
                        canvas.width = view.videoWidth;
                        canvas.height = view.videoHeight;
                        var overlayCanvas = document.createElement('canvas');
                        overlayCanvas.className = 'overlay-canvas';
                        overlayCanvas.id = 'overlay-' + this.panelId;
                        overlayCanvas.width = view.videoWidth;
                        overlayCanvas.height = view.videoHeight;
                        wrapper.appendChild(canvas);
                        wrapper.appendChild(overlayCanvas);
                        this.element.appendChild(wrapper);
                        view.canvas = canvas;
                        view.ctx = canvas.getContext('2d');
                        view.overlayCanvas = overlayCanvas;
                        view.overlayCtx = overlayCanvas.getContext('2d');
                        view.wrapper = wrapper;
                    }
                    requestAnimationFrame(function () { refreshPaneInteractions(); });
                }
            }

            dispose() {
                panelRenderers.delete(this.panelId);
                requestAnimationFrame(function () { refreshPaneInteractions(); });
            }

            getViewName() {
                return this.viewName;
            }
        }

        function mapPositionToDirection(position) {
            if (position === 'left') return 'left';
            if (position === 'right') return 'right';
            if (position === 'top') return 'above';
            if (position === 'bottom') return 'below';
            return 'within';
        }

        function updateStripItemStatus(viewName, inDock) {
            var items = document.querySelectorAll('.view-strip-item[data-view-name="' + viewName + '"]');
            items.forEach(function (item) {
                var dot = item.querySelector('.strip-status');
                if (dot) {
                    dot.style.display = inDock ? '' : 'none';
                    dot.className = 'strip-status' + (inDock ? ' in-dock' : '');
                }
            });
        }

        const _paneManagerImpl = {
            dockview: null,
            api: null,
            panelCounter: 0,
            dockedViews: new Map(),

            init(container) {
                var theme = Object.assign({}, themeDark, {
                    name: 'mv-dark',
                    className: 'dockview-theme-abyss',
                });

                this.dockview = new DockviewComponent(container, {
                    theme: theme,
                    createComponent: function (_options) {
                        return new VideoPaneRenderer();
                    },
                    disableFloatingGroups: true,
                });
                this.api = this.dockview.api;

                var self = this;

                // Accept external drags from view strip
                this.api.onUnhandledDragOverEvent(function (event) {
                    if (event.nativeEvent.dataTransfer &&
                        event.nativeEvent.dataTransfer.types.includes('text/plain')) {
                        event.accept();
                    }
                });

                // Handle external drops
                this.api.onDidDrop(function (event) {
                    var raw = event.nativeEvent.dataTransfer
                        ? event.nativeEvent.dataTransfer.getData('text/plain')
                        : null;
                    if (!raw) return;
                    var names = parseDroppedViewNames(raw);
                    var direction = mapPositionToDirection(event.position);
                    var position;
                    if (event.group) {
                        position = { referenceGroup: event.group.id, direction: direction };
                    } else {
                        position = { direction: direction };
                    }
                    for (var di = 0; di < names.length; di++) {
                        self.addVideoPanel(names[di], di === 0 ? position : undefined);
                    }
                });

                // Track active panel — highlight selected video + camera in 3D
                this.api.onDidActivePanelChange(function (event) {
                    // Pause view correspondence during multi-selection
                    if (multiSelectViews && multiSelectViews.size > 0) return;

                    document.querySelectorAll('.video-cell.video-selected').forEach(function (el) {
                        el.classList.remove('video-selected');
                    });
                    var activeViewName = null;
                    if (event && event.id && !self._suppressActiveHighlight) {
                        var renderer = panelRenderers.get(event.id);
                        if (renderer && renderer.element) {
                            renderer.element.classList.add('video-selected');
                            activeViewName = renderer.getViewName();
                        }
                    }
                    // Highlight corresponding view strip item
                    document.querySelectorAll('.view-strip-item.strip-selected').forEach(function (el) {
                        el.classList.remove('strip-selected');
                    });
                    if (activeViewName) {
                        var stripItems = document.querySelectorAll('.view-strip-item');
                        stripItems.forEach(function (item) {
                            if (item.getAttribute('data-view-name') === activeViewName) {
                                item.classList.add('strip-selected');
                            }
                        });
                    }
                    // Update interaction manager so new instances are created on the selected view
                    if (activeViewName && interactionManager) {
                        interactionManager.lastInteractedView = activeViewName;
                    }
                    // Highlight corresponding camera in 3D viewer (skip during auto-assignment)
                    if (viewport3d && !autoAssignState) {
                        viewport3d.highlightCamera(activeViewName);
                        viewport3d.selectedCamera = activeViewName;
                    }
                });

                // Track panel removal
                this.api.onDidRemovePanel(function (event) {
                    var renderer = panelRenderers.get(event.id);
                    if (renderer) {
                        var viewName = renderer.getViewName();
                        if (viewName) {
                            var count = (self.dockedViews.get(viewName) || 1) - 1;
                            if (count <= 0) {
                                self.dockedViews.delete(viewName);
                                updateStripItemStatus(viewName, false);
                            } else {
                                self.dockedViews.set(viewName, count);
                            }
                        }
                    }
                    panelRenderers.delete(event.id);
                    if (self.api.panels.length === 0) {
                        var emptyMsg = document.getElementById('videoDockEmpty');
                        if (emptyMsg) emptyMsg.classList.remove('hidden');
                    }
                });
            },

            addVideoPanel(viewName, position) {
                // Prevent duplicate panels for the same view
                if (this.dockedViews.has(viewName) && this.dockedViews.get(viewName) > 0) {
                    // Already docked — activate the existing panel instead
                    if (this.api) {
                        var panels = Array.from(this.api.panels);
                        for (var pi = 0; pi < panels.length; pi++) {
                            var renderer = panelRenderers.get(panels[pi].id);
                            if (renderer && renderer.getViewName() === viewName) {
                                panels[pi].api.setActive();
                                return;
                            }
                        }
                    }
                    return;
                }
                var count = this.dockedViews.get(viewName) || 0;
                this.dockedViews.set(viewName, count + 1);
                this.panelCounter++;
                var id = 'video-' + viewName + '-' + this.panelCounter;

                this.api.addPanel({
                    id: id,
                    component: 'video-canvas',
                    title: viewName,
                    params: { viewName: viewName },
                    position: position,
                });

                var emptyMsg = document.getElementById('videoDockEmpty');
                if (emptyMsg) emptyMsg.classList.add('hidden');

                updateStripItemStatus(viewName, true);
            },

            addAllViews() {
                for (var i = 0; i < state.views.length; i++) {
                    this.addVideoPanel(state.views[i].name);
                }
            },

            /**
             * Add all views arranged in an optimal grid layout.
             * n<=3: 1 row. n<=8: 2 rows. n<=15: 3 rows.
             * Top row gets ceil(n/rows) items, remaining rows fill the rest.
             */
            addAllViewsAsGrid() {
                var views = state.views;
                var n = views.length;
                if (n === 0) return;

                // Calculate grid dimensions
                var rows, cols;
                if (n <= 3)       { rows = 1; }
                else if (n <= 8)  { rows = 2; }
                else              { rows = 3; }
                cols = Math.ceil(n / rows);

                // Build grid of view names (row-major, top row first)
                var grid = [];
                var idx = 0;
                for (var r = 0; r < rows; r++) {
                    grid[r] = [];
                    // Top row gets ceil(n/rows), remaining rows get the rest evenly
                    var rowCount = (r === 0) ? cols : Math.ceil((n - cols) / (rows - 1));
                    if (r === rows - 1) rowCount = n - idx; // last row gets remainder
                    for (var c = 0; c < rowCount && idx < n; c++) {
                        grid[r][c] = views[idx].name;
                        idx++;
                    }
                }

                // Track panel IDs for positioning
                var panelIds = []; // panelIds[r][c] = panel id string
                for (var r2 = 0; r2 < grid.length; r2++) {
                    panelIds[r2] = [];
                }

                var self = this;

                // Helper to add a single panel (bypasses duplicate check for grid init)
                function addGridPanel(viewName, position) {
                    self.dockedViews.set(viewName, (self.dockedViews.get(viewName) || 0) + 1);
                    self.panelCounter++;
                    var id = 'video-' + viewName + '-' + self.panelCounter;
                    self.api.addPanel({
                        id: id,
                        component: 'video-canvas',
                        title: viewName,
                        params: { viewName: viewName },
                        position: position,
                    });
                    var emptyMsg = document.getElementById('videoDockEmpty');
                    if (emptyMsg) emptyMsg.classList.add('hidden');
                    updateStripItemStatus(viewName, true);
                    return id;
                }

                // Add first row: left to right
                for (var c1 = 0; c1 < grid[0].length; c1++) {
                    if (c1 === 0) {
                        panelIds[0][0] = addGridPanel(grid[0][0]);
                    } else {
                        panelIds[0][c1] = addGridPanel(grid[0][c1], {
                            referencePanel: panelIds[0][c1 - 1],
                            direction: 'right',
                        });
                    }
                }

                // Add subsequent rows: below the corresponding column in the row above
                for (var r3 = 1; r3 < grid.length; r3++) {
                    for (var c3 = 0; c3 < grid[r3].length; c3++) {
                        // Reference the panel directly above
                        var refCol = Math.min(c3, panelIds[r3 - 1].length - 1);
                        panelIds[r3][c3] = addGridPanel(grid[r3][c3], {
                            referencePanel: panelIds[r3 - 1][refCol],
                            direction: 'below',
                        });
                    }
                }
            },

            clearAll() {
                var panels = this.api ? Array.from(this.api.panels) : [];
                for (var i = 0; i < panels.length; i++) {
                    panels[i].api.close();
                }
                this.dockedViews.clear();
                var emptyMsg = document.getElementById('videoDockEmpty');
                if (emptyMsg) emptyMsg.classList.remove('hidden');
            },
        };
        setPaneManager(_paneManagerImpl);

        export function refreshPaneInteractions() {
            // Re-attach interaction manager to current views after panel changes
            if (interactionManager && state.views.length > 0) {
                interactionManager.attach(state.views);
            }
            // Initialize zoom and set up handlers for each docked view
            // Only re-setup if the cell element changed (panel was recreated)
            if (videoController) {
                for (var i = 0; i < state.views.length; i++) {
                    var view = state.views[i];
                    if (view.canvas) {
                        videoController.initZoom(view);
                        var cell = view.canvas.closest('.video-cell');
                        if (cell && cell !== view._zoomCell) {
                            view._zoomCell = cell;
                            view._zoomSetup = true;
                            videoController.setupZoomHandlers(view, cell);
                        }
                    }
                }
            }
            // Render current frame to newly created canvases and fit sizes
            fitCanvasesToCells();
            if (videoController) {
                videoController.seekToFrame(state.currentFrame);
            }
            drawAllOverlays(state.currentFrame);
        }

        function renderDuplicatePanels() {
            var primaryCanvases = new Map();
            for (var i = 0; i < state.views.length; i++) {
                var view = state.views[i];
                if (view.canvas) primaryCanvases.set(view.name, view);
            }

            for (var entry of panelRenderers) {
                var panelId = entry[0];
                var renderer = entry[1];
                var viewName = renderer.getViewName();
                var primaryView = primaryCanvases.get(viewName);
                if (!primaryView || !primaryView.canvas) continue;

                var panelCanvas = renderer.element.querySelector('canvas:not(.overlay-canvas)');
                var panelOverlay = renderer.element.querySelector('.overlay-canvas');

                if (panelCanvas && panelCanvas !== primaryView.canvas) {
                    var ctx = panelCanvas.getContext('2d');
                    try { ctx.drawImage(primaryView.canvas, 0, 0, panelCanvas.width, panelCanvas.height); }
                    catch (e) { /* canvas not ready */ }
                }

                if (panelOverlay && primaryView.overlayCanvas && panelOverlay !== primaryView.overlayCanvas) {
                    var octx = panelOverlay.getContext('2d');
                    try { octx.drawImage(primaryView.overlayCanvas, 0, 0, panelOverlay.width, panelOverlay.height); }
                    catch (e) { /* canvas not ready */ }
                }
            }
        }

        // ============================================
        // View Strip
        // ============================================

        // Multi-selection state for view strip
        export var multiSelectViews = new Set();

        export function clearMultiSelect() {
            if (multiSelectViews.size === 0) return;
            multiSelectViews.clear();
            document.querySelectorAll('.view-strip-item.strip-multi-selected').forEach(function (el) {
                el.classList.remove('strip-multi-selected');
            });
        }

        function populateVideoBrightnessTable() {
            var container = document.getElementById('visVideoBrightnessTable');
            if (!container) return;
            container.innerHTML = '';
            for (var vi = 0; vi < state.views.length; vi++) {
                var view = state.views[vi];
                var row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;';

                var slider = document.createElement('input');
                slider.type = 'range';
                slider.min = '0';
                slider.max = '200';
                slider.value = view._brightness != null ? view._brightness : 100;
                slider.step = '1';
                slider.style.cssText = 'width:120px;flex-shrink:0;';
                slider.dataset.viewIdx = vi;

                var valLabel = document.createElement('span');
                valLabel.className = 'vis-val';
                valLabel.style.cssText = 'min-width:32px;text-align:right;flex-shrink:0;';
                valLabel.textContent = slider.value + '%';

                var camLabel = document.createElement('span');
                camLabel.style.cssText = 'color:var(--text-primary,#e0e0e0);white-space:nowrap;flex-shrink:0;';
                camLabel.textContent = view.name;

                // Video file name from videoFiles
                var videoName = '';
                for (var vfi = 0; vfi < state.videoFiles.length; vfi++) {
                    if (state.videoFiles[vfi].name === view.name) {
                        videoName = state.videoFiles[vfi].file ? state.videoFiles[vfi].file.name : '';
                        break;
                    }
                }
                var vidLabel = document.createElement('span');
                vidLabel.style.cssText = 'color:var(--text-muted,#888);font-size:10px;overflow-x:auto;white-space:nowrap;max-width:120px;';
                vidLabel.textContent = videoName;

                slider.addEventListener('input', (function(idx, vl) {
                    return function(e) {
                        var val = parseInt(e.target.value);
                        vl.textContent = val + '%';
                        var linked = document.getElementById('visVideoBrightnessLink');
                        if (linked && linked.checked) {
                            for (var i = 0; i < state.views.length; i++) {
                                state.views[i]._brightness = val;
                                applyVideoBrightness(state.views[i]);
                            }
                            var sliders = container.querySelectorAll('input[type=range]');
                            var vals = container.querySelectorAll('.vis-val');
                            sliders.forEach(function(s) { s.value = val; });
                            vals.forEach(function(v) { v.textContent = val + '%'; });
                        } else {
                            state.views[idx]._brightness = val;
                            applyVideoBrightness(state.views[idx]);
                        }
                    };
                })(vi, valLabel));

                row.appendChild(slider);
                row.appendChild(valLabel);
                row.appendChild(camLabel);
                row.appendChild(vidLabel);
                container.appendChild(row);
            }
        }

        function applyVideoBrightness(view) {
            if (!view.canvas) return;
            var brightness = view._brightness != null ? view._brightness : 100;
            view.canvas.style.filter = brightness === 100 ? '' : 'brightness(' + (brightness / 100) + ')';
        }

        export function clampRotation(deg) {
            deg = deg % 360;
            if (deg > 180) deg -= 360;
            if (deg < -179) deg += 360;
            return deg;
        }

        function populateVideoRotationTable() {
            var container = document.getElementById('visVideoRotationTable');
            if (!container) return;
            container.innerHTML = '';
            for (var vi = 0; vi < state.views.length; vi++) {
                var view = state.views[vi];
                var row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;';

                var slider = document.createElement('input');
                slider.type = 'range';
                slider.min = '-179';
                slider.max = '180';
                slider.value = Math.round(view.rotation || 0);
                slider.step = '1';
                slider.style.cssText = 'width:120px;flex-shrink:0;';
                slider.dataset.viewIdx = vi;

                var numInput = document.createElement('input');
                numInput.type = 'number';
                numInput.min = '-179';
                numInput.max = '180';
                numInput.step = '1';
                numInput.value = Math.round(view.rotation || 0);
                numInput.style.cssText = 'width:48px;flex-shrink:0;background:var(--bg-tertiary,#2a2a2a);color:var(--text-primary,#e0e0e0);border:1px solid var(--border-color,#444);border-radius:3px;font-size:11px;text-align:right;padding:2px 4px;-moz-appearance:textfield;';
                numInput.classList.add('no-spinner');
                numInput.dataset.viewIdx = vi;

                var camLabel = document.createElement('span');
                camLabel.style.cssText = 'color:var(--text-primary,#e0e0e0);white-space:nowrap;flex-shrink:0;';
                camLabel.textContent = view.name;

                var videoName = '';
                for (var vfi = 0; vfi < state.videoFiles.length; vfi++) {
                    if (state.videoFiles[vfi].name === view.name) {
                        videoName = state.videoFiles[vfi].file ? state.videoFiles[vfi].file.name : '';
                        break;
                    }
                }
                var vidLabel = document.createElement('span');
                vidLabel.style.cssText = 'color:var(--text-muted,#888);font-size:10px;overflow-x:auto;white-space:nowrap;max-width:120px;';
                vidLabel.textContent = videoName;

                (function(idx, sl, ni) {
                    function applyRotation(val) {
                        val = clampRotation(parseInt(val) || 0);
                        state.views[idx].rotation = val;
                        sl.value = val;
                        ni.value = val;
                        if (videoController) videoController.applyZoom(state.views[idx]);
                        drawAllOverlays(state.currentFrame);
                    }
                    sl.addEventListener('input', function() { applyRotation(sl.value); });
                    ni.addEventListener('change', function() { applyRotation(ni.value); });
                })(vi, slider, numInput);

                row.appendChild(slider);
                row.appendChild(numInput);
                row.appendChild(camLabel);
                row.appendChild(vidLabel);
                container.appendChild(row);
            }
        }

        export function syncRotationUI(view) {
            var container = document.getElementById('visVideoRotationTable');
            if (!container) return;
            var idx = state.views.indexOf(view);
            if (idx < 0) return;
            var val = Math.round(view.rotation || 0);
            var sliders = container.querySelectorAll('input[type=range]');
            var nums = container.querySelectorAll('input[type=number]');
            if (sliders[idx]) sliders[idx].value = val;
            if (nums[idx]) nums[idx].value = val;
        }

        export function populateViewStrip() {
            var list = document.getElementById('viewStripList');
            list.textContent = '';
            multiSelectViews.clear();

            for (var idx = 0; idx < state.views.length; idx++) {
                (function (view) {
                    var item = document.createElement('div');
                    item.className = 'view-strip-item';
                    item.setAttribute('data-view-name', view.name);
                    item.draggable = true;

                    var thumb = document.createElement('div');
                    thumb.className = 'strip-thumb';
                    var thumbCanvas = document.createElement('canvas');
                    thumbCanvas.width = 48;
                    thumbCanvas.height = 36;
                    thumb.appendChild(thumbCanvas);

                    var label = document.createElement('div');
                    label.className = 'strip-label';
                    label.textContent = view.name;

                    var status = document.createElement('div');
                    status.className = 'strip-status';
                    status.style.display = 'none';

                    item.appendChild(thumb);
                    item.appendChild(label);
                    item.appendChild(status);

                    item.addEventListener('dragstart', function (e) {
                        // If multi-selected, pack all selected view names; otherwise just this one
                        var names;
                        if (multiSelectViews.size > 0 && multiSelectViews.has(view.name)) {
                            names = Array.from(multiSelectViews);
                        } else {
                            names = [view.name];
                        }
                        e.dataTransfer.setData('text/plain', JSON.stringify(names));
                        e.dataTransfer.effectAllowed = 'move';
                        // Dim all dragged items
                        if (names.length > 1) {
                            document.querySelectorAll('.view-strip-item').forEach(function (el) {
                                if (names.indexOf(el.getAttribute('data-view-name')) >= 0) {
                                    el.classList.add('dragging');
                                }
                            });
                        } else {
                            item.classList.add('dragging');
                        }
                    });

                    item.addEventListener('dragend', function () {
                        document.querySelectorAll('.view-strip-item.dragging').forEach(function (el) {
                            el.classList.remove('dragging');
                        });
                    });

                    // Single click: Ctrl/Cmd+Click for multi-select, plain click for panel focus
                    item.addEventListener('click', function (e) {
                        if (e.ctrlKey || e.metaKey) {
                            // Toggle multi-selection
                            if (multiSelectViews.has(view.name)) {
                                multiSelectViews.delete(view.name);
                                item.classList.remove('strip-multi-selected');
                            } else {
                                // On first multi-select, hide yellow single-select highlight
                                if (multiSelectViews.size === 0) {
                                    document.querySelectorAll('.view-strip-item.strip-selected').forEach(function (el) {
                                        el.classList.remove('strip-selected');
                                    });
                                }
                                multiSelectViews.add(view.name);
                                item.classList.add('strip-multi-selected');
                            }
                            return;
                        }
                        // Plain click — clear multi-select and do normal panel focus
                        clearMultiSelect();
                        var count = paneManager.dockedViews.get(view.name) || 0;
                        if (count > 0 && paneManager.api) {
                            // Find and activate the first panel for this view
                            var panels = Array.from(paneManager.api.panels);
                            for (var pi = 0; pi < panels.length; pi++) {
                                var renderer = panelRenderers.get(panels[pi].id);
                                if (renderer && renderer.getViewName() === view.name) {
                                    panels[pi].api.setActive();
                                    return;
                                }
                            }
                        }
                    });

                    // Double click: only add to dock if NOT already loaded
                    item.addEventListener('dblclick', function () {
                        var count = paneManager.dockedViews.get(view.name) || 0;
                        if (count > 0 && paneManager.api) {
                            // Already in dock — select it instead
                            var panels = Array.from(paneManager.api.panels);
                            for (var pi = 0; pi < panels.length; pi++) {
                                var renderer = panelRenderers.get(panels[pi].id);
                                if (renderer && renderer.getViewName() === view.name) {
                                    panels[pi].api.setActive();
                                    return;
                                }
                            }
                        }
                        paneManager.addVideoPanel(view.name);
                    });

                    list.appendChild(item);

                    // Render first frame directly from decoder to thumbnail
                    if (view.decoder) {
                        view.decoder.getFrame(0).then(function (frame) {
                            if (frame && thumbCanvas) {
                                var ctx = thumbCanvas.getContext('2d');
                                ctx.drawImage(frame, 0, 0, thumbCanvas.width, thumbCanvas.height);
                            }
                        }).catch(function () { /* decoder not ready */ });
                    } else {
                        requestAnimationFrame(function () {
                            updateViewStripThumbnail(view, thumbCanvas);
                        });
                    }
                })(state.views[idx]);
            }
            populateVideoBrightnessTable();
            populateVideoRotationTable();
        }

        // ============================================
        // Sessions Info Panel
        // ============================================

        export function populateSessionsPanel() {
            var table = document.getElementById('sessionsTable');
            if (!table) return;
            var tbody = table.querySelector('tbody');
            var empty = document.getElementById('sessionsEmpty');
            tbody.textContent = '';

            if (state.sessions.length === 0) {
                table.style.display = 'none';
                if (empty) empty.style.display = '';
                return;
            }

            table.style.display = '';
            if (empty) empty.style.display = 'none';

            for (var si = 0; si < state.sessions.length; si++) {
                var session = state.sessions[si];
                var tr = document.createElement('tr');
                tr.style.cursor = 'pointer';
                if (si === state.activeSessionIdx) tr.style.background = 'var(--accent-dim)';

                var tdName = document.createElement('td');
                tdName.textContent = session.name;
                tdName.style.fontWeight = si === state.activeSessionIdx ? '600' : 'normal';

                var tdCams = document.createElement('td');
                tdCams.className = 'mono';
                var numCams = session.cameras ? session.cameras.length : 0;
                var numVids = session.videoFileIndices ? session.videoFileIndices.length : 0;
                tdCams.textContent = numCams;
                tdCams.title = numVids + ' video(s) loaded';

                var tdFrames = document.createElement('td');
                tdFrames.className = 'mono';
                tdFrames.textContent = session.numFrames || 0;

                var tdTracks = document.createElement('td');
                tdTracks.className = 'mono';
                tdTracks.textContent = session.tracks ? session.tracks.length : 0;

                var tdActions = document.createElement('td');
                tdActions.style.padding = '0';
                if (state.sessions.length > 1) {
                    var delBtn = document.createElement('button');
                    delBtn.textContent = '\u00d7';
                    delBtn.style.cssText = 'background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:14px;padding:2px 4px;line-height:1;';
                    delBtn.title = 'Delete session';
                    (function(idx) {
                        delBtn.addEventListener('click', function(e) {
                            e.stopPropagation();
                            removeSession(idx);
                        });
                    })(si);
                    tdActions.appendChild(delBtn);
                }

                (function(idx, row) {
                    row.addEventListener('click', function() { switchSession(idx); });
                    row.addEventListener('dblclick', function(e) {
                        e.stopPropagation();
                        var newName = prompt('Rename session:', state.sessions[idx].name);
                        if (newName && newName.trim()) {
                            state.sessions[idx].name = newName.trim();
                            populateSessionsPanel();
                            populateSessionStrip();
                        }
                    });
                    // Drop zone for video-to-session drag
                    row.addEventListener('dragenter', function(e) {
                        if (idx !== state.activeSessionIdx) {
                            e.preventDefault();
                        }
                    });
                    row.addEventListener('dragover', function(e) {
                        if (idx !== state.activeSessionIdx) {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            row.style.outline = '2px solid var(--accent,#4a9eff)';
                        }
                    });
                    row.addEventListener('dragleave', function() {
                        row.style.outline = '';
                    });
                    row.addEventListener('drop', function(e) {
                        e.preventDefault();
                        row.style.outline = '';
                        var raw = e.dataTransfer.getData('text/plain');
                        if (raw && idx !== state.activeSessionIdx) {
                            var viewNames = parseDroppedViewNames(raw);
                            showMoveVideoModal(viewNames, state.activeSessionIdx, idx);
                        }
                    });
                })(si, tr);

                tr.appendChild(tdName);
                tr.appendChild(tdCams);
                tr.appendChild(tdFrames);
                tr.appendChild(tdTracks);
                tr.appendChild(tdActions);
                tbody.appendChild(tr);
            }
        }

        // ============================================
        // Session Strip
        // ============================================

        export function populateSessionStrip() {
            var list = document.getElementById('sessionStripList');
            list.textContent = '';

            for (var si = 0; si < state.sessions.length; si++) {
                var session = state.sessions[si];
                var item = document.createElement('div');
                item.className = 'session-strip-item' + (si === state.activeSessionIdx ? ' active' : '');
                item.title = session.name;
                item.dataset.sessionIdx = si;

                var icon = document.createElement('div');
                icon.className = 'session-strip-icon';
                var numCams = session.cameras ? session.cameras.length : 0;
                for (var ci = 0; ci < numCams; ci++) {
                    var dot = document.createElement('div');
                    dot.className = 'cam-dot';
                    icon.appendChild(dot);
                }
                item.appendChild(icon);

                var label = document.createElement('div');
                label.className = 'session-strip-label';
                label.textContent = session.name;
                item.appendChild(label);

                (function(idx, el) {
                    el.addEventListener('click', function() {
                        switchSession(idx);
                    });
                    el.addEventListener('dblclick', function(e) {
                        e.stopPropagation();
                        var newName = prompt('Rename session:', state.sessions[idx].name);
                        if (newName && newName.trim()) {
                            state.sessions[idx].name = newName.trim();
                            populateSessionStrip();
                        }
                    });
                    // Drop zone for video-to-session drag
                    el.addEventListener('dragenter', function(e) {
                        if (idx !== state.activeSessionIdx) {
                            e.preventDefault();
                        }
                    });
                    el.addEventListener('dragover', function(e) {
                        if (idx !== state.activeSessionIdx) {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            el.style.outline = '2px solid var(--accent,#4a9eff)';
                        }
                    });
                    el.addEventListener('dragleave', function() {
                        el.style.outline = '';
                    });
                    el.addEventListener('drop', function(e) {
                        e.preventDefault();
                        el.style.outline = '';
                        var raw = e.dataTransfer.getData('text/plain');
                        if (raw && idx !== state.activeSessionIdx) {
                            var viewNames = parseDroppedViewNames(raw);
                            showMoveVideoModal(viewNames, state.activeSessionIdx, idx);
                        }
                    });
                })(si, item);

                list.appendChild(item);
            }
        }

        // Parse dropped view names — handles both JSON array and plain string (legacy)
        function parseDroppedViewNames(raw) {
            try {
                var parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) return parsed;
            } catch (e) { /* not JSON */ }
            return [raw];
        }

        var skipMoveConfirmation = false;

        export function showMoveVideoModal(viewNames, fromIdx, toIdx) {
            var fromSession = state.sessions[fromIdx];
            var toSession = state.sessions[toIdx];

            // Resolve file info for each view (only search within origin session's indices)
            var videoInfos = [];
            for (var vi = 0; vi < viewNames.length; vi++) {
                var vn = viewNames[vi];
                var vfInfo = null;
                for (var fii = 0; fii < fromSession.videoFileIndices.length; fii++) {
                    var vf = state.videoFiles[fromSession.videoFileIndices[fii]];
                    if (vf && (vf.assignedCamera === vn || vf.name === vn)) {
                        vfInfo = vf; break;
                    }
                }
                var fileName = vfInfo ? (vfInfo.file ? vfInfo.file.name : vfInfo.name) : vn;
                videoInfos.push({ viewName: vn, fileName: fileName, checked: true });
            }

            // Skip modal if user opted out
            if (skipMoveConfirmation) {
                var checkedNames = viewNames.slice();
                moveVideosToSession(checkedNames, fromIdx, toIdx);
                return Promise.resolve();
            }

            return new Promise(function (resolve) {
                var overlay = document.createElement('div');
                overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10000;display:flex;align-items:center;justify-content:center;';

                var card = document.createElement('div');
                card.style.cssText = 'background:var(--bg-secondary,#1e1e1e);border-radius:8px;padding:24px;max-width:500px;width:90%;';

                // Title
                var title = document.createElement('div');
                title.style.cssText = 'color:#fff;font-size:16px;font-weight:600;margin-bottom:14px;';
                title.textContent = 'Move Videos to Another Session';
                card.appendChild(title);

                // Header: From / To
                var header = document.createElement('div');
                header.style.cssText = 'color:#ccc;font-size:15px;margin-bottom:12px;line-height:1.7;';
                header.innerHTML =
                    '<b>From:</b> ' + fromSession.name + '<br>' +
                    '<b>To:</b> ' + toSession.name;
                card.appendChild(header);

                // Video table
                var tableContainer = document.createElement('div');
                tableContainer.className = 'slp-export-table-container';
                tableContainer.style.maxHeight = '200px';

                var table = document.createElement('table');
                table.className = 'data-table slp-export-table';
                table.style.width = '100%';

                var thead = document.createElement('thead');
                var headRow = document.createElement('tr');
                var thCheck = document.createElement('th');
                thCheck.style.width = '28px';
                thCheck.textContent = '';
                var thFile = document.createElement('th');
                thFile.textContent = 'Video';
                var thCam = document.createElement('th');
                thCam.textContent = 'Camera';
                headRow.appendChild(thCheck);
                headRow.appendChild(thFile);
                headRow.appendChild(thCam);
                thead.appendChild(headRow);
                table.appendChild(thead);

                var tbody = document.createElement('tbody');
                var checkboxes = [];
                for (var ri = 0; ri < videoInfos.length; ri++) {
                    (function (info, idx) {
                        var tr = document.createElement('tr');
                        var tdCheck = document.createElement('td');
                        tdCheck.style.textAlign = 'center';
                        var cb = document.createElement('input');
                        cb.type = 'checkbox';
                        cb.checked = true;
                        cb.addEventListener('change', function () {
                            info.checked = cb.checked;
                            updateContinueBtn();
                        });
                        checkboxes.push(cb);
                        tdCheck.appendChild(cb);

                        var tdFile = document.createElement('td');
                        tdFile.textContent = info.fileName;
                        var tdCam = document.createElement('td');
                        tdCam.textContent = info.viewName !== info.fileName ? info.viewName : '';
                        tdCam.style.color = 'var(--text-muted,#888)';

                        tr.appendChild(tdCheck);
                        tr.appendChild(tdFile);
                        tr.appendChild(tdCam);
                        tbody.appendChild(tr);
                    })(videoInfos[ri], ri);
                }
                table.appendChild(tbody);
                tableContainer.appendChild(table);
                card.appendChild(tableContainer);

                // Warning banner
                var warning = document.createElement('div');
                warning.style.cssText = 'font-size:12px;margin:12px 0;padding:8px 10px;background:rgba(255,255,255,0.03);border-radius:4px;line-height:1.7;';
                warning.innerHTML =
                    '<span style="color:#5cb85c;">\u2705 Transferred:</span> <span style="color:#ccc;">UserInstances, track data</span><br>' +
                    '<span style="color:#d9534f;">\u274C Lost:</span> <span style="color:#ccc;">Group assignments, triangulation, reprojections involving ' +
                    (viewNames.length > 1 ? 'these views' : 'this view') + '</span>';
                card.appendChild(warning);

                // Don't show again checkbox
                var hideRow = document.createElement('label');
                hideRow.style.cssText = 'display:flex;align-items:center;gap:6px;color:var(--text-muted,#888);font-size:12px;margin:8px 0 4px;cursor:pointer;';
                var hideCb = document.createElement('input');
                hideCb.type = 'checkbox';
                hideRow.appendChild(hideCb);
                hideRow.appendChild(document.createTextNode("Don't show this message again"));
                card.appendChild(hideRow);

                // Buttons
                var btnRow = document.createElement('div');
                btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;';

                var cancelBtn = document.createElement('button');
                cancelBtn.style.cssText = 'padding:8px 20px;font-size:13px;font-weight:600;cursor:pointer;background:var(--bg-tertiary,#2a2a2a);color:var(--text-primary,#e0e0e0);border:1px solid var(--border-color,#444);border-radius:6px;';
                cancelBtn.textContent = 'Cancel';

                var continueBtn = document.createElement('button');
                continueBtn.style.cssText = 'padding:8px 20px;font-size:13px;font-weight:600;cursor:pointer;background:var(--accent,#4a9eff);color:#fff;border:none;border-radius:6px;';
                continueBtn.textContent = 'Continue';

                function updateContinueBtn() {
                    var anyChecked = videoInfos.some(function (v) { return v.checked; });
                    continueBtn.disabled = !anyChecked;
                    continueBtn.style.opacity = anyChecked ? '1' : '0.4';
                }

                function dismiss(proceed) {
                    overlay.remove();
                    document.removeEventListener('keydown', onKey);
                    if (proceed) {
                        if (hideCb.checked) skipMoveConfirmation = true;
                        var checkedNames = [];
                        for (var ci = 0; ci < videoInfos.length; ci++) {
                            if (videoInfos[ci].checked) checkedNames.push(videoInfos[ci].viewName);
                        }
                        if (checkedNames.length > 0) {
                            moveVideosToSession(checkedNames, fromIdx, toIdx);
                        }
                    }
                    resolve();
                }
                cancelBtn.addEventListener('click', function () { dismiss(false); });
                continueBtn.addEventListener('click', function () { dismiss(true); });
                function onKey(e) {
                    if (e.key === 'Escape') { e.preventDefault(); dismiss(false); }
                    if (e.key === 'Enter') { e.preventDefault(); dismiss(true); }
                }
                document.addEventListener('keydown', onKey);

                btnRow.appendChild(cancelBtn);
                btnRow.appendChild(continueBtn);
                card.appendChild(btnRow);
                overlay.appendChild(card);
                document.body.appendChild(overlay);
            });
        }

        function moveVideosToSession(viewNames, fromIdx, toIdx) {
            var fromSession = state.sessions[fromIdx];
            var toSession = state.sessions[toIdx];
            var totalRetriangulated = 0;

            var originHasCalib = fromSession.cameras.some(function (c) {
                var r = c.rotation || c.rvec;
                var t = c.translation || c.tvec;
                return (r && (r[0] !== 0 || r[1] !== 0 || r[2] !== 0)) ||
                       (t && (t[0] !== 0 || t[1] !== 0 || t[2] !== 0));
            });

            for (var vni = 0; vni < viewNames.length; vni++) {
                var viewName = viewNames[vni];

                // 1. Transfer instances for this view
                for (var [frameIdx, fg] of fromSession.frameGroups) {
                    var camInstances = fg.instances.get(viewName) || [];
                    var ulInstances = fg.getUnlinkedInstances(viewName) || [];

                    if (camInstances.length > 0 || ulInstances.length > 0) {
                        if (!toSession.frameGroups.has(frameIdx)) {
                            toSession.addFrameGroup(new FrameGroup(frameIdx));
                        }
                        var destFg = toSession.getFrameGroup(frameIdx);

                        for (var ci = 0; ci < camInstances.length; ci++) {
                            destFg.addUnlinkedInstance(viewName, new UnlinkedInstance(camInstances[ci], viewName));
                        }
                        for (var ui = 0; ui < ulInstances.length; ui++) {
                            destFg.addUnlinkedInstance(viewName, ulInstances[ui]);
                        }
                    }

                    fg.instances.delete(viewName);
                    if (fg.unlinkedInstances) fg.unlinkedInstances.delete(viewName);
                }

                // 2. Remove view from InstanceGroups and re-triangulate
                for (var [frameIdx2, groups] of fromSession.instanceGroups) {
                    for (var gi = 0; gi < groups.length; gi++) {
                        var group = groups[gi];
                        if (group.instances.has(viewName) || group.reprojectedInstances.has(viewName)) {
                            group.instances.delete(viewName);
                            group.reprojectedInstances.delete(viewName);

                            if (group.cameraNames.length >= 2) {
                                var groupCameras = fromSession.cameras.filter(function (c) {
                                    return group.cameraNames.indexOf(c.name) >= 0;
                                });
                                if (groupCameras.length >= 2) {
                                    var result = triangulateAndReproject(group, groupCameras);
                                    var valid = result.points3d && result.points3d.some(function (p) { return p != null; });
                                    if (valid) {
                                        group.points3d = result.points3d;
                                        group.reprojections = result.reprojections;
                                        storeReprojectedInstances(group, result, fromSession.cameras);
                                    }
                                    group.markClean();
                                    totalRetriangulated++;
                                }
                            } else if (group.cameraNames.length < 2) {
                                group.points3d = null;
                                group.reprojections = null;
                                group.reprojectedInstances.clear();
                            }
                        }
                    }
                }

                // 3. Move video file reference (only search within origin session's indices)
                for (var fii = 0; fii < fromSession.videoFileIndices.length; fii++) {
                    var vfi = fromSession.videoFileIndices[fii];
                    var vf = state.videoFiles[vfi];
                    if (vf && (vf.assignedCamera === viewName || vf.name === viewName)) {
                        vf.sessionIdx = toIdx;
                        fromSession.videoFileIndices.splice(fii, 1);
                        if (toSession.videoFileIndices.indexOf(vfi) < 0) {
                            toSession.videoFileIndices.push(vfi);
                        }
                        break;
                    }
                }

                // 3b. Remove camera if uncalibrated
                if (!originHasCalib) {
                    fromSession.cameras = fromSession.cameras.filter(function (c) { return c.name !== viewName; });
                }

                // 3c. Ensure destination has a camera entry
                if (!toSession.cameras.some(function (c) { return c.name === viewName; })) {
                    var origCam = null;
                    if (originHasCalib) {
                        for (var cci = 0; cci < state.session.cameras.length; cci++) {
                            if (state.session.cameras[cci].name === viewName) { origCam = state.session.cameras[cci]; break; }
                        }
                    }
                    if (origCam) {
                        toSession.cameras.push(origCam);
                    } else {
                        toSession.cameras.push(new Camera(viewName, [[1,0,0],[0,1,0],[0,0,1]],
                            [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]));
                    }
                }
            }

            // 4. Remove moved views and rebuild UI
            var movedSet = {};
            for (var ms = 0; ms < viewNames.length; ms++) movedSet[viewNames[ms]] = true;
            state.views = state.views.filter(function (v) { return !movedSet[v.name]; });
            paneManager.clearAll();
            if (state.views.length > 0) {
                paneManager._suppressActiveHighlight = true;
                paneManager.addAllViewsAsGrid();
                paneManager._suppressActiveHighlight = false;
            }
            populateViewStrip();
            populateSessionStrip();
            rebuildVideoController();
            fitCanvasesToCells();
            if (interactionManager) {
                interactionManager.detach();
                if (state.views.length > 0) interactionManager.attach(state.views);
            }

            // 5. Update 3D viewport
            if (viewport3d && sessionHasCalibration()) {
                var noVideoCams = [];
                var activeViewNames = state.views.map(function (v) { return v.name; });
                for (var nvi = 0; nvi < state.session.cameras.length; nvi++) {
                    if (activeViewNames.indexOf(state.session.cameras[nvi].name) < 0) {
                        noVideoCams.push(state.session.cameras[nvi].name);
                    }
                }
                viewport3d.setMissingVideoCameras(noVideoCams);
            }

            // Clear destination's cached views so they rebuild on switch
            toSession._views = null;

            // Clear multi-selection
            clearMultiSelect();

            drawAllOverlays(state.currentFrame);
            updateInfoPanel();
            if (timeline) timeline.refreshTracks(fromSession);

            var label = viewNames.length > 1
                ? 'Moved ' + viewNames.length + ' videos to ' + toSession.name
                : 'Moved ' + viewNames[0] + ' to ' + toSession.name;
            setStatus(label + (totalRetriangulated > 0 ? '. Re-triangulated ' + totalRetriangulated + ' group(s).' : '.'), 'success');
        }

        export function removeSession(idx) {
            if (!confirm('Delete session "' + state.sessions[idx].name + '"?')) return;

            // Clean up lazy loader if present
            var sess = state.sessions[idx];
            if (sess.lazyLoader) {
                sess.lazyLoader.close();
            }

            // Clean up session's video file entries
            if (sess.videoFileIndices) {
                for (var vi = 0; vi < sess.videoFileIndices.length; vi++) {
                    var vfIdx = sess.videoFileIndices[vi];
                    if (state.videoFiles[vfIdx]) {
                        state.videoFiles[vfIdx].sessionIdx = -1;
                    }
                }
            }

            if (sess.triangulationResults) {
                sess.triangulationResults.clear();
            }

            state.sessions.splice(idx, 1);

            if (state.sessions.length === 0) {
                // Last session removed — full reset to fresh state
                state.session = null;
                state.activeSessionIdx = 0;
                state.triangulationResults = new Map();
                state.views = [];
                state.videoFiles = [];
                state.keypoints3d = null;
                state.lastUserPoints = new Map();
                state.currentFrame = 0;
                state.totalFrames = 0;
                if (videoController) {
                    if (state.isPlaying) videoController.stopPlayback();
                    setVideoController(null);
                }
                paneManager.clearAll();
                if (interactionManager) interactionManager.detach();

                // Clear all UI
                populateViewStrip();
                populateSessionStrip();
                populateSessionsPanel();
                updateInfoPanel();
                setReprojErrorVisible(false);

                // Reset timeline
                if (timeline) {
                    timeline.setData(null);
                    timeline.setTotalFrames(0);
                }

                // Clear 3D viewport
                if (viewport3d) {
                    viewport3d.cameras = [];
                    viewport3d.skeleton = null;
                    viewport3d.setFrame([]);
                }

                // Reset frame counter display
                document.getElementById('currentFrame').textContent = '0';
                document.getElementById('totalFrames').textContent = '0';

                // Show dock empty message
                var emptyMsg = document.getElementById('videoDockEmpty');
                if (emptyMsg) emptyMsg.classList.remove('hidden');

                setStatus('Session removed — ready for new session', 'success');
                return;
            }

            // Compute new active index BEFORE switching
            var newActiveIdx;
            if (state.activeSessionIdx === idx) {
                // Deleted the active session — pick nearest
                newActiveIdx = Math.min(idx, state.sessions.length - 1);
            } else if (state.activeSessionIdx > idx) {
                newActiveIdx = state.activeSessionIdx - 1;
            } else {
                newActiveIdx = state.activeSessionIdx;
            }

            // Update sessionIdx tags on remaining sessions' videos
            for (var si = 0; si < state.sessions.length; si++) {
                var s = state.sessions[si];
                if (s.videoFileIndices) {
                    for (var svi = 0; svi < s.videoFileIndices.length; svi++) {
                        var svfIdx = s.videoFileIndices[svi];
                        if (state.videoFiles[svfIdx]) {
                            state.videoFiles[svfIdx].sessionIdx = si;
                        }
                    }
                }
            }

            // Set active directly (bypass switchSession's save-old-state which would act on wrong session)
            state.activeSessionIdx = newActiveIdx;
            state.session = state.sessions[newActiveIdx];
            state.triangulationResults = state.session.triangulationResults || new Map();

            // Restore views for the new active session
            if (state.session._views && state.session._views.length > 0) {
                state.views = state.session._views;
                setVideoController(state.session._videoController || null);
                paneManager.clearAll();
                paneManager.addAllViewsAsGrid();
                setTimeout(function () {
                    fitCanvasesToCells();
                    refreshPaneInteractions();
                    state.currentFrame = state.session.lastFrame || 0;
                    if (videoController) videoController.seekToFrame(state.currentFrame);
                    drawAllOverlays(state.currentFrame);
                }, 50);
            } else {
                // Build views using pool decoders
                setVideoController(null);
                state.views = [];
                paneManager.clearAll();
                var rmVi = 0;
                for (var nvi = 0; nvi < state.session.videoFileIndices.length; nvi++) {
                    var vf = state.videoFiles[state.session.videoFileIndices[nvi]];
                    if (vf && vf.file && rmVi < state.decoderPool.length) {
                        vf.decoder = state.decoderPool[rmVi];
                        rmVi++;
                        createViewForVideoFile(vf);
                    }
                }
                updateTotalFrames();
                paneManager.addAllViewsAsGrid();
                rebuildVideoController();
                // Async: swap pool decoders to correct sources
                (async function() {
                    for (var rvi = 0; rvi < state.session.videoFileIndices.length; rvi++) {
                        var rvf = state.videoFiles[state.session.videoFileIndices[rvi]];
                        if (rvf && rvf.file && rvf.decoder) {
                            try {
                                await rvf.decoder.switchSource(rvf.file);
                                rvf.videoWidth = rvf.decoder.videoTrack.video.width;
                                rvf.videoHeight = rvf.decoder.videoTrack.video.height;
                                rvf.frameCount = rvf.decoder.samples.length;
                            } catch (e) { console.error('[removeSession] switchSource failed:', e); }
                        }
                    }
                    updateTotalFrames();
                    if (videoController) videoController.seekToFrame(state.currentFrame);
                })();
                setTimeout(function () {
                    fitCanvasesToCells();
                    refreshPaneInteractions();
                    drawAllOverlays(state.currentFrame);
                }, 50);
            }

            populateViewStrip();
            populateSessionStrip();
            populateSessionsPanel();
            setStatus('Session removed', 'success');
        }

        export async function switchSession(newIdx) {
            if (newIdx === state.activeSessionIdx) return;
            if (newIdx < 0 || newIdx >= state.sessions.length) return;

            // Save current session state
            var oldSession = state.sessions[state.activeSessionIdx];
            oldSession.lastFrame = state.currentFrame;
            oldSession.totalFrames = state.totalFrames;
            oldSession.fps = state.fps;
            oldSession.triangulationResults = state.triangulationResults;

            // Detach decoders from old session (they stay alive in decoderPool)
            oldSession._views = null;
            oldSession._videoController = null;

            // Save timeline view state so switching back restores zoom/scroll
            if (timeline) {
                oldSession._timelineZoom = timeline._zoom;
                oldSession._timelineScroll = timeline._scrollFrame;
            }

            // Save 3D viewport state
            if (viewport3d && viewport3d.threeCamera && viewport3d.controls) {
                oldSession._viewport3dState = {
                    cameraPosition: viewport3d.threeCamera.position.toArray(),
                    cameraUp: viewport3d.threeCamera.up.toArray(),
                    controlsTarget: viewport3d.controls.target.toArray(),
                };
            }

            // Pause old session
            if (videoController && state.isPlaying) {
                videoController.stopPlayback();
            }

            // Null out old session's decoder references (decoders stay in pool)
            for (var ovi = 0; ovi < oldSession.videoFileIndices.length; ovi++) {
                var oldVf = state.videoFiles[oldSession.videoFileIndices[ovi]];
                if (oldVf) oldVf.decoder = null;
            }

            // Switch active session
            state.activeSessionIdx = newIdx;
            var newSession = state.sessions[newIdx];
            state.session = newSession;
            state.triangulationResults = newSession.triangulationResults || new Map();

            // Sync trust track labels toggle
            var trustCheck = document.getElementById('menuTrustTracksCheck');
            if (trustCheck) trustCheck.textContent = newSession.trustTracks ? '\u2611' : '\u2610';

            // Rebuild views — reuse pool decoders via switchSource
            setVideoController(null);
            state.views = [];
            paneManager.clearAll();

            if (newSession.videoFileIndices.length === 0) {
                for (var nvi = 0; nvi < state.videoFiles.length; nvi++) {
                    if (state.videoFiles[nvi].sessionIdx === newIdx) {
                        newSession.videoFileIndices.push(nvi);
                    }
                }
            }

            for (var vi = 0; vi < newSession.videoFileIndices.length; vi++) {
                var vfIdx = newSession.videoFileIndices[vi];
                var vf = state.videoFiles[vfIdx];
                if (vf && vf.file) {
                    showLoading('Loading video: ' + vf.file.name + '...');
                    try {
                        if (vi < state.decoderPool.length) {
                            // Reuse pool decoder — swap source without creating new video element
                            await state.decoderPool[vi].switchSource(vf.file);
                            vf.decoder = state.decoderPool[vi];
                        } else {
                            // More cameras than pool — create new decoder and add to pool
                            var newDec = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
                            await newDec.init(vf.file);
                            vf.decoder = newDec;
                            state.decoderPool.push(newDec);
                        }
                        vf.videoWidth = vf.decoder.videoTrack.video.width;
                        vf.videoHeight = vf.decoder.videoTrack.video.height;
                        vf.frameCount = vf.decoder.samples.length;
                    } catch (e) {
                        console.error('[switchSession] Video init failed:', e);
                    }
                }
                if (vf && vf.decoder) {
                    createViewForVideoFile(vf);
                }
            }
            hideLoading();

            updateTotalFrames();
            paneManager.addAllViewsAsGrid();
            rebuildVideoController();

            var targetFrame = newSession.lastFrame || 0;
            setTimeout(function() {
                fitCanvasesToCells();
                refreshPaneInteractions();
                state.currentFrame = targetFrame;
                if (videoController && state.views.length > 0) {
                    videoController.seekToFrame(targetFrame);
                }
                drawAllOverlays(targetFrame);
            }, 50);

            // Update sidebars and panels (immediate, no delay needed)
            populateViewStrip();
            populateSessionStrip();

            // Update 3D viewport
            if (sessionHasCalibration()) {
                var vp3dMsg = document.getElementById('viewport3dMessage');
                if (vp3dMsg) vp3dMsg.classList.add('hidden');
                if (viewport3d) {
                    viewport3d.cameras = newSession.cameras;
                    viewport3d.skeleton = newSession.skeleton;
                    viewport3d.addCameraPyramids();
                    viewport3d.setFrame(getInstanceGroupsForFrame(state.currentFrame));
                    // Restore saved 3D view state, or fit to scene if first visit
                    if (newSession._viewport3dState) {
                        var vs = newSession._viewport3dState;
                        viewport3d.threeCamera.position.fromArray(vs.cameraPosition);
                        viewport3d.threeCamera.up.fromArray(vs.cameraUp);
                        viewport3d.controls.target.fromArray(vs.controlsTarget);
                        viewport3d.controls.update();
                    } else {
                        viewport3d.fitToScene();
                    }
                } else {
                    setup3DViewport();
                }
            } else {
                // No calibration — show message, hide 3D content
                var vp3dMsg = document.getElementById('viewport3dMessage');
                if (vp3dMsg) vp3dMsg.classList.remove('hidden');
                if (viewport3d) {
                    viewport3d.cameras = [];
                    viewport3d.addCameraPyramids();
                    viewport3d.setFrame([]);
                }
            }

            if (state.triangulationResults.size > 0) {
                setReprojErrorVisible(true);
            }
            updateInfoPanel();
            // updateTotalFrames() already wrote state.totalFrames from the current
            // decoders. Cache it onto the session so future no-decoder paths can
            // restore. If updateTotalFrames found no decoders, fall back to the
            // session's previously cached value (covers lazy-load paths where the
            // decoder isn't ready yet but the count is known).
            if (state.totalFrames > 0) {
                newSession.totalFrames = state.totalFrames;
                newSession.fps = state.fps;
            } else if (newSession.totalFrames > 0) {
                state.totalFrames = newSession.totalFrames;
                state.fps = newSession.fps || 30;
                document.getElementById('totalFrames').textContent = state.totalFrames;
                document.getElementById('fpsDisplay').textContent = state.fps.toFixed(1) + ' fps';
            }

            if (timeline) {
                timeline.setData(newSession);
                timeline.setTotalFrames(state.totalFrames);
                if (newSession._timelineZoom !== undefined) {
                    timeline._zoom = Math.max(1, Math.min(newSession._timelineZoom, timeline._maxZoom()));
                    timeline._scrollFrame = Math.max(0, newSession._timelineScroll || 0);
                } else {
                    timeline._zoom = 1;
                    timeline._scrollFrame = 0;
                }
                timeline._clampScroll();
                timeline.redraw();
            }

            setStatus('Switched to ' + newSession.name, 'info');
        }

        function updateViewStripThumbnail(view, thumbCanvas) {
            if (!thumbCanvas) return;
            // Prefer decoding first frame directly from decoder
            if (view.decoder) {
                view.decoder.getFrame(0).then(function (frame) {
                    if (frame) {
                        var ctx = thumbCanvas.getContext('2d');
                        ctx.drawImage(frame, 0, 0, thumbCanvas.width, thumbCanvas.height);
                    }
                }).catch(function () { /* decoder not ready */ });
                return;
            }
            if (!view.canvas) return;
            var ctx = thumbCanvas.getContext('2d');
            try {
                ctx.drawImage(view.canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
            } catch (e) { /* not ready */ }
        }

        function updateAllStripThumbnails() {
            var items = document.querySelectorAll('.view-strip-item');
            items.forEach(function (item) {
                var viewName = item.getAttribute('data-view-name');
                var view = state.views.find(function (v) { return v.name === viewName; });
                var thumbCanvas = item.querySelector('.strip-thumb canvas');
                if (view && thumbCanvas) {
                    updateViewStripThumbnail(view, thumbCanvas);
                }
            });
        }

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

        export function updateFpsDisplay() {
            var fpsEl = document.getElementById('fpsDisplay');
            if (fpsEl) fpsEl.textContent = (state.fps || 30).toFixed(1) + ' fps';
        }

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


        // ============================================
        // Cross-View Tracker Integration
        // ============================================

        var globalTracker = null;
        var trackerWorker = null;

        function getTrackerHyperparams() {
            var el2d = document.getElementById('trackerWeight2d');
            return {
                correspondenceWeight2d: el2d ? parseFloat(el2d.value) : 1.0,
                correspondenceWeight3d: document.getElementById('trackerWeight3d') ? parseFloat(document.getElementById('trackerWeight3d').value) : 1.0,
                velocityThreshold: document.getElementById('trackerVelocity') ? parseFloat(document.getElementById('trackerVelocity').value) : 1.0,
                distanceThreshold: document.getElementById('trackerDistance') ? parseFloat(document.getElementById('trackerDistance').value) : 1.0,
                timePenalty: document.getElementById('trackerTimePenalty') ? parseFloat(document.getElementById('trackerTimePenalty').value) : 1.0
            };
        }

        // Tracker state: number of animals (null = unconstrained)
        var trackerNumAnimals = null;

        function promptNumAnimals() {
            var input = prompt('Number of animals (leave empty for auto-detect):', trackerNumAnimals || '');
            if (input === null) return false;  // cancelled
            input = input.trim();
            if (input === '') {
                trackerNumAnimals = null;
            } else {
                var n = parseInt(input);
                if (isNaN(n) || n < 1) {
                    setStatus('Invalid number', 'error');
                    return false;
                }
                trackerNumAnimals = n;
            }
            return true;
        }

        export function trackCurrentFrame() {
            var session = getActiveSession();
            if (!session || !session.cameras || session.cameras.length === 0) {
                setStatus('No session with cameras loaded', 'error');
                return;
            }
            var fg = session.getFrameGroup(state.currentFrame);
            if (!fg) {
                setStatus('No frame data at frame ' + state.currentFrame, 'error');
                return;
            }

            // Prompt for number of animals on first use
            if (trackerNumAnimals == null) {
                if (!promptNumAnimals()) return;
            }

            try {
                var result = matchFrameInstances(fg, session.cameras, session, {
                    numAnimals: trackerNumAnimals
                });
                drawAllOverlays(state.currentFrame);
                updateInfoPanel();
                if (timeline) timeline.refreshTracks(state.session);
                if (result.numIdentities > 0) {
                    setStatus('Frame ' + state.currentFrame + ': ' + result.numIdentities + ' identities' +
                        (trackerNumAnimals ? ' (constrained to ' + trackerNumAnimals + ')' : ''), 'success');
                } else {
                    setStatus('No cross-view matches found (need instances in 2+ views)', 'warning');
                }
            } catch (e) {
                console.error('[Tracker] error:', e, e.stack);
                setStatus('Tracker error: ' + e.message + ' | ' + (e.stack ? e.stack.split('\n')[1] : ''), 'error');
            }
        }

        export function findMatchForSelected() {
            var session = getActiveSession();
            if (!session || !session.cameras || session.cameras.length === 0) return;
            if (!interactionManager) return;

            // Determine the selected instance and its camera
            var selectedInst = null;
            var selectedCam = null;

            if (interactionManager.selectedUnlinked) {
                // Unlinked instance: single-view, has .instance and .cameraName
                selectedInst = interactionManager.selectedUnlinked.instance;
                selectedCam = interactionManager.selectedUnlinked.cameraName;
            } else if (interactionManager.selectedInstanceGroup) {
                // Grouped instance: pick the first camera's instance
                var group = interactionManager.selectedInstanceGroup;
                var iter = group.instances.entries();
                var first = iter.next();
                if (!first.done) {
                    selectedCam = first.value[0];
                    selectedInst = first.value[1];
                }
            }

            if (!selectedInst || !selectedCam) {
                setStatus('Select an instance first', 'warning');
                return;
            }
            if (!globalTracker) {
                globalTracker = new CrossViewTracker(getTrackerHyperparams());
            }
            var fg = session.getFrameGroup(state.currentFrame);
            if (!fg) return;

            var matches = globalTracker.findMatchesForInstance(selectedInst, selectedCam, fg, session.cameras);
            if (matches.size === 0) {
                setStatus('No matches found in other views', 'warning');
                return;
            }

            // Report matches
            var parts = [];
            matches.forEach(function (match, camName) {
                parts.push(camName + ' (err=' + match.score.toFixed(1) + ')');
            });
            setStatus('Matches: ' + parts.join(', '), 'success');

            // TODO: Visual highlight of matched instances (phase 2)
        }

        export async function trackAll() {
            var session = getActiveSession();
            if (!session || !session.cameras || session.cameras.length === 0) {
                setStatus('No session with cameras loaded', 'error');
                return;
            }

            var cameras = session.cameras;
            if (cameras.length < 2) {
                setStatus('Need at least 2 cameras', 'warning');
                return;
            }

            var frameIndices = session.frameIndices;
            if (frameIndices.length === 0) {
                setStatus('No frames to track', 'error');
                return;
            }

            // Prompt for number of animals
            if (trackerNumAnimals == null) {
                if (!promptNumAnimals()) return;
            }
            console.log('[TrackAll] numAnimals:', trackerNumAnimals, 'frames:', frameIndices.length);
            console.time('[TrackAll] total');

            // Clear old identities for fresh run
            session.identities = [];
            session.trackIdentityMap = new Map();
            session.frameIdentityMap = new Map();

            showLoading('Assigning identities: 0/' + frameIndices.length + ' frames...');

            var YIELD_EVERY = 50;

            var prevAssignments = null;
            var prevTargets3d = null;
            try {
                for (var f = 0; f < frameIndices.length; f++) {
                    var fi = frameIndices[f];
                    var fg = session.getFrameGroup(fi);
                    if (fg) {
                        try {
                            var result = matchFrameInstances(fg, cameras, session, {
                                numAnimals: trackerNumAnimals,
                                perFrame: true,
                                prevAssignments: prevAssignments,
                                prevTargets3d: prevTargets3d
                            });
                            if (result.assignments && result.assignments.size > 0) {
                                prevAssignments = result.assignments;
                            }
                            if (result.targets3d && result.targets3d.length > 0) {
                                prevTargets3d = result.targets3d;
                            }
                        } catch (frameErr) {
                            console.error('[TrackAll] Error at frame ' + fi + ':', frameErr);
                            // Continue to next frame instead of aborting
                        }
                    }

                    if (f % YIELD_EVERY === 0) {
                        document.getElementById('loadingStatus').textContent =
                            'Assigning identities: ' + (f + 1) + '/' + frameIndices.length + ' frames...';
                        await new Promise(function (r) { setTimeout(r, 0); });
                    }
                }

                hideLoading();
                drawAllOverlays(state.currentFrame);
                console.timeEnd('[TrackAll] total');
                updateInfoPanel();
                if (timeline) timeline.refreshTracks(state.session);
                setStatus('Tracked ' + frameIndices.length + ' frames, ' +
                    session.identities.length + ' identities', 'success');
            } catch (e) {
                hideLoading();
                console.error('[TrackAll] error:', e, e.stack);
                setStatus('Track All error: ' + e.message + ' | ' + (e.stack ? e.stack.split('\n')[1] : ''), 'error');
            }
        }

        // Wire up tracker buttons
        (function () {
            var btnTrackFrame = document.getElementById('tbTrackFrame');
            var btnTrackAll = document.getElementById('tbTrackAll');
            var btnCancel = document.getElementById('trackerCancel');

            if (btnTrackFrame) btnTrackFrame.addEventListener('click', trackCurrentFrame);
            if (btnTrackAll) btnTrackAll.addEventListener('click', trackAll);
            if (btnCancel) btnCancel.addEventListener('click', function () {
                if (trackerWorker) trackerWorker.postMessage({ type: 'cancel' });
            });

            // Slider value display
            ['trackerWeight2d', 'trackerWeight3d', 'trackerVelocity', 'trackerDistance', 'trackerTimePenalty'].forEach(function (id) {
                var slider = document.getElementById(id);
                var valSpan = document.getElementById(id + 'Val');
                if (slider && valSpan) {
                    slider.addEventListener('input', function () {
                        valSpan.textContent = slider.value;
                        // Reset tracker so new hyperparams take effect
                        globalTracker = null;
                    });
                }
            });
        })();

        // ============================================
        // Start
        // ============================================

        init();
