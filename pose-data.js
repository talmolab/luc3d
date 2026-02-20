// pose-data.js - Data model for multi-view pose data
// All vanilla JS classes, no imports/exports.

class Skeleton {
    /**
     * @param {string} name
     * @param {string[]} nodes - Node names (e.g. ['nose', 'head', ...])
     * @param {[number, number][]} edges - Pairs of indices into the nodes array
     */
    constructor(name, nodes, edges) {
        this.name = name;
        this.nodes = nodes;
        this.edges = edges;
    }

    /**
     * Add a new node to the skeleton.
     * @param {string} name - Node name
     * @returns {number} Index of the new node
     */
    addNode(name) {
        this.nodes.push(name);
        return this.nodes.length - 1;
    }

    /**
     * Remove a node by index. Also removes edges referencing this node
     * and adjusts edge indices for nodes that shift down.
     * @param {number} nodeIdx
     * @returns {string|null} The removed node name, or null if invalid
     */
    removeNode(nodeIdx) {
        if (nodeIdx < 0 || nodeIdx >= this.nodes.length) return null;
        const name = this.nodes.splice(nodeIdx, 1)[0];

        // Remove edges that reference this node and adjust indices
        this.edges = this.edges.filter(function (edge) {
            return edge[0] !== nodeIdx && edge[1] !== nodeIdx;
        }).map(function (edge) {
            return [
                edge[0] > nodeIdx ? edge[0] - 1 : edge[0],
                edge[1] > nodeIdx ? edge[1] - 1 : edge[1],
            ];
        });

        return name;
    }

    /**
     * Add an edge between two nodes.
     * @param {number} srcIdx - Source node index
     * @param {number} dstIdx - Destination node index
     * @returns {boolean} True if added, false if invalid or duplicate
     */
    addEdge(srcIdx, dstIdx) {
        if (srcIdx < 0 || srcIdx >= this.nodes.length) return false;
        if (dstIdx < 0 || dstIdx >= this.nodes.length) return false;
        if (srcIdx === dstIdx) return false;
        // Check for duplicate
        for (let i = 0; i < this.edges.length; i++) {
            if ((this.edges[i][0] === srcIdx && this.edges[i][1] === dstIdx) ||
                (this.edges[i][0] === dstIdx && this.edges[i][1] === srcIdx)) {
                return false;
            }
        }
        this.edges.push([srcIdx, dstIdx]);
        return true;
    }

    /**
     * Remove an edge by index.
     * @param {number} edgeIdx
     * @returns {boolean} True if removed
     */
    removeEdge(edgeIdx) {
        if (edgeIdx < 0 || edgeIdx >= this.edges.length) return false;
        this.edges.splice(edgeIdx, 1);
        return true;
    }

    /**
     * Create a default 6-node mouse skeleton.
     * Nodes: nose, head, neck, body, tail_base, tail_tip
     * Edges: nose-head, head-neck, neck-body, body-tail_base, tail_base-tail_tip
     * @returns {Skeleton}
     */
    static defaultMouse() {
        return new Skeleton(
            'mouse',
            ['nose', 'head', 'neck', 'body', 'tail_base', 'tail_tip'],
            [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]
        );
    }
}


class Camera {
    /**
     * @param {string} name
     * @param {number[][]} matrix - 3x3 intrinsic matrix K
     * @param {number[]} dist - 5 distortion coefficients [k1, k2, p1, p2, k3]
     * @param {number[]} rvec - 3-element rotation vector (Rodrigues)
     * @param {number[]} tvec - 3-element translation vector
     * @param {[number, number]} size - [width, height]
     */
    constructor(name, matrix, dist, rvec, tvec, size) {
        this.name = name;
        this.matrix = matrix;
        this.dist = dist;
        this.rvec = rvec;
        this.tvec = tvec;
        this.size = size;
    }

    /**
     * Compute 3x3 rotation matrix from rvec.
     *
     * Handles two input formats:
     *   - 3x3 rotation matrix (e.g. from anipose TOML): returned directly
     *   - 3-element Rodrigues vector: converted via Rodrigues formula
     *
     * @returns {number[][]} 3x3 rotation matrix
     */
    get rotationMatrix() {
        // If rvec is already a 3x3 rotation matrix, return it directly.
        // This handles anipose TOML format which stores rotation as a matrix.
        if (Array.isArray(this.rvec) && Array.isArray(this.rvec[0])) {
            return this.rvec;
        }

        const [rx, ry, rz] = this.rvec;
        const theta = Math.sqrt(rx * rx + ry * ry + rz * rz);

        // If theta is near zero, rotation is identity
        if (theta < 1e-12) {
            return [
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1]
            ];
        }

        // Unit axis
        const kx = rx / theta;
        const ky = ry / theta;
        const kz = rz / theta;

        // Skew-symmetric matrix K of the unit axis k
        //     [  0, -kz,  ky ]
        // K = [ kz,   0, -kx ]
        //     [-ky,  kx,   0 ]
        const K = [
            [0, -kz, ky],
            [kz, 0, -kx],
            [-ky, kx, 0]
        ];

        // K*K (matrix multiply K by K)
        const KK = mat3x3Multiply(K, K);

        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);
        const oneMinusCosT = 1 - cosT;

        // R = I + sin(theta)*K + (1 - cos(theta))*K*K
        const R = [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0]
        ];
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                R[i][j] = (i === j ? 1 : 0) + sinT * K[i][j] + oneMinusCosT * KK[i][j];
            }
        }
        return R;
    }

    /**
     * Compute the 3x4 extrinsic matrix [R | t].
     * @returns {number[][]} 3x4 matrix
     */
    get extrinsicMatrix() {
        const R = this.rotationMatrix;
        const t = this.tvec;
        return [
            [R[0][0], R[0][1], R[0][2], t[0]],
            [R[1][0], R[1][1], R[1][2], t[1]],
            [R[2][0], R[2][1], R[2][2], t[2]]
        ];
    }

    /**
     * Compute the 3x4 projection matrix P = K * [R | t].
     * @returns {number[][]} 3x4 projection matrix
     */
    get projectionMatrix() {
        const K = this.matrix;
        const Rt = this.extrinsicMatrix;
        return mat3x3Multiply3x4(K, Rt);
    }

    /**
     * Project a single 3D point [x, y, z] to 2D [u, v] using the projection matrix.
     * No distortion applied (for simplicity).
     * @param {number[]} point3d - [x, y, z]
     * @returns {number[]} [u, v]
     */
    project(point3d) {
        const P = this.projectionMatrix;
        const [X, Y, Z] = point3d;

        // Homogeneous multiplication: [u', v', w'] = P * [X, Y, Z, 1]^T
        const w = P[2][0] * X + P[2][1] * Y + P[2][2] * Z + P[2][3];
        const u = (P[0][0] * X + P[0][1] * Y + P[0][2] * Z + P[0][3]) / w;
        const v = (P[1][0] * X + P[1][1] * Y + P[1][2] * Z + P[1][3]) / w;

        return [u, v];
    }

    /**
     * Project an array of 3D points to 2D.
     * @param {number[][]} points3d - Array of [x, y, z]
     * @returns {number[][]} Array of [u, v]
     */
    projectPoints(points3d) {
        return points3d.map(p => this.project(p));
    }
}


class Instance {
    /**
     * @param {(number[]|null)[]} points - Array of [u, v] 2D keypoints (null if not visible)
     * @param {number} trackIdx - Track index
     * @param {'user'|'predicted'} type
     * @param {number} score - Confidence 0-1
     */
    constructor(points, trackIdx, type, score) {
        this.points = points;
        this.trackIdx = trackIdx;
        this.type = type;
        this.score = score;
        /** @type {boolean} Whether the user has edited this instance */
        this.modified = false;
        /** @type {(number[]|null)[]|null} Backup of original points before editing */
        this._originalPoints = null;
    }

    /**
     * Set visibility of a specific point by node index.
     * When hiding, the point is set to null. When showing, it is restored
     * from the backup (_originalPoints) if available.
     * @param {number} nodeIdx
     * @param {boolean} visible
     */
    setPointVisible(nodeIdx, visible) {
        if (nodeIdx < 0 || nodeIdx >= this.points.length) return;
        if (visible) {
            // Restore from backup if available
            if (!this.points[nodeIdx] && this._originalPoints && this._originalPoints[nodeIdx]) {
                this.points[nodeIdx] = clonePoints([this._originalPoints[nodeIdx]])[0];
            }
        } else {
            this.points[nodeIdx] = null;
        }
    }

    /**
     * Save a backup of the current points as _originalPoints.
     * Subsequent calls overwrite the previous backup.
     */
    backupPoints() {
        this._originalPoints = clonePoints(this.points);
    }

    /**
     * Restore points from the _originalPoints backup.
     * Does nothing if no backup exists.
     */
    restorePoints() {
        if (this._originalPoints) {
            this.points = clonePoints(this._originalPoints);
        }
    }
}


/** Auto-incrementing ID counter for UnlinkedInstance */
let _unlinkedIdCounter = 0;

class UnlinkedInstance {
    /**
     * A 2D prediction in a single camera view that has not yet been assigned
     * to a cross-view InstanceGroup.
     *
     * @param {Instance} instance - The 2D instance data
     * @param {string} cameraName - Which camera view this belongs to
     * @param {number} [id] - Unique ID (auto-generated if not provided)
     */
    constructor(instance, cameraName, id) {
        this.instance = instance;
        this.cameraName = cameraName;
        this.id = id !== undefined ? id : _unlinkedIdCounter++;
    }
}


class FrameGroup {
    /**
     * @param {number} frameIdx
     */
    constructor(frameIdx) {
        this.frameIdx = frameIdx;
        /** @type {Map<string, Instance[]>} camera name -> instances in that view */
        this.instances = new Map();
        /** @type {Map<string, UnlinkedInstance[]>} camera name -> unlinked instances */
        this.unlinkedInstances = new Map();
    }

    /**
     * Add an instance for a given camera view.
     * @param {string} cameraName
     * @param {Instance} instance
     */
    addInstance(cameraName, instance) {
        if (!this.instances.has(cameraName)) {
            this.instances.set(cameraName, []);
        }
        this.instances.get(cameraName).push(instance);
    }

    /**
     * Get all instances for a given camera view.
     * @param {string} cameraName
     * @returns {Instance[]}
     */
    getInstances(cameraName) {
        return this.instances.get(cameraName) || [];
    }

    /**
     * Add an unlinked instance for a given camera view.
     * @param {string} cameraName
     * @param {UnlinkedInstance} unlinked
     */
    addUnlinkedInstance(cameraName, unlinked) {
        if (!this.unlinkedInstances.has(cameraName)) {
            this.unlinkedInstances.set(cameraName, []);
        }
        this.unlinkedInstances.get(cameraName).push(unlinked);
    }

    /**
     * Get all unlinked instances for a given camera view.
     * @param {string} cameraName
     * @returns {UnlinkedInstance[]}
     */
    getUnlinkedInstances(cameraName) {
        return this.unlinkedInstances.get(cameraName) || [];
    }

    /**
     * Remove an unlinked instance by ID.
     * @param {number} unlinkedId
     * @returns {UnlinkedInstance|null} The removed instance, or null
     */
    removeUnlinkedById(unlinkedId) {
        for (const [camName, list] of this.unlinkedInstances) {
            for (let i = 0; i < list.length; i++) {
                if (list[i].id === unlinkedId) {
                    return list.splice(i, 1)[0];
                }
            }
        }
        return null;
    }
}


class InstanceGroup {
    /**
     * @param {number} id
     * @param {number} trackIdx
     */
    constructor(id, trackIdx) {
        this.id = id;
        this.trackIdx = trackIdx;
        /** @type {Map<string, Instance>} camera name -> single instance */
        this.instances = new Map();
        /** @type {number[][]|null} N x [x, y, z] triangulated 3D points, or null */
        this.points3d = null;
        /** @type {boolean} True when re-triangulation is needed */
        this.dirty = false;
        /** @type {Set<string>|null} Camera names used for last triangulation */
        this.usedCameras = null;
    }

    /**
     * Add (or replace) the instance for a given camera view.
     * @param {string} cameraName
     * @param {Instance} instance
     */
    addInstance(cameraName, instance) {
        this.instances.set(cameraName, instance);
    }

    /**
     * Get the instance for a given camera view.
     * @param {string} cameraName
     * @returns {Instance|undefined}
     */
    getInstance(cameraName) {
        return this.instances.get(cameraName);
    }

    /**
     * List of camera names that have instances in this group.
     * @returns {string[]}
     */
    get cameraNames() {
        return Array.from(this.instances.keys());
    }

    /**
     * Mark this group as needing re-triangulation.
     */
    markDirty() {
        this.dirty = true;
    }

    /**
     * Mark this group as up-to-date (no re-triangulation needed).
     */
    markClean() {
        this.dirty = false;
    }
}


class Session {
    /**
     * @param {Camera[]} cameras
     * @param {Skeleton} skeleton
     * @param {string[]} tracks - Track names
     */
    constructor(cameras, skeleton, tracks) {
        this.cameras = cameras;
        this.skeleton = skeleton;
        this.tracks = tracks;
        /** @type {Map<number, FrameGroup>} frameIdx -> FrameGroup */
        this.frameGroups = new Map();
        /** @type {Map<number, Map<number, InstanceGroup[]>>} frameIdx -> trackIdx -> InstanceGroup[] */
        this.instanceGroups = new Map();
    }

    /**
     * Add a FrameGroup for a given frame index.
     * @param {FrameGroup} frameGroup
     */
    addFrameGroup(frameGroup) {
        this.frameGroups.set(frameGroup.frameIdx, frameGroup);
    }

    /**
     * Get the FrameGroup for a given frame index.
     * @param {number} frameIdx
     * @returns {FrameGroup|undefined}
     */
    getFrameGroup(frameIdx) {
        return this.frameGroups.get(frameIdx);
    }

    /**
     * Sorted list of all frame indices.
     * @returns {number[]}
     */
    get frameIndices() {
        return Array.from(this.frameGroups.keys()).sort((a, b) => a - b);
    }

    /**
     * Number of frames in the session.
     * @returns {number}
     */
    get numFrames() {
        return this.frameGroups.size;
    }

    /**
     * Create a new empty Instance and add it to the FrameGroup for the given frame and camera.
     * If no FrameGroup exists for the frame, one is created automatically.
     * @param {number} frameIdx
     * @param {string} cameraName
     * @param {Skeleton} skeleton - Used to determine the number of nodes
     * @param {number} trackIdx
     * @returns {Instance} The newly created instance
     */
    addNewInstance(frameIdx, cameraName, skeleton, trackIdx) {
        // Build an empty points array (all null) matching the skeleton node count
        const numNodes = skeleton && skeleton.nodes ? skeleton.nodes.length : 0;
        const points = new Array(numNodes).fill(null);

        const instance = new Instance(points, trackIdx, 'user', 0);
        instance.modified = true;

        // Ensure a FrameGroup exists for this frame
        if (!this.frameGroups.has(frameIdx)) {
            this.addFrameGroup(new FrameGroup(frameIdx));
        }
        const fg = this.frameGroups.get(frameIdx);
        fg.addInstance(cameraName, instance);

        return instance;
    }

    /**
     * Remove an instance from the FrameGroup at the given frame and camera by index.
     * @param {number} frameIdx
     * @param {string} cameraName
     * @param {number} instanceIdx - Index into the camera's instance array
     * @returns {Instance|null} The removed instance, or null if not found
     */
    removeInstance(frameIdx, cameraName, instanceIdx) {
        const fg = this.frameGroups.get(frameIdx);
        if (!fg) return null;
        const camInstances = fg.instances.get(cameraName);
        if (!camInstances || instanceIdx < 0 || instanceIdx >= camInstances.length) return null;
        const removed = camInstances.splice(instanceIdx, 1);
        return removed.length > 0 ? removed[0] : null;
    }

    /**
     * Get a flat array of all InstanceGroup objects for a given frame index,
     * across all tracks.
     * @param {number} frameIdx
     * @returns {InstanceGroup[]}
     */
    getInstanceGroupsForFrame(frameIdx) {
        const trackMap = this.instanceGroups.get(frameIdx);
        if (!trackMap) return [];
        const result = [];
        for (const groups of trackMap.values()) {
            for (let i = 0; i < groups.length; i++) {
                result.push(groups[i]);
            }
        }
        return result;
    }

    /**
     * Convert a predicted InstanceGroup to a user-edited one.
     * Sets type='user' and modified=true on every Instance in the group.
     * @param {InstanceGroup} instanceGroup
     */
    convertPredictedToUser(instanceGroup) {
        for (const instance of instanceGroup.instances.values()) {
            instance.type = 'user';
            instance.modified = true;
        }
    }

    /**
     * Add an unlinked instance at a given frame and camera.
     * Creates a FrameGroup if needed.
     *
     * @param {number} frameIdx
     * @param {string} cameraName
     * @param {Instance} instance
     * @returns {UnlinkedInstance}
     */
    addUnlinkedInstance(frameIdx, cameraName, instance) {
        if (!this.frameGroups.has(frameIdx)) {
            this.addFrameGroup(new FrameGroup(frameIdx));
        }
        const fg = this.frameGroups.get(frameIdx);
        const unlinked = new UnlinkedInstance(instance, cameraName);
        fg.addUnlinkedInstance(cameraName, unlinked);
        return unlinked;
    }

    /**
     * Create an InstanceGroup from an array of UnlinkedInstances.
     * Removes them from their respective FrameGroup unlinked lists.
     *
     * @param {number} frameIdx
     * @param {UnlinkedInstance[]} unlinkedList - Must have at least 1 entry
     * @param {number} [trackIdx] - Track index (auto-determined if not provided)
     * @returns {InstanceGroup} The newly created group
     */
    createGroupFromUnlinked(frameIdx, unlinkedList, trackIdx) {
        const fg = this.frameGroups.get(frameIdx);
        if (!fg) throw new Error('No FrameGroup for frame ' + frameIdx);

        // Determine track index
        if (trackIdx === undefined) {
            const existing = this.getInstanceGroupsForFrame(frameIdx);
            const usedTracks = new Set(existing.map(function (g) { return g.trackIdx; }));
            trackIdx = 0;
            while (usedTracks.has(trackIdx)) trackIdx++;
        }

        const group = new InstanceGroup(Date.now(), trackIdx);

        for (let i = 0; i < unlinkedList.length; i++) {
            const ul = unlinkedList[i];
            group.addInstance(ul.cameraName, ul.instance);

            // Also add to FrameGroup.instances for overlay rendering
            fg.addInstance(ul.cameraName, ul.instance);

            // Remove from unlinked lists
            fg.removeUnlinkedById(ul.id);
        }

        // Store in instanceGroups map
        if (!this.instanceGroups.has(frameIdx)) {
            this.instanceGroups.set(frameIdx, new Map());
        }
        const trackMap = this.instanceGroups.get(frameIdx);
        if (!trackMap.has(trackIdx)) {
            trackMap.set(trackIdx, []);
        }
        trackMap.get(trackIdx).push(group);

        return group;
    }

    /**
     * Rename a camera key in all data structures (FrameGroups, UnlinkedInstances, InstanceGroups).
     * Used when calibration is loaded and camera names change (e.g., "CamA" → "A").
     *
     * @param {string} oldName - The old camera name
     * @param {string} newName - The new camera name
     */
    renameCameraInAllData(oldName, newName) {
        if (oldName === newName) return;

        // Rename in all FrameGroups
        for (const fg of this.frameGroups.values()) {
            // Rename in fg.instances (Map<string, Instance[]>)
            if (fg.instances.has(oldName)) {
                const insts = fg.instances.get(oldName);
                fg.instances.delete(oldName);
                if (fg.instances.has(newName)) {
                    // Merge into existing
                    for (const inst of insts) fg.instances.get(newName).push(inst);
                } else {
                    fg.instances.set(newName, insts);
                }
            }

            // Rename in fg.unlinkedInstances (Map<string, UnlinkedInstance[]>)
            if (fg.unlinkedInstances.has(oldName)) {
                const uls = fg.unlinkedInstances.get(oldName);
                fg.unlinkedInstances.delete(oldName);
                for (const ul of uls) ul.cameraName = newName;
                if (fg.unlinkedInstances.has(newName)) {
                    for (const ul of uls) fg.unlinkedInstances.get(newName).push(ul);
                } else {
                    fg.unlinkedInstances.set(newName, uls);
                }
            }
        }

        // Rename in all InstanceGroups
        for (const trackMap of this.instanceGroups.values()) {
            for (const groups of trackMap.values()) {
                for (const group of groups) {
                    if (group.instances.has(oldName)) {
                        const inst = group.instances.get(oldName);
                        group.instances.delete(oldName);
                        group.instances.set(newName, inst);
                    }
                }
            }
        }
    }

    /**
     * Propagate a skeleton node addition to all instances.
     * Adds a null point at the end of every Instance.points array.
     */
    propagateNodeAdded() {
        // Update all instances in FrameGroups
        for (const fg of this.frameGroups.values()) {
            for (const instances of fg.instances.values()) {
                for (const inst of instances) {
                    inst.points.push(null);
                    if (inst._originalPoints) inst._originalPoints.push(null);
                }
            }
            for (const unlinkedList of fg.unlinkedInstances.values()) {
                for (const ul of unlinkedList) {
                    ul.instance.points.push(null);
                    if (ul.instance._originalPoints) ul.instance._originalPoints.push(null);
                }
            }
        }
    }

    /**
     * Propagate a skeleton node removal to all instances.
     * Splices out the point at nodeIdx from every Instance.points array.
     * @param {number} nodeIdx - The index of the removed node
     */
    propagateNodeRemoved(nodeIdx) {
        for (const fg of this.frameGroups.values()) {
            for (const instances of fg.instances.values()) {
                for (const inst of instances) {
                    if (inst.points.length > nodeIdx) {
                        inst.points.splice(nodeIdx, 1);
                    }
                    if (inst._originalPoints && inst._originalPoints.length > nodeIdx) {
                        inst._originalPoints.splice(nodeIdx, 1);
                    }
                }
            }
            for (const unlinkedList of fg.unlinkedInstances.values()) {
                for (const ul of unlinkedList) {
                    if (ul.instance.points.length > nodeIdx) {
                        ul.instance.points.splice(nodeIdx, 1);
                    }
                    if (ul.instance._originalPoints && ul.instance._originalPoints.length > nodeIdx) {
                        ul.instance._originalPoints.splice(nodeIdx, 1);
                    }
                }
            }
        }
        // Mark all instance groups as dirty (triangulation needs recomputing)
        for (const trackMap of this.instanceGroups.values()) {
            for (const groups of trackMap.values()) {
                for (const group of groups) {
                    group.markDirty();
                    group.points3d = null;
                }
            }
        }
    }

    /**
     * Remove an InstanceGroup from a given frame.
     * Also removes its linked instances from the FrameGroup.
     *
     * @param {number} frameIdx
     * @param {InstanceGroup} group - The group to remove
     * @returns {boolean} True if the group was found and removed
     */
    removeInstanceGroup(frameIdx, group) {
        // Remove from instanceGroups map
        const trackMap = this.instanceGroups.get(frameIdx);
        let removed = false;
        if (trackMap) {
            for (const [trackIdx, groups] of trackMap) {
                const idx = groups.indexOf(group);
                if (idx >= 0) {
                    groups.splice(idx, 1);
                    removed = true;
                    // Clean up empty track entries
                    if (groups.length === 0) {
                        trackMap.delete(trackIdx);
                    }
                    break;
                }
            }
            // Clean up empty frame entries
            if (trackMap.size === 0) {
                this.instanceGroups.delete(frameIdx);
            }
        }

        // Remove associated instances from the FrameGroup
        const fg = this.frameGroups.get(frameIdx);
        if (fg) {
            for (const [camName, instance] of group.instances) {
                const camInstances = fg.instances.get(camName);
                if (camInstances) {
                    const instIdx = camInstances.indexOf(instance);
                    if (instIdx >= 0) {
                        camInstances.splice(instIdx, 1);
                    }
                    // Clean up empty camera entries
                    if (camInstances.length === 0) {
                        fg.instances.delete(camName);
                    }
                }
            }
            // Clean up empty FrameGroups
            if (fg.instances.size === 0 && fg.unlinkedInstances.size === 0) {
                this.frameGroups.delete(frameIdx);
            }
        }

        return removed;
    }

    /**
     * Assign an unlinked instance to an existing InstanceGroup.
     * Removes it from the unlinked list and adds to the group.
     *
     * @param {number} frameIdx
     * @param {UnlinkedInstance} unlinked
     * @param {InstanceGroup} group
     */
    assignToGroup(frameIdx, unlinked, group) {
        const fg = this.frameGroups.get(frameIdx);
        if (!fg) return;

        group.addInstance(unlinked.cameraName, unlinked.instance);
        fg.addInstance(unlinked.cameraName, unlinked.instance);
        fg.removeUnlinkedById(unlinked.id);
        group.markDirty();
    }
}


// --------------------------------------------------------------------------
// Points helper
// --------------------------------------------------------------------------

/**
 * Deep clone a points array. Each element is either [u, v] or null.
 * @param {(number[]|null)[]} points
 * @returns {(number[]|null)[]}
 */
function clonePoints(points) {
    if (!points) return null;
    const cloned = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        cloned[i] = pt != null ? [pt[0], pt[1]] : null;
    }
    return cloned;
}


// --------------------------------------------------------------------------
// Linear algebra helpers (module-level utility functions)
// --------------------------------------------------------------------------

/**
 * Multiply two 3x3 matrices.
 * @param {number[][]} A - 3x3
 * @param {number[][]} B - 3x3
 * @returns {number[][]} 3x3 result
 */
function mat3x3Multiply(A, B) {
    const C = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0]
    ];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            for (let k = 0; k < 3; k++) {
                C[i][j] += A[i][k] * B[k][j];
            }
        }
    }
    return C;
}

/**
 * Multiply a 3x3 matrix by a 3x4 matrix.
 * @param {number[][]} A - 3x3
 * @param {number[][]} B - 3x4
 * @returns {number[][]} 3x4 result
 */
function mat3x3Multiply3x4(A, B) {
    const C = [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0]
    ];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 4; j++) {
            for (let k = 0; k < 3; k++) {
                C[i][j] += A[i][k] * B[k][j];
            }
        }
    }
    return C;
}
