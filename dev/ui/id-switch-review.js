/**
 * ui/id-switch-review.js — the ID-switch review checklist's data: the results a
 * session's Tracks ▸ Check ID Switches run left (`session._idSwitch`), the
 * helpers that read them, and their `.slp` serialization.
 *
 * The ID Switches tab (ui/id-switch-modal.js) renders `session._idSwitch`:
 *   { results: { size?, image? },   // checkSizeSwitches / checkImageSwitches results (ok ones)
 *     reviewed: Set<rowKey>,        // rows ticked "reviewed"
 *     showRepeats, current, navigate }
 *
 * It is saved per session as `metadata.lucid.idSwitchReview` (through
 * import-export/visibility-metadata.js, the one `metadata.lucid` seam), so the
 * checklist — what was flagged and what was ticked — survives a save and reopen.
 * Only what the tab and the timeline draw is kept, not the encounters or the
 * fitted models:
 *
 *   { v: 1,
 *     checks: { size?|image?: { encounters, sampleHz, step, fps, fpsFromVideo,
 *                                [imageHz, crops, cameras, model: {name, note}],
 *                                points: [[frame, nameA, nameB, score, kind, followOf, continues, startFrame], …] } },
 *     reviewed: [rowKey, …] }
 *
 * `points` are every change point and repeat (`flags` + `changes`); `kind` is ''
 * or 'end', `followOf` a frame or -1, `continues` 0/1, `startFrame` the first close
 * frame of the encounter (`frame` is its last) or -1 — absent in files saved before
 * it was added, which then land on `frame`. Rows are keyed by check,
 * frame and identity NAMES (`rowKey`) — names, not ids, are what a reopened
 * project still agrees on. Nothing is written for a session no check has run on,
 * so such a project's bytes are unchanged. Reads tolerate absence and garbage.
 *
 * Imports no project modules (loads in the node test sandbox, like
 * ui/timeline-visibility.js).
 */

/** A row's identity across re-runs and reopens: its check, frame and pair (by name). */
export function idSwitchRowKey(m) {
    return (m.cue || 'size') + ':' + m.frame + ':' + m.nameA + ':' + m.nameB;
}

/** Change points to review: switch onsets plus 'end' points (where an early swapped stretch stops). */
export function idSwitchPrimary(res) {
    return res.flags.filter(function (f) { return !f.continues; }).concat(res.changes || [])
        .sort(function (a, b) { return a.frame - b.frame; });
}

/** Everything drawn on the timeline: change points at full strength, repeats faint. */
export function idSwitchMarkers(res) {
    return res.flags.concat(res.changes || []);
}

/** Independent change points (not follow-ons) — the "possible switches" count. */
export function idSwitchOnsets(res) {
    return idSwitchPrimary(res).filter(function (f) { return f.followOf == null; }).length;
}

/** How many close encounters a check scored (a restored result keeps only the count). */
export function idSwitchEncounterCount(res) {
    return res.encounters ? res.encounters.length : (res.encounterCount || 0);
}

/** Tag every marker with its check, and link change points both checks found (same pair, within 1 s) as `agree`. */
export function linkIdSwitchResults(results) {
    ['size', 'image'].forEach(function (cue) {
        var r = results[cue];
        if (r && r.ok) idSwitchMarkers(r).forEach(function (m) { m.cue = cue; delete m.agree; });
    });
    var s = results.size, im = results.image;
    if (!(s && s.ok && im && im.ok)) return;
    var tol = Math.max(1, Math.round(s.fps || 30));
    var samePair = function (a, b) {
        return (a.nameA === b.nameA && a.nameB === b.nameB) || (a.nameA === b.nameB && a.nameB === b.nameA);
    };
    idSwitchPrimary(im).forEach(function (m) {
        var hit = idSwitchPrimary(s).find(function (x) { return samePair(x, m) && Math.abs(x.frame - m.frame) <= tol; });
        if (hit) { m.agree = hit; hit.agree = m; }
    });
}

/**
 * The `metadata.lucid.idSwitchReview` payload for a session, or null when no
 * check has results there (so nothing is written).
 */
export function serializeIdSwitchReview(session) {
    var st = session && session._idSwitch;
    if (!st || !st.results) return null;
    var checks = {};
    ['size', 'image'].forEach(function (cue) {
        var r = st.results[cue];
        if (!(r && r.ok)) return;
        var c = {
            encounters: idSwitchEncounterCount(r), sampleHz: r.sampleHz, step: r.step, fps: r.fps, fpsFromVideo: !!r.fpsFromVideo,
            points: idSwitchMarkers(r).map(function (m) {
                return [m.frame, String(m.nameA), String(m.nameB), Math.round(m.score * 10) / 10, m.kind === 'end' ? 'end' : '',
                        m.followOf == null ? -1 : m.followOf, m.continues ? 1 : 0, m.startFrame == null ? -1 : m.startFrame];
            }),
        };
        if (cue === 'image') {
            c.imageHz = r.imageHz; c.crops = r.crops; c.cameras = (r.cameras || []).slice();
            if (r.model && r.model.note) c.model = { name: r.model.name, note: r.model.note };
        }
        checks[cue] = c;
    });
    if (!Object.keys(checks).length) return null;
    return { v: 1, checks: checks, reviewed: Array.from(st.reviewed || []).sort() };
}

var isNum = function (x) { return typeof x === 'number' && isFinite(x); };

/** Put a saved `idSwitchReview` payload back on a session as `session._idSwitch`. Ignores anything malformed. */
export function ingestIdSwitchReview(session, payload) {
    if (!session) return session;
    try {
        if (!payload || typeof payload !== 'object' || payload.v !== 1 || !payload.checks || typeof payload.checks !== 'object') return session;
        var results = {};
        ['size', 'image'].forEach(function (cue) {
            var c = payload.checks[cue];
            if (!c || typeof c !== 'object' || !Array.isArray(c.points)) return;
            var flags = [];
            c.points.forEach(function (p) {
                if (!Array.isArray(p) || !isNum(p[0]) || typeof p[1] !== 'string' || typeof p[2] !== 'string' || !isNum(p[3])) return;
                var m = { frame: p[0], nameA: p[1], nameB: p[2], score: p[3], cue: cue };
                if (p[4] === 'end') m.kind = 'end';
                if (isNum(p[5]) && p[5] >= 0) m.followOf = p[5];
                if (p[6]) m.continues = true;
                if (isNum(p[7]) && p[7] >= 0 && p[7] <= p[0]) m.startFrame = p[7];
                flags.push(m);
            });
            var r = { ok: true, restored: true, flags: flags, changes: [], encounterCount: isNum(c.encounters) ? c.encounters : 0,
                      sampleHz: isNum(c.sampleHz) ? c.sampleHz : 0, step: isNum(c.step) ? c.step : 1, fps: isNum(c.fps) ? c.fps : 0,
                      fpsFromVideo: !!c.fpsFromVideo };
            if (cue === 'image') {
                r.imageHz = isNum(c.imageHz) ? c.imageHz : 0; r.crops = isNum(c.crops) ? c.crops : 0;
                r.cameras = Array.isArray(c.cameras) ? c.cameras.filter(function (x) { return typeof x === 'string'; }) : [];
                if (c.model && typeof c.model.note === 'string') r.model = { name: String(c.model.name || ''), note: c.model.note };
            }
            results[cue] = r;
        });
        if (!Object.keys(results).length) return session;
        linkIdSwitchResults(results);
        session._idSwitch = {
            results: results,
            reviewed: new Set(Array.isArray(payload.reviewed) ? payload.reviewed.filter(function (k) { return typeof k === 'string'; }) : []),
            showRepeats: false, current: null,
        };
    } catch (e) { /* a malformed payload is ignored, like every other optional metadata.lucid key */ }
    return session;
}
