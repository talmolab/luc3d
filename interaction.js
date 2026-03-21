/**
 * interaction.js - Mouse and keyboard interaction system for the multi-view
 * pose proofreading GUI.
 *
 * Handles node selection, dragging, instance conversion, and all user
 * interaction with the overlay canvases. Works with the data model classes
 * from pose-data.js (Skeleton, Camera, Instance, FrameGroup, InstanceGroup,
 * Session).
 *
 * All coordinates are kept in video pixel space for data consistency. The
 * overlay canvases have the same dimensions as the video, so the default
 * coordinate transform is 1:1 unless zoom/pan is applied via CSS transforms.
 *
 * No imports/exports - follows the vibes pattern of global scope scripts
 * loaded via script tags.
 */

// ============================================
// InteractionManager
// ============================================

class InteractionManager {
    /**
     * @param {Object} callbacks - Functions the interaction manager uses to
     *   communicate with the rest of the application.
     * @param {Function} callbacks.getState - Returns the current application
     *   state object. Expected shape:
     *   {
     *     currentFrame: number,
     *     session: Session,
     *     views: Array<{ name, overlayCanvas, videoWidth, videoHeight, zoom? }>,
     *   }
     * @param {Function} callbacks.getInstanceGroups - (frameIdx) => InstanceGroup[]
     *   Returns all instance groups for the given frame index.
     * @param {Function} callbacks.onSelectionChanged - (selectedInstanceGroup, selectedNodeIdx) => void
     *   Called whenever the selection state changes.
     * @param {Function} callbacks.onNodeMoved - (viewName, instanceGroup, nodeIdx, newPos) => void
     *   Called when a node drag operation completes. newPos is [u, v] in video coords.
     * @param {Function} callbacks.onInstanceConverted - (instanceGroup) => void
     *   Called after a predicted instance is converted to a user instance
     *   (double-click interaction).
     * @param {Function} callbacks.onNodeSetNull - (viewName, instanceGroup, nodeIdx) => void  (toggle null state)
     *   Called after a right-click toggles a node's visibility.
     * @param {Function} callbacks.requestRedraw - () => void
     *   Triggers a full overlay redraw across all views.
     */
    constructor(callbacks) {
        /** @type {Object} */
        this.callbacks = callbacks || {};

        // ------------------------------------------------------------------
        // Selection state
        // ------------------------------------------------------------------

        /** @type {InstanceGroup|null} Currently selected instance group */
        this.selectedInstanceGroup = null;

        /** @type {number} Currently selected node index (-1 = no node selected) */
        this.selectedNodeIdx = -1;

        /**
         * Node currently under the cursor, or null.
         * @type {{ viewName: string, instanceGroupIdx: number, nodeIdx: number }|null}
         */
        this.hoveredNode = null;

        // ------------------------------------------------------------------
        // Drag state
        // ------------------------------------------------------------------

        /** @type {boolean} Whether a drag is in progress */
        this.isDragging = false;

        /**
         * Details of the active drag, or null.
         * @type {{
         *   mode: 'node'|'instance',
         *   viewName: string,
         *   instanceGroupIdx: number,
         *   nodeIdx: number,
         *   startPos: number[],
         *   currentPos: number[],
         *   originalPoints: (number[]|null)[]|null
         * }|null}
         */
        this.dragInfo = null;

        // ------------------------------------------------------------------
        // Assignment mode state
        // ------------------------------------------------------------------

        /** @type {boolean} Whether assignment mode is active */
        this.assignmentMode = false;

        /** @type {UnlinkedInstance[]} Currently selected unlinked instances for assignment */
        this.assignmentSelection = [];

        /** @type {UnlinkedInstance|null} Currently selected unlinked instance (for editing/deletion) */
        this.selectedUnlinked = null;

        // ------------------------------------------------------------------
        // Hit-test configuration
        // ------------------------------------------------------------------

        /** @type {number} Maximum distance in video pixels for a hit-test match */
        this.hitThreshold = 12;

        // ------------------------------------------------------------------
        // Internal bookkeeping for attach/detach
        // ------------------------------------------------------------------

        /** @type {string|null} Last view where user interacted (for per-camera delete) */
        this.lastInteractedView = null;

        /** @type {number} Last active track index, used when creating new instances */
        this.lastActiveTrackIdx = 0;

        /** @type {Map<string, Object>} viewName -> { handlers } */
        this._boundHandlers = new Map();

        /** @type {Function|null} Bound keydown handler (document-level) */
        this._keyHandler = null;
    }

    // ======================================================================
    // Coordinate transforms
    // ======================================================================

    /**
     * Convert mouse coordinates to video pixel coordinates.
     *
     * Uses clientX/clientY with getBoundingClientRect() which correctly
     * accounts for CSS transforms (zoom/pan). The bounding rect reflects
     * the actual on-screen position after all transforms, so dividing by
     * rect dimensions gives the correct mapping regardless of zoom state.
     *
     * @param {number} clientX - event.clientX (viewport coordinate)
     * @param {number} clientY - event.clientY (viewport coordinate)
     * @param {string} viewName - Camera view name (e.g. 'back')
     * @returns {number[]} [videoX, videoY] in video pixel coordinates
     */
    canvasToVideo(clientX, clientY, viewName) {
        const state = this._getState();
        if (!state) return [clientX, clientY];

        const view = this._findView(state, viewName);
        if (!view) return [clientX, clientY];

        const canvas = view.overlayCanvas;
        if (!canvas) return [clientX, clientY];

        // getBoundingClientRect() includes CSS transforms (zoom/pan),
        // so the position and size reflect what's actually on screen.
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return [clientX, clientY];

        // Position within the displayed (transformed) canvas
        const displayX = clientX - rect.left;
        const displayY = clientY - rect.top;

        // Convert from display pixels to video pixels.
        // Use view.videoWidth rather than canvas.width so that the mapping
        // is correct even when the overlay canvas internal resolution differs
        // from the video resolution (e.g. when scaled up for zoom).
        const videoX = displayX * ((view.videoWidth || canvas.width) / rect.width);
        const videoY = displayY * ((view.videoHeight || canvas.height) / rect.height);
        return [videoX, videoY];
    }

    // ======================================================================
    // Hit testing
    // ======================================================================

    /**
     * Compute the shortest distance from point (px, py) to a line segment
     * defined by endpoints (ax, ay) and (bx, by).
     * @returns {number} Distance in the same coordinate space.
     */
    _pointToSegmentDist(px, py, ax, ay, bx, by) {
        const dx = bx - ax;
        const dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));
        // Project point onto segment, clamped to [0,1]
        var t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        const projX = ax + t * dx;
        const projY = ay + t * dy;
        return Math.sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY));
    }

    /**
     * Find the nearest visible node or edge to the given video-space position
     * in a specific camera view at a given frame.
     *
     * Hit testing checks nodes first (using visual node size as threshold),
     * then skeleton edges (using edge weight as threshold). Clicking empty
     * space between nodes/edges returns null.
     *
     * @param {number} videoX - X coordinate in video pixels
     * @param {number} videoY - Y coordinate in video pixels
     * @param {string} viewName - Camera view name
     * @param {number} frameIdx - Frame index
     * @returns {{
     *   instanceGroupIdx: number,
     *   instanceGroup: InstanceGroup,
     *   instanceIdx: number,
     *   nodeIdx: number,
     *   distance: number,
     * }|null} The nearest hit, or null if nothing is within threshold.
     */
    findNearestNode(videoX, videoY, viewName, frameIdx, options) {
        const groups = this._getInstanceGroups(frameIdx);
        if (!groups || groups.length === 0) return null;

        // Compute a display-to-video scale factor so thresholds feel consistent
        // regardless of display size and zoom level.
        let displayToVideo = 1;
        const state = this._getState();
        if (state) {
            const view = this._findView(state, viewName);
            if (view && view.overlayCanvas) {
                const rect = view.overlayCanvas.getBoundingClientRect();
                if (rect.width > 0) {
                    displayToVideo = (view.videoWidth || view.overlayCanvas.width) / rect.width;
                }
            }
        }

        // Node threshold = visual node size (video px) + screen-space padding (4 CSS px → video px)
        const sliderEl = document.getElementById('visUserNodeSize');
        const nodeSize = sliderEl ? parseInt(sliderEl.value) || 4 : 4;
        const nodeThreshold = this.hitThreshold || (nodeSize + 4 * displayToVideo);

        // Edge threshold = edge weight (video px) + screen-space padding (4 CSS px → video px)
        const edgeSliderEl = document.getElementById('visUserEdgeWeight');
        const edgeWeight = edgeSliderEl ? parseInt(edgeSliderEl.value) || 2 : 2;
        const edgeThreshold = edgeWeight + 4 * displayToVideo;

        // Get skeleton edges and node names for hit testing
        const skeleton = (state && state.session) ? state.session.skeleton : null;
        const edges = skeleton ? skeleton.edges : null;
        const nodeNames = skeleton ? skeleton.nodes : null;

        // Label threshold: approximate label area in video pixels
        const labelSliderEl = document.getElementById('visUserLabelSize');
        const labelSize = labelSliderEl ? parseInt(labelSliderEl.value) || 11 : 11;
        const labelThreshold = labelSize * displayToVideo * 1.5;

        let best = null;
        let bestDist = Infinity;

        // Two-pass hit testing: user instances first (front), then predicted/reprojected (back)
        const typePassFilters = [
            function(t) { return t !== 'predicted' && t !== 'reprojected'; },
            function(t) { return t === 'predicted' || t === 'reprojected'; },
        ];

        for (let pass = 0; pass < typePassFilters.length; pass++) {
            for (let g = 0; g < groups.length; g++) {
                const group = groups[g];

                // Collect candidate instances: regular + reprojected
                var candidates = [];
                var regInst = group.getInstance(viewName);
                if (regInst && regInst.points) candidates.push(regInst);
                var reprojInst = group.getReprojectedInstance ? group.getReprojectedInstance(viewName) : null;
                if (reprojInst && reprojInst.points) candidates.push(reprojInst);

                for (let ci = 0; ci < candidates.length; ci++) {
                    var instance = candidates[ci];

                    // Skip instances whose type is hidden via visibility checkboxes
                    var instType = instance.type || 'user';
                    var _visEl;
                    if (instType === 'user') { _visEl = document.getElementById('visUser'); if (_visEl && !_visEl.checked) continue; }
                    if (instType === 'predicted') { _visEl = document.getElementById('visPredicted'); if (_visEl && !_visEl.checked) continue; }
                    if (instType === 'reprojected') { _visEl = document.getElementById('visReprojections'); if (_visEl && !_visEl.checked) continue; }

                    // Skip instances not matching this pass's type filter
                    if (!typePassFilters[pass](instType)) continue;

                    // --- Node hit testing ---
                    for (let n = 0; n < instance.points.length; n++) {
                        const pt = instance.points[n];
                        if (pt == null) continue;

                        const dx = pt[0] - videoX;
                        const dy = pt[1] - videoY;
                        const dist = Math.sqrt(dx * dx + dy * dy);

                        if (dist < nodeThreshold && dist < bestDist) {
                            bestDist = dist;
                            best = {
                                instanceGroupIdx: g,
                                instanceGroup: group,
                                instanceIdx: g,
                                nodeIdx: n,
                                distance: dist,
                                isReprojected: instType === 'reprojected',
                            };
                        }
                    }

                    // --- Edge hit testing (only if no node was hit for this instance) ---
                    // When an edge is hit, snap to the nearest endpoint so drags
                    // always target a real node (nodeIdx -1 was a no-op).
                    if (edges && !best) {
                        for (let ei = 0; ei < edges.length; ei++) {
                            const edge = edges[ei];
                            const ptA = instance.points[edge[0]];
                            const ptB = instance.points[edge[1]];
                            if (ptA == null || ptB == null) continue;

                            const edgeDist = this._pointToSegmentDist(
                                videoX, videoY, ptA[0], ptA[1], ptB[0], ptB[1]);

                            if (edgeDist < edgeThreshold && edgeDist < bestDist) {
                                bestDist = edgeDist;
                                // Pick the closer endpoint as the target node
                                var dA = Math.hypot(ptA[0] - videoX, ptA[1] - videoY);
                                var dB = Math.hypot(ptB[0] - videoX, ptB[1] - videoY);
                                best = {
                                    instanceGroupIdx: g,
                                    instanceGroup: group,
                                    instanceIdx: g,
                                    nodeIdx: dA <= dB ? edge[0] : edge[1],
                                    distance: edgeDist,
                                    isReprojected: instType === 'reprojected',
                                };
                            }
                        }
                    }

                    // --- Label hit testing (only if no node or edge was hit) ---
                    // Clicking a node's label text grabs that node for dragging.
                    if (!best && nodeNames && !(options && options.skipLabels)) {
                        for (let n = 0; n < instance.points.length; n++) {
                            const pt = instance.points[n];
                            if (pt == null) continue;
                            var name = typeof nodeNames[n] === 'string' ? nodeNames[n] : (nodeNames[n] && nodeNames[n].name ? nodeNames[n].name : null);
                            if (!name) continue;
                            // Estimate label bounds: label is drawn offset from node,
                            // roughly within labelThreshold distance
                            var ldist = Math.hypot(pt[0] - videoX, pt[1] - videoY);
                            if (ldist < labelThreshold && ldist < bestDist) {
                                bestDist = ldist;
                                best = {
                                    instanceGroupIdx: g,
                                    instanceGroup: group,
                                    instanceIdx: g,
                                    nodeIdx: n,
                                    distance: ldist,
                                    isReprojected: instType === 'reprojected',
                                };
                            }
                        }
                    }
                }
            }
            // If we found a hit in the user pass, return immediately
            if (best) return best;
        }

        return best;
    }

    /**
     * Find the nearest unlinked instance node to the given video-space position.
     *
     * @param {number} videoX
     * @param {number} videoY
     * @param {string} viewName
     * @param {number} frameIdx
     * @returns {{ unlinked: UnlinkedInstance, nodeIdx: number, distance: number }|null}
     */
    findNearestUnlinkedNode(videoX, videoY, viewName, frameIdx, options) {
        const state = this._getState();
        if (!state || !state.session) return null;

        const fg = state.session.getFrameGroup(frameIdx);
        if (!fg) return null;

        const unlinkedList = fg.getUnlinkedInstances(viewName);
        if (!unlinkedList || unlinkedList.length === 0) return null;

        // Compute display-to-video scale factor
        let displayToVideo = 1;
        const view = this._findView(state, viewName);
        if (view && view.overlayCanvas) {
            const rect = view.overlayCanvas.getBoundingClientRect();
            if (rect.width > 0) {
                displayToVideo = (view.videoWidth || view.overlayCanvas.width) / rect.width;
            }
        }

        // Node threshold = visual node size (video px) + screen-space padding (4 CSS px → video px)
        const sliderEl = document.getElementById('visUserNodeSize');
        const nodeSize = sliderEl ? parseInt(sliderEl.value) || 4 : 4;
        const nodeThreshold = this.hitThreshold || (nodeSize + 4 * displayToVideo);

        // Edge threshold = edge weight (video px) + screen-space padding (4 CSS px → video px)
        const edgeSliderEl = document.getElementById('visUserEdgeWeight');
        const edgeWeight = edgeSliderEl ? parseInt(edgeSliderEl.value) || 2 : 2;
        const edgeThreshold = edgeWeight + 4 * displayToVideo;

        // Get skeleton edges and node names for hit testing
        const skeleton = state.session.skeleton;
        const edges = skeleton ? skeleton.edges : null;
        const nodeNames = skeleton ? skeleton.nodes : null;

        // Label threshold
        const labelSliderEl2 = document.getElementById('visUserLabelSize');
        const labelSize2 = labelSliderEl2 ? parseInt(labelSliderEl2.value) || 11 : 11;
        const labelThreshold2 = labelSize2 * displayToVideo * 1.5;

        let best = null;
        let bestDist = Infinity;

        // Two-pass hit testing: user instances first (front), then predicted (back)
        const ulTypePassFilters = [
            function(t) { return t !== 'predicted'; },
            function(t) { return t === 'predicted'; },
        ];

        for (let pass = 0; pass < ulTypePassFilters.length; pass++) {
            for (let u = 0; u < unlinkedList.length; u++) {
                const ul = unlinkedList[u];
                const points = ul.instance.points;
                if (!points) continue;

                var ulType = ul.instance.type || 'user';
                var _visEl2;
                if (ulType === 'user') { _visEl2 = document.getElementById('visUser'); if (_visEl2 && !_visEl2.checked) continue; }
                if (ulType === 'predicted') { _visEl2 = document.getElementById('visPredicted'); if (_visEl2 && !_visEl2.checked) continue; }

                if (!ulTypePassFilters[pass](ulType)) continue;

                // --- Node hit testing ---
                for (let n = 0; n < points.length; n++) {
                    const pt = points[n];
                    if (pt == null) continue;

                    const dx = pt[0] - videoX;
                    const dy = pt[1] - videoY;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < nodeThreshold && dist < bestDist) {
                        bestDist = dist;
                        best = {
                            unlinked: ul,
                            nodeIdx: n,
                            distance: dist,
                        };
                    }
                }

                // --- Edge hit testing (only if no node was hit for this instance) ---
                // Snap to nearest endpoint so drags target a real node.
                if (edges && !best) {
                    for (let ei = 0; ei < edges.length; ei++) {
                        const edge = edges[ei];
                        const ptA = points[edge[0]];
                        const ptB = points[edge[1]];
                        if (ptA == null || ptB == null) continue;

                        const edgeDist = this._pointToSegmentDist(
                            videoX, videoY, ptA[0], ptA[1], ptB[0], ptB[1]);

                        if (edgeDist < edgeThreshold && edgeDist < bestDist) {
                            bestDist = edgeDist;
                            var dA2 = Math.hypot(ptA[0] - videoX, ptA[1] - videoY);
                            var dB2 = Math.hypot(ptB[0] - videoX, ptB[1] - videoY);
                            best = {
                                unlinked: ul,
                                nodeIdx: dA2 <= dB2 ? edge[0] : edge[1],
                                distance: edgeDist,
                            };
                        }
                    }
                }

                // --- Label hit testing (only if no node or edge was hit) ---
                if (!best && nodeNames && !(options && options.skipLabels)) {
                    for (let n = 0; n < points.length; n++) {
                        const pt = points[n];
                        if (pt == null) continue;
                        var ldist = Math.hypot(pt[0] - videoX, pt[1] - videoY);
                        if (ldist < labelThreshold2 && ldist < bestDist) {
                            bestDist = ldist;
                            best = { unlinked: ul, nodeIdx: n, distance: ldist };
                        }
                    }
                }
            }
            if (best) return best;
        }

        return best;
    }

    // ======================================================================
    // Assignment mode
    // ======================================================================

    /**
     * Toggle assignment mode on/off.
     * @param {boolean} [enabled] - Force on/off; omit to toggle
     */
    setAssignmentMode(enabled) {
        if (enabled === undefined) enabled = !this.assignmentMode;
        this.assignmentMode = enabled;
        if (!enabled) {
            this.assignmentSelection = [];
        }
        this._requestRedraw();
    }

    /**
     * Add an unlinked instance to the assignment selection.
     * Only allows one selection per camera view.
     * @param {UnlinkedInstance} unlinked
     */
    addToAssignmentSelection(unlinked) {
        // Check if we already have one from this camera — replace or toggle
        for (let i = 0; i < this.assignmentSelection.length; i++) {
            if (this.assignmentSelection[i].cameraName === unlinked.cameraName) {
                if (this.assignmentSelection[i].id === unlinked.id) {
                    // Toggle off: clicking the same instance removes it
                    this.assignmentSelection.splice(i, 1);
                    this._requestRedraw();
                    if (this.callbacks.onAssignmentSelectionChanged) {
                        this.callbacks.onAssignmentSelectionChanged(this.assignmentSelection.length);
                    }
                    return;
                }
                // Different instance from same camera — replace (only one per camera)
                this.assignmentSelection.splice(i, 1, unlinked);
                this._requestRedraw();
                if (this.callbacks.onAssignmentSelectionChanged) {
                    this.callbacks.onAssignmentSelectionChanged(this.assignmentSelection.length);
                }
                return;
            }
        }
        this.assignmentSelection.push(unlinked);
        this._requestRedraw();
        if (this.callbacks.onAssignmentSelectionChanged) {
            this.callbacks.onAssignmentSelectionChanged(this.assignmentSelection.length);
        }
    }

    /**
     * Get the IDs of currently selected unlinked instances for assignment.
     * @returns {number[]}
     */
    getAssignmentSelectedIds() {
        return this.assignmentSelection.map(function (ul) { return ul.id; });
    }

    // ======================================================================
    // Selection
    // ======================================================================

    /**
     * Select an instance group and optionally a specific node.
     *
     * @param {InstanceGroup|null} instanceGroup - The group to select, or
     *   null to clear.
     * @param {number} [nodeIdx=-1] - Node index to select, or -1 for none.
     */
    select(instanceGroup, nodeIdx) {
        if (nodeIdx === undefined) nodeIdx = -1;

        const changed = (
            this.selectedInstanceGroup !== instanceGroup ||
            this.selectedNodeIdx !== nodeIdx
        );

        this.selectedInstanceGroup = instanceGroup;
        this.selectedNodeIdx = nodeIdx;

        if (instanceGroup && instanceGroup.trackIdx !== undefined) {
            this.lastActiveTrackIdx = instanceGroup.trackIdx;
        }

        if (changed && this.callbacks.onSelectionChanged) {
            this.callbacks.onSelectionChanged(this.selectedInstanceGroup, this.selectedNodeIdx);
        }
    }

    /**
     * Clear the current selection entirely (linked and unlinked).
     */
    clearSelection() {
        this.select(null, -1);
        this.selectedUnlinked = null;
    }

    // ======================================================================
    // Mouse event handlers
    // ======================================================================

    /**
     * Handle mousedown on an overlay canvas.
     *
     * - Left click on node: select the instance group + node, begin drag.
     * - Left click on empty area: clear selection.
     * - Double-click on a predicted instance: convert to user instance.
     * - Right-click on a node: toggle node visibility (null <-> restore).
     *
     * @param {MouseEvent} e
     * @param {string} viewName
     */
    onMouseDown(e, viewName) {
        var state = this._getState();
        if (!state) return;

        this.lastInteractedView = viewName;

        // Guard: clean up any stale drag state from a missed mouseup
        if (this.isDragging) {
            this._endDrag();
        }

        var coords = this.canvasToVideo(e.clientX, e.clientY, viewName);
        var vx = coords[0], vy = coords[1];
        var frameIdx = state.currentFrame;

        // Pre-check: if a node/edge is near the click, block zoom immediately
        // so the zoom handler never starts a box-zoom on node interactions.
        // Skip label hits here — their large threshold causes false positives.
        if (e.button === 0) {
            var preHit = this.findNearestNode(vx, vy, viewName, frameIdx, { skipLabels: true });
            var preUlHit = this.findNearestUnlinkedNode(vx, vy, viewName, frameIdx, { skipLabels: true });
            if (preHit || preUlHit) {
                window.__mvguiDragging = true;
            }
        }

        // --- Right-click / Ctrl+click (macOS trackpad): toggle node null ---
        if (e.button === 2 || (e.button === 0 && e.ctrlKey)) {
            e.preventDefault();
            if (this.assignmentMode) return;

            // Check both linked (InstanceGroup) and unlinked instances
            var hit = this.findNearestNode(vx, vy, viewName, frameIdx);
            var ulHit = this.findNearestUnlinkedNode(vx, vy, viewName, frameIdx);

            // Prefer whichever is closer
            if (hit && ulHit) {
                if (ulHit.distance < hit.distance) hit = null;
                else ulHit = null;
            }

            if (hit) {
                // Block null toggle for predicted instances
                var hitInstance = hit.instanceGroup.getInstance(viewName);
                if (hitInstance && hitInstance.type === 'predicted') return;
                // Select the group and toggle null in one action
                this.select(hit.instanceGroup, hit.nodeIdx);
                this._toggleNodeNull(viewName, hit.instanceGroup, hit.nodeIdx);
            } else if (ulHit) {
                var ulInst = ulHit.unlinked.instance;
                if (ulInst && ulInst.type === 'predicted') return;
                // Toggle null directly on the unlinked instance
                if (!ulInst.nulledNodes) ulInst.nulledNodes = new Set();
                if (ulInst.nulledNodes.has(ulHit.nodeIdx)) {
                    ulInst.nulledNodes.delete(ulHit.nodeIdx);
                } else {
                    ulInst.nulledNodes.add(ulHit.nodeIdx);
                }
                this._requestRedraw();
            }
            return;
        }

        // --- Left click only ---
        if (e.button !== 0) return;

        // --- Find the closest node (linked or unlinked) ---
        var linkedHit = this.findNearestNode(vx, vy, viewName, frameIdx);
        var ulHit = this.findNearestUnlinkedNode(vx, vy, viewName, frameIdx);

        var useLinked = false;
        var useUnlinked = false;
        if (linkedHit && ulHit) {
            // In assignment mode, prefer unlinked targets so clicks always
            // add to the assignment selection instead of exiting the mode.
            if (this.assignmentMode) {
                useUnlinked = true;
            } else {
                useLinked = linkedHit.distance <= ulHit.distance;
                useUnlinked = !useLinked;
            }
        } else if (linkedHit) {
            useLinked = true;
        } else if (ulHit) {
            useUnlinked = true;
        }

        // --- In assignment mode, ignore linked node clicks entirely ---
        if (this.assignmentMode && useLinked && !useUnlinked) {
            e.preventDefault();
            e.stopPropagation();
            e._consumedByInteraction = true;
            return;
        }

        // --- Double-click on linked predicted instance: clone as user group ---
        if (e.detail >= 2 && useLinked) {
            var firstGroupInst = linkedHit.instanceGroup.instances.values().next().value;
            if (firstGroupInst && firstGroupInst.type === 'predicted') {
                // Clone predicted group as a new user group, keeping original intact
                if (this.callbacks.onClonePredictedGroup) {
                    this.callbacks.onClonePredictedGroup(linkedHit.instanceGroup);
                }
                this._requestRedraw();
                e.preventDefault();
                e.stopPropagation();
                e._consumedByInteraction = true;
                return;
            }
        }

        // --- Double-click on reprojected instance: add user instance to existing group ---
        if (e.detail >= 2 && useLinked && linkedHit.isReprojected) {
            if (this.callbacks.onConvertReprojection) {
                this.callbacks.onConvertReprojection(linkedHit.instanceGroup, viewName);
            }
            this._requestRedraw();
            e.preventDefault();
            e.stopPropagation();
            e._consumedByInteraction = true;
            return;
        }

        // --- Linked node: select or drag ---
        if (useLinked) {
            this.selectedUnlinked = null;
            // Exit assignment mode if active
            if (this.assignmentMode) {
                this.assignmentSelection = [];
                this.setAssignmentMode(false);
                if (this.callbacks.onAssignmentCancelled) {
                    this.callbacks.onAssignmentCancelled();
                }
            }
            var hitInst = linkedHit.instanceGroup.getInstance(viewName);
            var hitReprojInst = linkedHit.isReprojected;

            // Predicted/reprojected: select only (double-click to convert)
            if (hitReprojInst || (hitInst && (hitInst.type === 'predicted' || hitInst.type === 'reprojected'))) {
                this.select(linkedHit.instanceGroup, linkedHit.nodeIdx);
                this._requestRedraw();
                e.preventDefault();
                e.stopPropagation();
                e._consumedByInteraction = true;
            } else {
                // User nodes: select and start drag immediately
                this.select(linkedHit.instanceGroup, linkedHit.nodeIdx);
                this._startDrag(viewName, linkedHit.instanceGroupIdx, linkedHit.nodeIdx,
                    vx, vy, null, e.altKey ? linkedHit.instanceGroup.getInstance(viewName) : null,
                    e.clientX, e.clientY);
                e.preventDefault();
                e.stopPropagation();
                e._consumedByInteraction = true;
            }

        // --- Unlinked node: double-click predicted → convert all same-track predictions across views ---
        } else if (useUnlinked && e.detail >= 2 && ulHit.unlinked.instance && ulHit.unlinked.instance.type === 'predicted') {
            if (this.callbacks.onConvertUnlinkedPredictions) {
                this.callbacks.onConvertUnlinkedPredictions(ulHit.unlinked);
            }
            e.preventDefault();
            e.stopPropagation();
            e._consumedByInteraction = true;
            this._requestRedraw();

        // --- Unlinked node: auto-enter assignment mode and select ---
        } else if (useUnlinked) {
            this.select(null, -1);
            this.selectedUnlinked = ulHit.unlinked;
            // Auto-enter assignment mode and add to selection
            if (!this.assignmentMode) {
                this.assignmentMode = true;
                this.assignmentSelection = [];
            }
            this.addToAssignmentSelection(ulHit.unlinked);
            // Always allow drag for repositioning
            this._startDrag(viewName, -1, ulHit.nodeIdx,
                vx, vy, ulHit.unlinked, e.altKey ? ulHit.unlinked : null,
                e.clientX, e.clientY);
            e.preventDefault();
            e.stopPropagation();
            e._consumedByInteraction = true;

        // --- Clicked empty space: clear selection and exit assignment mode ---
        } else {
            if (this.assignmentMode) {
                this.assignmentSelection = [];
                this.setAssignmentMode(false);
                if (this.callbacks.onAssignmentCancelled) {
                    this.callbacks.onAssignmentCancelled();
                }
            }
            this.clearSelection();
        }

        this._requestRedraw();
    }

    /**
     * Handle mousemove on an overlay canvas (hover tracking only).
     * During active drags, movement is handled by _onDragMove at the
     * document level instead.
     *
     * @param {MouseEvent} e
     * @param {string} viewName
     */
    onMouseMove(e, viewName) {
        // During drags, movement is handled by document-level _onDragMove
        if (this.isDragging && this.dragInfo) {
            return;
        }

        var state = this._getState();
        if (!state) return;

        var coords = this.canvasToVideo(e.clientX, e.clientY, viewName);
        var vx = coords[0], vy = coords[1];

        // Update hover state
        var frameIdx = state.currentFrame;
        var hit = this.findNearestNode(vx, vy, viewName, frameIdx);

        var prevHover = this.hoveredNode;
        if (hit) {
            this.hoveredNode = {
                viewName: viewName,
                instanceGroupIdx: hit.instanceGroupIdx,
                nodeIdx: hit.nodeIdx,
            };
        } else {
            this.hoveredNode = null;
        }

        // Also check unlinked instances for cursor feedback
        var hoverUnlinked = false;
        if (!this.hoveredNode) {
            var ulHit = this.findNearestUnlinkedNode(vx, vy, viewName, frameIdx);
            if (ulHit) hoverUnlinked = true;
        }

        // Update cursor style on the overlay canvas
        var view = this._findView(state, viewName);
        if (view && view.overlayCanvas) {
            if ((this.hoveredNode || hoverUnlinked) && e.altKey) {
                view.overlayCanvas.style.cursor = 'move';
            } else {
                view.overlayCanvas.style.cursor = (this.hoveredNode || hoverUnlinked) ? 'pointer' : 'default';
            }
        }

        // Redraw if hover state changed (for highlight rendering)
        var hoverChanged = !this._hoveredNodesEqual(prevHover, this.hoveredNode);
        if (hoverChanged) {
            this._requestRedraw();
        }
    }

    /**
     * Handle mouseup on an overlay canvas.
     *
     * If a drag was in progress: finalize the node position, mark the
     * instance as modified, and invoke the onNodeMoved callback so the
     * application can re-triangulate.
     *
     * @param {MouseEvent} e
     * @param {string} viewName
     */
    onMouseUp(e, viewName) {
        if (!this.isDragging || !this.dragInfo) return;

        const state = this._getState();
        if (!state) {
            this._endDrag();
            return;
        }

        const info = this.dragInfo;

        // Only finalize if the drag actually moved
        const dx = info.currentPos[0] - info.startPos[0];
        const dy = info.currentPos[1] - info.startPos[1];
        const didMove = info.thresholdMet && Math.sqrt(dx * dx + dy * dy) > 0.5;

        if (didMove) {
            // Determine the instance being dragged (linked or unlinked)
            let instance = null;
            let group = null;
            if (info.unlinked) {
                instance = info.unlinked.instance;
            } else {
                const groups = this._getInstanceGroups(state.currentFrame);
                if (groups && groups.length > info.instanceGroupIdx) {
                    group = groups[info.instanceGroupIdx];
                    instance = group.getInstance(info.viewName);
                }
            }

            if (instance && instance.points) {
                if (info.mode === 'instance' && info.originalPoints) {
                    // Whole-instance drag: finalize all translated points
                    const fdx = info.currentPos[0] - info.startPos[0];
                    const fdy = info.currentPos[1] - info.startPos[1];
                    for (var fi = 0; fi < instance.points.length; fi++) {
                        if (info.originalPoints[fi]) {
                            instance.points[fi] = [
                                info.originalPoints[fi][0] + fdx,
                                info.originalPoints[fi][1] + fdy
                            ];
                        }
                    }
                    instance.type = 'user';
                } else if (instance.points.length > info.nodeIdx) {
                    // Single-node drag: finalize the single point
                    instance.points[info.nodeIdx] = [info.currentPos[0], info.currentPos[1]];
                    instance.type = 'user';
                }

                instance.modified = true;

                // Notify the application (only for linked instances)
                if (group && this.callbacks.onNodeMoved) {
                    this.callbacks.onNodeMoved(
                        info.viewName,
                        group,
                        info.nodeIdx,
                        [info.currentPos[0], info.currentPos[1]]
                    );
                }
            }
        }

        this._endDrag();
        this._requestRedraw();
    }

    /**
     * Handle mouse leaving an overlay canvas. Clears hover state.
     *
     * @param {string} viewName
     */
    onMouseLeave(viewName) {
        if (this.hoveredNode && this.hoveredNode.viewName === viewName) {
            this.hoveredNode = null;

            const state = this._getState();
            const view = state ? this._findView(state, viewName) : null;
            if (view && view.overlayCanvas) {
                view.overlayCanvas.style.cursor = 'default';
            }

            this._requestRedraw();
        }
    }

    // ======================================================================
    // Keyboard event handler
    // ======================================================================

    /**
     * Handle keydown events for interaction shortcuts.
     *
     * - Delete / Backspace: delete the selected instance (via callback).
     * - N: add a new empty instance at the current frame (via callback).
     * - C: create group from assignment selection.
     *
     * @param {KeyboardEvent} e
     */
    onKeyDown(e) {
        // Do not intercept when the user is typing in an input
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) {
            return;
        }

        const state = this._getState();
        if (!state) return;

        switch (e.key) {
            case 'Delete':
            case 'Backspace': {
                if (this.selectedInstanceGroup || this.selectedUnlinked) {
                    e.preventDefault();
                    this._deleteSelected(e.shiftKey);
                }
                break;
            }

            case 'n':
            case 'N': {
                // Only handle plain 'n', not Ctrl+N (new window) etc.
                if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault();
                    this._addNewInstance();
                }
                break;
            }

            case 'a':
            case 'A': {
                if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault();
                    this.setAssignmentMode();
                    this._requestRedraw();
                }
                break;
            }

            case 'c':
            case 'C': {
                if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                    if (this.assignmentMode && this.assignmentSelection.length >= 1) {
                        e.preventDefault();
                        this._createGroupFromAssignment();
                    }
                }
                break;
            }

            case 'Enter': {
                if (this.assignmentMode && this.assignmentSelection.length >= 1) {
                    e.preventDefault();
                    this._createGroupFromAssignment();
                }
                break;
            }

            case 'u':
            case 'U': {
                if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                    if (this.selectedInstanceGroup) {
                        e.preventDefault();
                        this._unlinkSelectedGroup();
                    }
                }
                break;
            }

            case 'Escape': {
                if (this.assignmentMode) {
                    e.preventDefault();
                    this.assignmentSelection = [];
                    this.setAssignmentMode(false);
                    this._requestRedraw();
                    if (this.callbacks.onAssignmentCancelled) {
                        this.callbacks.onAssignmentCancelled();
                    }
                } else {
                    // Clear selection when not in assignment mode
                    this.clearSelection();
                    this._requestRedraw();
                }
                break;
            }
        }
    }

    // ======================================================================
    // Attach / Detach
    // ======================================================================

    /**
     * Attach event listeners to all overlay canvases and the document
     * (for keyboard).
     *
     * @param {Array<{ name: string, overlayCanvas: HTMLCanvasElement }>} views
     *   The view objects containing overlay canvases.
     */
    attach(views) {
        // Remove any previously-bound handlers so we never stack duplicates
        this.detach();

        if (!views || views.length === 0) return;

        var self = this;
        for (var vi = 0; vi < views.length; vi++) {
            var view = views[vi];
            var canvas = view.overlayCanvas;
            if (!canvas) continue;

            var viewName = view.name;

            // Create bound handlers so we can remove them later.
            // Use IIFE to capture viewName properly in the closure.
            var handlers = (function (vn) {
                return {
                    mousedown: function (e) { self.onMouseDown(e, vn); },
                    mousemove: function (e) { self.onMouseMove(e, vn); },
                    mouseup: function (e) {
                        if (self.isDragging && self.dragInfo) {
                            self.onMouseUp(e, self.dragInfo.viewName);
                        }
                        window.__mvguiDragging = false;
                    },
                    mouseleave: function () { self.onMouseLeave(vn); },
                    contextmenu: function (e) { e.preventDefault(); },
                    dblclick: function (e) {
                        // Prevent double-clicks from bubbling to zoom-reset handler
                        e.stopPropagation();
                        e._consumedByInteraction = true;
                    },
                };
            })(viewName);

            canvas.addEventListener('mousedown', handlers.mousedown);
            canvas.addEventListener('mousemove', handlers.mousemove);
            canvas.addEventListener('mouseup', handlers.mouseup);
            canvas.addEventListener('mouseleave', handlers.mouseleave);
            canvas.addEventListener('contextmenu', handlers.contextmenu);
            canvas.addEventListener('dblclick', handlers.dblclick);

            this._boundHandlers.set(viewName, { canvas: canvas, handlers: handlers });
        }

        // Keyboard handler
        this._keyHandler = function (e) { self.onKeyDown(e); };
        document.addEventListener('keydown', this._keyHandler);

        // Safety: always reset the dragging flag on any mouseup so it never
        // gets stuck (e.g. mouseup fires outside canvas after select-only click)
        this._globalMouseUpHandler = function () { window.__mvguiDragging = false; };
        document.addEventListener('mouseup', this._globalMouseUpHandler);
    }

    /**
     * Remove all event listeners that were added by attach().
     */
    detach() {
        for (var entry of this._boundHandlers.values()) {
            var canvas = entry.canvas;
            var h = entry.handlers;
            canvas.removeEventListener('mousedown', h.mousedown);
            canvas.removeEventListener('mousemove', h.mousemove);
            canvas.removeEventListener('mouseup', h.mouseup);
            canvas.removeEventListener('mouseleave', h.mouseleave);
            canvas.removeEventListener('contextmenu', h.contextmenu);
            canvas.removeEventListener('dblclick', h.dblclick);
        }
        this._boundHandlers.clear();

        // Clean up any active drag listeners
        this._removeDragListeners();

        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }

        if (this._globalMouseUpHandler) {
            document.removeEventListener('mouseup', this._globalMouseUpHandler);
            this._globalMouseUpHandler = null;
        }
    }

    // ======================================================================
    // Internal helpers
    // ======================================================================

    /**
     * Safely call getState from callbacks.
     * @returns {Object|null}
     * @private
     */
    _getState() {
        if (this.callbacks.getState) {
            return this.callbacks.getState();
        }
        return null;
    }

    /**
     * Safely call getInstanceGroups from callbacks.
     * @param {number} frameIdx
     * @returns {InstanceGroup[]|null}
     * @private
     */
    _getInstanceGroups(frameIdx) {
        if (this.callbacks.getInstanceGroups) {
            return this.callbacks.getInstanceGroups(frameIdx);
        }
        return null;
    }

    /**
     * Safely call requestRedraw from callbacks.
     * @private
     */
    _requestRedraw() {
        if (this.callbacks.requestRedraw) {
            this.callbacks.requestRedraw();
        }
    }

    /**
     * Find a view object by name from the current application state.
     * @param {Object} state
     * @param {string} viewName
     * @returns {Object|null}
     * @private
     */
    _findView(state, viewName) {
        if (!state || !state.views) return null;
        for (let i = 0; i < state.views.length; i++) {
            if (state.views[i].name === viewName) return state.views[i];
        }
        return null;
    }

    /**
     * Start a drag operation. Sets up document-level mousemove + mouseup
     * listeners so the drag works even if the mouse leaves the overlay canvas.
     *
     * @param {string} viewName
     * @param {number} instanceGroupIdx - Index in groups array, or -1 for unlinked
     * @param {number} nodeIdx
     * @param {number} vx - Start X in video coords
     * @param {number} vy - Start Y in video coords
     * @param {UnlinkedInstance|null} unlinked
     * @param {Object|null} altDragSource - If Alt+drag, the instance or unlinked to copy points from
     * @private
     */
    _startDrag(viewName, instanceGroupIdx, nodeIdx, vx, vy, unlinked, altDragSource, clientX, clientY) {
        // Clean up any previous drag listeners
        this._removeDragListeners();

        var originalPoints = null;
        var mode = 'node';
        if (altDragSource) {
            mode = 'instance';
            var srcInst = unlinked ? unlinked.instance : altDragSource;
            if (srcInst && srcInst.points) {
                originalPoints = srcInst.points.map(function (p) { return p ? [p[0], p[1]] : null; });
            }
        }

        this.isDragging = true;
        window.__mvguiDragging = true;
        this.dragInfo = {
            mode: mode,
            viewName: viewName,
            instanceGroupIdx: instanceGroupIdx,
            nodeIdx: nodeIdx,
            startPos: [vx, vy],
            currentPos: [vx, vy],
            startClientX: clientX || 0,
            startClientY: clientY || 0,
            unlinked: unlinked,
            originalPoints: originalPoints,
            thresholdMet: false,
        };

        // Capture pointer on the overlay canvas so it gets all events during drag
        var state = this._getState();
        if (state) {
            var view = this._findView(state, viewName);
            if (view && view.overlayCanvas && view.overlayCanvas.setPointerCapture) {
                try {
                    // Find the pointer ID from the most recent event
                    this._capturedCanvas = view.overlayCanvas;
                } catch (ignored) {}
            }
        }

        // Install document-level listeners as backup for drag duration
        var self = this;
        this._dragMoveHandler = function (e) { self._onDragMove(e); };
        this._dragUpHandler = function (e) { self._onDragUp(e); };
        document.addEventListener('mousemove', this._dragMoveHandler, true);
        document.addEventListener('mouseup', this._dragUpHandler, true);
    }

    /**
     * Document-level mousemove during a drag. Uses capture phase so it
     * fires before any other handlers, preventing zoom interference.
     * @param {MouseEvent} e
     * @private
     */
    _onDragMove(e) {
        if (!this.isDragging || !this.dragInfo) return;

        // Always block zoom handlers during drag
        e.stopImmediatePropagation();
        e.preventDefault();
        window.__mvguiDragging = true;

        var info = this.dragInfo;
        var coords = this.canvasToVideo(e.clientX, e.clientY, info.viewName);
        var vx = coords[0], vy = coords[1];
        info.currentPos = [vx, vy];

        // Mark threshold as met on any movement (annotation tools need instant response)
        if (!info.thresholdMet) {
            var tdx = e.clientX - info.startClientX;
            var tdy = e.clientY - info.startClientY;
            if (tdx === 0 && tdy === 0) {
                return;
            }
            info.thresholdMet = true;
        }

        // Determine the instance being dragged
        var instance = null;
        if (info.unlinked) {
            instance = info.unlinked.instance;
        } else {
            var state = this._getState();
            if (state) {
                var groups = this._getInstanceGroups(state.currentFrame);
                if (groups && groups.length > info.instanceGroupIdx) {
                    var group = groups[info.instanceGroupIdx];
                    instance = group.getInstance(info.viewName);
                }
            }
        }

        if (instance && instance.points) {
            if (info.mode === 'instance' && info.originalPoints) {
                var dx = vx - info.startPos[0];
                var dy = vy - info.startPos[1];
                for (var pi = 0; pi < instance.points.length; pi++) {
                    if (info.originalPoints[pi]) {
                        instance.points[pi] = [
                            info.originalPoints[pi][0] + dx,
                            info.originalPoints[pi][1] + dy
                        ];
                    }
                }
            } else if (instance.points.length > info.nodeIdx) {
                instance.points[info.nodeIdx] = [vx, vy];
            }
        }

        this._requestRedraw();
    }

    /**
     * Document-level mouseup during a drag. Finalizes the drag and removes
     * the temporary document listeners.
     * @param {MouseEvent} e
     * @private
     */
    _onDragUp(e) {
        // Block zoom handlers from seeing this mouseup
        e.stopImmediatePropagation();
        e.preventDefault();

        if (!this.isDragging || !this.dragInfo) {
            this._endDrag();
            return;
        }

        // Delegate to the existing onMouseUp logic
        this.onMouseUp(e, this.dragInfo.viewName);
    }

    /**
     * End the current drag operation without finalizing (internal cleanup).
     * Removes document-level drag listeners.
     * @private
     */
    _endDrag() {
        this.isDragging = false;
        this.dragInfo = null;
        window.__mvguiDragging = false;
        this._removeDragListeners();
    }

    /**
     * Remove temporary document-level drag listeners.
     * @private
     */
    _removeDragListeners() {
        if (this._dragMoveHandler) {
            document.removeEventListener('mousemove', this._dragMoveHandler, true);
            this._dragMoveHandler = null;
        }
        if (this._dragUpHandler) {
            document.removeEventListener('mouseup', this._dragUpHandler, true);
            this._dragUpHandler = null;
        }
    }

    /**
     * Compare two hoveredNode objects for equality.
     * @param {Object|null} a
     * @param {Object|null} b
     * @returns {boolean}
     * @private
     */
    _hoveredNodesEqual(a, b) {
        if (a === b) return true;
        if (a == null || b == null) return false;
        return (
            a.viewName === b.viewName &&
            a.instanceGroupIdx === b.instanceGroupIdx &&
            a.nodeIdx === b.nodeIdx
        );
    }

    /**
     * Toggle a node's null state (right-click action).
     * Nulled nodes keep their coordinates but are rendered grayed out
     * and excluded from triangulation.
     *
     * @param {string} viewName
     * @param {InstanceGroup} group
     * @param {number} nodeIdx
     * @private
     */
    _toggleNodeNull(viewName, group, nodeIdx) {
        const instance = group.getInstance(viewName);
        if (!instance || !instance.points) return;

        if (!instance.nulledNodes) instance.nulledNodes = new Set();

        if (instance.nulledNodes.has(nodeIdx)) {
            instance.nulledNodes.delete(nodeIdx);
        } else {
            instance.nulledNodes.add(nodeIdx);
        }

        if (this.callbacks.onNodeSetNull) {
            this.callbacks.onNodeSetNull(viewName, group, nodeIdx);
        }

        this._requestRedraw();
    }

    /**
     * Convert all instances in an InstanceGroup from 'predicted' to 'user'.
     * This creates a deep copy of the point data so edits do not corrupt
     * the original predictions.
     *
     * @param {InstanceGroup} group
     * @private
     */
    _convertToUserInstance(group) {
        if (!group || !group.instances) return;

        let converted = false;

        // Iterate over all views in the group
        for (const [camName, instance] of group.instances) {
            if (instance.type === 'predicted') {
                // Deep copy the points array
                instance.points = instance.points.map(pt =>
                    pt != null ? [pt[0], pt[1]] : null
                );
                // Fill missing nodes near centroid so user can see and place them
                let cx = 0, cy = 0, count = 0;
                for (let i = 0; i < instance.points.length; i++) {
                    if (instance.points[i]) {
                        cx += instance.points[i][0];
                        cy += instance.points[i][1];
                        count++;
                    }
                }
                if (count > 0) {
                    cx /= count;
                    cy /= count;
                    for (let i = 0; i < instance.points.length; i++) {
                        if (!instance.points[i]) {
                            // Offset each missing node slightly so they don't stack
                            instance.points[i] = [cx + (i - instance.points.length / 2) * 10, cy];
                        }
                    }
                }
                instance.type = 'user';
                converted = true;
            }
        }

        if (converted) {
            this.select(group, this.selectedNodeIdx);

            if (this.callbacks.onInstanceConverted) {
                this.callbacks.onInstanceConverted(group);
            }

            this._requestRedraw();
        }
    }

    /**
     * Cycle selection through the instance groups at the current frame.
     * Tab = forward, Shift+Tab = backward.
     *
     * @param {boolean} reverse - If true, cycle backward.
     * @private
     */
    _cycleSelection(reverse) {
        const state = this._getState();
        if (!state) return;

        const groups = this._getInstanceGroups(state.currentFrame);
        if (!groups || groups.length === 0) return;

        let currentIdx = -1;
        if (this.selectedInstanceGroup) {
            for (let i = 0; i < groups.length; i++) {
                if (groups[i] === this.selectedInstanceGroup) {
                    currentIdx = i;
                    break;
                }
            }
        }

        let nextIdx;
        if (currentIdx === -1) {
            // Nothing selected yet - pick first or last
            nextIdx = reverse ? groups.length - 1 : 0;
        } else if (reverse) {
            nextIdx = (currentIdx - 1 + groups.length) % groups.length;
        } else {
            nextIdx = (currentIdx + 1) % groups.length;
        }

        this.select(groups[nextIdx], -1);
        this._requestRedraw();
    }

    /**
     * Delete the currently selected instance group.
     *
     * If deleteAll is true (Shift+Del) or no lastInteractedView is set,
     * removes the entire group from all cameras.
     * Otherwise, removes only the instance for the last-clicked camera.
     * If that was the last camera in the group, removes the whole group.
     *
     * @param {boolean} [deleteAll=false] - If true, delete from all cameras
     * @private
     */
    _deleteSelected(deleteAll) {
        const state = this._getState();
        if (!state || !state.session) return;

        const frameIdx = state.currentFrame;
        const viewName = this.lastInteractedView;

        // Handle unlinked instance deletion
        if (this.selectedUnlinked) {
            const ul = this.selectedUnlinked;
            this.clearSelection();

            const fg = state.session.getFrameGroup(frameIdx);
            if (fg) {
                fg.removeUnlinkedById(ul.id);
            }

            if (this.callbacks.onInstanceDeleted) {
                this.callbacks.onInstanceDeleted(frameIdx, null);
            }

            this._requestRedraw();
            return;
        }

        // Handle linked instance group deletion
        if (!this.selectedInstanceGroup) return;

        const group = this.selectedInstanceGroup;

        // Clear selection before modifying data
        this.clearSelection();

        if (deleteAll || !viewName) {
            // Full group removal (existing behavior)
            state.session.removeInstanceGroup(frameIdx, group);
        } else {
            // Per-camera removal: remove only this view's instance
            const instance = group.getInstance(viewName);
            if (instance) {
                group.instances.delete(viewName);

                // Remove from FrameGroup too
                const fg = state.session.getFrameGroup(frameIdx);
                if (fg) {
                    const camInstances = fg.instances.get(viewName);
                    if (camInstances) {
                        const idx = camInstances.indexOf(instance);
                        if (idx >= 0) camInstances.splice(idx, 1);
                        if (camInstances.length === 0) fg.instances.delete(viewName);
                    }
                }
            }

            // If group is now empty, remove the whole group
            if (group.instances.size === 0) {
                state.session.removeInstanceGroup(frameIdx, group);
            }
        }

        // Notify the application (e.g. to update 3D viewport, info panel, timeline)
        if (this.callbacks.onInstanceDeleted) {
            this.callbacks.onInstanceDeleted(frameIdx, group);
        }

        this._requestRedraw();
    }

    /**
     * Create an InstanceGroup from the current assignment selection.
     * @private
     */
    _createGroupFromAssignment() {
        const state = this._getState();
        if (!state || !state.session) return;
        if (this.assignmentSelection.length < 1) return;

        const frameIdx = state.currentFrame;
        const group = state.session.createGroupFromUnlinked(frameIdx, this.assignmentSelection);

        // Update instance trackIdx to match group for consistent coloring
        for (const [camName, inst] of group.instances) {
            inst.trackIdx = group.trackIdx;
        }

        // Clear assignment mode
        this.assignmentSelection = [];
        this.assignmentMode = false;

        // Select the newly created group
        this.select(group, -1);
        this._requestRedraw();

        // Notify host to clean up toast and refresh UI
        if (this.callbacks.onAssignmentGroupCreated) {
            this.callbacks.onAssignmentGroupCreated(group);
        }
    }

    /**
     * Unlink the currently selected InstanceGroup: break it apart and
     * return its instances to the unlinked pool.
     * @private
     */
    _unlinkSelectedGroup() {
        const state = this._getState();
        if (!state || !state.session) return;
        if (!this.selectedInstanceGroup) return;

        const frameIdx = state.currentFrame;
        const group = this.selectedInstanceGroup;

        // Clear selection before modifying data
        this.clearSelection();

        // Unlink the group (instances go back to unlinked pool)
        state.session.unlinkGroup(frameIdx, group);

        // Notify the application
        if (this.callbacks.onInstanceDeleted) {
            this.callbacks.onInstanceDeleted(frameIdx, group);
        }

        this._requestRedraw();
    }

    /**
     * Add a new empty instance at the current frame. This is a stub that
     * relies on the application providing a callback for actual creation.
     * Since the callbacks spec does not include an addInstance callback,
     * this method is provided as a hook point. Subclasses or future
     * callback additions can extend this.
     *
     * @private
     */
    _addNewInstance() {
        const state = this._getState();
        if (!state || !state.session) return;

        const skeleton = state.session.skeleton;
        const numNodes = skeleton ? skeleton.nodes.length : 0;

        // Target camera = last clicked view, fallback to first view
        let targetCamera = this.lastInteractedView;
        if (!targetCamera && state.views && state.views.length > 0) {
            targetCamera = state.views[0].name;
        }
        if (!targetCamera) return;

        // Use last active track index
        const trackIdx = this.lastActiveTrackIdx;

        // Try to copy positions from the nearest previous frame on the same
        // camera. Check both linked InstanceGroups (matching track) and
        // unlinked instances.
        let points = null;
        const session = state.session;
        const currentFrame = state.currentFrame;
        const sortedFrames = session.frameIndices;
        for (let i = sortedFrames.length - 1; i >= 0; i--) {
            const fi = sortedFrames[i];
            if (fi >= currentFrame) continue;
            // Check linked groups first (matching track)
            const groups = session.getInstanceGroupsForFrame(fi);
            for (const g of groups) {
                if (g.trackIdx === trackIdx && g.instances.has(targetCamera)) {
                    const srcInst = g.instances.get(targetCamera);
                    if (srcInst && srcInst.points) {
                        points = srcInst.points.map(function (p) { return p ? [p[0], p[1]] : null; });
                    }
                    break;
                }
            }
            // Check unlinked instances on this camera
            if (!points) {
                const fg = session.getFrameGroup(fi);
                if (fg) {
                    const unlinked = fg.getUnlinkedInstances(targetCamera);
                    for (let u = unlinked.length - 1; u >= 0; u--) {
                        const srcInst = unlinked[u].instance;
                        if (srcInst && srcInst.points) {
                            points = srcInst.points.map(function (p) { return p ? [p[0], p[1]] : null; });
                            break;
                        }
                    }
                }
            }
            if (points) break;
        }

        // Fallback: default positions spread around center
        if (!points) {
            let vw = 640, vh = 480;
            if (state.views) {
                for (const v of state.views) {
                    if (v.name === targetCamera) {
                        vw = v.videoWidth || vw;
                        vh = v.videoHeight || vh;
                        break;
                    }
                }
            }
            const cx = vw / 2, cy = vh / 2;
            const spacing = Math.min(vw, vh) * 0.04;
            points = new Array(numNodes);
            for (let n = 0; n < numNodes; n++) {
                const offset = n - (numNodes - 1) / 2;
                points[n] = [cx + offset * spacing * 0.3, cy + offset * spacing];
            }
        }

        const instance = new Instance(points, trackIdx, 'user', 1.0);
        instance.modified = true;

        state.session.addUnlinkedInstance(state.currentFrame, targetCamera, instance);
        this._requestRedraw();
    }
}
