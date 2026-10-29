// ui/rendering.js — overlay drawing, visibility settings, frame counters
// Pass 3d-1 extraction. Holds the canvas overlay-rendering pipeline:
// - getVisibilitySettings: collects user-controlled visibility/style settings from the DOM.
// - drawAllOverlays: per-frame multi-view overlay rendering (calls drawFrameOverlays).
// - setReprojErrorVisible: toggles reprojection-error column visibility in info panels.
// - updateFrameCounters: status-bar frame counters (labeled / triangulated / instances),
//   whole-project on a lazy project too (counting logic in ui/frame-counters.js).

import { state, interactionManager, timeline, isViewDocked } from './app-state.js?v=3dc23012ccdb';
import { points3dNodeCount, isPoints3dFromFile, isPoints3dSmoothed } from '../pose/pose-data.js?v=3dc23012ccdb';
import {
    ensureLazyFrameData, ensureLazyTrailWindow, getInstanceGroupsForFrame,
    triangulateAndReproject, reprojectStoredPoints3d, storeReprojectedInstances,
} from '../pose/triangulation.js?v=3dc23012ccdb';
import { dropDerivedReprojections } from '../pose/lazy-residency.js?v=3dc23012ccdb';
import { drawFrameOverlays } from './overlays.js?v=3dc23012ccdb';
import { syncViewLegends } from './view-legend.js?v=3dc23012ccdb';
import { isCameraTracked, getTrackingThreshold } from './settings.js?v=3dc23012ccdb';
// Plane placements draw on the same overlay canvas, so they must run AFTER
// drawFrameOverlays (which opens with a clearRect). Circular import — safe
// because the call site is inside drawAllOverlays' body.
import { drawPlaneOverlays, applyPlaneModeToolbarLock } from './plane-definition.js?v=3dc23012ccdb';
// The toolbar's Animals field shows the ACTIVE session's count. Circular
// (it reaches pose/tracker.js, which imports this module) — safe for the same
// reason: the call site is inside drawAllOverlays' body.
import { syncAnimalCountField } from './animal-count-field.js?v=3dc23012ccdb';
import { syncNodeTooltipFrame } from './node-tooltip.js?v=3dc23012ccdb';
import { syncSmoothingButton } from './smoothing-button.js?v=3dc23012ccdb';
import { syncRunButtons } from './run-buttons.js?v=3dc23012ccdb';

// Pass 3f: editGroupState + finishEditGroup moved to ui/identity-assignment.js.
import { editGroupState, finishEditGroup } from './identity-assignment.js?v=3dc23012ccdb';
import { updateFrameInfo } from './info-panel.js?v=3dc23012ccdb';
import {
    computeFrameCounterBaseline, computeLazyCameraBaseline, createFrameCounterBaselineBuilder,
    countFrameCounters, nonResidentCameraCounts, refreshCountedFrame,
} from './frame-counters.js?v=3dc23012ccdb';

// ============================================
// Reproj/Error visibility
// ============================================

/**
 * Show / hide the reprojection-error UI (Info Panel section + error columns).
 * Showing it also ticks the toolbar's Reprojections and Errors boxes — unless
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
 * Errors off, Reprojections on (the toolbar checkboxes). Each change fires the
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
// anything, so the user knows where User / Predictions went.
export var REPROJ_ONLY_NOTE = ' · showing Reprojections only (toolbar)';

/**
 * After Track Frame / Track Frame Range / Track All: the run's product is the
 * tracked PREDICTIONS (now colored by identity), so show only those — Predictions
 * on; User, Reprojections and Errors off. Same mechanics as `showReprojectionsOnly`
 * (each box fires its own `change` event). Returns whether anything changed.
 */
export function showPredictedOnly() {
    return setToolbarLayers([['visUser', false], ['visPredicted', true], ['visReprojections', false], ['visErrors', false]]);
}

// Suffix for a tracking status line when `showPredictedOnly` changed anything.
export var PREDICTED_ONLY_NOTE = ' · showing Predictions only (toolbar)';

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

// Hard limits on the overlay backing store (luc3d #200). Chrome refuses a
// canvas past 16384 px on a side or 2^28 px of area, and refuses it SILENTLY:
// `canvas.width` reads back as the size you asked for, every draw call
// succeeds, and the pixels come back transparent — so the entire annotation
// overlay disappears with nothing in the console. Clamped in drawAllOverlays.
const MAX_OVERLAY_DIM = 16384;
const MAX_OVERLAY_AREA = 268435456; // 2^28 px

// Lazily compute reprojections for groups that have points3d but no
// reprojected instances, on frame `fi` (whose groups are `instanceGroups`).
// Runs for every frame drawAllOverlays draws — during playback the views can
// be on different frames (see its `viewFrames`).
//
// Neither Triangulate All path keeps reprojections or per-frame results for
// the project (see `sweepTriangulateAllFrames`' docstring in
// pose/triangulation.js), so after one this fill is what produces them, one
// shown frame at a time. Two things keep that cheap:
//  - **It reprojects the stored 3D rather than re-solving**
//    (`reprojectStoredPoints3d`) whenever that 3D is current: the group was
//    triangulated (`triangulationMethod` set), has not been edited since
//    (`dirty` clear), and no reprojection-error threshold is set (with one the
//    solve drops observations the stored 3D does not record, and its
//    undistorted error leaves them out). Measured on a 17-camera project:
//    0.1 ms per frame with one animal and 0.2 ms with three, against 2.4 and
//    5.0 ms to re-solve Refined — at 120 fps a frame has 8.3 ms. 3D READ
//    FROM A FILE (`isPoints3dFromFile`: a loaded `.slp`'s, an imported
//    points3d `.h5`'s) is reprojected whenever the group is clean, threshold
//    or not, and with or without a method: a re-solve would show LUCID's
//    answer rather than the 3D the project holds. SMOOTHED 3D
//    (`isPoints3dSmoothed`) is reprojected the same way, or the display would
//    re-solve the unsmoothed answer from the 2D. Any other group (Track
//    All's provisional 3D, an edited group) is re-solved, as before.
//  - **It keeps what it made for at most DERIVED_FRAMES_KEEP frames per
//    session** (`noteDerivedFrame`), dropping the least recently filled
//    beyond that, so playing through the whole recording does not rebuild
//    the per-frame state Triangulate All no longer keeps.
//
// The paths that used to derive this state for EVERY frame they touched now
// leave it to this fill: both Triangulate All paths, the `.slp` load
// (`handleLoadSlpFile`), moving a view between sessions
// (`moveVideosToSession`), and the overlay video export, which calls it for
// each frame it draws so the video shows exactly what the app shows.
export function fillLazyReprojections(fi, instanceGroups) {
    if (instanceGroups && state.session.cameras.length >= 2) {
        var _lazyFrameResults = null;
        var _threshold = null;
        for (var _rg = 0; _rg < instanceGroups.length; _rg++) {
            var _grp = instanceGroups[_rg];
            if (points3dNodeCount(_grp.points3d) > 0 &&
                (!_grp.reprojectedInstances || _grp.reprojectedInstances.size === 0) &&
                (!_grp.reprojections || Object.keys(_grp.reprojections).length === 0)) {
                if (_threshold == null) _threshold = getTrackingThreshold('reprojErrorThreshold') || 0;
                var _triRes;
                if (!_grp.dirty && (isPoints3dFromFile(_grp.points3d) || isPoints3dSmoothed(_grp.points3d) ||
                    (_grp.triangulationMethod != null && !(_threshold > 0)))) {
                    _triRes = reprojectStoredPoints3d(_grp, state.session.cameras);
                } else {
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
                    _triRes = triangulateAndReproject(_grp, state.session.cameras, { method: _m });
                }
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
            noteDerivedFrame(state.session, fi);
        }
    }
}

/**
 * Most frames whose derived reprojection state the fill keeps per session.
 * About 75 KB a frame per animal on a 17-camera, 34-node project (the
 * reprojections, the reprojected instances and the per-camera errors), so 600
 * frames is ~45 MB per animal there — 5 s of 120 fps playback, and every frame
 * stepped through recently is still a cache hit.
 */
export const DERIVED_FRAMES_KEEP = 600;
// session -> Map(frameIdx -> true), least recently filled first
const _derivedFrames = new WeakMap();

/**
 * Record that the fill derived reprojection state for frame `fi`, and drop
 * the least recently filled frames' beyond DERIVED_FRAMES_KEEP
 * (`dropDerivedReprojections`; the fill re-derives a frame's when it is shown
 * again). Never drops the frame on screen, nor a frame holding an edited
 * group (`dirty`): an edited group deliberately keeps showing its old
 * reprojections until it is re-triangulated, and a re-derive would replace
 * them with a fresh solve. Exported for tests.
 */
export function noteDerivedFrame(session, fi) {
    var lru = _derivedFrames.get(session);
    if (!lru) { lru = new Map(); _derivedFrames.set(session, lru); }
    lru.delete(fi);
    lru.set(fi, true);
    if (lru.size <= DERIVED_FRAMES_KEEP) return;
    for (var old of lru.keys()) {
        if (lru.size <= DERIVED_FRAMES_KEEP) break;
        if (old === fi || old === state.currentFrame) continue;
        lru.delete(old);
        if (!frameHasDirtyGroup(session, old)) dropDerivedReprojections(session, old, state.triangulationResults);
    }
}

function frameHasDirtyGroup(session, fi) {
    var groups = session.instanceGroups ? session.instanceGroups.get(fi) : null;
    if (groups) for (var i = 0; i < groups.length; i++) if (groups[i].dirty) return true;
    return false;
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

    // A node tooltip names a node on the frame it was hovered on; on any other
    // frame that node has moved out from under the pointer.
    syncNodeTooltipFrame(frameIdx);

    // Lazy H5: fetch frame data on demand if not yet loaded
    if (state.session.lazyLoader && !state.session.frameGroups.has(frameIdx)) {
        ensureLazyFrameData(frameIdx).then(function () {
            if (state.currentFrame === frameIdx) {
                drawAllOverlays(frameIdx);
            }
        });
        return;
    }

    // Node trails draw resident frames only, and a seek hydrates the frames
    // ahead of its target, not behind it — so hydrate the trail's window first.
    // A no-op on every playback frame (those frames were just played).
    if (state.trailLength > 0 && state.session.lazyLoader) {
        // Worker-backed loader: one request at a time, so on landing redraw
        // whatever frame is on screen NOW — after another jump that redraw is
        // what requests the new frame's window.
        var trailLoad = ensureLazyTrailWindow(frameIdx, state.trailLength);
        if (trailLoad) trailLoad.then(function (n) {
            if (n > 0) drawAllOverlays(state.currentFrame);
        });
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
    // Group and Edit Group live in the Group hover menu: its button turns blue
    // whenever either item is, so the mode shows without opening the menu.
    var tbGroupMenu = document.getElementById('tbGroupMenu');
    if (tbGroupMenu) {
        tbGroupMenu.classList.toggle('active',
            !!(tbGroup && tbGroup.classList.contains('active')) ||
            !!(tbEditGroup && tbEditGroup.classList.contains('active')));
    }
    syncSmoothingButton();
    syncRunButtons();
    // Defining Plane Mode blocks the pose-annotation buttons, and the two
    // above are recomputed on EVERY overlay draw — so the lock is re-asserted
    // here rather than only at `enterPlaneMode`, where it would survive until
    // the first mouse move. A no-op when the mode is off.
    applyPlaneModeToolbarLock();
    // Nothing announces a session change (each load path and the session
    // switch assign `state.session` themselves), and every one of them ends in
    // a draw — so the per-session Animals field catches up here. O(1) when the
    // session and its count are the ones already shown.
    syncAnimalCountField();

    var editGroupTarget = interactionManager ? interactionManager.editGroupTarget : null;

    // Frames other than `frameIdx` that this call draws (per-view playback
    // frames), each needing the same lazy reprojection fill — done once each.
    var filledFrames = null;

    // Views not on screen (another camera is solo'd, or the pane was closed)
    // have detached overlay canvases: skip them. Docking one again creates a
    // new canvas and redraws (`refreshPaneInteractions`), so nothing stale is
    // ever shown. With NO view docked, draw them all — the same fallback as
    // `VideoController._shownViews`.
    const anyDocked = state.views.some(isViewDocked);

    for (const view of state.views) {
        if (!view.overlayCtx || !view.overlayCanvas) continue;
        if (anyDocked && !isViewDocked(view)) continue;

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

        // The canvas's LAYOUT width — deliberately NOT getBoundingClientRect(),
        // which reports the rotated element's axis-aligned bounding box and so
        // would shrink every label whenever Video Rotation is non-zero.
        var cssW = view.overlayCanvas.offsetWidth;
        if (!cssW) {
            // Detached / not laid out yet. Only an explicit px inline width is
            // usable here — the stylesheet gives `.overlay-canvas` width:100%,
            // and parseFloat('100%') would happily hand back 100.
            var inlineW = view.overlayCanvas.style.width || '';
            if (/px\s*$/.test(inlineW)) cssW = parseFloat(inlineW) || 0;
        }

        // Resize the overlay backing store for sharp rendering under zoom.
        //
        // The wrapper's CSS transform magnifies this canvas by `zs`, so what
        // governs sharpness is backing pixels per SCREEN pixel. Supersampling by
        // the full `zs` held that constant — but it grew the canvas as zs^2 while
        // the cell still shows only a cell-sized WINDOW onto it, so at zs=10 on a
        // 1280x1024 view it allocated 12800x10240 (524 MB) to display ~283x226
        // (luc3d #200). Off a GPU-accelerated 2D canvas that is enough to drop a
        // node drag from 120 to 74 fps, which is what the issue reports.
        //
        // So bound the supersample by what the display can actually resolve,
        // never below the video's own resolution. `ss === zs` whenever the cell
        // is wide enough to need it, so an unzoomed view is byte-for-byte what it
        // was before this change.
        //
        // OVERLAY_QUALITY is backing pixels per screen pixel, and the floor of 2
        // is not cosmetic: nodes and edges are vector shapes whose smoothness
        // comes from this ratio. A cell showing a 1280px video in 283px was
        // supersampling 4.5x for free (it is downscaling), so dropping straight
        // to 1:1 on a non-retina display made circles visibly chunkier the moment
        // you zoomed. 2x holds normal anti-aliasing on every display.
        var OVERLAY_QUALITY = Math.max(2, window.devicePixelRatio || 1);
        var zs = view.zoom ? view.zoom.scale : 1;
        var ss = zs;
        if (cssW > 0) {
            // QUANTIZED to 1/4 steps, and that is not a detail. `ss` depends on
            // `cssW`, which the old `ss = zs` did not — so without this a pane
            // SASH DRAG (cssW changing by a pixel per frame) reallocates the
            // whole backing store on every redraw, which the old code never did
            // at any zoom. Measured at zoom 8 with canvas acceleration off: 59
            // reallocations over a 60-step drag, 3.49 ms per redraw against 0.32
            // unzoomed. Rounded UP so quantizing can never drop quality below
            // what OVERLAY_QUALITY asks for.
            var want = (OVERLAY_QUALITY * cssW * zs) / view.videoWidth;
            ss = Math.min(zs, Math.max(1, Math.ceil(want * 4) / 4));
        }

        // Correctness backstop, NOT a budget one. Past Chrome's canvas limits the
        // allocation reports the size you asked for and every draw silently
        // no-ops, so the whole annotation overlay goes blank with no error — the
        // old `ss = zs` reached that at 2048x1536 video and zoom 10
        // (20480x15360). The quality bound above normally keeps `ss` far under
        // this, so the clamp only bites for an unusually wide cell.
        var vwPx = view.videoWidth || 1;
        var vhPx = view.videoHeight || 1;
        ss = Math.min(ss, MAX_OVERLAY_DIM / vwPx, MAX_OVERLAY_DIM / vhPx,
                      Math.sqrt(MAX_OVERLAY_AREA / (vwPx * vhPx)));

        // `Math.floor`, not `round`: rounding up at the clamp is what would put
        // the canvas back over the limit it was just clamped to.
        var targetW = Math.max(1, Math.floor(view.videoWidth * ss));
        var targetH = Math.max(1, Math.floor(view.videoHeight * ss));
        if (view.overlayCanvas.width !== targetW || view.overlayCanvas.height !== targetH) {
            view.overlayCanvas.width = targetW;
            view.overlayCanvas.height = targetH;
        }

        // Node radii and line widths are expressed in BACKING pixels and drawn
        // unscaled, which is what held them at a constant on-screen size while
        // the backing store tracked `zs` exactly. Now that it does not, they have
        // to be scaled by the ratio actually used or they grow with zoom.
        // Labels need no such term: `labelDisplayScale` below is derived from the
        // real `targetW`, so it self-corrects.
        var overlaySizeScale = zs > 0 ? ss / zs : 1;

        // Backing pixels per CSS pixel, for labels (the one screen-relative
        // size). The zoom factor must stay in the denominator: dropping it would
        // make labels grow with zoom instead of holding a fixed point size.
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
            trailShade: state.trailShade,
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
            // Backing store no longer tracks `zs` exactly (luc3d #200); 1 at
            // zoom 1, so an unzoomed view draws exactly as it did.
            overlaySizeScale: overlaySizeScale,
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
    // info-panel DOM and re-aggregates reprojection errors per frame — a human
    // can't read it at playback speed, and doing it every frame is a major
    // per-frame cost that caps buffered playback fps. (`timeline.setCurrentFrame`
    // only moves the playhead element now, ui/timeline.js, so it is cheap; it
    // shares the throttle because it always has.)
    // The skeleton overlays + video above still update every frame, so tracking
    // stays smooth and frame-accurate; only these two auxiliary updates coalesce.
    // When paused (seek/step) they always run so the panel/playhead are exact.
    var _auxNow = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (!state.isPlaying || (_auxNow - _lastAuxUpdate) >= AUX_UPDATE_MS) {
        _lastAuxUpdate = _auxNow;
        updateFrameInfo(frameIdx, instanceGroups);
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
 * without it a lazy count would be the resident window, the very number this
 * replaces, and an eager one a walk of every frame on every step. Once per view
 * per session, or after a rebuild dropped it. Not for a lazy loader that cannot
 * enumerate rows: it has no camera half to build.
 */
function ensureCameraHalf(session, baseline, cam) {
    if (!cam || baseline.cams.has(cam)) return;
    var loader = session.lazyLoader;
    if (loader && typeof loader.forEachInstanceRow !== 'function') return;
    var half = computeLazyCameraBaseline(session, cam);
    if (half) baseline.cams.set(cam, half);
}

function renderFrameCounters(session, activeCam, baseline) {
    var c = countFrameCounters(session, activeCam, baseline);
    var labeledEl = document.getElementById('statusLabeledFrames');
    var triangulatedEl = document.getElementById('statusTriangulatedFrames');
    var instancesEl = document.getElementById('statusInstances');
    if (labeledEl) labeledEl.textContent = 'Labeled Frames: ' + c.labeled.toLocaleString('en-US');
    if (instancesEl) instancesEl.textContent = 'Instances: ' + c.instances.toLocaleString('en-US');
    if (triangulatedEl) triangulatedEl.textContent = 'Triangulated: ' + c.triangulated.toLocaleString('en-US');
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
        if (prev && prev.loader === next.loader && next.eager) {
            // Eager: the other views' halves are DROPPED, each rebuilt (one
            // walk, ~10 ms on 36,000 frames x 17 cameras) when its view is next
            // active. A rebuild follows an edit or a bulk change, and on an
            // eager project nothing cheap can tell which: every frame is
            // resident, so `nonResidentCameraCounts` says nothing.
            next.lastFrame = prev.lastFrame;
        } else if (prev && prev.loader === next.loader) {
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
        refreshCountedFrame(session, next, state.currentFrame);   // an edit made mid-build
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
 * resident-only count it replaced. On an eager project every frame is resident,
 * so that would be a walk of the whole project per step (~10 ms at 36,000
 * frames x 17 cameras); there the count is the baseline alone, kept exact by
 * re-counting the drawn frame into it each call (`refreshCountedFrame`) — O(1).
 * Building the baseline is a walk of every frame's groups (~100 ms on a
 * 108,000-frame x 8-camera project), so:
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
 *   resident, and resident frames are always counted live (on an eager
 *   project, re-counted into the baseline).
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
    // Eager: re-count the drawn frame into the baseline (O(1); a no-op on a
    // lazy project, whose resident frames are counted live).
    refreshCountedFrame(session, baseline, state.currentFrame);
    renderFrameCounters(session, activeCam, baseline);

    var sameFrame = baseline.lastFrame === state.currentFrame;
    baseline.lastFrame = state.currentFrame;
    if (!fresh && (sameFrame || _counterRebuild.pending)) requestCounterRebuild();
}
