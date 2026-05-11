// ui/sessions-panes.js — Pass 3h extraction
//
// Hosts:
//   - Dockview pane manager (`panelRenderers`, `VideoPaneRenderer`,
//     `mapPositionToDirection`, `updateStripItemStatus`,
//     `refreshPaneInteractions`, `renderDuplicatePanels`).
//   - View strip (`multiSelectViews`, `clearMultiSelect`,
//     `populateVideoBrightnessTable`, `applyVideoBrightness`,
//     `clampRotation`, `populateVideoRotationTable`, `syncRotationUI`,
//     `populateViewStrip`).
//   - Sessions panel (`populateSessionsPanel`).
//   - Session strip (`populateSessionStrip`).
//   - Move video modal + transfer (`parseDroppedViewNames`,
//     `showMoveVideoModal`, `moveVideosToSession`).
//   - Remove session (`removeSession`).
//   - Switch session (`switchSession`).
//   - View strip thumbnails (`updateViewStripThumbnail`,
//     `updateAllStripThumbnails`).
//
// Extracted from app.js per the consolidated Pass 3 plan, Module 11.

import { DockviewComponent, themeDark } from 'https://cdn.jsdelivr.net/npm/dockview-core/+esm';
import {
    state,
    videoController, interactionManager, viewport3d, timeline, paneManager,
    setVideoController, setPaneManager,
} from './app-state.js';
import { FrameGroup, UnlinkedInstance, Camera } from '../pose/pose-data.js';
import {
    triangulateAndReproject, storeReprojectedInstances, getInstanceGroupsForFrame,
    sessionHasCalibration,
} from '../pose/triangulation.js';
import {
    cellResizeObserver,
    createViewForVideoFile,
    rebuildVideoController,
    fitCanvasesToCells,
    updateTotalFrames,
} from '../loading/session-loader.js';
import { OnDemandVideoDecoder } from '../loading/video.js';
import { setStatus, showLoading, hideLoading } from '../import-export/save-load.js';
import { drawAllOverlays, setReprojErrorVisible } from './rendering.js';
import { updateInfoPanel } from './info-panel.js';
// `autoAssignState` is a mutable binding tracked via ESM live binding.
// The cycle (identity-assignment imports panelRenderers from here) is
// hoist-safe because both reads are inside function bodies.
import { autoAssignState } from './identity-assignment.js';

// Pass 3i-3: setup3DViewport moved to pose/initialization.js.
import { setup3DViewport } from '../pose/initialization.js';
import { getLoadingProgressModal } from './loading-progress-modal.js';

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
        state.currentFrame = state.session.lastFrame || 0;
        if (videoController) videoController.seekToFrame(state.currentFrame);
        drawAllOverlays(state.currentFrame);
        setTimeout(function () {
            fitCanvasesToCells();
            refreshPaneInteractions();
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

    // Cold-reserve initialization — decoders trimmed off the active pool
    // (when a smaller session follows a larger one) park here and get
    // closed after 60s idle. Rehydrating from this reserve cancels the
    // close timer.
    if (!state._decoderPoolCold) state._decoderPoolCold = [];

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

    // Save per-session timeline height + collapsed state so the next visit
    // to oldSession restores the user's customization. Read via
    // `document.getElementById` (already stubbed by the brace-walked tests)
    // rather than importing from `timeline-controller.js` — adding a new
    // imported dep would require all session-switch tests to stub it.
    var _tlElOut = (typeof document !== 'undefined' && document.getElementById)
        ? document.getElementById('timelineContainer')
        : null;
    if (_tlElOut) {
        var _hStr = _tlElOut.style && _tlElOut.style.height;
        var _h = parseFloat(_hStr);
        if (!isNaN(_h) && _h > 0) {
            oldSession._timelineHeight = _h;
        }
        oldSession._timelineCollapsed = !!(
            _tlElOut.classList &&
            _tlElOut.classList.contains &&
            _tlElOut.classList.contains('collapsed')
        );
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

    // Update timeline session reference up front so its track segments and
    // frame markers reflect the new session within ~1 frame of the click,
    // instead of waiting for all decoders to finish switching. The video
    // panes will still show their loading spinner during the parallel
    // decoder switch below. Later calls to timeline.setData (inside
    // rebuildVideoController and at the bottom of this function) become
    // idempotent (timeline._session === newSession).
    //
    // Block 1: also refresh the new session's uploaded-camera marker now
    // (using whatever state.views looks like at this moment — typically
    // the previous session's views are still attached). It will be
    // re-recomputed below after views are rebuilt. Inlined rather than
    // imported from session-loader so the brace-walked switchSession test
    // harness (test-session-switch-frame-reset.js, …) doesn't need an
    // extra stub parameter.
    if (newSession) {
        newSession._uploadedCameras = (state.views || []).map(function (v) {
            return v.cameraName || v.name;
        });
    }
    if (timeline) timeline.setData(newSession);

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

    // Pre-extend the decoder pool. Each new slot is filled by reviving a
    // decoder from the cold reserve (cancelling its eviction timer) when
    // available, or null otherwise. This avoids the race where two parallel
    // `push` calls land in non-deterministic order, and recycles decoders
    // from a recently-shrunk pool instead of constructing new ones.
    while (state.decoderPool.length < newSession.videoFileIndices.length) {
        var revived = null;
        while (state._decoderPoolCold.length > 0) {
            var cand = state._decoderPoolCold.pop();
            if (cand && cand._coldTimer) {
                clearTimeout(cand._coldTimer);
                cand._coldTimer = null;
            }
            if (cand) { revived = cand; break; }
        }
        state.decoderPool.push(revived);
    }

    var modal = getLoadingProgressModal({ title: 'Loading videos' });
    modal.reset();
    modal.show();
    var taskIds = newSession.videoFileIndices.map(function (vfIdx) {
        var vf = state.videoFiles[vfIdx];
        var label = (vf && vf.file && vf.file.name) || ('camera ' + vfIdx);
        return modal.addTask({ label: label });
    });

    showLoading('Loading videos…');

    // Phase 4: parallel decoder-switching. For 4 cameras at ~500 ms each,
    // sequential awaits would take ~2000 ms; Promise.all reduces this to
    // ~max-of-all (~500 ms). On failure for any one camera, vf.decoder
    // remains null so the second-pass createViewForVideoFile is skipped
    // for that camera via the existing guard.
    await Promise.all(newSession.videoFileIndices.map(async function (vfIdx, vi) {
        var vf = state.videoFiles[vfIdx];
        if (vf && vf.file) {
            var taskId = taskIds[vi];
            var onProgress = function (ev) {
                if (ev && ev.error) modal.failTask(taskId, ev.error);
                else modal.updateTask(taskId, ev);
            };
            try {
                if (state.decoderPool[vi] != null) {
                    // Reuse pool decoder — swap source without creating new video element
                    state.decoderPool[vi]._onProgress = onProgress;
                    state.decoderPool[vi].onProgress = onProgress;
                    await state.decoderPool[vi].switchSource(vf.file);
                    vf.decoder = state.decoderPool[vi];
                } else {
                    // No pool decoder for this slot — create one and assign by index.
                    // Indexed assignment (not push) keeps slot order deterministic
                    // when multiple inits resolve out of order.
                    var newDec = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10, onProgress: onProgress });
                    await newDec.init(vf.file);
                    vf.decoder = newDec;
                    state.decoderPool[vi] = newDec;
                }
                vf.videoWidth = vf.decoder.videoTrack.video.width;
                vf.videoHeight = vf.decoder.videoTrack.video.height;
                vf.frameCount = vf.decoder.samples.length;
                // Note: completeTask is intentionally deferred until after
                // the first frame has actually painted (see seekPromise.then
                // below) so the bar can't sit at 100% while the canvas is
                // still empty. The task currently sits at the mp4box
                // ratio:1 weighted display (90%).
            } catch (e) {
                console.error('[switchSession] Video init failed:', e);
                modal.failTask(taskId, e);
            }
        }
    }));

    // Trim the pool to the new session's camera count. Surplus decoders
    // (from a larger previous session) move into the cold reserve with a
    // 60s eviction timer. Rehydration on the next swap pops from this
    // reserve and cancels the timer. Keeps the pool's active region equal
    // to the current session's camera count without throwing away usable
    // decoders immediately. Catches stability-review Issue #3: pool slots
    // from earlier-larger sessions leaking through repeated swaps.
    var activeCount = newSession.videoFileIndices.length;
    while (state.decoderPool.length > activeCount) {
        // IIFE captures per-iteration `coldDec` binding; without it, all
        // setTimeout closures reference the same hoisted `var`.
        (function (coldDec) {
            if (!coldDec) return;
            // Wipe stale per-load callbacks so the cold decoder doesn't
            // accidentally drive an unrelated modal task.
            coldDec._onProgress = null;
            coldDec.onProgress = null;
            // Schedule close after 60s idle; rehydrate cancels this.
            coldDec._coldTimer = setTimeout(function () {
                var idx = state._decoderPoolCold.indexOf(coldDec);
                if (idx >= 0) state._decoderPoolCold.splice(idx, 1);
                if (typeof coldDec.close === 'function') {
                    try { coldDec.close(); } catch (_e) {}
                }
                coldDec._coldTimer = null;
            }, 60000);
            state._decoderPoolCold.push(coldDec);
        })(state.decoderPool.pop());
    }

    // Second pass — deterministic for-loop. createViewForVideoFile has DOM
    // side effects so we run it in source order after Promise.all resolves,
    // not interleaved with the parallel awaits.
    for (var vi2 = 0; vi2 < newSession.videoFileIndices.length; vi2++) {
        var vf2 = state.videoFiles[newSession.videoFileIndices[vi2]];
        if (vf2 && vf2.decoder) {
            createViewForVideoFile(vf2);
        }
    }
    updateTotalFrames();
    paneManager.addAllViewsAsGrid();
    rebuildVideoController();

    var targetFrame = newSession.lastFrame || 0;
    fitCanvasesToCells();
    refreshPaneInteractions();
    state.currentFrame = targetFrame;
    // Keep the showLoading('Loading videos…') overlay up until the first
    // frame has actually painted (seekToFrame resolves after each pane's
    // decoder has decoded the target frame AND drawImage'd it). This
    // prevents the user from scrubbing onto an empty canvas during the
    // brief window between hideLoading and the first paint. Capped at
    // SEEK_TIMEOUT_MS so a stuck decoder can't freeze the UI; on timeout
    // the overlay lifts even though seekPromise is still running in the
    // background — the frame paints whenever it's ready.
    var SEEK_TIMEOUT_MS = 3000;
    var seekRawPromise = (videoController && state.views.length > 0)
        ? Promise.resolve(videoController.seekToFrame(targetFrame))
        : Promise.resolve();
    // When the seek actually succeeds, mark every non-failed task complete
    // so the modal's bars finish to 100% (and the auto-dismiss schedules).
    // This intentionally fires INDEPENDENTLY of the Promise.race below: if
    // the seek wins the race, this then() runs immediately; if the timeout
    // wins, this then() runs whenever the seek eventually finishes, even
    // after hideLoading has lifted the overlay.
    seekRawPromise.then(function () {
        for (var ti = 0; ti < taskIds.length; ti++) {
            var tid = taskIds[ti];
            if (tid == null) continue;
            var ts = modal.getTaskState(tid);
            if (ts && ts.status !== 'error') modal.completeTask(tid);
        }
    }, function (e) {
        // Seek failure: log only — leave tasks at the mp4box ratio:1
        // display (90%) so the user can see the load got close but the
        // first frame never landed.
        console.error('[switchSession] first-frame seek failed:', e);
    });
    await Promise.race([
        seekRawPromise.catch(function () { return null; }),
        new Promise(function (r) { setTimeout(r, SEEK_TIMEOUT_MS); }),
    ]);
    hideLoading();
    drawAllOverlays(targetFrame);

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

    // Block 1: recompute the uploaded-camera filter for the NEW session
    // (using the freshly-rebuilt state.views) before the timeline reads it.
    // Inlined for test-harness compatibility — see comment near the earlier
    // assignment at the top of switchSession.
    if (newSession) {
        newSession._uploadedCameras = (state.views || []).map(function (v) {
            return v.cameraName || v.name;
        });
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

    // Restore per-session timeline height + collapsed state. First visit
    // (no `_timelineHeight` stored) → fit to the new session's data,
    // capped at 40% of window.innerHeight (same default the SLP-import
    // path uses). Inlined rather than imported from `timeline-controller`
    // so the brace-walked switchSession test harness doesn't need an
    // additional stub parameter.
    var _tlElIn = (typeof document !== 'undefined' && document.getElementById)
        ? document.getElementById('timelineContainer')
        : null;
    if (_tlElIn) {
        if (_tlElIn.classList && _tlElIn.classList.remove) {
            _tlElIn.classList.remove('collapsed');
        }
        if (newSession._timelineHeight && newSession._timelineHeight > 0) {
            _tlElIn.style.height = newSession._timelineHeight + 'px';
        } else if (timeline && typeof timeline.getPreferredHeight === 'function') {
            var _pref = timeline.getPreferredHeight();
            var _winH = (typeof window !== 'undefined' && window.innerHeight)
                ? window.innerHeight
                : 1080;
            var _target = Math.min(_pref, Math.floor(0.4 * _winH));
            if (_target > 0) _tlElIn.style.height = _target + 'px';
        }
        if (newSession._timelineCollapsed && _tlElIn.classList && _tlElIn.classList.add) {
            _tlElIn.classList.add('collapsed');
        }
        if (timeline && typeof timeline.resize === 'function') timeline.resize();
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
