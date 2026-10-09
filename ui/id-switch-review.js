/**
 * ui/id-switch-review.js — the ID-switch review checklist's data: the results a
 * session's Tracks ▸ Check ID Switches run left (`session._idSwitch`), the
 * helpers that read them, and their `.slp` serialization.
 *
 * The ID Switches tab (ui/id-switch-modal.js) renders `session._idSwitch`:
 *   { results: { size?, image? },   // checkSizeSwitches / checkImageSwitches results (ok ones)
 *     reviewed: Set<rowKey>,        // rows ticked "reviewed"
 *     fixes: [fix, …],              // switches the user fixed, oldest first (see idSwitchFixPlan)
 *     showRepeats, current, navigate }
 *
 * It is saved per session as `metadata.lucid.idSwitchReview` (through
 * import-export/visibility-metadata.js, the one `metadata.lucid` seam), so the
 * checklist — what was flagged and what was ticked — survives a save and reopen.
 * Only what the tab and the timeline draw is kept, not the encounters or the
 * fitted models:
 *
 *   { v: 1,
 *     checks: { size?|image?|brightness?: { encounters, sampleHz, step, fps, fpsFromVideo,
 *                                [imageHz, crops, cameras, model: {name, note}],
 *                                points: [[frame, nameA, nameB, score, kind, followOf, continues, startFrame, link,
 *                                          look?], …] } },
 *     reviewed: [rowKey, …],
 *     fixes: [[key, partnerKey, nameA, nameB, from, to], …] }      // only when something was fixed
 *
 * `points` are every change point and repeat (`flags` + `changes`); `kind` is ''
 * or 'end', `followOf` a frame or -1, `continues` 0/1, `startFrame` the first close
 * frame of the encounter (`frame` is its last) or -1 — absent in files saved before
 * it was added, which then land on `frame`. `link` is the other edge of a change
 * point's swapped stretch — an onset's `switchBackAt`, an 'end''s `switchedAt` —
 * or -1 for none (the session's end / start); files saved before it was added
 * have no `link`, and a fix then pairs rows by what the list shows. `look`,
 * written only for a point scored at a candidate moment rather than an encounter
 * (single camera, see pose/single-camera-tracking.js), lists its cues. Rows are keyed by check,
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

/**
 * The checks, in order of precedence: when two find the same change point, the
 * row is shown once, on the earlier check's result ("Both").
 */
export const ID_SWITCH_CUES = ['size', 'image', 'brightness'];

/** True for the later half of a "Both" pair — drawn and listed through its partner. */
export function idSwitchIsSecondary(m) {
    return !!(m && m.agree && ID_SWITCH_CUES.indexOf(m.cue) > ID_SWITCH_CUES.indexOf(m.agree.cue));
}

/**
 * Tag every marker with its check, and link change points two checks found (same
 * pair, within 1 s) as `agree`: each change point of a later check to the first
 * unlinked one of an earlier check (size before images before brightness).
 */
export function linkIdSwitchResults(results) {
    var ran = ID_SWITCH_CUES.filter(function (cue) { return results[cue] && results[cue].ok; });
    ran.forEach(function (cue) { idSwitchMarkers(results[cue]).forEach(function (m) { m.cue = cue; delete m.agree; }); });
    if (ran.length < 2) return;
    var tol = Math.max(1, Math.round(results[ran[0]].fps || 30));
    ran.forEach(function (cue, i) {
        idSwitchPrimary(results[cue]).forEach(function (m) {
            for (var j = 0; j < i && !m.agree; j++) {
                var hit = idSwitchPrimary(results[ran[j]]).find(function (x) { return !x.agree && samePair(x, m) && Math.abs(x.frame - m.frame) <= tol; });
                if (hit) { m.agree = hit; hit.agree = m; }
            }
        });
    });
}

function samePair(a, b) {
    return (a.nameA === b.nameA && a.nameB === b.nameB) || (a.nameA === b.nameB && a.nameB === b.nameA);
}

/**
 * The other edge of a change point's swapped stretch, as a frame (the last close
 * frame of that encounter) or null for the session's end (onset) / start ('end').
 * Read from the check (`switchBackAt` / `switchedAt`); for results restored from
 * a file saved before those were kept, the nearest change point of the same pair
 * on the right side stands in.
 */
function linkedFrame(m, res) {
    var isEnd = m.kind === 'end', own = isEnd ? m.switchedAt : m.switchBackAt;
    if (own !== undefined) return own;
    var best = null;
    idSwitchMarkers(res).forEach(function (x) {
        if (x === m || x.continues || !samePair(x, m) || (x.kind === 'end') === isEnd) return;
        if (isEnd ? (x.frame < m.frame && (best == null || x.frame > best)) : (x.frame > m.frame && (best == null || x.frame < best))) best = x.frame;
    });
    return best;
}

/**
 * What fixing change point `m` swaps: identities `nameA` ↔ `nameB` on frames
 * `from..to` (inclusive), in every view.
 *
 * The boundary is the CURRENT frame whenever it is inside the row's window
 * `o.window` — in the app the whole span of the row's progress bar, 1 s before
 * the animals come close to 1 s after they separate — so the user puts it where
 * they saw the labels flip, by playing, stepping or clicking the bar. Outside the
 * window it falls back to e + 1, where they separate. Without `o.window` the
 * window is the close spell [s, e + 1]. How far it reaches is the detector's: an onset swaps from there to
 * the pair's next encounter that reads right again (`switchBackAt`, its last
 * close frame) or the end of the video; an 'end' swaps the stretch BEFORE it —
 * from just after the encounter where it began (`switchedAt`), or frame 0 — up
 * to the frame before its boundary. The change point at the other edge, when the
 * list shows one, is the fix's `partnerKey`: the same stretch, fixed by the same swap.
 *
 * @param {object} m          a change point (a row of the ID Switches tab)
 * @param {object} res        the check result it came from
 * @param {{currentFrame:number, totalFrames:number, window?:number[]}} o  `window`: [first, last] frame
 * @returns {?{key, partnerKey, nameA, nameB, from, to, start:'current'|'separate', edge:?number}}
 *   null when the stretch is empty. `edge` is the linked frame (null = session end / start).
 */
export function idSwitchFixPlan(m, res, o) {
    var s = m.startFrame != null && m.startFrame <= m.frame ? m.startFrame : m.frame, e = m.frame;
    var w = o.window || [s, e + 1], cur = o.currentFrame, here = cur != null && cur >= w[0] && cur <= w[1];
    var split = here ? cur : e + 1, edge = linkedFrame(m, res), from, to;
    if (m.kind === 'end') { from = edge == null ? 0 : edge + 1; to = split - 1; }
    else { from = split; to = edge == null ? Math.max(0, (o.totalFrames || 0) - 1) : edge; }
    if (!(to >= from)) return null;
    var partner = edge == null ? null : idSwitchMarkers(res).find(function (x) {
        return x !== m && !x.continues && x.frame === edge && samePair(x, m) && (x.kind === 'end') !== (m.kind === 'end');
    });
    return { key: idSwitchRowKey(m), partnerKey: partner ? idSwitchRowKey(partner) : '', nameA: m.nameA, nameB: m.nameB,
             from: from, to: to, start: here ? 'current' : 'separate', edge: edge };
}

/** The fix that covers row `m` (its own, or its partner's), or null. */
export function idSwitchFixFor(st, m) {
    var keys = [idSwitchRowKey(m)].concat(m.agree ? [idSwitchRowKey(m.agree)] : []);
    var fx = (st && st.fixes) || [];
    for (var i = fx.length - 1; i >= 0; i--) if (keys.indexOf(fx[i].key) >= 0 || keys.indexOf(fx[i].partnerKey) >= 0) return fx[i];
    return null;
}

/**
 * After `fix` swapped two identities on its frames, every OTHER row in that
 * stretch that names exactly one of them is about the animal that now carries
 * the other name — rename it, so selecting the row still boxes the same animals.
 * Rows of the fixed pair itself are left alone (the pair is the same either way
 * round). An involution, like the swap: applying it again (on undo) restores the
 * names. Keys follow (reviewed ticks, the selection, other fixes) and "Both" is
 * re-linked.
 */
export function idSwitchRenameForFix(st, fix) {
    var remap = new Map();
    ID_SWITCH_CUES.forEach(function (cue) {
        var r = st.results[cue];
        if (!(r && r.ok)) return;
        idSwitchMarkers(r).forEach(function (m) {
            if (m.frame < fix.from || m.frame > fix.to) return;
            var a = m.nameA === fix.nameA || m.nameA === fix.nameB, b = m.nameB === fix.nameA || m.nameB === fix.nameB;
            if (a === b) return;                                   // the fixed pair itself, or neither
            var swapName = function (n) { return n === fix.nameA ? fix.nameB : fix.nameA; };
            var before = idSwitchRowKey(m);
            if (a) { m.nameA = swapName(m.nameA); if (m.identityA != null && fix.idA != null) m.identityA = m.identityA === fix.idA ? fix.idB : fix.idA; }
            else { m.nameB = swapName(m.nameB); if (m.identityB != null && fix.idA != null) m.identityB = m.identityB === fix.idA ? fix.idB : fix.idA; }
            remap.set(before, idSwitchRowKey(m));
        });
    });
    if (!remap.size) return;
    var mapKey = function (k) { return remap.has(k) ? remap.get(k) : k; };
    st.reviewed = new Set(Array.from(st.reviewed || []).map(mapKey));
    if (st.current) st.current = mapKey(st.current);
    (st.fixes || []).forEach(function (f) { if (f !== fix) { f.key = mapKey(f.key); if (f.partnerKey) f.partnerKey = mapKey(f.partnerKey); } });
    linkIdSwitchResults(st.results);
}

/**
 * The `metadata.lucid.idSwitchReview` payload for a session, or null when no
 * check has results there (so nothing is written).
 */
export function serializeIdSwitchReview(session) {
    var st = session && session._idSwitch;
    if (!st || !st.results) return null;
    var checks = {};
    ID_SWITCH_CUES.forEach(function (cue) {
        var r = st.results[cue];
        if (!(r && r.ok)) return;
        var c = {
            encounters: idSwitchEncounterCount(r), sampleHz: r.sampleHz, step: r.step, fps: r.fps, fpsFromVideo: !!r.fpsFromVideo,
            points: idSwitchMarkers(r).map(function (m) {
                var p = [m.frame, String(m.nameA), String(m.nameB), Math.round(m.score * 10) / 10, m.kind === 'end' ? 'end' : '',
                         m.followOf == null ? -1 : m.followOf, m.continues ? 1 : 0, m.startFrame == null ? -1 : m.startFrame,
                         linkOf(m)];
                if (m.look && m.look.length) p.push(m.look.map(String));   // a candidate moment's cues; absent otherwise
                return p;
            }),
        };
        if (cue !== 'size') {                                   // image / brightness: samples per second, samples, views
            c.imageHz = r.imageHz; c.crops = r.crops; c.cameras = (r.cameras || []).slice();
            if (r.model && r.model.note) c.model = { name: r.model.name, note: r.model.note };
        }
        checks[cue] = c;
    });
    if (!Object.keys(checks).length) return null;
    var out = { v: 1, checks: checks, reviewed: Array.from(st.reviewed || []).sort() };
    if (st.fixes && st.fixes.length) {
        out.fixes = st.fixes.map(function (f) { return [f.key, f.partnerKey || '', String(f.nameA), String(f.nameB), f.from, f.to]; });
    }
    return out;
}

/** A point's `link` column: its stretch's other edge, -1 for none or not known. */
function linkOf(m) {
    var v = m.kind === 'end' ? m.switchedAt : m.switchBackAt;
    return typeof v === 'number' && isFinite(v) ? v : -1;
}

var isNum = function (x) { return typeof x === 'number' && isFinite(x); };

/** Put a saved `idSwitchReview` payload back on a session as `session._idSwitch`. Ignores anything malformed. */
export function ingestIdSwitchReview(session, payload) {
    if (!session) return session;
    try {
        if (!payload || typeof payload !== 'object' || payload.v !== 1 || !payload.checks || typeof payload.checks !== 'object') return session;
        var results = {};
        ID_SWITCH_CUES.forEach(function (cue) {
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
                if (isNum(p[8]) && !m.continues) {                // absent in older files: pairing falls back (linkedFrame)
                    var link = p[8] >= 0 ? p[8] : null;
                    if (m.kind === 'end') m.switchedAt = link; else m.switchBackAt = link;
                }
                if (Array.isArray(p[9])) {                        // written only for a candidate moment (its cues)
                    var look = p[9].filter(function (x) { return typeof x === 'string'; });
                    if (look.length) m.look = look;
                }
                flags.push(m);
            });
            var r = { ok: true, restored: true, flags: flags, changes: [], encounterCount: isNum(c.encounters) ? c.encounters : 0,
                      sampleHz: isNum(c.sampleHz) ? c.sampleHz : 0, step: isNum(c.step) ? c.step : 1, fps: isNum(c.fps) ? c.fps : 0,
                      fpsFromVideo: !!c.fpsFromVideo };
            if (cue !== 'size') {
                r.imageHz = isNum(c.imageHz) ? c.imageHz : 0; r.crops = isNum(c.crops) ? c.crops : 0;
                r.cameras = Array.isArray(c.cameras) ? c.cameras.filter(function (x) { return typeof x === 'string'; }) : [];
                if (c.model && typeof c.model.note === 'string') r.model = { name: String(c.model.name || ''), note: c.model.note };
            }
            results[cue] = r;
        });
        if (!Object.keys(results).length) return session;
        linkIdSwitchResults(results);
        var fixes = [];
        (Array.isArray(payload.fixes) ? payload.fixes : []).forEach(function (f) {
            if (!Array.isArray(f) || typeof f[0] !== 'string' || typeof f[2] !== 'string' || typeof f[3] !== 'string' ||
                !isNum(f[4]) || !isNum(f[5]) || f[5] < f[4]) return;
            fixes.push({ key: f[0], partnerKey: typeof f[1] === 'string' ? f[1] : '', nameA: f[2], nameB: f[3], from: f[4], to: f[5] });
        });
        session._idSwitch = {
            results: results,
            reviewed: new Set(Array.isArray(payload.reviewed) ? payload.reviewed.filter(function (k) { return typeof k === 'string'; }) : []),
            fixes: fixes, showRepeats: false, current: null,
        };
    } catch (e) { /* a malformed payload is ignored, like every other optional metadata.lucid key */ }
    return session;
}
