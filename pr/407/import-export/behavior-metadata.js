// import-export/behavior-metadata.js — behavior labels in the project file:
// the ethogram and each session's labelled bouts, so a reopened project shows
// exactly what was coded.
//
// ## What is stored (all under `metadata.lucid`, only when non-empty)
//
//   ethogram        project-scoped: the same payload in EVERY session's dict
//                   (as `planeNodes` is), read from the first session ingested
//                   (`ingestEthogram`; later sessions of the same project map
//                   onto it by name, a no-op). See pose/behavior-ethogram.js.
//     { v: 1, behaviors: [{ id, name, color, kind, key?, social?, group?, description? }] }
//
//   behaviorLabels  per session: every bout, plus the frame rate they were coded
//                   at when known (frames are the truth; fps is not saved in
//                   the `.slp`, so exports need to know what seconds meant).
//     { v: 1, fps?, bouts: [[behaviorId, animal, target, start, end, present, source, note], …] }
//
// A project nobody labelled behaviors in writes neither key, so its bytes are
// unchanged (tests/e2e/save-golden-digest.mjs). A running state (Label
// Behaviors mode) is saved as ending at the playhead without being stopped.
//
// Reading REPLACES the session's bouts (`importBoutRows`) and never merges:
// every reader builds a fresh Session. A session file added to an open
// project (the single-SLP folder loader) brings its ethogram in by name, and
// its bouts are remapped onto the project's behavior ids.
//
// DOM-free: Node tests import it directly.
//
// Depends on: pose/behavior-ethogram.js, pose/behavior-labels.js

import { serializeEthogram, ingestEthogram, resetEthogram } from '../pose/behavior-ethogram.js?v=79abc800b879';
import { exportBoutRows, importBoutRows, behaviorFps, noteBehaviorFps } from '../pose/behavior-labels.js?v=79abc800b879';

/** Every `metadata.lucid` key this module may write. */
export var BEHAVIOR_METADATA_KEYS = ['ethogram', 'behaviorLabels'];

/**
 * Write the ethogram and the session's bouts into `lucid`, each only when it
 * has something in it.
 * @param {Object} lucid the session's `metadata.lucid` dict (mutated)
 * @param {Session} session
 */
export function writeBehaviorMetadata(lucid, session) {
    if (!lucid) return;
    var eth = serializeEthogram();
    if (eth) lucid.ethogram = eth;
    var rows = exportBoutRows(session);
    if (!rows.length) return;
    var out = { v: 1, bouts: rows };
    var fps = behaviorFps(session);
    if (fps > 0) out.fps = fps;
    lucid.behaviorLabels = out;
}

/**
 * Read the ethogram (into the project) and the session's bouts back.
 * Tolerates absence and garbage.
 * @param {Session} session
 * @param {Object} lucid
 * @returns {{kept:number, dropped:number}} bouts read and bouts skipped
 */
export function readBehaviorMetadata(session, lucid) {
    if (!session || !lucid || typeof lucid !== 'object') return { kept: 0, dropped: 0 };
    var idMap = lucid.ethogram ? ingestEthogram(lucid.ethogram) : new Map();
    var bl = lucid.behaviorLabels;
    if (!bl || typeof bl !== 'object' || bl.v !== 1 || !Array.isArray(bl.bouts)) return { kept: 0, dropped: 0 };
    var res = importBoutRows(session, bl.bouts, idMap);
    if (typeof bl.fps === 'number' && bl.fps > 0) noteBehaviorFps(session, bl.fps);
    if (res.dropped) {
        console.warn('[behavior] ' + res.dropped + ' saved bout' + (res.dropped === 1 ? '' : 's') +
            ' in session "' + (session.name || '') + '" named no known behavior or were malformed, and were skipped');
    }
    return res;
}

/**
 * Forget the project's ethogram. The ethogram is project-scoped and lives on a
 * module singleton, so it survives `state.sessions = []`: call this before
 * every load and on New Project, or the next project opens with this one's
 * behaviors. (Bouts live on their Session and go with it.)
 */
export function resetBehaviorState() {
    resetEthogram();
}
