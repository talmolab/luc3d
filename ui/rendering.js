// ui/rendering.js — overlay drawing, visibility settings, frame counters
// Pass 3d-1 extraction. Holds the canvas overlay-rendering pipeline:
// - getVisibilitySettings: collects user-controlled visibility/style settings from the DOM.
// - drawAllOverlays: per-frame multi-view overlay rendering (calls drawFrameOverlays).
// - setReprojErrorVisible: toggles reprojection-error column visibility in info panels.
// - updateFrameCounters: status-bar frame counters (labeled / triangulated / instances).

import { state, interactionManager, timeline } from './app-state.js';
import {
    ensureLazyFrameData, getInstanceGroupsForFrame,
    triangulateAndReproject, storeReprojectedInstances,
} from '../pose/triangulation.js';
import { drawFrameOverlays } from './overlays.js';

// Pass 3f: editGroupState + finishEditGroup moved to ui/identity-assignment.js.
import { editGroupState, finishEditGroup } from './identity-assignment.js';
import { updateFrameInfo } from './info-panel.js';

// ============================================
// Reproj/Error visibility
// ============================================

export function setReprojErrorVisible(visible) {
    var display = visible ? '' : 'none';
    var el = document.getElementById('reprojErrorSection');
    if (el) el.style.display = display;
    // Error column header and cells
    var cols = document.querySelectorAll('.reproj-error-col');
    for (var i = 0; i < cols.length; i++) {
        cols[i].style.display = display;
    }
    // Check the checkboxes when triangulation data is available
    if (visible) {
        var reproj = document.getElementById('visReprojections');
        if (reproj) reproj.checked = true;
        var errors = document.getElementById('visErrors');
        if (errors) errors.checked = true;
    }
}

// ============================================
// Overlay Drawing
// ============================================

export function getVisibilitySettings() {
    // Read a `.line-style-options` (or node-style) button group's data-value,
    // tolerating a missing element (headless test runner).
    function styleVal(id, fallback) {
        var el = document.getElementById(id);
        return (el && el.getAttribute('data-value')) || fallback;
    }
    return {
        showLegend: document.getElementById('visLegend').checked,
        showUser: document.getElementById('visUser').checked,
        showPredicted: document.getElementById('visPredicted').checked,
        showReprojected: document.getElementById('visReprojections').checked,
        reprojNodeColor: document.getElementById('visReprojNodeColor').getAttribute('data-value') || 'white',
        showErrors: document.getElementById('visErrors').checked,
        userOpts: {
            nodeSize: parseInt(document.getElementById('visUserNodeSize').value) || 4,
            lineWidth: parseInt(document.getElementById('visUserEdgeWeight').value) || 2,
            alpha: parseInt(document.getElementById('visUserEdgeTrans').value) / 100,
            labelSize: parseInt(document.getElementById('visUserLabelSize').value) || 11,
            labelAlpha: parseFloat(document.getElementById('visUserLabelAlpha').value),
            showLabels: parseInt(document.getElementById('visUserLabelSize').value) > 0,
            preLineStyle: document.getElementById('visUserPreLineStyle').getAttribute('data-value') || 'dashed',
            postLineStyle: document.getElementById('visUserPostLineStyle').getAttribute('data-value') || 'solid',
            nodeStyle: styleVal('visUserNodeStyle', 'circle'),
        },
        predictedOpts: {
            nodeSize: parseInt(document.getElementById('visPredNodeSize').value) || 4,
            lineWidth: parseInt(document.getElementById('visPredEdgeWeight').value) || 2,
            alpha: parseInt(document.getElementById('visPredEdgeTrans').value) / 100,
            showLabels: false,
            preLineStyle: document.getElementById('visPredPreLineStyle').getAttribute('data-value') || 'solid',
            postLineStyle: document.getElementById('visPredPostLineStyle').getAttribute('data-value') || 'solid',
            nodeStyle: styleVal('visPredNodeStyle', 'circle'),
        },
        reprojOpts: {
            nodeSize: parseInt(document.getElementById('visReprojNodeSize').value) || 4,
            lineWidth: parseInt(document.getElementById('visReprojEdgeWeight').value) || 2,
            alpha: parseInt(document.getElementById('visReprojEdgeTrans').value) / 100,
            brightness: parseInt(document.getElementById('visReprojBrightness').value) / 100,
            labelSize: parseInt(document.getElementById('visReprojLabelSize').value) || 11,
            labelAlpha: parseFloat(document.getElementById('visReprojLabelAlpha').value),
            showLabels: parseInt(document.getElementById('visReprojLabelSize').value) > 0,
            lineStyle: document.getElementById('visReprojLineStyle').getAttribute('data-value') || 'dotted',
            nodeStyle: styleVal('visReprojNodeStyle', 'x'),
        },
    };
}

export function drawAllOverlays(frameIdx) {
    if (!state.session) return;

    // Lazy H5: fetch frame data on demand if not yet loaded
    if (state.session.lazyLoader && !state.session.frameGroups.has(frameIdx)) {
        ensureLazyFrameData(frameIdx).then(function () {
            if (state.currentFrame === frameIdx) {
                drawAllOverlays(frameIdx);
            }
        });
        return;
    }

    // Auto-finish edit group mode on frame change
    if (editGroupState && frameIdx !== state.currentFrame) {
        finishEditGroup();
    }

    const frameGroup = state.session.getFrameGroup(frameIdx);
    const instanceGroups = getInstanceGroupsForFrame(frameIdx);

    // Lazily compute reprojections for groups that have points3d but no reprojected instances
    if (instanceGroups && state.session.cameras.length >= 2) {
        var _lazyFrameResults = null;
        for (var _rg = 0; _rg < instanceGroups.length; _rg++) {
            var _grp = instanceGroups[_rg];
            if (_grp.points3d && _grp.points3d.length > 0 &&
                (!_grp.reprojectedInstances || _grp.reprojectedInstances.size === 0) &&
                (!_grp.reprojections || Object.keys(_grp.reprojections).length === 0)) {
                var _triRes = triangulateAndReproject(_grp, state.session.cameras);
                _grp.reprojections = _triRes.reprojections;
                storeReprojectedInstances(_grp, _triRes, state.session.cameras);
                _grp.observedPoints = {};
                for (var _rc = 0; _rc < state.session.cameras.length; _rc++) {
                    var _cam = state.session.cameras[_rc];
                    var _inst = _grp.getInstance(_cam.name);
                    if (_inst) _grp.observedPoints[_cam.name] = _inst.points;
                }
                // Store in triangulationResults for info panel
                if (!_lazyFrameResults) _lazyFrameResults = [];
                _lazyFrameResults.push({
                    group: _grp,
                    points3d: _triRes.points3d,
                    reprojections: _triRes.reprojections,
                    errors: _triRes.errors,
                    meanError: _triRes.meanError,
                });
            }
        }
        if (_lazyFrameResults) {
            var _existing = state.triangulationResults.get(frameIdx) || [];
            state.triangulationResults.set(frameIdx, _existing.concat(_lazyFrameResults));
        }
    }

    var vis = getVisibilitySettings();

    // Get interaction state — only show selection highlight if the
    // selected group belongs to the current frame
    let selectedInstanceGroup = interactionManager ? interactionManager.selectedInstanceGroup : null;
    const selectedNodeIdx = interactionManager ? interactionManager.selectedNodeIdx : -1;
    if (selectedInstanceGroup) {
        const currentGroups = getInstanceGroupsForFrame(frameIdx);
        if (currentGroups.indexOf(selectedInstanceGroup) < 0) {
            selectedInstanceGroup = null;
        }
    }
    const hoveredNode = interactionManager ? interactionManager.hoveredNode : null;
    const dragInfo = interactionManager ? interactionManager.dragInfo : null;
    const assignmentMode = interactionManager ? interactionManager.assignmentMode : false;
    const assignmentSelectedIds = interactionManager ? interactionManager.getAssignmentSelectedIds() : [];
    const selectedUnlinked = interactionManager ? interactionManager.selectedUnlinked : null;

    // Update toolbar state
    var tbGroup = document.getElementById('tbGroup');
    var hasGroupedSelection = interactionManager && interactionManager.selectedInstanceGroup && !interactionManager.selectedReprojected;
    if (tbGroup) {
        if (hasGroupedSelection && !assignmentMode) {
            tbGroup.textContent = 'Ungroup';
            tbGroup.classList.add('active');
            tbGroup.disabled = false;
        } else {
            tbGroup.textContent = 'Group';
            // A group needs ≥2 instances. Disable + de-highlight
            // the button when exactly one is selected so the user
            // can't form a degenerate single-instance group.
            var oneAssignmentSelected = assignmentMode && assignmentSelectedIds.length === 1;
            tbGroup.classList.toggle('active', assignmentMode && !oneAssignmentSelected);
            tbGroup.disabled = oneAssignmentSelected;
        }
    }
    var tbEditGroup = document.getElementById('tbEditGroup');
    if (tbEditGroup) {
        var editGroupActive = interactionManager ? interactionManager.editGroupMode : false;
        tbEditGroup.classList.toggle('active', editGroupActive || hasGroupedSelection);
        // Disable when a reprojected instance is selected
        var isReprojSelected = interactionManager ? interactionManager.selectedReprojected : false;
        tbEditGroup.disabled = isReprojSelected;
    }

    var editGroupTarget = interactionManager ? interactionManager.editGroupTarget : null;

    for (const view of state.views) {
        if (!view.overlayCtx || !view.overlayCanvas) continue;

        // Resize overlay canvas to match zoom level for sharp rendering.
        // Higher internal resolution at higher zoom keeps sizes constant
        // in screen pixels: the CSS transform scales the display, and the
        // increased resolution compensates so drawn sizes don't change.
        var zs = view.zoom ? view.zoom.scale : 1;
        var targetW = Math.round(view.videoWidth * zs);
        var targetH = Math.round(view.videoHeight * zs);
        if (view.overlayCanvas.width !== targetW || view.overlayCanvas.height !== targetH) {
            view.overlayCanvas.width = targetW;
            view.overlayCanvas.height = targetH;
        }

        // Convert FrameGroup instances to the format expected by drawFrameOverlays
        let overlayFrameGroup = null;
        if (frameGroup) {
            overlayFrameGroup = {
                frameIdx: frameGroup.frameIdx,
                instances: {}
            };
            for (const [camName, instances] of frameGroup.instances) {
                overlayFrameGroup.instances[camName] = instances;
            }
        }

        // Get unlinked instances for this view, filtered by type visibility
        var viewUnlinked = [];
        if (frameGroup && (vis.showUser || vis.showPredicted)) {
            var allUnlinked = frameGroup.getUnlinkedInstances(view.name) || [];
            for (var _ui = 0; _ui < allUnlinked.length; _ui++) {
                var _ulType = allUnlinked[_ui].instance.type || 'user';
                if (_ulType === 'predicted' && vis.showPredicted) viewUnlinked.push(allUnlinked[_ui]);
                else if (_ulType !== 'predicted' && vis.showUser) viewUnlinked.push(allUnlinked[_ui]);
            }
        }

        drawFrameOverlays(view.overlayCtx, view.name, overlayFrameGroup, instanceGroups, state.session, {
            colorByIdentity: state.colorByIdentity,
            showLegend: vis.showLegend,
            showUser: vis.showUser,
            showPredicted: vis.showPredicted,
            showReprojected: vis.showReprojected,
            reprojNodeColor: vis.reprojNodeColor,
            showErrors: vis.showErrors,
            userOpts: vis.userOpts,
            predictedOpts: vis.predictedOpts,
            reprojOpts: vis.reprojOpts,
            videoWidth: view.videoWidth,
            videoHeight: view.videoHeight,
            canvasWidth: view.overlayCanvas.width,
            canvasHeight: view.overlayCanvas.height,
            selectedInstanceGroup: selectedInstanceGroup,
            selectedReprojected: interactionManager ? interactionManager.selectedReprojected : false,
            selectedNodeIdx: selectedNodeIdx,
            hoveredNode: hoveredNode,
            dragInfo: dragInfo,
            unlinkedInstances: viewUnlinked,
            assignmentSelectedIds: assignmentSelectedIds,
            assignmentMode: assignmentMode,
            selectedUnlinkedId: selectedUnlinked ? selectedUnlinked.id : null,
            editGroupTarget: editGroupTarget,
        });
    }

    // Update info panel with current frame stats
    updateFrameInfo(frameIdx, instanceGroups);

    // Update timeline current frame
    if (timeline) {
        timeline.setCurrentFrame(frameIdx);
    }
}

// ============================================
// Frame counters (status bar)
// ============================================

export function updateFrameCounters() {
    if (!state.session) return;

    // Determine active camera
    var activeCam = interactionManager ? interactionManager.lastInteractedView : null;
    if (!activeCam && state.views.length > 0) activeCam = state.views[0].name;

    var cameraEl = document.getElementById('statusCamera');
    if (cameraEl) cameraEl.textContent = 'Camera: ' + (activeCam || '-');

    var labeledCount = 0;
    var instanceCount = 0;
    var triangulatedCount = 0;

    state.session.frameGroups.forEach(function(fg, frameIdx) {
        // Per-camera: labeled if frame has a grouped/ungrouped UserInstance
        // or grouped PredictedInstance in this view
        var hasLabeled = false;
        if (activeCam) {
            // Check grouped instances for this camera
            var camInstances = fg.instances.get(activeCam) || [];
            for (var i = 0; i < camInstances.length; i++) {
                var t = camInstances[i].type || 'user';
                if (t === 'user') {
                    hasLabeled = true;
                    instanceCount++;
                } else if (t === 'predicted') {
                    hasLabeled = true;
                }
            }
            // Check ungrouped UserInstances for this camera
            var ulInstances = fg.getUnlinkedInstances(activeCam);
            for (var u = 0; u < ulInstances.length; u++) {
                var ulType = ulInstances[u].instance.type || 'user';
                if (ulType === 'user') {
                    hasLabeled = true;
                    instanceCount++;
                }
            }
        }
        if (hasLabeled) labeledCount++;

        // Triangulated: frame has at least one InstanceGroup with points3d
        var frameGroupsList = state.session.instanceGroups.get(frameIdx) || [];
        for (var g = 0; g < frameGroupsList.length; g++) {
            if (frameGroupsList[g].points3d) { triangulatedCount++; break; }
        }
    });

    var labeledEl = document.getElementById('statusLabeledFrames');
    var triangulatedEl = document.getElementById('statusTriangulatedFrames');
    var instancesEl = document.getElementById('statusInstances');
    if (labeledEl) labeledEl.textContent = 'Labeled Frames: ' + labeledCount;
    if (instancesEl) instancesEl.textContent = 'Instances: ' + instanceCount;
    if (triangulatedEl) triangulatedEl.textContent = 'Triangulated: ' + triangulatedCount;
}
