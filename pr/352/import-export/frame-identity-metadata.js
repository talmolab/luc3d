// import-export/frame-identity-metadata.js — how `Session.frameIdentityMap`
// is stored in a `.slp`'s `metadata.lucid`, and how it is rebuilt on load.
//
// `frameIdentityMap` maps (frame, camera, track) -> identity: "which animal is
// this 2D detection". After Track All it holds one entry per grouped detection,
// and every one of them equals the identity of the instance group that
// detection is in — which the file already stores, per group. Writing the map
// out in full was the largest piece of `sessions_json`: 3,458,373 entries,
// 101 MB of JSON, on an 8-camera, 176,406-frame project. That string is built
// and parsed in the renderer, and as one HDF5 string it grows with the
// recording toward h5wasm's ~0.45 GB string-read ceiling (luc3d #161), past
// which the project would not open at all.
//
// So the writers store only what the groups do NOT already say:
//
//   frameIdentityMap           entries the groups do not reproduce (same
//                              `[["frameIdx:camName:trackIdx", id], ...]`
//                              shape as before)
//   frameIdentityMapFromGroups true: rebuild the rest from the instance groups
//   frameIdentityMapDropped    keys the groups imply that the map did not hold;
//                              omitted when empty
//
// and the readers rebuild the map from the groups, delete the dropped keys and
// set the listed entries — giving back exactly the map that was saved (see
// `Session.frameIdentityExceptions` in pose/pose-data.js for why the result
// does not depend on the order the groups are walked in).
//
// Three rules:
//   1. **Never larger than the full map.** When the exceptions are not smaller
//      than the map itself (no groups, or a map that disagrees with them), the
//      full list is written, without the marker — the old form, which every
//      reader, old or new, understands.
//   2. **A reader must run AFTER the instance groups are rebuilt**, since it
//      derives from them. Both `.slp` readers that restore groups call
//      `readFrameIdentityMetadata` right after doing so: `restoreGroupingAndUnlink`
//      (import-export/slp-import.js — File ▸ Load SLP and the single-SLP folder
//      loader) and `handleLoadProjectSlpLazy` (loading/session-loader.js).
//   3. **The project JSON (save-load.js) keeps the full map.** It carries no
//      instance groups of the kind this rebuild reads, and is not where size
//      hurts.
//
// The cost: a LUC3D build from before this change opens such a file with only
// the listed entries, so its Identity timeline and colour-by-identity show no
// identity on the grouped detections (each group still knows its animal).
//
// No imports: the Session methods it needs are reached through the instance,
// which keeps this module out of the slp-import / session-loader import graph.

/** Every `metadata.lucid` key this module may write. */
export const FRAME_IDENTITY_METADATA_KEYS = Object.freeze([
    'frameIdentityMap', 'frameIdentityMapFromGroups', 'frameIdentityMapDropped',
]);

/**
 * Write `session.frameIdentityMap` into a `.slp` writer's `metadata.lucid`
 * dict: only the entries the instance groups do not reproduce, when that is
 * smaller than the full map; else the full map in its original form.
 * Assigns `lucid.frameIdentityMap` (keeping its place if the caller's literal
 * already has the key) and the two companion keys when they apply.
 * @param {Object} lucid - the session's `metadata.lucid` dict, mutated
 * @param {Session} session
 * @returns {Object} lucid
 */
export function writeFrameIdentityMetadata(lucid, session) {
    var map = session.frameIdentityMap;
    if (!map || map.size === 0) {
        lucid.frameIdentityMap = [];
        return lucid;
    }
    var ex = session.frameIdentityExceptions();
    if (ex.entries.length + ex.dropped.length < map.size) {
        lucid.frameIdentityMap = ex.entries;
        lucid.frameIdentityMapFromGroups = true;
        if (ex.dropped.length) lucid.frameIdentityMapDropped = ex.dropped;
    } else {
        lucid.frameIdentityMap = session.exportFrameIdentityEntries();
    }
    return lucid;
}

/**
 * Rebuild `session.frameIdentityMap` from a file written in the compact form:
 * derive from the instance groups, delete `frameIdentityMapDropped`, then set
 * the listed `frameIdentityMap` entries. Call AFTER the groups are rebuilt.
 * A file in the full form (no `frameIdentityMapFromGroups`) is left alone —
 * its map was already ingested as it was written.
 * @param {Session} session
 * @param {Object} lucid - the session's `metadata.lucid` dict as read
 * @param {{onProgress?:(msg:string)=>void, onCount?:(done:number, total:number)=>(void|Promise), yieldMs?:number}} [opts]
 *   passed on to `stampFrameIdentitiesFromGroups`
 * @returns {Promise<boolean>} true when the map was rebuilt
 */
export async function readFrameIdentityMetadata(session, lucid, opts) {
    if (!lucid || lucid.frameIdentityMapFromGroups !== true) return false;
    session.ingestFrameIdentityEntries([]);
    await stampFrameIdentitiesFromGroups(session, opts);
    session.deleteFrameIdentityKeys(lucid.frameIdentityMapDropped);
    session.applyFrameIdentityEntries(lucid.frameIdentityMap);
    return true;
}

/**
 * Fill `session.frameIdentityMap` from the instance groups' identities.
 * Two callers: `readFrameIdentityMetadata` above (a LUC3D file in the compact
 * form), and the loaders for a file that stores identities ONLY per group
 * (campy-live-export writes `identity_idx` + `metadata.lucid.identityId` on
 * each group, and no LUC3D session-level `frameIdentityMap`). Everything that
 * asks "which animal is this detection" — the Identity timeline, colour by
 * identity, Propagate — reads that map, so without it the reopened groups know
 * their animal but the timeline shows none.
 *
 * Writes one entry per tracked group member: (frame, camera, member's track)
 * → the group's identity — the same entries Track All writes, and the rule
 * `Session._derivedFrameIdentity` mirrors on the save side (keep the two in
 * step). Never overwrites an entry already there, and skips trackless members
 * (the map cannot key a null track; the group keeps the identity). Reads only
 * `group.identityId` and each member's `trackIdx`, so lazy placeholder members
 * work unchanged and no 2D is hydrated. Yields every `opts.yieldMs` (40 ms),
 * reporting `opts.onProgress(message)` and, awaited, `opts.onCount(done, total)`
 * in frames (the Open project card's counted hook; also called at the end).
 *
 * @param {Session} session
 * @param {{onProgress?:(msg:string)=>void, onCount?:(done:number, total:number)=>(void|Promise), yieldMs?:number}} [opts]
 * @returns {Promise<number>} entries written
 */
export async function stampFrameIdentitiesFromGroups(session, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var _now = function () { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); };
    var yieldMs = opts.yieldMs != null ? opts.yieldMs : 40;
    var ty = _now();
    var written = 0, done = 0, total = session.instanceGroups.size;
    for (var [frameIdx, groups] of session.instanceGroups) {
        done++;
        for (var gi = 0; gi < groups.length; gi++) {
            var g = groups[gi];
            if (g.identityId == null || g.identityId < 0) continue;
            for (var [camName, inst] of g.instances) {
                if (!inst || inst.trackIdx == null || inst.trackIdx < 0) continue;
                if (session.hasFrameIdentity(frameIdx, camName, inst.trackIdx)) continue;
                session.setFrameIdentity(frameIdx, camName, inst.trackIdx, g.identityId);
                written++;
            }
        }
        if (_now() - ty > yieldMs) {
            onProgress('Restoring identities (' + done.toLocaleString('en-US') + '/' + total.toLocaleString('en-US') + ')...');
            if (opts.onCount) await opts.onCount(done, total);   // the Open project card's counted hook
            await new Promise(function (r) { setTimeout(r, 0); });
            ty = _now();
        }
    }
    if (opts.onCount) await opts.onCount(total, total);
    return written;
}
