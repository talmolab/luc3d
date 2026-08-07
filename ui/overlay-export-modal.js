// ui/overlay-export-modal.js — "Export Video Overlays" (issue #190)
//
// Renders the session's 2D camera videos WITH pose overlays burned in, plus the
// 3D viewport, either stitched into a single composed video (laid out exactly as
// the user arranged it) or as one file per tile.
//
// The counterpart of SLEAP's `View ▸ Render Video Clip with Instances…`
// (sleap/gui/dialogs/render_clip.py): frame range, appearance, background,
// quality preset, output FPS — plus LUCID's multi-view composition and its
// user / predicted / reprojected overlay layers.
//
// Structure:
//   [views strip] [composition dock (dockview)] [settings panel]
//
// Rendering model. Every tile owns TWO canvases (video + overlay), exactly like
// the main window's `.canvas-wrapper`, because `drawFrameOverlays()` opens with
// a full-canvas `clearRect` and would otherwise erase the video drawn beneath
// it. Preview canvases are sized to the tile's CSS box; export uses SEPARATE
// canvases sized to the tile's output pixel box, so preparing an export never
// disturbs the live preview.
//
// Composition geometry is read straight off the DOM (`computeTileRects`), so the
// exported frame is WYSIWYG with the dock the user arranged.

// Pinned to 6.6.1 — keep in sync with the dockview.css pin in index.html and the
// import in ui/sessions-panes.js (see CLAUDE.md › Dependencies).
import { DockviewComponent, themeDark } from 'https://cdn.jsdelivr.net/npm/dockview-core@6.6.1/+esm';

import { state, videoController, getActiveSession } from './app-state.js';
import { Viewport3D } from './viewport3d.js';
import { drawFrameOverlays, getTrackColor, getGroupColor } from './overlays.js';
import { getVisibilitySettings } from './rendering.js';
import {
    getInstanceGroupsForFrame,
    ensureLazyFrameData,
    triangulateAndReproject,
    storeReprojectedInstances,
    sessionHasCalibration,
} from '../pose/triangulation.js';
import { points3dNodeCount } from '../pose/pose-data.js';
import { setStatus } from '../import-export/save-load.js';

import {
    TILE_3D, RES_PRESETS, RES_CUSTOM, MAX_OUT_DIM,
    fitRect, computeTileRects, outputSizeFor, outputSizeFrom, customAspect, clampOutDim,
    h264CodecFor, bitrateFor, estimatedBytes, shouldStreamToDisk,
    defaultOverlayExportSettings, applyStoredSettings, saveOverlayExportSettings,
    overlayOptionsFrom, seedLayoutPlan,
} from './overlay-export-layout.js';
import { createMp4Writer, videoEncodingAvailable } from './video-encode.js';

// Re-exported so callers/tests have one import site for the feature.
export { TILE_3D };


function fmtDuration(totalSeconds) {
    var s = Math.max(0, Math.round(totalSeconds));
    var m = Math.floor(s / 60);
    var rem = s % 60;
    return m + ':' + (rem < 10 ? '0' : '') + rem;
}

function fmtBytes(bytes) {
    if (!isFinite(bytes) || bytes <= 0) return '—';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return (bytes >= 100 ? Math.round(bytes) : bytes.toFixed(1)) + ' ' + units[i];
}

function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function safeName(s) {
    return String(s || 'session').replace(/[^\w.-]+/g, '_');
}

// ============================================================================
// Settings
// ============================================================================

/**
 * Seed the export appearance from the LIVE Visibility panel, so a fresh export
 * defaults to looking exactly like the app does right now. Falls back to the
 * built-in defaults whenever the panel isn't in the DOM (headless tests).
 */
export function settingsFromVisibilityPanel() {
    var s = defaultOverlayExportSettings();
    var vis;
    try { vis = getVisibilitySettings(); } catch (e) { return s; }
    if (!vis) return s;
    s.layers = {
        user: !!vis.showUser,
        predicted: !!vis.showPredicted,
        reproj: !!vis.showReprojected,
        errors: !!vis.showErrors,
        legend: !!vis.showLegend,
    };
    s.trailLength = state.trailLength || 0;
    s.colorBy = state.colorByIdentity ? 'identity' : 'track';
    function copy(dst, src, keys) {
        if (!src) return;
        for (var i = 0; i < keys.length; i++) {
            if (src[keys[i]] != null && !Number.isNaN(src[keys[i]])) dst[keys[i]] = src[keys[i]];
        }
    }
    copy(s.user, vis.userOpts, ['nodeStyle', 'nodeSize', 'lineWidth', 'alpha', 'labelSize', 'labelAlpha']);
    if (vis.userOpts) s.user.lineStyle = vis.userOpts.postLineStyle || 'solid';
    copy(s.pred, vis.predictedOpts, ['nodeStyle', 'nodeSize', 'lineWidth', 'alpha']);
    if (vis.predictedOpts) s.pred.lineStyle = vis.predictedOpts.postLineStyle || 'solid';
    copy(s.reproj, vis.reprojOpts, ['nodeStyle', 'nodeSize', 'lineWidth', 'alpha', 'brightness', 'labelSize', 'labelAlpha']);
    if (vis.reprojOpts) s.reproj.lineStyle = vis.reprojOpts.lineStyle || 'dotted';
    s.reproj.nodeColor = vis.reprojNodeColor || 'white';
    s.fps = Math.round(state.fps || 30);
    return s;
}

export function loadOverlayExportSettings() {
    return applyStoredSettings(settingsFromVisibilityPanel());
}

/**
 * Fill the reprojection cache for `groups` — the same lazy fill `drawAllOverlays`
 * does on the live path, so an export of a triangulated-but-never-viewed frame
 * range still shows reprojections.
 */
function ensureReprojections(groups, session) {
    if (!groups || !session || !session.cameras || session.cameras.length < 2) return;
    for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        if (points3dNodeCount(g.points3d) > 0 &&
            (!g.reprojectedInstances || g.reprojectedInstances.size === 0) &&
            (!g.reprojections || Object.keys(g.reprojections).length === 0)) {
            // Resolve the method from the group, exactly as `rendering.js`'s lazy
            // fill does. Omitting it silently re-solves with DLT, which would burn
            // DLT reprojections into the video while the app displays BA's —
            // breaking the "exported 3D == displayed 3D" invariant (#113).
            var _m = (g.triangulationMethod === 'ba') ? 'ba' : 'dlt';
            var res = triangulateAndReproject(g, session.cameras, { method: _m });
            g.reprojections = res.reprojections;
            storeReprojectedInstances(g, res, session.cameras);
        }
    }
}

/** `frameGroup` in the plain-object shape `drawFrameOverlays` expects. */
function toOverlayFrameGroup(frameGroup) {
    if (!frameGroup) return null;
    var out = { frameIdx: frameGroup.frameIdx, instances: {} };
    for (var entry of frameGroup.instances) out.instances[entry[0]] = entry[1];
    return out;
}

const BG_FILL = { black: '#000000', white: '#ffffff', gray: '#808080' };

// ============================================================================
// The modal
// ============================================================================

var FIELD = 'background:var(--bg-tertiary,#2a2a2a);color:var(--text-primary,#e0e0e0);border:1px solid var(--border-color,#444);border-radius:4px;font-size:12px;padding:3px 5px;';
var HANDLE = 'position:absolute;top:5px;width:15px;height:15px;margin-left:-8px;border-radius:50%;background:var(--accent,#4a9eff);border:2px solid #fff;box-sizing:border-box;cursor:ew-resize;touch-action:none;z-index:2;';

/**
 * Open the "Export Video Overlays" modal.
 *
 * Views strip (left) → drag/double-click to dock. Composition dock (middle) →
 * dockview, drag / drop / close / resize. Settings (right) → frame range,
 * layers, per-layer appearance, background, quality, output.
 */
export function showOverlayExportModal() {
    var session = getActiveSession();
    if (!session) { setStatus('No session to export', 'error'); return; }

    var frameCount = (state.totalFrames && state.totalFrames > 0) ? state.totalFrames : 0;
    if (!frameCount) {
        var maxF = -1;
        if (session.frameGroups) for (var k of session.frameGroups.keys()) if (k > maxF) maxF = k;
        if (session.instanceGroups) for (var k2 of session.instanceGroups.keys()) if (k2 > maxF) maxF = k2;
        frameCount = maxF + 1;
    }
    if (frameCount <= 0) { setStatus('No frames to export', 'error'); return; }

    // Never let the main transport keep decoding underneath us — the modal and
    // the app share one decoder per view.
    try { if (state.isPlaying && videoController) videoController.stopPlayback(); } catch (e) { /* ignore */ }

    var settings = loadOverlayExportSettings();
    var lastIdx = frameCount - 1;
    var rangeStart = 0, rangeEnd = lastIdx;
    var previewFrame = Math.min(state.currentFrame || 0, lastIdx);
    // `sessionHasCalibration()` reads `state.session` — no argument.
    var has3D = sessionHasCalibration();

    // ---- DOM ---------------------------------------------------------------
    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay';
    overlay.id = 'ovExportOverlay';
    var modal = document.createElement('div');
    modal.className = 'multi-frame-modal';
    modal.style.cssText =
        'width:1240px;max-width:97vw;height:820px;max-height:94vh;box-sizing:border-box;' +
        'display:flex;flex-direction:column;padding:18px;';
    modal.innerHTML =
        '<h3 style="margin:0 0 10px 0;">Export Video Overlays</h3>' +
        '<div style="flex:1 1 auto;min-height:0;display:flex;gap:10px;">' +
        // --- views strip -------------------------------------------------
        '  <div style="flex:0 0 108px;display:flex;flex-direction:column;min-height:0;' +
        '       background:var(--bg-tertiary,#242424);border:1px solid var(--border-color,#444);border-radius:6px;">' +
        '    <div style="font-size:11px;font-weight:600;padding:6px 8px;color:var(--text-secondary);' +
        '         border-bottom:1px solid var(--border-color,#444);">Views</div>' +
        '    <div id="ovStrip" style="flex:1;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:6px;"></div>' +
        '  </div>' +
        // --- composition -------------------------------------------------
        '  <div style="flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:8px;">' +
        '    <div id="ovDockFrame" style="flex:1 1 auto;min-height:0;min-width:0;display:flex;' +
        '         align-items:center;justify-content:center;">' +
        '      <div id="ovDock" style="width:100%;height:100%;background:#141414;border:1px solid var(--border-color,#444);' +
        '           border-radius:6px;position:relative;overflow:hidden;"></div>' +
        '    </div>' +
        '    <div id="ovDockEmpty" style="display:none;position:absolute;"></div>' +
        '    <div style="display:flex;align-items:center;gap:6px;">' +
        // `touch-action:none` so a touch scrub drags the playhead instead of
        // scrolling the modal (the handles carry the same rule).
        '      <div id="ovTrack" title="Click or drag to scrub" ' +
        '           style="position:relative;flex:1;height:26px;margin:0 10px;cursor:pointer;touch-action:none;">' +
        '        <div style="position:absolute;top:11px;left:0;right:0;height:4px;background:#444;border-radius:2px;"></div>' +
        '        <div id="ovRangeFill" style="position:absolute;top:11px;height:4px;background:var(--accent,#4a9eff);border-radius:2px;"></div>' +
        '        <div id="ovPlayhead" style="position:absolute;top:3px;width:2px;height:20px;background:#fff;opacity:0.85;margin-left:-1px;pointer-events:none;z-index:1;"></div>' +
        '        <div id="ovHandleStart" title="Start frame" style="' + HANDLE + '"></div>' +
        '        <div id="ovHandleEnd" title="End frame" style="' + HANDLE + '"></div>' +
        '      </div>' +
        '      <span id="ovScrubVal" style="font-size:12px;min-width:96px;text-align:right;color:var(--text-secondary);"></span>' +
        '    </div>' +
        '    <div id="ovProgressWrap" style="display:none;">' +
        '      <div style="background:#333;border-radius:4px;height:8px;overflow:hidden;">' +
        '        <div id="ovProgressFill" style="width:0%;height:100%;background:var(--accent,#4a9eff);transition:width 0.1s;"></div>' +
        '      </div>' +
        '      <div id="ovProgressLabel" style="font-size:11px;color:var(--text-secondary);margin-top:4px;"></div>' +
        '    </div>' +
        '  </div>' +
        // --- settings ----------------------------------------------------
        '  <div style="flex:0 0 296px;display:flex;flex-direction:column;min-height:0;' +
        '       background:var(--bg-tertiary,#242424);border:1px solid var(--border-color,#444);border-radius:6px;">' +
        '    <div style="font-size:11px;font-weight:600;padding:6px 8px;color:var(--text-secondary);' +
        '         border-bottom:1px solid var(--border-color,#444);display:flex;justify-content:space-between;align-items:center;">' +
        '      <span>Settings</span>' +
        '      <button id="ovResetSettings" title="Re-seed from the app\'s Visibility panel" ' +
        '        style="font-size:10px;padding:2px 6px;cursor:pointer;background:transparent;color:var(--text-secondary);' +
        '        border:1px solid var(--border-color,#444);border-radius:3px;">Reset</button>' +
        '    </div>' +
        '    <div id="ovSettings" style="flex:1;overflow-y:auto;padding:8px 10px;font-size:12px;"></div>' +
        '  </div>' +
        '</div>' +
        '<div class="modal-actions" style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:10px;">' +
        '  <div id="ovSummary" style="font-size:11px;color:var(--text-secondary);"></div>' +
        '  <div style="display:flex;gap:10px;">' +
        '    <button id="ovCancel">Cancel</button>' +
        '    <button class="primary" id="ovExport">Export</button>' +
        '  </div>' +
        '</div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var stripEl = modal.querySelector('#ovStrip');
    var dockFrameEl = modal.querySelector('#ovDockFrame');
    var dockEl = modal.querySelector('#ovDock');
    var settingsEl = modal.querySelector('#ovSettings');
    var summaryEl = modal.querySelector('#ovSummary');
    var trackEl = modal.querySelector('#ovTrack');
    var rangeFill = modal.querySelector('#ovRangeFill');
    var playhead = modal.querySelector('#ovPlayhead');
    var handleStart = modal.querySelector('#ovHandleStart');
    var handleEnd = modal.querySelector('#ovHandleEnd');
    var scrubVal = modal.querySelector('#ovScrubVal');
    var cancelBtn = modal.querySelector('#ovCancel');
    var exportBtn = modal.querySelector('#ovExport');
    var resetBtn = modal.querySelector('#ovResetSettings');
    var progressWrap = modal.querySelector('#ovProgressWrap');
    var progressFill = modal.querySelector('#ovProgressFill');
    var progressLabel = modal.querySelector('#ovProgressLabel');

    var exporting = false, cancelled = false;
    var startField = null, endField = null;   // assigned by buildSettings()
    var outWField = null, outHField = null, resSelect = null;

    // ========================================================================
    // Composition dock
    // ========================================================================

    // panelId -> { viewName, element, videoCanvas, overlayCanvas, is3d }
    var tiles = new Map();
    var vp3d = null;              // Viewport3D instance for the 3D tile
    var vp3dFitted = false;       // has fitToScene run at a real viewport size?
    var panelCounter = 0;
    var tileResizeObserver = (typeof ResizeObserver !== 'undefined')
        ? new ResizeObserver(function () { maybeFit3D(); schedulePreview(); refreshSummary(); })
        : null;

    function TilePane() {
        this.element = document.createElement('div');
        this.element.style.cssText = 'position:relative;width:100%;height:100%;background:#000;overflow:hidden;';
    }
    TilePane.prototype.init = function (params) {
        var viewName = (params.params && params.params.viewName) || null;
        var id = params.api.id;
        this.element.setAttribute('data-view-name', viewName || '');
        var is3d = viewName === TILE_3D;
        var tile = { viewName: viewName, element: this.element, is3d: is3d, videoCanvas: null, overlayCanvas: null };

        if (is3d) {
            var host = document.createElement('div');
            host.style.cssText = 'position:absolute;inset:0;';
            this.element.appendChild(host);
            tile.host = host;
            mount3D(host);
        } else {
            var vc = document.createElement('canvas');
            vc.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
            var oc = document.createElement('canvas');
            oc.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
            this.element.appendChild(vc);
            this.element.appendChild(oc);
            tile.videoCanvas = vc;
            tile.overlayCanvas = oc;
        }
        tiles.set(id, tile);
        // dockview sizes a panel AFTER `init` and again on every split/resize.
        // Without this the canvas keeps whatever backing store it had at first
        // paint and the browser stretches it — a visibly blurry, wrongly-scaled
        // preview. `onDidLayoutChange` alone is not enough: it fires before the
        // new sizes have settled.
        if (tileResizeObserver) { try { tileResizeObserver.observe(this.element); } catch (e) { /* ignore */ } }
        markStripDocked();
    };
    TilePane.prototype.dispose = function () { /* removal handled via onDidRemovePanel */ };

    var dockview = new DockviewComponent(dockEl, {
        theme: Object.assign({}, themeDark, { name: 'ov-dark', className: 'dockview-theme-abyss' }),
        createComponent: function () { return new TilePane(); },
        disableFloatingGroups: true,
    });
    var dockApi = dockview.api;

    dockApi.onUnhandledDragOverEvent(function (event) {
        if (event.nativeEvent.dataTransfer &&
            event.nativeEvent.dataTransfer.types.includes('text/plain')) {
            event.accept();
        }
    });
    dockApi.onDidDrop(function (event) {
        var raw = event.nativeEvent.dataTransfer
            ? event.nativeEvent.dataTransfer.getData('text/plain') : null;
        if (!raw) return;
        var dir = mapPositionToDirection(event.position);
        var pos = event.group ? { referenceGroup: event.group.id, direction: dir } : { direction: dir };
        addTile(raw, pos);
    });
    dockApi.onDidRemovePanel(function (event) {
        var tile = tiles.get(event.id);
        if (tile && tile.is3d) dispose3D();
        tiles.delete(event.id);
        markStripDocked();
        refreshSummary();
    });
    dockApi.onDidLayoutChange(function () { schedulePreview(); });

    /**
     * Shape the dock to the output frame so the composition stays WYSIWYG.
     *
     * With a resolution PRESET the output width is derived from the dock, so the
     * two aspects agree by construction and the dock simply fills its area. A
     * CUSTOM width x height can disagree — and `computeTileRects` resolves that by
     * letterboxing the composition into the output, i.e. by burning black bars
     * into the file. Fitting the dock to the custom aspect instead makes the two
     * agree again, so those bars never appear: what the user re-arranges inside
     * the dock is precisely the frame that gets encoded. The unused area left
     * around the dock is modal chrome, not output.
     */
    function applyDockAspect() {
        var target = customAspect(settings);
        if (!target) {
            dockEl.style.width = '100%';
            dockEl.style.height = '100%';
            return;
        }
        var box = dockFrameEl.getBoundingClientRect();
        if (box.width < 8 || box.height < 8) return;   // not laid out yet
        var fit = fitRect(target, 1, box.width, box.height);
        dockEl.style.width = Math.max(8, Math.floor(fit.width)) + 'px';
        dockEl.style.height = Math.max(8, Math.floor(fit.height)) + 'px';
    }

    // dockview re-layouts itself off its own container observer, so re-shaping the
    // dock is enough; this only has to catch the OUTER box changing (window /
    // modal resize), which never touches `settings`.
    var dockFrameObserver = (typeof ResizeObserver !== 'undefined')
        ? new ResizeObserver(function () { applyDockAspect(); })
        : null;
    if (dockFrameObserver) { try { dockFrameObserver.observe(dockFrameEl); } catch (e) { /* ignore */ } }

    function mapPositionToDirection(position) {
        switch (position) {
            case 'left': return 'left';
            case 'right': return 'right';
            case 'top': return 'above';
            case 'bottom': return 'below';
            default: return 'within';
        }
    }

    function isDocked(viewName) {
        for (var t of tiles.values()) if (t.viewName === viewName) return true;
        return false;
    }

    function addTile(viewName, position) {
        if (isDocked(viewName)) return;
        if (viewName === TILE_3D && !has3D) return;
        // A positionless dockview `addPanel` STACKS the new panel as a tab in the
        // active group, where it is hidden — and a hidden tile contributes nothing
        // to the composition, so "add to composition" would silently do nothing
        // visible. Split to the right instead unless the caller placed it (a drag
        // carries its own drop position, and stacking IS meaningful there).
        if (!position && tiles.size > 0) position = { direction: 'right' };
        panelCounter++;
        dockApi.addPanel({
            id: 'ovtile-' + viewName + '-' + panelCounter,
            component: 'tile',
            title: viewName === TILE_3D ? '3D View' : viewName,
            params: { viewName: viewName },
            position: position,
        });
        refreshSummary();
        schedulePreview();
    }

    function mount3D(host) {
        if (vp3d) return;
        try {
            // Mirror the app's live 3D-viewport styling (Visibility ▸ 3D Viewer)
            // so the exported 3D tile looks like the panel the user has been
            // working in — same read-from-the-DOM approach as
            // `showExport3DVideoModal`, tolerant of a missing control.
            var num = function (id, dflt) {
                var e = document.getElementById(id);
                var v = e ? parseFloat(e.value) : NaN;
                return isFinite(v) ? v : dflt;
            };
            var bool = function (id, dflt) {
                var e = document.getElementById(id);
                return e ? e.checked : dflt;
            };
            var attr = function (id, dflt) {
                var e = document.getElementById(id);
                return (e && e.getAttribute('data-value')) || dflt;
            };
            vp3d = new Viewport3D(host, {
                cameras: session.cameras,
                skeleton: session.skeleton,
                getTrackColor: getTrackColor,
                getGroupColor: function (group) {
                    return getGroupColor(group, session, settings.colorBy === 'identity', previewFrame);
                },
                cameraLabelSize: num('vis3dLabelSize', 28),
                cameraSphereSize: num('vis3dSphereSize', 3),
                pyramidLength: num('vis3dPyramidLength', 40),
                skeletonNodeSize: num('vis3dNodeSize', 2),
                skeletonEdgeWeight: num('vis3dEdgeWeight', 0.8),
                showCameraLabels: bool('vis3dLabelShow', true),
                showCameraSpheres: bool('vis3dSphereShow', true),
                showCameraPyramids: bool('vis3dPyramidShow', true),
                showSkeletonNodes: bool('vis3dNodeShow', true),
                showSkeletonEdges: bool('vis3dEdgeShow', true),
                skeletonNodeShape: attr('vis3dNodeStyle', 'circle'),
                preserveDrawingBuffer: true,
            });
            vp3d.setFrame(getInstanceGroupsForFrame(previewFrame));
            // `fitToScene` needs the real viewport aspect, and dockview sizes the
            // panel after `init`. Fitting too early frames the scene for a
            // near-zero-size viewport and leaves the user staring at the inside of
            // a camera pyramid. `maybeFit3D` runs on the first resize that gives
            // the host a usable size (and once more on a timer as a backstop).
            vp3dFitted = false;
            setTimeout(maybeFit3D, 250);
        } catch (err) {
            console.error('[overlay export] 3D viewport unavailable:', err);
            host.textContent = '3D viewport unavailable (WebGL required)';
            host.style.cssText += 'display:flex;align-items:center;justify-content:center;color:#888;font-size:12px;text-align:center;';
            vp3d = null;
        }
    }

    /** Frame the 3D scene once its tile has a real size (see `mount3D`). */
    function maybeFit3D() {
        if (!vp3d || vp3dFitted) return;
        var host = vp3d.container;
        if (!host || host.clientWidth < 40 || host.clientHeight < 40) return;
        vp3dFitted = true;
        try { vp3d.resize(); vp3d.fitToScene(); } catch (e) { /* ignore */ }
    }

    function dispose3D() {
        if (!vp3d) return;
        try { vp3d.dispose(); } catch (e) { /* ignore */ }
        vp3d = null;
        vp3dFitted = false;
    }

    // ========================================================================
    // Views strip
    // ========================================================================

    function stripEntries() {
        var out = [];
        for (var i = 0; i < state.views.length; i++) out.push({ name: state.views[i].name, is3d: false });
        if (has3D) out.push({ name: TILE_3D, is3d: true, label: '3D View' });
        return out;
    }

    function buildStrip() {
        stripEl.textContent = '';
        stripEntries().forEach(function (entry) {
            var item = document.createElement('div');
            item.className = 'ov-strip-item';
            item.setAttribute('data-view-name', entry.name);
            item.draggable = true;
            item.title = 'Drag into the composition, or double-click to add';
            item.style.cssText =
                'position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px;' +
                'border:1px solid var(--border-color,#444);border-radius:4px;cursor:grab;background:#1b1b1b;';

            var thumb = document.createElement('canvas');
            thumb.width = 80; thumb.height = 56;
            thumb.style.cssText = 'width:80px;height:56px;background:#000;border-radius:2px;display:block;';
            item.appendChild(thumb);
            entry.thumb = thumb;

            var label = document.createElement('div');
            label.style.cssText = 'font-size:10px;color:var(--text-secondary);max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            label.textContent = entry.label || entry.name;
            item.appendChild(label);

            var dot = document.createElement('div');
            dot.className = 'ov-strip-dot';
            dot.style.cssText = 'position:absolute;top:5px;right:5px;width:7px;height:7px;border-radius:50%;background:var(--accent,#4a9eff);display:none;';
            item.appendChild(dot);

            item.addEventListener('dragstart', function (e) {
                e.dataTransfer.setData('text/plain', entry.name);
                e.dataTransfer.effectAllowed = 'copy';
            });
            item.addEventListener('dblclick', function () { addTile(entry.name); });

            stripEl.appendChild(item);

            if (entry.is3d) draw3DGlyph(thumb);
        });
        markStripDocked();
    }

    function markStripDocked() {
        var items = stripEl.querySelectorAll('.ov-strip-item');
        for (var i = 0; i < items.length; i++) {
            var name = items[i].getAttribute('data-view-name');
            var dot = items[i].querySelector('.ov-strip-dot');
            if (dot) dot.style.display = isDocked(name) ? '' : 'none';
            items[i].style.opacity = isDocked(name) ? '0.55' : '1';
        }
    }

    /** Simple wireframe-cube glyph so the 3D entry reads as a tile, not a video. */
    function draw3DGlyph(canvas) {
        var c = canvas.getContext('2d');
        c.fillStyle = '#101010';
        c.fillRect(0, 0, canvas.width, canvas.height);
        c.strokeStyle = '#4a9eff';
        c.lineWidth = 1.5;
        var f = [[22, 18], [50, 18], [50, 42], [22, 42]];
        var b = [[32, 12], [60, 12], [60, 36], [32, 36]];
        function poly(p) {
            c.beginPath();
            c.moveTo(p[0][0], p[0][1]);
            for (var i = 1; i < p.length; i++) c.lineTo(p[i][0], p[i][1]);
            c.closePath(); c.stroke();
        }
        poly(f); poly(b);
        c.beginPath();
        for (var i = 0; i < 4; i++) { c.moveTo(f[i][0], f[i][1]); c.lineTo(b[i][0], b[i][1]); }
        c.stroke();
    }

    function refreshStripThumb(viewName, bitmap, vw, vh) {
        var item = stripEl.querySelector('.ov-strip-item[data-view-name="' + cssEscape(viewName) + '"]');
        if (!item) return;
        var canvas = item.querySelector('canvas');
        if (!canvas || !bitmap) return;
        var c = canvas.getContext('2d');
        c.fillStyle = '#000';
        c.fillRect(0, 0, canvas.width, canvas.height);
        var f = fitRect(vw, vh, canvas.width, canvas.height);
        try { c.drawImage(bitmap, f.x, f.y, f.width, f.height); } catch (e) { /* ignore */ }
    }

    function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

    // ========================================================================
    // Preview
    // ========================================================================

    var previewToken = 0;
    var previewPending = false;

    function schedulePreview() {
        if (previewPending || exporting) return;
        previewPending = true;
        requestAnimationFrame(function () { previewPending = false; renderPreview(); });
    }

    async function renderPreview() {
        if (exporting) return;
        var token = ++previewToken;
        var f = previewFrame;

        if (session.lazyLoader && !session.frameGroups.has(f)) {
            try { await ensureLazyFrameData(f); } catch (e) { /* ignore */ }
            if (token !== previewToken) return;
        }

        var frameGroup = session.getFrameGroup(f);
        var groups = getInstanceGroupsForFrame(f);
        if (settings.layers.reproj || settings.layers.errors) ensureReprojections(groups, session);
        var ofg = toOverlayFrameGroup(frameGroup);

        // Decode every docked 2D view in parallel.
        var jobs = [];
        for (var tile of tiles.values()) {
            if (tile.is3d) continue;
            (function (t) {
                var view = findView(t.viewName);
                if (!view || !view.decoder) { jobs.push(Promise.resolve({ tile: t, view: view, bitmap: null })); return; }
                jobs.push(view.decoder.getFrame(f)
                    .then(function (bm) { return { tile: t, view: view, bitmap: bm }; })
                    .catch(function () { return { tile: t, view: view, bitmap: null }; }));
            })(tile);
        }
        var results = await Promise.all(jobs);
        if (token !== previewToken) return;

        for (var i = 0; i < results.length; i++) {
            var res = results[i];
            if (!res.view) continue;
            var el = res.tile.element;
            var w = Math.max(2, Math.round(el.clientWidth));
            var h = Math.max(2, Math.round(el.clientHeight));
            sizeCanvas(res.tile.videoCanvas, w, h);
            sizeCanvas(res.tile.overlayCanvas, w, h);
            paintTile(res.tile, res.view, res.bitmap, frameGroup, ofg, groups, f, w, h);
            refreshStripThumb(res.tile.viewName, res.bitmap, res.view.videoWidth, res.view.videoHeight);
        }

        if (vp3d) {
            try { vp3d.setFrame(getInstanceGroupsForFrame(f)); } catch (e) { /* ignore */ }
        }
    }

    function findView(name) {
        for (var i = 0; i < state.views.length; i++) if (state.views[i].name === name) return state.views[i];
        return null;
    }

    function sizeCanvas(canvas, w, h) {
        if (!canvas) return;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
    }

    /**
     * Draw one 2D tile: background (video frame or solid fill) into `videoCanvas`,
     * overlays into `overlayCanvas`. Both are `w`×`h`; the video is letterboxed
     * with the same fit `drawFrameOverlays` uses, so the two align exactly.
     */
    function paintTile(tile, view, bitmap, frameGroup, ofg, groups, frameIdx, w, h) {
        var vctx = tile.videoCanvas.getContext('2d');
        vctx.clearRect(0, 0, w, h);
        if (settings.background === 'video') {
            vctx.fillStyle = '#000';
            vctx.fillRect(0, 0, w, h);
            if (bitmap) {
                var fit = fitRect(view.videoWidth, view.videoHeight, w, h);
                try { vctx.drawImage(bitmap, fit.x, fit.y, fit.width, fit.height); } catch (e) { /* ignore */ }
            }
        } else {
            vctx.fillStyle = BG_FILL[settings.background] || '#000';
            vctx.fillRect(0, 0, w, h);
        }

        var octx = tile.overlayCanvas.getContext('2d');
        var opts = overlayOptionsFrom(settings, view.videoWidth, view.videoHeight, w, h);
        var unlinked = collectUnlinked(frameGroup, view.name);
        opts.unlinkedInstances = unlinked;
        drawFrameOverlays(octx, view.name, ofg, groups, session, opts);
    }

    function collectUnlinked(frameGroup, viewName) {
        if (!frameGroup) return [];
        if (!settings.layers.user && !settings.layers.predicted) return [];
        var all = frameGroup.getUnlinkedInstances(viewName) || [];
        var out = [];
        for (var i = 0; i < all.length; i++) {
            var t = all[i].instance.type || 'user';
            if (t === 'predicted' ? settings.layers.predicted : settings.layers.user) out.push(all[i]);
        }
        return out;
    }

    // ========================================================================
    // Settings panel
    // ========================================================================

    function group(title, openByDefault) {
        var d = document.createElement('details');
        d.open = openByDefault !== false;
        d.style.cssText = 'margin-bottom:8px;border:1px solid var(--border-color,#3a3a3a);border-radius:4px;';
        var s = document.createElement('summary');
        s.textContent = title;
        s.style.cssText = 'cursor:pointer;font-size:11px;font-weight:600;padding:5px 7px;color:var(--text-primary,#ddd);user-select:none;';
        d.appendChild(s);
        var body = document.createElement('div');
        body.style.cssText = 'padding:4px 8px 8px 8px;display:flex;flex-direction:column;gap:5px;';
        d.appendChild(body);
        d.body = body;
        settingsEl.appendChild(d);
        return d;
    }

    function row(parent, labelText) {
        var r = document.createElement('label');
        r.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:var(--text-secondary);';
        var l = document.createElement('span');
        l.textContent = labelText;
        r.appendChild(l);
        parent.appendChild(r);
        return r;
    }

    function onChange() {
        saveOverlayExportSettings(settings);
        applyDockAspect();     // a size/resolution change re-shapes the composition
        refreshSummary();
        schedulePreview();
    }

    function addCheck(parent, labelText, obj, key) {
        var r = row(parent, labelText);
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!obj[key];
        input.setAttribute('data-ov', key);
        input.addEventListener('change', function () { obj[key] = input.checked; onChange(); });
        r.appendChild(input);
        return input;
    }

    function addSelect(parent, labelText, obj, key, options, id) {
        var r = row(parent, labelText);
        var sel = document.createElement('select');
        sel.style.cssText = FIELD + 'width:118px;';
        if (id) sel.id = id;
        options.forEach(function (o) {
            var opt = document.createElement('option');
            opt.value = o[0]; opt.textContent = o[1];
            sel.appendChild(opt);
        });
        sel.value = String(obj[key]);
        sel.addEventListener('change', function () { obj[key] = sel.value; onChange(); });
        r.appendChild(sel);
        return sel;
    }

    function addNumber(parent, labelText, obj, key, min, max, step, id) {
        var r = row(parent, labelText);
        var input = document.createElement('input');
        input.type = 'number';
        input.min = min; input.max = max; input.step = step;
        input.value = obj[key];
        input.style.cssText = FIELD + 'width:64px;text-align:center;';
        if (id) input.id = id;
        input.addEventListener('change', function () {
            var v = parseFloat(input.value);
            if (!isFinite(v)) { input.value = obj[key]; return; }
            v = Math.min(max, Math.max(min, v));
            obj[key] = v;
            input.value = v;
            onChange();
        });
        r.appendChild(input);
        return input;
    }

    /**
     * The width x height row under the Resolution picker.
     *
     * The fields always show the size the export will actually be — for a preset
     * that is the derived size, refreshed by `syncOutFields()` as the composition
     * changes. Typing in either one is the gesture that switches Resolution to
     * Custom: there is no separate "enable custom size" step to forget.
     */
    function buildSizeRow(parent) {
        var r = row(parent, 'Size (px)');
        var wrap = document.createElement('span');
        wrap.style.cssText = 'display:flex;align-items:center;gap:4px;';
        outWField = document.createElement('input');
        outHField = document.createElement('input');
        [outWField, outHField].forEach(function (inp, i) {
            inp.type = 'number';
            inp.min = 2; inp.max = MAX_OUT_DIM; inp.step = 2;
            inp.id = i === 0 ? 'ovOutW' : 'ovOutH';
            inp.title = 'Editing either field switches Resolution to Custom';
            inp.style.cssText = FIELD + 'width:56px;text-align:center;';
            inp.addEventListener('change', function () { commitSizeField(); });
        });
        var x = document.createElement('span');
        x.textContent = '×';
        x.style.cssText = 'color:var(--text-muted,#888);';
        wrap.appendChild(outWField); wrap.appendChild(x); wrap.appendChild(outHField);
        r.appendChild(wrap);
    }

    function commitSizeField() {
        // Whatever is in the two boxes now IS the custom size — including the
        // derived numbers the user was shown before touching anything, so
        // nudging one dimension of a preset keeps the other.
        settings.outW = clampOutDim(outWField.value);
        settings.outH = clampOutDim(outHField.value);
        settings.res = RES_CUSTOM;
        if (resSelect) resSelect.value = RES_CUSTOM;
        onChange();
    }

    /** Push the effective output size back into the two fields. */
    function syncOutFields(size) {
        if (!outWField || !outHField || !size) return;
        var active = document.activeElement;
        if (active !== outWField) outWField.value = size.width;
        if (active !== outHField) outHField.value = size.height;
    }

    var MARKERS = [['circle', 'circle'], ['square', 'square'], ['diamond', 'diamond'],
        ['triangle', 'triangle'], ['cross', 'cross'], ['x', 'x']];
    var LINES = [['solid', 'solid'], ['dashed', 'dashed'], ['dotted', 'dotted']];

    function buildSettings() {
        settingsEl.textContent = '';

        // --- Frame range (top, per the issue) ---
        var gRange = group('Frame Range');
        var rr = document.createElement('div');
        rr.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary);';
        rr.innerHTML =
            '<span>Start</span><input type="number" id="ovStartField" min="1" max="' + frameCount + '" step="1" style="' + FIELD + 'width:74px;text-align:center;">' +
            '<span>End</span><input type="number" id="ovEndField" min="1" max="' + frameCount + '" step="1" style="' + FIELD + 'width:74px;text-align:center;">';
        gRange.body.appendChild(rr);
        var note = document.createElement('div');
        note.id = 'ovRangeNote';
        note.style.cssText = 'font-size:11px;color:var(--text-muted,#888);';
        gRange.body.appendChild(note);
        startField = rr.querySelector('#ovStartField');
        endField = rr.querySelector('#ovEndField');
        startField.addEventListener('change', function () { commitRangeField('start'); });
        endField.addEventListener('change', function () { commitRangeField('end'); });

        // --- Layers ---
        var gLayers = group('Layers');
        addCheck(gLayers.body, 'User instances', settings.layers, 'user');
        addCheck(gLayers.body, 'Predicted instances', settings.layers, 'predicted');
        addCheck(gLayers.body, 'Reprojections', settings.layers, 'reproj');
        addCheck(gLayers.body, 'Reprojection errors', settings.layers, 'errors');
        addCheck(gLayers.body, 'Legend', settings.layers, 'legend');
        addSelect(gLayers.body, 'Color by', settings, 'colorBy',
            [['track', 'Track'], ['identity', 'Identity']], 'ovColorBy');
        addNumber(gLayers.body, 'Node trails (frames)', settings, 'trailLength', 0, 500, 10);
        addSelect(gLayers.body, 'Background', settings, 'background',
            [['video', 'video'], ['black', 'black'], ['white', 'white'], ['gray', 'gray']], 'ovBackground');

        // --- Per-layer appearance ---
        var gUser = group('User Appearance', false);
        addSelect(gUser.body, 'Marker', settings.user, 'nodeStyle', MARKERS);
        addNumber(gUser.body, 'Marker size', settings.user, 'nodeSize', 1, 30, 0.5);
        addNumber(gUser.body, 'Line width', settings.user, 'lineWidth', 0.5, 15, 0.5);
        addNumber(gUser.body, 'Opacity', settings.user, 'alpha', 0.1, 1, 0.05);
        addSelect(gUser.body, 'Line style', settings.user, 'lineStyle', LINES);
        addCheck(gUser.body, 'Show nodes', settings.user, 'showNodes');
        addCheck(gUser.body, 'Show edges', settings.user, 'showEdges');
        addNumber(gUser.body, 'Node label size', settings.user, 'labelSize', 0, 40, 1);
        addNumber(gUser.body, 'Label opacity', settings.user, 'labelAlpha', 0, 1, 0.05);

        var gPred = group('Predicted Appearance', false);
        addSelect(gPred.body, 'Marker', settings.pred, 'nodeStyle', MARKERS);
        addNumber(gPred.body, 'Marker size', settings.pred, 'nodeSize', 1, 30, 0.5);
        addNumber(gPred.body, 'Line width', settings.pred, 'lineWidth', 0.5, 15, 0.5);
        addNumber(gPred.body, 'Opacity', settings.pred, 'alpha', 0.1, 1, 0.05);
        addSelect(gPred.body, 'Line style', settings.pred, 'lineStyle', LINES);
        addCheck(gPred.body, 'Show nodes', settings.pred, 'showNodes');
        addCheck(gPred.body, 'Show edges', settings.pred, 'showEdges');

        var gRep = group('Reprojection Appearance', false);
        addSelect(gRep.body, 'Marker', settings.reproj, 'nodeStyle', MARKERS);
        addNumber(gRep.body, 'Marker size', settings.reproj, 'nodeSize', 1, 30, 0.5);
        addNumber(gRep.body, 'Line width', settings.reproj, 'lineWidth', 0.5, 15, 0.5);
        addNumber(gRep.body, 'Opacity', settings.reproj, 'alpha', 0.1, 1, 0.05);
        addSelect(gRep.body, 'Line style', settings.reproj, 'lineStyle', LINES);
        addSelect(gRep.body, 'Marker color', settings.reproj, 'nodeColor',
            [['white', 'white'], ['black', 'black'], ['track', 'track']]);
        addNumber(gRep.body, 'Brightness', settings.reproj, 'brightness', 0.1, 1, 0.05);
        addCheck(gRep.body, 'Show nodes', settings.reproj, 'showNodes');
        addCheck(gRep.body, 'Show edges', settings.reproj, 'showEdges');

        // --- Quality / output ---
        var gOut = group('Quality & Output');
        var resOpts = Object.keys(RES_PRESETS).map(function (k) { return [k, RES_PRESETS[k].label]; });
        resOpts.push([RES_CUSTOM, 'Custom']);
        resSelect = addSelect(gOut.body, 'Resolution', settings, 'res', resOpts, 'ovRes');
        buildSizeRow(gOut.body);
        addSelect(gOut.body, 'Quality', settings, 'quality',
            [['low', 'low'], ['medium', 'medium'], ['high', 'high']], 'ovQuality');
        addNumber(gOut.body, 'Output FPS', settings, 'fps', 1, 240, 1, 'ovFps');
        addSelect(gOut.body, 'Output', settings, 'mode',
            [['stitched', 'Stitched'], ['individual', 'Individual']], 'ovMode');
        var outNote = document.createElement('div');
        outNote.id = 'ovOutNote';
        outNote.style.cssText = 'font-size:11px;color:var(--text-muted,#888);line-height:1.4;';
        gOut.body.appendChild(outNote);
    }

    // ========================================================================
    // Frame range + transport
    // ========================================================================

    function pctOf(f) { return lastIdx > 0 ? (f / lastIdx) * 100 : 0; }
    function selectedCount() { return rangeEnd - rangeStart + 1; }
    function currentFps() {
        var f = settings.fps;
        if (!isFinite(f) || f <= 0) f = 30;
        return Math.min(240, f);
    }

    function layoutTrack() {
        handleStart.style.left = pctOf(rangeStart) + '%';
        handleEnd.style.left = pctOf(rangeEnd) + '%';
        rangeFill.style.left = pctOf(rangeStart) + '%';
        rangeFill.style.width = (pctOf(rangeEnd) - pctOf(rangeStart)) + '%';
        playhead.style.left = pctOf(previewFrame) + '%';
        if (startField) startField.value = rangeStart + 1;   // 1-based display
        if (endField) endField.value = rangeEnd + 1;
        scrubVal.textContent = 'frame ' + (previewFrame + 1) + ' / ' + frameCount;
        var note = modal.querySelector('#ovRangeNote');
        if (note) {
            note.textContent = selectedCount() + ' frames · ' +
                fmtDuration(selectedCount() / currentFps()) + ' @ ' + currentFps() + ' fps';
        }
        refreshSummary();
    }

    function setRange(s, e) {
        s = Math.max(0, Math.min(lastIdx, Math.round(s)));
        e = Math.max(0, Math.min(lastIdx, Math.round(e)));
        if (s > e) { var t = s; s = e; e = t; }
        rangeStart = s; rangeEnd = e;
        layoutTrack();
    }

    // Reject illegal input outright (revert to the last valid value) rather than
    // silently clamping, matching the Export 3D Video modal's fields.
    function commitRangeField(which) {
        var field = which === 'start' ? startField : endField;
        var raw = field.value.trim();
        var v = Number(raw);
        var ok = raw !== '' && Number.isInteger(v) && v >= 1 && v <= frameCount &&
            (which === 'start' ? (v - 1) <= rangeEnd : (v - 1) >= rangeStart);
        if (!ok) { field.value = (which === 'start' ? rangeStart : rangeEnd) + 1; return; }
        if (which === 'start') setRange(v - 1, rangeEnd); else setRange(rangeStart, v - 1);
        showFrame(v - 1);
    }

    function showFrame(f) {
        if (f < 0) f = 0;
        if (f > lastIdx) f = lastIdx;
        previewFrame = f;
        playhead.style.left = pctOf(f) + '%';
        scrubVal.textContent = 'frame ' + (f + 1) + ' / ' + frameCount;
        schedulePreview();
        syncViewer(f);
    }

    /**
     * Drive the app underneath from the modal's playhead, so stepping, scrubbing
     * and playing here move the real viewer, its overlays and the timeline — and
     * closing the modal leaves you on the frame you stopped at.
     *
     * `scrubToFrame` is the coalescing entry point: it keeps at most one seek in
     * flight and drops intermediate targets, so the app skips frames it can't
     * keep up with instead of queueing a decode backlog behind the preview. The
     * two share one decoder per view, and the modal has already asked for this
     * exact frame, so the app's request lands in the decoder's LRU cache.
     */
    function syncViewer(f) {
        if (exporting) return;
        try {
            if (videoController) videoController.scrubToFrame(f);
            else state.currentFrame = f;
        } catch (e) { /* the preview is authoritative; a stale app view is harmless */ }
    }

    // The modal deliberately has NO playback transport: it is a still-frame
    // previewer, so the only way to change frames is to scrub the track (or set
    // the range fields, which preview the boundary they commit). Playing back a
    // multi-view composition here meant decoding every view per tick and pushing
    // each tick into the app viewer too, which competed with the export it
    // exists to configure; the single rendered frame is what tells you whether
    // the overlays look right, and that is what this modal is for.

    // `'playhead'` | `'start'` | `'end'` — the track scrubs, the handles resize.
    var dragging = null;
    function frameFromClientX(clientX) {
        var rect = trackEl.getBoundingClientRect();
        if (rect.width <= 0) return 0;
        var pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return Math.round(pct * lastIdx);
    }
    function onDragMove(ev) {
        if (!dragging) return;
        var f = frameFromClientX(ev.clientX);
        if (dragging === 'playhead') showFrame(f);
        else if (dragging === 'start') setRange(Math.min(f, rangeEnd), rangeEnd);
        else setRange(rangeStart, Math.max(f, rangeStart));
        if (ev.cancelable) ev.preventDefault();
    }
    function onDragEnd() {
        if (!dragging) return;
        // Releasing an endpoint previews the boundary you just set; a playhead
        // drag is already sitting on the right frame, so leave it alone.
        if (dragging !== 'playhead') showFrame(dragging === 'start' ? rangeStart : rangeEnd);
        dragging = null;
        document.removeEventListener('pointermove', onDragMove);
        document.removeEventListener('pointerup', onDragEnd);
    }
    function beginDrag(which, ev) {
        if (exporting) return;
        dragging = which;
        document.addEventListener('pointermove', onDragMove);
        document.addEventListener('pointerup', onDragEnd);
        if (ev.cancelable) ev.preventDefault();
    }
    handleStart.addEventListener('pointerdown', function (ev) { beginDrag('start', ev); });
    handleEnd.addEventListener('pointerdown', function (ev) { beginDrag('end', ev); });

    /**
     * Pressing the track scrubs the CURRENT FRAME and drags it, rather than
     * pulling whichever range endpoint happens to be nearer.
     *
     * Scrubbing is the gesture you reach for constantly — you set the export
     * range once and then hunt for the frame you want to check. Nearest-endpoint
     * grabbing meant an innocent click halfway down the track silently redefined
     * what would be exported, and which end moved depended on invisible
     * arithmetic. So the two gestures are now separated by what you press: the
     * track scrubs, and an endpoint moves only when you grab its handle
     * directly. The handles sit above the track (`z-index`) and claim their own
     * `pointerdown`, so a press that lands on one never reaches here.
     *
     * Scrubbing is deliberately NOT clamped to the export range — the playhead
     * is a preview cursor, and being able to look just outside the range before
     * committing to it is the point. Playback still starts at `rangeStart` when
     * the playhead is outside, so nothing downstream is confused by it.
     */
    trackEl.addEventListener('pointerdown', function (ev) {
        if (exporting) return;
        if (ev.target === handleStart || ev.target === handleEnd) return;
        beginDrag('playhead', ev);
        showFrame(frameFromClientX(ev.clientX));
    });

    // ========================================================================
    // Layout capture + summary
    // ========================================================================

    /**
     * Snapshot the dock: its size plus each tile's rect in dock-local CSS px,
     * ordered top-to-bottom then left-to-right so individual-file exports come
     * out in a predictable order.
     */
    function captureLayout() {
        var dockRect = dockEl.getBoundingClientRect();
        var out = [];
        for (var tile of tiles.values()) {
            var r = tile.element.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;   // hidden tab in a stacked group
            out.push({
                tile: tile,
                x: r.left - dockRect.left,
                y: r.top - dockRect.top,
                width: r.width,
                height: r.height,
            });
        }
        out.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
        return { dock: { width: dockRect.width, height: dockRect.height }, tiles: out };
    }

    function refreshSummary() {
        var layout = captureLayout();
        var n = layout.tiles.length;
        var outNote = modal.querySelector('#ovOutNote');
        if (n === 0) {
            summaryEl.textContent = 'Add at least one view to the composition.';
            if (outNote) outNote.textContent = '';
            syncOutFields(outputSizeFrom(settings, 16 / 9));
            return;
        }
        var fps = currentFps();
        var nFrames = selectedCount();
        if (settings.mode === 'stitched') {
            var aspect = layout.dock.height > 0 ? layout.dock.width / layout.dock.height : 16 / 9;
            var size = outputSizeFrom(settings, aspect);
            syncOutFields(size);
            var bytes = estimatedBytes(size.width, size.height, fps, settings.quality, nFrames);
            summaryEl.textContent = n + ' tile' + (n === 1 ? '' : 's') + ' · ' + resTierLabel(size) +
                ' · ' + size.width + '×' + size.height +
                ' · ' + nFrames + ' frames · ~' + fmtBytes(bytes);
            if (outNote) {
                outNote.textContent = 'One .mp4 laid out exactly as the composition (' +
                    size.width + '×' + size.height + ' at ' + settings.quality + ' quality, ' +
                    (bitrateFor(size.width, size.height, fps, settings.quality) / 1e6).toFixed(1) + ' Mbps).';
            }
        } else {
            var total = 0;
            for (var i = 0; i < layout.tiles.length; i++) {
                var s = individualSizeFor(layout.tiles[i]);
                total += estimatedBytes(s.width, s.height, fps, settings.quality, nFrames);
            }
            // With a preset every file is sized to its own aspect, so the fields
            // show the first one; a custom size applies to all of them.
            var firstSize = individualSizeFor(layout.tiles[0]);
            syncOutFields(firstSize);
            summaryEl.textContent = n + ' file' + (n === 1 ? '' : 's') + ' · ' + resTierLabel(null) +
                ' · ' + nFrames + ' frames · ~' + fmtBytes(total);
            if (outNote) {
                outNote.textContent = settings.res === RES_CUSTOM
                    ? 'One .mp4 per tile (' + n + '), each ' + firstSize.width + '×' + firstSize.height + ', same appearance settings.'
                    // Each file gets its own WIDTH (its tile's aspect) but the same
                    // tier HEIGHT, so naming the height is accurate for all of them
                    // where naming a single W×H would not be.
                    : 'One .mp4 per tile (' + n + ' file' + (n === 1 ? '' : 's') + '), each ' +
                      firstSize.height + 'px tall at its own aspect, same appearance settings.';
            }
        }
    }

    /**
     * The chosen quality tier, named. Shown alongside the literal W×H because the
     * two can legitimately disagree: a preset fixes only the HEIGHT, and a very
     * wide composition clamps the derived width to `MAX_OUT_DIM` and then
     * recomputes the height to keep the aspect — so "2160p" can encode at 3840×960.
     * Stating the tier and the pixels side by side makes that visible instead of
     * surprising.
     */
    function resTierLabel(size) {
        if (settings.res === RES_CUSTOM) return 'custom';
        var preset = RES_PRESETS[settings.res];
        if (!preset) return 'custom';
        return size && size.height !== preset.h
            ? preset.h + 'p (width-capped)'
            : preset.h + 'p';
    }

    /** Output size of one tile in "Individual files" mode. */
    function individualSizeFor(entry) {
        var aspect;
        if (entry.tile.is3d) {
            aspect = entry.height > 0 ? entry.width / entry.height : 16 / 9;
        } else {
            var view = findView(entry.tile.viewName);
            aspect = (view && view.videoHeight > 0) ? view.videoWidth / view.videoHeight : 16 / 9;
        }
        // A custom size wins over the tile's own aspect — the tile content is
        // letterboxed into it by `drawExportTile`'s `fitRect`, so asking for
        // 1920x1080 gets you 1920x1080 files whatever shape the cameras are.
        return outputSizeFrom(settings, aspect);
    }

    // ========================================================================
    // Export
    // ========================================================================

    /**
     * One mp4 writer per output file, bound to the canvas it encodes.
     * `fileHandle` (when the browser gave us one) makes it stream to disk at a
     * bounded memory cost instead of buffering the whole file — see
     * ui/video-encode.js.
     */
    function makeWriter(canvas, W, H, fps, nFrames, fileHandle) {
        return createMp4Writer({
            canvas: canvas,
            width: W, height: H, fps: fps,
            bitrate: bitrateFor(W, H, fps, settings.quality),
            fullCodecString: h264CodecFor(W, H),
            frameCount: nFrames,
            fileHandle: fileHandle || null,
        });
    }

    async function runExport() {
        if (!videoEncodingAvailable()) {
            setStatus('Overlay video export needs a browser with WebCodecs (Chrome, Edge or a recent Safari)', 'error');
            return;
        }
        var layout = captureLayout();
        if (layout.tiles.length === 0) {
            setStatus('Add at least one view to the composition before exporting', 'error');
            return;
        }

        exporting = true;
        cancelled = false;
        setControlsDisabled(true);
        progressWrap.style.display = '';

        var fps = currentFps();
        var expStart = rangeStart, expEnd = rangeEnd;
        var nFrames = expEnd - expStart + 1;
        var stitched = settings.mode === 'stitched';

        // --- allocate output targets -----------------------------------------
        var outW = 0, outH = 0, tileRects = null, targets = [];
        var jobs = [];   // { entry, canvas, ctx, w, h, target|null, dstRect|null }

        if (stitched) {
            var aspect = layout.dock.height > 0 ? layout.dock.width / layout.dock.height : 16 / 9;
            var size = outputSizeFrom(settings, aspect);
            outW = size.width; outH = size.height;
            tileRects = computeTileRects(layout.dock, layout.tiles, outW, outH);
        }

        for (var i = 0; i < layout.tiles.length; i++) {
            var entry = layout.tiles[i];
            var w, h, dst = null;
            if (stitched) {
                dst = tileRects[i];
                w = dst.width; h = dst.height;
            } else {
                var isz = individualSizeFor(entry);
                w = isz.width; h = isz.height;
            }
            var canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            var job = {
                entry: entry, canvas: canvas, ctx: canvas.getContext('2d'),
                w: w, h: h, dstRect: dst, target: null,
                overlay: null, overlayCtx: null,
            };
            if (!entry.tile.is3d) {
                var oc = document.createElement('canvas');
                oc.width = w; oc.height = h;
                job.overlay = oc;
                job.overlayCtx = oc.getContext('2d');
            }
            jobs.push(job);
        }

        // --- 3D viewport: render at output size, CSS size untouched ----------
        var vp3dRestore = null;
        var job3d = null;
        for (var j = 0; j < jobs.length; j++) if (jobs[j].entry.tile.is3d) job3d = jobs[j];
        if (job3d && vp3d) {
            try {
                if (vp3d._resizeObserver) vp3d._resizeObserver.disconnect();
                vp3dRestore = { pr: vp3d.renderer.getPixelRatio(), aspect: vp3d.threeCamera.aspect };
                vp3d.renderer.setPixelRatio(1);
                vp3d.renderer.setSize(job3d.w, job3d.h, false);
                vp3d.threeCamera.aspect = job3d.w / job3d.h;
                vp3d.threeCamera.updateProjectionMatrix();
            } catch (e) { console.warn('[overlay export] 3D resize failed:', e); }
        }

        // Undo that resize. Factored out because the destination picker below
        // can bail out of the export before any frame is encoded.
        function restore3dViewport() {
            if (!vp3d || !vp3dRestore) return;
            try {
                vp3d.renderer.setPixelRatio(vp3dRestore.pr);
                vp3d.threeCamera.aspect = vp3dRestore.aspect;
                vp3d.threeCamera.updateProjectionMatrix();
                if (vp3d._resizeObserver) vp3d._resizeObserver.observe(vp3d.container);
                vp3d.resize();
            } catch (e) { /* ignore */ }
            vp3dRestore = null;
        }

        var composite = null, compositeCtx = null;
        if (stitched) {
            composite = document.createElement('canvas');
            composite.width = outW; composite.height = outH;
            compositeCtx = composite.getContext('2d');
        }

        var base = safeName(session.name) + '_overlay_f' + (expStart + 1) + '-' + (expEnd + 1);

        // One spec per output FILE: the canvas it encodes, its size, its name.
        var specs = [];
        if (stitched) {
            specs.push({ canvas: composite, w: outW, h: outH, filename: base + '.mp4', job: null });
        } else {
            for (var t = 0; t < jobs.length; t++) {
                var tileName = jobs[t].entry.tile.is3d ? '3d' : safeName(jobs[t].entry.tile.viewName);
                specs.push({
                    canvas: jobs[t].canvas, w: jobs[t].w, h: jobs[t].h,
                    filename: base + '_' + tileName + '.mp4', job: jobs[t],
                });
            }
        }

        // --- destination ------------------------------------------------------
        // Small exports keep the old zero-friction behaviour: buffer, download,
        // no questions. Only once the expected output is big enough that holding
        // it in memory is a genuine risk do we ask for a real destination and
        // stream to it (see `shouldStreamToDisk`). This has to be decided and
        // the picker opened BEFORE any await, because the File System Access API
        // needs the transient user activation from the Export click and every
        // step above this point is synchronous.
        var estTotal = 0;
        for (var se = 0; se < specs.length; se++) {
            estTotal += estimatedBytes(specs[se].w, specs[se].h, fps, settings.quality, nFrames);
        }
        var wantStream = shouldStreamToDisk(estTotal);
        var streamToDisk = false;

        function abortExport(msg) {
            setStatus(msg, 'warning');
            restore3dViewport();
            exporting = false;
            setControlsDisabled(false);
        }

        if (wantStream) {
            var picker = stitched ? window.showSaveFilePicker : window.showDirectoryPicker;
            if (typeof picker === 'function') {
                try {
                    if (stitched) {
                        specs[0].fileHandle = await window.showSaveFilePicker({
                            suggestedName: specs[0].filename,
                            types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
                        });
                    } else {
                        // Deliberately NOT cached to `state.exportDirHandle`:
                        // showSlpExportAllModal REUSES that handle without
                        // prompting, so stashing a video destination there would
                        // silently redirect a later SLP export into it.
                        var dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                        for (var sd = 0; sd < specs.length; sd++) {
                            specs[sd].fileHandle = await dirHandle.getFileHandle(specs[sd].filename, { create: true });
                        }
                    }
                    streamToDisk = true;
                } catch (pickErr) {
                    // Declining the destination for an export this size means
                    // the export cannot safely proceed — buffering ~
                    // fmtBytes(estTotal) in memory is what we were avoiding.
                    // Say that rather than silently doing the risky thing.
                    if (pickErr && pickErr.name === 'AbortError') {
                        abortExport('Overlay video export cancelled — an export this large (~' +
                            fmtBytes(estTotal) + ') needs a destination folder or file to stream into');
                        return;
                    }
                    console.warn('[overlay export] destination pick failed:', pickErr);
                    for (var sc2 = 0; sc2 < specs.length; sc2++) specs[sc2].fileHandle = null;
                }
            }
            if (!streamToDisk) {
                // No File System Access API (or it failed): the whole file has
                // to be built in memory. Mirror the JSON exporter and let the
                // user decide instead of risking the tab silently.
                if (!window.confirm('This export is about ' + fmtBytes(estTotal) + '. Without a ' +
                    'save-file picker it must be built entirely in memory, which may crash the ' +
                    'tab.\n\nExport anyway?')) {
                    abortExport('Overlay video export cancelled');
                    return;
                }
            }
        }

        var ok = true;
        try {
            for (var sw = 0; sw < specs.length; sw++) {
                var writer = await makeWriter(specs[sw].canvas, specs[sw].w, specs[sw].h,
                    fps, nFrames, specs[sw].fileHandle);
                specs[sw].writer = writer;
                targets.push(writer);
                if (specs[sw].job) specs[sw].job.target = writer;
            }

            for (var f = expStart; f <= expEnd; f++) {
                if (cancelled) break;
                var out = f - expStart;

                if (session.lazyLoader && !session.frameGroups.has(f)) {
                    try { await ensureLazyFrameData(f); } catch (e) { /* frame stays empty */ }
                }
                var frameGroup = session.getFrameGroup(f);
                var groups = getInstanceGroupsForFrame(f);
                if (settings.layers.reproj || settings.layers.errors) ensureReprojections(groups, session);
                var ofg = toOverlayFrameGroup(frameGroup);

                // Decode every 2D tile's frame in parallel.
                var decodes = jobs.map(function (job) {
                    if (job.entry.tile.is3d) return Promise.resolve(null);
                    var view = findView(job.entry.tile.viewName);
                    if (!view || !view.decoder) return Promise.resolve(null);
                    return view.decoder.getFrame(f).catch(function () { return null; });
                });
                var bitmaps = await Promise.all(decodes);
                if (cancelled) break;

                if (vp3d && job3d) {
                    try {
                        vp3d.setFrame(getInstanceGroupsForFrame(f));
                        vp3d.renderer.render(vp3d.scene, vp3d.threeCamera);
                    } catch (e) { /* keep the last rendered 3D frame */ }
                }

                for (var jj = 0; jj < jobs.length; jj++) {
                    var job = jobs[jj];
                    if (job.entry.tile.is3d) {
                        job.ctx.fillStyle = '#000';
                        job.ctx.fillRect(0, 0, job.w, job.h);
                        if (vp3d) {
                            try { job.ctx.drawImage(vp3d.renderer.domElement, 0, 0, job.w, job.h); } catch (e) { /* ignore */ }
                        }
                    } else {
                        var view2 = findView(job.entry.tile.viewName);
                        if (!view2) continue;
                        drawExportTile(job, view2, bitmaps[jj], frameGroup, ofg, groups);
                    }
                }

                if (stitched) {
                    compositeCtx.fillStyle = '#000';
                    compositeCtx.fillRect(0, 0, outW, outH);
                    for (var jc = 0; jc < jobs.length; jc++) {
                        var jb = jobs[jc];
                        compositeCtx.drawImage(jb.canvas, jb.dstRect.x, jb.dstRect.y, jb.dstRect.width, jb.dstRect.height);
                    }
                }

                // Awaiting each writer IS the backpressure — mediabunny settles
                // the promise once the encoder has room, so the old
                // `while (encodeQueueSize > 12)` spin is gone. It also rejects
                // if the encoder died, which the spin could never notice.
                for (var tq = 0; tq < targets.length; tq++) {
                    await targets[tq].addFrame(out);
                }

                if (out % 5 === 0 || f === expEnd) {
                    var pct = Math.round(((out + 1) / nFrames) * 100);
                    progressFill.style.width = pct + '%';
                    progressLabel.textContent = 'Encoding ' + (out + 1) + ' / ' + nFrames;
                    await new Promise(function (r) { setTimeout(r, 0); });
                }
            }

            if (!cancelled) {
                progressLabel.textContent = 'Finalizing…';
                for (var fj = 0; fj < specs.length; fj++) {
                    var res = await specs[fj].writer.finish();
                    if (!res.streamed) {
                        downloadBlob(res.blob, specs[fj].filename);
                        // Serial downloads need a beat between them or the
                        // browser coalesces/drops the later ones.
                        if (specs.length > 1) await new Promise(function (r) { setTimeout(r, 250); });
                    }
                }
                if (stitched) {
                    setStatus('Overlay video exported: ' + specs[0].filename + ' (' + nFrames +
                        ' frames @ ' + fps + ' fps, ' + outW + '×' + outH + ')', 'success');
                } else {
                    setStatus('Overlay videos exported: ' + specs.length + ' file' +
                        (specs.length === 1 ? '' : 's') + ' (' + nFrames + ' frames @ ' +
                        fps + ' fps)', 'success');
                }
            } else {
                // Cancelling a STREAMED export still commits whatever reached
                // the file (mediabunny closes the writable), so the partial
                // .mp4 on disk is real and unplayable — say so rather than
                // letting the user find it later.
                for (var cj = 0; cj < specs.length; cj++) {
                    if (specs[cj].writer) await specs[cj].writer.cancel();
                }
                setStatus(streamToDisk
                    ? 'Overlay video export cancelled — partial file(s) were written to the chosen destination'
                    : 'Overlay video export cancelled', 'warning');
            }
        } catch (err) {
            ok = false;
            console.error('[overlay export] failed:', err);
            setStatus('Overlay video export failed: ' + err.message, 'error');
        }

        // Tear down anything still open (a mid-export throw leaves writers live).
        for (var tc = 0; tc < targets.length; tc++) {
            try { await targets[tc].cancel(); } catch (e) { /* ignore */ }
        }
        restore3dViewport();
        exporting = false;
        if (ok) cleanup(); else setControlsDisabled(false);
    }

    /** Export-time twin of `paintTile`, at the tile's OUTPUT pixel size. */
    function drawExportTile(job, view, bitmap, frameGroup, ofg, groups) {
        var ctx = job.ctx;
        ctx.clearRect(0, 0, job.w, job.h);
        if (settings.background === 'video') {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, job.w, job.h);
            if (bitmap) {
                var fit = fitRect(view.videoWidth, view.videoHeight, job.w, job.h);
                try { ctx.drawImage(bitmap, fit.x, fit.y, fit.width, fit.height); } catch (e) { /* ignore */ }
            }
        } else {
            ctx.fillStyle = BG_FILL[settings.background] || '#000';
            ctx.fillRect(0, 0, job.w, job.h);
        }
        var opts = overlayOptionsFrom(settings, view.videoWidth, view.videoHeight, job.w, job.h);
        opts.unlinkedInstances = collectUnlinked(frameGroup, view.name);
        drawFrameOverlays(job.overlayCtx, view.name, ofg, groups, session, opts);
        ctx.drawImage(job.overlay, 0, 0);
    }

    function setControlsDisabled(on) {
        exportBtn.disabled = on;
        trackEl.style.pointerEvents = on ? 'none' : '';
        stripEl.style.pointerEvents = on ? 'none' : '';
        dockEl.style.pointerEvents = on ? 'none' : '';
        settingsEl.querySelectorAll('input,select').forEach(function (el) { el.disabled = on; });
        cancelBtn.textContent = on ? 'Stop' : 'Cancel';
    }

    // ========================================================================
    // Wiring + lifecycle
    // ========================================================================

    exportBtn.addEventListener('click', function () {
        if (exporting) return;
        runExport();
    });

    cancelBtn.addEventListener('click', function () {
        if (exporting) { cancelled = true; return; }
        cleanup();
    });

    resetBtn.addEventListener('click', function () {
        settings = settingsFromVisibilityPanel();
        saveOverlayExportSettings(settings);
        buildSettings();
        layoutTrack();
        applyDockAspect();
        schedulePreview();
    });

    // Esc closes the modal, or stops an in-progress export (CLAUDE.md › Modals).
    function onKey(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        if (exporting) { cancelled = true; return; }
        cleanup();
    }
    document.addEventListener('keydown', onKey, true);

    var onWinResize = function () { schedulePreview(); };
    window.addEventListener('resize', onWinResize);

    function cleanup() {
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onWinResize);
        if (tileResizeObserver) { try { tileResizeObserver.disconnect(); } catch (e) { /* ignore */ } }
        if (dockFrameObserver) { try { dockFrameObserver.disconnect(); } catch (e) { /* ignore */ } }
        dispose3D();
        try { dockview.dispose(); } catch (e) { /* ignore */ }
        tiles.clear();
        overlay.remove();
    }

    // ---- initial state ------------------------------------------------------
    buildStrip();
    buildSettings();

    seedLayout();
    setRange(0, lastIdx);
    showFrame(previewFrame);
    layoutTrack();
    applyDockAspect();
    refreshSummary();

    // Seed the dock to mirror the main window: the videos in a grid, the 3D
    // viewport docked to the right of the whole grid. `seedLayoutPlan` returns
    // positions that reference EARLIER entries by index; substitute the real
    // dockview panel ids as we go.
    function seedLayout() {
        var names = state.views.map(function (v) { return v.name; });
        var plan = seedLayoutPlan(names, has3D);
        var ids = [];
        for (var i = 0; i < plan.length; i++) {
            var step = plan[i];
            var pos;
            if (!step.position) pos = undefined;
            else if (step.position.refIndex != null) {
                pos = { referencePanel: ids[step.position.refIndex], direction: step.position.direction };
            } else {
                pos = { direction: step.position.direction };
            }
            ids.push(addPanelReturningId(step.viewName, pos));
        }
    }

    function addPanelReturningId(viewName, position) {
        panelCounter++;
        var id = 'ovtile-' + viewName + '-' + panelCounter;
        dockApi.addPanel({
            id: id,
            component: 'tile',
            title: viewName === TILE_3D ? '3D View' : viewName,
            params: { viewName: viewName },
            position: position,
        });
        return id;
    }

    return {
        // Test hooks — the modal is otherwise fully self-contained.
        _overlay: overlay,
        _settings: function () { return settings; },
        _tiles: function () { return tiles; },
        _captureLayout: captureLayout,
        _close: cleanup,
    };
}
