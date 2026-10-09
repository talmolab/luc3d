// ui/track-summary.js — what the Track All summary box says, DOM-free.
//
// Track All used to end on a status-bar line and, when the automatic ID-switch
// check found something, the ID Switches tab. When it found NOTHING, the run
// ended with no visible next step: the tab stayed shut, the line scrolled away,
// and "no switches" read the same as "the check never ran". The summary box
// (ui/track-summary-modal.js) answers both questions — how did tracking go, and
// what now — and this module decides what it says, so the decision tree is
// unit-tested in Node (`tests/test-track-summary.mjs`) without a browser.
//
// Imports only `id-switch-review.js`, which is import-free.

import { idSwitchOnsets, idSwitchEncounterCount } from './id-switch-review.js?v=4c3f7d0398e7';

/** Thousands separators, as everywhere else frame counts are shown. */
function n(v) {
    return (v || 0).toLocaleString('en-US');
}

function plural(count, word, many) {
    return n(count) + ' ' + (count === 1 ? word : (many || word + 's'));
}

/**
 * A share as a percentage that never overstates: floored to one decimal, so
 * 99.97% reads "99.9%" and only a full count reads "100%"; a non-zero share too
 * small to show reads "<0.1%".
 */
export function formatShare(count, total) {
    if (!(total > 0)) return '—';
    if (count >= total) return '100%';
    var v = Math.floor(1000 * count / total) / 10;
    if (v === 0 && count > 0) return '<0.1%';
    return v.toFixed(1) + '%';
}

/**
 * A wall-clock duration as a person reads it: "0.4 s", "8.3 s", "42 s",
 * "3 min 5 s", "1 h 12 min". Empty for a missing or invalid value.
 */
export function formatDuration(ms) {
    if (!(typeof ms === 'number' && isFinite(ms) && ms >= 0)) return '';
    if (ms < 100) return '<0.1 s';
    if (ms < 9950) return (ms / 1000).toFixed(1) + ' s';
    var sec = Math.round(ms / 1000);
    if (sec < 60) return sec + ' s';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + ' min' + (sec % 60 ? ' ' + (sec % 60) + ' s' : '');
    var h = Math.floor(min / 60);
    return h + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '');
}

/**
 * How fast tracking ran: frames tracked per second of wall-clock time, and —
 * when the recording's frame rate is known — how many times faster than the
 * recording plays ("10×" for 30 minutes of video tracked in 3). The multiplier
 * is the throughput over the recording's fps, so the two always agree.
 *
 * @returns {{fps:string, realtime:string}}  empty strings when not measurable
 */
export function formatTrackingSpeed(frames, ms, recordingFps) {
    if (!(frames > 0 && ms > 0)) return { fps: '', realtime: '' };
    var num = function (v) {
        return v >= 10 ? Math.round(v).toLocaleString('en-US') : v >= 0.1 ? v.toFixed(1) : '<0.1';
    };
    var rate = frames / (ms / 1000);
    if (!(recordingFps > 0)) return { fps: num(rate) + ' fps', realtime: '' };
    return { fps: num(rate) + ' fps', realtime: num(rate / recordingFps) + '×' };
}

/**
 * Count, per identity, the frames it was tracked in — plus how many frames had
 * any identity, and how many had every animal.
 *
 * Reads `session.instanceGroups`, which a lazy project never evicts, so this is
 * the whole project and not the resident window.
 *
 * @param {Object} session
 * @param {{frames:number, animals:number, animalsAuto?:boolean, elapsedMs?:number, fps?:number}} opts
 *   `frames` — the frames the pass swept (the denominator); `animals` — the
 *   animal count it ran with; `animalsAuto` — whether that count was detected
 *   rather than entered; `elapsedMs` — how long tracking took; `fps` — the
 *   recording's frame rate, for the real-time multiplier (0/absent: none shown).
 */
export function summarizeTrackedIdentities(session, opts) {
    opts = opts || {};
    var ids = (session && session.identities) || [];
    var index = new Map();
    ids.forEach(function (id, i) { index.set(id.id, i); });
    var counts = new Array(ids.length).fill(0);
    var lastFrame = new Array(ids.length).fill(-1);
    var animals = opts.animals > 0 ? opts.animals : 0;
    var tracked = 0, complete = 0;
    var groupsByFrame = (session && session.instanceGroups) || new Map();
    groupsByFrame.forEach(function (groups, fi) {
        var distinct = 0;
        for (var g = 0; g < groups.length; g++) {
            var k = index.get(groups[g].identityId);
            if (k == null || lastFrame[k] === fi) continue;
            lastFrame[k] = fi;
            counts[k]++;
            distinct++;
        }
        if (distinct > 0) tracked++;
        if (animals > 0 && distinct >= animals) complete++;
    });
    return {
        frames: opts.frames || 0,
        trackedFrames: tracked,
        completeFrames: complete,
        animals: animals,
        animalsAuto: !!opts.animalsAuto,
        elapsedMs: opts.elapsedMs,
        fps: opts.fps > 0 ? opts.fps : 0,
        identities: ids.map(function (id, i) {
            return { id: id.id, name: id.name, color: id.color, frames: counts[i] };
        }),
    };
}

/**
 * One ID-switch check's outcome, in the summary's terms.
 *
 * @param {boolean} enabled  the Tracking Wizard runs this check after tracking
 * @param {Object|null} res  that check's result from `runIdSwitchChecks`
 * @param {number} identities  identities the pass assigned
 * @param {string} [whyNotRun]  reason when the checks never started (no 3D)
 * @returns {{state:string, switches?:number, encounters?:number, reason?:string, elapsedMs?:number}}
 *   state: 'found' | 'clear' | 'skipped' | 'failed' | 'cancelled' | 'off' | 'na';
 *   `elapsedMs` is the check's own wall-clock time (`runIdSwitchChecks` stamps it).
 */
export function describeSwitchCheck(enabled, res, identities, whyNotRun) {
    if (!(identities > 1)) return { state: 'na' };
    if (!enabled) return { state: 'off' };
    if (!res) return { state: 'skipped', reason: whyNotRun || 'did not run' };
    var out;
    if (res.ok) {
        var found = idSwitchOnsets(res);
        out = { state: found ? 'found' : 'clear', switches: found, encounters: idSwitchEncounterCount(res) };
    } else if (res.cancelled) {
        out = { state: 'cancelled' };
    } else {
        out = { state: res.failed ? 'failed' : 'skipped', reason: res.reason || '' };
    }
    if (typeof res.elapsedMs === 'number') out.elapsedMs = res.elapsedMs;
    return out;
}

// Check states that spent real time — a skip returns at its preflight, so a
// time beside it would only be noise.
var TIMED_STATES = { found: 1, clear: 1, failed: 1, cancelled: 1 };

// A check's reason can run to a paragraph (the skeleton check lists all 16 bone
// pairs it looks for); a row shows it up to its first parenthesis, and the
// whole of it on hover (`full`).
var MAX_REASON = 70;
function shortReason(r) {
    r = String(r || '').replace(/^failed — /, '');
    if (r.length <= MAX_REASON) return r;
    var cut = r.indexOf(' (');
    return cut > 0 && cut <= MAX_REASON ? r.slice(0, cut) : r.slice(0, MAX_REASON - 1).trimEnd() + '…';
}

/** What a check row says. */
function checkText(c) {
    switch (c.state) {
        case 'found': return plural(c.switches, 'possible switch', 'possible switches') + ' in ' +
            plural(c.encounters, 'close encounter');
        case 'clear': return c.encounters ? 'No possible switches in ' + plural(c.encounters, 'close encounter')
            : 'No close encounters to check';
        case 'off': return 'Not run';
        case 'cancelled': return 'Cancelled';
        case 'failed': return 'Failed — ' + shortReason(c.reason);
        case 'skipped': return 'Skipped — ' + shortReason(c.reason);
        default: return 'Not needed — only one identity';
    }
}

// How many identity rows the box lists before folding the rest into "and N more".
export const MAX_IDENTITY_ROWS = 12;

/**
 * Everything the summary box shows, and the next step it recommends.
 *
 * @param {ReturnType<typeof summarizeTrackedIdentities>} s
 * @param {{size: object, image: object}} checks  each from `describeSwitchCheck`
 * @returns {{
 *   title: string,
 *   stats: Array<{label:string, value:string, detail?:string, title?:string}>,
 *   identities: Array<{name:string, color:string, frames:number, share:string, frac:number}>,
 *   moreIdentities: number,
 *   notes: string[],
 *   checks: Array<{label:string, text:string, state:string, full:string, time:string}>,
 *   next: {headline:string, caveat:?string, steps:string[]},
 *   primary: {action:string, label:string},
 *   secondary: Array<{action:string, label:string}>,
 * }}
 *   Actions: 'review' (ID Switches tab), 'triangulate' (Triangulate All),
 *   'imageCheck' / 'sizeCheck' (run that check), 'wizard' (Tracking Wizard).
 */
export function planTrackSummary(s, checks) {
    var nIds = s.identities.length;
    var stats = [], notes = [];

    stats.push({
        label: 'Identities',
        value: n(nIds),
        detail: s.animals > 0 ? 'for ' + plural(s.animals, 'animal') + (s.animalsAuto ? ' (auto-detected)' : '') : '',
    });
    stats.push({
        label: 'Frames tracked',
        value: n(s.trackedFrames) + ' of ' + n(s.frames),
        detail: formatShare(s.trackedFrames, s.frames),
    });
    if (nIds > 0 && s.animals > 1) {
        stats.push({
            label: 'All ' + n(s.animals) + ' animals',
            value: plural(s.completeFrames, 'frame'),
            detail: formatShare(s.completeFrames, s.frames),
        });
    }
    var trackTime = formatDuration(s.elapsedMs);
    if (trackTime) {
        var speed = formatTrackingSpeed(s.frames, s.elapsedMs, s.fps);
        stats.push({
            label: 'Tracking time', value: trackTime,
            detail: speed.fps + (speed.realtime ? ' · ' + speed.realtime : ''),
            title: speed.fps ? 'Frames tracked per second' + (speed.realtime
                ? ', and how many times faster than the recording plays at ' +
                  (Math.round(s.fps * 100) / 100) + ' fps' : '') : '',
        });
    }

    // Identities beyond the animal count are an animal the tracker lost and
    // re-found under a new name: each extra covers only the stretch after it.
    if (s.animals > 0 && nIds > s.animals) {
        notes.push('More identities than animals: the tracker lost an animal and gave it a new identity. ' +
            'The identities with the fewest frames show where.');
    } else if (s.animals > 0 && nIds > 0 && nIds < s.animals) {
        notes.push('Fewer identities than animals: ' + (s.animals - nIds === 1 ? 'one animal was' : 'some animals were') +
            ' never matched across two views.');
    }

    var maxFrames = s.identities.reduce(function (m, id) { return Math.max(m, id.frames); }, 0);
    var identities = s.identities.slice(0, MAX_IDENTITY_ROWS).map(function (id) {
        return {
            name: id.name, color: id.color, frames: id.frames,
            share: formatShare(id.frames, s.frames),
            frac: s.frames > 0 ? Math.min(1, id.frames / s.frames) : (maxFrames > 0 ? id.frames / maxFrames : 0),
        };
    });

    var size = checks.size, image = checks.image;
    var checkRow = function (label, c) {
        return { label: label, text: checkText(c), state: c.state,
                 full: c.reason ? String(c.reason).replace(/^failed — /, '') : '',
                 time: TIMED_STATES[c.state] ? formatDuration(c.elapsedMs) : '' };
    };
    var checkRows = nIds > 1 ? [checkRow('Body size', size), checkRow('Images', image)] : [];

    var TRIANGULATE = 'Run Triangulate All for 3D poses in every frame.';
    var PROPAGATE = 'Optional: Tracks ▸ Propagate IDs → Tracks stores the identities as tracks too.';
    var next, primary, secondary = [];
    var canImage = image.state === 'off' || image.state === 'cancelled';

    if (nIds === 0) {
        next = {
            headline: 'Nothing was tracked.',
            caveat: null,
            steps: ['No animal was matched across two or more views. Check that the calibration belongs to these ' +
                'videos and that at least two views are included in the Tracking Wizard.'],
        };
        primary = { action: 'wizard', label: 'Tracking Wizard…' };
    } else if (size.state === 'found' || image.state === 'found') {
        next = {
            headline: 'Review the possible ID switches.',
            caveat: null,
            steps: ['Step through them in the ID Switches tab and fix the real ones.', TRIANGULATE, PROPAGATE],
        };
        primary = { action: 'review', label: 'Review switches' };
    } else {
        var headline, caveat = null;
        if (nIds === 1) {
            headline = 'One identity, so there is nothing to switch.';
        } else if (size.state === 'clear' && image.state === 'clear') {
            headline = 'Neither check flagged an ID switch.';
        } else if (size.state === 'clear' || image.state === 'clear') {
            headline = 'No ID switches were flagged.';
            // Body size cannot separate animals of near-equal size; images can,
            // so "nothing found" by size alone is weaker than it reads.
            if (size.state === 'clear' && canImage) {
                caveat = 'Body size cannot tell apart animals of similar size. If yours are, run the image check too.';
            }
        } else {
            headline = 'Identities were not checked for switches.';
            caveat = 'Spot-check them by playing through moments when animals come close.';
        }
        next = { headline: headline, caveat: caveat, steps: [TRIANGULATE, PROPAGATE] };
        primary = { action: 'triangulate', label: 'Triangulate All' };
        if (nIds > 1 && size.state === 'off') secondary.push({ action: 'sizeCheck', label: 'Check by body size' });
        if (nIds > 1 && canImage) secondary.push({ action: 'imageCheck', label: 'Check by images…' });
    }

    return {
        title: 'Track All finished',
        stats: stats,
        identities: identities,
        moreIdentities: Math.max(0, nIds - MAX_IDENTITY_ROWS),
        notes: notes,
        checks: checkRows,
        next: next,
        primary: primary,
        secondary: secondary,
    };
}
