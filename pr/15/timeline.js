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

        /** Range selection state */
        this._rangeStart = null;
        this._rangeEnd = null;

        /** Tooltip state */
        this._tooltip = { visible: false, x: 0, y: 0, text: '' };

        // --- Layout constants ------------------------------------------------

        /** @const {number} Height of each track bar row (px) */
        this.TRACK_ROW_HEIGHT = 16;

        /** @const {number} Vertical gap between track rows (px) */
        this.TRACK_ROW_GAP = 2;

        /** @const {number} Height of the frame-marker area (px) */
        this.MARKER_AREA_HEIGHT = 20;

        /** @const {number} Height reserved for the frame-number labels (px) */
        this.LABEL_AREA_HEIGHT = 16;

        /** @const {number} Left margin for track labels */
        this.LEFT_MARGIN = 60;

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
        this.MARKER_MODIFIED_COLOR = '#4ade80';        // green
        this.RANGE_COLOR = 'rgba(99,102,241,0.25)';   // indigo translucent
        this.SEPARATOR_COLOR = 'rgba(255,255,255,0.12)';

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

        this._canvas.addEventListener('mousedown', this._onMouseDown);
        this._canvas.addEventListener('mousemove', this._onMouseMove);
        window.addEventListener('mouseup', this._onMouseUp);
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
        if (!session) {
            this._trackSegments = [];
            this._frameMarkers.clear();
            this._trackNames = [];
            this.redraw();
            return;
        }

        this._trackNames = session.tracks || [];
        this._buildTrackSegments(session);
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
        const dpr = window.devicePixelRatio || 1;
        const rect = this._container.getBoundingClientRect();
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        this._canvas.width = w * dpr;
        this._canvas.height = h * dpr;
        this._canvas.style.width = w + 'px';
        this._canvas.style.height = h + 'px';
        this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._cssWidth = w;
        this._cssHeight = h;
        this._clampScroll();
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
    }

    /**
     * Destroy the timeline: remove event listeners, observer, and DOM elements.
     */
    destroy() {
        this._canvas.removeEventListener('mousedown', this._onMouseDown);
        this._canvas.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mouseup', this._onMouseUp);
        this._canvas.removeEventListener('wheel', this._onWheel);
        this._canvas.removeEventListener('touchstart', this._onTouchStart);
        this._canvas.removeEventListener('touchmove', this._onTouchMove);
        this._canvas.removeEventListener('touchend', this._onTouchEnd);
        this._canvas.removeEventListener('contextmenu', this._onContextMenu);
        this._resizeObserver.disconnect();
        this._container.removeChild(this._canvas);
        this._container.removeChild(this._tooltipEl);
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
        const numTracks = session.tracks ? session.tracks.length : 0;
        this._trackSegments = [];

        for (let t = 0; t < numTracks; t++) {
            /** @type {Set<number>} */
            const presentFrames = new Set();

            // Scan all frame groups for instances belonging to this track
            for (const [frameIdx, fg] of session.frameGroups) {
                // fg.instances is a Map<cameraName, Instance[]>
                for (const [_camName, instances] of fg.instances) {
                    for (let i = 0; i < instances.length; i++) {
                        if (instances[i].trackIdx === t) {
                            presentFrames.add(frameIdx);
                            break; // one hit per camera is enough
                        }
                    }
                }
            }

            // Convert the set of frame indices into sorted contiguous segments
            const sorted = Array.from(presentFrames).sort((a, b) => a - b);
            const segments = [];
            let segStart = -1;
            let segEnd = -1;

            for (let i = 0; i < sorted.length; i++) {
                const f = sorted[i];
                if (segStart < 0) {
                    segStart = f;
                    segEnd = f;
                } else if (f === segEnd + 1) {
                    segEnd = f;
                } else {
                    segments.push({ start: segStart, end: segEnd });
                    segStart = f;
                    segEnd = f;
                }
            }
            if (segStart >= 0) {
                segments.push({ start: segStart, end: segEnd });
            }

            this._trackSegments.push({
                trackIdx: t,
                color: typeof getTrackColor === 'function' ? getTrackColor(t) : '#667eea',
                segments: segments,
            });
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

        for (let t = 0; t < this._trackSegments.length; t++) {
            const track = this._trackSegments[t];
            const rowY = top + t * (this.TRACK_ROW_HEIGHT + this.TRACK_ROW_GAP);

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
                const seg = track.segments[s];
                const x0 = Math.max(this._frameToX(seg.start), this.LEFT_MARGIN);
                // +1 so the bar covers the full frame width for the end frame
                const x1 = Math.min(this._frameToX(seg.end + 1), W - this.RIGHT_PADDING);
                if (x1 <= x0) continue;

                ctx.globalAlpha = 0.7;
                ctx.fillRect(x0, rowY, x1 - x0, this.TRACK_ROW_HEIGHT);
                ctx.globalAlpha = 1.0;
            }
        }

        // Reset text alignment
        ctx.textAlign = 'left';
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
                // Green filled dot
                ctx.fillStyle = this.MARKER_MODIFIED_COLOR;
                ctx.beginPath();
                ctx.arc(x, cy, dotR, 0, Math.PI * 2);
                ctx.fill();
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

            if (!hasUser && !hasPredicted && !hasModified) continue;

            const x = contentLeft + b;
            if (hasModified) {
                ctx.fillStyle = this.MARKER_MODIFIED_COLOR;
            } else if (hasUser) {
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
            ctx.fillText(String(f), x, top + 2);
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
        const rect = this._canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Middle button -> pan
        if (e.button === 1) {
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

        // Normal click -> seek
        this._isDragging = true;
        const frame = this._clampFrame(this._xToFrame(x));
        this._currentFrame = frame;
        this._emitFrameChange(frame);
        this.redraw();
    }

    /**
     * @param {MouseEvent} e
     * @private
     */
    _handleMouseMove(e) {
        const rect = this._canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

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
            let text = 'Frame ' + frame;
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
     * @param {MouseEvent} e
     * @private
     */
    _handleMouseUp(e) {
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
    }

    /**
     * Zoom with mouse wheel centered on the cursor position.
     * @param {WheelEvent} e
     * @private
     */
    _handleWheel(e) {
        e.preventDefault();

        const rect = this._canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;

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
     * Clear the current range selection.
     */
    clearRangeSelection() {
        this._rangeStart = null;
        this._rangeEnd = null;
        this.redraw();
    }
}
