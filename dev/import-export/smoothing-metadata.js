// import-export/smoothing-metadata.js — Temporal Smoothing's state in the
// project file, so a reopened project is exactly as smoothed as the one saved:
// the toolbar button and the last run's menu scope are lit, a re-run replaces
// the last run instead of smoothing its output again, and Gaussian/median
// windows 0 restores the 3D from before smoothing.
//
// ## What is stored
//
// Two pieces, both written ONLY while something is smoothed, so a project that
// never was saves byte-identically (tests/e2e/save-golden-digest.mjs):
//
//   * Per group, the 3D it held before smoothing (`unsmoothedPoints3d`, the
//     source every pass filters). The writers hand it to sleap-io.js as
//     `Instance3D.lucidUnsmoothed`, and the vendored writer appends it to
//     `/session_data/unsmoothed_points_3d`, row-parallel to `points_3d` with NaN
//     rows for groups that have none (LUCID local patch (smoothing source)). The
//     reader hands it back the same way; `adoptSmoothingSource` re-marks the
//     group. A full copy rather than "re-triangulate on demand": the source is
//     not always reproducible (imported or campy-live 3D, changed thresholds or
//     calibration), and a re-solve would cost a Triangulate All on reopen.
//   * Per session, `metadata.lucid.temporalSmoothing`: the scope of the last run
//     ('all' | 'frame', which menu item `ui/smoothing-button.js` lights) and its
//     resolved windows. Informational apart from the scope: a re-run always uses
//     the current Settings.
//
// The smoothed state lapses per group exactly as before reopening: the mark is
// keyed by the `points3d` array (`markPoints3dSmoothed`), and every re-solve or
// edit assigns a new one.
//
// DOM-free: Node tests import it directly.
//
// Depends on: pose/pose-data.js, pose/temporal-smoothing.js

import { unsmoothedPoints3d, markPoints3dSmoothed, pooledPoints3d } from '../pose/pose-data.js?v=4d1ba74d1e09';
import { hasSmoothed3d, noteSmoothedFrames } from '../pose/temporal-smoothing.js?v=4d1ba74d1e09';

/** Every `metadata.lucid` key this module may write. */
export const SMOOTHING_METADATA_KEYS = ['temporalSmoothing'];

/** Session -> its last smoothing run, `{scope, config}`. */
var _lastRun = new WeakMap();

/**
 * Record a smoothing run (`runTemporalSmoothing`), or one read from a file.
 * @param {Session} session
 * @param {'all'|'frame'} scope
 * @param {Object} [config] `resolveSmoothingParams`' result
 */
export function noteSmoothingRun(session, scope, config) {
    if (session) _lastRun.set(session, { scope: scope === 'frame' ? 'frame' : 'all', config: config || null });
}

/** The session's last smoothing run, or null. */
export function smoothingRunOf(session) {
    return (session && _lastRun.get(session)) || null;
}

/**
 * The source to save with a group: its 3D from before smoothing, or undefined.
 * @param {InstanceGroup} group
 * @returns {Float64Array|undefined}
 */
export function smoothingSourceFor(group) {
    return (group && unsmoothedPoints3d(group.points3d)) || undefined;
}

/**
 * Re-mark a group read from a file as smoothed when the reader returned its
 * source (`instance3d.lucidUnsmoothed`), and register its frame so the button
 * finds it (`hasSmoothed3d` walks only frames known to be smoothed). Call
 * after `group.points3d` is final.
 * @param {Session} session
 * @param {number} frameIdx
 * @param {InstanceGroup} group
 * @param {Object} instance3d the typed sleap-io.js Instance3D
 * @returns {boolean} whether the group is smoothed
 */
export function adoptSmoothingSource(session, frameIdx, group, instance3d) {
    var src = instance3d && instance3d.lucidUnsmoothed;
    if (!src || !group || !group.points3d || src.length !== group.points3d.length) return false;
    markPoints3dSmoothed(group.points3d, pooledPoints3d(src));
    group.smoothed = true;
    noteSmoothedFrames(session, [frameIdx]);
    return true;
}

/**
 * Write the session's last run into `lucid`, only while any of its 3D is
 * smoothed.
 * @param {Object} lucid the session's `metadata.lucid` dict (mutated)
 * @param {Session} session
 */
export function writeSmoothingMetadata(lucid, session) {
    if (!lucid || !hasSmoothed3d(session)) return;
    var run = smoothingRunOf(session);
    var out = { scope: run ? run.scope : 'all' };
    var cfg = run && run.config;
    if (cfg) {
        out.medianWindow = cfg.medianWindow;
        out.gaussianWindow = cfg.gaussianWindow;
        out.maxGap = cfg.maxGap;
        out.minSegment = cfg.minSegment;
    }
    lucid.temporalSmoothing = out;
}

/**
 * Read the last run back. Tolerates absence and garbage.
 * @param {Session} session
 * @param {Object} lucid
 */
export function readSmoothingMetadata(session, lucid) {
    var ts = lucid && lucid.temporalSmoothing;
    if (!session || !ts || typeof ts !== 'object') return;
    var cfg = null;
    if (['medianWindow', 'gaussianWindow', 'maxGap', 'minSegment'].every(function (k) {
        return Number.isFinite(ts[k]);
    })) {
        cfg = {
            medianWindow: ts.medianWindow, gaussianWindow: ts.gaussianWindow,
            maxGap: ts.maxGap, minSegment: ts.minSegment,
            enabled: ts.medianWindow > 0 || ts.gaussianWindow > 0,
        };
    }
    noteSmoothingRun(session, ts.scope, cfg);
}
