/**
 * import-track-resolve.js — pure (dependency-free) helper for resolving an
 * imported instance's track index. Lives in its own module so it can be unit
 * tested headlessly (its former home, `loading/session-loader.js`, transitively
 * imports `app.js` and cannot be bridged into the test runner).
 */

/**
 * Resolve an imported instance's trackIdx to LUCID's internal representation.
 *
 * A trackless instance — `track = -1` (SLEAP's "no track") or `null` — stays
 * trackless (`trackIdx = null`, the app-wide trackless sentinel) regardless of
 * whether it is a user OR predicted instance. Downstream code uses `trackIdx !=
 * null` as the untracked test (timeline.js, overlays.js, etc.); trackless
 * instances render with fallback coloring and can be grouped via the Assign
 * menu.
 *
 * History: predicted instances used to coerce a trackless `-1` to track `0`.
 * That made a deleted-track instance reappear on the FIRST track (e.g.
 * `global_0`) after an export → reimport round trip: deleting a track nulls its
 * instances, export writes them as `track=-1`, and the old coercion snapped
 * every untracked prediction onto track 0. Keeping them trackless is correct —
 * an untracked prediction has no track, and the user assigns one via Track All.
 *
 * `session` is unused but kept in the signature for call-site stability / future
 * context needs. `instType` is likewise no longer consulted.
 *
 * @param {object} session - unused (kept for signature stability)
 * @param {number|null} rawTrackIdx - raw track index from the SLP (-1/null = none)
 * @param {string} [instType] - 'user' | 'predicted' (no longer consulted)
 * @returns {number|null} the resolved trackIdx, or null when trackless
 */
export function resolveImportTrackIdx(session, rawTrackIdx, instType) {
    // Defensively normalize an unsigned-int32 readback of a signed -1
    // (0xFFFFFFFF = 4294967295) back to -1. The post-pass writes the track
    // column as signed i4, but if h5wasm's compound reader introspects the
    // field as unsigned, -1 comes through as a large positive number and would
    // slip past the `>= 0` check as a "real" track.
    if (typeof rawTrackIdx === 'number' && rawTrackIdx > 0x7FFFFFFF) {
        rawTrackIdx = rawTrackIdx - 0x100000000;
    }
    if (rawTrackIdx != null && rawTrackIdx >= 0) return rawTrackIdx;
    // Trackless (track = -1 / null) — user OR predicted — stays trackless.
    return null;
}

/**
 * Map a per-instance track index from the file-level (GLOBAL) track list to the
 * index in a SPECIFIC session's track list, matched by NAME.
 *
 * A multi-session SLP stores ONE global track list (`tracks_json`) and writes
 * each instance's track column as an index into THAT global list — but tracks
 * are per-session. So an instance's global index must be translated to this
 * session's own track index before use, or sessions cross-couple: deleting a
 * track in one session reorders the global union and silently remaps another
 * session's instances (e.g. `global_0` → `track_3`).
 *
 * Trackless (`-1`/`null`) stays trackless. A global track whose name is NOT in
 * this session's list returns `-1` (the instance is trackless in this session —
 * it belongs to a track this session does not have).
 *
 * @param {number|null} rawTrackIdx - index into `globalTrackNames`
 * @param {string[]} globalTrackNames - the file-level union (`slpData.tracks`)
 * @param {string[]} sessionTrackNames - this session's per-session track list
 * @returns {number|null} index into `sessionTrackNames`, or trackless sentinel
 */
export function remapGlobalTrackToSession(rawTrackIdx, globalTrackNames, sessionTrackNames) {
    if (typeof rawTrackIdx === 'number' && rawTrackIdx > 0x7FFFFFFF) {
        rawTrackIdx = rawTrackIdx - 0x100000000;
    }
    if (rawTrackIdx == null || rawTrackIdx < 0) return rawTrackIdx;
    if (!Array.isArray(globalTrackNames) || !Array.isArray(sessionTrackNames)) return rawTrackIdx;
    var name = rawTrackIdx < globalTrackNames.length ? globalTrackNames[rawTrackIdx] : null;
    if (name == null) return -1;
    return sessionTrackNames.indexOf(name); // -1 if this session lacks the track
}

/**
 * Reconstruct a user instance's occlusion set (`nulledNodes`) from its saved
 * per-point occlusion (a point present in the file but flagged not-visible).
 *
 * `_buildSioPoints` writes an occluded (nulled) node as its real xy with
 * `visible:false`, so the occlusion IS in the SLP — as invisibility — for BOTH
 * grouped and UNGROUPED (unlinked) instances. But the explicit `nulledNodes`
 * FLAG is only persisted in per-group `metadata.lucid.instanceMeta` (grouped
 * instances only). An unlinked user label — e.g. a prediction converted to a
 * user label that was never grouped — therefore lost its occlusion on reload:
 * the point came back positioned but no longer flagged occluded. Deriving the
 * flag back from the finite-but-invisible signal restores it on every load
 * path. Lives here (dependency-free) so it can be unit-tested headlessly — its
 * callers (`slp-import.js` / `session-loader.js`) both transitively import
 * `app.js` and cannot be bridged into the test runner.
 *
 * Only USER instances carry occlusion — a predicted instance's invisible point
 * is a low-confidence/absent prediction, not a user occlusion (and the occlude
 * UI blocks predicted instances). Returns a Set, or null when none apply.
 *
 * @param {Array} points - instance points ([x,y] or null per node)
 * @param {boolean[]} occluded - per-node "present but not visible" flags
 * @param {string} type - instance type ('user' | 'predicted')
 * @returns {Set<number>|null}
 */
export function nulledNodesFromOcclusion(points, occluded, type) {
    if (type !== 'user' || !occluded) return null;
    var s = new Set();
    for (var i = 0; i < occluded.length; i++) {
        if (occluded[i] && points && points[i] != null) s.add(i);
    }
    return s.size > 0 ? s : null;
}
