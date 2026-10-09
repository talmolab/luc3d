// ui/calibration-notice.js — tell the user when a multi-session project's
// sessions do not all carry the same calibration.
//
// A multi-session load reads one calibration per session folder and nothing
// makes them match. Almost always they are copies of one file and there is
// nothing to say, so this modal is deliberately silent in the ordinary case —
// it opens only when `compareSessionCalibrations` finds a real disagreement.
//
// It exists because the disagreement is otherwise INVISIBLE. Each session
// reprojects correctly against its own cameras, every error is small, every
// number looks plausible; what is broken is only the comparison BETWEEN
// sessions, which nothing on screen performs and so nothing on screen
// contradicts. The user finds out when a distance measured in one session does
// not match the same distance in another, long after annotating both.
//
// **It is a NOTE, and it says only what the user has to act on: WHICH SESSIONS
// LOADED WHICH CALIBRATION.** It used to also classify the disagreement
// (origin / lens / cameras / extrinsics), quote the measured offset, explain
// the consequence and list remedies — five blocks of prose over a grouping
// table two rows tall. That is a document, not a note: nobody reads it on the
// way into a project, and the one line they needed — the name of the odd
// folder — was buried in it. The classification is still MEASURED, because the
// detector has to know whether the sessions agree at all; it now goes to the
// console for whoever is debugging, and the modal shows the grouping.
//
// The remedies are not lost either — they belong where the divergence is
// CREATED, not where it is discovered: the Set as New Calibration
// confirmation's `#originRebaseMultiNote` states the obligation to deal with
// the other session folders before it writes the file that causes this.
//
// One dismiss button, Esc closes it, and it changes nothing. Offering a fix
// here would mean writing to the user's session folders during a load, which
// is not what a load is for.

import { compareSessionCalibrations } from '../pose/calibration-compare.js?v=47948b6dc0b2';

/** Thousands separators, matching the origin dialogs. */
function n(v) {
    return (v || 0).toLocaleString('en-US');
}

/** A length in mm, at a precision a user can read rather than 15 digits. */
function mm(v) {
    if (!isFinite(v)) return '?';
    if (v >= 100) return n(Math.round(v)) + ' mm';
    if (v >= 1) return v.toFixed(1) + ' mm';
    return v.toFixed(3) + ' mm';
}

function deg(v) {
    if (!isFinite(v)) return '?';
    return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + '°';
}

function plural(count, word) {
    return n(count) + ' ' + word + (count === 1 ? '' : 's');
}

/** A short list of names that does not run off the modal. */
function names(list, limit) {
    var cap = limit || 6;
    if (list.length <= cap) return list.join(', ');
    return list.slice(0, cap).join(', ') + ' and ' + n(list.length - cap) + ' more';
}

/**
 * A, B, C… per distinct calibration.
 *
 * The letter is a handle for talking about a group whose only other identity is
 * the list of folders under it — it is NOT read off the file name, because two
 * groups routinely both loaded a file called `calibration.toml`.
 */
function groupLetter(i) {
    return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

/**
 * Show the note. Assumes `report.ok === false`; callers use
 * `noteSessionCalibrationDivergence` rather than calling this directly.
 */
export function showCalibrationNoticeModal(report) {
    var overlay = document.createElement('div');
    overlay.className = 'plane-confirm-overlay';
    overlay.id = 'calibNoticeOverlay';

    var modal = document.createElement('div');
    modal.className = 'plane-confirm-modal calib-notice-modal';

    var h = document.createElement('h3');
    // One title whatever the KIND of disagreement: the user's next move is the
    // same either way — go and look at the folder the modal names — and a title
    // that changed with the classification implied the modal was about to
    // explain the difference, which it deliberately no longer does.
    h.textContent = 'Sessions with different calibrations detected';
    modal.appendChild(h);

    // ---- who loaded what ---------------------------------------------
    //
    // The largest group first, so the odd session out is the LAST thing read
    // rather than sorted into detection order. `report.reference` is the
    // detector's own answer to "which is the majority", so the modal does not
    // recompute it and cannot disagree with the console line below.
    var order = [report.reference].concat(report.groups
        .map(function (g, i) { return i; })
        .filter(function (i) { return i !== report.reference; }));

    var groups = document.createElement('div');
    groups.id = 'calibNoticeGroups';
    order.forEach(function (gi, slot) {
        var g = report.groups[gi];
        var wrap = document.createElement('div');
        wrap.className = 'origin-rebase-block calib-notice-group';
        wrap.setAttribute('data-calib-group', groupLetter(slot));

        var title = document.createElement('div');
        title.className = 'origin-rebase-block-title calib-notice-group-title';
        var label = document.createElement('span');
        label.textContent = 'Calibration ' + groupLetter(slot);
        var count = document.createElement('span');
        count.className = 'calib-notice-group-count';
        count.textContent = plural(g.sessions.length, 'session')
            + ' · ' + plural(g.cameraCount, 'camera');
        title.appendChild(label);
        title.appendChild(count);
        wrap.appendChild(title);

        // One folder name per line. These are the only actionable strings in
        // the modal — the user takes one and opens it — and comma-joining them
        // made a wrapped paragraph whose name boundaries had to be picked out.
        var list = document.createElement('div');
        list.className = 'calib-notice-sessions';
        // Capped so a project with dozens of sessions cannot make the majority
        // group an unbounded wall of names; the count on the title row is
        // always the true total.
        var CAP = 10;
        g.sessions.slice(0, CAP).forEach(function (name) {
            var row = document.createElement('div');
            row.className = 'calib-notice-session';
            row.textContent = name;
            list.appendChild(row);
        });
        if (g.sessions.length > CAP) {
            var more = document.createElement('div');
            more.className = 'calib-notice-session calib-notice-more';
            more.textContent = 'and ' + n(g.sessions.length - CAP) + ' more';
            list.appendChild(more);
        }
        wrap.appendChild(list);
        groups.appendChild(wrap);
    });
    modal.appendChild(groups);

    if (report.withoutCalibration.length) {
        var noCal = document.createElement('div');
        noCal.className = 'origin-rebase-block-note';
        noCal.id = 'calibNoticeNoCal';
        // Not a disagreement, and not silently dropped either: a session with no
        // calibration is excluded from the comparison, and a reader counting the
        // sessions listed above against the session strip would otherwise come
        // up short and wonder which one the check missed.
        noCal.textContent = 'Not compared, no calibration loaded: '
            + names(report.withoutCalibration, 4) + '.';
        modal.appendChild(noCal);
    }

    var actions = document.createElement('div');
    actions.className = 'modal-actions';
    function close() {
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.remove();
    }
    function onKey(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        close();
    }
    var ok = document.createElement('button');
    ok.id = 'btnCalibNoticeOk';
    ok.className = 'primary';
    ok.textContent = 'Got it';
    ok.addEventListener('click', close);
    actions.appendChild(ok);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    return overlay;
}

/**
 * Compare the loaded sessions' calibrations and, if they disagree, say so.
 *
 * Called at the END of a multi-session load, once every session is in
 * `state.sessions` — the comparison is meaningless while sessions are still
 * arriving one at a time, and a modal raised mid-load would sit over the
 * loading overlay.
 *
 * @param {Array<Object>} sessions - `state.sessions`
 * @returns {Object|null} the report when a modal was shown, else null. Returning
 *   the report rather than a boolean is what lets the e2e test assert on the
 *   numbers the modal is built from.
 */
export function noteSessionCalibrationDivergence(sessions) {
    var report;
    try {
        report = compareSessionCalibrations(sessions);
    } catch (e) {
        // A load must never fail because of a check that only prints advice.
        console.warn('[calibration-notice] comparison failed:', e);
        return null;
    }
    if (!report || report.ok) return null;
    // The measured detail the modal no longer prints. It is worth keeping
    // somewhere — it is what distinguishes a misplaced `calibration-rebased.toml`
    // (one rigid transform explains every camera) from sessions genuinely
    // calibrated apart — and the console is where someone asking that question
    // is already looking.
    console.warn('[calibration-notice] ' + report.groups.length
        + ' distinct calibrations across ' + report.comparedCount + ' sessions',
        report.diffs.map(function (d) {
            var f = d.frame;
            var detail = f && f.rigid
                ? ' (origin ' + mm(f.distanceMm) + ' / ' + deg(f.angleDeg) + ')'
                : '';
            return d.sessions.join('+') + ':' + d.kind + detail;
        }).join(' '));
    showCalibrationNoticeModal(report);
    return report;
}
