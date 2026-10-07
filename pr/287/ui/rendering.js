// ui/rendering.js — overlay drawing, visibility settings, frame counters
// Pass 3d-1 extraction. Holds the canvas overlay-rendering pipeline:
// - getVisibilitySettings: collects user-controlled visibility/style settings from the DOM.
// - drawAllOverlays: per-frame multi-view overlay rendering (calls drawFrameOverlays).
// - setReprojErrorVisible: toggles reprojection-error column visibility in info panels.
// - updateFrameCounters: status-bar frame counters (labeled / triangulated / instances),
//   whole-project on a lazy project too (counting logic in ui/frame-counters.js).

import { state, interactionManager, timeline } from './app-state.js?v=549b33057c62';
import { points3dNodeCount } from '../pose/pose-data.js?v=549b33057c62';
import {
    ensureLazyFrameData, getInstanceGroupsForFrame,
    triangulateAndReproject, storeReprojectedInstances,
} from '../pose/triangulation.js?v=549b33057c62';
import { drawFrameOverlays } from './overlays.js?v=549b33057c62';
import { syncViewLegends } from './view-legend.js?v=549b33057c62';
import { isCameraTracked } from './settings.js?v=549b33057c62';
// Plane placements draw on the same overlay canvas, so they must run AFTER
// drawFrameOverlays (which opens with a clearRect). Circular import — safe
// because the call site is inside drawAllOverlays' body.
import { drawPlaneOverlays, applyPlaneModeToolbarLock } from './plane-definition.js?v=549b33057c62';

// Pass 3f: editGroupState + finishEditGroup moved to ui/identity-assignment.js.
import { editGroupState, finishEditGroup } from './identity-assignment.js?v=549b33057c62';
import { updateFrameInfo } from './info-panel.js?v=549b33057c62';
import {
    computeFrameCounterBaseline, computeLazyCameraBaseline, createFrameCounterBaselineBuilder,
    countFrameCounters, nonResidentCameraCounts,
} from './frame-counters.js?v=549b33057c62';

// ============================================
// Reproj/Error visibility
// ============================================

/**
 * Show / hide the reprojection-error UI (Info Panel section + error columns).
 * Showing it also ticks the toolbar's Reproj and Errors boxes — unless
 * `opts.checkBoxes === false`, which the Triangulate All paths pass because
 * they set the boxes themselves via `showReprojectionsOnly` (#243). Ticking
 * Errors here first would make every run look like a change (and flicker it).
 */
export function setReprojErrorVisible(visible, opts) {
    var display = visible ? '' : 'none';
    var el = document.getElementById('reprojErrorSection');
    if (el) el.style.display = display;
    // Error column header and cells
    var cols = document.querySelectorAll('.reproj-error-col');
    for (var i = 0; i < cols.length; i++) {
        cols[i].style.display = display;
    }
    // Check the checkboxes when triangulation data is available
    if (visible && !(opts && opts.checkBoxes === false)) {
        var reproj = document.getElementById('visReprojections');
        if (reproj) reproj.checked = true;
        var errors = document.getElementById('visErrors');
        if (errors) errors.checked = true;
    }
}

/**
 * After Triangulate All (#243): the next job is proofreading the 3D, so show
 * the reprojections and hide what competes with them — User, Predicted and
 * Errors off, Reproj on (the toolbar checkboxes). Each change fires the
 * checkbox's own `change` event, exactly as a click would, so the existing
 * handler deselects an instance whose type just got hidden and redraws.
 *
 * Pair it with `setReprojErrorVisible(true, { checkBoxes: false })` so the
 * boxes are compared with what the USER had, not with Errors just re-ticked.
 *
 * @returns {boolean} whether any checkbox changed (for the status line)
 */
export function showReprojectionsOnly() {
    return setToolbarLayers([['visUser', false], ['visPredicted', false], ['visErrors', false], ['visReprojections', true]]);
}

// Suffix for a Triangulate All status line when `showReprojectionsOnly` hid
// anything, so the user knows where User / Predicted went.
export var REPROJ_ONLY_NOTE = ' · showing Reproj only (toolbar)';

/**
 * After Track Frame / Track Frame Range / Track All: the run's product is the
 * tracked PREDICTIONS (now colored by identity), so show only those — Predicted
 * on; User, Reproj and Errors off. Same mechanics as `showReprojectionsOnly`
 * (each box fires its own `change` event). Returns whether anything changed.
 */
export function showPredictedOnly() {
    return setToolbarLayers([['visUser', false], ['visPredicted', true], ['visReprojections', false], ['visErrors', false]]);
}

// Suffix for a tracking status line when `showPredictedOnly` changed anything.
export var PREDICTED_ONLY_NOTE = ' · showing Predicted only (toolbar)';

/** Set toolbar layer checkboxes `[[id, checked], …]` as clicks would; true if any changed. */
function setToolbarLayers(want) {
    var changed = false;
    for (var i = 0; i < want.length; i++) {
        var el = document.getElementById(want[i][0]);
        if (!el || el.checked === want[i][1]) continue;
        el.checked = want[i][1];
        el.dispatchEvent(new Event('change', { bubbles: true }));
        changed = true;
    }
    return changed;
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
    // Same tolerance as styleVal, for checkboxes added after the fact: the
    // headless runners build a partial DOM, and a bare `.checked` on a missing
    // element throws and takes the whole render down.
    function checkVal(id, fallback) {
        var el = document.getElementById(id);
        return el ? el.checked : fallback;
    }
    return {
        showLegend: document.getElementById('visLegend').checked,
        showUser: document.getElementById('visUser').checked,
        showPredicted: document.getElementById('visPredicted').checked,
        showReprojected: document.getElementById('visReprojections').checked,
        reprojNodeColor: document.getElementById('visReprojNodeColor').getAttribute('data-value') || 'white',
        showErrors: document.getElementById('visErrors').checked,
        // The "?" badge on unlinked instances. Defaults TRUE when the control is
        // absent, so the affordance is never lost by accident.
        showUnlinkedBadge: checkVal('visUnlinkedBadge', true),
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
            nodeSize: parseInt(document.getElementById('visPredNodeSize').value) || 6,
            lineWidth: parseInt(document.getElementById('visPredEdgeWeight').value) || 2,
            alpha: parseInt(document.getElementById('visPredEdgeTrans').value) / 100,
            showLabels: false,
            preLineStyle: document.getElementById('visPredPreLineStyle').getAttribute('data-value') || 'solid',
            postLineStyle: document.getElementById('visPredPostLineStyle').getAttribute('data-value') || 'solid',
            nodeStyle: styleVal('visPredNodeStyle', 'x'),
        },
        reprojOpts: {
            nodeSize: parseInt(document.getElementById('visReprojNodeSize').value) || 4,
            lineWidth: parseInt(document.getElementById('visReprojEdgeWeight').value) || 2,
            alpha: parseInt(document.getElementById('visReprojEdgeTrans').value) / 100,
            brightness: parseInt(document.getElementById('visReprojBrightness').value) / 100,
            labelSize: parseInt(document.getElementById('visReprojLabelSize').value) || 11,
            labelAlpha: parseFloat(document.getElementById('visReprojLabelAlpha').value),
            showLabels: parseInt(document.getElementById('visReprojLabelSize').value) > 0,
            lineStyle: document.getElementById('visReprojLineStyle').getAttribute('data-value') || 'solid',
            nodeStyle: styleVal('visReprojNodeStyle', 'circle'),
        },
    };
}

// Throttle window (ms) for the info-panel + timeline playhead updates during
// playback — see the coalescing note at the bottom of drawAllOverlays.
let _lastAuxUpdate = 0;
const AUX_UPDATE_MS = 100;

// Lazily compute reprojections for groups that have points3d but no
// reprojected instances, on frame `fi` (whose groups are `instanceGroups`).
// Runs for every frame drawAllOverlays draws — during playback the views can
// be on different frames (see its `viewFrames`).
function fillLazyReprojections(fi, instanceGroups) {
    if (instanceGroups && state.session.cameras.length >= 2) {
        var _lazyFrameResults = null;
        for (var _rg = 0; _rg < instanceGroups.length; _rg++) {
            var _grp = instanceGroups[_rg];
            if (points3dNodeCount(_grp.points3d) > 0 &&
                (!_grp.reprojectedInstances || _grp.reprojectedInstances.size === 0) &&
                (!_grp.reprojections || Object.keys(_grp.reprojections).length === 0)) {
                // Re-solve with WHICHEVER METHOD this group was last triangulated
                // with — same precondition as `reTriangulateGroup`. Passing no
                // options makes the dispatcher silently default to 'dlt', which is
                // how "Triangulate All ▸ Bundle Adjustment" appeared to do nothing:
                // the windowed sweep deliberately drops `reprojections` /
                // `state.triangulationResults` project-wide (~1.9 GB at 531,799
                // groups — see sweepTriangulateAllFrames' docstring), so this fill
                // is the ONLY thing that repopulates them, and a DLT re-solve here
                // overwrote BA's error with DLT's while `group.triangulationMethod`
                // still made the panel label it "Bundle Adjustment".
                var _m = (_grp.triangulationMethod === 'ba') ? 'ba' : 'dlt';
                var _triRes = triangulateAndReproject(_grp, state.session.cameras, { method: _m });
                _grp.reprojections = _triRes.reprojections;
                storeReprojectedInstances(_grp, _triRes, state.session.cameras);
                // Store in triangulationResults for info panel. `method` is carried
                // through so the panel's method label comes from the solve that
                // actually produced these numbers rather than falling back to
                // `group.triangulationMethod` (which is what let the two disagree).
                if (!_lazyFrameResults) _lazyFrameResults = [];
                _lazyFrameResults.push({
                    group: _grp,
                    points3d: _triRes.points3d,
                    reprojections: _triRes.reprojections,
                    errors: _triRes.errors,
                    errorsUndistorted: _triRes.errorsUndistorted,
                    meanError: _triRes.meanError,
                    meanErrorUndistorted: _triRes.meanErrorUndistorted,
                    method: _triRes.method,
                });
            }
        }
        if (_lazyFrameResults) {
            var _existing = state.triangulationResults.get(fi) || [];
            state.triangulationResults.set(fi, _existing.concat(_lazyFrameResults));
        }
    }
}

/**
 * Redraw every view's pose overlay.
 *
 * @param {number} frameIdx - the frame being shown (drives selection, the info
 *   panel, timeline, legend and the lazy-load gate).
 * @param {Object<string, number>} [viewFrames] - optional per-view frame
 *   indices, `{ viewName: frameIdx }`. Playback passes the frame each view's
 *   canvas ACTUALLY shows (from its captured VideoFrame — see
 *   `VideoController.startPlayback`), which can differ from `frameIdx` by a
 *   frame or two across cameras; each view's overlay is then drawn for its own
 *   frame so skeleton and video always agree. A view whose frame is not
 *   hydrated (lazy project) falls back to `frameIdx`. Omitted = every view at
 *   `frameIdx` (seek / step / edits).
 */
export function drawAllOverlays(frameIdx, viewFrames) {
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

    fillLazyReprojections(frameIdx, instanceGroups);

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
    // Defining Plane Mode blocks the pose-annotation buttons, and the two
    // above are recomputed on EVERY overlay draw — so the lock is re-asserted
    // here rather than only at `enterPlaneMode`, where it would survive until
    // the first mouse move. A no-op when the mode is off.
    applyPlaneModeToolbarLock();

    var editGroupTarget = interactionManager ? interactionManager.editGroupTarget : null;

    // Frames other than `frameIdx` that this call draws (per-view playback
    // frames), each needing the same lazy reprojection fill — done once each.
    var filledFrames = null;

    for (const view of state.views) {
        if (!view.overlayCtx || !view.overlayCanvas) continue;

        // This view's frame: during playback, the frame ITS canvas shows
        // (`viewFrames`); otherwise — or if that frame isn't hydrated in a lazy
        // project — the shared `frameIdx`.
        var vFrameGroup = frameGroup, vGroups = instanceGroups, vSelected = selectedInstanceGroup;
        var vFrame = viewFrames ? viewFrames[view.name] : undefined;
        if (vFrame != null && vFrame !== frameIdx &&
            !(state.session.lazyLoader && !state.session.frameGroups.has(vFrame))) {
            vFrameGroup = state.session.getFrameGroup(vFrame);
            vGroups = getInstanceGroupsForFrame(vFrame);
            if (!filledFrames) filledFrames = new Set();
            if (!filledFrames.has(vFrame)) { filledFrames.add(vFrame); fillLazyReprojections(vFrame, vGroups); }
            // Highlight the selection only where it exists on this view's frame.
            if (vSelected && (!vGroups || vGroups.indexOf(vSelected) < 0)) vSelected = null;
        }

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

        // Backing pixels per CSS pixel, for labels (the one screen-relative
        // size). Derived from the canvas's LAYOUT width times the zoom scale —
        // deliberately NOT getBoundingClientRect(), which reports the rotated
        // element's axis-aligned bounding box and so would shrink every label
        // whenever Video Rotation is non-zero. The zoom factor must stay in:
        // the backing store already grew by `zs` above, so dropping it would
        // make labels grow with zoom instead of holding a fixed point size.
        var cssW = view.overlayCanvas.offsetWidth;
        if (!cssW) {
            // Detached / not laid out yet. Only an explicit px inline width is
            // usable here — the stylesheet gives `.overlay-canvas` width:100%,
            // and parseFloat('100%') would happily hand back 100.
            var inlineW = view.overlayCanvas.style.width || '';
            if (/px\s*$/.test(inlineW)) cssW = parseFloat(inlineW) || 0;
        }
        var displayW = cssW * zs;
        var labelDisplayScale = displayW > 0 ? targetW / displayW : 1;

        // Labels cancel the view's rotation so they read horizontally (issue
        // #162). Quantized to whole degrees: the Shift+R+Arrow chord advances
        // `view.rotation` by a FRACTIONAL amount every animation frame, and the
        // redraw that keeps labels upright is triggered off this same rounded
        // value changing (ui/ui-wiring.js), so drawing the rounded angle is
        // what makes the two agree. The residual is under half a degree.
        var labelRotation = Math.round(view.rotation || 0);

        // Convert FrameGroup instances to the format expected by drawFrameOverlays
        let overlayFrameGroup = null;
        if (vFrameGroup) {
            overlayFrameGroup = {
                frameIdx: vFrameGroup.frameIdx,
                instances: {}
            };
            for (const [camName, instances] of vFrameGroup.instances) {
                overlayFrameGroup.instances[camName] = instances;
            }
        }

        // Get unlinked instances for this view, filtered by type visibility
        var viewUnlinked = [];
        if (vFrameGroup && (vis.showUser || vis.showPredicted)) {
            var allUnlinked = vFrameGroup.getUnlinkedInstances(view.name) || [];
            for (var _ui = 0; _ui < allUnlinked.length; _ui++) {
                var _ulType = allUnlinked[_ui].instance.type || 'user';
                if (_ulType === 'predicted' && vis.showPredicted) viewUnlinked.push(allUnlinked[_ui]);
                else if (_ulType !== 'predicted' && vis.showUser) viewUnlinked.push(allUnlinked[_ui]);
            }
        }

        drawFrameOverlays(view.overlayCtx, view.name, overlayFrameGroup, vGroups, state.session, {
            colorByIdentity: state.colorByIdentity,
            trailLength: state.trailLength,
            // NOT vis.showLegend: the live legend is pane chrome now
            // (`syncViewLegends`, below), because anything painted on this
            // canvas rotates with the view. `drawFrameOverlays` keeps the
            // option for the overlay-video export, which has no DOM to use.
            showLegend: false,
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
            labelDisplayScale: labelDisplayScale,
            labelRotation: labelRotation,
            selectedInstanceGroup: vSelected,
            selectedReprojected: interactionManager ? interactionManager.selectedReprojected : false,
            selectedNodeIdx: selectedNodeIdx,
            hoveredNode: hoveredNode,
            dragInfo: dragInfo,
            unlinkedInstances: viewUnlinked,
            showUnlinkedBadge: vis.showUnlinkedBadge,
            assignmentSelectedIds: assignmentSelectedIds,
            assignmentMode: assignmentMode,
            selectedUnlinkedId: selectedUnlinked ? selectedUnlinked.id : null,
            editGroupTarget: editGroupTarget,
            trackingExcluded: !isCameraTracked(view.name),
        });

        // Annotated planes (View ▸ Define Planes). Frame-independent, so they
        // are drawn on every frame regardless of the current FrameGroup.
        drawPlaneOverlays(view);
    }

    // The legend lives in the pane, outside the rotating `.canvas-wrapper`, so
    // it stays upright and anchored to the VIEW rather than to the video box.
    // Driven from here so it follows exactly the triggers the overlays do — the
    // Display Legend checkbox handler already ends in a redraw.
    syncViewLegends(vis.showLegend, {
        showDetected: vis.showUser || vis.showPredicted,
        showReprojected: vis.showReprojected,
        showErrors: vis.showErrors,
    });

    // Update info panel with current frame stats + the timeline playhead.
    // During playback these are THROTTLED to ~10 Hz: `updateFrameInfo` rebuilds
    // info-panel DOM and re-aggregates reprojection errors, and
    // `timeline.setCurrentFrame` does a full timeline-canvas `redraw()` — both
    // per frame. A human can't read either at playback speed, and doing them
    // every frame is a major per-frame cost that caps buffered playback fps.
    // The skeleton overlays + video above still update every frame, so tracking
    // stays smooth and frame-accurate; only these two auxiliary updates coalesce.
    // When paused (seek/step) they always run so the panel/playhead are exact.
    var _auxNow = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (!state.isPlaying || (_auxNow - _lastAuxUpdate) >= AUX_UPDATE_MS) {
        _lastAuxUpdate = _auxNow;
        updateFrameInfo(frameIdx, instanceGroups);
        // While playing, only the playhead moves: let the timeline blit its
        // cached track/marker layer instead of a full redraw (ui/timeline.js).
        if (timeline) timeline.setCurrentFrame(frameIdx, state.isPlaying ? { playback: true } : undefined);
    }
}

// ============================================
// Frame counters (status bar)
// ============================================

// Whole-project baselines for the counters (see ui/frame-counters.js), one per
// session: `{ loader, tri, cams: Map<camera, half>, lastFrame }`. A WeakMap so
// a closed project's baseline — and the session and store it was read from — is
// never kept alive by the status bar.
var _counterBaselines = new WeakMap();
// Rebuild this long after the last redraw that asked for one: coalesces a drag
// or a burst of edits into one rebuild, and lands well before anyone reads the
// counter after a bulk operation.
var COUNTER_REBUILD_DELAY_MS = 250;
// Frames per rebuild slice (a few ms each on a real project), so a rebuild never
// holds the page for the ~100 ms a 108,000-frame x 8-camera one takes in total.
var COUNTER_REBUILD_STEP = 8192;
// `pending`: asked for and not yet installed — survives a rebuild abandoned to
// playback, so the next paused update finishes the job.
var _counterRebuild = { timer: 0, running: false, again: false, pending: false };

function counterCamera() {
    var cam = interactionManager ? interactionManager.lastInteractedView : null;
    if (!cam && state.views.length > 0) cam = state.views[0].name;
    return cam || null;
}

/**
 * Give `baseline` a camera half for `cam` if it has none — synchronously, since
 * without it the count would be the resident window, the very number this
 * replaces. Once per view per session, or after a bulk change dropped it.
 */
function ensureCameraHalf(session, baseline, cam) {
    if (!cam || !session.lazyLoader || baseline.cams.has(cam)) return;
    var half = computeLazyCameraBaseline(session, cam);
    if (half) baseline.cams.set(cam, half);
}

function renderFrameCounters(session, activeCam, baseline) {
    var c = countFrameCounters(session, activeCam, baseline);
    var labeledEl = document.getElementById('statusLabeledFrames');
    var triangulatedEl = document.getElementById('statusTriangulatedFrames');
    var instancesEl = document.getElementById('statusInstances');
    if (labeledEl) labeledEl.textContent = 'Labeled Frames: ' + c.labeled;
    if (instancesEl) instancesEl.textContent = 'Instances: ' + c.instances;
    if (triangulatedEl) triangulatedEl.textContent = 'Triangulated: ' + c.triangulated;
}

function requestCounterRebuild() {
    _counterRebuild.pending = true;
    if (_counterRebuild.running) { _counterRebuild.again = true; return; }
    if (_counterRebuild.timer) clearTimeout(_counterRebuild.timer);
    _counterRebuild.timer = setTimeout(runCounterRebuild, COUNTER_REBUILD_DELAY_MS);
}

function runCounterRebuild() {
    _counterRebuild.timer = 0;
    var session = state.session;
    // Playback skips the counters (`updateStatusBarForFrame`); the redraw that
    // stops it sees `pending` and asks again.
    if (!session || state.isPlaying) return;
    var cam = counterCamera();
    var builder = createFrameCounterBaselineBuilder(session, cam);
    _counterRebuild.running = true;
    _counterRebuild.again = false;
    var slice = function () {
        if (state.session !== session || state.isPlaying) {
            _counterRebuild.timer = 0;
            _counterRebuild.running = false;   // abandoned; `pending` stays set
            return;
        }
        if (!builder.step(COUNTER_REBUILD_STEP)) {
            _counterRebuild.timer = setTimeout(slice, 0);
            return;
        }
        _counterRebuild.timer = 0;
        _counterRebuild.running = false;
        _counterRebuild.pending = false;
        var prev = _counterBaselines.get(session);
        var next = builder.result;
        next.loader = session.lazyLoader;
        if (prev && prev.loader === next.loader) {
            next.lastFrame = prev.lastFrame;
            // The other views' halves can only be behind on frames that changed
            // while NOT resident — a bulk operation. If this view's own
            // non-resident part moved, one happened: drop them, so each is
            // rebuilt exactly when its view is next active instead of showing a
            // pre-operation count until then. An edit to the current frame
            // moves only resident frames, so annotating keeps view switches free.
            var oldHalf = prev.cams.get(cam), newHalf = next.cams.get(cam);
            var bulkChange = false;
            if (oldHalf && newHalf) {
                var a = nonResidentCameraCounts(session, oldHalf);
                var b = nonResidentCameraCounts(session, newHalf);
                bulkChange = a.labeled !== b.labeled || a.instances !== b.instances;
            }
            if (!bulkChange) {
                prev.cams.forEach(function (half, c) { if (!next.cams.has(c)) next.cams.set(c, half); });
            }
        }
        _counterBaselines.set(session, next);
        var shownCam = counterCamera();   // the view may have changed mid-build
        ensureCameraHalf(session, next, shownCam);
        renderFrameCounters(session, shownCam, next);
        if (_counterRebuild.again) requestCounterRebuild();
    };
    slice();
}

/**
 * Status-bar counters: Labeled Frames and Instances for the active camera, and
 * Triangulated, all over the WHOLE project.
 *
 * On a lazy project most frames are not resident, so the count is the live
 * count of the resident frames plus a cached whole-project baseline for the
 * rest (`countFrameCounters`) — O(resident frames) per call, like the
 * resident-only count it replaced. Building the baseline is a walk of every
 * frame's groups (~100 ms on a 108,000-frame x 8-camera project), so:
 *
 * - It is built SYNCHRONOUSLY only when there is none: the first update of a
 *   session (or after its lazy loader changes), and the first time a view
 *   becomes active (its camera half).
 * - Otherwise it is REBUILT in the background, in slices, shortly after a
 *   redraw of the SAME frame as the previous update. Every operation that
 *   changes data redraws the current frame — an edit, Track All, Triangulate
 *   All, a session-wide delete — so the counts follow all of them without each
 *   having to invalidate anything (Track All does not even mark the project
 *   dirty). A redraw on a NEW frame is navigation, which changes no data:
 *   stepping and scrubbing cost no whole-project work at all.
 * - An edit to the current frame needs no rebuild to show: the current frame is
 *   resident, and resident frames are always counted live.
 */
export function updateFrameCounters() {
    var session = state.session;
    if (!session) return;

    var activeCam = counterCamera();
    var cameraEl = document.getElementById('statusCamera');
    if (cameraEl) cameraEl.textContent = 'Camera: ' + (activeCam || '-');

    var baseline = _counterBaselines.get(session);
    var fresh = false;
    if (!baseline || baseline.loader !== session.lazyLoader) {
        baseline = computeFrameCounterBaseline(session, activeCam);
        baseline.loader = session.lazyLoader;
        _counterBaselines.set(session, baseline);
        fresh = true;
    } else {
        ensureCameraHalf(session, baseline, activeCam);
    }
    renderFrameCounters(session, activeCam, baseline);

    var sameFrame = baseline.lastFrame === state.currentFrame;
    baseline.lastFrame = state.currentFrame;
    if (!fresh && (sameFrame || _counterRebuild.pending)) requestCounterRebuild();
}
