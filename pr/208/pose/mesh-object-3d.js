// pose/mesh-object-3d.js — a NAMED GROUP OF PLANES, and nothing geometric.
//
// The layering this module completes, stated once:
//
//     node    a point with ONE 3D position, in the global pool
//     plane   simply a group of nodes
//     object  a group of planes — and its SHAPE is determined by how those
//             planes are CONNECTED, i.e. by which nodes they share
//
// So a cage is three planes (floor, back, side) that reference the same corner
// nodes where they meet. Nothing here computes that shape; `mesh-object-geometry.js`
// derives it on demand. This file owns identity, naming and membership only —
// the authoring layer, which is the half that gets written to the project file.
//
// The class is `MeshObject3D` because a JS identifier may not begin with a
// digit. Every USER-FACING string says "3D Mesh Object"; the code says
// `MeshObject3D`. That mismatch is deliberate and worth knowing before renaming
// anything.
//
// ## Strictly additive — nothing here reaches back into the plane model
//
// This module is new state sitting BESIDE the existing model. `PlaneNode`,
// `PlaneNodePool`, `PlaneSkeleton`, `PlaneInstance` and every `PlaneModel`
// method predate it and are untouched by it. In particular there is **no delete
// cascade**: `PlaneModel.deletePlane` does not know objects exist and is not
// going to be taught. Instead membership is resolved LAZILY —
// `resolvePlaneIds(model)` filters to the planes that still exist, every time it
// is asked. A deleted plane simply stops contributing a face.
//
// That is a real design choice, not laziness, and it buys three things:
//
//   1. `deletePlane` needs no hook, so this feature cannot change the behaviour
//      of a workflow that shipped before it.
//   2. There is no window in which the object holds a dangling reference,
//      because the reference is never dereferenced except through the filter.
//   3. Delete-then-undo (were it ever added) restores membership for free, since
//      the ID was never scrubbed.
//
// The cost is that `planeIds` may contain IDs that resolve to nothing. That is
// why `planeCount(model)` takes a model and `planeIds.length` is not the number
// of faces — call the former.
//
// DOM-free and dependency-free, like `plane-nodes.js` and `origin-frame.js`.

/**
 * Per-OBJECT colours, handed out round-robin as objects are created.
 *
 * Deliberately a different palette from `PLANE_COLORS` and `PLANE_NODE_COLORS`:
 * on screen an object's colour overrides its members' plane colours, and if the
 * two palettes overlapped the user could not tell "the floor, drawn as itself"
 * from "the floor, drawn as part of the cage".
 */
export const MESH_OBJECT_COLORS = [
    '#26a69a', '#ef5350', '#5c6bc0', '#d4e157',
    '#ec407a', '#29b6f6', '#ffa726', '#8d6e63',
];

/** Palette entry `i`, cycling. @param {number} i @returns {string} */
export function defaultMeshObjectColor(i) {
    var n = MESH_OBJECT_COLORS.length;
    return MESH_OBJECT_COLORS[((i % n) + n) % n];
}

/**
 * One 3D Mesh Object: a name, a colour, and the planes that make it up.
 *
 * Membership is an ORDERED LIST OF PLANE IDS. Order is preserved because it is
 * the order faces come out of the geometry builder, and therefore the order
 * they will appear in an exported file — a stable face order makes two exports
 * of an unchanged project diffable. It carries no geometric meaning: the shape
 * comes from shared nodes, not from the order planes were added.
 */
export class MeshObject3D {
    /**
     * @param {number} id - Stable, never reused within a `MeshObjectSet`.
     * @param {string} name
     * @param {string} color - CSS colour.
     */
    constructor(id, name, color) {
        this.id = id;
        this.name = name;
        this.color = color;
        /** @type {number[]} Plane IDs, in insertion order. May contain IDs of
         * planes that have since been deleted — see the module note. */
        this.planeIds = [];
        /**
         * @type {boolean} Invert every face normal after the coherent-orientation
         * pass.
         *
         * Stored on the OBJECT rather than passed per-call because it is a
         * property of the shape, not of the viewer: an OPEN object (a cage with
         * no lid) has no enclosed volume, so nothing can decide which side is
         * "out" — the signed-volume test that settles it for a closed mesh is
         * meaningless. Only the user knows, so their answer has to persist with
         * the object or they would re-answer it on every load.
         */
        this.flipNormals = false;
    }

    /** Is `planeId` a member? @param {number} planeId @returns {boolean} */
    hasPlane(planeId) {
        return this.planeIds.indexOf(planeId) >= 0;
    }

    /**
     * Add a plane. No-op when already a member.
     * @param {number} planeId
     * @returns {boolean} True when membership changed.
     */
    addPlane(planeId) {
        if (planeId == null || this.hasPlane(planeId)) return false;
        this.planeIds.push(planeId);
        return true;
    }

    /**
     * Remove a plane. No-op when not a member.
     * @param {number} planeId
     * @returns {boolean} True when membership changed.
     */
    removePlane(planeId) {
        var i = this.planeIds.indexOf(planeId);
        if (i < 0) return false;
        this.planeIds.splice(i, 1);
        return true;
    }

    /**
     * The member plane IDs that still resolve to a plane in `model`, in
     * membership order.
     *
     * THE accessor — see the module note on lazy resolution. Everything that
     * counts, draws or exports faces goes through here, so a deleted plane
     * cannot reach the geometry builder.
     *
     * @param {import('./plane-data.js').PlaneModel} model
     * @returns {number[]}
     */
    resolvePlaneIds(model) {
        if (!model) return [];
        var out = [];
        for (var i = 0; i < this.planeIds.length; i++) {
            if (model.getPlane(this.planeIds[i])) out.push(this.planeIds[i]);
        }
        return out;
    }

    /**
     * The member planes that still exist, in membership order.
     * @param {import('./plane-data.js').PlaneModel} model
     * @returns {import('./plane-data.js').PlaneSkeleton[]}
     */
    resolvePlanes(model) {
        if (!model) return [];
        var out = [];
        for (var i = 0; i < this.planeIds.length; i++) {
            var p = model.getPlane(this.planeIds[i]);
            if (p) out.push(p);
        }
        return out;
    }

    /**
     * How many members still exist. NOT `planeIds.length` — see the module note.
     * @param {import('./plane-data.js').PlaneModel} model
     * @returns {number}
     */
    planeCount(model) {
        return this.resolvePlaneIds(model).length;
    }

    /**
     * How many member IDs no longer resolve.
     *
     * Zero in every normal session; non-zero after the user deletes a plane that
     * was part of an object. Surfaced in the panel rather than silently swept,
     * because "my cage lost a wall" should have a visible cause.
     *
     * @param {import('./plane-data.js').PlaneModel} model
     * @returns {number}
     */
    danglingCount(model) {
        return this.planeIds.length - this.planeCount(model);
    }
}

/**
 * Every 3D Mesh Object in the project, in creation order.
 *
 * Mirrors `PlaneNodePool`'s contract for IDs — monotonic, never reused, and
 * `adoptObject` for the restore path — because the same argument applies: an
 * object is addressed by ID from the panel's selection and from the project
 * file, and re-minting IDs on load would silently re-point them.
 */
export class MeshObjectSet {
    constructor() {
        /** @type {MeshObject3D[]} Ordered; the table's row order. */
        this.objects = [];
        /** @type {Map<number, MeshObject3D>} @private */
        this._byId = new Map();
        /** @private Monotonic; IDs are NEVER reused. */
        this._nextId = 1;
        /** @private Monotonic colour cursor, for the same reason
         * `PlaneNodePool._colorSeq` is not `nodes.length`: deleting an object
         * must not hand its colour to the next one created. */
        this._colorSeq = 0;
    }

    /** How many objects the set holds. @returns {number} */
    get size() { return this.objects.length; }

    /** Is the set empty? Used to decide whether to write the key at all. */
    get isEmpty() { return this.objects.length === 0; }

    /**
     * Create an object.
     * @param {string} [name]
     * @param {{color?:string}} [opts]
     * @returns {MeshObject3D}
     */
    createObject(name, opts) {
        var o = opts || {};
        var id = this._nextId++;
        var obj = new MeshObject3D(
            id,
            name || ('Object ' + id),
            o.color || defaultMeshObjectColor(this._colorSeq++)
        );
        this.objects.push(obj);
        this._byId.set(obj.id, obj);
        return obj;
    }

    /**
     * Adopt an already-built object, KEEPING ITS ID. Restore path only —
     * see `PlaneNodePool.adoptNode`, whose argument this repeats exactly.
     * @param {MeshObject3D} obj
     * @returns {boolean} False when the ID is already taken (nothing adopted).
     */
    adoptObject(obj) {
        if (!obj || this._byId.has(obj.id)) return false;
        this.objects.push(obj);
        this._byId.set(obj.id, obj);
        if (obj.id >= this._nextId) this._nextId = obj.id + 1;
        this._colorSeq++;
        return true;
    }

    /** @param {number} id @returns {MeshObject3D|null} */
    getObject(id) {
        var obj = this._byId.get(id);
        return obj || null;
    }

    /**
     * Delete an object. The planes it referenced are NOT touched — an object is
     * a grouping, and dissolving the group cannot destroy its members.
     * @param {number|MeshObject3D} objOrId
     * @returns {boolean} True when something was deleted.
     */
    deleteObject(objOrId) {
        var id = (objOrId && objOrId.id !== undefined) ? objOrId.id : objOrId;
        var obj = this._byId.get(id);
        if (!obj) return false;
        var i = this.objects.indexOf(obj);
        if (i >= 0) this.objects.splice(i, 1);
        this._byId.delete(id);
        return true;
    }

    /**
     * Rename. Empty / blank names are refused rather than silently accepted —
     * an unnamed row in the table is indistinguishable from a broken one.
     * @param {number|MeshObject3D} objOrId @param {string} name
     * @returns {boolean} True when the name changed.
     */
    renameObject(objOrId, name) {
        var obj = this._resolve(objOrId);
        if (!obj) return false;
        var next = (name == null) ? '' : String(name).trim();
        if (!next || next === obj.name) return false;
        obj.name = next;
        return true;
    }

    /**
     * Re-colour.
     * @param {number|MeshObject3D} objOrId @param {string} color
     * @returns {boolean} True when the colour changed.
     */
    recolorObject(objOrId, color) {
        var obj = this._resolve(objOrId);
        if (!obj || !color || color === obj.color) return false;
        obj.color = color;
        return true;
    }

    /**
     * Which objects reference `planeId`. The inverse of membership, for the
     * plane table's "part of N objects" hint.
     * @param {number} planeId @returns {MeshObject3D[]}
     */
    objectsForPlane(planeId) {
        var out = [];
        for (var i = 0; i < this.objects.length; i++) {
            if (this.objects[i].hasPlane(planeId)) out.push(this.objects[i]);
        }
        return out;
    }

    /** Drop every object. The teardown half of a project load. */
    clear() {
        this.objects = [];
        this._byId = new Map();
        this._nextId = 1;
        this._colorSeq = 0;
    }

    /** @private @param {number|MeshObject3D} objOrId @returns {MeshObject3D|null} */
    _resolve(objOrId) {
        if (objOrId && objOrId.id !== undefined) return this._byId.get(objOrId.id) || null;
        return this._byId.get(objOrId) || null;
    }
}
