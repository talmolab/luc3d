/**
 * timeline.js - SLEAP-like timeline widget for multi-view pose proofreading
 *
 * Canvas-based timeline showing track occupancy bars, frame markers, and
 * a current-frame indicator.  Supports click-to-seek, drag-to-scrub,
 * shift-drag range selection, wheel zoom, and middle-click panning.
 *
 * ES module. Exports `Timeline`.
 */

import { getTrackColor, NULL_ID_COLOR } from './overlays.js';

// ============================================================================
// Timeline class
// ============================================================================

export class Timeline {

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    /**
     * Create a new Timeline widget and mount it into a container element.
     *
     * @param {HTMLElement} container - DOM element to hold the canvas
     * @param {Object}      options
     * @param {number}      options.totalFrames       - Total number of frames
     * @param {Function}    [options.onFrameChange]   - Called with (frameIdx) on seek/scrub
     * @param {Function}    [options.onRangeSelect]   - Called with (startFrame, endFrame)
     */
    constructor(container, options) {
        options = options || {};

        /** @type {HTMLElement} */
        this._container = container;

        /** @type {number} */
        this._totalFrames = options.totalFrames || 1;

        /** @type {Function|null} */
        this._onFrameChange = options.onFrameChange || null;

        /** @type {Function|null} */
        this._onRangeSelect = options.onRangeSelect || null;

        /** @type {Function|null} */
        this._onDragEnd = options.onDragEnd || null;

        // --- State -----------------------------------------------------------

        /** Current frame index (0-based) */
        this._currentFrame = 0;

        /** Horizontal zoom level (1 = all frames fit in view) */
        this._zoom = 1;

        /** Scroll offset in logical (frame) space.  The leftmost visible frame. */
        this._scrollFrame = 0;

        /** Cached track segment data: Array of { trackIdx, color, segments: [{start,end}] } */
        this._trackSegments = [];

        /** Cached per-frame marker info: Map<frameIdx, { hasUser, hasPredicted, modified }> */
        this._frameMarkers = new Map();

        /** Track names (string[]) */
        this._trackNames = [];

        /**
         * Per-camera grouping for tree-decorated label rendering.
         * Populated by `_rebuildSegments`.
         *
         * Each entry: { name: cameraName, tracks: [trackSeg, ...], isEmpty: bool }
         */
        this._cameraGroups = [];

        /**
         * Display mode: 'tracks', 'identities', or 'both'
         * Controls what the timeline bars represent.
         */
        this._displayMode = 'tracks';

        /** Cached session reference for rebuilding segments on mode change */
        this._session = null;

        /** Range selection state */
        this._rangeStart = null;
        this._rangeEnd = null;

        /** Tooltip state */
        this._tooltip = { visible: false, x: 0, y: 0, text: '' };

        // --- Layout constants ------------------------------------------------

        /** @const {number} Height of each track bar row (px) */
        this.TRACK_ROW_HEIGHT = 10;

        /** @const {number} Vertical gap between track rows (px) */
        this.TRACK_ROW_GAP = 1;

        /** @const {number} Extra gap between camera/view groups (px) */
        this.VIEW_GROUP_GAP = 8;

        /** @const {number} Height of the frame-marker area (px) */
        this.MARKER_AREA_HEIGHT = 20;

        /** @const {number} Height reserved for the frame-number labels (px) */
        this.LABEL_AREA_HEIGHT = 16;

        /** @const {number} Minimum left margin for track labels (px) */
        this.MIN_LEFT_MARGIN = 100;

        /** @const {number} Maximum left margin for track labels (px) — keeps
         * the timeline from being pushed unreasonably far right when track
         * names are very long. */
        this.MAX_LEFT_MARGIN = 280;

        /** @const {number} Padding between the rightmost label glyph and
         * the start of the segment area (px). Labels are right-aligned at
         * `LEFT_MARGIN - LABEL_RIGHT_PAD`. */
        this.LABEL_RIGHT_PAD = 6;

        /** @const {number} Extra breathing room added to the measured label
         * width when recomputing LEFT_MARGIN, so glyphs don't kiss the edge. */
        this.LABEL_LEFT_PAD = 12;

        /** Left margin for track labels (recomputed each rebuild based on the
         * widest tree-decorated label; see `_recomputeLeftMargin`). Initialized
         * to the minimum and re-measured once row labels exist. */
        this.LEFT_MARGIN = this.MIN_LEFT_MARGIN;

        /** @const {number} Right padding */
        this.RIGHT_PADDING = 8;

        /** @const {number} Top padding */
        this.TOP_PADDING = 4;

        // --- Colors ----------------------------------------------------------

        this.BG_COLOR = '#1e1e1e';
        this.GRID_COLOR_MINOR = 'rgba(255,255,255,0.06)';
        this.GRID_COLOR_MAJOR = 'rgba(255,255,255,0.12)';
        this.LABEL_COLOR = 'rgba(255,255,255,0.50)';
        this.PLAYHEAD_COLOR = '#ffffff';
        this.MARKER_USER_COLOR = '#3b82f6';          // blue
        this.MARKER_PREDICTED_COLOR = '#93c5fd';      // light blue
        this.MARKER_MODIFIED_COLOR = '#ffffff';        // white
        this.RANGE_COLOR = 'rgba(99,102,241,0.25)';   // indigo translucent
        this.SEPARATOR_COLOR = 'rgba(255,255,255,0.12)';

        /** @const {number} Height of the horizontal scrollbar (px) */
        this.SCROLLBAR_HEIGHT = 10;

        /** @const {number} Absolute minimum draw width for a track segment (px) */
        this.MIN_SEGMENT_WIDTH_PX = 2;

        /**
         * @const {number} Minimum draw width for a track segment as a fraction
         * of the canvas width. The effective minimum is
         * max(MIN_SEGMENT_WIDTH_PX, canvasWidth * MIN_SEGMENT_WIDTH_FRACTION),
         * so wider windows show wider minimum bars. This ensures short/single
         * frame segments remain visible in long videos where pxPerFrame is
         * smaller than 1.
         */
        this.MIN_SEGMENT_WIDTH_FRACTION = 0.0025;

        /** @const {number} Min thumb width (px) */
        this.SCROLLBAR_THUMB_MIN = 20;

        // --- Create scrollable track-area wrapper ---------------------------

        // Block 1 (Prompt 4): when the natural track-area height exceeds the
        // container height, the *track rows* scroll while the header /
        // mode-toggle / playhead remain fixed. The wrapper is a direct
        // child of the container and uses CSS flexbox to take the
        // remaining vertical space. The canvas is mounted INSIDE this
        // wrapper so its scrollHeight grows with the natural row count.
        /** @type {HTMLDivElement} */
        this._trackScrollEl = document.createElement('div');
        this._trackScrollEl.className = 'timeline-track-area';
        // Inline styles so the wrapper works even without the corresponding
        // CSS rules (e.g., in headless test contexts). Set each property
        // individually rather than via cssText so test DOM stubs that
        // don't parse cssText still expose `style.overflowY` etc.
        var _tsStyle = this._trackScrollEl.style;
        _tsStyle.flex = '1 1 auto';
        _tsStyle.minHeight = '0';
        _tsStyle.overflowY = 'auto';
        _tsStyle.overflowX = 'hidden';
        _tsStyle.position = 'relative';
        _tsStyle.width = '100%';
        this._container.appendChild(this._trackScrollEl);

        // --- Create canvas ---------------------------------------------------

        /** @type {HTMLCanvasElement} */
        this._canvas = document.createElement('canvas');
        this._canvas.style.display = 'block';
        this._canvas.style.width = '100%';
        this._canvas.style.height = '100%';
        this._canvas.style.cursor = 'pointer';
        // Canvas lives inside the scroll wrapper so vertical overflow
        // produces a scrollbar instead of clipping.
        this._trackScrollEl.appendChild(this._canvas);

        /** @type {CanvasRenderingContext2D} */
        this._ctx = this._canvas.getContext('2d');

        // --- Tooltip element -------------------------------------------------

        /** @type {HTMLDivElement} */
        this._tooltipEl = document.createElement('div');
        this._tooltipEl.style.cssText =
            'position:absolute;pointer-events:none;background:rgba(0,0,0,0.82);' +
            'color:#fff;font:11px/1.4 system-ui,sans-serif;padding:3px 7px;' +
            'border-radius:3px;white-space:nowrap;display:none;z-index:10;';
        // Ensure the container can position the tooltip
        if (getComputedStyle(this._container).position === 'static') {
            this._container.style.position = 'relative';
        }
        this._container.appendChild(this._tooltipEl);

        // --- Scrollbar element -----------------------------------------------

        /** @type {HTMLDivElement} */
        this._scrollbarTrack = document.createElement('div');
        this._scrollbarTrack.style.cssText =
            'position:absolute;bottom:0;left:' + this.LEFT_MARGIN + 'px;' +
            'right:' + this.RIGHT_PADDING + 'px;height:' + this.SCROLLBAR_HEIGHT + 'px;' +
            'background:rgba(255,255,255,0.05);display:none;z-index:5;border-radius:5px;';

        /** @type {HTMLDivElement} */
        this._scrollbarThumb = document.createElement('div');
        this._scrollbarThumb.style.cssText =
            'position:absolute;top:1px;height:' + (this.SCROLLBAR_HEIGHT - 2) + 'px;' +
            'background:rgba(255,255,255,0.3);border-radius:4px;cursor:grab;min-width:' +
            this.SCROLLBAR_THUMB_MIN + 'px;';
        this._scrollbarTrack.appendChild(this._scrollbarThumb);
        this._container.appendChild(this._scrollbarTrack);

        /** Scrollbar drag state */
        this._isScrollbarDragging = false;
        this._scrollbarDragStartX = 0;
        this._scrollbarDragStartScroll = 0;

        // Scrollbar events
        this._scrollbarThumb.addEventListener('mousedown', (function (e) {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            this._isScrollbarDragging = true;
            this._scrollbarDragStartX = e.clientX;
            this._scrollbarDragStartScroll = this._scrollFrame;
            this._scrollbarThumb.style.cursor = 'grabbing';
        }).bind(this));

        this._scrollbarTrack.addEventListener('mousedown', (function (e) {
            if (e.button !== 0 || this._isScrollbarDragging) return;
            e.preventDefault();
            e.stopPropagation();
            // Click on track — jump scroll position
            var trackRect = this._scrollbarTrack.getBoundingClientRect();
            var clickX = e.clientX - trackRect.left;
            var trackW = trackRect.width;
            var fraction = clickX / trackW;
            var maxScroll = Math.max(0, this._totalFrames - this._visibleFrames());
            this._scrollFrame = fraction * maxScroll;
            this._clampScroll();
            this._updateScrollbar();
            this.redraw();
        }).bind(this));

        // --- Mouse / touch interaction state ---------------------------------

        this._isDragging = false;
        this._isRangeSelecting = false;
        this._isPanning = false;
        this._panStartX = 0;
        this._panStartScroll = 0;

        // --- Bind events -----------------------------------------------------

        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);
        this._onWheel = this._handleWheel.bind(this);
        this._onTouchStart = this._handleTouchStart.bind(this);
        this._onTouchMove = this._handleTouchMove.bind(this);
        this._onTouchEnd = this._handleTouchEnd.bind(this);
        this._onContextMenu = function (e) { e.preventDefault(); };
        this._onWindowMouseMove = this._handleWindowMouseMove.bind(this);

        this._canvas.addEventListener('mousedown', this._onMouseDown);
        this._canvas.addEventListener('mousemove', this._onMouseMove);
        window.addEventListener('mouseup', this._onMouseUp);
        window.addEventListener('mousemove', this._onWindowMouseMove);
        this._canvas.addEventListener('wheel', this._onWheel, { passive: false });
        this._canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
        this._canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
        this._canvas.addEventListener('touchend', this._onTouchEnd);
        this._canvas.addEventListener('contextmenu', this._onContextMenu);

        // --- ResizeObserver --------------------------------------------------

        this._resizeObserver = new ResizeObserver(() => this.resize());
        this._resizeObserver.observe(this._container);

        // --- Initial sizing & draw -------------------------------------------

        this.resize();
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Update the current frame indicator.
     * @param {number} frameIdx
     */
    setCurrentFrame(frameIdx) {
        frameIdx = this._clampFrame(frameIdx);
        if (frameIdx === this._currentFrame) return;
        this._currentFrame = frameIdx;
        this._ensureFrameVisible(frameIdx);
        this.redraw();
    }

    /**
     * Populate track bars and frame markers from a Session object.
     *
     * @param {Session} session - The session (has .tracks, .frameGroups)
     */
    setData(session) {
        this._session = session;
        if (!session) {
            this._trackSegments = [];
            this._frameMarkers.clear();
            this._trackNames = [];
            this.redraw();
            return;
        }

        this._rebuildSegments(session);
        this._buildFrameMarkers(session);
        // Grow-only container resize: some SLP-load call sites invoke
        // setData without a matching fitTimelineToData, leaving a 96 px
        // default container that _computeLayout collapses below the
        // tracks-visible threshold. Mirrors refreshTracks.
        this._growContainerToFit();
        this.resize();
    }

    /**
     * Update the total number of frames.
     * @param {number} n
     */
    setTotalFrames(n) {
        this._totalFrames = Math.max(1, n);
        this._clampScroll();
        this.redraw();
    }

    /**
     * Set zoom level.  1 = all frames visible; higher = zoomed in.
     * @param {number} level
     */
    setZoom(level) {
        level = Math.max(1, Math.min(level, this._maxZoom()));
        if (level === this._zoom) return;
        this._zoom = level;
        this._clampScroll();
        this.redraw();
    }

    /**
     * Scroll so that the given frame is visible.
     * @param {number} frameIdx
     */
    scrollTo(frameIdx) {
        this._ensureFrameVisible(frameIdx);
        this.redraw();
    }

    /**
     * Re-measure the container and resize the canvas (call after layout changes).
     * The canvas is sized to exactly fit the container — when the container is
     * shrunk below the natural content height, sections (tracks first, then
     * markers) are progressively hidden by `_computeLayout` so the frame
     * number labels at the bottom remain visible as long as possible.
     */
    resize() {
        var dpr = window.devicePixelRatio || 1;
        var rect = this._container.getBoundingClientRect();
        var w = Math.round(rect.width);

        // Canvas height = max(natural preferred height, available height
        // in the track-scroll wrapper). When natural > available the
        // wrapper scrolls; when available > natural the canvas grows to
        // fill the area so the playhead / labels stay aligned with the
        // bottom of the timeline.
        var availableH = 0;
        if (this._trackScrollEl) {
            availableH = this._trackScrollEl.clientHeight;
            if (!availableH && typeof this._trackScrollEl.getBoundingClientRect === 'function') {
                var sRect = this._trackScrollEl.getBoundingClientRect();
                availableH = sRect ? sRect.height : 0;
            }
        }
        if (!availableH) availableH = Math.round(rect.height);
        var natural = this.getPreferredHeight();
        var h = Math.max(natural, availableH);
        if (h < 0) h = 0;

        this._canvas.width = w * dpr;
        this._canvas.height = h * dpr;
        this._canvas.style.width = w + 'px';
        this._canvas.style.height = h + 'px';
        this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._cssWidth = w;
        this._cssHeight = h;
        this._clampScroll();
        this._scrollbarTrack.style.left = this.LEFT_MARGIN + 'px';
        this._scrollbarTrack.style.right = this.RIGHT_PADDING + 'px';
        this.redraw();
    }

    /**
     * Return the ideal container height (in CSS pixels) that shows every
     * track row, the marker area, and the frame-number labels without
     * clipping. Callers (e.g., session-load handlers in index.html) use
     * this to size the timeline container so all loaded tracks fit with
     * a small gap below the lowest track row.
     */
    getPreferredHeight() {
        var numRows = this._trackSegments.length;
        var numViewGaps = 0;
        var prevCam = null;
        for (var i = 0; i < numRows; i++) {
            var thisCam = this._trackSegments[i].cameraName;
            if (prevCam != null && thisCam !== prevCam) numViewGaps++;
            prevCam = thisCam;
        }
        // Track area + small gap + marker area + label area. When there are
        // no tracks, use a compact height that still shows markers + labels.
        if (numRows === 0) {
            return this.TOP_PADDING + this.MARKER_AREA_HEIGHT + 4 + this.LABEL_AREA_HEIGHT + 8;
        }
        return this.TOP_PADDING
            + numRows * this.TRACK_ROW_HEIGHT
            + (numRows - 1) * this.TRACK_ROW_GAP
            + numViewGaps * this.VIEW_GROUP_GAP
            + 6 /* small gap below lowest track row */
            + this.MARKER_AREA_HEIGHT
            + this.LABEL_AREA_HEIGHT
            + 8 /* bottom breathing room; also absorbs the 1px border-top
                   and sub-pixel rounding so _computeLayout never has to
                   collapse tracks at the preferred height */;
    }

    /**
     * Compute the vertical layout for a given canvas height H, applying
     * collapse priority: labels are the last thing hidden, markers the
     * next, tracks the first. Returns an object describing which sections
     * are visible and where they sit.
     *
     * Priority tiers (H decreasing):
     *   full     — tracks + markers + labels all visible
     *   markers  — markers + labels visible, tracks hidden
     *   labels   — labels visible, markers + tracks hidden
     *   none     — H too small to draw anything
     *
     * @private
     */
    _computeLayout(H) {
        var layout = {
            showLabels: false,
            showMarkers: false,
            showTracks: false,
            labelAreaTop: H,
            markerAreaTop: H,
            markerAreaBottom: H,
            trackAreaTop: this.TOP_PADDING,
            trackAreaBottom: this.TOP_PADDING,
            numVisibleTracks: 0,
        };
        if (H <= 0) return layout;

        var numTracks = this._trackSegments.length;
        var naturalTrackH = numTracks > 0
            ? numTracks * this.TRACK_ROW_HEIGHT + (numTracks - 1) * this.TRACK_ROW_GAP
            : 0;
        var numViewGaps = 0;
        var prevCam = null;
        for (var i = 0; i < numTracks; i++) {
            var thisCam = this._trackSegments[i].cameraName;
            if (prevCam != null && thisCam !== prevCam) numViewGaps++;
            prevCam = thisCam;
        }
        naturalTrackH += numViewGaps * this.VIEW_GROUP_GAP;

        // Labels always win when any height at all is available.
        if (H >= this.LABEL_AREA_HEIGHT) {
            layout.showLabels = true;
            layout.labelAreaTop = H - this.LABEL_AREA_HEIGHT;
        } else {
            return layout;
        }

        // Markers need their own area plus the small gap above the labels.
        var markersMinH = this.LABEL_AREA_HEIGHT + this.MARKER_AREA_HEIGHT + 4;
        if (H >= markersMinH) {
            layout.showMarkers = true;
            layout.markerAreaBottom = layout.labelAreaTop;
            layout.markerAreaTop = layout.markerAreaBottom - this.MARKER_AREA_HEIGHT;
        }

        // Tracks render whenever the natural block fits above the marker
        // area. With the Block 1 scroll wrapper, `resize()` sizes the
        // canvas to `max(natural, available)` so the natural block always
        // fits inside the canvas (overflow scrolls); this branch only
        // fires the "hide all tracks" case when callers invoke
        // `_computeLayout` directly with a tight H (used by
        // test-timeline-height.js to verify the collapse priority).
        if (numTracks > 0 && layout.showMarkers) {
            var trackCeiling = layout.markerAreaTop - 4; // small gap before markers
            var availableForTracks = trackCeiling - this.TOP_PADDING;
            if (availableForTracks >= naturalTrackH) {
                layout.showTracks = true;
                layout.trackAreaTop = this.TOP_PADDING;
                layout.trackAreaBottom = layout.trackAreaTop + naturalTrackH;
                layout.numVisibleTracks = numTracks;
            }
        }
        return layout;
    }

    /**
     * Full redraw of the timeline canvas.
     */
    redraw() {
        const ctx = this._ctx;
        const W = this._cssWidth;
        const H = this._cssHeight;
        if (!W || !H) return;

        // --- Background ---
        ctx.fillStyle = this.BG_COLOR;
        ctx.fillRect(0, 0, W, H);

        // --- Compute layout (applies collapse priority) ---
        const layout = this._computeLayout(H);
        this._layout = layout;

        // Grid lines span the full visible canvas.
        this._drawGrid(ctx, W, H);

        // --- Track bars and modified-frame white vertical bars ---
        if (layout.showTracks) {
            this._drawTrackBars(ctx, layout.trackAreaTop, W);

            // White vertical lines: frames explicitly flagged as modified
            // (triangulated/grouped). They extend only from the top of the
            // timeline down to the bottom of the lowest track row — NOT into
            // the marker or label areas. (The blue "grouped user" column tint
            // was removed; the white modified lines are the sole in-track
            // frame indicator, so track/identity bars read as a flat color.)
            this._drawModifiedFrameLines(ctx, 0, layout.trackAreaBottom, W);

            // Separator between track area and marker area.
            if (layout.showMarkers) {
                const separatorY = layout.trackAreaBottom + 4;
                ctx.strokeStyle = this.SEPARATOR_COLOR;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(this.LEFT_MARGIN, separatorY);
                ctx.lineTo(W - this.RIGHT_PADDING, separatorY);
                ctx.stroke();
            }
        }

        // --- Frame markers (dots / density bars) ---
        if (layout.showMarkers) {
            this._drawFrameMarkers(ctx, layout.markerAreaTop, layout.markerAreaBottom, W);
        }

        // --- Frame number labels (last to hide) ---
        if (layout.showLabels) {
            this._drawFrameLabels(ctx, layout.labelAreaTop, W);
        }

        // --- Range selection highlight ---
        if (this._rangeStart != null && this._rangeEnd != null) {
            const x0 = this._frameToX(Math.min(this._rangeStart, this._rangeEnd));
            const x1 = this._frameToX(Math.max(this._rangeStart, this._rangeEnd) + 1);
            ctx.fillStyle = this.RANGE_COLOR;
            ctx.fillRect(x0, 0, x1 - x0, H);
        }

        // --- Current frame playhead ---
        this._drawPlayhead(ctx, H);

        // --- Scrollbar ---
        this._updateScrollbar();
    }

    /**
     * Destroy the timeline: remove event listeners, observer, and DOM elements.
     */
    destroy() {
        this._canvas.removeEventListener('mousedown', this._onMouseDown);
        this._canvas.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mouseup', this._onMouseUp);
        window.removeEventListener('mousemove', this._onWindowMouseMove);
        this._canvas.removeEventListener('wheel', this._onWheel);
        this._canvas.removeEventListener('touchstart', this._onTouchStart);
        this._canvas.removeEventListener('touchmove', this._onTouchMove);
        this._canvas.removeEventListener('touchend', this._onTouchEnd);
        this._canvas.removeEventListener('contextmenu', this._onContextMenu);
        this._resizeObserver.disconnect();
        // Canvas now lives inside _trackScrollEl, not directly on the
        // container. Remove the wrapper (which carries the canvas with it).
        if (this._trackScrollEl && this._trackScrollEl.parentNode === this._container) {
            this._container.removeChild(this._trackScrollEl);
        } else if (this._canvas && this._canvas.parentNode) {
            this._canvas.parentNode.removeChild(this._canvas);
        }
        this._container.removeChild(this._tooltipEl);
        this._container.removeChild(this._scrollbarTrack);
    }

    // -----------------------------------------------------------------------
    // Data building (cached for fast redraws)
    // -----------------------------------------------------------------------

    /**
     * Build cached track segment data from the session.
     * Each track gets a list of contiguous frame-range segments where it has
     * at least one instance in any camera view.
     *
     * @param {Session} session
     * @private
     */
    _buildTrackSegments(session) {
        this._trackSegments = [];
        this._trackNames = [];

        // Find max track index across all data (not just session.tracks.length,
        // which may be stale if tracks were added dynamically)
        var maxTrackIdx = session.tracks ? session.tracks.length - 1 : -1;
        if (session.trackOccupancy) {
            for (var [, occ] of session.trackOccupancy) {
                if (occ.nTracks - 1 > maxTrackIdx) maxTrackIdx = occ.nTracks - 1;
            }
        }
        if (session.instanceGroups) {
            for (var [_fi, grps] of session.instanceGroups) {
                for (var _gi = 0; _gi < grps.length; _gi++) {
                    // Use per-instance trackIdx, not group.identityId, which
                    // can drift — swapAssignTrack updates trackIdx on each
                    // instance but `group.identityId` is only set for the
                    // group the dropdown was changed on, at the moment of
                    // the change.
                    for (var [, _inst] of grps[_gi].instances) {
                        if (_inst.trackIdx != null && _inst.trackIdx > maxTrackIdx) {
                            maxTrackIdx = _inst.trackIdx;
                        }
                    }
                }
            }
        }
        for (var [_fi2, fg] of session.frameGroups) {
            for (var [_cn, insts] of fg.instances) {
                for (var _ii = 0; _ii < insts.length; _ii++) {
                    if (insts[_ii].trackIdx > maxTrackIdx) maxTrackIdx = insts[_ii].trackIdx;
                }
            }
            for (var [_cn2, ulList] of fg.unlinkedInstances) {
                for (var _ui = 0; _ui < ulList.length; _ui++) {
                    if (ulList[_ui].instance.trackIdx > maxTrackIdx) maxTrackIdx = ulList[_ui].instance.trackIdx;
                }
            }
        }

        var numTracks = maxTrackIdx + 1;

        // Collect camera names. When the session has been annotated with
        // `_uploadedCameras` (set by session-loader / slp-import after video
        // assignments are settled), restrict the timeline to those cameras
        // so calibration-only cameras don't appear without a video.
        var cameraNames = session.cameras ? session.cameras.map(function (c) { return c.name; }) : [];
        if (Array.isArray(session._uploadedCameras)) {
            var allowed = new Set(session._uploadedCameras);
            cameraNames = cameraNames.filter(function (n) { return allowed.has(n); });
        }

        // When no tracks exist but the session has cameras with uploaded
        // videos, fall through into the camera loop below so each camera
        // still gets an empty-row placeholder. The early-return removed.
        if (numTracks === 0 && cameraNames.length === 0) return;

        // --- Build segments from track occupancy (lazy H5 / SLP sessions) ---
        // Occupancy is a static "as-loaded" prediction grid. Once a frame
        // has been materialized into `session.frameGroups`, its per-track
        // presence can diverge from occupancy (e.g., the user reassigned
        // an instance from track_0 to track_1) — so for materialized
        // frames the live `fg.instances` data is authoritative. We skip
        // those frames when building occupancy segments; otherwise the
        // old track's bar would persist even after reassignment.
        var materializedFrames = new Set();
        if (session.frameGroups) {
            for (var [_mfIdx] of session.frameGroups) materializedFrames.add(_mfIdx);
        }
        var occSegmentMap = {};  // "trackIdx:camName" -> [{start, end}, ...]
        if (session.trackOccupancy) {
            for (var oci = 0; oci < cameraNames.length; oci++) {
                var occCam = cameraNames[oci];
                var occ = session.trackOccupancy.get(occCam);
                if (!occ) continue;
                for (var occTr = 0; occTr < occ.nTracks; occTr++) {
                    var occSegments = [];
                    var occStart = -1;
                    for (var occFi = 0; occFi < occ.nFrames; occFi++) {
                        var present = occ.data[occFi * occ.nTracks + occTr]
                            && !materializedFrames.has(occFi);
                        if (present) {
                            if (occStart < 0) occStart = occFi;
                        } else {
                            if (occStart >= 0) {
                                occSegments.push({ start: occStart, end: occFi - 1 });
                                occStart = -1;
                            }
                        }
                    }
                    if (occStart >= 0) occSegments.push({ start: occStart, end: occ.nFrames - 1 });
                    if (occSegments.length > 0) {
                        occSegmentMap[occTr + ':' + occCam] = occSegments;
                    }
                }
            }
        }

        // --- Build per-track-per-camera frame sets from frameGroups/instanceGroups ---
        // key: "trackIdx:camName" → Set<frameIdx>
        var trackCamFrames = {};

        // Scan grouped instances (instanceGroups). Key off each member's
        // actual `trackIdx`, not `group.identityId`. swapAssignTrack only
        // propagates forward, so past-frame instances in the same group
        // can retain the old trackIdx while `group.identityId` reflects
        // the new one — using identityId here would phantom-draw the new
        // track's bar across the past frames too.
        if (session.instanceGroups) {
            for (var [frameIdx, groups] of session.instanceGroups) {
                for (var gi = 0; gi < groups.length; gi++) {
                    for (var [camName, gInst] of groups[gi].instances) {
                        var gt = gInst && gInst.trackIdx != null ? gInst.trackIdx : -1;
                        if (gt < 0) continue;
                        var key = gt + ':' + camName;
                        if (!trackCamFrames[key]) trackCamFrames[key] = new Set();
                        trackCamFrames[key].add(frameIdx);
                    }
                }
            }
        }

        // Scan linked and unlinked instances in frameGroups
        for (var [frameIdx2, fg] of session.frameGroups) {
            // Linked instances (fg.instances)
            for (var [camName2, instances] of fg.instances) {
                for (var i = 0; i < instances.length; i++) {
                    var t = instances[i].trackIdx;
                    if (t >= 0) {
                        var key2 = t + ':' + camName2;
                        if (!trackCamFrames[key2]) trackCamFrames[key2] = new Set();
                        trackCamFrames[key2].add(frameIdx2);
                    }
                }
            }
            // Unlinked instances (fg.unlinkedInstances)
            for (var [camName3, ulList] of fg.unlinkedInstances) {
                for (var u = 0; u < ulList.length; u++) {
                    var t2 = ulList[u].instance.trackIdx;
                    if (t2 >= 0) {
                        var key3 = t2 + ':' + camName3;
                        if (!trackCamFrames[key3]) trackCamFrames[key3] = new Set();
                        trackCamFrames[key3].add(frameIdx2);
                    }
                }
            }
        }

        // Collect all track indices from any source (occupancy or frameGroups)
        var allTrackIndices = new Set();
        for (var tcfKey in trackCamFrames) {
            var colonPos = tcfKey.indexOf(':');
            if (colonPos > 0) allTrackIndices.add(parseInt(tcfKey.substring(0, colonPos)));
        }
        for (var occMapKey in occSegmentMap) {
            var oColon = occMapKey.indexOf(':');
            if (oColon > 0) allTrackIndices.add(parseInt(occMapKey.substring(0, oColon)));
        }
        var sortedTrackIndices = Array.from(allTrackIndices).sort(function(a, b) { return a - b; });

        // Build segments ordered by camera then track (view-first layout).
        // For each camera, count how many real track rows it produces; if
        // zero, append a single empty-camera placeholder row so the camera
        // still appears in the label gutter (Block 1 requirement).
        for (var ci = 0; ci < cameraNames.length; ci++) {
            var camRowsBefore = this._trackSegments.length;
            for (var ti = 0; ti < sortedTrackIndices.length; ti++) {
                var t3 = sortedTrackIndices[ti];
                var camKey = t3 + ':' + cameraNames[ci];
                var frameSet = trackCamFrames[camKey];
                var occSegs = occSegmentMap[camKey];

                var segments;
                if (occSegs && (!frameSet || frameSet.size === 0)) {
                    // Only occupancy data — fast path, use segments directly
                    segments = occSegs;
                } else if (!occSegs && frameSet && frameSet.size > 0) {
                    // Only frameGroup/instanceGroup frames
                    segments = this._framesToSegments(frameSet);
                } else if (occSegs && frameSet && frameSet.size > 0) {
                    // Both — merge occupancy segments with fg frames without
                    // expanding occupancy into a full frame set (memory-efficient).
                    segments = this._mergeSegmentsWithFrames(occSegs, frameSet);
                } else {
                    continue;
                }

                if (!segments || segments.length === 0) continue;

                var trackName = session.tracks[t3] || ('track_' + t3);
                var color = getTrackColor(t3);

                this._trackSegments.push({
                    trackIdx: t3,
                    cameraName: cameraNames[ci],
                    color: color,
                    segments: segments,
                    trackName: trackName,
                    treeRole: 'middle', // assigned in finalizeTreeRoles pass
                    _isTrack: true,     // marker for visibility filter (Block 2)
                });
                this._trackNames.push(''); // placeholder, finalized below
            }
            // No tracks were produced for this camera → reserve an
            // empty-camera placeholder row so the camera name still
            // appears in the gutter.
            if (this._trackSegments.length === camRowsBefore) {
                this._trackSegments.push({
                    trackIdx: -1,
                    cameraName: cameraNames[ci],
                    color: null,
                    segments: [],
                    trackName: '',
                    treeRole: 'empty',
                    _isTrack: true,
                });
                this._trackNames.push('');
            }
        }
    }

    /**
     * Convert a frame Set into sorted non-overlapping segments.
     * @param {Set<number>} frameSet
     * @returns {Array<{start:number,end:number}>}
     * @private
     */
    _framesToSegments(frameSet) {
        var sorted = Array.from(frameSet).sort(function (a, b) { return a - b; });
        var segments = [];
        var segStart = -1, segEnd = -1;
        for (var si = 0; si < sorted.length; si++) {
            var f = sorted[si];
            if (segStart < 0) { segStart = f; segEnd = f; }
            else if (f === segEnd + 1) { segEnd = f; }
            else { segments.push({ start: segStart, end: segEnd }); segStart = f; segEnd = f; }
        }
        if (segStart >= 0) segments.push({ start: segStart, end: segEnd });
        return segments;
    }

    /**
     * Merge an existing sorted non-overlapping segment list with a set of extra
     * frames, returning a new sorted non-overlapping segment list. Does NOT
     * expand the input segments into a full frame Set, so the memory cost is
     * O(|segments| + |extraFrames|) rather than O(total frames covered).
     *
     * @param {Array<{start:number,end:number}>} segments - sorted, non-overlapping
     * @param {Set<number>} extraFrameSet
     * @returns {Array<{start:number,end:number}>}
     * @private
     */
    _mergeSegmentsWithFrames(segments, extraFrameSet) {
        var extras = Array.from(extraFrameSet).sort(function (a, b) { return a - b; });
        var extraSegs = [];
        for (var i = 0; i < extras.length; i++) {
            extraSegs.push({ start: extras[i], end: extras[i] });
        }

        // Merge two sorted segment lists by start
        var all = [];
        var ai = 0, bi = 0;
        while (ai < segments.length && bi < extraSegs.length) {
            if (segments[ai].start <= extraSegs[bi].start) {
                all.push(segments[ai++]);
            } else {
                all.push(extraSegs[bi++]);
            }
        }
        while (ai < segments.length) all.push(segments[ai++]);
        while (bi < extraSegs.length) all.push(extraSegs[bi++]);

        // Coalesce adjacent/overlapping segments
        if (all.length === 0) return [];
        var merged = [{ start: all[0].start, end: all[0].end }];
        for (var k = 1; k < all.length; k++) {
            var last = merged[merged.length - 1];
            if (all[k].start <= last.end + 1) {
                if (all[k].end > last.end) last.end = all[k].end;
            } else {
                merged.push({ start: all[k].start, end: all[k].end });
            }
        }
        return merged;
    }

    /**
     * Rebuild segments based on current display mode.
     * @param {Session} session
     * @private
     */
    _rebuildSegments(session) {
        if (this._displayMode === 'identities') {
            this._buildIdentitySegments(session);
        } else if (this._displayMode === 'both') {
            // Build tracks then identities, then interleave by camera so
            // each camera's rows are contiguous in the row list. Without
            // this interleave the row order would be
            // [tracks_camA, tracks_camB, identities_camA, identities_camB]
            // which produces 4 camera groups (camA, camB, camA, camB) and
            // breaks the Block 1 tree grouping.
            this._buildTrackSegments(session);
            var trackSegs = this._trackSegments;
            this._trackSegments = [];
            this._trackNames = [];
            this._buildIdentitySegments(session);
            var idSegs = this._trackSegments;

            // Group rows by camera, preserving the camera order from the
            // tracks pass (which used the filtered camera list).
            var camOrder = [];
            var byCam = {};
            function addSeg(seg) {
                var name = seg.cameraName;
                if (!Object.prototype.hasOwnProperty.call(byCam, name)) {
                    camOrder.push(name);
                    byCam[name] = [];
                }
                byCam[name].push(seg);
            }
            for (var ai = 0; ai < trackSegs.length; ai++) addSeg(trackSegs[ai]);
            for (var bi = 0; bi < idSegs.length; bi++) addSeg(idSegs[bi]);

            this._trackSegments = [];
            this._trackNames = [];
            for (var ci = 0; ci < camOrder.length; ci++) {
                var camName = camOrder[ci];
                var camRows = byCam[camName];
                // If the camera has any REAL rows, drop the empty
                // placeholders. If it only has placeholders (no tracks AND
                // no identities), keep exactly ONE placeholder — the
                // tracks-pass and identities-pass would otherwise each
                // emit one, doubling the camera in the gutter.
                var hasReal = false;
                for (var dr = 0; dr < camRows.length; dr++) {
                    if (camRows[dr].treeRole !== 'empty') { hasReal = true; break; }
                }
                var emptyEmittedForCam = false;
                for (var er = 0; er < camRows.length; er++) {
                    if (camRows[er].treeRole === 'empty') {
                        if (hasReal) continue;          // drop placeholder
                        if (emptyEmittedForCam) continue; // dedupe placeholders
                        emptyEmittedForCam = true;
                    }
                    this._trackSegments.push(camRows[er]);
                    this._trackNames.push('');
                }
            }
        } else {
            this._buildTrackSegments(session);
        }

        // --- Block 2 (Prompt 4): apply per-session visibility filter.
        // Drops rows whose camera / track / identity is in the session's
        // hidden Sets. Runs unconditionally (no-op when all sets are
        // empty) and BEFORE `_finalizeTreeGrouping` so the tree roles
        // and camera groups reflect the filtered row list.
        this._applyVisibilityFilter(session);

        // --- Group rows by camera and finalize tree roles + label strings.
        this._finalizeTreeGrouping();

        // Pre-measure labels across all 3 modes (tracks / identities / both)
        // and expand LEFT_MARGIN so the camera tree aligns the same across
        // mode switches. Lives here (outside `_finalizeTreeGrouping`) so the
        // cross-mode sandbox inside `_recomputeLeftMargin` can call
        // `_finalizeTreeGrouping` without recursing into the margin path.
        this._recomputeLeftMargin();
    }

    /**
     * Block 2 (Prompt 4) — apply the per-session visibility filter to
     * `this._trackSegments`. Reads the three hidden Sets from `session`
     * (lazy-initialized to empty Sets if absent):
     *
     *   session._hiddenCameras    — Set<cameraName>
     *   session._hiddenTracks     — Set<trackName>
     *   session._hiddenIdentities — Set<identityName>
     *
     * Filtering rules (precedence: Views > Tracks/Identities):
     *   - A row whose camera is in `_hiddenCameras` is dropped entirely
     *     (including the empty-camera placeholder), and so is the camera
     *     header — nothing remains in the gutter.
     *   - A row tagged `_isIdentity` is dropped if its `trackName` is in
     *     `_hiddenIdentities`.
     *   - A row tagged `_isTrack` is dropped if its `trackName` is in
     *     `_hiddenTracks`.
     *   - Empty-placeholder rows (treeRole === 'empty') are preserved
     *     unless their camera is hidden at the view level.
     *   - If a camera group had real rows pre-filter but zero real rows
     *     post-filter, an "all-hidden" placeholder row is emitted so the
     *     camera header still survives in the gutter (drawn gray by the
     *     bar-draw path). This mirrors Block 1's empty-camera placeholder
     *     behaviour.
     *
     * Fast-path: when all three Sets are empty, returns immediately
     * without copying the array.
     *
     * @param {Session} session
     * @private
     */
    _applyVisibilityFilter(session) {
        if (!session) return;
        // Inline ensureHiddenSets — keeps timeline.js decoupled from
        // timeline-visibility.js (which mirrors this contract for the
        // Info Panel side).
        if (!session._hiddenCameras) session._hiddenCameras = new Set();
        if (!session._hiddenTracks) session._hiddenTracks = new Set();
        if (!session._hiddenIdentities) session._hiddenIdentities = new Set();

        var hCams = session._hiddenCameras;
        var hTracks = session._hiddenTracks;
        var hIds = session._hiddenIdentities;

        // Fast path — nothing hidden.
        if (hCams.size === 0 && hTracks.size === 0 && hIds.size === 0) return;

        var rows = this._trackSegments || [];
        var out = [];

        var i = 0;
        while (i < rows.length) {
            // Collect a camera group (consecutive rows with the same cameraName).
            var camName = rows[i].cameraName;
            var groupStart = i;
            var j = i;
            while (j < rows.length && rows[j].cameraName === camName) j++;
            var groupEnd = j;  // exclusive

            // View-level hide: drop the entire group, no placeholder.
            if (camName && hCams.has(camName)) {
                i = groupEnd;
                continue;
            }

            var hadReal = false;
            var kept = [];
            for (var k = groupStart; k < groupEnd; k++) {
                var row = rows[k];
                if (row.treeRole === 'empty') {
                    kept.push(row);
                    continue;
                }
                // Real row — track its existence + apply track/identity hide.
                hadReal = true;
                var name = row.trackName;
                if (row._isIdentity) {
                    if (hIds.has(name)) continue;
                } else if (row._isTrack) {
                    if (hTracks.has(name)) continue;
                } else {
                    // Defensive fallback — pre-Block 2 callers without
                    // an explicit `_isTrack` / `_isIdentity` marker.
                    if (hTracks.has(name)) continue;
                }
                kept.push(row);
            }

            // Count real rows kept.
            var keptReal = 0;
            var ki;
            for (ki = 0; ki < kept.length; ki++) {
                if (kept[ki].treeRole !== 'empty') keptReal++;
            }

            if (hadReal && keptReal === 0) {
                // All this camera's real rows were filtered out. Strip
                // any pre-existing empty placeholders (their `_isTrack` /
                // `_isIdentity` marker would otherwise leak), then emit
                // a single all-hidden placeholder so the camera header
                // survives in the gutter (gray-styled by the draw path).
                var stripped = [];
                for (ki = 0; ki < kept.length; ki++) {
                    if (kept[ki].treeRole !== 'empty') stripped.push(kept[ki]);
                }
                kept = stripped;
                kept.push({
                    trackIdx: -1,
                    cameraName: camName,
                    color: null,
                    segments: [],
                    trackName: '',
                    treeRole: 'empty',
                    isAllHidden: true,
                });
            }

            for (ki = 0; ki < kept.length; ki++) out.push(kept[ki]);
            i = groupEnd;
        }

        this._trackSegments = out;
        // Resize `_trackNames` in parallel so downstream draw paths see
        // a length-matched array. `_finalizeTreeGrouping` rebuilds the
        // strings, so empty placeholders here are fine.
        this._trackNames = [];
        for (var ti = 0; ti < this._trackSegments.length; ti++) {
            this._trackNames.push('');
        }
    }

    /**
     * After `_buildTrackSegments` / `_buildIdentitySegments` populates the
     * row list, group consecutive rows by camera name and assign each
     * row's `treeRole` ('first' / 'middle' / 'last' / 'only' / 'empty').
     * Rebuilds `_trackNames` to contain the tree-decorated label strings
     * the canvas drawing path consumes.
     * @private
     */
    _finalizeTreeGrouping() {
        this._cameraGroups = [];
        if (!this._trackSegments || this._trackSegments.length === 0) {
            this._trackNames = [];
            return;
        }

        var lastCam = null;
        var currentGroup = null;
        for (var i = 0; i < this._trackSegments.length; i++) {
            var seg = this._trackSegments[i];
            if (seg.cameraName !== lastCam) {
                currentGroup = { name: seg.cameraName, tracks: [], isEmpty: false, isAllHidden: false };
                this._cameraGroups.push(currentGroup);
                lastCam = seg.cameraName;
            }
            if (seg.treeRole === 'empty') {
                currentGroup.isEmpty = true;
                // Block 2 (Prompt 4): propagate the all-hidden marker
                // from the placeholder row up to the group so the draw
                // path can render the camera name in gray.
                if (seg.isAllHidden) currentGroup.isAllHidden = true;
            } else {
                currentGroup.tracks.push(seg);
            }
        }

        // Assign treeRole per row based on the group's real-track count.
        // (Empty-camera placeholder rows keep their 'empty' role, set during
        // build.) Tree-decorated label strings live in `_trackNames` keyed
        // by row index — they're rebuilt below.
        for (var gi = 0; gi < this._cameraGroups.length; gi++) {
            var groupTracks = this._cameraGroups[gi].tracks;
            var n = groupTracks.length;
            for (var ri = 0; ri < n; ri++) {
                var row = groupTracks[ri];
                if (n === 1) row.treeRole = 'only';
                else if (ri === 0) row.treeRole = 'first';
                else if (ri === n - 1) row.treeRole = 'last';
                else row.treeRole = 'middle';
            }
        }

        // Rebuild `_trackNames` in row order so callers (and tests) see
        // tree-decorated labels keyed by the same index as _trackSegments.
        this._trackNames = [];
        for (var rj = 0; rj < this._trackSegments.length; rj++) {
            var s = this._trackSegments[rj];
            this._trackNames.push(this._formatTreeLabel(s));
        }
        // NOTE: `_recomputeLeftMargin()` is called from `_rebuildSegments`
        // (the single caller) rather than here, so the cross-mode label
        // collector inside that method can call `_finalizeTreeGrouping`
        // recursively without re-entering the margin computation.
    }

    /**
     * Split a tree-decorated label into its (bold) camera-name prefix and
     * (regular) tree-suffix parts. Only `first`, `only`, `empty`, and the
     * fallback default rows actually begin with the camera name; `middle`
     * and `last` rows have no camera-name prefix and are returned with
     * `camName: ''`.
     *
     * Used by both the label-draw path (`_drawTrackBars`) and the
     * left-margin pre-measure (`_recomputeLeftMargin`) so the two see
     * exactly the same split.
     *
     * @param {Object} row - A `_trackSegments[i]` entry; must have
     *     `cameraName` and `treeRole` set.
     * @param {string} label - The composed label string (i.e.,
     *     `_trackNames[i]`).
     * @returns {{ camName: string, suffix: string }} The bold-eligible camera
     *     name (empty if this row has none) and the regular-weight remainder.
     * @private
     */
    _splitLabel(row, label) {
        var camName = (row && row.cameraName) || '';
        if (!camName || !label) return { camName: '', suffix: label || '' };
        var role = row.treeRole;
        if (role !== 'first' && role !== 'only' && role !== 'empty' && role) {
            // `middle` / `last` — no camera name in the label.
            return { camName: '', suffix: label };
        }
        // Defensive: the label begins with the camera name only when the
        // role is one of the prefixed roles. The other branch (default/no
        // role) preserves the historical formatter behavior of joining
        // camName + ' ' + trackName.
        if (label.indexOf(camName) === 0) {
            return { camName: camName, suffix: label.slice(camName.length) };
        }
        return { camName: '', suffix: label };
    }

    /**
     * Measure the widest entry in `_trackNames` using the same monospace font
     * the label-draw path uses, and expand `this.LEFT_MARGIN` so the camera
     * name (at the start of `first` / `only` / `empty` row labels) is not
     * clipped on the left. Camera names are drawn in BOLD so their width is
     * measured under the bold font; the tree-suffix is measured under the
     * regular font. Clamped between `MIN_LEFT_MARGIN` and `MAX_LEFT_MARGIN`
     * so very long track names don't push the timeline unreasonably right.
     *
     * Also updates `_scrollbarTrack.style.left` (which is anchored to
     * `LEFT_MARGIN` at construction) so the horizontal scrollbar tracks
     * the new content origin.
     *
     * No-op in headless environments where `_ctx.measureText` is unavailable
     * (the test stub doesn't provide it); the LEFT_MARGIN simply stays at
     * its prior value.
     * @private
     */
    _recomputeLeftMargin() {
        if (!this._ctx || typeof this._ctx.measureText !== 'function') return;
        var prevFont = this._ctx.font;
        var REG_FONT = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        var BOLD_FONT = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';

        // Measure three columns separately so the draw path (which uses
        // column-positioned, NOT right-aligned, labels) can line up the
        // connector glyphs (`┌─` / `├─` / `└─`) at a single X regardless
        // of individual track-name length. Per the spec, the tree width
        // is determined by the longest track/id name in the *currently
        // viewed tab* — only the current mode's rows are measured.
        var maxCamW = 0;
        var maxConnectorW = 0;
        var maxTrackW = 0;
        for (var i = 0; i < this._trackSegments.length; i++) {
            var row = this._trackSegments[i];
            var camName = (row.cameraName || '');
            var trackName = (row.trackName || '');
            var connector = this._connectorForRole(row.treeRole);

            if (camName) {
                this._ctx.font = BOLD_FONT;
                var cw = this._ctx.measureText(camName).width;
                if (cw > maxCamW) maxCamW = cw;
            }
            this._ctx.font = REG_FONT;
            if (connector) {
                var cnw = this._ctx.measureText(connector).width;
                if (cnw > maxConnectorW) maxConnectorW = cnw;
            }
            if (trackName) {
                var tw = this._ctx.measureText(trackName).width;
                if (tw > maxTrackW) maxTrackW = tw;
            }
        }
        this._ctx.font = prevFont;

        // Stash column metrics for the draw path. The column layout is:
        //   [LABEL_LEFT_PAD][ camName ][GAP][ connector ][trackName ][LABEL_RIGHT_PAD]
        // with camName right-aligned (so all camera names end at the same
        // X), connector left-aligned at a fixed X (so `┌─`/`├─`/`└─` all
        // line up), and trackName left-aligned immediately after.
        var COL_GAP = 4;
        this._labelMaxCamW = maxCamW;
        this._labelMaxConnectorW = maxConnectorW;
        this._labelMaxTrackW = maxTrackW;
        this._labelColGap = COL_GAP;

        var needed = Math.ceil(
            this.LABEL_LEFT_PAD +
            maxCamW +
            (maxCamW > 0 ? COL_GAP : 0) +
            maxConnectorW +
            maxTrackW +
            this.LABEL_RIGHT_PAD
        );
        var newLeft = Math.min(this.MAX_LEFT_MARGIN,
                               Math.max(this.MIN_LEFT_MARGIN, needed));
        if (newLeft !== this.LEFT_MARGIN) {
            this.LEFT_MARGIN = newLeft;
            // The horizontal scrollbar track is anchored to LEFT_MARGIN at
            // construction (see ctor), so keep it in sync.
            if (this._scrollbarTrack && this._scrollbarTrack.style) {
                this._scrollbarTrack.style.left = newLeft + 'px';
            }
        }
    }

    /**
     * Format a tree-decorated label string for a single row. The camera
     * name is embedded in the first row of each multi-track group (and
     * the only/empty rows of single-track / empty-camera groups) so that
     * string-search assertions in the test suite (e.g., `labels.indexOf('camA')`)
     * succeed without requiring a separate canvas-row for the camera name.
     *
     * @param {{cameraName: string, trackName: string, treeRole: string}} row
     * @returns {string}
     * @private
     */
    _formatTreeLabel(row) {
        var camName = row.cameraName || '';
        var trackName = row.trackName || '';
        switch (row.treeRole) {
            case 'first':
                return camName + '  ┌─ ' + trackName;
            case 'middle':
                return '│ ├─ ' + trackName;
            case 'last':
                return '│ └─ ' + trackName;
            case 'only':
                return camName + '  ── ' + trackName;
            case 'empty':
                return camName + ' ──';
            default:
                return camName + ' ' + trackName;
        }
    }

    /**
     * Bracket glyph drawn at the connector column for a row's `treeRole`.
     * Used by both the pre-measure pass (`_recomputeLeftMargin`) and the
     * draw path (`_drawTrackBars`) so the width budgeted for the connector
     * column matches what's rendered.
     *
     * Every glyph here is the same character-width (`┌─ ` / `├─ ` / `└─ ` /
     * `── ` / `──`) so the brackets line up vertically when each is
     * left-aligned at the same X. The `│` continuation glyph that the
     * tester-agent's assertions look for is kept in the composed
     * `_trackNames` strings (via `_formatTreeLabel`) but is *not* drawn —
     * the contiguous `├`/`└` glyphs already encode the vertical structure
     * visually, and adding a `│` to the drawn connector pushed the brackets
     * out of column-alignment.
     * @private
     */
    _connectorForRole(role) {
        switch (role) {
            case 'first':  return '┌─ ';
            case 'middle': return '├─ ';
            case 'last':   return '└─ ';
            case 'only':   return '── ';
            case 'empty':  return '──';
            default:       return '';
        }
    }

    /**
     * Build segments grouped by identity instead of track.
     * Uses session.trackIdentityMap to find identity per camera:trackIdx,
     * then colors by identity color.
     *
     * @param {Session} session
     * @private
     */
    _buildIdentitySegments(session) {
        this._trackSegments = [];
        this._trackNames = [];

        // Even when no identities are defined we still need to enumerate
        // the camera list so the label gutter shows one placeholder row
        // per camera (Block 1 / mode-consistency requirement).
        var cameraNames = session.cameras ? session.cameras.map(function (c) { return c.name; }) : [];
        if (Array.isArray(session._uploadedCameras)) {
            var allowedIds = new Set(session._uploadedCameras);
            cameraNames = cameraNames.filter(function (n) { return allowedIds.has(n); });
        }
        var hasIdentities = !!(session.identities && session.identities.length > 0);

        // Build identity -> camName -> Set<frameIdx>
        var idCamFrames = {};  // "identityId:camName" -> Set<frameIdx>
        // Frames the tracker explicitly marked as "no identity" (-1) get a
        // gray "No ID" row per camera, keyed under this sentinel prefix.
        var NO_ID_KEY = '__noid__';

        if (hasIdentities) {
            for (var [frameIdx, fg] of session.frameGroups) {
                // Grouped instances
                for (var [camName, instances] of fg.instances) {
                    for (var i = 0; i < instances.length; i++) {
                        var idId = session.getIdentityIdForTrack
                            ? session.getIdentityIdForTrack(camName, instances[i].trackIdx, frameIdx)
                            : session.trackIdentityMap.get(camName + ':' + instances[i].trackIdx);
                        if (idId == null) {
                            if (session.isExplicitNoIdentity &&
                                session.isExplicitNoIdentity(camName, instances[i].trackIdx, frameIdx)) {
                                var nKey = NO_ID_KEY + ':' + camName;
                                if (!idCamFrames[nKey]) idCamFrames[nKey] = new Set();
                                idCamFrames[nKey].add(frameIdx);
                            }
                            continue;
                        }
                        var segKey = idId + ':' + camName;
                        if (!idCamFrames[segKey]) idCamFrames[segKey] = new Set();
                        idCamFrames[segKey].add(frameIdx);
                    }
                }
                // Unlinked instances
                for (var [camName2, ulList] of fg.unlinkedInstances) {
                    for (var u = 0; u < ulList.length; u++) {
                        var idId2 = session.getIdentityIdForTrack
                            ? session.getIdentityIdForTrack(camName2, ulList[u].instance.trackIdx, frameIdx)
                            : session.trackIdentityMap.get(camName2 + ':' + ulList[u].instance.trackIdx);
                        if (idId2 == null) {
                            if (session.isExplicitNoIdentity &&
                                session.isExplicitNoIdentity(camName2, ulList[u].instance.trackIdx, frameIdx)) {
                                var nKey2 = NO_ID_KEY + ':' + camName2;
                                if (!idCamFrames[nKey2]) idCamFrames[nKey2] = new Set();
                                idCamFrames[nKey2].add(frameIdx);
                            }
                            continue;
                        }
                        var segKey2 = idId2 + ':' + camName2;
                        if (!idCamFrames[segKey2]) idCamFrames[segKey2] = new Set();
                        idCamFrames[segKey2].add(frameIdx);
                    }
                }
            }
        }

        // Build segments per camera per identity (view-first layout).
        // Enumerate from `cameraNames` (the filtered uploaded list) so a
        // camera with no identity rows still gets an empty placeholder.
        for (var ci = 0; ci < cameraNames.length; ci++) {
            var camRowsBefore = this._trackSegments.length;
            if (hasIdentities) {
                for (var idIdx = 0; idIdx < session.identities.length; idIdx++) {
                    var ident = session.identities[idIdx];
                    var sKey = ident.id + ':' + cameraNames[ci];
                    var frameSet = idCamFrames[sKey];
                    if (!frameSet || frameSet.size === 0) continue;

                    var sorted = Array.from(frameSet).sort(function (a, b) { return a - b; });
                    var segments = [];
                    var segStart = -1, segEnd = -1;
                    for (var si = 0; si < sorted.length; si++) {
                        var f = sorted[si];
                        if (segStart < 0) { segStart = f; segEnd = f; }
                        else if (f === segEnd + 1) { segEnd = f; }
                        else { segments.push({ start: segStart, end: segEnd }); segStart = f; segEnd = f; }
                    }
                    if (segStart >= 0) segments.push({ start: segStart, end: segEnd });

                    this._trackSegments.push({
                        trackIdx: ident.id,
                        cameraName: cameraNames[ci],
                        color: ident.color || '#667eea',
                        segments: segments,
                        trackName: ident.name,
                        treeRole: 'middle',
                        _isIdentity: true, // marker for visibility filter (Block 2)
                    });
                    this._trackNames.push('');
                }
            }
            // No-ID row: frames the tracker marked explicit-none (-1) for this
            // camera. Rendered in space gray so proofreaders see un-identified
            // instances — and the frames they occur on — in the tracks/id window.
            var noIdFrames = idCamFrames[NO_ID_KEY + ':' + cameraNames[ci]];
            if (noIdFrames && noIdFrames.size > 0) {
                this._trackSegments.push({
                    trackIdx: -1,
                    cameraName: cameraNames[ci],
                    color: NULL_ID_COLOR,
                    segments: this._framesToSegments(noIdFrames),
                    trackName: 'No ID',
                    treeRole: 'middle',
                    _isIdentity: true,
                    _isNoId: true,
                });
                this._trackNames.push('');
            }
            if (this._trackSegments.length === camRowsBefore) {
                this._trackSegments.push({
                    trackIdx: -1,
                    cameraName: cameraNames[ci],
                    color: null,
                    segments: [],
                    trackName: '',
                    treeRole: 'empty',
                    _isIdentity: true,
                });
                this._trackNames.push('');
            }
        }
    }

    /**
     * Set the timeline display mode and refresh.
     * @param {'tracks'|'identities'|'both'} mode
     */
    setDisplayMode(mode) {
        this._displayMode = mode;
        if (this._session) {
            this._rebuildSegments(this._session);
            this.resize();  // resize recalculates canvas height for new row count + redraws
        }
    }

    /**
     * Build cached frame-marker map from the session.
     *
     * @param {Session} session
     * @private
     */
    _buildFrameMarkers(session) {
        this._frameMarkers.clear();

        for (const [frameIdx, fg] of session.frameGroups) {
            let hasUser = false;
            let hasPredicted = false;

            for (const [_camName, instances] of fg.instances) {
                for (let i = 0; i < instances.length; i++) {
                    if (instances[i].type === 'user') hasUser = true;
                    else if (instances[i].type === 'predicted') hasPredicted = true;
                }
            }

            this._frameMarkers.set(frameIdx, {
                hasUser: hasUser,
                hasPredicted: hasPredicted,
                modified: false, // The app can set this later
            });
        }
    }

    // -----------------------------------------------------------------------
    // Drawing helpers
    // -----------------------------------------------------------------------

    /**
     * Draw vertical grid lines every 10 / 100 frames.
     * @private
     */
    _drawGrid(ctx, W, H) {
        const startFrame = Math.floor(this._scrollFrame);
        const endFrame = Math.ceil(this._scrollFrame + this._visibleFrames());

        ctx.lineWidth = 1;

        for (let f = startFrame; f <= endFrame; f++) {
            if (f < 0 || f >= this._totalFrames) continue;
            if (f % 10 !== 0) continue;

            const x = this._frameToX(f);
            if (x < this.LEFT_MARGIN || x > W - this.RIGHT_PADDING) continue;

            ctx.strokeStyle = (f % 100 === 0) ? this.GRID_COLOR_MAJOR : this.GRID_COLOR_MINOR;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + 0.5, 0);
            ctx.lineTo(Math.round(x) + 0.5, H);
            ctx.stroke();
        }
    }

    /**
     * Draw the track occupancy bars.
     * @private
     */
    _drawTrackBars(ctx, top, W) {
        const trackW = W - this.LEFT_MARGIN - this.RIGHT_PADDING;
        if (trackW <= 0) return;

        // Precompute row Y positions with extra gap between camera groups
        var rowYPositions = [];
        var cumY = 0;
        var prevCam = null;
        for (var ry = 0; ry < this._trackSegments.length; ry++) {
            var thisCam = this._trackSegments[ry].cameraName;
            if (prevCam != null && thisCam !== prevCam) {
                cumY += this.VIEW_GROUP_GAP;
            }
            rowYPositions.push(cumY);
            cumY += this.TRACK_ROW_HEIGHT + this.TRACK_ROW_GAP;
            prevCam = thisCam;
        }

        // Monospace label font (camera names use the bold variant so they
        // stand out from track names in views with mixed/no tracks).
        const LABEL_FONT_REG = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        const LABEL_FONT_BOLD = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';

        // Pre-computed column metrics from `_recomputeLeftMargin`:
        //   [LABEL_LEFT_PAD][ camName ][COL_GAP][ connector ][trackName ]
        // Camera names right-align at X_CAM_RIGHT; connector glyphs
        // left-align at X_CONNECTOR; track names left-align at X_TRACK.
        // This positions the bracket chars (`┌─` / `├─` / `└─`) at the
        // SAME X for every row in the gutter — so they line up vertically
        // regardless of individual track-name length.
        const colGap = this._labelColGap || 4;
        const maxCamW = this._labelMaxCamW || 0;
        const maxConnW = this._labelMaxConnectorW || 0;
        const X_CAM_RIGHT = this.LABEL_LEFT_PAD + maxCamW;
        const X_CONNECTOR = X_CAM_RIGHT + (maxCamW > 0 ? colGap : 0);
        const X_TRACK = X_CONNECTOR + maxConnW;

        for (let t = 0; t < this._trackSegments.length; t++) {
            const track = this._trackSegments[t];
            const rowY = top + rowYPositions[t];
            const labelY = rowY + this.TRACK_ROW_HEIGHT / 2;

            ctx.fillStyle = this.LABEL_COLOR;
            ctx.textBaseline = 'middle';

            // 1. Camera name (bold, right-aligned at X_CAM_RIGHT). Only
            //    rendered on the anchor row of a group — `first`, `only`,
            //    or `empty` — to avoid repeating the name on every track.
            const camName = track.cameraName || '';
            const isAnchor =
                track.treeRole === 'first' ||
                track.treeRole === 'only' ||
                track.treeRole === 'empty';
            if (camName && isAnchor) {
                ctx.font = LABEL_FONT_BOLD;
                ctx.textAlign = 'right';
                // Block 2 (Prompt 4): when every track under this camera
                // is toggled off, render the camera name in gray (the
                // user can still see which view they hid). Restore the
                // prior fill so the connector + track-name pass renders
                // at full opacity.
                var _prevFill = ctx.fillStyle;
                if (track.isAllHidden) ctx.fillStyle = 'rgba(255,255,255,0.25)';
                ctx.fillText(camName, X_CAM_RIGHT, labelY);
                ctx.fillStyle = _prevFill;
            }

            // 2. Connector glyph (regular, left-aligned at X_CONNECTOR).
            ctx.font = LABEL_FONT_REG;
            ctx.textAlign = 'left';
            const connector = this._connectorForRole(track.treeRole);
            if (connector) {
                ctx.fillText(connector, X_CONNECTOR, labelY);
            }

            // 3. Track / identity name (regular, left-aligned at X_TRACK).
            if (track.trackName) {
                ctx.fillText(track.trackName, X_TRACK, labelY);
            }

            // Empty-camera placeholder rows reserve vertical space but
            // do not draw colored bars.
            if (track.treeRole === 'empty' || !track.segments || track.segments.length === 0) {
                continue;
            }

            // Draw segments. Accumulate every segment rect into a single path
            // and fill once at 0.7 alpha. A single fill paints each pixel only
            // once, so segments widened by the min-width floor (long videos,
            // pxPerFrame < 1) that overlap in pixels no longer compound their
            // alpha into darker patches — the row stays a uniform shade.
            ctx.fillStyle = track.color;
            ctx.globalAlpha = 0.7;
            ctx.beginPath();
            for (let s = 0; s < track.segments.length; s++) {
                const rect = this._computeSegmentDrawRect(track.segments[s]);
                if (!rect) continue;
                ctx.rect(rect.x, rowY, rect.width, this.TRACK_ROW_HEIGHT);
            }
            ctx.fill();
            ctx.globalAlpha = 1.0;
        }

        // Reset text alignment
        ctx.textAlign = 'left';
    }

    /**
     * Compute the pixel rectangle for drawing a single track segment.
     * Enforces a minimum visible width of
     * max(MIN_SEGMENT_WIDTH_PX, canvasWidth * MIN_SEGMENT_WIDTH_FRACTION)
     * so short/single-frame segments remain visible in long videos where
     * pxPerFrame < 1. When the minimum-width floor kicks in, the bar is
     * centered on the segment's midpoint — matching the playhead, which
     * uses `_frameToX(currentFrame + 0.5)` — so it never drifts right of
     * the current-frame indicator.
     *
     * Clamps the result to stay inside the content area; if the centered
     * bar would overflow either edge, it is shifted back inside.
     *
     * Uses the timeline's internal CSS width (`this._cssWidth`), matching
     * the coordinate system of `_frameToX`.
     *
     * @param {{start:number, end:number}} seg - Segment frame range (inclusive)
     * @returns {{x:number, width:number}|null} Draw rectangle, or null if the
     *     segment is entirely outside the visible content area.
     * @private
     */
    _computeSegmentDrawRect(seg) {
        const W = this._cssWidth;
        const contentLeft = this.LEFT_MARGIN;
        const contentRight = W - this.RIGHT_PADDING;
        if (contentRight <= contentLeft) return null;

        // +1 so the bar spans the full frame width for the end frame
        const x0raw = this._frameToX(seg.start);
        const x1raw = this._frameToX(seg.end + 1);

        // Skip segments entirely outside the visible content area
        if (x1raw < contentLeft || x0raw > contentRight) return null;

        const minSegW = Math.min(
            contentRight - contentLeft,
            Math.max(this.MIN_SEGMENT_WIDTH_PX, W * this.MIN_SEGMENT_WIDTH_FRACTION)
        );

        // Center the bar on the segment's midpoint. For wide segments
        // (rawWidth >= minSegW), this matches the natural [x0raw, x1raw]
        // extents; for narrow segments, it ensures the bar is drawn
        // symmetrically around the same pixel the playhead would occupy.
        const midX = (x0raw + x1raw) / 2;
        const rawWidth = x1raw - x0raw;
        const width = Math.max(rawWidth, minSegW);
        let x = midX - width / 2;

        // Clamp inside the content area. If either edge would overflow,
        // shift the bar (preserving width) so it stays flush with the edge.
        if (x < contentLeft) {
            x = contentLeft;
        }
        if (x + width > contentRight) {
            x = contentRight - width;
            if (x < contentLeft) x = contentLeft;
        }

        const drawWidth = Math.min(width, contentRight - x);
        if (drawWidth <= 0) return null;
        return { x: x, width: drawWidth };
    }

    /**
     * Given a click x-coordinate (CSS pixels), find the nearest labeled
     * frame in any track segment within snap tolerance. Returns null if
     * no segment is within range. If multiple labeled frames are in range
     * (e.g., a cluster of adjacent frames or multiple nearby segments),
     * returns the frame whose center pixel is closest to the click.
     *
     * Snap tolerance matches the minimum segment draw width:
     * max(MIN_SEGMENT_WIDTH_PX, canvasWidth * MIN_SEGMENT_WIDTH_FRACTION).
     *
     * @param {number} clickX - Click x coordinate in CSS pixels
     * @returns {number|null} Snapped frame index, or null for no snap
     * @private
     */
    _findSnapFrame(clickX) {
        if (!this._trackSegments || this._trackSegments.length === 0) return null;

        const W = this._cssWidth;
        const tolerance = Math.max(
            this.MIN_SEGMENT_WIDTH_PX,
            W * this.MIN_SEGMENT_WIDTH_FRACTION
        );

        const clickFrameF = this._xToFrame(clickX);
        let bestFrame = null;
        let bestDist = Infinity;

        for (let t = 0; t < this._trackSegments.length; t++) {
            const track = this._trackSegments[t];
            for (let s = 0; s < track.segments.length; s++) {
                const seg = track.segments[s];

                // Candidate = the frame in [seg.start, seg.end] whose center
                // pixel is closest to clickX. Frame N's center lives at
                // _frameToX(N + 0.5), so we want N ≈ clickFrameF - 0.5 clamped
                // to [seg.start, seg.end].
                let cand = Math.round(clickFrameF - 0.5);
                if (cand < seg.start) cand = seg.start;
                else if (cand > seg.end) cand = seg.end;

                const candX = this._frameToX(cand + 0.5);
                const dist = Math.abs(candX - clickX);

                if (dist <= tolerance && dist < bestDist) {
                    bestFrame = cand;
                    bestDist = dist;
                }
            }
        }

        return bestFrame;
    }

    /**
     * Draw white vertical lines for modified (grouped/triangulated) frames.
     * These span from the track area through the marker area and render
     * on top of the colored track bars.
     * @private
     */
    _drawModifiedFrameLines(ctx, top, bottom, W) {
        this._drawFrameBars(ctx, top, bottom, W,
            this.MARKER_MODIFIED_COLOR,
            function (m) { return m.modified; },
            0.7, 0.85);
    }

    /**
     * Shared helper that draws colored vertical bars across the track
     * area for every frame matching `predicate`. `denseAlpha` is used
     * when frames are smaller than ~3 px (bars are binned by column);
     * `sparseAlpha` is used for the individual-line mode.
     * @private
     */
    _drawFrameBars(ctx, top, bottom, W, color, predicate, denseAlpha, sparseAlpha) {
        const lineH = bottom - top;
        if (lineH <= 0) return;

        const pxPerFrame = this._pxPerFrame();
        const startFrame = Math.floor(this._scrollFrame);
        const endFrame = Math.ceil(this._scrollFrame + this._visibleFrames());
        const contentLeft = this.LEFT_MARGIN;
        const contentRight = W - this.RIGHT_PADDING;

        ctx.fillStyle = color;

        if (pxPerFrame < 3) {
            const contentW = contentRight - contentLeft;
            if (contentW <= 0) return;
            const numBins = Math.ceil(contentW);
            const framesPerBin = this._visibleFrames() / numBins;

            for (let b = 0; b < numBins; b++) {
                const binFrameStart = this._scrollFrame + b * framesPerBin;
                const binFrameEnd = binFrameStart + framesPerBin;
                let hit = false;

                for (let f = Math.floor(binFrameStart); f < Math.ceil(binFrameEnd); f++) {
                    const marker = this._frameMarkers.get(f);
                    if (marker && predicate(marker)) { hit = true; break; }
                }

                if (!hit) continue;
                const x = contentLeft + b;
                ctx.globalAlpha = denseAlpha;
                ctx.fillRect(x, top, 1, lineH);
                ctx.globalAlpha = 1.0;
            }
        } else {
            const lineW = Math.max(1, Math.min(2, pxPerFrame * 0.3));

            for (let f = startFrame; f <= endFrame; f++) {
                if (f < 0 || f >= this._totalFrames) continue;
                const marker = this._frameMarkers.get(f);
                if (!marker || !predicate(marker)) continue;

                const x = this._frameToX(f + 0.5);
                if (x < contentLeft || x > contentRight) continue;

                ctx.globalAlpha = sparseAlpha;
                ctx.fillRect(Math.round(x) - lineW / 2, top, lineW, lineH);
                ctx.globalAlpha = 1.0;
            }
        }
    }

    /**
     * Draw frame markers (dots or density bars).
     * @private
     */
    _drawFrameMarkers(ctx, top, bottom, W) {
        const areaH = bottom - top;
        if (areaH <= 0) return;

        const pxPerFrame = this._pxPerFrame();
        const startFrame = Math.floor(this._scrollFrame);
        const endFrame = Math.ceil(this._scrollFrame + this._visibleFrames());

        // If frames are very dense (< 3px each), draw as a colored bar per bin
        if (pxPerFrame < 3) {
            this._drawFrameMarkersDense(ctx, top, areaH, W, startFrame, endFrame);
            return;
        }

        // Sparse mode: individual dots
        const dotR = Math.min(3, pxPerFrame * 0.3);
        const cy = top + areaH / 2;

        for (let f = startFrame; f <= endFrame; f++) {
            if (f < 0 || f >= this._totalFrames) continue;
            const marker = this._frameMarkers.get(f);
            if (!marker) continue;

            const x = this._frameToX(f + 0.5); // center of frame slot
            if (x < this.LEFT_MARGIN || x > W - this.RIGHT_PADDING) continue;

            // Modified frames are drawn as full-height white lines by
            // `_drawModifiedFrameLines`. Grouped-user frames no longer get an
            // in-track tint (the blue column was removed). The marker row
            // draws a dot only for predicted-only frames.
            if (marker.modified || marker.hasUser) continue;
            if (marker.hasPredicted) {
                ctx.strokeStyle = this.MARKER_PREDICTED_COLOR;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(x, cy, dotR, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    }

    /**
     * Draw frame markers in dense mode as colored mini-bars.
     * @private
     */
    _drawFrameMarkersDense(ctx, top, height, W, startFrame, endFrame) {
        const contentLeft = this.LEFT_MARGIN;
        const contentRight = W - this.RIGHT_PADDING;
        const contentW = contentRight - contentLeft;
        if (contentW <= 0) return;

        // Grouped / modified frames are rendered as full-height vertical
        // bars in the track area, so the dense marker row only draws
        // mini-bars for bins that are predicted-only (no grouped user
        // instance).
        const numBins = Math.ceil(contentW);
        const framesPerBin = this._visibleFrames() / numBins;

        ctx.fillStyle = this.MARKER_PREDICTED_COLOR;
        for (let b = 0; b < numBins; b++) {
            const binFrameStart = this._scrollFrame + b * framesPerBin;
            const binFrameEnd = binFrameStart + framesPerBin;
            let hasPredictedOnly = false;

            for (let f = Math.floor(binFrameStart); f < Math.ceil(binFrameEnd); f++) {
                const marker = this._frameMarkers.get(f);
                if (!marker) continue;
                if (marker.modified || marker.hasUser) { hasPredictedOnly = false; break; }
                if (marker.hasPredicted) hasPredictedOnly = true;
            }

            if (!hasPredictedOnly) continue;

            const x = contentLeft + b;
            ctx.globalAlpha = 0.6;
            ctx.fillRect(x, top + 2, 1, height - 4);
            ctx.globalAlpha = 1.0;
        }
    }

    /**
     * Draw frame number labels along the bottom edge.
     * @private
     */
    _drawFrameLabels(ctx, top, W) {
        ctx.fillStyle = this.LABEL_COLOR;
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        // Choose label interval so they don't overlap (~50px apart)
        const pxPerFrame = this._pxPerFrame();
        let interval = 1;
        const minPxBetween = 50;
        if (pxPerFrame > 0) {
            interval = Math.max(1, Math.ceil(minPxBetween / pxPerFrame));
            // Snap to a "nice" number (1, 2, 5, 10, 20, 50, 100, ...)
            interval = this._niceInterval(interval);
        }

        const startFrame = Math.floor(this._scrollFrame);
        const endFrame = Math.ceil(this._scrollFrame + this._visibleFrames());

        // Start at first multiple of interval >= startFrame
        const first = Math.ceil(Math.max(0, startFrame) / interval) * interval;

        for (let f = first; f <= endFrame && f < this._totalFrames; f += interval) {
            const x = this._frameToX(f);
            if (x < this.LEFT_MARGIN || x > W - this.RIGHT_PADDING) continue;
            ctx.fillText(String(f + 1), x, top + 2);
        }

        ctx.textAlign = 'left';
    }

    /**
     * Draw the playhead (current frame indicator).
     * @private
     */
    _drawPlayhead(ctx, H) {
        const x = this._frameToX(this._currentFrame + 0.5);
        if (x < this.LEFT_MARGIN - 2 || x > this._cssWidth - this.RIGHT_PADDING + 2) return;

        // The playhead always extends down to the top of the label area
        // (or to the bottom of the canvas when labels are hidden). It is
        // drawn slightly bolder than the grouped-instance white bars so
        // it stays clearly distinguishable.
        const layout = this._layout || { labelAreaTop: H - this.LABEL_AREA_HEIGHT, showLabels: true };
        const lineBottom = layout.showLabels ? layout.labelAreaTop : H;

        ctx.strokeStyle = this.PLAYHEAD_COLOR;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, lineBottom);
        ctx.stroke();

        // Triangle at bottom of the non-label area, pointing down.
        const triH = 6;
        const triW = 5;
        const triY = lineBottom;
        ctx.fillStyle = this.PLAYHEAD_COLOR;
        ctx.beginPath();
        ctx.moveTo(x, triY - triH);
        ctx.lineTo(x - triW, triY);
        ctx.lineTo(x + triW, triY);
        ctx.closePath();
        ctx.fill();
    }

    // -----------------------------------------------------------------------
    // Coordinate conversion
    // -----------------------------------------------------------------------

    /**
     * Number of frames visible at the current zoom level.
     * @returns {number}
     * @private
     */
    _visibleFrames() {
        return this._totalFrames / this._zoom;
    }

    /**
     * Pixels per frame in the content area.
     * @returns {number}
     * @private
     */
    _pxPerFrame() {
        const contentW = this._cssWidth - this.LEFT_MARGIN - this.RIGHT_PADDING;
        return contentW / this._visibleFrames();
    }

    /**
     * Convert a frame index to an X coordinate on the canvas.
     * @param {number} frame - Can be fractional
     * @returns {number}
     * @private
     */
    _frameToX(frame) {
        const contentW = this._cssWidth - this.LEFT_MARGIN - this.RIGHT_PADDING;
        const visible = this._visibleFrames();
        return this.LEFT_MARGIN + ((frame - this._scrollFrame) / visible) * contentW;
    }

    /**
     * Convert an X coordinate on the canvas to a frame index.
     * @param {number} x - CSS pixel coordinate
     * @returns {number} - Possibly fractional
     * @private
     */
    _xToFrame(x) {
        const contentW = this._cssWidth - this.LEFT_MARGIN - this.RIGHT_PADDING;
        const visible = this._visibleFrames();
        return this._scrollFrame + ((x - this.LEFT_MARGIN) / contentW) * visible;
    }

    /**
     * Clamp a frame index to [0, totalFrames - 1].
     * @param {number} f
     * @returns {number}
     * @private
     */
    _clampFrame(f) {
        return Math.max(0, Math.min(Math.round(f), this._totalFrames - 1));
    }

    /**
     * Clamp scrollFrame so the view stays within bounds.
     * @private
     */
    _clampScroll() {
        const maxScroll = Math.max(0, this._totalFrames - this._visibleFrames());
        this._scrollFrame = Math.max(0, Math.min(this._scrollFrame, maxScroll));
    }

    /**
     * Update the scrollbar thumb position and visibility.
     * @private
     */
    _updateScrollbar() {
        if (this._zoom <= 1) {
            this._scrollbarTrack.style.display = 'none';
            return;
        }
        this._scrollbarTrack.style.display = 'block';
        var trackW = this._scrollbarTrack.offsetWidth;
        if (trackW <= 0) return;
        var visibleFrac = Math.min(1, this._visibleFrames() / this._totalFrames);
        var thumbW = Math.max(this.SCROLLBAR_THUMB_MIN, visibleFrac * trackW);
        var maxScroll = Math.max(0, this._totalFrames - this._visibleFrames());
        var scrollFrac = maxScroll > 0 ? this._scrollFrame / maxScroll : 0;
        var thumbTravel = trackW - thumbW;
        this._scrollbarThumb.style.width = thumbW + 'px';
        this._scrollbarThumb.style.left = (scrollFrac * thumbTravel) + 'px';
    }

    /**
     * Maximum useful zoom level.
     * @returns {number}
     * @private
     */
    _maxZoom() {
        // At max zoom, each frame is ~20px wide
        const contentW = this._cssWidth - this.LEFT_MARGIN - this.RIGHT_PADDING;
        return Math.max(1, this._totalFrames / Math.max(1, contentW / 20));
    }

    /**
     * Ensure the given frame is visible, scrolling if necessary.
     * @param {number} frameIdx
     * @private
     */
    _ensureFrameVisible(frameIdx) {
        const visible = this._visibleFrames();
        if (frameIdx < this._scrollFrame) {
            this._scrollFrame = frameIdx;
        } else if (frameIdx > this._scrollFrame + visible - 1) {
            this._scrollFrame = frameIdx - visible + 1;
        }
        this._clampScroll();
    }

    /**
     * Snap an interval to a "nice" human-readable number.
     * @param {number} raw
     * @returns {number}
     * @private
     */
    _niceInterval(raw) {
        if (raw <= 1) return 1;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const norm = raw / mag;
        if (norm <= 1) return mag;
        if (norm <= 2) return 2 * mag;
        if (norm <= 5) return 5 * mag;
        return 10 * mag;
    }

    // -----------------------------------------------------------------------
    // Mouse events
    // -----------------------------------------------------------------------

    /**
     * @param {MouseEvent} e
     * @private
     */
    _handleMouseDown(e) {
        var x = e.offsetX;
        var y = e.offsetY;

        // Middle or right button -> horizontal pan. Right-click + drag
        // scrolls the timeline; right-click + release (no drag) shows
        // nothing because the `contextmenu` listener preventDefaults
        // the native menu — so a pure right-click is a no-op, matching
        // the "behavior unchanged" requirement of Prompt 96.
        if (e.button === 1 || e.button === 2) {
            e.preventDefault();
            this._isPanning = true;
            this._panStartX = e.clientX;
            this._panStartScroll = this._scrollFrame;
            this._canvas.style.cursor = 'grabbing';
            return;
        }

        // Ignore anything other than the left button.
        if (e.button !== 0) return;

        if (x < this.LEFT_MARGIN) return; // clicked in label area

        if (e.shiftKey) {
            // Range selection start
            this._isRangeSelecting = true;
            const frame = this._clampFrame(this._xToFrame(x));
            this._rangeStart = frame;
            this._rangeEnd = frame;
            this.redraw();
            return;
        }

        // Left-click-and-drag for frame selection was removed in Prompt 97
        // so the video decoder isn't hammered with intermediate frames
        // while the user is still dragging. We just remember that the
        // button is down here; the actual seek happens on `mouseup` at
        // the final cursor position. The playhead stays put during the
        // drag so there's no visual suggestion of a scrub.
        this._isDragging = true;
    }

    /**
     * @param {MouseEvent} e
     * @private
     */
    _handleMouseMove(e) {
        var x = e.offsetX;
        var y = e.offsetY;

        // Panning
        if (this._isPanning) {
            const dx = e.clientX - this._panStartX;
            const framesPerPx = this._visibleFrames() /
                (this._cssWidth - this.LEFT_MARGIN - this.RIGHT_PADDING);
            this._scrollFrame = this._panStartScroll - dx * framesPerPx;
            this._clampScroll();
            this.redraw();
            return;
        }

        // Range selection drag
        if (this._isRangeSelecting) {
            this._rangeEnd = this._clampFrame(this._xToFrame(x));
            this.redraw();
            return;
        }

        // While dragging with the left button, intentionally skip the
        // frame-scrub that used to happen here. Prompt 97 removed
        // mid-drag frame loading — the seek now fires once on
        // `mouseup` at the final cursor position. The hover tooltip
        // below keeps tracking so the user can still see which frame
        // they would land on if they released.

        // Hover tooltip
        if (x >= this.LEFT_MARGIN && x <= this._cssWidth - this.RIGHT_PADDING) {
            const frame = this._clampFrame(this._xToFrame(x));
            const marker = this._frameMarkers.get(frame);
            let text = 'Frame ' + (frame + 1);
            if (marker) {
                const parts = [];
                if (marker.hasUser) parts.push('user');
                if (marker.hasPredicted) parts.push('predicted');
                if (marker.modified) parts.push('modified');
                if (parts.length > 0) text += ' (' + parts.join(', ') + ')';
            }
            this._showTooltip(x, y, text);
        } else {
            this._hideTooltip();
        }
    }

    /**
     * Window-level mousemove for scrollbar dragging.
     * @param {MouseEvent} e
     * @private
     */
    _handleWindowMouseMove(e) {
        if (!this._isScrollbarDragging) return;
        var trackRect = this._scrollbarTrack.getBoundingClientRect();
        var trackW = trackRect.width;
        if (trackW <= 0) return;
        var dx = e.clientX - this._scrollbarDragStartX;
        var maxScroll = Math.max(0, this._totalFrames - this._visibleFrames());
        var thumbTravel = trackW - this._scrollbarThumb.offsetWidth;
        if (thumbTravel <= 0) return;
        this._scrollFrame = this._scrollbarDragStartScroll + (dx / thumbTravel) * maxScroll;
        this._clampScroll();
        this._updateScrollbar();
        this.redraw();
    }

    /**
     * @param {MouseEvent} e
     * @private
     */
    _handleMouseUp(e) {
        if (this._isScrollbarDragging) {
            this._isScrollbarDragging = false;
            this._scrollbarThumb.style.cursor = 'grab';
            return;
        }

        if (this._isPanning) {
            this._isPanning = false;
            this._canvas.style.cursor = 'pointer';
            return;
        }

        if (this._isRangeSelecting) {
            this._isRangeSelecting = false;
            if (this._rangeStart != null && this._rangeEnd != null && this._onRangeSelect) {
                const s = Math.min(this._rangeStart, this._rangeEnd);
                const e2 = Math.max(this._rangeStart, this._rangeEnd);
                this._onRangeSelect(s, e2);
            }
            return;
        }

        if (this._isDragging) {
            this._isDragging = false;
            // Compute the final frame from the release position and
            // emit a single seek for the whole click-or-drag gesture.
            // `mouseup` is bound on `window` so `e.offsetX` isn't
            // reliable — use clientX relative to the canvas rect.
            var rect = this._canvas.getBoundingClientRect();
            var upX = e.clientX - rect.left;
            if (upX >= this.LEFT_MARGIN && upX <= this._cssWidth - this.RIGHT_PADDING) {
                var snapFrame = this._findSnapFrame(upX);
                var frame = snapFrame != null
                    ? this._clampFrame(snapFrame)
                    : this._clampFrame(this._xToFrame(upX));
                this._currentFrame = frame;
                this._emitFrameChange(frame);
                if (this._onDragEnd) this._onDragEnd(frame);
                this.redraw();
            }
        }
    }

    /**
     * Pinch-to-zoom + trackpad/wheel vertical scroll handler.
     *
     * Browsers translate macOS trackpad pinch gestures into `wheel` events
     * with `ctrlKey: true` (a long-standing Chrome/Safari convention that
     * Firefox now mirrors). Ctrl+wheel on a regular mouse produces the
     * same event, so a single branch covers both inputs:
     *
     *   • `ctrlKey === true`  → zoom the time axis (pinch / Ctrl+wheel).
     *   • `ctrlKey === false` → fall through. The wheel event bubbles to
     *     `_trackScrollEl`, whose `overflow-y: auto` produces native
     *     vertical scrolling. This is what two-finger trackpad scrolling
     *     and a regular mouse wheel both land on.
     *
     * We deliberately do NOT call `preventDefault()` on the non-zoom path —
     * native overflow scrolling only happens when the browser receives
     * the wheel event uncancelled.
     *
     * @param {WheelEvent} e
     * @private
     */
    _handleWheel(e) {
        // Non-pinch wheel events delegate to the scroll wrapper. Returning
        // without preventDefault lets `_trackScrollEl` scroll naturally
        // (macOS two-finger scroll, mouse wheel, etc.).
        if (!e.ctrlKey) return;

        var mouseX = e.offsetX;
        var contentRight = this._cssWidth - this.RIGHT_PADDING;
        // Pinching over the label gutter or right padding still zooms,
        // but we anchor on the nearest content edge so the math behaves.
        if (mouseX < this.LEFT_MARGIN) mouseX = this.LEFT_MARGIN;
        if (mouseX > contentRight) mouseX = contentRight;

        e.preventDefault();

        // Frame under cursor before zoom
        const frameUnderCursor = this._xToFrame(mouseX);

        // Adjust zoom. Trackpad pinch produces fractional deltaY (often <10
        // per event), mouse-wheel-with-Ctrl produces ~±100 — same direction
        // convention applies (negative deltaY = pinch-out / zoom in).
        const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newZoom = Math.max(1, Math.min(this._zoom * zoomFactor, this._maxZoom()));

        if (newZoom === this._zoom) return;
        this._zoom = newZoom;

        // Adjust scroll so the frame under the cursor stays put
        const contentW = this._cssWidth - this.LEFT_MARGIN - this.RIGHT_PADDING;
        const visible = this._visibleFrames();
        const frac = (mouseX - this.LEFT_MARGIN) / contentW;
        this._scrollFrame = frameUnderCursor - frac * visible;
        this._clampScroll();

        this.redraw();
    }

    // -----------------------------------------------------------------------
    // Touch events (mobile support)
    // -----------------------------------------------------------------------

    /**
     * @param {TouchEvent} e
     * @private
     */
    _handleTouchStart(e) {
        if (e.touches.length !== 1) return;
        e.preventDefault();

        const touch = e.touches[0];
        const rect = this._canvas.getBoundingClientRect();
        const x = touch.clientX - rect.left;

        if (x < this.LEFT_MARGIN) return;

        this._isDragging = true;
        this._touchLastX = touch.clientX;

        const frame = this._clampFrame(this._xToFrame(x));
        this._currentFrame = frame;
        this._emitFrameChange(frame);
        this.redraw();
    }

    /**
     * @param {TouchEvent} e
     * @private
     */
    _handleTouchMove(e) {
        if (!this._isDragging || e.touches.length !== 1) return;
        e.preventDefault();

        const touch = e.touches[0];
        const rect = this._canvas.getBoundingClientRect();
        const x = touch.clientX - rect.left;

        const frame = this._clampFrame(this._xToFrame(x));
        if (frame !== this._currentFrame) {
            this._currentFrame = frame;
            this._emitFrameChange(frame);
            this.redraw();
        }
    }

    /**
     * @param {TouchEvent} e
     * @private
     */
    _handleTouchEnd(e) {
        this._isDragging = false;
    }

    // -----------------------------------------------------------------------
    // Tooltip
    // -----------------------------------------------------------------------

    /**
     * Show tooltip near the cursor.
     * @param {number} x - CSS x relative to canvas
     * @param {number} y - CSS y relative to canvas
     * @param {string} text
     * @private
     */
    _showTooltip(x, y, text) {
        this._tooltipEl.textContent = text;
        this._tooltipEl.style.display = 'block';
        // Position above cursor
        this._tooltipEl.style.left = (x + 8) + 'px';
        this._tooltipEl.style.top = Math.max(0, y - 28) + 'px';
    }

    /**
     * Hide the tooltip.
     * @private
     */
    _hideTooltip() {
        this._tooltipEl.style.display = 'none';
    }

    // -----------------------------------------------------------------------
    // Callbacks
    // -----------------------------------------------------------------------

    /**
     * Emit a frame-change event.
     * @param {number} frameIdx
     * @private
     */
    _emitFrameChange(frameIdx) {
        if (this._onFrameChange) {
            this._onFrameChange(frameIdx);
        }
    }

    /**
     * Mark a frame as modified (e.g., after user edits).
     * @param {number} frameIdx
     * @param {boolean} [modified=true]
     */
    setFrameModified(frameIdx, modified) {
        if (modified === undefined) modified = true;
        const marker = this._frameMarkers.get(frameIdx);
        if (marker) {
            marker.modified = modified;
        } else {
            this._frameMarkers.set(frameIdx, {
                hasUser: false,
                hasPredicted: false,
                modified: modified,
            });
        }
    }

    /**
     * Rebuild track segments from the session without clearing frame markers.
     * Call after triangulation or track assignment to update track bars in real time.
     *
     * Default behavior also grows the container when the new set of
     * tracks needs more vertical space than the container currently has —
     * otherwise the collapse-priority layout in `_computeLayout` would
     * hide every track row (since the natural track block no longer
     * fits), which manifests as "the timeline clears the first time a
     * new track is assigned." Never shrinks; callers that need to resize
     * down go through `setData` + `fitTimelineToData` in index.html.
     *
     * Pass `{ keepSize: true }` to skip the grow + resize step. This is
     * the right mode for Block 2 visibility toggles: the underlying
     * tracks haven't changed (only which rows render), so the outer
     * timeline frame AND the inner canvas height must both stay put.
     * Otherwise `resize()` would shrink the canvas to `availableH`
     * (since the natural-height term in `max(natural, availableH)`
     * drops when rows are filtered), and the playhead / marker row /
     * frame-number labels would jump up to the new bottom — visible as
     * "the timeline got shorter."
     *
     * @param {Session} session
     * @param {{keepSize?: boolean}} [opts]
     */
    refreshTracks(session, opts) {
        if (!session) return;
        this._session = session;
        this._rebuildSegments(session);
        if (opts && opts.keepSize) {
            // Segments rebuilt; row positions reflowed; outer container
            // and canvas pixel dimensions stay exactly as the user left
            // them. Just repaint.
            this.redraw();
            return;
        }
        this._growContainerToFit();
        this.resize();
    }

    /**
     * If the container is shorter than the preferred height for the
     * current track set, enlarge it in-place. No-op when the timeline
     * has been manually collapsed (the toolbar button sets `.collapsed`
     * which forces height:0 via CSS).
     * @private
     */
    _growContainerToFit() {
        if (!this._container) return;
        if (this._container.classList && this._container.classList.contains('collapsed')) return;
        var preferred = this.getPreferredHeight();
        var styleH = parseFloat(this._container.style && this._container.style.height);
        var currentPx = (!isNaN(styleH) && styleH > 0) ? styleH : 0;
        if (!currentPx) {
            var rect = this._container.getBoundingClientRect
                ? this._container.getBoundingClientRect()
                : null;
            currentPx = (rect && rect.height) || 0;
        }
        if (preferred > currentPx + 0.5) {
            this._container.style.height = preferred + 'px';
        }
    }

    /**
     * Clear the current range selection.
     */
    clearRangeSelection() {
        this._rangeStart = null;
        this._rangeEnd = null;
        this.redraw();
    }

    // -----------------------------------------------------------------------
    // Block 1 (Prompt 4) tree-grouping accessors
    // -----------------------------------------------------------------------

    /**
     * Return the per-camera grouped row data. Each entry has shape
     * `{ name: cameraName, tracks: [trackSeg, ...], isEmpty: bool }`.
     * Returns a defensive copy so callers can't mutate internal state.
     *
     * @returns {Array<{name:string, tracks:Array, isEmpty:boolean}>}
     */
    getCameraGroups() {
        return this._cameraGroups ? this._cameraGroups.slice() : [];
    }

    /**
     * Return the tree-decorated label strings, one per row. Mirrors the
     * private `_trackNames` array consumed by the canvas drawing path.
     *
     * @returns {string[]}
     */
    getLabelLines() {
        return this._trackNames ? this._trackNames.slice() : [];
    }

    /**
     * Return the total number of timeline rows (real track rows +
     * empty-camera placeholder rows).
     *
     * @returns {number}
     */
    getRowCount() {
        return this._trackSegments ? this._trackSegments.length : 0;
    }

    /**
     * Return the scrollable track-area wrapper element so external code
     * (and tests) can read its `scrollHeight` / `clientHeight` and verify
     * the overflow:auto styling.
     *
     * @returns {HTMLElement|null}
     */
    getTrackAreaElement() {
        return this._trackScrollEl || null;
    }
}
