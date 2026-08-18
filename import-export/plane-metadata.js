// import-export/plane-metadata.js — the `metadata.lucid` <-> plane-state mapping.
//
// The Define Planes pipeline (nodes, planes, per-view 2D, triangulation, plane
// fit, the origin frame) is project state: it describes THIS project's cage,
// floor and reference geometry, so it belongs in the project file. Until now
// none of it was persisted, which is why plane edits deliberately did not mark
// the project dirty — flagging a project dirty for state a save would silently
// drop is worse than losing it. This module is what makes it save-able, and the
// `markDirty()` calls in `ui/plane-definition.js` are what makes it noticed.
//
// ## The scope split, and why one payload is written N times
//
// `metadata.lucid` is PER SESSION, but the plane model is not:
//
//   * The node pool, the planes and the origin frame are PROJECT-scoped — a
//     node has one 3D position, whatever session you are looking at. These are
//     written IDENTICALLY into every session's dict so that opening any one
//     session of a multi-session project restores the same geometry, and read
//     back by whichever session is ingested first (the rest are the same bytes).
//     Duplication is the price of a per-session container; the payload is a few
//     dozen nodes, not a frame table.
//   * The per-view 2D (`PlaneInstance`) is SESSION-scoped, because a view
//     belongs to a session. It lives on `Session.planePlacements`, which is
//     exactly where `ui/plane-definition.js`'s `planeModel()` picks it up.
//
// ## Contract (the same three rules `visibility-metadata.js` holds)
//
//   1. **Defaults are never written.** A project that never opened the feature
//      produces no keys at all, so its bytes are unchanged and
//      `tests/e2e/save-golden-digest.mjs` must not move.
//   2. **Only `lucid` is touched.** `writePlaneMetadata` mutates the dict it is
//      handed and reads nothing else off the session, so `sessionName` /
//      `tracks` / `identities` / `skeleton` / `frameIdentityMap` / the
//      Visibility keys are all safe from it.
//   3. **Reads tolerate absence and garbage.** Every key is optional and every
//      restore path drops what it cannot resolve rather than throwing — a
//      `.slp` from SLEAP, or from a LUCID build older than this module, loads
//      with an empty plane model.
//
// Purely additive to the format: optional keys in LUCID's own `metadata.lucid`
// dict, which sleap-io and sleap-io.js round-trip as opaque JSON.
//
// ## What is deliberately NOT written
//
// The plane panel's node size, edge width and 3D corner size are browser-local
// display taste — the same category as the Visibility panel's global appearance
// preferences, and kept out of the `.slp` for the same reason: opening a
// colleague's project must not silently resize your overlays. So are the
// editor's transient selections (which plane is selected, which placement rows
// are expanded). The one thing restored beyond the data is the plane SELECTION
// being re-pointed at a plane that still exists, because a selection naming a
// deleted plane renders an editor with nothing in it.

import {
    serializePlaneProject, restorePlaneProject,
    serializePlanePlacements, restorePlanePlacements,
    serializeOriginFrame, restoreOriginFrame,
} from '../pose/plane-serialization.js';
// Circular by design, and safe for the same reason the rest of this feature's
// cycles are: every use below is inside a function body, so the bindings are
// resolved at call time rather than at module evaluation.
import { planeState } from '../ui/plane-definition.js';
import { originState } from '../ui/origin-definition.js';
import { state } from '../ui/app-state.js';

/**
 * Every `metadata.lucid` key this module may write. Exported so the
 * slim-metadata and golden-digest guards can assert that a project which never
 * opened Define Planes carries none of them, without duplicating the list.
 *
 * @type {string[]}
 */
export const PLANE_METADATA_KEYS = [
    'planeNodes',
    'planes',
    'planePlacements',
    'planeOrigin',
];

/**
 * Write a session's plane state into a `metadata.lucid` dict.
 *
 * Mutates `lucid` in place and returns it. Keys with nothing to say are omitted
 * entirely rather than written empty — see invariant 1.
 *
 * @param {Object} lucid - the `metadata.lucid` dict to extend
 * @param {Object} session - a `pose/pose-data.js` Session
 * @returns {Object} the same `lucid` object
 */
export function writePlaneMetadata(lucid, session) {
    if (!lucid || !session) return lucid;
    var model = planeState.model;
    if (!model) return lucid;

    // Project-scoped: the same bytes in every session's dict.
    var project = serializePlaneProject(model);
    if (project) {
        if (project.planeNodes) lucid.planeNodes = project.planeNodes;
        if (project.planes) lucid.planes = project.planes;
    }

    var origin = serializeOriginFrame(originState.frame);
    if (origin) lucid.planeOrigin = origin;

    // Session-scoped: THIS session's 2D, read off the Session rather than off
    // the model, so saving a background session writes ITS placements and not
    // whichever map the model happens to have attached.
    var placements = serializePlanePlacements(session.planePlacements, model.pool);
    if (placements) lucid.planePlacements = placements;

    return lucid;
}

/**
 * Read a `metadata.lucid` dict's plane state back.
 *
 * Two different destinations, because the state has two different scopes:
 * placements land on `session`, and the pool / planes / origin land on the
 * shared model — but only when it is still EMPTY. That guard is what makes
 * ingesting N sessions of a multi-session project idempotent: the first session
 * carrying plane state restores it, and the rest (which hold identical bytes)
 * are skipped rather than appended, which would double every node.
 *
 * The corollary is that a LOAD MUST START FROM AN EMPTY MODEL — call
 * `resetPlaneState()` when tearing the previous project down. Without it, the
 * old project's planes survive and the new project's are the ones dropped.
 *
 * Safe to call with `null` / `undefined` / garbage.
 *
 * @param {Object} session - a `pose/pose-data.js` Session
 * @param {*} lucid - the `metadata.lucid` dict from disk (may be absent)
 * @returns {Object} session
 */
export function readPlaneMetadata(session, lucid) {
    if (!session) return session;
    var src = (lucid && typeof lucid === 'object') ? lucid : {};
    var model = planeState.model;
    if (!model) return session;

    if (!model.pool.size && !model.planes.length) {
        restorePlaneProject(model, src);
        if (src.planeOrigin) originState.frame = restoreOriginFrame(src.planeOrigin);
        // A selection naming a plane that is gone renders an empty editor.
        if (!model.getPlane(planeState.selectedPlaneId)) {
            planeState.selectedPlaneId = model.planes.length ? model.planes[0].id : null;
        }
    }

    var planeIds = model.planes.map(function (p) { return p.id; });
    var placements = restorePlanePlacements(src.planePlacements, model.pool, planeIds);
    // Assign unconditionally: a session with no stored placements must come
    // back with an EMPTY map, not with whatever map it had before the load.
    session.planePlacements = placements;
    // The model may still be pointing at the previous project's map. When THIS
    // session is the active one, re-point it now rather than waiting for the
    // next `planeModel()` call — the load path draws overlays before anything
    // asks the model for its 2D again. For a background session the map is
    // simply parked on the Session and adopted on the next session switch,
    // which is the same route a runtime switch takes.
    if (state.session === session && model.placements !== placements) {
        model.attachPlacements(placements);
    }

    return session;
}

/**
 * Empty the plane model and drop the applied origin.
 *
 * Called by every path that tears the previous project down. `readPlaneMetadata`
 * only restores into an empty model (see its note), so skipping this on a load
 * path does not merge the two projects — it keeps the OLD one and silently
 * discards the new one's planes.
 */
export function resetPlaneState() {
    var model = planeState.model;
    if (model) {
        restorePlaneProject(model, null);
        model.placements = new Map();
        model._nextInstanceId = 1;
    }
    planeState.selectedPlaneId = null;
    if (planeState.expanded) planeState.expanded.clear();
    originState.frame = null;
}
