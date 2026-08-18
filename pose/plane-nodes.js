// pose/plane-nodes.js — the GLOBAL pool of plane nodes.
//
// A plane node used to belong to exactly one plane: `PlaneSkeleton` owned a
// node-name list, a colour list, and a flat `points3d` indexed by that list.
// That representation cannot express the thing this feature is actually for —
// two planes MEETING along a shared line. If the shared corners are duplicated
// (one copy per plane) they are two independent 3D points that drift apart the
// moment either plane is re-triangulated or re-fitted, and the intersection
// line the user annotated silently splits.
//
// So nodes moved OUT of the planes and into one pool:
//
//   PlaneNodePool — every plane node in the project, in a stable order.
//   PlaneNode     — one node: identity, appearance, its 3D, its immutability.
//   PlaneSkeleton — (in `plane-data.js`) an ordered list of node IDs + edges.
//
// Three properties follow, and they are the whole reason for the split:
//
//   1. THE 3D LIVES ON THE NODE. One node, one `[x,y,z]` — so a corner shared
//      by two planes IS the same point by construction, not by two writers
//      agreeing to keep two copies in step. `planeFit` stays per-plane, because
//      two planes through the same edge genuinely have different fits.
//   2. IDENTITY IS AN ID, NEVER AN INDEX. IDs are handed out monotonically and
//      never reused. Edges and plane membership are stored as IDs, so deleting
//      or reordering a node cannot silently re-point an edge at its neighbour.
//   3. IMMUTABILITY IS A NODE PROPERTY. A node the user has pinned (a surveyed
//      reference, a corner already used to define the origin) must not be moved
//      by a later solve — and since the coordinate lives here rather than on a
//      plane, no plane-level invalidation can destroy it either.
//
// The 3D representation is a per-node `Float64Array(3)` rather than one flat
// array on the pool. A flat pool-order array would have to be spliced in step
// with the node list on every add/remove/reorder — exactly the index-shifting
// fragility this module exists to remove. Callers that want the flat form ask
// for it explicitly (`points3d()` here, `points3dForPlane()` in
// `plane-data.js`) and get a fresh array laid out in the order they asked for.
// Missing coordinates are an all-NaN triple, matching `InstanceGroup.points3d`.

/**
 * Default per-NODE colours, handed out in creation order. Chosen to stay
 * legible on video and to be tellable apart from each other — a plane node's
 * colour is the cross-view correspondence cue (red-in-camA must be the same
 * physical corner as red-in-camB), so these need to be distinguishable at a
 * glance.
 */
export const PLANE_NODE_COLORS = [
    '#ff5252', '#40c4ff', '#69f0ae', '#ffd740',
    '#e040fb', '#ff6e40', '#18ffff', '#b2ff59',
    '#ff4081', '#7c4dff', '#eeff41', '#64ffda',
];

/** Palette entry `i`, cycling. @param {number} i @returns {string} */
export function defaultNodeColor(i) {
    return PLANE_NODE_COLORS[((i % PLANE_NODE_COLORS.length) + PLANE_NODE_COLORS.length) %
        PLANE_NODE_COLORS.length];
}

/**
 * One plane node: a physical feature in the scene (a corner, a mark on a wall)
 * that any number of planes may reference.
 *
 * `xyz` is the single source of truth for this node's 3D. Nothing else in the
 * model stores a plane node's position — `points3dForPlane()` materializes a
 * per-plane view of it on demand and is never written back to directly.
 */
export class PlaneNode {
    /**
     * @param {number} id - Stable, never reused within a `PlaneNodePool`.
     * @param {string} name
     * @param {string} color - CSS colour, used in 2D and 3D alike.
     * @param {boolean} [immutable=false]
     */
    constructor(id, name, color, immutable) {
        this.id = id;
        this.name = name;
        this.color = color;
        /**
         * @type {boolean} The user pinned this node's 3D: a solve may READ it
         * but must never MOVE it. Settable at any time, including before the
         * node has any 3D at all — see `nodeFreezeState` for why that state is
         * worth naming rather than forbidding.
         */
        this.immutable = !!immutable;
        /**
         * @type {Float64Array} `[x,y,z]`; all-NaN means "not triangulated",
         * the same convention `InstanceGroup.points3d` uses.
         */
        this.xyz = new Float64Array(3);
        this.xyz[0] = NaN; this.xyz[1] = NaN; this.xyz[2] = NaN;
        /**
         * @type {number|null} Mean reprojection error of `xyz`, in px, or null
         * when unknown. Per-NODE rather than per-plane: one 3D point has one
         * error however many planes reference it.
         */
        this.error = null;
    }

    /** Is this node triangulated? All three coords must be finite. @returns {boolean} */
    hasPoint3d() {
        return isFinite(this.xyz[0]) && isFinite(this.xyz[1]) && isFinite(this.xyz[2]);
    }

    /** Boxed `[x,y,z]`, or null when untriangulated. ALLOCATES. @returns {number[]|null} */
    getPoint3d() {
        return this.hasPoint3d() ? [this.xyz[0], this.xyz[1], this.xyz[2]] : null;
    }

    /**
     * Write this node's 3D.
     *
     * Refuses on an immutable node unless `force` — that refusal is the entire
     * mechanism behind the immutable flag, so every writer in the model funnels
     * through here rather than touching `xyz` directly. `force` exists for the
     * one legitimate case: the user explicitly re-entering a pinned coordinate.
     *
     * @param {number[]|Float64Array|null} xyz - null clears the point.
     * @param {{force?:boolean}} [opts]
     * @returns {boolean} True when the write happened.
     */
    setPoint3d(xyz, opts) {
        if (this.immutable && !(opts && opts.force)) return false;
        if (xyz == null) {
            this.xyz[0] = NaN; this.xyz[1] = NaN; this.xyz[2] = NaN;
            return true;
        }
        this.xyz[0] = xyz[0]; this.xyz[1] = xyz[1]; this.xyz[2] = xyz[2];
        return true;
    }

    /**
     * Drop this node's 3D (and its error). Honours `immutable` exactly as
     * `setPoint3d` does — a pinned coordinate must survive an invalidation
     * cascade triggered by an unrelated edit.
     * @param {{force?:boolean}} [opts]
     * @returns {boolean} True when it was cleared.
     */
    clearPoint3d(opts) {
        if (!this.setPoint3d(null, opts)) return false;
        this.error = null;
        return true;
    }
}

/**
 * The three states a node can be in with respect to solving, as one value.
 *
 * `frozen-unsolved` is a real dead end and is named rather than hidden: the
 * user is allowed to pin a node before anything has been triangulated (marking
 * a known reference up front is a reasonable thing to want), but such a node
 * can never ACQUIRE a 3D, because being pinned is exactly what forbids a solve
 * from writing one. Downstream — a constrained fit deciding what to hold fixed,
 * a panel deciding what to warn about — needs to tell that apart from a pinned
 * node that actually has coordinates, without re-deriving the condition and
 * getting it subtly different in each place.
 *
 * @param {PlaneNode} node
 * @returns {'mutable'|'frozen'|'frozen-unsolved'}
 */
export function nodeFreezeState(node) {
    if (!node || !node.immutable) return 'mutable';
    return node.hasPoint3d() ? 'frozen' : 'frozen-unsolved';
}

/**
 * Every plane node in the project, in a stable order.
 *
 * The ORDER is the canonical index space for 2D: one `PlaneInstance` per view
 * covers the whole pool, index `i` being `pool.nodeAt(i)`. The pool therefore
 * owns the only operations that change that space (`addNode` / `removeNode` /
 * `moveNode`), and `PlaneModel` is what keeps the per-view instances in step
 * with them — call those through the model, not here, unless you are the model.
 */
export class PlaneNodePool {
    constructor() {
        /** @type {PlaneNode[]} Ordered; the index space every `PlaneInstance` uses. */
        this.nodes = [];
        /** @type {Map<number, PlaneNode>} @private */
        this._byId = new Map();
        /** @private Monotonic; IDs are NEVER reused. */
        this._nextId = 1;
        /**
         * @private Monotonic colour cursor. Deliberately not `nodes.length` —
         * that would hand a fresh node the colour of a live neighbour after a
         * deletion, and colour is the cross-view correspondence cue.
         */
        this._colorSeq = 0;
    }

    /** How many nodes the pool holds. @returns {number} */
    get size() { return this.nodes.length; }

    /**
     * Append a node.
     * @param {string} name
     * @param {{color?:string, immutable?:boolean}} [opts]
     * @returns {PlaneNode}
     */
    addNode(name, opts) {
        var o = opts || {};
        var node = new PlaneNode(
            this._nextId++,
            name || ('n' + this._nextId),
            o.color || defaultNodeColor(this._colorSeq++),
            !!o.immutable
        );
        this.nodes.push(node);
        this._byId.set(node.id, node);
        return node;
    }

    /**
     * Adopt an already-built node, KEEPING ITS ID. Restore path only.
     *
     * `addNode` mints an ID, which is wrong for a project being read back from
     * disk: plane membership, plane edges and every placement's `nodeIds`
     * ledger are all stored as IDs, so re-minting them would re-point every one
     * of those references at whatever node happened to land in that slot. The
     * ID here comes from the file and is authoritative.
     *
     * `_nextId` is advanced past the adopted ID so the pool's "IDs are NEVER
     * reused" promise survives a load — a node created after opening a project
     * must not collide with one that was deleted before it was saved.
     *
     * @param {PlaneNode} node
     * @returns {boolean} False when the ID is already taken (nothing adopted).
     */
    adoptNode(node) {
        if (!node || this._byId.has(node.id)) return false;
        this.nodes.push(node);
        this._byId.set(node.id, node);
        if (node.id >= this._nextId) this._nextId = node.id + 1;
        this._colorSeq++;
        return true;
    }

    /**
     * Remove a node by ID. LOW LEVEL — it shifts the index space every
     * `PlaneInstance` is keyed by, and leaves plane membership and edges
     * pointing at a node that is gone. Use `PlaneModel.deleteNode`.
     * @param {number} id
     * @returns {{node:PlaneNode, index:number}|null} null when unknown.
     */
    removeNode(id) {
        var index = this.indexOf(id);
        if (index < 0) return null;
        var node = this.nodes.splice(index, 1)[0];
        this._byId.delete(id);
        return { node: node, index: index };
    }

    /**
     * Move node at `from` to `to` (array-splice semantics). LOW LEVEL — see
     * `removeNode`; use `PlaneModel.moveNode`.
     * @param {number} from @param {number} to @returns {boolean}
     */
    moveNode(from, to) {
        var n = this.nodes.length;
        if (from < 0 || from >= n || to < 0 || to >= n || from === to) return false;
        var node = this.nodes.splice(from, 1)[0];
        this.nodes.splice(to, 0, node);
        return true;
    }

    /** The node with this ID, or null. @param {number} id @returns {PlaneNode|null} */
    getNode(id) {
        var n = this._byId.get(id);
        return n === undefined ? null : n;
    }

    /** The node at pool index `i`, or null. @param {number} i @returns {PlaneNode|null} */
    nodeAt(i) {
        return (i >= 0 && i < this.nodes.length) ? this.nodes[i] : null;
    }

    /** Pool index of `id`, or -1. @param {number} id @returns {number} */
    indexOf(id) {
        for (var i = 0; i < this.nodes.length; i++) if (this.nodes[i].id === id) return i;
        return -1;
    }

    /** Does the pool hold this ID? @param {number} id @returns {boolean} */
    has(id) { return this._byId.has(id); }

    /** Every node ID, in pool order. @returns {number[]} */
    ids() {
        return this.nodes.map(function (n) { return n.id; });
    }

    /** Every node name, in pool order. @returns {string[]} */
    names() {
        return this.nodes.map(function (n) { return n.name; });
    }

    /** Every node colour, in pool order. @returns {string[]} */
    colors() {
        return this.nodes.map(function (n) { return n.color; });
    }

    /**
     * Pin / unpin a node. Settable at ANY time — including on a node with no
     * 3D yet (`nodeFreezeState` reports that as `frozen-unsolved`). Setting the
     * flag never fabricates a coordinate and clearing it never destroys one.
     * @param {number} id @param {boolean} immutable @returns {boolean} Applied?
     */
    setImmutable(id, immutable) {
        var node = this.getNode(id);
        if (!node) return false;
        node.immutable = !!immutable;
        return true;
    }

    /** Freeze state of node `id`. @param {number} id @returns {'mutable'|'frozen'|'frozen-unsolved'} */
    freezeState(id) {
        return nodeFreezeState(this.getNode(id));
    }

    /** Is node `id` triangulated? @param {number} id @returns {boolean} */
    hasPoint3d(id) {
        var node = this.getNode(id);
        return !!node && node.hasPoint3d();
    }

    /** Boxed 3D of node `id`, or null. @param {number} id @returns {number[]|null} */
    getPoint3d(id) {
        var node = this.getNode(id);
        return node ? node.getPoint3d() : null;
    }

    /**
     * Write node `id`'s 3D, honouring `immutable` (see `PlaneNode.setPoint3d`).
     * @param {number} id @param {number[]|Float64Array|null} xyz
     * @param {{force?:boolean}} [opts]
     * @returns {boolean} True when written.
     */
    setPoint3d(id, xyz, opts) {
        var node = this.getNode(id);
        return !!node && node.setPoint3d(xyz, opts);
    }

    /**
     * Drop node `id`'s 3D, honouring `immutable`.
     * @param {number} id @param {{force?:boolean}} [opts] @returns {boolean}
     */
    clearPoint3d(id, opts) {
        var node = this.getNode(id);
        return !!node && node.clearPoint3d(opts);
    }

    /**
     * Flat `[x,y,z]` per node in POOL order — the representation the 3D viewer
     * and the fit math already speak. Freshly allocated, so mutating it does
     * NOT write back; use `setPoint3d` for that.
     * @returns {Float64Array}
     */
    points3d() {
        var out = new Float64Array(this.nodes.length * 3);
        for (var i = 0; i < this.nodes.length; i++) {
            var xyz = this.nodes[i].xyz;
            out[i * 3] = xyz[0]; out[i * 3 + 1] = xyz[1]; out[i * 3 + 2] = xyz[2];
        }
        return out;
    }

    /** IDs of every node a solve is allowed to move. @returns {number[]} */
    mutableIds() {
        var out = [];
        for (var i = 0; i < this.nodes.length; i++) {
            if (!this.nodes[i].immutable) out.push(this.nodes[i].id);
        }
        return out;
    }
}
