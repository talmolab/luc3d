// pose/initialization.js — Pass 3i-3 extraction
//
// App startup logic, empty-session controller, demo session loader,
// interaction manager wiring, 3D viewport setup, timeline setup,
// smart instance creation, and the FPS-display helper.
//
// This module owns the singletons that downstream code reads via
// app-state.js live bindings. The bottom of the file invokes init()
// once the module is parsed, replacing the old app.js entry point.

import { state, videoController, interactionManager, viewport3d, timeline, paneManager,
         setVideoController, setInteractionManager, setViewport3D, setTimeline,
         hasRealVideo, VIEW_NAMES } from '../ui/app-state.js';
import { Instance, UnlinkedInstance } from './pose-data.js';
import {
    getInstanceGroupsForFrame, updateTimelineForFrame,
    reTriangulateGroup, sessionHasCalibration,
} from './triangulation.js';
import { OnDemandVideoDecoder, VideoController } from '../loading/video.js';
import { rebuildVideoController } from '../loading/session-loader.js';
import { markDirty, setStatus, showLoading, hideLoading } from '../import-export/save-load.js';
import { createDemoSession } from '../demo-data.js';
import { setupUI, setupMenus, updateSeekbar, onPlaybackStateChange, fitTimelineToData } from '../ui/ui-wiring.js';
import { installTimelineShortcuts } from '../ui/timeline-controller.js';
import { setupPanelTabs, setupSkeletonEditing, updateInfoPanel } from '../ui/info-panel.js';
import { setupSplitHandles } from '../ui/layout-controls.js';
import { drawAllOverlays, setReprojErrorVisible } from '../ui/rendering.js';
import { populateViewStrip, populateSessionStrip } from '../ui/sessions-panes.js';
import {
    manualAssignState, getTotalUnlinkedCount, cleanupManualAssignment, startManualAssignment,
    editGroupState, cancelEditGroup, finishEditGroup, updateEditGroupToast,
    purgeTriangulationDataForGroup,
} from '../ui/identity-assignment.js';
import { getTrackColor, getGroupColor } from '../ui/overlays.js';
import { Viewport3D } from '../ui/viewport3d.js';
import { Timeline } from '../ui/timeline.js';
import { InteractionManager } from '../ui/interaction.js';

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
export async function loadDemoSession() {
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
            skeletonNodeShape: (function() { var e = document.getElementById('vis3dNodeStyle'); return e ? (e.getAttribute('data-value') || 'circle') : 'circle'; })(),
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

/**
 * Navigate to a frame from any UI entry point (timeline scrub, transport
 * buttons, arrow keys). With video loaded this defers to the video
 * controller's decode+render seek. For a video-less project — e.g. a skeleton
 * with imported 3D points (`handleLoadPoints3dH5`) — there is no decoder, so
 * we clamp + update `currentFrame` and re-render the overlays, the 3D
 * viewport, and the seekbar directly so the full points3d duration is
 * navigable.
 */
export function navigateToFrame(frameIdx) {
    if (hasRealVideo()) { videoController.seekToFrame(frameIdx); return; }
    var maxF = Math.max(0, (state.totalFrames || 1) - 1);
    if (frameIdx < 0) frameIdx = 0;
    if (frameIdx > maxF) frameIdx = maxF;
    state.currentFrame = frameIdx;
    try { drawAllOverlays(frameIdx); } catch (e) { console.warn('[nav] overlay draw failed:', e); }
    // updateSeekbar updates the seekbar position AND the 3D viewport.
    updateSeekbar(frameIdx);
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
                // Video-less project (skeleton + imported 3D points): render the
                // frame statically — no decoder to seek.
                if (!hasRealVideo()) { navigateToFrame(frameIdx); return; }
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
            if (hasRealVideo()) videoController.seekToFrame(frameIdx);
            else navigateToFrame(frameIdx);
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

    // Install the Block 1 keyboard shortcuts (Ctrl/Cmd+J toggles the
    // timeline, Ctrl/Cmd+Shift+J fires the legacy "Change Frame Number"
    // command). The installer is idempotent — subsequent calls are
    // no-ops, so repeated `setupTimeline()` calls during session reload
    // don't stack handlers.
    installTimelineShortcuts();
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
export function updateFpsDisplay() {
    var fpsEl = document.getElementById('fpsDisplay');
    if (fpsEl) fpsEl.textContent = (state.fps || 30).toFixed(1) + ' fps';
}

// ============================================
// Start
// ============================================

init();
