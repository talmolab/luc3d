// ui/track-summary-modal.js — the box that opens when Track All finishes.
//
// Shows how tracking went (identities, frames tracked, frames with every
// animal, how long it took, each identity's share of the frames), what each
// automatic ID-switch check concluded and how long it took — "not run" and
// "skipped" included, which used to be indistinguishable from "found nothing" —
// and the NEXT STEP, with its button focused. What it says is decided by `planTrackSummary` (ui/track-summary.js);
// this module only renders it.
//
// A note, not a prompt: nothing changes until a button is pressed, Esc / Close /
// a backdrop click dismiss it, and every action button simply clicks the
// existing menu item or toolbar button, so it runs exactly what the user would
// have run by hand.
//
// Closing it is not the end of it: Track All keeps what it showed on the session
// (`rememberTrackSummary`), and the ID Switches tab reopens it
// (`reopenTrackSummary`) — with each check's CURRENT result, so a check run after
// the box was closed is reported rather than still "Not run". A check started from
// the box's own "Check by …" buttons reopens it too, when it ends, rather than
// leaving the user on the ID Switches tab: the counts are re-read and the check's
// row and the next step show what it found (or that it was cancelled).
//
// Under the identity bars, the "Identities" section (ui/identity-gallery.js): five
// sample images of each identity and a map of its path, so a switch between
// animals that look different can be seen before anything else is run. Clicking
// a sample or a point on a map closes the box and goes to that frame.
//
// Depends on: ui/track-summary.js, ui/id-switch-modal.js (openIdSwitchPanel,
// refreshIdSwitchPanel, setTrackSummaryOpener, clickCheckFromSummary), ui/identity-gallery.js.

import { planTrackSummary, summarizeTrackedIdentities, describeSwitchCheck } from './track-summary.js?v=5fb918fdc147';
import { openIdSwitchPanel, refreshIdSwitchPanel, setTrackSummaryOpener, clickCheckFromSummary } from './id-switch-modal.js?v=5fb918fdc147';
import { renderIdentityGallery } from './identity-gallery.js?v=5fb918fdc147';

// The viewer's frame navigation, registered once by ui-wiring (as the ID Switches tab's is):
// the tracker that opens this box cannot import pose/initialization.js.
var _navigate = null;

/** Register `navigateToFrame` for the Identities section's samples and maps (called once from ui/ui-wiring.js). */
export function setTrackSummaryNavigator(fn) { _navigate = fn; }

/** Click an existing control by id (a disabled button ignores it, as it would a real click). */
function clickById(id) {
    var el = document.getElementById(id);
    if (el) el.click();
}

// One per action `planTrackSummary` can recommend.
var ACTIONS = {
    review: function () {
        openIdSwitchPanel();
        // Land on the first flagged switch, as "Next unreviewed ▸" would.
        var next = document.getElementById('idSwitchNext');
        if (next && !next.disabled) next.click();
    },
    triangulate: function () { clickById('tbTriangulateAll'); },
    // These two come back here when the check ends, with its result in the box.
    imageCheck: function () { clickCheckFromSummary('menuCheckImageSwitches'); },
    sizeCheck: function () { clickCheckFromSummary('menuCheckSizeSwitches'); },
    wizard: function () { clickById('menuTrackingWizard'); },
};

function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
}

/** A colour string safe to put in a style (the identity palette is hex). */
function safeColor(c) {
    return typeof c === 'string' && /^#[0-9a-f]{3,8}$|^rgba?\([\d\s.,%]+\)$/i.test(c) ? c : null;
}

/**
 * Open the summary for a finished Track All. Replaces one already open (a
 * second run's numbers supersede the first's).
 *
 * @param {Object} summary  from `summarizeTrackedIdentities`
 * @param {{size: object, image: object}} checks  each from `describeSwitchCheck`
 * @param {{session?: Object}} [opts]  the tracked session: with it, the Identities section
 * @returns {{close: function, overlay: HTMLElement, gallery: Object|null}|null}  null without a DOM;
 *   `gallery.done` settles once its images are drawn
 */
export function showTrackSummaryModal(summary, checks, opts) {
    if (typeof document === 'undefined') return null;     // Node harnesses drive Track All with no DOM
    var plan = planTrackSummary(summary, checks);
    var old = document.getElementById('trackSummaryOverlay');
    if (old && old._close) old._close(); else if (old) old.remove();

    var overlay = el('div', 'multi-frame-modal-overlay');
    overlay.id = 'trackSummaryOverlay';
    var modal = el('div', 'multi-frame-modal track-summary-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-labelledby', 'trackSummaryTitle');
    var title = el('h3', null, plan.title);
    title.id = 'trackSummaryTitle';
    modal.appendChild(title);

    // ---- the numbers -------------------------------------------------------
    var stats = el('div', 'track-summary-stats');
    stats.id = 'trackSummaryStats';
    plan.stats.forEach(function (s) {
        var row = el('div', 'track-summary-stat');
        row.appendChild(el('span', 'track-summary-label', s.label));
        row.appendChild(el('span', 'track-summary-value', s.value));
        row.appendChild(el('span', 'track-summary-detail', s.detail || ''));
        if (s.title) row.title = s.title;
        stats.appendChild(row);
    });
    modal.appendChild(stats);

    // ---- each identity's share of the frames -------------------------------
    if (plan.identities.length > 1) {
        var ids = el('div', 'track-summary-ids');
        ids.id = 'trackSummaryIdentities';
        plan.identities.forEach(function (id) {
            var color = safeColor(id.color);
            var row = el('div', 'track-summary-id');
            row.title = id.frames.toLocaleString('en-US') + ' frames';
            var name = el('span', 'track-summary-id-name', id.name);
            if (color) name.style.color = color;
            var bar = el('span', 'track-summary-id-bar');
            var fill = el('span', 'track-summary-id-fill' + (id.frames > 0 ? ' is-sliver' : ''));
            fill.style.width = (100 * id.frac).toFixed(1) + '%';
            if (color) fill.style.background = color;
            bar.appendChild(fill);
            row.appendChild(name);
            row.appendChild(bar);
            row.appendChild(el('span', 'track-summary-id-share', id.share));
            ids.appendChild(row);
        });
        if (plan.moreIdentities > 0) {
            ids.appendChild(el('div', 'track-summary-id-more',
                'and ' + plan.moreIdentities.toLocaleString('en-US') + ' more'));
        }
        modal.appendChild(ids);
    }
    // ---- what each identity looks like, and where it went (filled in after the box opens) ----
    var gallery = opts && opts.session ? renderIdentityGallery(modal, opts.session, {
        onPick: function (frame) { close(); if (_navigate) _navigate(frame); },
    }) : null;
    if (gallery) modal.classList.add('has-gallery');
    plan.notes.forEach(function (t) { modal.appendChild(el('p', 'track-summary-note', t)); });

    // ---- the ID-switch checks ----------------------------------------------
    if (plan.checks.length) {
        var checks2 = el('div', 'track-summary-checks');
        checks2.id = 'trackSummaryChecks';
        checks2.appendChild(el('div', 'track-summary-section-title', 'ID-switch check'));
        plan.checks.forEach(function (c) {
            var row = el('div', 'track-summary-check is-' + c.state);
            row.setAttribute('data-cue', c.label === 'Images' ? 'image' : 'size');
            if (c.full) row.title = c.full;                 // the whole reason, which the row may shorten
            row.appendChild(el('span', 'track-summary-label', c.label));
            row.appendChild(el('span', 'track-summary-check-text', c.text));
            row.appendChild(el('span', 'track-summary-detail track-summary-check-time', c.time));
            checks2.appendChild(row);
        });
        modal.appendChild(checks2);
    }

    // ---- what now ----------------------------------------------------------
    var next = el('div', 'track-summary-next');
    next.id = 'trackSummaryNext';
    next.appendChild(el('div', 'track-summary-section-title', 'Next step'));
    next.appendChild(el('p', 'track-summary-headline', plan.next.headline));
    if (plan.next.caveat) next.appendChild(el('p', 'track-summary-caveat', plan.next.caveat));
    var ol = el(plan.next.steps.length > 1 ? 'ol' : 'div', 'track-summary-steps');
    plan.next.steps.forEach(function (t) { ol.appendChild(el(plan.next.steps.length > 1 ? 'li' : 'p', null, t)); });
    next.appendChild(ol);
    modal.appendChild(next);

    // ---- buttons: the alternatives, Close, then the recommended step -------
    var actions = el('div', 'modal-actions');
    var close = function () {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
    };
    overlay._close = close;
    var button = function (spec, cls) {
        var b = el('button', cls || null, spec.label);
        b.setAttribute('data-action', spec.action);
        b.addEventListener('click', function () {
            close();
            if (ACTIONS[spec.action]) ACTIONS[spec.action]();
        });
        return b;
    };
    plan.secondary.forEach(function (spec) { actions.appendChild(button(spec)); });
    var closeBtn = el('button', null, 'Close');
    closeBtn.id = 'trackSummaryClose';
    closeBtn.addEventListener('click', close);
    actions.appendChild(closeBtn);
    var primary = button(plan.primary, 'primary');
    primary.id = 'trackSummaryPrimary';
    actions.appendChild(primary);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Capture phase, and every key stops here: the app's shortcuts must not act
    // under an open dialog. Enter / Space still press the focused button (a
    // default action, not a listener), which is the recommended step.
    var onKey = function (e) {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    primary.focus();
    return { close: close, overlay: overlay, gallery: gallery };
}

/**
 * Keep a finished Track All's summary on its session, for `reopenTrackSummary`.
 * In memory only — not saved with the project. Replaces the session's previous one.
 *
 * @param {Session} session
 * @param {Object} opts  `summarizeTrackedIdentities`'s options for the pass
 * @param {{size: object, image: object}} checks  what the box showed, from `describeSwitchCheck`
 * @param {number} identities  identities the pass assigned
 */
export function rememberTrackSummary(session, opts, checks, identities) {
    if (!session) return;
    session._trackSummary = { opts: opts, checks: checks, identities: identities };
    refreshIdSwitchPanel(session);                       // the tab's reopen button appears
}

/**
 * Reopen the session's last Track All summary. The numbers are re-counted from the
 * session as it is now (a fixed switch moves the shares), the time is the pass's own,
 * and each check shows its current result: a check run since replaces the pass's
 * "Not run" / "Skipped", and one whose results were cleared reads "Not run" again.
 * A skip or a failure is not kept by the check itself, so it comes from the pass —
 * or from `latest`, a check just run from this box, whose outcome (a cancel, skip or
 * failure included) replaces the pass's from then on.
 *
 * @param {Session} session
 * @param {{size?: object, image?: object}|null} [latest]  `runIdSwitchChecks`'s results
 *   for a check the box started (`clickCheckFromSummary`)
 * @returns {{close: function, overlay: HTMLElement}|null}  null when there is none
 */
export function reopenTrackSummary(session, latest) {
    var saved = session && session._trackSummary;
    if (!saved) return null;
    var results = (session._idSwitch && session._idSwitch.results) || {};
    var checks = {};
    ['size', 'image'].forEach(function (cue) {
        if (latest && latest[cue]) saved.checks[cue] = describeSwitchCheck(true, latest[cue], saved.identities);
        var now = results[cue], then = saved.checks[cue];
        if (now && now.ok) checks[cue] = describeSwitchCheck(true, now, saved.identities);
        else if (then && (then.state === 'found' || then.state === 'clear')) checks[cue] = describeSwitchCheck(false, null, saved.identities);
        else checks[cue] = then;
    });
    return showTrackSummaryModal(summarizeTrackedIdentities(session, saved.opts), checks, { session: session });
}

// The ID Switches tab's "Show Track All summary" (ui/id-switch-modal.js stays a leaf: it is handed this)
setTrackSummaryOpener(reopenTrackSummary);
