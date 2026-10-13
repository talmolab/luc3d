/**
 * track-union.js — the ONE session track list a multi-camera load builds from
 * each camera's own track list, as a pure function.
 *
 * A per-camera session folder holds one `.slp`/`.h5` per camera, and each file
 * carries its OWN track list: on a real 8-camera folder they ran from 249 to
 * 863 tracks, all named `track_0..track_{n-1}`. A LUCID session has ONE
 * `session.tracks`, and every consumer of a trackIdx — the overlays' colours
 * and names, the info panel's Track select, the Tracks Timeline, the
 * export-modal track stats, Custom Delete's track filter, the streaming writer —
 * reads `session.tracks[trackIdx]`. So every camera's own track index has to be
 * re-expressed as an index into that one list.
 *
 * The rule is: **the union of the cameras' track NAMES, cameras taken in sorted
 * name order, each camera's names in its file order.** Two consequences:
 *
 *   - The answer depends only on WHICH (camera, track list) pairs were loaded,
 *     never on the order they were opened in. The lazy loaders used to take the
 *     list of whichever camera's file finished opening first, which on the real
 *     folder gave 262, 863, 863, 863 and 388 tracks across five loads of the
 *     same files, and left every other camera's indices pointing past the end
 *     of the list or at another camera's names.
 *   - A track name shared by two cameras is ONE session track (the same index,
 *     colour and Track-select entry). That is what the eager per-camera loader
 *     has always done, and what `metadata.lucid.hiddenTracks` (saved by NAME)
 *     assumes. It says nothing about the animal — a raw per-camera tracker's
 *     `track_0` is unrelated across cameras; the cross-view tracker keys its
 *     association by (camera, trackIdx), so it is unaffected either way.
 *
 * Names are matched as a MULTISET: a camera whose own list repeats a name keeps
 * its repeats as distinct tracks (the k-th `x` in a camera maps to the k-th `x`
 * slot of the union), so the per-camera map is always injective and no two of a
 * camera's tracks are ever merged.
 *
 * Camera names are compared by code unit (`<`), not `localeCompare`, so the
 * order is the same on every machine and locale.
 *
 * Imports NOTHING, so it loads in Node (`tests/test-track-union.mjs`) as well as
 * from both lazy loaders and `loading/session-loader.js`.
 */

/**
 * @param {Array<{camName: string, names: string[]}>} perCamera - each camera's
 *   own track names, in its file's order. Input order is irrelevant.
 * @returns {{names: string[], remapByCam: Map<string, Int32Array>}} `names` is
 *   the session track list; `remapByCam.get(cam)[i]` is the session index of
 *   that camera's own track `i`.
 */
export function unionTrackNames(perCamera) {
    var cams = (perCamera || []).slice().sort(function (a, b) {
        return a.camName < b.camName ? -1 : (a.camName > b.camName ? 1 : 0);
    });
    var names = [];
    var slotsByName = new Map();   // name -> session indices carrying it, in order
    var remapByCam = new Map();
    for (var c = 0; c < cams.length; c++) {
        var own = cams[c].names || [];
        var remap = new Int32Array(own.length);
        var seen = new Map();      // name -> occurrences so far in THIS camera
        for (var i = 0; i < own.length; i++) {
            var name = own[i] == null ? '' : String(own[i]);
            var k = seen.get(name) || 0;
            seen.set(name, k + 1);
            var slots = slotsByName.get(name);
            if (!slots) { slots = []; slotsByName.set(name, slots); }
            if (k >= slots.length) { slots.push(names.length); names.push(name); }
            remap[i] = slots[k];
        }
        remapByCam.set(cams[c].camName, remap);
    }
    return { names: names, remapByCam: remapByCam };
}

/**
 * Map one of a camera's own track indices through its `remap` (an `Int32Array`
 * from `unionTrackNames`, or any array/object indexable the same way).
 * Trackless stays trackless (-1), and so does an index OUTSIDE the camera's own
 * list — a value no track of that file names. That is what sleap-io's lazy
 * materializer always made of one (`tracks[id]` is undefined → no track); keeping
 * it as a raw number instead would make it name whatever session track happens
 * to sit at that index. An unsigned read-back of -1 (4294967295) is trackless
 * too, as in `resolveImportTrackIdx`.
 *
 * @param {ArrayLike<number>|Object} remap
 * @param {number|null|undefined} ownIdx
 * @returns {number} session track index, or -1
 */
export function remapTrackIdx(remap, ownIdx) {
    if (typeof ownIdx !== 'number' || !(ownIdx >= 0) || ownIdx > 0x7FFFFFFF) return -1;
    var v = remap ? remap[ownIdx] : undefined;
    return (typeof v === 'number' && v >= 0) ? v : -1;
}

/** True when `remap[i] === i` for every i — the camera's indices need no rewrite. */
export function isIdentityRemap(remap) {
    for (var i = 0; i < remap.length; i++) if (remap[i] !== i) return false;
    return true;
}
