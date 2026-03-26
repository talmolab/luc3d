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

        /** @type {boolean} Whether the selection targets the reprojected sub-entry */
        this.selectedReprojected = false;

        /**
         * Node currently under the cursor, or null.
         * @type {{ viewName: string, instanceGroupIdx: number, nodeIdx: number }|null}
         */
        this.hoveredNode = null;

        /** Last known cursor position in video coordinates for the last interacted view */
        this.lastCursorPos = null; // [vx, vy] or null

        // ------------------------------------------------------------------
        // Drag state
        // ------------------------------------------------------------------

        /** @type {boolean} Whether a drag is in progress */
        this.isDragging = false;

        /** @type {boolean} Whether drag is allowed (set true on mouseup, false on mousedown) */
        this._canDrag = false;

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

        /** @private Whether the clicked unlinked instance was already in assignment selection */
        this._unlinkedWasSelected = false;
        /** @private The unlinked instance clicked on mousedown (for deselect-on-click logic) */
        this._unlinkedClickTarget = null;

        // ------------------------------------------------------------------
        // Edit Group mode state
        // ------------------------------------------------------------------

        /** @type {boolean} Whether edit group mode is active */
        this.editGroupMode = false;

        /** @type {InstanceGroup|null} The group being edited */
        this.editGroupTarget = null;

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
    findNearestNode(videoX, videoY, viewName, frameIdx) {
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

        // Node threshold = visual node size (video px) + screen-space padding (3 CSS px → video px)
        const sliderEl = document.getElementById('visUserNodeSize');
        const nodeSize = sliderEl ? parseInt(sliderEl.value) || 4 : 4;
        const nodeThreshold = nodeSize + 1 * displayToVideo;

        // Edge threshold = edge weight (video px) + screen-space padding (3 CSS px → video px)
        const edgeSliderEl = document.getElementById('visUserEdgeWeight');
        const edgeWeight = edgeSliderEl ? parseInt(edgeSliderEl.value) || 2 : 2;
        const edgeThreshold = edgeWeight + 1 * displayToVideo;

        // Get skeleton edges for edge hit testing
        const skeleton = (state && state.session) ? state.session.skeleton : null;
        const edges = skeleton ? skeleton.edges : null;

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

                // Collect candidate instances for this group in this view
                var candidates = [];
                var mainInst = group.getInstance(viewName);
                if (mainInst && mainInst.points) {
                    var mainType = mainInst.type || 'user';
                    var visUserEl = document.getElementById('visUser');
                    var visPredEl = document.getElementById('visPredicted');
                    var visReprojEl = document.getElementById('visReprojections');
                    var mainVisible = (mainType === 'user' && (!visUserEl || visUserEl.checked)) ||
                        (mainType === 'predicted' && (!visPredEl || visPredEl.checked)) ||
                        (mainType === 'reprojected' && (!visReprojEl || visReprojEl.checked));
                    if (mainVisible && typePassFilters[pass](mainType)) {
                        candidates.push({ inst: mainInst, isReproj: false });
                    }
                }
                // Also consider reprojected instance (may coexist with main instance)
                var visReprojEl2 = document.getElementById('visReprojections');
                if (typePassFilters[pass]('reprojected') &&
                    (!visReprojEl2 || visReprojEl2.checked)) {
                    var reprojInst = group.getReprojectedInstance ? group.getReprojectedInstance(viewName) : null;
                    if (reprojInst && reprojInst.points) {
                        candidates.push({ inst: reprojInst, isReproj: true });
                    }
                }

                for (let ci = 0; ci < candidates.length; ci++) {
                    var instance = candidates[ci].inst;
                    var hitReprojected = candidates[ci].isReproj;

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
                                hitReprojected: hitReprojected,
                            };
                        }
                    }

                    // --- Edge hit testing (only if no node was hit for this instance) ---
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
                                best = {
                                    instanceGroupIdx: g,
                                    instanceGroup: group,
                                    instanceIdx: g,
                                    nodeIdx: -1, // edge hit, no specific node
                                    distance: edgeDist,
                                    hitReprojected: hitReprojected,
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
    findNearestUnlinkedNode(videoX, videoY, viewName, frameIdx) {
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

        // Node threshold = visual node size (video px) + screen-space padding (3 CSS px → video px)
        const sliderEl = document.getElementById('visUserNodeSize');
        const nodeSize = sliderEl ? parseInt(sliderEl.value) || 4 : 4;
        const nodeThreshold = nodeSize + 1 * displayToVideo;

        // Edge threshold = edge weight (video px) + screen-space padding (3 CSS px → video px)
        const edgeSliderEl = document.getElementById('visUserEdgeWeight');
        const edgeWeight = edgeSliderEl ? parseInt(edgeSliderEl.value) || 2 : 2;
        const edgeThreshold = edgeWeight + 1 * displayToVideo;

        // Get skeleton edges for edge hit testing
        const skeleton = state.session.skeleton;
        const edges = skeleton ? skeleton.edges : null;

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
                var visUserChk = document.getElementById('visUser');
                var visPredChk = document.getElementById('visPredicted');
                if (ulType === 'user' && visUserChk && !visUserChk.checked) continue;
                if (ulType === 'predicted' && visPredChk && !visPredChk.checked) continue;

                if (!ulTypePassFilters[pass](ulType)) continue;

                // --- Node hit testing ---
                // Use <= so later (newer) instances in the array win ties,
                // matching the render order where newer instances draw on top.
                for (let n = 0; n < points.length; n++) {
                    const pt = points[n];
                    if (pt == null) continue;

                    const dx = pt[0] - videoX;
                    const dy = pt[1] - videoY;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < nodeThreshold && dist <= bestDist) {
                        bestDist = dist;
                        best = {
                            unlinked: ul,
                            nodeIdx: n,
                            distance: dist,
                        };
                    }
                }

                // --- Edge hit testing (only if no node was hit for this instance) ---
                if (edges && !best) {
                    for (let ei = 0; ei < edges.length; ei++) {
                        const edge = edges[ei];
                        const ptA = points[edge[0]];
                        const ptB = points[edge[1]];
                        if (ptA == null || ptB == null) continue;

                        const edgeDist = this._pointToSegmentDist(
                            videoX, videoY, ptA[0], ptA[1], ptB[0], ptB[1]);

                        if (edgeDist < edgeThreshold && edgeDist <= bestDist) {
                            bestDist = edgeDist;
                            best = {
                                unlinked: ul,
                                nodeIdx: -1,
                                distance: edgeDist,
                            };
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
     * Toggle edit group mode on/off.
     * @param {boolean} enabled
     * @param {InstanceGroup} [group] - The group to edit (required when enabling)
     */
    setEditGroupMode(enabled, group) {
        this.editGroupMode = !!enabled;
        this.editGroupTarget = enabled ? group : null;
        this._requestRedraw();
    }

    /**
     * Add an unlinked instance to the assignment selection.
     * Only allows one selection per camera view.
     * @param {UnlinkedInstance} unlinked
     */
    addToAssignmentSelection(unlinked) {
        // Check if we already have one from this camera — reject duplicates
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
                // Different instance from same camera — replace
                this.assignmentSelection[i] = unlinked;
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
    select(instanceGroup, nodeIdx, reprojected) {
        if (nodeIdx === undefined) nodeIdx = -1;

        const changed = (
            this.selectedInstanceGroup !== instanceGroup ||
            this.selectedNodeIdx !== nodeIdx
        );

        this.selectedInstanceGroup = instanceGroup;
        this.selectedNodeIdx = nodeIdx;
        this.selectedReprojected = !!reprojected;

        // When clearing linked selection (null), also clear unlinked selection
        if (!instanceGroup) {
            this.selectedUnlinked = null;
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
            // After cleaning up a stale drag, allow the new mousedown to drag
            this._canDrag = true;
        }

        this._canDrag = false;

        var coords = this.canvasToVideo(e.clientX, e.clientY, viewName);
        var vx = coords[0], vy = coords[1];
        var frameIdx = state.currentFrame;

        // --- Right-click / Ctrl+click (macOS trackpad): toggle node null ---
        if (e.button === 2 || (e.button === 0 && e.ctrlKey)) {
            e.preventDefault();

            // Check both linked (InstanceGroup) and unlinked instances
            var hit = this.findNearestNode(vx, vy, viewName, frameIdx);
            var ulHit = this.findNearestUnlinkedNode(vx, vy, viewName, frameIdx);

            // Prefer unlinked (ungrouped) when equal distance — they render on top
            if (hit && ulHit) {
                if (ulHit.distance <= hit.distance) hit = null;
                else ulHit = null;
            }

            if (hit) {
                // Determine which instance was hit (reprojected or main)
                var hitInstance;
                if (hit.hitReprojected) {
                    hitInstance = hit.instanceGroup.reprojectedInstances
                        ? hit.instanceGroup.reprojectedInstances.get(viewName) : null;
                } else {
                    hitInstance = hit.instanceGroup.getInstance(viewName);
                }
                // Block null toggle for predicted instances
                if (hitInstance && hitInstance.type === 'predicted') return;
                // Resolve edge hits to nearest node
                var nullNodeIdx = hit.nodeIdx;
                if (nullNodeIdx === -1) {
                    nullNodeIdx = this._resolveNearestNode(hitInstance, vx, vy);
                }
                if (nullNodeIdx < 0) return; // no valid node found
                // Select group and toggle null
                this.select(hit.instanceGroup, -1, hit.hitReprojected);
                if (hit.hitReprojected) {
                    // Toggle null directly on the reprojected instance
                    if (!hitInstance.nulledNodes) hitInstance.nulledNodes = new Set();
                    if (hitInstance.nulledNodes.has(nullNodeIdx)) {
                        hitInstance.nulledNodes.delete(nullNodeIdx);
                    } else {
                        hitInstance.nulledNodes.add(nullNodeIdx);
                    }
                    this._requestRedraw();
                    if (this.callbacks.onNodeSetNull) {
                        this.callbacks.onNodeSetNull(viewName, hit.instanceGroup, nullNodeIdx);
                    }
                } else {
                    this._toggleNodeNull(viewName, hit.instanceGroup, nullNodeIdx);
                }
            } else if (ulHit) {
                var ulInst = ulHit.unlinked.instance;
                if (ulInst && ulInst.type === 'predicted') return;
                // Resolve edge hits to nearest node
                var ulNullNodeIdx = ulHit.nodeIdx;
                if (ulNullNodeIdx === -1) {
                    ulNullNodeIdx = this._resolveNearestNode(ulInst, vx, vy);
                }
                if (ulNullNodeIdx < 0) return;
                // Toggle null directly on the unlinked instance
                if (!ulInst.nulledNodes) ulInst.nulledNodes = new Set();
                if (ulInst.nulledNodes.has(ulNullNodeIdx)) {
                    ulInst.nulledNodes.delete(ulNullNodeIdx);
                } else {
                    ulInst.nulledNodes.add(ulNullNodeIdx);
                }
                this._requestRedraw();
            }
            return;
        }

        // --- Left click only ---
        if (e.button !== 0) return;

        // --- Edit Group mode: intercept clicks ---
        if (this.editGroupMode && this.editGroupTarget) {
            var egLinked = this.findNearestNode(vx, vy, viewName, frameIdx);
            var egUnlinked = this.findNearestUnlinkedNode(vx, vy, viewName, frameIdx);

            // Skip reprojected hits — only interact with real instances in edit group mode
            if (egLinked && egLinked.hitReprojected) {
                egLinked = null;
            }

            if (egLinked) {
                // Check if clicked instance belongs to the edit target group
                if (egLinked.instanceGroup === this.editGroupTarget) {
                    // Remove this instance from the group
                    if (this.callbacks.onEditGroupRemove) {
                        this.callbacks.onEditGroupRemove(this.editGroupTarget, viewName);
                    }
                } else {
                    // Instance belongs to another group
                    if (this.callbacks.onEditGroupError) {
                        this.callbacks.onEditGroupError('Cannot add: instance belongs to another group');
                    }
                }
            } else if (egUnlinked) {
                var group = this.editGroupTarget;
                // Validate: can't add if group already has this view
                if (group.getInstance(viewName)) {
                    if (this.callbacks.onEditGroupError) {
                        this.callbacks.onEditGroupError('Cannot add: group already has an instance from this view');
                    }
                } else {
                    if (this.callbacks.onEditGroupAdd) {
                        this.callbacks.onEditGroupAdd(group, viewName, egUnlinked.unlinked);
                    }
                }
            }
            // Consume event only if a node/instance was clicked;
            // let empty-space clicks pass through for pan/zoom.
            if (egLinked || egUnlinked) {
                e.preventDefault();
                e.stopPropagation();
                e._consumedByInteraction = true;
                this._requestRedraw();
            }
            return;
        }

        // --- Find the closest node (linked or unlinked) ---
        var linkedHit = this.findNearestNode(vx, vy, viewName, frameIdx);
        var ulHit = this.findNearestUnlinkedNode(vx, vy, viewName, frameIdx);

        var useLinked = false;
        var useUnlinked = false;
        if (linkedHit && ulHit) {
            // In assignment mode, prefer unlinked targets so clicks always
            // add to the assignment selection instead of exiting the mode.
            // Otherwise prefer unlinked (ungrouped) instances since they render
            // on top of grouped instances — use strict less-than so that equal
            // distances resolve to the visually-frontmost (unlinked) layer.
            if (this.assignmentMode) {
                useUnlinked = true;
            } else {
                useLinked = linkedHit.distance < ulHit.distance;
                useUnlinked = !useLinked;
            }
        } else if (linkedHit) {
            useLinked = true;
        } else if (ulHit) {
            useUnlinked = true;
        }

        // --- Double-click on reprojected instance: create user instance ---
        if (e.detail >= 2 && useLinked && linkedHit.hitReprojected) {
            if (this.callbacks.onDoubleClickReprojected) {
                this.callbacks.onDoubleClickReprojected(linkedHit.instanceGroup, viewName);
            }
            e.preventDefault();
            e.stopPropagation();
            e._consumedByInteraction = true;
            this._requestRedraw();
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
                e.preventDefault();
                e.stopPropagation();
                e._consumedByInteraction = true;
                this._requestRedraw();
                return;
            }
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
            // Block drag for reprojected; auto-convert predicted to user for editing
            if (linkedHit.hitReprojected) {
                // Reprojected instance hit: select group with reprojected flag
                this.select(linkedHit.instanceGroup, linkedHit.nodeIdx, true);
                this._requestRedraw();
                e.preventDefault();
                e.stopPropagation();
                e._consumedByInteraction = true;
                // Fall through to the end (no drag)
            } else if (hitInst && hitInst.type === 'reprojected') {
                // Reprojected (non-editable projection): select only, no drag
                this.select(linkedHit.instanceGroup, linkedHit.nodeIdx);
                this._requestRedraw();
                e.preventDefault();
                e.stopPropagation();
                e._consumedByInteraction = true;
            } else if (hitInst && hitInst.type === 'predicted') {
                // Predicted instance: auto-convert to user so it becomes editable,
                // then fall through to the drag logic below.
                this._convertToUserInstance(linkedHit.instanceGroup);
                hitInst = linkedHit.instanceGroup.getInstance(viewName);
            }

            // User instance (or freshly converted predicted): select + drag
            if (hitInst && hitInst.type !== 'reprojected' && !linkedHit.hitReprojected) {
                // Resolve edge hits (nodeIdx=-1) to the nearest node
                var dragNodeIdx = linkedHit.nodeIdx;
                if (dragNodeIdx === -1) {
                    dragNodeIdx = this._resolveNearestNode(hitInst, vx, vy);
                }
                // Select group only (no node-level selection) — matches
                // ungrouped behavior where dragging doesn't require
                // pre-selecting a specific node.
                this.select(linkedHit.instanceGroup, -1);
                // Always start drag — thresholdMet in _startDrag prevents
                // accidental movement on click-without-drag.
                if (dragNodeIdx >= 0) {
                    this._startDrag(viewName, linkedHit.instanceGroupIdx, dragNodeIdx,
                        vx, vy, null, e.altKey ? linkedHit.instanceGroup.getInstance(viewName) : null);
                }
                e.preventDefault();
                e.stopPropagation();
                e._consumedByInteraction = true;
            }

        // --- Unlinked node: double-click predicted → create user instance ---
        } else if (useUnlinked && e.detail >= 2 && ulHit.unlinked.instance && ulHit.unlinked.instance.type === 'predicted') {
            var predInst = ulHit.unlinked.instance;
            // Compute centroid of visible points for placing missing nodes
            var _cx = 0, _cy = 0, _cc = 0;
            for (var _pi = 0; _pi < predInst.points.length; _pi++) {
                if (predInst.points[_pi] != null) {
                    _cx += predInst.points[_pi][0]; _cy += predInst.points[_pi][1]; _cc++;
                }
            }
            if (_cc > 0) { _cx = Math.round(_cx / _cc); _cy = Math.round(_cy / _cc); }
            var _nulled = new Set();
            var _nullCount = 0;
            for (var _ni = 0; _ni < predInst.points.length; _ni++) {
                if (predInst.points[_ni] == null) _nullCount++;
            }
            var _nullIdx = 0;
            var clonedPoints = predInst.points.map(function(pt, idx) {
                if (pt != null) return [pt[0], pt[1]];
                // Missing point — fan out from centroid so they don't overlap
                if (_cc > 0) {
                    _nulled.add(idx);
                    var angle = (2 * Math.PI * _nullIdx) / Math.max(_nullCount, 1);
                    var spread = 20;
                    _nullIdx++;
                    return [Math.round(_cx + Math.cos(angle) * spread),
                            Math.round(_cy + Math.sin(angle) * spread)];
                }
                return null;
            });
            var newInst = new Instance(clonedPoints, predInst.trackIdx, 'user', 1.0);
            if (_nulled.size > 0) newInst.nulledNodes = _nulled;
            newInst.modified = true;
            var newUl = state.session.addUnlinkedInstance(frameIdx, viewName, newInst);
            this.select(null, -1);
            this.selectedUnlinked = newUl;
            if (this.callbacks.onUserInstanceCreated) {
                this.callbacks.onUserInstanceCreated(viewName, clonedPoints);
            }
            e.preventDefault();
            e.stopPropagation();
            e._consumedByInteraction = true;
            this._requestRedraw();

        // --- Unlinked node: select, auto-enter assignment mode, or drag ---
        } else if (useUnlinked) {
            this.select(null, -1);
            this.selectedUnlinked = ulHit.unlinked;
            // Auto-enter assignment mode
            if (!this.assignmentMode) {
                this.assignmentMode = true;
                this.assignmentSelection = [];
            }
            // Check if already selected (for deselect-on-click-only logic)
            var wasAlreadySelected = false;
            for (var asi = 0; asi < this.assignmentSelection.length; asi++) {
                if (this.assignmentSelection[asi].id === ulHit.unlinked.id) {
                    wasAlreadySelected = true;
                    break;
                }
            }
            // Always ensure selected on mousedown (don't toggle yet)
            if (!wasAlreadySelected) {
                this.addToAssignmentSelection(ulHit.unlinked);
            }
            // Still allow drag for repositioning
            // Block drag for predicted unlinked instances (select only)
            var ulInstType = ulHit.unlinked.instance ? ulHit.unlinked.instance.type : 'user';
            if (ulInstType !== 'predicted') {
                // Store flag for mouseup to decide whether to deselect
                this._unlinkedWasSelected = wasAlreadySelected;
                this._unlinkedClickTarget = ulHit.unlinked;
                // Resolve edge hits to nearest node
                var ulDragNodeIdx = ulHit.nodeIdx;
                if (ulDragNodeIdx === -1) {
                    ulDragNodeIdx = this._resolveNearestNode(ulHit.unlinked.instance, vx, vy);
                }
                if (ulDragNodeIdx >= 0) {
                    this._startDrag(viewName, -1, ulDragNodeIdx,
                        vx, vy, ulHit.unlinked, e.altKey ? ulHit.unlinked : null);
                }
            } else {
                // Predicted: no drag, toggle immediately on click
                if (wasAlreadySelected) {
                    this.addToAssignmentSelection(ulHit.unlinked); // toggles off
                }
            }
            e.preventDefault();
            e.stopPropagation();
            e._consumedByInteraction = true;

        // --- Clicked empty space: clear selection, maybe keep assignment mode ---
        } else {
            if (this.assignmentMode) {
                // Check if the click is in a different view than any selected
                var clickedInNewView = true;
                for (var ai = 0; ai < this.assignmentSelection.length; ai++) {
                    if (this.assignmentSelection[ai].cameraName === viewName) {
                        clickedInNewView = false;
                        break;
                    }
                }
                if (clickedInNewView && viewName) {
                    // Clicking empty space in a new view: keep assignment mode active
                } else {
                    // Same view or outside views: exit assignment mode
                    this.assignmentSelection = [];
                    this.setAssignmentMode(false);
                    if (this.callbacks.onAssignmentCancelled) {
                        this.callbacks.onAssignmentCancelled();
                    }
                }
            }
            this.clearSelection();
            // Double-click on empty space: reset zoom
            if (e.detail >= 2 && this.callbacks.onDoubleClickEmpty) {
                this.callbacks.onDoubleClickEmpty(viewName);
            }
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
        // During drags, all movement is handled by _onDragMove (document-level)
        if (this.isDragging) return;

        var state = this._getState();
        if (!state) return;

        var coords = this.canvasToVideo(e.clientX, e.clientY, viewName);
        var vx = coords[0], vy = coords[1];

        // Track cursor position for new instance placement
        this.lastCursorPos = [vx, vy];
        this.lastInteractedView = viewName;

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
                } else if (info.nodeIdx >= 0 && instance.points.length > info.nodeIdx) {
                    // Single-node drag: finalize the single point
                    instance.points[info.nodeIdx] = [info.currentPos[0], info.currentPos[1]];
                    instance.type = 'user';
                }

                instance.modified = true;

                // Notify the application
                if (group && this.callbacks.onNodeMoved) {
                    this.callbacks.onNodeMoved(
                        info.viewName,
                        group,
                        info.nodeIdx,
                        [info.currentPos[0], info.currentPos[1]]
                    );
                } else if (info.unlinked && this.callbacks.onUnlinkedNodeMoved) {
                    this.callbacks.onUnlinkedNodeMoved(
                        info.viewName,
                        instance
                    );
                }
            }
        }

        // Deselect unlinked instance only on plain click (no drag) of already-selected instance
        if (!didMove && this._unlinkedWasSelected && this._unlinkedClickTarget) {
            this.addToAssignmentSelection(this._unlinkedClickTarget); // toggles off
        }
        this._unlinkedWasSelected = false;
        this._unlinkedClickTarget = null;

        this._endDrag();
        this._requestRedraw();
    }

    /**
     * Handle mouse leaving an overlay canvas. Clears hover state.
     *
     * @param {string} viewName
     */
    onMouseLeave(viewName) {
        if (this.lastInteractedView === viewName) {
            this.lastCursorPos = null;
        }
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

        // Edit Group mode: Escape cancels, Enter finishes
        if (this.editGroupMode) {
            if (e.key === 'Escape') {
                e.preventDefault();
                if (this.callbacks.onEditGroupCancelled) {
                    this.callbacks.onEditGroupCancelled();
                }
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                if (this.callbacks.onEditGroupFinished) {
                    this.callbacks.onEditGroupFinished();
                }
                return;
            }
        }

        switch (e.key) {
            case 'Delete':
            case 'Backspace': {
                if (this.selectedInstanceGroup || this.selectedUnlinked) {
                    e.preventDefault();
                    this._deleteSelected(e.shiftKey);
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
                        if (!self.isDragging) {
                            self._canDrag = true;
                        }
                    },
                    mouseleave: function () { self.onMouseLeave(vn); },
                    contextmenu: function (e) { e.preventDefault(); },
                };
            })(viewName);

            canvas.addEventListener('mousedown', handlers.mousedown);
            canvas.addEventListener('mousemove', handlers.mousemove);
            canvas.addEventListener('mouseup', handlers.mouseup);
            canvas.addEventListener('mouseleave', handlers.mouseleave);
            canvas.addEventListener('contextmenu', handlers.contextmenu);

            this._boundHandlers.set(viewName, { canvas: canvas, handlers: handlers });
        }

        // Keyboard handler
        this._keyHandler = function (e) { self.onKeyDown(e); };
        document.addEventListener('keydown', this._keyHandler);
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
        }
        this._boundHandlers.clear();

        // Clean up any active drag listeners
        this._removeDragListeners();

        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }
    }

    // ======================================================================
    // Internal helpers
    // ======================================================================

    /**
     * Resolve an edge hit (nodeIdx === -1) to the nearest node.
     * When a click lands on a skeleton edge rather than directly on a node,
     * findNearestNode returns nodeIdx=-1. This method finds the closest
     * node to the click point so that drag and null-toggle work correctly.
     *
     * @param {Instance} instance - The instance whose points to search
     * @param {number} vx - Click X in video coordinates
     * @param {number} vy - Click Y in video coordinates
     * @returns {number} Resolved node index, or -1 if no valid node found
     * @private
     */
    _resolveNearestNode(instance, vx, vy) {
        if (!instance || !instance.points) return -1;
        var bestIdx = -1;
        var bestDist = Infinity;
        for (var ni = 0; ni < instance.points.length; ni++) {
            var pt = instance.points[ni];
            if (pt == null) continue;
            var dx = pt[0] - vx;
            var dy = pt[1] - vy;
            var d = Math.sqrt(dx * dx + dy * dy);
            if (d < bestDist) {
                bestDist = d;
                bestIdx = ni;
            }
        }
        return bestIdx;
    }

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
    _startDrag(viewName, instanceGroupIdx, nodeIdx, vx, vy, unlinked, altDragSource) {
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
            unlinked: unlinked,
            originalPoints: originalPoints,
            thresholdMet: false,
        };

        // Install document-level listeners for the drag duration
        var self = this;
        this._dragMoveHandler = function (e) { self._onDragMove(e); };
        this._dragUpHandler = function (e) { self._onDragUp(e); };
        document.addEventListener('mousemove', this._dragMoveHandler, true); // capture phase
        document.addEventListener('mouseup', this._dragUpHandler, true); // capture phase
    }

    /**
     * Document-level mousemove during a drag. Uses capture phase so it
     * fires before any other handlers, preventing zoom interference.
     * @param {MouseEvent} e
     * @private
     */
    _onDragMove(e) {
        if (!this.isDragging || !this.dragInfo) return;

        var info = this.dragInfo;
        var coords = this.canvasToVideo(e.clientX, e.clientY, info.viewName);
        var vx = coords[0], vy = coords[1];

        // Clamp to view bounds so nodes can't be dragged outside the video
        var state = this._getState();
        if (state) {
            var view = this._findView(state, info.viewName);
            if (view) {
                var maxW = view.videoWidth || (view.overlayCanvas ? view.overlayCanvas.width : 0);
                var maxH = view.videoHeight || (view.overlayCanvas ? view.overlayCanvas.height : 0);
                if (vx < 0) vx = 0;
                if (vy < 0) vy = 0;
                if (maxW > 0 && vx > maxW) vx = maxW;
                if (maxH > 0 && vy > maxH) vy = maxH;
            }
        }

        info.currentPos = [vx, vy];

        // Require minimum movement before committing to a drag
        if (!info.thresholdMet) {
            var tdx = vx - info.startPos[0];
            var tdy = vy - info.startPos[1];
            if (Math.sqrt(tdx * tdx + tdy * tdy) < 3) {
                return; // Don't update position yet
            }
            info.thresholdMet = true;
        }

        // Determine the instance being dragged
        var instance = null;
        if (info.unlinked) {
            instance = info.unlinked.instance;
        } else {
            if (!state) state = this._getState();
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
            } else if (info.nodeIdx >= 0 && instance.points.length > info.nodeIdx) {
                instance.points[info.nodeIdx] = [vx, vy];
            }
        }

        e.preventDefault();
        e.stopPropagation();
        this._requestRedraw();
    }

    /**
     * Document-level mouseup during a drag. Finalizes the drag and removes
     * the temporary document listeners.
     * @param {MouseEvent} e
     * @private
     */
    _onDragUp(e) {
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
                // For null points, try to fill from reprojected instance and mark occluded
                var reprojInst = group.getReprojectedInstance
                    ? group.getReprojectedInstance(camName) : null;
                var nulled = instance.nulledNodes || new Set();

                // Compute centroid of visible points as fallback for missing nodes
                var cx = 0, cy = 0, cCount = 0;
                for (var ci = 0; ci < instance.points.length; ci++) {
                    if (instance.points[ci] != null) {
                        cx += instance.points[ci][0];
                        cy += instance.points[ci][1];
                        cCount++;
                    }
                }
                if (cCount > 0) { cx = Math.round(cx / cCount); cy = Math.round(cy / cCount); }

                // Count null points for fan-out spacing
                var nullTotal = 0;
                for (var ni = 0; ni < instance.points.length; ni++) {
                    if (instance.points[ni] == null) nullTotal++;
                }
                var nullSeq = 0;

                // Deep copy the points array, filling nulls from reprojection or centroid
                instance.points = instance.points.map(function (pt, idx) {
                    if (pt != null) return [pt[0], pt[1]];
                    // Point is null — try reprojection first
                    if (reprojInst && reprojInst.points && reprojInst.points[idx] != null) {
                        nulled.add(idx);
                        return [reprojInst.points[idx][0], reprojInst.points[idx][1]];
                    }
                    // No reprojection — fan out from centroid so nodes don't overlap
                    if (cCount > 0) {
                        nulled.add(idx);
                        var angle = (2 * Math.PI * nullSeq) / Math.max(nullTotal, 1);
                        var spread = 20;
                        nullSeq++;
                        return [Math.round(cx + Math.cos(angle) * spread),
                                Math.round(cy + Math.sin(angle) * spread)];
                    }
                    return null;
                });
                if (nulled.size > 0) {
                    instance.nulledNodes = nulled;
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
            const deletedViews = viewName ? [viewName] : [];
            this.clearSelection();

            const fg = state.session.getFrameGroup(frameIdx);
            if (fg) {
                fg.removeUnlinkedById(ul.id);
            }

            if (this.callbacks.onInstanceDeleted) {
                this.callbacks.onInstanceDeleted(frameIdx, null, deletedViews);
            }

            this._requestRedraw();
            return;
        }

        // Handle linked instance group deletion
        if (!this.selectedInstanceGroup) return;

        const group = this.selectedInstanceGroup;

        // Capture affected view names before deletion
        var deletedViews;
        if (deleteAll || !viewName) {
            deletedViews = Array.from(group.instances.keys());
        } else {
            deletedViews = [viewName];
        }

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
            this.callbacks.onInstanceDeleted(frameIdx, group, deletedViews);
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

        // Notify the application (no views deleted — instances moved to unlinked pool)
        if (this.callbacks.onInstanceDeleted) {
            this.callbacks.onInstanceDeleted(frameIdx, group, []);
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
    _addNewInstance(initialPoints, cursorPos) {
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

        // Get video dimensions
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

        let points;
        if (initialPoints && initialPoints.length === numNodes) {
            points = initialPoints;
        } else {
            // Topology-based layout using skeleton edges
            // Center at cursor position if available and within view bounds, else view center
            let cx = vw / 2, cy = vh / 2;
            if (cursorPos && cursorPos[0] >= 0 && cursorPos[0] <= vw && cursorPos[1] >= 0 && cursorPos[1] <= vh) {
                cx = cursorPos[0];
                cy = cursorPos[1];
            }
            const spacing = Math.min(vw, vh) * 0.04;
            points = new Array(numNodes);

            if (skeleton && skeleton.edges && skeleton.edges.length > 0 && numNodes > 0) {
                // Build adjacency list
                const adj = new Array(numNodes);
                const degree = new Array(numNodes).fill(0);
                for (let i = 0; i < numNodes; i++) adj[i] = [];
                for (const edge of skeleton.edges) {
                    adj[edge[0]].push(edge[1]);
                    adj[edge[1]].push(edge[0]);
                    degree[edge[0]]++;
                    degree[edge[1]]++;
                }

                // Find root: node with most connections
                let root = 0;
                for (let i = 1; i < numNodes; i++) {
                    if (degree[i] > degree[root]) root = i;
                }

                // BFS from root, placing children at evenly distributed angles
                const visited = new Array(numNodes).fill(false);
                const queue = [root];
                visited[root] = true;
                points[root] = [cx, cy];
                let parentAngle = new Array(numNodes).fill(-Math.PI / 2); // default upward

                while (queue.length > 0) {
                    const node = queue.shift();
                    const children = adj[node].filter(c => !visited[c]);
                    const baseAngle = parentAngle[node];
                    const spread = Math.PI; // spread children over 180 degrees
                    for (let i = 0; i < children.length; i++) {
                        const child = children[i];
                        visited[child] = true;
                        let angle;
                        if (children.length === 1) {
                            angle = baseAngle;
                        } else {
                            angle = baseAngle - spread / 2 + (spread * i) / (children.length - 1);
                        }
                        points[child] = [
                            points[node][0] + Math.cos(angle) * spacing * 2,
                            points[node][1] + Math.sin(angle) * spacing * 2
                        ];
                        parentAngle[child] = angle;
                        queue.push(child);
                    }
                }

                // Handle any disconnected nodes
                for (let i = 0; i < numNodes; i++) {
                    if (!visited[i]) {
                        const offset = i - (numNodes - 1) / 2;
                        points[i] = [cx + offset * spacing * 0.3, cy + offset * spacing];
                    }
                }
            } else {
                // Fallback: simple vertical line
                for (let n = 0; n < numNodes; n++) {
                    const offset = n - (numNodes - 1) / 2;
                    points[n] = [cx + offset * spacing * 0.3, cy + offset * spacing];
                }
            }
        }

        const instance = new Instance(points, 0, 'user', 1.0);
        instance.modified = true;

        state.session.addUnlinkedInstance(state.currentFrame, targetCamera, instance);
        if (this.callbacks.onUserInstanceCreated) {
            this.callbacks.onUserInstanceCreated(targetCamera, points);
        }
        this._requestRedraw();
    }
}
