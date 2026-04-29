        import { DockviewComponent, themeDark } from 'https://cdn.jsdelivr.net/npm/dockview-core/+esm';
        import { Skeleton, Camera, Instance, UnlinkedInstance, FrameGroup, Identity, InstanceGroup, Session } from './pose/pose-data.js?v=1';
        import {
            reprojectPoints, computeReprojectionErrors, computeInstanceDistance,
            triangulateAndReproject, hungarianAlgorithm,
            storeReprojectedInstances, LazyFrameLoader, shouldUseLazyH5,
            getInstanceGroupsForFrame, frameHasGroupedUserInstances,
            ensureLazyFrameData, buildLazyFrameGroupSync, batchLoadLazyFrames,
            loadAllLazyFrames, evictLazyFrames, updateTimelineForFrame,
            triangulateMultiFrameInstances,
        } from './pose/triangulation.js?v=2';
        import { matchFrameInstances } from './pose/tracker.js?v=1';
        import { REPROJECTION_COLOR, getTrackColor, getGroupColor, drawFrameOverlays } from './ui/overlays.js?v=1';
        import { InteractionManager, isInteractiveClickTarget } from './ui/interaction.js?v=1';
        import { Viewport3D } from './ui/viewport3d.js?v=1';
        import { Timeline } from './ui/timeline.js?v=1';
        import { validateSkeletonCompatibility, mergeTracksIntoSession, mergeSlpFramesIntoSession, rebuildInstanceGroupsForFrames } from './import-export/slp-merge.js?v=1';
        import {
            pickFiles, pickFolder, parseCalibrationTOML, parseCalibrationJSON,
            matchVideosToCameras, buildVideoGrid, exportCalibrationTOML,
            serializeSkeleton, buildSlpExportData, buildPoints3dExportData,
            downloadJSON, downloadTOML, h5FileToBlob, buildPerCameraSlpJson,
            buildSlpLabels, buildSlpLabelsMultiSession, buildSlpLabelsAllViews,
            parseSlpH5, instancePointsMatch, convertSlpToV06Compatible,
            loadCalibrationFile, pickVideoFiles, exportSlpClientSide, exportSlpMultiSession,
            buildPoints3dH5, buildReprojH5, parsePoints3dH5
        } from './import-export/file-io.js?v=1';
        import { OnDemandVideoDecoder, EmbeddedVideoDecoder, VideoController, videoLog } from './loading/video.js?v=1';
        import { createDemoCalibration, createDemoSkeleton, generateDemoKeypoints3D, createDemoSession } from './demo-data.js?v=1';
        import {
            state,
            videoController, interactionManager, viewport3d, timeline, paneManager,
            setVideoController, setInteractionManager, setViewport3D, setTimeline, setPaneManager,
            getActiveSession, setActiveSession,
            VIEW_NAMES,
        } from './ui/app-state.js?v=1';
        import {
            handleLoadCalibration, handleLoadVideos, autoAssignVideosToCameras,
            forceVideoSelection, showParentDirMatchSummary, forceVideoSelectionWithFolder,
            createViewForVideoFile, updateGridLayout, createVideoPromptCell,
            fitCanvasesToCells, rebuildVideoController, updateTotalFrames,
            handleLoadMultiSession, showSessionModeModal, loadSingleSessionFromCache,
            handleLoadSessionFolderPerCamera,
            resolveImportTrackIdx, cellResizeObserver,
        } from './loading/session-loader.js?v=1';
        import {
            newProject, markDirty, clearDirty,
            quickSave, saveAs, saveProjectSlp, saveProject,
            handleLoadProject,
            showLoading, hideLoading, setStatus,
        } from './import-export/save-load.js?v=1';
        import {
            handleLoadSlpFile, handleAddSlp, handleLoadPoints3dH5,
        } from './import-export/slp-import.js?v=1';
        import {
            setReprojErrorVisible, getVisibilitySettings,
            drawAllOverlays, updateFrameCounters,
        } from './ui/rendering.js?v=1';
        import {
            setupPanelTabs, populateVideosTable, populateCamerasTable,
            populateSkeletonTable, setupSkeletonEditing, parseSkeletonJSON,
            updateInfoPanel, updateFrameInfo, updateTriangulationBadge,
        } from './ui/info-panel.js?v=1';

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
        function seekToLabeledFrame(direction) {
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
        function triangulateCurrentFrame() {
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
        async function triangulateAllFrames() {
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
        function showGroupByTrackModal() {
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
         * Uses session.trackIdentityMap to find which camera:trackIdx -> identityId.
         * For each frame, groups instances that share the same identity into InstanceGroups,
         * then triangulates each group.
         */
        async function groupByIdentityAndTriangulateAll() {
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

                        var identityId = session.getIdentityIdForTrack
                            ? session.getIdentityIdForTrack(camName, inst.trackIdx, frameIdx)
                            : session.trackIdentityMap.get(camName + ':' + inst.trackIdx);
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

                        var identityId2 = session.getIdentityIdForTrack
                            ? session.getIdentityIdForTrack(camName2, ulInst.trackIdx, frameIdx)
                            : session.trackIdentityMap.get(camName2 + ':' + ulInst.trackIdx);
                        if (identityId2 == null) continue;
                        if (!idBuckets[identityId2]) idBuckets[identityId2] = {};
                        if (!idBuckets[identityId2][camName2]) idBuckets[identityId2][camName2] = ulInst;
                    }
                }

                // 2. Clear existing groups and instances for this frame
                session.instanceGroups.delete(frameIdx);
                for (var [cn] of fg.instances) fg.instances.set(cn, []);
                for (var [cn2] of fg.unlinkedInstances) fg.unlinkedInstances.set(cn2, []);

                // Add ALL instances back to fg.instances (they're now grouped/linked)
                for (var cn3 in allInstancesByCam) {
                    for (var ai = 0; ai < allInstancesByCam[cn3].length; ai++) {
                        fg.addInstance(cn3, allInstancesByCam[cn3][ai]);
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
                    var triResult = triangulateAndReproject(group, cameras, { triangulateOnly: true });
                    group.points3d = triResult.points3d;
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

        function swapTracks(trackA, trackB, frameStart, frameEnd) {
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
                    // Auto-assign identity from track
                    var identity = session.getOrCreateIdentityForTrack(trackIdx);
                    var group = new InstanceGroup(Date.now() + trackIdx, identity.id);
                    for (var ci2 = 0; ci2 < camNames.length; ci2++) {
                        group.addInstance(camNames[ci2], bucket[camNames[ci2]]);
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
                timeline.refreshTracks(session);
            }

            // Update info panel
            updateInfoPanel();
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

        function addNewInstanceSmart() {
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

                    // Remove from group
                    group.instances.delete(viewName);

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

        function sessionHasCalibration() {
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

        function showCalibrationRequiredPopup() {
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

        function update3DViewport(frameIdx) {
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

        function assignTrackToSelected(trackIdx) {
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
            if (timeline) timeline.refreshTracks(state.session);
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
        function assignIdentityToSelected(identityId, identityName) {
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
                for (var [cn, inst] of sel.instances) {
                    session.trackIdentityMap.set(cn + ':' + inst.trackIdx, identityId);
                    propagated += propagateIdentityForward(inst.trackIdx, identityId, cn);
                }
            } else if (selUl) {
                session.assignTrackToIdentity(selUl.instance.trackIdx, identityId, selUl.cameraName);
                markDirty();
                propagated = propagateIdentityForward(selUl.instance.trackIdx, identityId, selUl.cameraName);
            }

            drawAllOverlays(state.currentFrame);
            updateInfoPanel();
            if (timeline) timeline.refreshTracks(state.session);

            var msg = 'Assigned ' + identityName;
            if (propagated > 0) msg += ' (propagated to ' + propagated + ' future instances)';
            setStatus(msg, 'success');
        }

        // ============================================
        // Menu Setup
        // ============================================

        function setupMenus() {
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
                if (interactionManager) interactionManager._unlinkSelectedGroup();
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

        /**
         * Unlink a given group (or the selected group) — returns its instances
         * to the unlinked pool and refreshes all UI.
         */
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
            setStatus('Unlinked ' + trackName, 'success');

            // Refresh everything
            updateTimelineForFrame(frameIdx);
            if (viewport3d) {
                var groups = getInstanceGroupsForFrame(frameIdx);
                viewport3d.setFrame(groups);
            }
            triangulateCurrentFrame();
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

        function hideGroupContextMenu() {
            var menu = document.getElementById('groupContextMenu');
            menu.style.display = 'none';
            menu._targetGroup = null;
        }

        // ============================================
        // UI Setup
        // ============================================

        function setupUI() {
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
                        selectedGroup.identityId = newTrackIdx;
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
                if (interactionManager.assignmentMode && interactionManager.assignmentSelection.length >= 1) {
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

        function updateSeekbarVisual(frameIdx) {
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

        function toggleInfoPanel() {
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

        function updateInfoPanelToggleBtn() {
            var wrapper = document.getElementById('infoPanelWrapper');
            var btn = document.getElementById('infoPanelToggleBtn');
            if (btn) {
                btn.textContent = wrapper.classList.contains('collapsed') ? 'Show Panel' : 'Hide Panel';
            }
        }

        function toggle3DViewport() {
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

        function toggleTimeline() {
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

        function syncTimelineToggleButton() {
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
        // Manual Identity Assignment
        // ============================================

        var manualAssignState = null; // { toast: HTMLElement }

        function getTotalUnlinkedCount() {
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

        function cleanupManualAssignment() {
            if (!manualAssignState) return;
            if (manualAssignState.toast && manualAssignState.toast.parentNode) {
                manualAssignState.toast.parentNode.removeChild(manualAssignState.toast);
            }
            manualAssignState = null;
        }

        function startManualAssignment() {
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
                if (!interactionManager || interactionManager.assignmentSelection.length < 1) {
                    setStatus('Select at least one instance first', 'warning');
                    return;
                }
                interactionManager._createGroupFromAssignment();
            });
        }

        // ============================================
        // Edit Group Mode
        // ============================================

        export var editGroupState = null; // { toast, group, originalInstances: Map }

        function startEditGroup(group) {
            // Cleanup any existing assignment/edit state
            cleanupManualAssignment();
            cleanupEditGroup();
            if (interactionManager && interactionManager.assignmentMode) {
                interactionManager.setAssignmentMode(false);
            }

            // Snapshot group.instances (clone Map with cloned instance refs)
            var originalInstances = new Map();
            for (var [camName, inst] of group.instances) {
                originalInstances.set(camName, inst);
            }

            interactionManager.setEditGroupMode(true, group);

            // Create toast
            var toast = document.createElement('div');
            toast.className = 'auto-assign-toast';
            toast.innerHTML =
                '<span id="editGroupToastText">Editing Group: ' + group.instances.size + ' Instances Selected</span>' +
                '<button id="editGroupCancel">Cancel</button>' +
                '<button id="editGroupContinue" class="primary">Continue</button>';
            document.getElementById('menuBar').appendChild(toast);

            editGroupState = { toast: toast, group: group, originalInstances: originalInstances };

            toast.querySelector('#editGroupCancel').addEventListener('click', function () {
                cancelEditGroup();
            });
            toast.querySelector('#editGroupContinue').addEventListener('click', function () {
                finishEditGroup();
            });
        }

        function cancelEditGroup() {
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

            // If group has 0 instances, remove it entirely
            if (group.instances.size === 0) {
                state.session.removeInstanceGroup(frameIdx, group);
                markDirty();
                if (interactionManager) interactionManager.clearSelection();
            }

            cleanupEditGroup();
            updateTimelineForFrame(frameIdx);
            if (viewport3d) viewport3d.setFrame(getInstanceGroupsForFrame(frameIdx));
            drawAllOverlays(state.currentFrame);
            updateInfoPanel();
        }

        function cleanupEditGroup() {
            if (editGroupState && editGroupState.toast && editGroupState.toast.parentNode) {
                editGroupState.toast.parentNode.removeChild(editGroupState.toast);
            }
            editGroupState = null;
            if (interactionManager) interactionManager.setEditGroupMode(false);
        }

        function updateEditGroupToast() {
            if (!editGroupState) return;
            var textEl = document.getElementById('editGroupToastText');
            if (textEl) {
                textEl.textContent = 'Editing Group: ' + editGroupState.group.instances.size + ' Instances Selected';
            }
        }

        // ============================================
        // Automatic Identity Assignment
        // ============================================

        var autoAssignState = null; // { selectedViews: Set, toast: HTMLElement }

        function cleanupAutoAssignment() {
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

        function runAutomaticAssignment(selectedViewNames) {
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
        function runTrackedAssignment(viewNames, prevGroups) {
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
                        projected[gi][viewName] = reprojectPoints(
                            validPrevGroups[gi].points3d, cam.projectionMatrix
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
                    // Preserve identity from previous frame
                    group.identityId = prevIdentityId;

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
        function runSingleFrameTriangulation() {
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
                triangulateCurrentFrame();
            } else {
                // No assignment — show view selection toast (single frame mode)
                startViewSelectionForFrames(frameIdx, frameIdx, true);
            }
        }

        // ============================================
        // Multi-Frame Assignment Modal
        // ============================================

        function showMultiFrameModal() {
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
        function startViewSelectionForFrames(startFrame, endFrame, isSingleFrame) {
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
        function showMultiFrameProgressModal(startFrame, endFrame, viewNames) {
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

        async function runMultiFrameAssignment(startFrame, endFrame, viewNames, overlayEl) {
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

            // Update timeline: mark frames with grouped UserInstances, refresh track bars
            if (timeline) {
                for (var [fIdx] of state.triangulationResults) {
                    timeline.setFrameModified(fIdx, frameHasGroupedUserInstances(fIdx));
                }
                timeline.refreshTracks(state.session);
            }
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

        function showSlpExportModal() {
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

        function showSlpExportAllModal() {
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

        function showTriangulateMultiFrameModal() {
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
        // View Mode Switching (grid / single)
        // ============================================

        var savedGridLayout = null; // cached dockview layout JSON from grid mode

        function toggleViewMode() {
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

        function cycleSingleView(direction) {
            if (state.views.length === 0) return;
            if (state.viewMode !== 'single') {
                state.viewMode = 'single';
                state.singleViewIndex = direction > 0 ? 0 : state.views.length - 1;
            } else {
                state.singleViewIndex = (state.singleViewIndex + direction + state.views.length) % state.views.length;
            }
            updateVideoGridDisplay();
        }

        function setGridMode() {
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

        function updateVideoGridDisplay() {
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

        function showViewIndicator() {
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


        // ============================================
        // Export Labels (simple JSON dump)
        // ============================================

        function exportLabels() {
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
        // H5 Export wrappers
        // ============================================

        async function exportPoints3dH5() {
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

        async function exportReprojH5() {
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
        // Dockview Pane Manager
        // ============================================

        const panelRenderers = new Map(); // panelId -> VideoPaneRenderer

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

        function refreshPaneInteractions() {
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
        var multiSelectViews = new Set();

        function clearMultiSelect() {
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

        function clampRotation(deg) {
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

        function syncRotationUI(view) {
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

        function showMoveVideoModal(viewNames, fromIdx, toIdx) {
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

        function removeSession(idx) {
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
        // Split Handles
        // ============================================

        function setupDragHandle(handle, onDrag) {
            handle.addEventListener('mousedown', function (e) {
                e.preventDefault();
                var startX = e.clientX;
                handle.classList.add('dragging');

                // Create ghost line
                var ghost = document.createElement('div');
                ghost.className = 'split-ghost-line';
                ghost.style.left = e.clientX + 'px';
                ghost.style.top = '0';
                ghost.style.height = '100vh';
                document.body.appendChild(ghost);

                function onMouseMove(ev) {
                    ghost.style.left = ev.clientX + 'px';
                }

                function onMouseUp(ev) {
                    handle.classList.remove('dragging');
                    ghost.remove();
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                    var totalDeltaX = ev.clientX - startX;
                    onDrag(totalDeltaX);
                }

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        }

        function setupSplitHandles() {
            var viewport3dEl = document.getElementById('viewport3dContainer');
            var handle1 = document.getElementById('splitHandle1');
            var handle2 = document.getElementById('splitHandle2');

            setupDragHandle(handle1, function (totalDeltaX) {
                if (viewport3dEl.classList.contains('collapsed')) return;
                var currentWidth = viewport3dEl.offsetWidth;
                var newWidth = Math.max(150, currentWidth - totalDeltaX);
                viewport3dEl.style.width = newWidth + 'px';
                if (viewport3d) {
                    setTimeout(function () { viewport3d.resize(); }, 0);
                }
            });

            setupDragHandle(handle2, function (totalDeltaX) {
                var wrapperEl = document.getElementById('infoPanelWrapper');
                if (wrapperEl.classList.contains('collapsed')) return;
                var panelEl = document.getElementById('infoPanel');
                var currentWidth = panelEl.offsetWidth;
                var newWidth = Math.max(200, currentWidth - totalDeltaX);
                panelEl.style.width = newWidth + 'px';
                panelEl.style.minWidth = newWidth + 'px';
            });

            // Timeline resize handle (vertical drag).
            // Dragging the top edge resizes the timeline. Dragging it below
            // a small snap threshold fully hides the timeline (equivalent
            // to clicking the Timeline toolbar button).
            var timelineHandle = document.getElementById('timelineResizeHandle');
            var timelineEl = document.getElementById('timelineContainer');
            if (timelineHandle && timelineEl) {
                timelineHandle.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                    var startY = e.clientY;
                    var wasCollapsed = timelineEl.classList.contains('collapsed');
                    // When starting from collapsed, treat current height as 0
                    // so pulling the handle up immediately grows the timeline.
                    var startH = wasCollapsed ? 0 : timelineEl.offsetHeight;
                    timelineHandle.classList.add('dragging');

                    var COLLAPSE_SNAP = 20;
                    var MIN_H = 40;
                    var MAX_H = 600;

                    function onMove(ev) {
                        var delta = startY - ev.clientY;
                        var target = startH + delta;
                        if (target < COLLAPSE_SNAP) {
                            // Snap to fully hidden.
                            timelineEl.classList.add('collapsed');
                            timelineEl.style.height = '';
                        } else {
                            timelineEl.classList.remove('collapsed');
                            var newH = Math.max(MIN_H, Math.min(MAX_H, target));
                            timelineEl.style.height = newH + 'px';
                        }
                        if (timeline) timeline.resize();
                        syncTimelineToggleButton();
                    }
                    function onUp() {
                        timelineHandle.classList.remove('dragging');
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                    }
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                });
            }

            var infoPanelWrapper = document.getElementById('infoPanelWrapper');

            function updateHandleVisibility() {
                var vpCollapsed = viewport3dEl.classList.contains('collapsed');
                var wrapperCollapsed = infoPanelWrapper.classList.contains('collapsed');
                handle1.classList.toggle('hidden', vpCollapsed);
                handle2.classList.toggle('hidden', wrapperCollapsed);
                updateInfoPanelToggleBtn();
            }

            var observer = new MutationObserver(updateHandleVisibility);
            observer.observe(viewport3dEl, { attributes: true, attributeFilter: ['class'] });
            observer.observe(infoPanelWrapper, { attributes: true, attributeFilter: ['class'] });
            updateHandleVisibility();

            // Wire up the toggle button
            document.getElementById('infoPanelToggleBtn').addEventListener('click', toggleInfoPanel);
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

        function applyPlaybackRate() {
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

        function trackCurrentFrame() {
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

        function findMatchForSelected() {
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

        async function trackAll() {
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
