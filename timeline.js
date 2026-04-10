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
        this.redraw();
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
     */
    resize() {
        var dpr = window.devicePixelRatio || 1;
        var rect = this._container.getBoundingClientRect();
        var w = Math.round(rect.width);
        // Compute needed height based on track rows + extra gaps between camera groups
        var numRows = this._trackSegments.length;
        var numViewGaps = 0;
        var _prevCamResize = null;
        for (var _ri = 0; _ri < numRows; _ri++) {
            var _thisCam = this._trackSegments[_ri].cameraName;
            if (_prevCamResize != null && _thisCam !== _prevCamResize) numViewGaps++;
            _prevCamResize = _thisCam;
        }
        var neededH = this.TOP_PADDING + (numRows > 0 ? numRows * (this.TRACK_ROW_HEIGHT + this.TRACK_ROW_GAP) + numViewGaps * this.VIEW_GROUP_GAP : 0) + 8 + this.MARKER_AREA_HEIGHT + this.LABEL_AREA_HEIGHT;
        var h = Math.max(Math.round(rect.height), neededH);
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

        // --- Compute layout ---
        const trackAreaTop = this.TOP_PADDING;
        const numTracks = this._trackSegments.length;
        const trackAreaHeight = numTracks > 0
            ? numTracks * this.TRACK_ROW_HEIGHT + (numTracks - 1) * this.TRACK_ROW_GAP
            : 0;
        const separatorY = trackAreaTop + trackAreaHeight + (numTracks > 0 ? 4 : 0);
        const markerAreaTop = separatorY + (numTracks > 0 ? 4 : 0);
        const labelAreaTop = H - this.LABEL_AREA_HEIGHT;

        // --- Grid lines ---
        this._drawGrid(ctx, W, H);

        // --- Track bars ---
        this._drawTrackBars(ctx, trackAreaTop, W);

        // --- Modified frame lines (white, span track + marker areas, on top of track bars) ---
        this._drawModifiedFrameLines(ctx, trackAreaTop, labelAreaTop, W);

        // --- Separator ---
        if (numTracks > 0) {
            ctx.strokeStyle = this.SEPARATOR_COLOR;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(this.LEFT_MARGIN, separatorY);
            ctx.lineTo(W - this.RIGHT_PADDING, separatorY);
            ctx.stroke();
        }

        // --- Frame markers ---
        this._drawFrameMarkers(ctx, markerAreaTop, labelAreaTop, W);

        // --- Frame number labels ---
        this._drawFrameLabels(ctx, labelAreaTop, W);

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
                    var grpId = grps[_gi].identityId >= 0 ? grps[_gi].identityId : 0;
                    if (grpId > maxTrackIdx) maxTrackIdx = grpId;
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

        // --- Build segments from track occupancy (lazy H5 sessions) ---
        // Direct linear scan: O(nFrames * nTracks) per camera, no intermediate Sets.
        // Segments are collected in a per-(track, camera) map so they can be merged
        // with user-instance frames below — otherwise any user instance on a track
        // that also has predicted occupancy would be silently dropped.
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
                        if (occ.data[occFi * occ.nTracks + occTr]) {
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

        // Scan grouped instances (instanceGroups)
        if (session.instanceGroups) {
            for (var [frameIdx, groups] of session.instanceGroups) {
                for (var gi = 0; gi < groups.length; gi++) {
                    var grpTrack = groups[gi].identityId >= 0 ? groups[gi].identityId : 0;
                    for (var [camName] of groups[gi].instances) {
                        var key = grpTrack + ':' + camName;
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
        const lineH = bottom - top;
        if (lineH <= 0) return;

        const pxPerFrame = this._pxPerFrame();
        const startFrame = Math.floor(this._scrollFrame);
        const endFrame = Math.ceil(this._scrollFrame + this._visibleFrames());
        const contentLeft = this.LEFT_MARGIN;
        const contentRight = W - this.RIGHT_PADDING;

        ctx.fillStyle = this.MARKER_MODIFIED_COLOR;

        if (pxPerFrame < 3) {
            // Dense mode: bin into pixel columns
            const contentW = contentRight - contentLeft;
            if (contentW <= 0) return;
            const numBins = Math.ceil(contentW);
            const framesPerBin = this._visibleFrames() / numBins;

            for (let b = 0; b < numBins; b++) {
                const binFrameStart = this._scrollFrame + b * framesPerBin;
                const binFrameEnd = binFrameStart + framesPerBin;
                let hasModified = false;

                for (let f = Math.floor(binFrameStart); f < Math.ceil(binFrameEnd); f++) {
                    const marker = this._frameMarkers.get(f);
                    if (marker && marker.modified) { hasModified = true; break; }
                }

                if (!hasModified) continue;
                const x = contentLeft + b;
                ctx.globalAlpha = 0.7;
                ctx.fillRect(x, top, 1, lineH);
                ctx.globalAlpha = 1.0;
            }
        } else {
            // Sparse mode: individual lines per frame
            const lineW = Math.max(1, Math.min(2, pxPerFrame * 0.3));

            for (let f = startFrame; f <= endFrame; f++) {
                if (f < 0 || f >= this._totalFrames) continue;
                const marker = this._frameMarkers.get(f);
                if (!marker || !marker.modified) continue;

                const x = this._frameToX(f + 0.5);
                if (x < contentLeft || x > contentRight) continue;

                ctx.globalAlpha = 0.85;
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

            if (marker.modified) {
                // Modified frames are drawn as full-height lines by _drawModifiedFrameLines
            } else if (marker.hasUser) {
                // Blue filled dot
                ctx.fillStyle = this.MARKER_USER_COLOR;
                ctx.beginPath();
                ctx.arc(x, cy, dotR, 0, Math.PI * 2);
                ctx.fill();
            } else if (marker.hasPredicted) {
                // Light blue outlined dot
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

        // Bin frames into pixel columns
        const numBins = Math.ceil(contentW);
        const framesPerBin = this._visibleFrames() / numBins;

        for (let b = 0; b < numBins; b++) {
            const binFrameStart = this._scrollFrame + b * framesPerBin;
            const binFrameEnd = binFrameStart + framesPerBin;
            let hasUser = false;
            let hasPredicted = false;
            let hasModified = false;

            for (let f = Math.floor(binFrameStart); f < Math.ceil(binFrameEnd); f++) {
                const marker = this._frameMarkers.get(f);
                if (!marker) continue;
                if (marker.modified) hasModified = true;
                if (marker.hasUser) hasUser = true;
                if (marker.hasPredicted) hasPredicted = true;
            }

            if (!hasUser && !hasPredicted) continue;

            const x = contentLeft + b;
            if (hasUser) {
                ctx.fillStyle = this.MARKER_USER_COLOR;
            } else {
                ctx.fillStyle = this.MARKER_PREDICTED_COLOR;
            }
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

        // Vertical line
        ctx.strokeStyle = this.PLAYHEAD_COLOR;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H - this.LABEL_AREA_HEIGHT);
        ctx.stroke();

        // Triangle at bottom
        const triH = 6;
        const triW = 5;
        const triY = H - this.LABEL_AREA_HEIGHT;
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

        // Middle button or right button -> pan
        if (e.button === 1 || e.button === 2) {
            e.preventDefault();
            this._isPanning = true;
            this._panStartX = e.clientX;
            this._panStartScroll = this._scrollFrame;
            this._canvas.style.cursor = 'grabbing';
            return;
        }

        // Left button
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

        // Normal click -> seek. Snap to the nearest labeled frame if the click
        // is within tolerance of a track bar; otherwise use the raw click frame.
        this._isDragging = true;
        const snapFrame = this._findSnapFrame(x);
        const frame = snapFrame != null
            ? this._clampFrame(snapFrame)
            : this._clampFrame(this._xToFrame(x));
        this._currentFrame = frame;
        this._emitFrameChange(frame);
        this.redraw();
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

        // Scrub drag
        if (this._isDragging) {
            const frame = this._clampFrame(this._xToFrame(x));
            if (frame !== this._currentFrame) {
                this._currentFrame = frame;
                this._emitFrameChange(frame);
                this.redraw();
            }
            return;
        }

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

        this._isDragging = false;
        if (this._onDragEnd) this._onDragEnd(this._currentFrame);
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
     * @param {Session} session
     */
    refreshTracks(session) {
        if (!session) return;
        this._session = session;
        this._rebuildSegments(session);
        this.resize();
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
