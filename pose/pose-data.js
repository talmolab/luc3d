// pose-data.js - Data model for multi-view pose data
// All vanilla JS classes, no imports/exports.

/**
 * Name of the dedicated track that `propagateIdentitiesToTracks` collects
 * explicitly-un-identified ("no identity") instances onto. Treated as the
 * null track everywhere: rendered in `NULL_ID_COLOR` (the same gray the ID
 * panel uses for its "No ID" row) rather than a palette color.
 */
export const NO_ID_TRACK_NAME = 'No ID';

/**
 * Parse a `Session.frameIdentityMap` key ("frameIdx:camName:trackIdx") into
 * its parts. Splits on the FIRST colon for frameIdx and the LAST colon for
 * trackIdx — camera names aren't guaranteed colon-free, so a naive 3-way
 * split would misparse one whose name contains ':'. Mirrors the equivalent
 * inline parsing in `ui/timeline.js` (`_parseFrameIdentityKey`) and
 * `ui/track-identity-ops.js` (`deleteTrackAt`) — duplicated rather than
 * imported since this file is deliberately import/export-free vanilla JS.
 * @param {string} key
 * @returns {{frameIdx: number, camName: string, trackIdx: number}|null}
 */
function _parseFrameIdentityKey(key) {
    var i1 = key.indexOf(':');
    var i2 = key.lastIndexOf(':');
    if (i1 < 0 || i2 <= i1) return null;
    var frameIdx = parseInt(key.substring(0, i1), 10);
    var trackIdx = parseInt(key.substring(i2 + 1), 10);
    var camName = key.substring(i1 + 1, i2);
    if (!Number.isFinite(frameIdx) || !Number.isFinite(trackIdx)) return null;
    return { frameIdx: frameIdx, camName: camName, trackIdx: trackIdx };
}

/*
 * ---------------------------------------------------------------------------
 * `frameIdentityMap` key codec (luc3d #185 follow-up #3)
 * ---------------------------------------------------------------------------
 * `Session.frameIdentityMap` maps (frameIdx, camera, rawTrackIdx) -> identityId
 * and holds ONE ENTRY PER 2D DETECTION in the project: 2,627,447 of them on the
 * real 180,210-frame x 5-camera project. Keyed by the string
 * `"frameIdx:camName:trackIdx"` that cost a measured **132 MB** of V8's
 * pointer-compressed heap (strip-and-GC attribution), which a Chrome renderer
 * hard-caps near 4 GB — and that ceiling is what makes both the merged save and
 * the project reload fail on that project.
 *
 * Keys are now packed into a single exact-integer Number, so the Map holds no
 * per-entry string at all:
 *
 *     key = frameIdx * 2^23  +  camIdx * 2^17  +  (trackIdx + 1)
 *
 * Bit budget (total 53, the exact-integer limit for IEEE-754 doubles):
 *   - low  17 bits: `trackIdx + 1`, so the -1 "untracked/no-identity" sentinel
 *     encodes as 0. Range trackIdx in [-1, 131070].
 *   - next  6 bits: camera INDEX into `session.cameras` (up to 64 cameras).
 *   - top  30 bits: frameIdx (up to 1,073,741,823 frames).
 *
 * Anything outside those ranges cannot be encoded; `Session._fimKey` returns
 * null and its callers fall back to the legacy string key so such a project
 * keeps working (correctness over compactness) rather than silently dropping
 * identities. `_fimIsPacked` distinguishes the two at read time.
 *
 * ON-DISK FORMAT IS UNCHANGED: `Session.exportFrameIdentityEntries()` emits the
 * original `"frameIdx:camName:trackIdx"` strings, and
 * `ingestFrameIdentityEntries()` accepts BOTH packed numbers and legacy strings.
 * Every already-saved project — including the real 1.4 GB one — keeps loading,
 * and files written now stay readable by older builds.
 */
var FIM_TRACK_STRIDE = 131072;                        // 2^17
var FIM_CAM_STRIDE = FIM_TRACK_STRIDE * 64;           // 2^23
var FIM_MAX_CAM = 63;
var FIM_MAX_TRACK = FIM_TRACK_STRIDE - 2;             // trackIdx+1 must fit in 17 bits
var FIM_MAX_FRAME = 1073741823;                       // 2^30 - 1

/** True for a packed numeric key (as opposed to a legacy string key). */
function _fimIsPacked(key) {
    return typeof key === 'number';
}

/**
 * Pack (frameIdx, camIdx, trackIdx) into one exact-integer Number.
 * @returns {number|null} null when any component is out of encodable range
 */
function _fimPack(frameIdx, camIdx, trackIdx) {
    if (!Number.isInteger(frameIdx) || frameIdx < 0 || frameIdx > FIM_MAX_FRAME) return null;
    if (!Number.isInteger(camIdx) || camIdx < 0 || camIdx > FIM_MAX_CAM) return null;
    if (!Number.isInteger(trackIdx) || trackIdx < -1 || trackIdx > FIM_MAX_TRACK) return null;
    return frameIdx * FIM_CAM_STRIDE + camIdx * FIM_TRACK_STRIDE + (trackIdx + 1);
}

/**
 * Inverse of `_fimPack`.
 * @returns {{frameIdx:number, camIdx:number, trackIdx:number}}
 */
function _fimUnpack(key) {
    var frameIdx = Math.floor(key / FIM_CAM_STRIDE);
    var rem = key - frameIdx * FIM_CAM_STRIDE;
    var camIdx = Math.floor(rem / FIM_TRACK_STRIDE);
    return { frameIdx: frameIdx, camIdx: camIdx, trackIdx: (rem - camIdx * FIM_TRACK_STRIDE) - 1 };
}

export class Skeleton {
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

    /**
     * Deep copy with fresh nodes/edges arrays so the clone shares no mutable
     * state with this skeleton (used to seed new sessions without aliasing).
     * @returns {Skeleton}
     */
    clone() {
        return new Skeleton(
            this.name,
            this.nodes.slice(),
            this.edges.map(function (e) { return [e[0], e[1]]; })
        );
    }

    /**
     * Canonical, order-independent identity of this skeleton's *shape*: the set
     * of node names plus the set of edges expressed as unordered name pairs. Two
     * skeletons share a key iff they have the same node names and the same edges
     * regardless of node ordering — exactly the condition under which a copied
     * instance can be pasted onto another skeleton (points are remapped by node
     * name). Used by the instance copy/paste feature.
     * @returns {string}
     */
    compatibilityKey() {
        var nodes = this.nodes;
        var names = nodes.slice().sort();
        var edges = this.edges.map(function (e) {
            var a = nodes[e[0]], b = nodes[e[1]];
            return a < b ? a + '\u0001' + b : b + '\u0001' + a;
        }).sort();
        return names.join('\u0000') + '\u0002' + edges.join('\u0000');
    }
}


export class Camera {
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
        if (this._cachedR) return this._cachedR;

        // If rvec is already a 3x3 rotation matrix, return it directly.
        // This handles anipose TOML format which stores rotation as a matrix.
        if (Array.isArray(this.rvec) && Array.isArray(this.rvec[0])) {
            this._cachedR = this.rvec;
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
        this._cachedR = R;
        return R;
    }

    /**
     * Compute the 3x4 extrinsic matrix [R | t].
     * @returns {number[][]} 3x4 matrix
     */
    get extrinsicMatrix() {
        if (this._cachedRt) return this._cachedRt;
        const R = this.rotationMatrix;
        const t = this.tvec;
        this._cachedRt = [
            [R[0][0], R[0][1], R[0][2], t[0]],
            [R[1][0], R[1][1], R[1][2], t[1]],
            [R[2][0], R[2][1], R[2][2], t[2]]
        ];
        return this._cachedRt;
    }

    /**
     * Compute the 3x4 projection matrix P = K * [R | t].
     * @returns {number[][]} 3x4 projection matrix
     */
    get projectionMatrix() {
        if (!this._cachedP) {
            const K = this.matrix;
            const Rt = this.extrinsicMatrix;
            this._cachedP = mat3x3Multiply3x4(K, Rt);
        }
        return this._cachedP;
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

    /**
     * Undistort a 2D pixel point using OpenCV's distortion model.
     * Converts distorted pixel coords to ideal (undistorted) pixel coords.
     * Uses iterative refinement (OpenCV's undistortPoints approach).
     *
     * @param {number[]} point2d - [u, v] distorted pixel coordinates
     * @returns {number[]} [u, v] undistorted pixel coordinates
     */
    undistortPoint(point2d) {
        const K = this.matrix;
        const d = this.dist;
        if (!d || (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 0 && (d.length < 5 || d[4] === 0))) {
            return point2d; // No distortion
        }

        const fx = K[0][0], fy = K[1][1], cx = K[0][2], cy = K[1][2];
        const k1 = d[0], k2 = d[1], p1 = d[2], p2 = d[3], k3 = d.length > 4 ? d[4] : 0;

        // Normalize to camera coordinates
        let x = (point2d[0] - cx) / fx;
        let y = (point2d[1] - cy) / fy;

        // Iterative undistortion (Newton's method, ~10 iterations is plenty)
        let x0 = x, y0 = y;
        for (let iter = 0; iter < 10; iter++) {
            const r2 = x * x + y * y;
            const r4 = r2 * r2;
            const r6 = r4 * r2;
            const radial = 1 + k1 * r2 + k2 * r4 + k3 * r6;
            const dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
            const dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
            x = (x0 - dx) / radial;
            y = (y0 - dy) / radial;
        }

        // Back to pixel coordinates
        return [x * fx + cx, y * fy + cy];
    }

    /**
     * Apply the OpenCV distortion model to an ideal (undistorted) pixel point.
     * Converts ideal pinhole pixel coords to the distorted pixel coords that the
     * real (lens-distorted) camera would observe. This is the forward inverse of
     * `undistortPoint`.
     *
     * Used to re-distort reprojected 3D points back into the native image space
     * so reprojection markers and errors line up with the raw observed keypoints
     * — without it, reprojections drift outward near the frame edges ("fisheyed
     * coordinates") wherever radial distortion is significant.
     *
     * @param {number[]} point2d - [u, v] ideal (undistorted) pixel coordinates
     * @returns {number[]} [u, v] distorted pixel coordinates
     */
    distortPoint(point2d) {
        const K = this.matrix;
        const d = this.dist;
        if (!d || (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 0 && (d.length < 5 || d[4] === 0))) {
            return point2d; // No distortion
        }

        const fx = K[0][0], fy = K[1][1], cx = K[0][2], cy = K[1][2];
        const k1 = d[0], k2 = d[1], p1 = d[2], p2 = d[3], k3 = d.length > 4 ? d[4] : 0;

        // Ideal pixel -> normalized camera coordinates
        const x = (point2d[0] - cx) / fx;
        const y = (point2d[1] - cy) / fy;

        const r2 = x * x + y * y;
        const r4 = r2 * r2;
        const r6 = r4 * r2;
        const radial = 1 + k1 * r2 + k2 * r4 + k3 * r6;

        // Tangential distortion
        const xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
        const yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;

        // Distorted normalized -> pixel coordinates
        return [xd * fx + cx, yd * fy + cy];
    }
}


/**
 * A 2D pose in one camera view.
 *
 * ## Storage (luc3d #189 follow-up #1)
 *
 * Coordinates live in a flat **`Float64Array(2 * nNodes)`** (`_xy`) — node `k`
 * at `[2k, 2k+1]` — with **NaN in the x slot meaning "no point"**, replacing the
 * old `null` row. Occlusion lives in a **bit set** (`_occ`): a plain Number when
 * `nNodes <= 32`, else a `Uint32Array`.
 *
 * WHY: this project's real workload holds 2,630,632 Instances (5 cameras x
 * ~526,000 each) covering 39,459,480 keypoints. As boxed `[u,v]|null` rows plus
 * a `boolean[]`, that measured **824 B per instance = 2,065 MB**, all of it in
 * V8's pointer-compressed heap, which a Chrome renderer hard-caps near 4 GB.
 * Flat, it is **168 B per instance in the cage (421 MB)** plus a backing store
 * allocated outside the cap. Measured, not modelled:
 * `tests/e2e/_diag-repr-sizing.mjs`.
 *
 * f64 rather than f32 is deliberate — identical cage cost (only the external
 * store doubles), and every coordinate stays bit-identical, so
 * `tests/e2e/save-golden-digest.mjs` gates the conversion byte-for-byte.
 *
 * ## The `points` / `occluded` fields are GONE, on purpose
 *
 * They are not kept as compatibility getters. Two of the three ways this
 * refactor could go wrong are SILENT rather than loud:
 *   - `inst.points.length` meant *nNodes* at ~30 sites; on a `Float64Array(2n)`
 *     it silently DOUBLES instead of throwing.
 *   - `inst.occluded[k]` on a Number bitmask silently yields `undefined`
 *     (falsy), so occlusion would vanish from every export with no error.
 * Removing the fields converts both classes of bug into an immediate
 * `TypeError: Cannot read properties of undefined`. Use the accessors below.
 *
 * The CONSTRUCTOR still takes the boxed form (or a `Float64Array`) and
 * normalizes, so the ~23 construction sites are unchanged.
 */
export class Instance {
    /**
     * @param {(number[]|null)[]|Float64Array} points - Boxed `[u,v]|null` rows
     *   (normalized to the flat form) or an already-flat `Float64Array(2n)`,
     *   which is ADOPTED by reference.
     * @param {number} trackIdx - Track index
     * @param {'user'|'predicted'|'reprojected'} type
     * @param {number} score - Confidence 0-1
     */
    constructor(points, trackIdx, type, score) {
        /** @type {Float64Array} Flat [u,v] per node; NaN x = no point. */
        this._xy = xyFromPoints(points);
        /** @type {number|Uint32Array} Occlusion bit set. */
        this._occ = makeOccSet(this._xy.length >> 1);
        this.trackIdx = trackIdx;
        this.type = type;
        this.score = score;
        /**
         * @type {number|null} Identity carried by a TRACKLESS UNLINKED
         * instance (luc3d #201). `frameIdentityMap` is keyed by raw trackIdx,
         * so a null track keys one shared per-camera slot that cannot name an
         * individual — this field is where an ungrouped trackless detection's
         * identity lives instead. Stamped by `Session.unlinkGroup` from the
         * disbanding group's `identityId`, consumed (and cleared) when the
         * instance joins a group again. Ignored while the instance is grouped
         * or has a track; not persisted to SLP.
         */
        this.identityId = null;
        /** @type {boolean} Whether the user has edited this instance */
        this.modified = false;
        /** @type {Float64Array|null} Backup of original coords before editing */
        this._originalXY = null;
        /** @type {number|Uint32Array|null} Backup of original occlusion */
        this._originalOcc = null;
    }

    /** Number of skeleton nodes this instance covers. @returns {number} */
    get numNodes() { return this._xy.length >> 1; }

    /** Does node `k` have a position? @param {number} k @returns {boolean} */
    hasPoint(k) {
        return k >= 0 && k < this.numNodes && !Number.isNaN(this._xy[k << 1]);
    }

    /** X of node `k` (NaN when absent). @param {number} k @returns {number} */
    getX(k) { return this._xy[k << 1]; }
    /** Y of node `k` (NaN when absent). @param {number} k @returns {number} */
    getY(k) { return this._xy[(k << 1) + 1]; }

    /**
     * Node `k` as a boxed `[u,v]`, or null when absent. ALLOCATES — use
     * `readPoint` inside loops.
     * @param {number} k @returns {number[]|null}
     */
    getPoint(k) {
        if (!this.hasPoint(k)) return null;
        const o = k << 1;
        return [this._xy[o], this._xy[o + 1]];
    }

    /**
     * Allocation-free read of node `k` into a caller-owned 2-element `out`.
     * @param {number} k @param {number[]} out @returns {number[]|null}
     */
    readPoint(k, out) {
        if (!this.hasPoint(k)) return null;
        const o = k << 1;
        out[0] = this._xy[o]; out[1] = this._xy[o + 1];
        return out;
    }

    /** Set node `k`. @param {number} k @param {number} x @param {number} y */
    setPoint(k, x, y) {
        if (k < 0 || k >= this.numNodes) return;
        const o = k << 1;
        this._xy[o] = x; this._xy[o + 1] = y;
    }

    /**
     * Set node `k` from a boxed `[u,v]`, or clear it when null/undefined.
     * @param {number} k @param {number[]|null} xy
     */
    setPointFrom(k, xy) {
        if (xy == null) this.clearPoint(k);
        else this.setPoint(k, xy[0], xy[1]);
    }

    /** Remove node `k`'s position (and its occlusion flag). @param {number} k */
    clearPoint(k) {
        if (k < 0 || k >= this.numNodes) return;
        const o = k << 1;
        this._xy[o] = NaN; this._xy[o + 1] = NaN;
        this._occ = occSet(this._occ, k, false);
    }

    /** Is node `k` occluded? @param {number} k @returns {boolean} */
    isOccluded(k) { return occGet(this._occ, k); }

    /** Set node `k`'s occlusion. @param {number} k @param {boolean} v */
    setOccluded(k, v) {
        if (k < 0 || k >= this.numNodes) return;
        this._occ = occSet(this._occ, k, !!v);
    }

    /** Does any node carry the occluded flag? @returns {boolean} */
    anyOccluded() {
        for (let k = 0, n = this.numNodes; k < n; k++) if (occGet(this._occ, k)) return true;
        return false;
    }

    /** Any node with a position at all. @returns {boolean} */
    hasAnyPoint() {
        for (let k = 0, n = this.numNodes; k < n; k++) if (this.hasPoint(k)) return true;
        return false;
    }

    /**
     * Any node with a position that is NOT flagged in `nulledNodes` — i.e. a
     * point that may contribute to triangulation. Collapses the repeated
     * `points.some((p, i) => p != null && !nulledNodes.has(i))` idiom.
     * @returns {boolean}
     */
    hasAnyUsablePoint() {
        for (let k = 0, n = this.numNodes; k < n; k++) {
            if (this.hasPoint(k) && !(this.nulledNodes && this.nulledNodes.has(k))) return true;
        }
        return false;
    }

    /** How many nodes have a position. @returns {number} */
    countPoints() {
        let c = 0;
        for (let k = 0, n = this.numNodes; k < n; k++) if (this.hasPoint(k)) c++;
        return c;
    }

    /**
     * Boxed `[[u,v]|null, ...]` view, for the serialization boundaries that must
     * keep emitting the legacy shape (the JSON project format, the JSON label
     * export). ALLOCATES the whole structure.
     * @returns {(number[]|null)[]}
     */
    toPointsArray() {
        const n = this.numNodes, out = new Array(n);
        for (let k = 0; k < n; k++) out[k] = this.getPoint(k);
        return out;
    }

    /** Boxed `boolean[]` occlusion view, for serialization. @returns {boolean[]} */
    toOccludedArray() {
        const n = this.numNodes, out = new Array(n);
        for (let k = 0; k < n; k++) out[k] = occGet(this._occ, k);
        return out;
    }

    /**
     * Replace every coordinate (the old `inst.points = ...`). Accepts boxed rows
     * or a flat `Float64Array`, which is adopted by reference.
     * @param {(number[]|null)[]|Float64Array} points
     */
    setPointsFrom(points) {
        const next = xyFromPoints(points);
        if ((next.length >> 1) !== this.numNodes) this._occ = makeOccSet(next.length >> 1);
        this._xy = next;
    }

    /**
     * Replace occlusion (the old `inst.occluded = ...`) from a boolean/0-1 array.
     * @param {ArrayLike<boolean|number>} arr
     */
    setOccludedFrom(arr) {
        this._occ = makeOccSet(this.numNodes);
        if (!arr) return;
        for (let k = 0, n = Math.min(this.numNodes, arr.length); k < n; k++) {
            if (arr[k]) this._occ = occSet(this._occ, k, true);
        }
    }

    /**
     * Share another instance's coordinate + occlusion buffers BY REFERENCE.
     * Preserves the deliberate aliasing in the lazy-2D hydration path, where a
     * placeholder member adopts the freshly-decoded instance's arrays.
     * @param {Instance} other
     */
    adoptPointsFrom(other) {
        this._xy = other._xy;
        this._occ = other._occ;
    }

    /**
     * Toggle the occluded state of a node.
     * Only works if the point has valid coordinates.
     * @param {number} nodeIdx
     */
    toggleOccluded(nodeIdx) {
        if (nodeIdx < 0 || nodeIdx >= this.numNodes) return;
        if (!this.hasPoint(nodeIdx)) return;
        this._occ = occSet(this._occ, nodeIdx, !occGet(this._occ, nodeIdx));
    }

    /**
     * Set visibility of a specific point by node index.
     * When hiding, the point is cleared. When showing, it is restored
     * from the backup if available.
     * @param {number} nodeIdx
     * @param {boolean} visible
     */
    setPointVisible(nodeIdx, visible) {
        if (nodeIdx < 0 || nodeIdx >= this.numNodes) return;
        if (visible) {
            const o = nodeIdx << 1;
            if (!this.hasPoint(nodeIdx) && this._originalXY &&
                    !Number.isNaN(this._originalXY[o])) {
                this._xy[o] = this._originalXY[o];
                this._xy[o + 1] = this._originalXY[o + 1];
            }
        } else {
            this.clearPoint(nodeIdx);
        }
    }

    /**
     * Save a backup of the current coordinates + occlusion.
     * Subsequent calls overwrite the previous backup.
     */
    backupPoints() {
        this._originalXY = new Float64Array(this._xy);
        this._originalOcc = (typeof this._occ === 'number') ? this._occ : new Uint32Array(this._occ);
    }

    /** Restore coordinates + occlusion from the backup. Does nothing without one. */
    restorePoints() {
        if (this._originalXY) this._xy = new Float64Array(this._originalXY);
        if (this._originalOcc != null) {
            this._occ = (typeof this._originalOcc === 'number')
                ? this._originalOcc : new Uint32Array(this._originalOcc);
        }
    }

    /** Does a backup exist? @returns {boolean} */
    hasBackup() { return this._originalXY != null; }

    /**
     * Insert an empty node at `idx` (skeleton node added). Grows every buffer,
     * including any backup, so a later `restorePoints()` stays node-aligned.
     * @param {number} idx
     */
    insertNodeAt(idx) {
        const n = this.numNodes;
        if (idx < 0 || idx > n) return;
        this._xy = spliceXY(this._xy, idx, 0);
        this._occ = spliceOcc(this._occ, n, idx, 0);
        if (this._originalXY) {
            this._originalOcc = spliceOcc(this._originalOcc, n, idx, 0);
            this._originalXY = spliceXY(this._originalXY, idx, 0);
        }
    }

    /**
     * Remove node `idx` (skeleton node removed). Shrinks every buffer.
     * @param {number} idx
     */
    removeNodeAt(idx) {
        const n = this.numNodes;
        if (idx < 0 || idx >= n) return;
        this._xy = spliceXY(this._xy, idx, 1);
        this._occ = spliceOcc(this._occ, n, idx, 1);
        if (this._originalXY) {
            this._originalOcc = spliceOcc(this._originalOcc, n, idx, 1);
            this._originalXY = spliceXY(this._originalXY, idx, 1);
        }
    }
}


// --------------------------------------------------------------------------
// Instance storage helpers (module-private)
// --------------------------------------------------------------------------

/**
 * Normalize a constructor/setter `points` argument into the flat form.
 * A `Float64Array` is ADOPTED (no copy); boxed rows are converted; a plain
 * number is read as a node count.
 * @param {(number[]|null)[]|Float64Array|number} points
 * @returns {Float64Array}
 */
function xyFromPoints(points) {
    if (points instanceof Float64Array) return points;
    if (typeof points === 'number') {
        const a = new Float64Array(points * 2); a.fill(NaN); return a;
    }
    if (points == null) return new Float64Array(0);
    if (ArrayBuffer.isView(points)) return new Float64Array(points);
    const n = points.length;
    const xy = new Float64Array(n * 2);
    for (let k = 0; k < n; k++) {
        const p = points[k];
        const o = k << 1;
        if (p == null) { xy[o] = NaN; xy[o + 1] = NaN; }
        else { xy[o] = p[0]; xy[o + 1] = p[1]; }
    }
    return xy;
}

/** Fresh all-clear occlusion set for `n` nodes. */
function makeOccSet(n) {
    return n <= 32 ? 0 : new Uint32Array((n + 31) >> 5);
}

/** Read bit `k` from an occlusion set. */
function occGet(occ, k) {
    if (k < 0) return false;
    if (typeof occ === 'number') return k < 32 && (occ & (1 << k)) !== 0;
    const w = k >> 5;
    return w < occ.length && (occ[w] & (1 << (k & 31))) !== 0;
}

/** Write bit `k`; returns the (possibly new) occlusion set. */
function occSet(occ, k, v) {
    if (k < 0) return occ;
    if (typeof occ === 'number') {
        if (k >= 32) return occ;              // unreachable: >32 nodes uses Uint32Array
        return v ? (occ | (1 << k)) : (occ & ~(1 << k));
    }
    const w = k >> 5;
    if (w >= occ.length) return occ;
    if (v) occ[w] |= (1 << (k & 31));
    else occ[w] &= ~(1 << (k & 31));
    return occ;
}

/** Insert (`del`=0) or delete (`del`=1) one node slot in a flat xy buffer. */
function spliceXY(xy, idx, del) {
    const n = xy.length >> 1;
    const out = new Float64Array((n + (del ? -1 : 1)) * 2);
    out.fill(NaN);
    for (let k = 0, w = 0; k < n; k++) {
        if (del && k === idx) continue;
        if (!del && k === idx) w++;           // leave the inserted slot NaN
        out[w << 1] = xy[k << 1];
        out[(w << 1) + 1] = xy[(k << 1) + 1];
        w++;
    }
    return out;
}

/** Insert/delete one node slot in an occlusion set of `n` nodes. */
function spliceOcc(occ, n, idx, del) {
    const nextN = n + (del ? -1 : 1);
    let out = makeOccSet(nextN);
    for (let k = 0, w = 0; k < n; k++) {
        if (del && k === idx) continue;
        if (!del && k === idx) w++;           // inserted slot starts un-occluded
        out = occSet(out, w, occGet(occ, k));
        w++;
    }
    return out;
}


/** Auto-incrementing ID counter for UnlinkedInstance */
let _unlinkedIdCounter = 0;

export class UnlinkedInstance {
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


export class FrameGroup {
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


var _identityIdCounter = 0;

export var IDENTITY_COLORS = [
    '#00ff00', '#ff00ff', '#00ffff', '#ffff00', '#ff8800',
    '#0088ff', '#ff0088', '#88ff00', '#8800ff', '#00ff88',
    '#ff0000', '#0000ff', '#00ff44', '#ff4400', '#4400ff',
    '#44ff00', '#ff0044', '#0044ff', '#ffaa00', '#aa00ff',
];

export class Identity {
    constructor(id, name, color) {
        this.id = id != null ? id : _identityIdCounter++;
        this.name = name || ('id_' + this.id);
        this.color = color || IDENTITY_COLORS[this.id % IDENTITY_COLORS.length];
    }
}

export class InstanceGroup {
    /**
     * @param {number} id
     * @param {number} identityId
     */
    constructor(id, identityId) {
        this.id = id;
        this.identityId = identityId != null ? identityId : -1;
        /** @type {Map<string, Instance>} camera name -> single instance */
        this.instances = new Map();
        /** @type {number[][]|null} N x [x, y, z] triangulated 3D points, or null */
        this.points3d = null;
        /** @type {boolean} True when re-triangulation is needed */
        this.dirty = false;
        /** @type {Set<string>|null} Camera names used for last triangulation */
        this.usedCameras = null;
        /**
         * Which solver produced `points3d`: `'ba'` | `'dlt'` | undefined (never
         * triangulated). Read by `resolveTriangulationMethod` (a re-solve keeps the
         * group's method), by `ui/rendering.js`'s lazy reprojection fill (so the
         * reported error matches the 3D actually on hand), by `adoptPrior3d` (a
         * regroup only reuses 3D produced by the method being asked for) and by the
         * Info Panel's method label. NOT reconstructable from `points_3d`, so it is
         * PERSISTED in per-group `metadata.lucid.triangulationMethod` (written only
         * when `'ba'`; absent means DLT) and restored on import.
         * @type {'ba'|'dlt'|undefined}
         */
        this.triangulationMethod = undefined;
        /** @type {Map<string, Instance>} camera name -> reprojected instance */
        this.reprojectedInstances = new Map();
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
     * The 2D points paired with this group's reprojections, per camera —
     * `{ cameraName: [[x,y]|null, ...] }` for every member instance.
     *
     * DERIVED, not stored (luc3d #189). It was previously an own property that
     * nine sites rebuilt as exactly this object right after triangulating, and
     * that two more hand-patched on member add/remove to "keep observedPoints in
     * sync" — the sync a getter does for free. As a stored object it was 531,799
     * plain objects on the real project, a measured 74 MB of the ~4 GB
     * pointer-compressed heap that both the merged save and the project reload
     * run out of.
     *
     * Read-only ON PURPOSE: there is no setter, so a leftover
     * `group.observedPoints = ...` throws a TypeError in strict mode (all ES
     * modules) rather than silently reintroducing a stored copy that can drift
     * from `instances`.
     *
     * ALLOCATES a fresh object per access — hoist it into a local before reading
     * it per camera in a loop.
     *
     * Since luc3d #189 follow-up #1 the per-camera value is a fresh BOXED
     * SNAPSHOT (`Instance.toPointsArray()`), not the member's live array — the
     * member stores coordinates in a flat `Float64Array` now. Liveness is
     * unaffected in practice because the getter re-derives on every read, so a
     * drag in progress is reflected the next time a consumer asks; what is gone
     * is reference IDENTITY (`observedPoints[cam] === someArray`).
     *
     * @returns {Object.<string, (number[]|null)[]>}
     */
    get observedPoints() {
        var out = {};
        for (var [camName, inst] of this.instances) {
            if (inst) out[camName] = inst.toPointsArray();
        }
        return out;
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

    /**
     * Add (or replace) the reprojected instance for a given camera view.
     * @param {string} cameraName
     * @param {Instance} instance
     */
    addReprojectedInstance(cameraName, instance) {
        this.reprojectedInstances.set(cameraName, instance);
    }

    /**
     * Get the reprojected instance for a given camera view.
     * @param {string} cameraName
     * @returns {Instance|undefined}
     */
    getReprojectedInstance(cameraName) {
        return this.reprojectedInstances.get(cameraName);
    }
}


export class Session {
    /**
     * @param {Camera[]} cameras
     * @param {Skeleton} skeleton
     * @param {string[]} tracks - Track names
     * @param {string} name - Session name (optional, defaults to 'Session 1')
     */
    constructor(cameras, skeleton, tracks, name) {
        this.cameras = cameras;
        this.skeleton = skeleton;
        // Copy the tracks array so each session owns it. Tracks are per-session
        // (like identities): two sessions must never share one array, or
        // deleting/adding/renaming a track in one would mutate the others.
        this.tracks = Array.isArray(tracks) ? tracks.slice() : (tracks || []);
        this.name = name || 'Session 1';
        this.videoFileIndices = [];
        this.lastFrame = 0;
        /** @type {Map<number, FrameGroup>} frameIdx -> FrameGroup */
        this.frameGroups = new Map();
        /** @type {Map<number, InstanceGroup[]>} frameIdx -> InstanceGroup[] */
        this.instanceGroups = new Map();
        /** @type {Identity[]} */
        this.identities = [];
        this.trustTracks = false;
        /**
         * @type {Map<string, number>} "frameIdx:camName:trackIdx" → identityId.
         * The SINGLE source of per-instance identity. A negative value is an
         * explicit "no identity" marker. There is deliberately no global
         * "camName:trackIdx" default map: a track's identity is a per-frame
         * property (tracklets swap), and a global fallback painted stale
         * duplicate identities whenever per-frame reality diverged from it.
         */
        this.frameIdentityMap = new Map();
        /**
         * @type {Object<string, number>} cameraName -> contrast setting, an
         * integer in [-100, 100]. Display-only (a CSS filter on the view
         * canvas), but per-SESSION and persisted in the `.slp`
         * (`metadata.lucid.videoContrast`) — `state.views` is rebuilt from
         * scratch on every session switch, so a per-view field would reset.
         * Default (0) entries are never stored; see `ui/video-filters.js`.
         */
        this.videoContrast = {};
        /**
         * @type {Object<string, number>} cameraName -> brightness percentage,
         * an integer in [0, 200]. Same lifecycle as `videoContrast` above
         * (`metadata.lucid.videoBrightness`); default (100) entries are never
         * stored. Before this was session-backed it lived on the transient view
         * object, so it silently reset on every session switch.
         */
        this.videoBrightness = {};
        /**
         * @type {Object<string, number>} cameraName -> rotation in degrees, an
         * integer in [-179, 180]. Unlike brightness/contrast this is NOT
         * display-only: the renderer and hit-testing consume it via
         * `view.rotation`, which is restored from here whenever a pane is built.
         * Persisted as `metadata.lucid.videoRotation`; default (0) entries are
         * never stored.
         */
        this.videoRotation = {};
        /** @type {LazyFrameLoader|null} Set when using lazy H5 loading */
        this.lazyLoader = null;
        /** @type {Map<string,{data:Uint8Array,nTracks:number,nFrames:number}>|null} Per-camera track occupancy for timeline */
        this.trackOccupancy = null;
    }

    addIdentity(name, color) {
        var maxId = this.identities.reduce(function (m, id) { return Math.max(m, id.id); }, -1);
        var identity = new Identity(maxId + 1, name, color);
        this.identities.push(identity);
        return identity;
    }

    getIdentity(identityId) {
        for (var i = 0; i < this.identities.length; i++) {
            if (this.identities[i].id === identityId) return this.identities[i];
        }
        return null;
    }

    getOrCreateIdentityForTrack(trackIdx) {
        // Return the canonical "id_N" identity for a track, creating it if
        // absent. Pure lookup/create — it does NOT assign the identity to any
        // instance. Callers stamp per-frame identity themselves (via
        // setFrameIdentity / assignTrackToIdentity) so this stays O(1) even
        // when called once per (frame, track).
        var idName = 'id_' + trackIdx;
        for (var i = 0; i < this.identities.length; i++) {
            if (this.identities[i].name === idName) return this.identities[i];
        }
        return this.addIdentity(idName);
    }

    /**
     * Assign an identity to a group, enforcing per-frame uniqueness.
     * If another InstanceGroup in the same frame already has identityId,
     * give that group the identity that `group` is moving away from
     * ("swap"). Without this, the viewer's identity-color path would
     * paint two skeletons in the same view with the same color.
     *
     * Across frames, multiple groups may legitimately hold the same
     * identity (the same physical subject across time) — the swap is
     * scoped to the single frame containing `group`.
     *
     * @param {number} [hostFrameIdx] - the frame containing `group`, if the
     *   caller already knows it (e.g. a project-wide sweep already iterating
     *   `instanceGroups` frame-by-frame). Omit for the normal single-group
     *   interactive callers (info panel / identity-assignment UI) — this
     *   falls back to an O(project) search. Passing it turns a call made
     *   once per group in a full sweep from O(frames) into O(1) each,
     *   avoiding an O(frames^2) blowup over the whole sweep.
     */
    assignIdentityToGroup(group, identityId, hostFrameIdx) {
        var oldIdentityId = group.identityId;
        if (oldIdentityId === identityId) return;

        // Find the frame containing this group and check for colliders.
        if (hostFrameIdx == null) {
            for (var [frameIdx, groups] of this.instanceGroups) {
                if (groups.indexOf(group) >= 0) { hostFrameIdx = frameIdx; break; }
            }
        }
        if (hostFrameIdx != null && identityId != null && identityId >= 0) {
            var siblings = this.instanceGroups.get(hostFrameIdx);
            for (var si = 0; si < siblings.length; si++) {
                var other = siblings[si];
                if (other === group) continue;
                if (other.identityId === identityId) {
                    // Collision — hand the colliding group `group`'s previous identity.
                    other.identityId = (oldIdentityId != null && oldIdentityId >= 0) ? oldIdentityId : -1;
                }
            }
        }

        group.identityId = identityId;
    }

    /**
     * Walk every frame and resolve any pre-existing per-frame identity
     * collisions among InstanceGroup objects. Groups beyond the first
     * holder of an identity in a given frame have their identityId
     * cleared (-1). Useful for repairing data loaded from an SLP / project
     * that was authored before the per-frame uniqueness invariant was
     * enforced.
     *
     * @returns {number} count of groups whose identityId was cleared
     */
    deduplicateFrameIdentities() {
        var cleared = 0;
        for (var [frameIdx, groups] of this.instanceGroups) {
            var seen = new Set();
            for (var i = 0; i < groups.length; i++) {
                var g = groups[i];
                if (g.identityId == null || g.identityId < 0) continue;
                if (seen.has(g.identityId)) {
                    g.identityId = -1;
                    cleared++;
                } else {
                    seen.add(g.identityId);
                }
            }
        }
        return cleared;
    }

    /**
     * Walk every frame and move any "orphan" linked instances — instances
     * in `fg.instances` that are not members of any InstanceGroup AND
     * are not already in `fg.unlinkedInstances` — into the unlinked pool.
     *
     * Without this, the viewer's linked-instance pass renders these
     * orphans (because it iterates `fg.instances` directly), but the
     * info-panel doesn't list them in either the GROUPED or UNGROUPED
     * tables (grouped iterates `instanceGroups`, unlinked iterates
     * `fg.unlinkedInstances`). End-user symptom: skeleton visible in the
     * viewer but missing from the Instances panel.
     *
     * Operations like Track All / Auto Assign / manual re-grouping can
     * leave orphans behind; running this on load (and on demand) restores
     * the invariant that every linked instance is either grouped or
     * explicitly unlinked.
     *
     * @returns {number} count of instances moved to the unlinked pool
     */
    scrubOrphanInstances() {
        var moved = 0;
        for (var [frameIdx, fg] of this.frameGroups) {
            var groups = this.instanceGroups.get(frameIdx) || [];
            // Build the set of all instances claimed by some group.
            var groupedInstances = new Set();
            for (var gi = 0; gi < groups.length; gi++) {
                for (var [, gInst] of groups[gi].instances) {
                    groupedInstances.add(gInst);
                }
            }
            // For each (camera, [instances]) in fg.instances, separate into
            // grouped (kept) and orphan (moved to unlinked pool).
            for (var [camName, instances] of fg.instances) {
                var existingUl = fg.getUnlinkedInstances(camName) || [];
                var existingUlInstances = new Set();
                for (var ui = 0; ui < existingUl.length; ui++) {
                    existingUlInstances.add(existingUl[ui].instance);
                }
                var kept = [];
                for (var ii = 0; ii < instances.length; ii++) {
                    var inst = instances[ii];
                    if (groupedInstances.has(inst)) {
                        kept.push(inst);
                    } else if (!existingUlInstances.has(inst)) {
                        // Orphan — move to unlinked pool.
                        fg.addUnlinkedInstance(camName, new UnlinkedInstance(inst, camName));
                        moved++;
                    }
                    // else: already in unlinked pool; drop from fg.instances
                    // to avoid double-listing.
                }
                fg.instances.set(camName, kept);
            }
        }
        return moved;
    }

    /**
     * "Propagate IDs → Tracks": overwrite every instance's track with its
     * identity. Identity/grouping is the source of truth here — each instance
     * that belongs to an identity-bearing InstanceGroup gets a trackIdx whose
     * NAME is that identity's name. Instances with no identity — whether they
     * have no identity entry at all OR are explicitly marked "no identity" (the
     * negative per-frame sentinel) — become trackless (trackIdx = null). A null
     * identity propagates to a null track; we do NOT create a dedicated "No ID"
     * track for explicit-none instances.
     *
     * This rewrites the session-level `tracks` name list to one entry per used
     * identity and rewrites `frameIdentityMap`
     * under the new trackIdx keys, so each instance's track resolves back to its
     * identity (Color-by-Track and Color-by-Identity then show the same
     * partition). Identity lives purely per-frame — there is no global default
     * map to rebuild.
     *
     * SLP-export hazards this guards against: identity names are de-duplicated
     * (a numeric suffix is appended on collision) and never empty, so the
     * exported .slp gets exactly one uniquely-named Track per identity and no
     * instance points at the wrong track name.
     *
     * @returns {{tracks:number, instances:number}} new track count and number
     *   of instances whose trackIdx changed.
     */
    propagateIdentitiesToTracks() {
        // `frameIdentityMap` ("frameIdx:cam:trackIdx" → identityId) is the
        // single, always-resident, WHOLE-PROJECT source of per-instance
        // identity (see its doc comment above the constructor field) — Track
        // All/triangulation write it per-frame as they process every frame,
        // and nothing ever evicts it, unlike `frameGroups` which under lazy
        // loading only holds a small resident window of visited frames (see
        // `numFrames`'s doc). Driving steps 1-2 from `frameIdentityMap`
        // instead of walking `frameGroups` means this is correct and complete
        // for the whole project regardless of what's currently materialized —
        // walking `frameGroups` used to both under-cover unvisited frames AND
        // (via the old step 3's wholesale replace) silently DESTROY identity
        // data for every frame outside the resident window.
        var self = this;

        // 1. Which identities are actually assigned anywhere, project-wide.
        //    Preserves identities-array order for stable, reproducible track
        //    indices. Build new tracks = identity names (unique + non-empty).
        var usedSet = new Set();
        for (var idVal of this.frameIdentityMap.values()) {
            if (idVal != null && idVal >= 0) usedSet.add(idVal);
        }
        var newTracks = [];
        var idToTrackIdx = new Map();   // identityId → new trackIdx
        var nameSeen = {};
        // Auto-generated identity names look like "id_<identityId>" (the
        // placeholder `getOrCreateIdentityForTrack` stamps when "Propagate
        // Tracks → IDs" ran with no custom naming) — using that literally as
        // a track name breaks the app's normal "track_N" naming convention
        // (e.g. a Tracks-→-IDs-→-Tracks round trip would otherwise rename
        // track_0/track_1 to id_0/id_1 instead of restoring track_0/track_1).
        // A genuinely user-given name (e.g. "Alice") is still preserved as-is.
        var AUTO_IDENTITY_NAME_RE = /^id_\d+$/;
        for (var ix = 0; ix < this.identities.length; ix++) {
            var ident = this.identities[ix];
            if (!usedSet.has(ident.id)) continue;
            var trimmedName = ident.name != null ? String(ident.name).trim() : '';
            var base = (trimmedName !== '' && !AUTO_IDENTITY_NAME_RE.test(trimmedName))
                ? trimmedName : ('track_' + newTracks.length);
            var name = base, dup = 2;
            while (nameSeen[name]) { name = base + '_' + dup; dup++; }  // de-dup
            nameSeen[name] = true;
            idToTrackIdx.set(ident.id, newTracks.length);
            newTracks.push(name);
        }

        // 2. Remap the EXISTING, complete frameIdentityMap onto the new track
        //    indices. No frameGroups walk needed for this — every
        //    (frame,cam,oldTrack)→identityId fact the project has is already
        //    in the map. Entries whose identity is unused/explicit-none are
        //    intentionally dropped (that instance is trackless post-
        //    propagate, so no "frame:cam:track" entry is needed for it).
        var newFrameMap = new Map();   // packed (frame,cam,newTrackIdx) → identityId
        // packed (frame,cam,oldTrackIdx) → newTrackIdx, for step 4's lazy
        // columnar remap below. Collected free while we're already iterating
        // every entry here, so step 4's per-instance-row callback can do ONE
        // direct Map.get instead of re-deriving the same fact via
        // getIdentityIdForTrack + idToTrackIdx (two hash lookups per row,
        // across potentially millions of rows). Both maps use the packed key
        // codec, so neither holds a per-entry string.
        var oldKeyToNewTrackIdx = new Map();
        for (var rec of this.frameIdentityEntries()) {
            var oldIdVal = rec.identityId;
            if (oldIdVal == null || oldIdVal < 0 || !idToTrackIdx.has(oldIdVal)) continue;
            var newTrackIdx = idToTrackIdx.get(oldIdVal);
            newFrameMap.set(this._fimKey(rec.frameIdx, rec.camName, newTrackIdx), oldIdVal);
            oldKeyToNewTrackIdx.set(rec.key, newTrackIdx);
        }

        // 2b. Repair/supplement `newFrameMap` from `instanceGroups` directly
        //    (first-frame color regression: raw-trackIdx collision).
        //    `commitTrackedFrame`'s `writtenThisFrame` guard deliberately marks
        //    a (frame,cam,rawTrackIdx) key -1/ambiguous in frameIdentityMap
        //    when the raw per-camera tracker briefly assigns the SAME trackIdx
        //    to two different animals (most common on frame 0, before the
        //    tracker has history to differentiate them) — correct for
        //    protecting the 2D overlay's per-camera-per-frame color lookup
        //    from confidently showing the wrong one's color. But the pass
        //    above (correctly) SKIPS that ambiguous entry, so NEITHER
        //    identity's new key got written at all — every consumer that
        //    reads frameIdentityMap only (Timeline's ID view via
        //    `_buildIdentitySegments`) then showed that frame as having no
        //    identity for either animal, on both cameras' rows. Each
        //    instance's own group already has an unambiguous identity
        //    (`group.identityId`, set once per group at creation, never
        //    shared across two colliding groups) — write it in directly,
        //    independent of the raw-key collision.
        //
        //    The same repair is owed to `oldKeyToNewTrackIdx` (luc3d #203). That
        //    map is what step 4 remaps the COLUMNAR STORE through, and a key
        //    missing from it means "no track" there — so an instance on a marked
        //    frame kept the correct track in memory (step 3's `instanceToIdentity`
        //    fallback) but went TRACKLESS in the store, permanently: it exports
        //    trackless, the Tracks Timeline has a hole at the start, and
        //    store-derived `trackOccupancy` disagrees with resident `frameGroups`
        //    for exactly the first frames — which is what "extra tracks that
        //    overlap the originals, in the first few frames" looks like. Measured
        //    on the lazy fixture with one animal marked on frame 0 of one camera:
        //    that camera's store track column came back `[0,-1,0,1,0,1]`.
        //
        //    Only an UNCONTESTED key is repaired. `remapTracksFromIdentity`'s
        //    callback is keyed by (camera, frame, oldTrackIdx) and cannot see
        //    which ROW it is remapping, so when two different identities really do
        //    share one raw trackIdx on a frame there is no answer it could give
        //    that is right for both — mapping would put two instances on ONE track
        //    in that frame, which is invalid (SLEAP allows at most one instance per
        //    track per frame). Those stay trackless, as before, and are counted and
        //    reported rather than dropped silently.
        //    Resolution is PER ROW, not per track. A group member carries
        //    `_rawInstIndex` — its index within its camera-frame in the columnar
        //    store, the same quantity `remapTracksFromIdentity` now hands its
        //    callback as `offsetInFrame` — so each store row can be mapped to its
        //    own group's identity even when two animals share one raw trackIdx on
        //    that frame. That is what makes the genuine collision recoverable
        //    rather than merely detected.
        var rowClaim = new Map();       // (frame, cam, offsetInFrame) -> newTrackIdx
        var rawClaim = new Map();       // (frame, cam, rawTrack) -> identityId, or -1 when contested
        for (var [frameIdxG, groupsG] of this.instanceGroups) {
            for (var giG = 0; giG < groupsG.length; giG++) {
                var groupG = groupsG[giG];
                if (groupG.identityId == null || groupG.identityId < 0 || !idToTrackIdx.has(groupG.identityId)) continue;
                for (var [camNameG, instG] of groupG.instances) {
                    // Effective identity for THIS member, map-first — same
                    // precedence as step 3's remapInstance and getGroupColor.
                    // A single-view ID switch rewrites only frameIdentityMap
                    // (luc3d #201), so where the map has a usable entry for
                    // the member's raw track it outranks the group's shared
                    // `identityId`; the group fills only the gaps the map had
                    // to skip (absent / -1 collision sentinel). Claiming the
                    // group identity unconditionally here re-imposed the
                    // pre-switch identity on the still-grouped animal's store
                    // row, duplicating one ID onto both animals on that frame.
                    var effIdG = groupG.identityId;
                    var rawTrk = instG ? instG.trackIdx : null;
                    if (rawTrk != null && rawTrk >= 0) {
                        var mapIdG = this.getIdentityIdForTrack(camNameG, rawTrk, frameIdxG);
                        if (mapIdG != null && idToTrackIdx.has(mapIdG)) effIdG = mapIdG;
                    }
                    var newTrackIdxG = idToTrackIdx.get(effIdG);
                    newFrameMap.set(this._fimKey(frameIdxG, camNameG, newTrackIdxG), effIdG);
                    if (!instG) continue;
                    // Per-row: exact, and immune to a raw-trackIdx collision.
                    // `_fimKey` packs (frame, camIdx, smallInt) — the third slot
                    // holds a row offset here rather than a track index, which is
                    // why this is a SEPARATE map from the track-keyed ones.
                    if (instG._rawInstIndex != null && instG._rawInstIndex >= 0) {
                        rowClaim.set(this._fimKey(frameIdxG, camNameG, instG._rawInstIndex), newTrackIdxG);
                    }
                    // Per-track fallback for a member with no `_rawInstIndex`
                    // (a non-lazy session, where the store path does not run
                    // anyway). `instG.trackIdx` is still the RAW/store value here —
                    // step 3, which overwrites it, runs after this block.
                    if (rawTrk == null || rawTrk < 0) continue;
                    var rawKeyG = this._fimKey(frameIdxG, camNameG, rawTrk);
                    var priorClaim = rawClaim.get(rawKeyG);
                    if (priorClaim === undefined) rawClaim.set(rawKeyG, effIdG);
                    else if (priorClaim !== effIdG) rawClaim.set(rawKeyG, -1);
                }
            }
        }
        var ambiguousRawKeys = 0;
        for (var [rawKeyC, claimedId] of rawClaim) {
            if (claimedId < 0) { ambiguousRawKeys++; continue; }
            // Never override what step 2 already derived from frameIdentityMap —
            // only fill the gaps it had to skip.
            if (oldKeyToNewTrackIdx.has(rawKeyC)) continue;
            oldKeyToNewTrackIdx.set(rawKeyC, idToTrackIdx.get(claimedId));
        }

        // 3. Mutate whatever IS resident right now, for instant GUI feedback
        //    on the visible window — reads the OLD frameIdentityMap (not yet
        //    replaced), so this must run before step 5 commits the new one.
        var changed = 0;
        // Per-instance identity fallback for the same raw-trackIdx-collision
        // case as 2b above: an instance that belongs to a group has an
        // unambiguous identity via `group.identityId`, independent of whatever
        // `getIdentityIdForTrack` returns for its (possibly collided) raw
        // per-camera key. Built once, before any instance is mutated below.
        var instanceToIdentity = new Map();  // Instance -> identityId
        for (var [, groupsForFallback] of this.instanceGroups) {
            for (var gfi = 0; gfi < groupsForFallback.length; gfi++) {
                var gFallback = groupsForFallback[gfi];
                if (gFallback.identityId == null || gFallback.identityId < 0) continue;
                for (var [, instFallback] of gFallback.instances) {
                    instanceToIdentity.set(instFallback, gFallback.identityId);
                }
            }
        }
        // Once per instance: a shared object reached by BOTH the frameGroups
        // walk (step 3) and the instanceGroups walk (3b) must not be remapped
        // twice — the second pass would look its ALREADY-REWRITTEN trackIdx up
        // in the old map and undo the first. (The old group-first lookup was
        // accidentally idempotent because it keyed by object; the map-first
        // lookup below keys by the mutable trackIdx, so idempotency has to be
        // explicit.)
        var remapped = new Set();
        function remapInstance(inst, camName, frameIdx) {
            if (remapped.has(inst)) return;
            remapped.add(inst);
            var ni = null;
            if (inst.trackIdx != null) {
                // Per-frame map FIRST — it is the source of truth every display
                // consumer resolves first (see getGroupColor), and the ONLY
                // structure a single-view ID switch rewrites
                // (`swapIdentitiesForwardInCamera` deliberately leaves the
                // cross-view `group.identityId` alone, luc3d #201). The group
                // fallback covers only entries the map cannot answer (absent,
                // or the -1 collision sentinel — the #183 repair case).
                // Consulting the group FIRST resurrected its stale identity on
                // the frame of a single-view switch, duplicating one ID onto
                // both animals there.
                var id = self.getIdentityIdForTrack(camName, inst.trackIdx, frameIdx);
                if (id == null && instanceToIdentity.has(inst)) {
                    id = instanceToIdentity.get(inst);
                }
                if (id != null && id >= 0 && idToTrackIdx.has(id)) ni = idToTrackIdx.get(id);
                // No identity (including explicit "no identity") → trackless
                // (null). No dedicated "No ID" track is created.
            }
            if (inst.trackIdx !== ni) { inst.trackIdx = ni; changed++; }
        }
        function forEachInstance(cb) {
            for (var [frameIdx, fg] of self.frameGroups) {
                for (var [camName, insts] of fg.instances) {
                    for (var ii = 0; ii < insts.length; ii++) cb(insts[ii], camName, frameIdx);
                }
                for (var [camName2, ul] of fg.unlinkedInstances) {
                    for (var uu = 0; uu < ul.length; uu++) cb(ul[uu].instance, camName2, frameIdx);
                }
            }
        }
        forEachInstance(remapInstance);

        // 3b. `session.instanceGroups` is populated PROJECT-WIDE at lazy-reopen
        //    (unlike `frameGroups`, a small resident window) with its own
        //    lightweight per-camera Instance members (see
        //    reconstructInstanceGroupsFromSessionLazy /
        //    finalizeLazyFrameGroup in import-export/slp-import.js and
        //    pose/triangulation.js) — a member becomes the SAME object as its
        //    frameGroups counterpart only once that frame is scrubbed to, and
        //    even then `finalizeLazyFrameGroup` never refreshes `trackIdx` on
        //    hydration. Step 3 above only reaches whatever's resident, so
        //    every other frame's instanceGroups members kept their OLD
        //    trackIdx after propagate — which, once `session.tracks` is
        //    replaced (step 5) with a new, usually much SHORTER list, left
        //    those members pointing at out-of-range track indices. That
        //    single staleness was the root cause of three symptoms at once:
        //    the 3D viewport (colors by `group.instances.get(cam).trackIdx`,
        //    ui/overlays.js `getGroupColor`) staying on old colors, the
        //    Instance Info panel's track `<select>` going blank (no matching
        //    option for an out-of-range value), and the Timeline showing
        //    "old tracks plus new ones overlaid" (`_buildTrackSegments`
        //    scans `instanceGroups` directly, independently of the
        //    `trackOccupancy`-derived segments that already reflect the new
        //    assignment). Re-running the SAME remap here (idempotent for any
        //    member already fixed via the shared-reference case above) fixes
        //    all three without touching `group.identityId` — identity stays
        //    the source of truth, unaffected by this direction of propagate.
        for (var [frameIdx3, groups3] of this.instanceGroups) {
            for (var gi3 = 0; gi3 < groups3.length; gi3++) {
                for (var [camName3, inst3] of groups3[gi3].instances) {
                    remapInstance(inst3, camName3, frameIdx3);
                }
            }
        }

        // 4. Lazy sessions: also rewrite the persistent columnar store (the
        //    project-wide `instancesData.track` column + `labels.tracks`) so
        //    the new track assignment survives eviction/reload and native SLP
        //    export — which reads straight from that store, not from mutated
        //    in-memory Instance objects (see slp-streaming-write.js) — picks
        //    it up too, without materializing a single extra frame.
        var lazyChanged = 0;
        var lazyErrorRows = 0;
        if (this.lazyLoader && typeof this.lazyLoader.remapTracksFromIdentity === 'function') {
            // Diagnostic for the "export only has tracks on the first frame(s)"
            // report: if oldKeyToNewTrackIdx is suspiciously small relative to
            // frameIdentityMap (which the live session already shows is dense
            // across the whole project), the mismatch is in HOW this map got
            // built (step 2 above), not in the columnar remap itself. If the
            // sizes look right but rows still come up empty, check
            // lazyErrorRows below instead — that means the remap itself failed
            // partway through.
            console.log('[propagateIdentitiesToTracks] frameIdentityMap.size=' + this.frameIdentityMap.size +
                ', oldKeyToNewTrackIdx.size=' + oldKeyToNewTrackIdx.size + ', newTracks=' + newTracks.length);
            var lazyResult = this.lazyLoader.remapTracksFromIdentity(newTracks, function (camName, frameIdx, oldTrackIdx, offsetInFrame) {
                // Per-row first (luc3d #203): this row's own group knows its
                // identity unambiguously, so it is right even where the raw
                // trackIdx is shared by two animals, and it does not depend on
                // the row having a track to begin with.
                if (offsetInFrame != null) {
                    var byRow = rowClaim.get(self._fimKey(frameIdx, camName, offsetInFrame));
                    if (byRow != null) return byRow;
                }
                if (oldTrackIdx == null || oldTrackIdx < 0) return -1;
                var newTrackIdx = oldKeyToNewTrackIdx.get(self._fimKey(frameIdx, camName, oldTrackIdx));
                return newTrackIdx != null ? newTrackIdx : -1;
            });
            if (typeof lazyResult === 'number') {
                lazyChanged = lazyResult;   // back-compat: a mock/older lazyLoader may still return a bare count
            } else if (lazyResult) {
                lazyChanged = lazyResult.changed || 0;
                lazyErrorRows = lazyResult.errorRows || 0;
            }
        }

        // 5. Commit. Identity now lives purely per-frame under the new
        //    trackIdx keys — each instance's track IS its identity, so the
        //    per-frame map is what lookups read. (No global default map
        //    exists.) Already-grouped frames keep their group.identityId,
        //    which agrees with the new per-frame entries, so tracks and
        //    groups stay consistent. Safe to replace wholesale now that
        //    `newFrameMap` was itself derived from the complete prior map
        //    (step 2), not a residency-limited subset.
        this.tracks = newTracks;
        this.frameIdentityMap = newFrameMap;
        // `ambiguousRawKeys` counts (frame, camera, rawTrackIdx) keys that two
        // different identities genuinely share, which the track-keyed columnar
        // remap cannot resolve per row (luc3d #203) — those instances stay
        // trackless in the store. Reported so the condition is visible instead of
        // presenting as an unexplained gap in the first frames.
        if (ambiguousRawKeys > 0) {
            console.warn('[propagateIdentitiesToTracks] ' + ambiguousRawKeys + ' (frame,camera,trackIdx) key(s) ' +
                'are claimed by two different identities — the raw per-camera tracker gave two animals the same ' +
                'trackIdx on those frames. Their columnar store rows stay TRACKLESS because a track-keyed remap ' +
                'cannot tell the two rows apart; the in-memory instances keep the correct track.');
        }
        return {
            tracks: newTracks.length, instances: changed + lazyChanged,
            lazyErrorRows: lazyErrorRows, ambiguousRawKeys: ambiguousRawKeys,
        };
    }

    /**
     * "Propagate Tracks → IDs": make each track label an identity. For every
     * visible instance, stamp its per-frame identity to the canonical
     * "id_<trackIdx>" identity (created on demand). Grouped frames also get
     * their group.identityId aligned, so grouped and per-frame identity agree.
     * On a lazy session, also sweeps the whole project's columnar store (not
     * just the resident `frameGroups` window) so an unvisited frame's track
     * gets stamped too — see `SioLazyLoader.forEachInstanceRow`.
     *
     * NOTE (cross-camera trackIdx): maps `trackIdx` → a single identity across ALL
     * cameras, so it ASSUMES track ids correspond across cameras. Per-camera
     * prediction `.slp` files (lazy sessions) are tracked independently, so their
     * ids do NOT correspond — this would give the same identity to different animals.
     * Correct only for cross-view-tracked (trusted) tracks. See
     * `scratch/cross-camera-trackidx.md`.
     * @returns {{identities:number, instances:number}}
     */
    propagateTracksToIdentities() {
        var self = this, changed = 0;
        // `getOrCreateIdentityForTrack` resolves by a LINEAR SCAN over
        // `this.identities` (despite its doc comment's O(1) claim) — fine
        // when called once per (frame,track) as originally written, but the
        // lazy sweep below calls it once per INSTANCE ROW (up to millions on
        // a large project). With many distinct tracks that's an O(instances
        // x identities) blowup — observed as the whole tab freezing on
        // Propagate Tracks -> IDs for a heavily-tracked lazy project. Memoize
        // per distinct trackIdx so the scan runs once per track, not once
        // per row/frame it appears in.
        var identityForTrack = new Map();   // trackIdx -> Identity
        function resolveIdentity(trackIdx) {
            var cached = identityForTrack.get(trackIdx);
            if (cached) return cached;
            var ident = self.getOrCreateIdentityForTrack(trackIdx);
            identityForTrack.set(trackIdx, ident);
            return ident;
        }
        for (var [frameIdx, fg] of this.frameGroups) {
            var stamp = function (inst, cam) {
                if (inst.trackIdx == null) return;
                var ident = resolveIdentity(inst.trackIdx);
                self.setFrameIdentity(frameIdx, cam, inst.trackIdx, ident.id);
                changed++;
            };
            for (var [c1, insts] of fg.instances) for (var a = 0; a < insts.length; a++) stamp(insts[a], c1);
            for (var [c2, ul] of fg.unlinkedInstances) for (var b = 0; b < ul.length; b++) stamp(ul[b].instance, c2);
        }
        // Lazy sessions: the resident-`frameGroups` walk above only covers the
        // visited window — sweep the WHOLE project's persistent columnar
        // store too (no frame/instance materialization) so an unvisited
        // frame's track also gets stamped. Frames covered by the walk above
        // are harmlessly re-stamped with the same identity (setFrameIdentity
        // is idempotent for an unchanged value); `changed` only counts the
        // frameGroups pass to keep its meaning ("instances updated in the
        // live session") unchanged.
        if (this.lazyLoader && typeof this.lazyLoader.forEachInstanceRow === 'function') {
            this.lazyLoader.forEachInstanceRow(function (camName, lazyFrameIdx, trackIdx) {
                if (trackIdx == null || trackIdx < 0) return;
                var ident = resolveIdentity(trackIdx);
                self.setFrameIdentity(lazyFrameIdx, camName, trackIdx, ident.id);
            });
        }
        // Align grouped frames' group.identityId with their instances' track.
        // Passes the already-known frameIdx through to assignIdentityToGroup
        // (3rd arg) — without it, that method re-derives the host frame by
        // scanning ALL of `this.instanceGroups` (project-wide on a lazy
        // session, not just the resident window) per call; doing that once
        // per group while already iterating every frame here is an O(frames^2)
        // blowup (observed freezing the tab on a 180k-frame project).
        for (var [frameIdx2, groups] of this.instanceGroups) {
            for (var gi = 0; gi < groups.length; gi++) {
                var anyTrack = null;
                for (var [, gInst] of groups[gi].instances) {
                    if (gInst.trackIdx != null) { anyTrack = gInst.trackIdx; break; }
                }
                if (anyTrack != null) {
                    this.assignIdentityToGroup(groups[gi], resolveIdentity(anyTrack).id, frameIdx2);
                }
            }
        }
        return { identities: this.identities.length, instances: changed };
    }

    /**
     * Assign a tracklet (trackIdx) to an Identity by stamping a per-frame
     * entry on every frame where that (camera, trackIdx) instance appears.
     * Multiple trackIdx values may legitimately share an identity across
     * non-overlapping frame ranges ("tracklet stitching"). Per-frame
     * uniqueness (at most one trackIdx per camera per FRAME → one identity)
     * is enforced separately by propagateIdentity; this setter does not.
     * @param {number} trackIdx
     * @param {number} identityId
     * @param {string} [cameraName] - If omitted, assigns for ALL cameras
     */
    assignTrackToIdentity(trackIdx, identityId, cameraName) {
        var self = this;
        function applies(cam) { return cameraName ? cam === cameraName : true; }
        for (var [frameIdx, fg] of this.frameGroups) {
            var seenCams = new Set();
            var scan = function (inst, cam) {
                if (inst.trackIdx !== trackIdx || !applies(cam) || seenCams.has(cam)) return;
                seenCams.add(cam);
                self.setFrameIdentity(frameIdx, cam, trackIdx, identityId);
            };
            for (var [cam1, insts] of fg.instances) for (var a = 0; a < insts.length; a++) scan(insts[a], cam1);
            for (var [cam2, ul] of fg.unlinkedInstances) for (var b = 0; b < ul.length; b++) scan(ul[b].instance, cam2);
        }
    }

    /**
     * Clear any per-frame identity for a track ("set to none"). Removes every
     * "frameIdx:cameraName:trackIdx" entry, so the track resolves to no
     * identity on all frames. The per-frame replacement for deleting a global
     * "cameraName:trackIdx" mapping.
     * @param {number} trackIdx
     * @param {string} cameraName
     */
    clearTrackIdentity(trackIdx, cameraName) {
        // Packed keys have no parsable suffix, so match on decoded parts.
        var doomed = [];
        for (var rec of this.frameIdentityEntries()) {
            if (rec.camName === cameraName && rec.trackIdx === trackIdx) doomed.push(rec.key);
        }
        for (var d = 0; d < doomed.length; d++) this.frameIdentityMap.delete(doomed[d]);
    }

    /**
     * Migrate a legacy global "cameraName:trackIdx → identityId" map (the
     * removed `trackIdentityMap`) into per-frame entries, so projects saved
     * before the per-frame-only model keep their identities. For each global
     * entry, stamps `frameIdx:cameraName:trackIdx → identityId` on every frame
     * where that instance actually exists, WITHOUT overwriting an existing
     * (more specific) per-frame entry. Call after frame groups are loaded.
     * @param {Array<[string, number]>} entries - [["cam:trackIdx", id], ...]
     * @returns {number} per-frame entries written
     */
    migrateGlobalIdentitiesToPerFrame(entries) {
        if (!entries || !entries.length) return 0;
        var byKey = {};
        for (var i = 0; i < entries.length; i++) byKey[entries[i][0]] = entries[i][1];
        var self = this, n = 0;
        function apply(inst, cam, frameIdx) {
            if (inst.trackIdx == null) return;
            var gid = byKey[cam + ':' + inst.trackIdx];
            if (gid == null) return;
            if (self.hasFrameIdentity(frameIdx, cam, inst.trackIdx)) return;   // keep specific entry
            self.setFrameIdentity(frameIdx, cam, inst.trackIdx, gid);
            n++;
        }
        for (var [frameIdx, fg] of this.frameGroups) {
            for (var [cam1, insts] of fg.instances) for (var a = 0; a < insts.length; a++) apply(insts[a], cam1, frameIdx);
            for (var [cam2, ul] of fg.unlinkedInstances) for (var b = 0; b < ul.length; b++) apply(ul[b].instance, cam2, frameIdx);
        }
        return n;
    }

    /**
     * Get the Identity for a tracklet (trackIdx) in a specific camera.
     * Checks per-frame override first (if frameIdx provided), then global.
     * @param {number} trackIdx
     * @param {string} [cameraName] - If omitted, checks first matching camera
     * @param {number} [frameIdx] - If provided, checks per-frame overrides first
     * @returns {Identity|null}
     */
    getIdentityForTrack(trackIdx, cameraName, frameIdx) {
        // Per-frame identity is the only source. A negative value is an
        // explicit "no identity" marker → null (not a stale fallback).
        if (frameIdx != null && cameraName) {
            var frameIdVal = this.getFrameIdentityValue(frameIdx, cameraName, trackIdx);
            if (frameIdVal != null) return frameIdVal < 0 ? null : this.getIdentity(frameIdVal);
            return null;
        }
        // Per-frame without cameraName: check any camera at this frame.
        if (frameIdx != null && !cameraName) {
            for (var rec of this.frameIdentityEntries()) {
                if (rec.frameIdx !== frameIdx || rec.trackIdx !== trackIdx) continue;
                if (rec.identityId < 0) continue;   // skip explicit "no identity"
                return this.getIdentity(rec.identityId);
            }
        }
        return null;
    }

    /**
     * Get identity ID for a track at a specific frame (checks per-frame first, then global).
     * @param {string} cameraName
     * @param {number} trackIdx
     * @param {number} [frameIdx]
     * @returns {number|null} identityId or null
     */
    getIdentityIdForTrack(cameraName, trackIdx, frameIdx) {
        if (frameIdx == null) return null;
        var frameIdVal = this.getFrameIdentityValue(frameIdx, cameraName, trackIdx);
        // Negative = explicit "no identity"; absent = no identity. Either way
        // null — there is no global default to fall back to.
        if (frameIdVal != null) return frameIdVal < 0 ? null : frameIdVal;
        return null;
    }

    /**
     * Identity of an UNLINKED instance (luc3d #201): the per-frame map entry
     * for a TRACKED instance (exactly `getIdentityIdForTrack`), the
     * instance-level retained identity for a TRACKLESS one — the map cannot
     * represent a null track (one shared per-camera slot), so `unlinkGroup`
     * stamps the disbanding group's identity onto the instance instead. The
     * single resolver for everything that reads an ungrouped row's identity
     * (info panel, 2D color, regroup derivation).
     * @param {string} cameraName
     * @param {Instance} instance
     * @param {number} frameIdx
     * @returns {number|null} identityId or null
     */
    getIdentityIdForUnlinkedInstance(cameraName, instance, frameIdx) {
        if (!instance) return null;
        if (instance.trackIdx != null) {
            return this.getIdentityIdForTrack(cameraName, instance.trackIdx, frameIdx);
        }
        return (instance.identityId != null && instance.identityId >= 0)
            ? instance.identityId : null;
    }

    /**
     * True iff the tracker explicitly marked this (frame, camera, track) as
     * having NO identity — the negative sentinel written by
     * matchFrameInstances' Issue #6 guard for visible-but-ungrouped instances.
     * This is distinct from "no identity assigned" (no map entry at all): only
     * the explicit negative marker counts. Used to render null-ID instances in
     * space gray and to keep them out of identity-based groups on triangulation.
     * @param {string} cameraName
     * @param {number} trackIdx
     * @param {number} frameIdx
     * @returns {boolean}
     */
    isExplicitNoIdentity(cameraName, trackIdx, frameIdx) {
        if (frameIdx == null || cameraName == null || trackIdx == null) return false;
        var v = this.getFrameIdentityValue(frameIdx, cameraName, trackIdx);
        return v != null && v < 0;
    }

    /**
     * True iff `trackIdx` is the dedicated "No ID" track created by
     * `propagateIdentitiesToTracks` for explicitly-un-identified instances.
     * Such a track is the null track: colored in `NULL_ID_COLOR` (the ID
     * panel's gray) rather than a palette color, both in the Track panel and
     * on the skeleton when coloring by track.
     * @param {number} trackIdx
     * @returns {boolean}
     */
    isNoIdTrack(trackIdx) {
        return trackIdx != null && this.tracks[trackIdx] === NO_ID_TRACK_NAME;
    }

    /**
     * Set identity for a track at a specific frame (per-frame override).
     * @param {number} frameIdx
     * @param {string} cameraName
     * @param {number} trackIdx
     * @param {number} identityId
     */
    setFrameIdentity(frameIdx, cameraName, trackIdx, identityId) {
        this.frameIdentityMap.set(this._fimKey(frameIdx, cameraName, trackIdx), identityId);
    }

    /* ---------------- frameIdentityMap key plumbing (luc3d #185 #3) ----------
     * Every read/write of `frameIdentityMap` goes through these so the packed
     * key layout lives in exactly one place. See the codec notes at the top of
     * this file for the bit budget and the on-disk compatibility contract.
     */

    /** camera name -> index into `this.cameras`, memoized. */
    _fimCamIdx(cameraName) {
        var cache = this._fimCamIdxCache;
        if (!cache || cache.size !== this.cameras.length) {
            cache = this._fimCamIdxCache = new Map();
            for (var i = 0; i < this.cameras.length; i++) cache.set(this.cameras[i].name, i);
        }
        var idx = cache.get(cameraName);
        return idx === undefined ? -1 : idx;
    }

    /**
     * Key for (frameIdx, cameraName, trackIdx): a packed Number when encodable,
     * else the legacy `"frameIdx:camName:trackIdx"` string so an out-of-range
     * project still round-trips instead of losing identities.
     * @returns {number|string}
     */
    _fimKey(frameIdx, cameraName, trackIdx) {
        var packed = _fimPack(frameIdx, this._fimCamIdx(cameraName),
            trackIdx == null ? -1 : trackIdx);
        return packed === null ? (frameIdx + ':' + cameraName + ':' + trackIdx) : packed;
    }

    /**
     * Decode either key form back to its parts.
     * @returns {{frameIdx:number, camName:string, trackIdx:number}|null}
     */
    _fimDecode(key) {
        if (!_fimIsPacked(key)) return _parseFrameIdentityKey(String(key));
        var u = _fimUnpack(key);
        var cam = this.cameras[u.camIdx];
        return { frameIdx: u.frameIdx, camName: cam ? cam.name : String(u.camIdx), trackIdx: u.trackIdx };
    }

    /**
     * Raw per-frame identity value (may be the negative "explicit no identity"
     * sentinel), or undefined when there is no entry.
     * @returns {number|undefined}
     */
    getFrameIdentityValue(frameIdx, cameraName, trackIdx) {
        return this.frameIdentityMap.get(this._fimKey(frameIdx, cameraName, trackIdx));
    }

    /** True iff an entry exists for (frameIdx, cameraName, trackIdx). */
    hasFrameIdentity(frameIdx, cameraName, trackIdx) {
        return this.frameIdentityMap.has(this._fimKey(frameIdx, cameraName, trackIdx));
    }

    /** Remove the entry for (frameIdx, cameraName, trackIdx). */
    deleteFrameIdentity(frameIdx, cameraName, trackIdx) {
        return this.frameIdentityMap.delete(this._fimKey(frameIdx, cameraName, trackIdx));
    }

    /**
     * Iterate the map as decoded records. For consumers that used to parse keys
     * themselves (the ID timeline, track-identity ops, the propagate remap).
     * @yields {{frameIdx:number, camName:string, trackIdx:number, identityId:number, key:(number|string)}}
     */
    *frameIdentityEntries() {
        for (var entry of this.frameIdentityMap) {
            var parts = this._fimDecode(entry[0]);
            if (!parts) continue;
            yield {
                frameIdx: parts.frameIdx, camName: parts.camName, trackIdx: parts.trackIdx,
                identityId: entry[1], key: entry[0],
            };
        }
    }

    /**
     * Replace `frameIdentityMap` from serialized `[key, identityId]` pairs,
     * normalizing to packed keys. Accepts BOTH the legacy
     * `"frameIdx:camName:trackIdx"` strings written by every prior build (and
     * present in already-saved projects) and packed numbers — so reopening an
     * existing file keeps working. Unparseable keys are preserved verbatim
     * rather than dropped, so nothing is silently lost.
     * @param {Array<[string|number, number]>} entries
     * @returns {number} entries ingested
     */
    ingestFrameIdentityEntries(entries) {
        this.frameIdentityMap = new Map();
        if (!entries) return 0;
        var n = 0;
        for (var i = 0; i < entries.length; i++) {
            var k = entries[i][0], v = entries[i][1];
            if (_fimIsPacked(k)) { this.frameIdentityMap.set(k, v); n++; continue; }
            var parts = _parseFrameIdentityKey(String(k));
            if (!parts) { this.frameIdentityMap.set(k, v); n++; continue; }
            this.frameIdentityMap.set(
                this._fimKey(parts.frameIdx, parts.camName, parts.trackIdx), v);
            n++;
        }
        return n;
    }

    /**
     * Serialize `frameIdentityMap` in the ORIGINAL on-disk shape —
     * `[["frameIdx:camName:trackIdx", identityId], ...]` — so files written now
     * stay readable by older builds and by anything else parsing these strings.
     * @returns {Array<[string, number]>}
     */
    exportFrameIdentityEntries() {
        var out = [];
        for (var rec of this.frameIdentityEntries()) {
            out.push([rec.frameIdx + ':' + rec.camName + ':' + rec.trackIdx, rec.identityId]);
        }
        return out;
    }

    /**
     * Set identity for a track from a start frame forward through all subsequent frames.
     * Sets per-frame overrides for every frame where this camera:trackIdx appears.
     * @param {number} startFrame
     * @param {string} cameraName
     * @param {number} trackIdx
     * @param {number} identityId
     * @returns {number} Number of frames affected
     */
    propagateIdentity(startFrame, cameraName, trackIdx, identityId) {
        var self = this;
        var count = 0;
        // Frames handled by the resident pass. Resident frames WIN: they carry
        // in-memory edits and unlinked instances that the columnar store does not
        // know about yet, so the store pass must not re-derive them.
        var handled = new Set();

        for (var [frameIdx, fg] of this.frameGroups) {
            if (frameIdx < startFrame) continue;
            // Collect all distinct trackIdx values present on this camera at
            // this frame (linked + unlinked). Used to detect colliders.
            var presentTracks = new Set();
            var found = false;
            var linked = fg.getInstances(cameraName);
            if (linked) {
                for (var i = 0; i < linked.length; i++) {
                    var t1 = linked[i].trackIdx;
                    if (t1 != null) presentTracks.add(t1);
                    if (t1 === trackIdx) found = true;
                }
            }
            var unlinked = fg.getUnlinkedInstances(cameraName);
            if (unlinked) {
                for (var j = 0; j < unlinked.length; j++) {
                    var t2 = unlinked[j].instance.trackIdx;
                    if (t2 != null) presentTracks.add(t2);
                    if (t2 === trackIdx) found = true;
                }
            }
            handled.add(frameIdx);
            if (!found) continue;
            this._applyIdentityAtFrame(frameIdx, cameraName, trackIdx, identityId, presentTracks);
            count++;
        }

        // PROJECT-WIDE (luc3d #195 follow-up). The loop above sees only RESIDENT
        // frames — 31 of 180,210 on the real reopened project — so "propagate this
        // identity forward" silently stopped at the end of the current window.
        // Nothing was corrupted (`frameIdentityMap` writes are durable); the
        // operation just did almost nothing, which is the failure mode this whole
        // bug class shares.
        //
        // `forEachInstanceRow` walks the columnar store's track column directly:
        // no frame materialization, no allocation per frame. It visits each camera
        // exactly once and each (camera, frameIdx) exactly once, with that frame's
        // rows CONTIGUOUS — so a frame's track set can be accumulated in a single
        // reused Set and flushed on the frame boundary, keeping this O(1) in memory
        // rather than building a 180k-entry map of Sets.
        var loader = this.lazyLoader;
        if (loader && typeof loader.forEachInstanceRow === 'function') {
            var curFrame = -1;
            var curPresent = new Set();
            var curFound = false;
            var flush = function () {
                if (curFrame >= startFrame && curFound && !handled.has(curFrame)) {
                    self._applyIdentityAtFrame(curFrame, cameraName, trackIdx, identityId, curPresent);
                    count++;
                }
            };
            loader.forEachInstanceRow(function (cam, f, trk) {
                if (cam !== cameraName) return;
                if (f !== curFrame) {
                    flush();
                    curFrame = f;
                    curPresent.clear();
                    curFound = false;
                }
                // The store's trackless sentinel is -1; in-memory it is null.
                if (trk != null && trk >= 0) {
                    curPresent.add(trk);
                    if (trk === trackIdx) curFound = true;
                }
            });
            flush();
        }
        return count;
    }

    /**
     * Exchange two identities from `startFrame` through the END of the project,
     * in EVERY view (luc3d #172).
     *
     * This is the identity-layer analogue of SLEAP's `Labels.track_swap` over
     * `(frame_idx, None)`, and it is what a MANUAL identity correction means: the
     * user is asserting "from here on, these two animals are the other way
     * round". `propagateIdentity` cannot express that, because it follows ONE
     * raw `(camera, trackIdx)` pair forward and therefore dies at the first
     * fragment boundary of that raw track — on real per-camera tracker output
     * the same animal is track 4 for a few hundred frames, then track 12, then
     * track 20, so a correction reached only the current tracklet (issue #172:
     * "only a small fragment of the ID propagates down the timeline").
     *
     * Identity, unlike a raw track, is DENSE across the whole project: that is
     * precisely why `frameIdentityMap` is keyed per (frame, camera, track)
     * rather than globally per track. So the swap is expressed over identity
     * VALUES and needs no track continuity at all — it reaches every frame,
     * every camera, and every raw track fragment in one pass.
     *
     * Two structures are rewritten, both whole-project and both durable:
     *  - `frameIdentityMap` — the per-frame source of truth every consumer reads
     *    (`getGroupColor`, the ID timeline, triangulation grouping). Saved via
     *    `exportFrameIdentityEntries`.
     *  - `instanceGroups[*].identityId` — the group-level field, saved into the
     *    columnar `instance_groups` table and used as the display FALLBACK for
     *    groups with no per-frame entry, and read directly by
     *    `propagateIdentitiesToTracks` (step 2b). Leaving it stale would make a
     *    later "Propagate IDs -> Tracks" resurrect the pre-swap assignment.
     *
     * Frames BEFORE `startFrame` are never touched — a correction fixes the
     * future, not already-correct history (issue #155). A later correction at a
     * frame G simply exchanges the pair again from G forward, which composes to
     * "until the next manual correction" without this method having to know
     * anything about correction history.
     *
     * Cost: one arithmetic pass over `frameIdentityMap` (no key decoding for
     * packed keys, no allocation) plus one pass over `instanceGroups`. No frame
     * materialization, so nothing hydrates and nothing is evicted.
     *
     * @param {number} startFrame inclusive
     * @param {number} identityA
     * @param {number} identityB
     * @returns {{entries:number, groups:number, frames:number}} per-frame
     *   identity entries changed, group-level fields changed, and frames with at
     *   least one change.
     */
    swapIdentitiesForward(startFrame, identityA, identityB) {
        var entries = 0, groups = 0, frames = 0;
        if (identityA == null || identityB == null || identityA === identityB) {
            return { entries: 0, groups: 0, frames: 0 };
        }
        // Pass 1 — per-frame identity. Only VALUES change, so mutating during
        // iteration is safe (no key is added or removed). Packed keys carry
        // frameIdx in their top bits, so the frame filter is pure arithmetic on
        // the 2.6M-entry real project rather than a decode per entry.
        for (var entry of this.frameIdentityMap) {
            var k = entry[0], v = entry[1];
            if (v !== identityA && v !== identityB) continue;
            var f;
            if (_fimIsPacked(k)) {
                f = Math.floor(k / FIM_CAM_STRIDE);
            } else {
                var parts = _parseFrameIdentityKey(String(k));
                if (!parts) continue;
                f = parts.frameIdx;
            }
            if (f < startFrame) continue;
            this.frameIdentityMap.set(k, v === identityA ? identityB : identityA);
            entries++;
        }
        // Pass 2 — group-level identity (whole-project placeholders).
        for (var [gF, gList] of this.instanceGroups) {
            if (gF < startFrame) continue;
            var touched = false;
            for (var gi = 0; gi < gList.length; gi++) {
                var g = gList[gi];
                if (g.identityId === identityA) { g.identityId = identityB; groups++; touched = true; }
                else if (g.identityId === identityB) { g.identityId = identityA; groups++; touched = true; }
            }
            if (touched) frames++;
        }
        return { entries: entries, groups: groups, frames: frames };
    }

    /**
     * Exchange two identities from `startFrame` to the END of the project in ONE
     * camera only (luc3d #201).
     *
     * This is how you correct an ID in a single view: ungroup, then switch the
     * ID on that view's Ungrouped row. The per-camera tracker crossed two
     * animals in one camera while the other views are already right, so the
     * correction must not touch them — which is exactly what
     * `swapIdentitiesForward` (all views, by design) would do.
     *
     * Why not `propagateIdentity`, which is already per-camera: it follows one
     * raw `(camera, trackIdx)` pair forward and therefore dies at the first
     * fragment boundary of that raw track. That truncation IS issue #172 — on
     * real tracker output the same animal is track 4 for a few hundred frames,
     * then 12, then 20. Swapping identity VALUES needs no track continuity, so a
     * single-view correction reaches every frame and every raw track fragment in
     * that camera, in one pass.
     *
     * `instanceGroups[*].identityId` is deliberately NOT rewritten (the one
     * substantive difference from `swapIdentitiesForward`): it is a single
     * per-group field shared by every view, so changing it would assert the swap
     * for all cameras — the very thing this scoping exists to avoid. A group's
     * members are unlinked at the moment this runs, so there is no group-level
     * value that legitimately describes one camera.
     *
     * @param {number} startFrame inclusive
     * @param {string} cameraName the ONLY camera affected
     * @param {number} identityA
     * @param {number} identityB
     * @returns {{entries:number, groups:number, frames:number}} `groups` is
     *   always 0 — see above; kept so the result shape matches
     *   `swapIdentitiesForward` for `describeIdentitySwitch`.
     */
    swapIdentitiesForwardInCamera(startFrame, cameraName, identityA, identityB) {
        var entries = 0;
        var touchedFrames = new Set();
        if (identityA == null || identityB == null || identityA === identityB) {
            return { entries: 0, groups: 0, frames: 0 };
        }
        var camIdx = this._fimCamIdx(cameraName);
        if (camIdx < 0) return { entries: 0, groups: 0, frames: 0 };
        // Only VALUES change, so mutating during iteration is safe (no key is
        // added or removed) — same argument as `swapIdentitiesForward`. The
        // frame AND camera filters are pure arithmetic on a packed key (no
        // decode, no allocation) so this stays one cheap pass over the 2.6M-entry
        // real project.
        for (var entry of this.frameIdentityMap) {
            var k = entry[0], v = entry[1];
            if (v !== identityA && v !== identityB) continue;
            var f;
            if (_fimIsPacked(k)) {
                f = Math.floor(k / FIM_CAM_STRIDE);
                if (f < startFrame) continue;
                if (Math.floor((k - f * FIM_CAM_STRIDE) / FIM_TRACK_STRIDE) !== camIdx) continue;
            } else {
                var parts = _parseFrameIdentityKey(String(k));
                if (!parts) continue;
                f = parts.frameIdx;
                if (f < startFrame) continue;
                if (parts.camName !== cameraName) continue;
            }
            this.frameIdentityMap.set(k, v === identityA ? identityB : identityA);
            entries++;
            touchedFrames.add(f);
        }
        return { entries: entries, groups: 0, frames: touchedFrames.size };
    }

    /**
     * Stamp `identityId` onto (cameraName, trackIdx) at one frame, preserving
     * per-frame uniqueness. Shared by both passes of `propagateIdentity` so the
     * resident and store-driven paths cannot drift.
     *
     * @param {Set<number>} presentTracks every trackIdx physically present on this
     *   camera at this frame — the collider candidates.
     */
    _applyIdentityAtFrame(frameIdx, cameraName, trackIdx, identityId, presentTracks) {
        // Per-frame uniqueness: at most one trackIdx on this camera at
        // this frame may resolve to identityId. If another track that
        // physically exists here currently resolves to identityId, hand
        // it the identity that (cameraName, trackIdx) currently has —
        // a per-frame swap. This stops two instances in the same view
        // from rendering as the same identity after the propagation.
        var oldIdentityId = this.getIdentityIdForTrack(cameraName, trackIdx, frameIdx);
        if (oldIdentityId !== identityId) {
            for (var ot of presentTracks) {
                if (ot === trackIdx) continue;
                if (this.getIdentityIdForTrack(cameraName, ot, frameIdx) !== identityId) continue;
                // Collider — swap.
                if (oldIdentityId != null) {
                    this.setFrameIdentity(frameIdx, cameraName, ot, oldIdentityId);
                } else {
                    // No old identity to hand off; clear the per-frame
                    // override so the collider falls back to its global
                    // mapping rather than asserting a per-frame duplicate.
                    this.deleteFrameIdentity(frameIdx, cameraName, ot);
                }
            }
        }
        this.setFrameIdentity(frameIdx, cameraName, trackIdx, identityId);
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
     *
     * On a lazy session `frameGroups` holds only the visited/resident frames (a
     * small sliding window — see `evictLazyFrames`), so its size badly understates
     * the project. Prefer the loader's true frame count. `lazyLoader` is a declared
     * constructor field (unlike the ad-hoc, post-load `totalFrames`), so it is
     * always safe to read here; non-lazy sessions fall through to `frameGroups.size`
     * unchanged.
     * @returns {number}
     */
    get numFrames() {
        return this.lazyLoader ? this.lazyLoader.nFrames : this.frameGroups.size;
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
        return this.instanceGroups.get(frameIdx) || [];
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
     * @param {number} [identityId] - Identity ID (auto-determined if not provided)
     * @returns {InstanceGroup} The newly created group
     */
    createGroupFromUnlinked(frameIdx, unlinkedList, identityId) {
        const fg = this.frameGroups.get(frameIdx);
        if (!fg) throw new Error('No FrameGroup for frame ' + frameIdx);

        // Determine identity. An identity the members ALREADY read as wins over
        // anything derived from their raw track numbering (luc3d #201): after an
        // ungroup, deriving "id_<trackIdx>" from the first member's per-camera
        // track index renamed the animal, so the ungroup -> re-assign one row ->
        // regroup round trip could not preserve an ID even once `unlinkGroup`
        // retained it. Members are scanned in order and the first real identity
        // wins, matching how `resolveCurrentIdentityId` reads a selection.
        // TRACKLESS members count too, via their instance-level retained
        // identity (`getIdentityIdForUnlinkedInstance`) — the "a trackless
        // group gets no FABRICATED identity" rule below is untouched (a null
        // track must not mint an "id_null"), but a real identity a trackless
        // member carries is as good as a tracked one's.
        if (identityId === undefined || identityId < 0) {
            identityId = -1;
            for (let i = 0; i < unlinkedList.length; i++) {
                const ulm = unlinkedList[i];
                if (!ulm.instance) continue;
                const held = this.getIdentityIdForUnlinkedInstance(
                    ulm.cameraName, ulm.instance, frameIdx);
                if (held != null && held >= 0) { identityId = held; break; }
            }
        }
        // Otherwise derive it from the first member's track — but only when that
        // member actually HAS a track. Grouping trackless instances
        // (trackIdx == null) must yield a group with NO identity (-1) — do NOT
        // fabricate an "id_null" identity from a null track value.
        if (identityId < 0) {
            const firstTrackIdx = unlinkedList[0].instance.trackIdx;
            if (firstTrackIdx == null) {
                identityId = -1;
            } else {
                const identity = this.getOrCreateIdentityForTrack(firstTrackIdx);
                identityId = identity.id;
            }
        }

        const group = new InstanceGroup(Date.now(), identityId);

        for (let i = 0; i < unlinkedList.length; i++) {
            const ul = unlinkedList[i];
            group.addInstance(ul.cameraName, ul.instance);
            fg.addInstance(ul.cameraName, ul.instance);
            fg.removeUnlinkedById(ul.id);
            // The group owns the identity from here — drop the instance-level
            // retained copy so it cannot go stale against later group-level
            // switches (unlinkGroup re-stamps it if the group disbands again).
            ul.instance.identityId = null;
        }

        // Mixed groups (user + predicted) are treated as user. Promote
        // every predicted member to user immediately so the group is
        // uniformly user from the moment it's formed — independent of
        // unlinked insertion order. Without this, building a group from
        // {pred, user} vs {user, pred} would yield different `firstInst`
        // types and the info-panel badge would flip-flop.
        this._promoteIfMixed(group);

        // Store in instanceGroups (flat list per frame)
        if (!this.instanceGroups.has(frameIdx)) {
            this.instanceGroups.set(frameIdx, []);
        }
        this.instanceGroups.get(frameIdx).push(group);

        return group;
    }

    /**
     * If a group contains both user and predicted instances, promote every
     * predicted member to user (`type='user'`, `modified=true`). No-op for
     * uniform groups. Used at group-creation and on Edit-Group-add so the
     * "mixed = user-typed" semantic is enforced eagerly rather than only
     * at separation time.
     *
     * @returns {boolean} true if the group was mixed and promotion fired
     */
    _promoteIfMixed(group) {
        let hasUser = false, hasPred = false;
        for (const [, inst] of group.instances) {
            if (inst.type === 'user') hasUser = true;
            else if (inst.type === 'predicted') hasPred = true;
        }
        if (!(hasUser && hasPred)) return false;
        for (const [, inst] of group.instances) {
            if (inst.type === 'predicted') {
                inst.type = 'user';
                inst.modified = true;
            }
        }
        return true;
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
        for (const groups of this.instanceGroups.values()) {
            for (const group of groups) {
                if (group.instances.has(oldName)) {
                    const inst = group.instances.get(oldName);
                    group.instances.delete(oldName);
                    group.instances.set(newName, inst);
                }
            }
        }
    }

    /**
     * Warn when a whole-project structural edit can only reach resident frames.
     *
     * Unlike the identity/track operations, these edits cannot be pushed into the
     * columnar store: the store's point layout has a FIXED node count per
     * instance, so adding or removing a skeleton node cannot be expressed there
     * at all. A non-resident frame is rebuilt from the store on next hydration
     * and comes back with the OLD node count. That is a genuine limitation, not
     * an oversight to paper over — surface it instead of applying silently.
     * @private
     */
    _warnResidentOnlyStructuralEdit(what) {
        var loader = this.lazyLoader;
        var total = loader ? (loader.nFrames || 0) : 0;
        var resident = this.frameGroups ? this.frameGroups.size : 0;
        if (total > 0 && resident < total) {
            console.warn('[session] ' + what + ' applied to ' + resident.toLocaleString() +
                ' resident frame(s) of ' + total.toLocaleString() + '. Frames not currently ' +
                'in memory are rebuilt from the lazy store, which stores a fixed node count ' +
                'per instance, so they will keep the previous skeleton. Skeleton edits are ' +
                'reliable only on a fully-loaded project.');
        }
    }

    /**
     * Propagate a skeleton node addition to all instances.
     * Appends one empty node slot to every Instance.
     *
     * RESIDENT-ONLY by necessity — see `_warnResidentOnlyStructuralEdit`.
     */
    propagateNodeAdded() {
        this._warnResidentOnlyStructuralEdit('Skeleton node added');
        // Update all instances in FrameGroups. `insertNodeAt` grows the flat
        // coordinate/occlusion buffers AND any backup together, so a later
        // restorePoints() stays node-aligned (luc3d #189 follow-up #1).
        for (const fg of this.frameGroups.values()) {
            for (const instances of fg.instances.values()) {
                for (const inst of instances) inst.insertNodeAt(inst.numNodes);
            }
            for (const unlinkedList of fg.unlinkedInstances.values()) {
                for (const ul of unlinkedList) ul.instance.insertNodeAt(ul.instance.numNodes);
            }
        }
    }

    /**
     * Propagate a skeleton node removal to all instances.
     * Removes node `nodeIdx` from every Instance.
     *
     * RESIDENT-ONLY by necessity — see `_warnResidentOnlyStructuralEdit`.
     * @param {number} nodeIdx - The index of the removed node
     */
    propagateNodeRemoved(nodeIdx) {
        this._warnResidentOnlyStructuralEdit('Skeleton node removed');
        // `removeNodeAt` shrinks the flat coordinate/occlusion buffers AND any
        // backup together (luc3d #189 follow-up #1).
        for (const fg of this.frameGroups.values()) {
            for (const instances of fg.instances.values()) {
                for (const inst of instances) inst.removeNodeAt(nodeIdx);
            }
            for (const unlinkedList of fg.unlinkedInstances.values()) {
                for (const ul of unlinkedList) ul.instance.removeNodeAt(nodeIdx);
            }
        }
        // Mark all instance groups as dirty (triangulation needs recomputing)
        for (const groups of this.instanceGroups.values()) {
            for (const group of groups) {
                group.markDirty();
                group.points3d = null;
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
        const groups = this.instanceGroups.get(frameIdx);
        let removed = false;
        if (groups) {
            const idx = groups.indexOf(group);
            if (idx >= 0) {
                groups.splice(idx, 1);
                removed = true;
            }
            if (groups.length === 0) {
                this.instanceGroups.delete(frameIdx);
            }
        }

        const fg = this.frameGroups.get(frameIdx);
        if (fg) {
            for (const [camName, instance] of group.instances) {
                const camInstances = fg.instances.get(camName);
                if (camInstances) {
                    const instIdx = camInstances.indexOf(instance);
                    if (instIdx >= 0) {
                        camInstances.splice(instIdx, 1);
                    }
                    if (camInstances.length === 0) {
                        fg.instances.delete(camName);
                    }
                }
            }
            if (fg.instances.size === 0 && fg.unlinkedInstances.size === 0) {
                this.frameGroups.delete(frameIdx);
            }
        }

        return removed;
    }

    /**
     * Unlink an InstanceGroup: remove the group but return its instances
     * to the unlinked pool instead of deleting them.
     *
     * Identity is RETAINED (luc3d #201). `group.identityId` dies with the group
     * object, and every downstream identity reader — the info panel's Ungrouped
     * row, `ui/overlays.js` `getInstanceColor`, the export paths, save/load —
     * resolves an unlinked instance's identity through `frameIdentityMap` alone,
     * with no group-level fallback available once the group is gone. So the
     * group's identity is stamped into the map for each member before it is
     * dropped. Without this, ungrouping reset every row's ID to "—" and threw
     * the assignment away, which made "swap the ID in one view" (the reported
     * workflow: ungroup both -> re-assign one row -> regroup) destructive.
     *
     * This only fills in a fact the tracker path already records —
     * `commitTrackedFrame` writes the same per-frame entries for every group
     * member — so it brings the grouping paths that set `identityId` alone
     * (`assignIdentityToGroup`, `createGroupFromUnlinked`) into line with it.
     *
     * @param {number} frameIdx
     * @param {InstanceGroup} group - The group to unlink
     * @returns {UnlinkedInstance[]} The newly created unlinked instances
     */
    unlinkGroup(frameIdx, group, forcePromoteToUser) {
        const fg = this.frameGroups.get(frameIdx);
        const newUnlinked = [];

        // Mixed groups (containing at least one UserInstance) are treated
        // as user-typed: any predicted member detached from the group is
        // promoted to user. `forcePromoteToUser` covers the case where the
        // caller knows the source was mixed before a member was removed —
        // e.g., per-view delete that drops the group to a single
        // (formerly mixed) survivor.
        let promote = !!forcePromoteToUser;
        if (!promote) {
            let hasUser = false, hasPred = false;
            for (const [, _inst] of group.instances) {
                if (_inst.type === 'user') hasUser = true;
                else if (_inst.type === 'predicted') hasPred = true;
            }
            promote = hasUser && hasPred;
        }

        const groups = this.instanceGroups.get(frameIdx);
        if (groups) {
            const idx = groups.indexOf(group);
            if (idx >= 0) {
                groups.splice(idx, 1);
            }
            if (groups.length === 0) {
                this.instanceGroups.delete(frameIdx);
            }
        }

        if (fg) {
            for (const [camName, instance] of group.instances) {
                const camInstances = fg.instances.get(camName);
                if (camInstances) {
                    const instIdx = camInstances.indexOf(instance);
                    if (instIdx >= 0) {
                        camInstances.splice(instIdx, 1);
                    }
                    if (camInstances.length === 0) {
                        fg.instances.delete(camName);
                    }
                }
                if (promote && instance.type === 'predicted') {
                    instance.type = 'user';
                    instance.modified = true;
                }
                this._retainIdentityOnUnlink(frameIdx, camName, instance, group.identityId);
                const ul = new UnlinkedInstance(instance, camName);
                fg.addUnlinkedInstance(camName, ul);
                newUnlinked.push(ul);
            }
        }

        return newUnlinked;
    }

    /**
     * Preserve a disbanding group's identity as a per-frame entry for one
     * member, so the detached instance still reads as the same animal
     * (luc3d #201). Called by `unlinkGroup` per member; deliberately
     * conservative — it only ever ADDS a fact that was implicit in
     * `group.identityId`, and never changes an identity anything already
     * resolves today:
     *
     *  - A **trackless** member keeps the identity ON THE INSTANCE
     *    (`instance.identityId`) instead of in the map: `frameIdentityMap` is
     *    keyed by raw trackIdx, and a null track keys one shared "-1" slot per
     *    camera, so two trackless instances in one view cannot be told apart
     *    there. The stamp OVERWRITES any older instance-level value — while
     *    grouped, `group.identityId` is the freshest truth for a trackless
     *    member (identity switches pin the group field; they cannot write the
     *    map for a null track), so a pre-existing instance value is stale by
     *    definition. This is the reporter's recurrence of #201: untracked
     *    predictions / manual annotations grouped and identified, then
     *    ungrouped — the map-only retention below never fired and every row
     *    read "—".
     *  - An existing **positive** map entry is left alone. It is what the
     *    grouped row and the 2D color path already prefer over
     *    `group.identityId`, so overwriting it would change the displayed
     *    identity rather than preserve it.
     *  - A key still **shared with another group in this frame** is skipped.
     *    That is the raw-trackIdx collision `commitTrackedFrame` guards with an
     *    explicit -1: the key cannot name one animal, and claiming it for the
     *    departing group would mis-color the group that is still there.
     */
    _retainIdentityOnUnlink(frameIdx, camName, instance, identityId) {
        if (identityId == null || identityId < 0) return;
        const trackIdx = instance ? instance.trackIdx : null;
        if (trackIdx == null) {
            if (instance) instance.identityId = identityId;
            return;
        }
        const existing = this.getFrameIdentityValue(frameIdx, camName, trackIdx);
        if (existing != null && existing >= 0) return;
        const siblings = this.instanceGroups.get(frameIdx);
        if (siblings) {
            for (let i = 0; i < siblings.length; i++) {
                const other = siblings[i].instances.get(camName);
                if (other && other.trackIdx === trackIdx) return;
            }
        }
        this.setFrameIdentity(frameIdx, camName, trackIdx, identityId);
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
        // The group owns the identity from here (see createGroupFromUnlinked).
        unlinked.instance.identityId = null;
        group.markDirty();
    }

    /**
     * Assign an identity to a TRACKLESS unlinked instance (luc3d #201) — the
     * one-view correction for detections `frameIdentityMap` cannot key (a null
     * track is one shared per-camera slot). Per-frame by nature: with no track
     * there is no linkage to carry the correction to other frames. Within the
     * frame it keeps the camera duplicate-free by handing the vacated identity
     * to the trackless unlinked row that already held the target, mirroring
     * the tracked swap semantics.
     *
     * @param {number} frameIdx
     * @param {string} camName the instance's own camera
     * @param {Instance} instance TRACKLESS unlinked instance to correct
     * @param {number} identityId the new identity (>= 0)
     * @returns {{oldIdentityId:(number|null), swappedWithOther:boolean}}
     */
    assignIdentityToUnlinkedTrackless(frameIdx, camName, instance, identityId) {
        var oldIdentityId = (instance.identityId != null && instance.identityId >= 0)
            ? instance.identityId : null;
        var swappedWithOther = false;
        var fg = this.frameGroups.get(frameIdx);
        var pool = fg ? fg.getUnlinkedInstances(camName) : null;
        if (pool && identityId != null && identityId >= 0) {
            for (var i = 0; i < pool.length; i++) {
                var other = pool[i].instance;
                if (!other || other === instance || other.trackIdx != null) continue;
                if (other.identityId === identityId) {
                    other.identityId = oldIdentityId;
                    swappedWithOther = true;
                    break;
                }
            }
        }
        instance.identityId = (identityId != null && identityId >= 0) ? identityId : null;
        return { oldIdentityId: oldIdentityId, swappedWithOther: swappedWithOther };
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
export function clonePoints(points) {
    if (!points) return null;
    const cloned = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        cloned[i] = pt != null ? [pt[0], pt[1]] : null;
    }
    return cloned;
}


// --------------------------------------------------------------------------
// 3D point arrays (`InstanceGroup.points3d`)
// --------------------------------------------------------------------------
//
// A triangulated pose is stored as a FLAT `Float64Array` of `3 * nNodes`
// coordinates — node k occupies [3k, 3k+1, 3k+2] — rather than as an array of
// boxed `[x,y,z]|null` triples.
//
// WHY: on the real 180,210-frame project there are 531,799 instance groups x 15
// nodes = 7,976,985 keypoints. As boxed rows that measured 808 B per group
// (410 MB) held entirely in V8's pointer-compressed heap, which a Chrome
// renderer hard-caps near 4 GB. Flat, the same data is ~116 B per group in the
// cage (59 MB) plus a backing store that lives OUTSIDE the cap. Measured, not
// estimated: see `tests/e2e/_diag-repr-sizing.mjs`.
//
// f64 (not f32) is deliberate: it costs nothing in the cage — only the external
// backing store doubles — and keeps every coordinate bit-identical to the boxed
// representation, so `tests/e2e/save-golden-digest.mjs` stays byte-for-byte
// unchanged across the conversion.
//
// A missing / un-triangulated node is an ALL-NaN triple, replacing the old
// `null` row. This collapses "null" and "NaN-valued" into one state, which the
// SLP format has always done anyway (it writes NaN for missing 3D keypoints),
// so a save/reload round-trip already erased the distinction.

/** Coordinates per node in a `points3d` array. */
export var POINT3D_STRIDE = 3;

/**
 * Allocate a `points3d` array with every node marked missing (all-NaN).
 * @param {number} nNodes
 * @returns {Float64Array}
 */
export function makePoints3d(nNodes) {
    var pts = new Float64Array(nNodes * POINT3D_STRIDE);
    pts.fill(NaN);
    return pts;
}

/** Number of nodes a `points3d` array holds. @param {Float64Array} pts */
export function points3dNodeCount(pts) {
    return pts ? (pts.length / POINT3D_STRIDE) | 0 : 0;
}

/**
 * Is node `k` triangulated? A node counts as present only when all three
 * coordinates are finite — a partially-NaN triple is meaningless in 3D.
 * @param {Float64Array} pts
 * @param {number} k
 */
export function hasPoint3d(pts, k) {
    if (!pts) return false;
    var o = k * POINT3D_STRIDE;
    return !Number.isNaN(pts[o]) && !Number.isNaN(pts[o + 1]) && !Number.isNaN(pts[o + 2]);
}

/**
 * Read node `k` as a boxed `[x,y,z]`, or null when missing. ALLOCATES — for
 * one-off reads. Use `readPoint3d` in a loop.
 * @param {Float64Array} pts
 * @param {number} k
 * @returns {number[]|null}
 */
export function getPoint3d(pts, k) {
    if (!hasPoint3d(pts, k)) return null;
    var o = k * POINT3D_STRIDE;
    return [pts[o], pts[o + 1], pts[o + 2]];
}

/**
 * Allocation-free read of node `k` into a caller-owned 3-element `out`.
 * @param {Float64Array} pts
 * @param {number} k
 * @param {number[]} out
 * @returns {number[]|null} `out` when the node is present, else null
 */
export function readPoint3d(pts, k, out) {
    if (!hasPoint3d(pts, k)) return null;
    var o = k * POINT3D_STRIDE;
    out[0] = pts[o]; out[1] = pts[o + 1]; out[2] = pts[o + 2];
    return out;
}

/**
 * Write node `k`. A null/undefined `xyz` marks the node missing.
 * @param {Float64Array} pts
 * @param {number} k
 * @param {number[]|null} xyz
 */
export function setPoint3d(pts, k, xyz) {
    var o = k * POINT3D_STRIDE;
    if (xyz == null) {
        pts[o] = NaN; pts[o + 1] = NaN; pts[o + 2] = NaN;
    } else {
        pts[o] = xyz[0]; pts[o + 1] = xyz[1]; pts[o + 2] = xyz[2];
    }
}

/** Mark node `k` missing. @param {Float64Array} pts @param {number} k */
export function clearPoint3d(pts, k) {
    var o = k * POINT3D_STRIDE;
    pts[o] = NaN; pts[o + 1] = NaN; pts[o + 2] = NaN;
}

/** Does any node have a triangulated position? @param {Float64Array} pts */
export function someValidPoint3d(pts) {
    if (!pts) return false;
    for (var k = 0, n = points3dNodeCount(pts); k < n; k++) {
        if (hasPoint3d(pts, k)) return true;
    }
    return false;
}

/** How many nodes are triangulated. @param {Float64Array} pts */
export function countPoints3d(pts) {
    var c = 0;
    for (var k = 0, n = points3dNodeCount(pts); k < n; k++) {
        if (hasPoint3d(pts, k)) c++;
    }
    return c;
}

/** Copy a `points3d` array. @param {Float64Array} pts */
export function clonePoints3d(pts) {
    return pts ? new Float64Array(pts) : null;
}

/**
 * Boxed `[[x,y,z]|null, ...]` view, for the serialization boundaries that must
 * keep emitting the legacy shape (the JSON project format, the points3d.h5
 * export). ALLOCATES the whole boxed structure — never call it on a whole
 * project's worth of groups at once.
 * @param {Float64Array} pts
 * @returns {(number[]|null)[]|null}
 */
export function toBoxedPoints3d(pts) {
    if (!pts) return null;
    var n = points3dNodeCount(pts);
    var out = new Array(n);
    for (var k = 0; k < n; k++) out[k] = getPoint3d(pts, k);
    return out;
}

/**
 * Build a `points3d` array from boxed `[[x,y,z]|null, ...]` rows.
 * @param {(number[]|null)[]} boxed
 * @returns {Float64Array|null}
 */
export function fromBoxedPoints3d(boxed) {
    if (!boxed) return null;
    var pts = new Float64Array(boxed.length * POINT3D_STRIDE);
    for (var k = 0; k < boxed.length; k++) setPoint3d(pts, k, boxed[k]);
    return pts;
}

/**
 * Normalize whatever a reader handed us into the flat representation: a
 * `Float64Array` passes through untouched (no copy), boxed rows are converted,
 * null stays null. Use this at every ingest boundary — the SLP reader emits
 * flat arrays on the columnar path but boxed rows on the legacy fallback, and
 * restored JSON projects are always boxed.
 * @param {Float64Array|(number[]|null)[]|null} v
 * @returns {Float64Array|null}
 */
export function asPoints3d(v) {
    if (v == null) return null;
    if (v instanceof Float64Array) return v;
    if (ArrayBuffer.isView(v)) return new Float64Array(v);
    return fromBoxedPoints3d(v);
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
export function mat3x3Multiply(A, B) {
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
export function mat3x3Multiply3x4(A, B) {
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
