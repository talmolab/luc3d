/**
 * timeline.js - SLEAP-like timeline widget for multi-view pose proofreading
 *
 * Canvas-based timeline showing track occupancy bars, frame markers, and
 * a current-frame indicator.  Supports click-to-seek, drag-to-scrub,
 * shift-drag range selection, wheel zoom, and middle-click panning.
 *
 * Depends on:
 *   - getTrackColor(trackIdx)  from overlays.js
 *   - Session / FrameGroup / Instance  from pose-data.js
 *
 * All identifiers live in the global scope (no imports/exports).
 */

// ============================================================================
// Timeline class
// ============================================================================

class Timeline {

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
         * Display mode: 'tracks', 'identities', 'both', 'reprojs', or 'track-var'.
         * The latter two replace track bars with a line graph.
         */
        this._displayMode = 'tracks';

        /** Cached session reference for rebuilding segments on mode change */
        this._session = null;

        /** Range selection state */
        this._rangeStart = null;
        this._rangeEnd = null;

        /** Tooltip state */
        this._tooltip = { visible: false, x: 0, y: 0, text: '' };

        // --- Graph-view state (reprojs / track-var) ---

        /**
         * Lazy reader for reprojection data. Set via setReprojDataSource(fn).
         * fn() returns a Map<frameIdx, Array<{errors}>> (i.e. state.triangulationResults).
         * Using a callback avoids coupling Timeline to a specific Map reference
         * that gets swapped on session changes.
         * @type {Function|null}
         */
        this._reprojDataSource = null;

        /** Cached Reprojs series: Map<frameIdx, meanError>. null = dirty */
        this._reprojSeries = null;
        this._reprojMin = 0;
        this._reprojMax = 0;

        /** Cached Track Var series: { [camName]: Array<number|null> }. null = dirty */
        this._trackVarSeries = null;
        this._trackVarMin = 0;
        this._trackVarMax = 0;
        this._trackVarEmpty = true;

        /** Currently plotted Track Var key (first declared by default). */
        this._trackVarKey = null;

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

        /** @const {number} Left margin for track labels */
        this.LEFT_MARGIN = 100;

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

        // --- Graph-view constants ---

        /** @const Natural height of the graph band in graph view modes (px) */
        this.GRAPH_AREA_HEIGHT = 140;
        /** @const Degenerate-height threshold below which graph is skipped (px) */
        this.MIN_GRAPH_HEIGHT = 30;
        /** @const Warm amber — distinct from REPROJECTION_COLOR red reserved for reprojected instances */
        this.REPROJ_LINE_COLOR = '#f5a623';
        /** @const Fraction of y-range to pad above max and below min so the line never touches edges */
        this.GRAPH_Y_PAD_FRAC = 0.08;
        /** @const Alpha used for annotation-context bars when drawn in graph mode */
        this.GRAPH_ANNOTATION_ALPHA = 0.2;

        // --- Create canvas ---------------------------------------------------

        /** @type {HTMLCanvasElement} */
        this._canvas = document.createElement('canvas');
        this._canvas.style.display = 'block';
        this._canvas.style.width = '100%';
        this._canvas.style.height = '100%';
        this._canvas.style.cursor = 'pointer';
        this._container.appendChild(this._canvas);

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
        // Invalidate graph caches on every setData call (including null)
        // so stale data from a previous session never lingers.
        this.invalidateReprojCache();
        this.invalidateTrackVarCache();

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
        var h = Math.round(rect.height);
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
        // Graph-view modes use a fixed natural height since track-row
        // geometry doesn't apply.
        if (this._isGraphMode()) {
            return this.TOP_PADDING
                + this.GRAPH_AREA_HEIGHT
                + 6
                + this.MARKER_AREA_HEIGHT
                + this.LABEL_AREA_HEIGHT
                + 8;
        }
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
            showGraph: false,
            labelAreaTop: H,
            markerAreaTop: H,
            markerAreaBottom: H,
            trackAreaTop: this.TOP_PADDING,
            trackAreaBottom: this.TOP_PADDING,
            graphAreaTop: this.TOP_PADDING,
            graphAreaBottom: this.TOP_PADDING,
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

        // Tracks only render if the entire natural track block fits above
        // the marker area with TOP_PADDING above and a small gap below.
        if (numTracks > 0 && layout.showMarkers && !this._isGraphMode()) {
            var trackCeiling = layout.markerAreaTop - 4; // small gap before markers
            var availableForTracks = trackCeiling - this.TOP_PADDING;
            if (availableForTracks >= naturalTrackH) {
                layout.showTracks = true;
                layout.trackAreaTop = this.TOP_PADDING;
                layout.trackAreaBottom = layout.trackAreaTop + naturalTrackH;
                layout.numVisibleTracks = numTracks;
            }
        }

        // Graph view branch — fills the band that tracks would occupy,
        // using whatever vertical space is available (not a fixed 140 px),
        // so tall containers aren't wasted.
        if (this._isGraphMode() && layout.showMarkers) {
            var graphTop = this.TOP_PADDING;
            var graphBottom = layout.markerAreaTop - 4;
            if ((graphBottom - graphTop) >= this.MIN_GRAPH_HEIGHT) {
                layout.showGraph = true;
                layout.graphAreaTop = graphTop;
                layout.graphAreaBottom = graphBottom;
            }
        }
        return layout;
    }

    /** @private */
    _isGraphMode() {
        return this._displayMode === 'reprojs' || this._displayMode === 'track-var';
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

            // Blue bars: frames that have a grouped UserInstance. These
            // span the track area so the user sees a solid blue column
            // on every annotated frame — not just a dot.
            this._drawGroupedUserFrameBars(ctx, 0, layout.trackAreaBottom, W);

            // White bars: frames explicitly flagged as modified, drawn on
            // top of the blue bars. Both extend only from the top of the
            // timeline down to the bottom of the lowest track row — NOT
            // into the marker or label areas.
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

        // --- Graph view (reprojs / track-var) ---
        if (layout.showGraph) {
            // Preserve annotation context (user-frame + modified-frame bars)
            // at reduced alpha so users can still see which frames were
            // edited while viewing the graph.
            var prevAlpha = ctx.globalAlpha;
            ctx.globalAlpha = this.GRAPH_ANNOTATION_ALPHA;
            this._drawGroupedUserFrameBars(ctx, 0, layout.graphAreaBottom, W);
            this._drawModifiedFrameLines(ctx, 0, layout.graphAreaBottom, W);
            ctx.globalAlpha = prevAlpha;

            this._drawGraphView(ctx, layout, W);

            if (layout.showMarkers) {
                const sepY = layout.graphAreaBottom + 4;
                ctx.strokeStyle = this.SEPARATOR_COLOR;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(this.LEFT_MARGIN, sepY);
                ctx.lineTo(W - this.RIGHT_PADDING, sepY);
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
        this._container.removeChild(this._canvas);
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
        if (numTracks === 0) return;

        // Collect camera names
        var cameraNames = session.cameras ? session.cameras.map(function (c) { return c.name; }) : [];

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

        // Build segments ordered by camera then track (view-first layout)
        for (var ci = 0; ci < cameraNames.length; ci++) {
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
                var color = typeof getTrackColor === 'function' ? getTrackColor(t3) : '#667eea';

                this._trackSegments.push({
                    trackIdx: t3,
                    cameraName: cameraNames[ci],
                    color: color,
                    segments: segments,
                });
                this._trackNames.push(cameraNames[ci] + ' / ' + trackName);
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
        // Graph view modes (reprojs, track-var) don't use track segments.
        // Leaving _trackSegments untouched is intentional — it survives
        // across a graph-mode interlude so returning to tracks/ids/both
        // restores the previous view without a redundant rebuild.
        if (this._isGraphMode()) return;
        if (this._displayMode === 'identities') {
            this._buildIdentitySegments(session);
        } else if (this._displayMode === 'both') {
            this._buildTrackSegments(session);
            // Append identity segments after track segments
            var trackCount = this._trackSegments.length;
            var trackNames = this._trackNames.slice();
            this._buildIdentitySegments(session);
            // Merge: track segments first, then identity segments
            var idSegments = this._trackSegments;
            var idNames = this._trackNames;
            this._trackSegments = [];
            this._trackNames = [];
            // Re-build track segments
            this._buildTrackSegments(session);
            // Append identity segments
            for (var i = 0; i < idSegments.length; i++) {
                this._trackSegments.push(idSegments[i]);
                this._trackNames.push(idNames[i]);
            }
        } else {
            this._buildTrackSegments(session);
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

        if (!session.identities || session.identities.length === 0) return;

        var cameraNames = session.cameras ? session.cameras.map(function (c) { return c.name; }) : [];

        // Build identity -> camName -> Set<frameIdx>
        var idCamFrames = {};  // "identityId:camName" -> Set<frameIdx>

        for (var [frameIdx, fg] of session.frameGroups) {
            // Grouped instances
            for (var [camName, instances] of fg.instances) {
                for (var i = 0; i < instances.length; i++) {
                    var idId = session.getIdentityIdForTrack
                        ? session.getIdentityIdForTrack(camName, instances[i].trackIdx, frameIdx)
                        : session.trackIdentityMap.get(camName + ':' + instances[i].trackIdx);
                    if (idId == null) continue;
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
                    if (idId2 == null) continue;
                    var segKey2 = idId2 + ':' + camName2;
                    if (!idCamFrames[segKey2]) idCamFrames[segKey2] = new Set();
                    idCamFrames[segKey2].add(frameIdx);
                }
            }
        }

        // Build segments per camera per identity (view-first layout)
        for (var ci = 0; ci < cameraNames.length; ci++) {
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
                });
                this._trackNames.push(cameraNames[ci] + ' / ' + ident.name);
            }
        }
    }

    /**
     * Set the timeline display mode and refresh.
     * Valid values: 'tracks' | 'identities' | 'both' | 'reprojs' | 'track-var'.
     * The last two replace track rows with a line graph.
     */
    setDisplayMode(mode) {
        var wasGraph = this._isGraphMode();
        this._displayMode = mode;
        var isGraph = this._isGraphMode();

        if (this._session) {
            if (isGraph) {
                // Build the correct graph-view series. This handles both
                // tracks→graph and graph→graph (reprojs ↔ track-var) entries.
                this._buildGraphData(this._session);
            } else if (wasGraph) {
                // Leaving graph mode — restore the track-based view.
                this._rebuildSegments(this._session);
            } else {
                this._rebuildSegments(this._session);
            }
            // Ensure the container has enough vertical room for whichever
            // mode we just entered (grow-only; user can shrink via resize
            // handle if desired).
            this._growContainerToFit();
            this.resize();
        }
    }

    /**
     * Set (or replace) the Reprojs data-source callback.
     * The callback returns the current Map<frameIdx, Array<frameResults>>
     * — typically state.triangulationResults from the host page.
     * Invalidates the cache so the next redraw rebuilds the series.
     * @param {Function|null} fn
     */
    setReprojDataSource(fn) {
        this._reprojDataSource = (typeof fn === 'function') ? fn : null;
        this.invalidateReprojCache();
        if (this._displayMode === 'reprojs') {
            this._buildGraphData(this._session);
            this.redraw();
        }
    }

    /**
     * Pick which tracker-variable key to plot in 'track-var' mode.
     * @param {string|null} key
     */
    setTrackVarKey(key) {
        this._trackVarKey = key || null;
        this.invalidateTrackVarCache();
        if (this._displayMode === 'track-var') {
            this._buildGraphData(this._session);
            this.redraw();
        }
    }

    /** Invalidate the Reprojs cache. O(1) — rebuild happens lazily on next redraw. */
    invalidateReprojCache() {
        this._reprojSeries = null;
    }

    /** Invalidate the Track Var cache. O(1) — rebuild happens lazily on next redraw. */
    invalidateTrackVarCache() {
        this._trackVarSeries = null;
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

        for (let t = 0; t < this._trackSegments.length; t++) {
            const track = this._trackSegments[t];
            const rowY = top + rowYPositions[t];

            // Track label
            ctx.fillStyle = this.LABEL_COLOR;
            ctx.font = '10px system-ui, sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            const label = this._trackNames[t] || ('Track ' + t);
            ctx.fillText(label, this.LEFT_MARGIN - 6, rowY + this.TRACK_ROW_HEIGHT / 2);

            // Draw segments
            ctx.fillStyle = track.color;
            for (let s = 0; s < track.segments.length; s++) {
                const rect = this._computeSegmentDrawRect(track.segments[s]);
                if (!rect) continue;

                ctx.globalAlpha = 0.7;
                ctx.fillRect(rect.x, rowY, rect.width, this.TRACK_ROW_HEIGHT);
                ctx.globalAlpha = 1.0;
            }
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
        if (this._isGraphMode()) return null;  // clicks seek to exact frame in graph views
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
     * Draw blue vertical bars for frames that have a grouped user
     * instance (`hasUser`). These render over the track area so the user
     * sees a solid blue column on the frames that have been annotated,
     * not just a dot in the marker row. Frames that are also `modified`
     * are still drawn here — the white modified-line is painted on top
     * afterwards.
     * @private
     */
    _drawGroupedUserFrameBars(ctx, top, bottom, W) {
        this._drawFrameBars(ctx, top, bottom, W,
            this.MARKER_USER_COLOR,
            function (m) { return m.hasUser; },
            0.55, 0.7);
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

            // Modified / grouped-user frames are drawn as full-height
            // bars by `_drawModifiedFrameLines` / `_drawGroupedUserFrameBars`.
            // The marker row only draws a dot for predicted-only frames.
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
     * Zoom with mouse wheel centered on the cursor position.
     * @param {WheelEvent} e
     * @private
     */
    _handleWheel(e) {
        var mouseX = e.offsetX;
        var contentRight = this._cssWidth - this.RIGHT_PADDING;

        // Left label area or right edge: let container scroll vertically
        if (mouseX < this.LEFT_MARGIN || mouseX > contentRight) {
            // Don't preventDefault — let the container handle vertical scroll
            return;
        }

        e.preventDefault();

        // Frame under cursor before zoom
        const frameUnderCursor = this._xToFrame(mouseX);

        // Adjust zoom
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
     * Also grows the container when the new set of tracks needs more
     * vertical space than the container currently has — otherwise the
     * collapse-priority layout in `_computeLayout` would hide every
     * track row (since the natural track block no longer fits), which
     * manifests as "the timeline clears the first time a new track is
     * assigned." Never shrinks; callers that need to resize down go
     * through `setData` + `fitTimelineToData` in index.html.
     *
     * @param {Session} session
     */
    refreshTracks(session) {
        if (!session) return;
        this._session = session;
        // Belt-and-suspenders: any mutation that warrants a track refresh
        // may also affect graph data. Explicit invalidation sites still
        // fire independently; this is a safety net.
        this.invalidateReprojCache();
        this.invalidateTrackVarCache();
        this._rebuildSegments(session);
        this._growContainerToFit();
        this.resize();
    }

    // -----------------------------------------------------------------------
    // Graph view (reprojs / track-var)
    // -----------------------------------------------------------------------

    /**
     * Build the series cache for whichever graph mode is currently active.
     * Safe to call at any time — individual builders are no-ops if their
     * cache is fresh or their data source is missing.
     * @private
     */
    _buildGraphData(session) {
        if (this._displayMode === 'reprojs') {
            this._buildReprojSeries(session);
        } else if (this._displayMode === 'track-var') {
            this._buildTrackVarSeries(session);
        }
    }

    /**
     * Compute mean reprojection error per frame. Reads from the authoritative
     * source — session.instanceGroups, where group.reprojections is populated
     * by every triangulation path (the same data the overlay renders). If
     * available, group.observedPoints supplies the paired 2D observations;
     * otherwise we fall back to the instance's own .points.
     *
     * A secondary source (state.triangulationResults) is consulted via
     * _reprojDataSource if instanceGroups yields nothing, to cover any
     * future pipeline that records errors without touching the groups.
     *
     * Frames with no valid errors are omitted — gaps, not zeros.
     * @private
     */
    _buildReprojSeries(session) {
        var series = new Map();
        var yMin = Infinity, yMax = -Infinity;

        function addFrame(frameIdx, total, count) {
            if (count <= 0) return;
            var mean = total / count;
            series.set(frameIdx, mean);
            if (mean < yMin) yMin = mean;
            if (mean > yMax) yMax = mean;
        }

        // Given a group + cam name, return the reprojected 2D points array
        // ([[x,y]|null, ...]), consulting both representations the overlay
        // code also supports: group.reprojections[cam] (dict of arrays) and
        // group.reprojectedInstances.get(cam).points (Instance wrapper).
        function getReprojPoints(grp, cam) {
            if (grp.reprojections && grp.reprojections[cam]) return grp.reprojections[cam];
            var rInsts = grp.reprojectedInstances;
            if (rInsts && typeof rInsts.get === 'function') {
                var rInst = rInsts.get(cam);
                if (rInst && rInst.points) return rInst.points;
            }
            return null;
        }

        // List of camera names for this group — union across both
        // reprojection representations.
        function getReprojCamNames(grp) {
            var names = {};
            if (grp.reprojections) {
                for (var cn in grp.reprojections) {
                    if (Object.prototype.hasOwnProperty.call(grp.reprojections, cn)) names[cn] = true;
                }
            }
            if (grp.reprojectedInstances && typeof grp.reprojectedInstances.forEach === 'function') {
                grp.reprojectedInstances.forEach(function (_v, cn) { names[cn] = true; });
            }
            return Object.keys(names);
        }

        // Primary source: session.instanceGroups. Walk every group, union
        // camera names across both reprojection representations, compute
        // mean per-keypoint Euclidean error vs. the instance's observed
        // points. Frames with no errors are omitted.
        if (session && session.instanceGroups && session.instanceGroups.forEach) {
            session.instanceGroups.forEach(function (groups, frameIdx) {
                if (!groups || groups.length === 0) return;
                var total = 0, count = 0;
                for (var g = 0; g < groups.length; g++) {
                    var grp = groups[g];
                    if (!grp) continue;
                    var camNames = getReprojCamNames(grp);
                    if (camNames.length === 0) continue;
                    for (var ci = 0; ci < camNames.length; ci++) {
                        var camName = camNames[ci];
                        var rep = getReprojPoints(grp, camName);
                        if (!rep) continue;
                        // Prefer stored observed points; fall back to the
                        // instance's own .points.
                        var obs = (grp.observedPoints && grp.observedPoints[camName]) || null;
                        if (!obs) {
                            var inst = (typeof grp.getInstance === 'function')
                                ? grp.getInstance(camName)
                                : (grp.instances && grp.instances.get ? grp.instances.get(camName) : null);
                            obs = inst && inst.points;
                        }
                        if (!obs) continue;
                        var n = Math.min(rep.length, obs.length);
                        for (var k = 0; k < n; k++) {
                            var rp = rep[k], op = obs[k];
                            if (!rp || !op) continue;
                            var dx = rp[0] - op[0];
                            var dy = rp[1] - op[1];
                            var e = Math.sqrt(dx * dx + dy * dy);
                            if (isFinite(e)) { total += e; count++; }
                        }
                    }
                }
                addFrame(frameIdx, total, count);
            });
        }

        // Secondary source: state.triangulationResults via callback. Only
        // consulted when instanceGroups gave us nothing (e.g. a future
        // pipeline records errors separately from group.reprojections).
        if (series.size === 0) {
            var map = (typeof this._reprojDataSource === 'function') ? this._reprojDataSource() : null;
            if (map && map.forEach) {
                map.forEach(function (frameResults, frameIdx) {
                    if (!frameResults || frameResults.length === 0) return;
                    var total = 0, count = 0;
                    for (var r = 0; r < frameResults.length; r++) {
                        var errs = frameResults[r] && frameResults[r].errors;
                        if (!errs) continue;
                        for (var cn in errs) {
                            if (!Object.prototype.hasOwnProperty.call(errs, cn)) continue;
                            var arr = errs[cn];
                            if (!arr) continue;
                            for (var k2 = 0; k2 < arr.length; k2++) {
                                var e2 = arr[k2];
                                if (e2 != null && isFinite(e2)) { total += e2; count++; }
                            }
                        }
                    }
                    addFrame(frameIdx, total, count);
                });
            }
        }

        if (series.size === 0) {
            this._reprojSeries = series;
            this._reprojMin = 0;
            this._reprojMax = 1;
            return;
        }
        this._reprojSeries = series;
        this._reprojMin = yMin;
        this._reprojMax = yMax;
    }

    /**
     * Read session.trackerVariables and produce the per-camera arrays for
     * the currently-selected _trackVarKey. Sets _trackVarEmpty = true if
     * no key has any data.
     * @private
     */
    _buildTrackVarSeries(session) {
        this._trackVarEmpty = true;
        this._trackVarSeries = {};
        this._trackVarMin = 0;
        this._trackVarMax = 1;

        var tv = session && session.trackerVariables;
        if (!tv || !tv.data) return;

        // Enumerate all (camName, key) pairs that actually have any data.
        var keysWithData = {};
        var cams = Object.keys(tv.data);
        for (var ci = 0; ci < cams.length; ci++) {
            var byKey = tv.data[cams[ci]] || {};
            var keys = Object.keys(byKey);
            for (var ki = 0; ki < keys.length; ki++) {
                var arr = byKey[keys[ki]];
                if (arr && arr.length > 0) keysWithData[keys[ki]] = true;
            }
        }
        var availableKeys = Object.keys(keysWithData);
        if (availableKeys.length === 0) return;

        // Pick the active key. Prefer schema declaration order, then
        // previously-set _trackVarKey, then first available.
        var schemaKeys = tv.schema ? Object.keys(tv.schema) : [];
        var key = null;
        if (this._trackVarKey && keysWithData[this._trackVarKey]) {
            key = this._trackVarKey;
        } else {
            for (var si = 0; si < schemaKeys.length; si++) {
                if (keysWithData[schemaKeys[si]]) { key = schemaKeys[si]; break; }
            }
            if (!key) key = availableKeys[0];
        }
        this._trackVarKey = key;

        if (availableKeys.length > 1) {
            console.info('[Timeline] Multiple tracker variables declared (' +
                availableKeys.join(', ') + '); showing "' + key +
                '". Multi-key picker coming in a later release.');
        }

        // Collect per-camera arrays and compute y-range.
        var yMin = Infinity, yMax = -Infinity;
        var anyData = false;
        for (var ci2 = 0; ci2 < cams.length; ci2++) {
            var camName = cams[ci2];
            var arr2 = tv.data[camName] && tv.data[camName][key];
            if (!arr2 || arr2.length === 0) continue;
            this._trackVarSeries[camName] = arr2;
            for (var fi = 0; fi < arr2.length; fi++) {
                var v = arr2[fi];
                if (v != null && isFinite(v)) {
                    anyData = true;
                    if (v < yMin) yMin = v;
                    if (v > yMax) yMax = v;
                }
            }
        }
        if (!anyData) return;

        // Override with schema-declared range if provided.
        var meta = tv.schema && tv.schema[key];
        if (meta && typeof meta.yMin === 'number') yMin = meta.yMin;
        if (meta && typeof meta.yMax === 'number') yMax = meta.yMax;

        this._trackVarMin = yMin;
        this._trackVarMax = yMax;
        this._trackVarEmpty = false;
    }

    /**
     * Dispatch graph drawing to the active mode's renderer.
     * @private
     */
    _drawGraphView(ctx, layout, W) {
        // Lazy-build if cache is dirty.
        if (this._displayMode === 'reprojs' && this._reprojSeries == null) {
            this._buildReprojSeries(this._session);
        } else if (this._displayMode === 'track-var' && this._trackVarSeries == null) {
            this._buildTrackVarSeries(this._session);
        }

        var top = layout.graphAreaTop;
        var bot = layout.graphAreaBottom;

        if (this._displayMode === 'reprojs') {
            var hasData = this._reprojSeries && this._reprojSeries.size > 0;
            this._drawYAxis(ctx, top, bot, this._reprojMin, this._reprojMax);
            if (hasData) {
                this._drawLineGraph(ctx, top, bot, W,
                    this._reprojSeries, this._reprojMin, this._reprojMax,
                    this.REPROJ_LINE_COLOR);
            } else {
                this._drawEmptyMessage(ctx, top, bot, W,
                    'No reprojection data yet.',
                    'Run Track Frame or Track All to populate.');
            }
            return;
        }

        if (this._displayMode === 'track-var') {
            if (this._trackVarEmpty) {
                this._drawEmptyMessage(ctx, top, bot, W,
                    'No tracker variable data available for this session.',
                    'Run Track All to compute tracker metrics.');
                return;
            }
            this._drawYAxis(ctx, top, bot, this._trackVarMin, this._trackVarMax);

            // One line per camera using TRACK_COLORS, skipping index 0
            // (red) since that's reserved for reprojection visuals.
            var cams = this._session && this._session.cameras
                ? this._session.cameras.map(function (c) { return c.name; })
                : Object.keys(this._trackVarSeries);
            var legendEntries = [];
            for (var i = 0; i < cams.length; i++) {
                var camName = cams[i];
                var arr = this._trackVarSeries[camName];
                if (!arr || arr.length === 0) continue;
                var color = (typeof getTrackColor === 'function')
                    ? getTrackColor(i + 1)
                    : '#7fb6ff';
                // Array-backed series adapts to same line-graph interface.
                this._drawLineGraph(ctx, top, bot, W, arr,
                    this._trackVarMin, this._trackVarMax, color);
                legendEntries.push({ label: camName, color: color });
            }
            if (legendEntries.length > 0) {
                this._drawLegend(ctx, top + 4, W - this.RIGHT_PADDING - 6, legendEntries);
            }
        }
    }

    /**
     * Generic line-graph renderer. `series` can be either a
     * Map<frameIdx, number> or a dense Array<number|null> indexed by frame.
     * Breaks the path at null/undefined cells so gaps are not bridged.
     * Clips to the graph rect to avoid pathological off-screen strokes.
     * @private
     */
    _drawLineGraph(ctx, top, bot, W, series, yMin, yMax, color) {
        if (!series) return;
        var range = yMax - yMin;
        var pad = Math.max(range * this.GRAPH_Y_PAD_FRAC, 1e-9);
        var yLo = yMin - pad;
        var yHi = yMax + pad;
        if (yHi - yLo < 1e-9) { yLo -= 1; yHi += 1; }
        var usable = bot - top;
        var self = this;
        function yFor(v) {
            var norm = (v - yLo) / (yHi - yLo);
            return bot - norm * usable;
        }

        ctx.save();
        ctx.beginPath();
        ctx.rect(this.LEFT_MARGIN, top, W - this.LEFT_MARGIN - this.RIGHT_PADDING, bot - top);
        ctx.clip();

        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();

        // Collect visible (x,y) in order so we can (a) stroke the line and
        // (b) paint a small dot at every point — so single isolated frames
        // render as a visible dot even without any neighbor to form a line.
        var pts = [];
        var startFrame = Math.max(0, Math.floor(this._scrollFrame));
        var endFrame = Math.min(this._totalFrames - 1,
            Math.ceil(this._scrollFrame + this._visibleFrames()));

        if (series instanceof Map) {
            for (var f = startFrame; f <= endFrame; f++) {
                var v = series.get(f);
                if (v == null || !isFinite(v)) { pts.push(null); continue; }
                pts.push({ x: self._frameToX(f + 0.5), y: yFor(v) });
            }
        } else {
            var len = series.length;
            var hi = Math.min(endFrame, len - 1);
            for (var f2 = startFrame; f2 <= hi; f2++) {
                var v2 = series[f2];
                if (v2 == null || !isFinite(v2)) { pts.push(null); continue; }
                pts.push({ x: self._frameToX(f2 + 0.5), y: yFor(v2) });
            }
        }

        // Stroke the line (break on gaps).
        var started = false;
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i];
            if (!p) { started = false; continue; }
            if (!started) { ctx.moveTo(p.x, p.y); started = true; }
            else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();

        // Paint dots on top. Radius 2px.
        for (var j = 0; j < pts.length; j++) {
            var q = pts[j];
            if (!q) continue;
            ctx.beginPath();
            ctx.arc(q.x, q.y, 2, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    /**
     * Draw y-axis labels (min/mid/max) plus faint horizontal gridlines.
     * Labels appear in the space currently used by track names.
     * @private
     */
    _drawYAxis(ctx, top, bot, yMin, yMax) {
        var range = yMax - yMin;
        var pad = Math.max(range * this.GRAPH_Y_PAD_FRAC, 1e-9);
        var yLo = yMin - pad;
        var yHi = yMax + pad;
        if (yHi - yLo < 1e-9) { yLo -= 1; yHi += 1; }

        ctx.save();
        ctx.strokeStyle = this.GRID_COLOR_MINOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        var xs = this.LEFT_MARGIN;
        var xe = (this._cssWidth || 0) - this.RIGHT_PADDING;
        // Top / middle / bottom gridlines.
        ctx.moveTo(xs, top); ctx.lineTo(xe, top);
        ctx.moveTo(xs, (top + bot) / 2); ctx.lineTo(xe, (top + bot) / 2);
        ctx.moveTo(xs, bot); ctx.lineTo(xe, bot);
        ctx.stroke();

        ctx.fillStyle = this.LABEL_COLOR;
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        var lx = this.LEFT_MARGIN - 6;
        // Format: scientific when very small/large, else 2-decimal.
        function fmt(v) {
            var absV = Math.abs(v);
            if (absV > 0 && (absV < 0.01 || absV >= 10000)) return v.toExponential(1);
            return v.toFixed(2);
        }
        ctx.fillText(fmt(yHi), lx, top + 2);
        ctx.fillText(fmt((yLo + yHi) / 2), lx, (top + bot) / 2);
        ctx.fillText(fmt(yLo), lx, bot - 2);
        ctx.restore();
    }

    /**
     * Draw a compact top-right legend for Track Var camera colors.
     * @private
     */
    _drawLegend(ctx, top, rightX, entries) {
        if (!entries || entries.length === 0) return;
        ctx.save();
        ctx.font = '10px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        // Measure widest label first.
        var maxW = 0;
        for (var i = 0; i < entries.length; i++) {
            var w = ctx.measureText(entries[i].label).width;
            if (w > maxW) maxW = w;
        }
        var rowH = 14;
        var boxW = 10 + 6 + maxW + 8;
        var boxH = rowH * entries.length + 6;
        var boxX = rightX - boxW;
        var boxY = top;

        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);

        ctx.textAlign = 'left';
        for (var j = 0; j < entries.length; j++) {
            var cy = boxY + 3 + j * rowH + rowH / 2;
            ctx.fillStyle = entries[j].color;
            ctx.fillRect(boxX + 6, cy - 4, 8, 8);
            ctx.fillStyle = this.LABEL_COLOR;
            ctx.fillText(entries[j].label, boxX + 6 + 10 + 4, cy);
        }
        ctx.restore();
    }

    /**
     * Centered empty-state text (plus optional italic sub-line) inside the
     * graph band. Drawn between range-highlight and playhead layers in the
     * main redraw sequence so the wash doesn't obscure it.
     * @private
     */
    _drawEmptyMessage(ctx, top, bot, W, msg, hint) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        var cx = this.LEFT_MARGIN + (W - this.LEFT_MARGIN - this.RIGHT_PADDING) / 2;
        var cy = (top + bot) / 2;
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText(msg, cx, hint ? cy - 10 : cy);
        if (hint) {
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.font = 'italic 11px system-ui, sans-serif';
            ctx.fillText(hint, cx, cy + 10);
        }
        ctx.restore();
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
}
