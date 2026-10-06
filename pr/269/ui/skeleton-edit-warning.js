// ui/skeleton-edit-warning.js — confirm a skeleton edit against what it will
// re-shape.
//
// The Skeleton tab's node/edge controls look like settings and are not. The
// skeleton is the shape EVERY instance in the project is stored against —
// `Instance` keeps one flat `Float64Array(2N)` keyed by node INDEX — and LUCID
// is one skeleton per project, so a node typed into that box re-shapes every
// annotation in every loaded session at once. Before this dialog the only
// signal was a `console.warn` nobody sees.
//
// Five things about it:
//
// - **It is a title, one sentence, and the COUNTS.** It used to carry a
//   bulleted "What changes" block and an always-on "there is no undo" caution
//   as well: four paragraphs of prose above the one thing a reader can act on,
//   restating per edit what the lead already said, and a box that by its third
//   appearance is scenery — which would cost the lazy warning below its weight
//   too. The per-edit detail belongs in MODULES.md, not over the panel.
//
// - **It states a TOTAL and a per-session split.** A multi-session project
//   shares one skeleton object, so "4,812 user instances" is the project's
//   number, not the open session's; the by-session block exists so the user can
//   see which session that is actually in. The two can never disagree, because
//   the total is a fold of the same `perSession` records
//   (`pose/skeleton-edit-impact.js`).
//
// - **A lazy project gets a RED warning and the dialog advises against the
//   edit.** `Session.propagateNodeAdded` / `propagateNodeRemoved` can only
//   re-shape instances that are resident; the columnar store has a fixed node
//   count per instance and a skeleton edit cannot be expressed in it at all. A
//   frame hydrated afterwards comes back on the PREVIOUS skeleton — no error,
//   no symptom, until a save cements two different node counts into one file.
//   That is the failure the user needs to be steered away from, so the warning
//   names the non-resident frame count and says what to do instead.
//
// - **It is skipped when there is nothing to warn about.** Building the first
//   skeleton means typing a node name N times, and a modal per node would be
//   intolerable. `skeletonEditNeedsConfirmation` gates it: no instances, no
//   groups, nothing lazy → the edit applies straight through.
//
// - **"Do not show again" is the user's own version of that gate**, kept in
//   `localStorage` (browser-local display taste, never the `.slp`). It is
//   recorded only when the edit is APPLIED — ticked and then cancelled it does
//   nothing — and the Skeleton tab grows a `#skeletonWarnOffNote` line while it
//   is set, so the way back on sits where the thing it governs happens. A
//   preference you can set and never unset is a trap, and this one hides a
//   warning about silent data loss.
//
// - **The caller owns the mutation.** This module shows a dialog and calls
//   back; it never touches the skeleton. That keeps each edit's propagation
//   (which differs per kind — a node add has to grow instance buffers, an edge
//   add has to do nothing but repaint) in `ui/info-panel.js` beside the control
//   it belongs to.
//
// Geometry and block/table/caution classes are shared with
// `ui/origin-rebase.js`'s confirmation, for the same reason
// `ui/calibration-notice.js` shares them: it is the same kind of dialog — a
// stack of titled blocks whose height depends on the project.

import { state } from './app-state.js?v=5742b520de9a';
import {
    splitSessionsBySkeleton, countSkeletonEditImpact, skeletonEditNeedsConfirmation,
} from '../pose/skeleton-edit-impact.js?v=5742b520de9a';

/** `1,234` rather than `1234`, because these numbers get large. */
function n(v) {
    return (v || 0).toLocaleString();
}

// ============================================
// "Do not show again"
// ============================================
//
// Browser-local display taste, the same class as the Define Planes panel's
// section folds and the Visibility panel's global appearance prefs — so it
// lives in `localStorage` and MUST NOT reach the `.slp`: it is a property of
// this person's browser, not of the project, and opening a colleague's project
// should not silence their warnings (nor `save-golden-digest.mjs` move).
//
// Every access is try/caught. A private window and blocked site data throw on
// read AND on write, and a browser that cannot remember the preference has to
// keep WARNING — the failure direction is the one that shows the dialog, never
// the one that silently skips it.

const SKELETON_EDIT_WARN_KEY = 'skeletonEditWarningOff';

/** Has the user asked not to be shown this again? @returns {boolean} */
export function isSkeletonEditWarningSuppressed() {
    try {
        return localStorage.getItem(SKELETON_EDIT_WARN_KEY) === '1';
    } catch (e) {
        return false;
    }
}

/**
 * Remember (or forget) the preference. The Skeleton tab's
 * `#skeletonWarnOffNote` is the way back on — a setting a user can switch off
 * and never find again is a trap, and this one hides a warning about silent
 * data loss.
 * @param {boolean} off
 */
export function setSkeletonEditWarningSuppressed(off) {
    try {
        if (off) localStorage.setItem(SKELETON_EDIT_WARN_KEY, '1');
        else localStorage.removeItem(SKELETON_EDIT_WARN_KEY);
    } catch (e) { /* best effort — see above */ }
}

/**
 * What each kind of edit is, in one sentence, in the user's terms.
 *
 * Kept as one table rather than as strings at the five call sites: the five
 * edits differ in exactly this and in nothing else, and a consequence written
 * beside the button that causes it is a consequence that drifts from what the
 * code does. `title` is a question, because the dialog is one.
 *
 * **One sentence, and no bulleted "What changes" list.** That list was four
 * paragraphs of prose above the one thing a reader can act on — the counts —
 * restating per edit what the lead already says. The counts, the by-session
 * split and the lazy warning are the dialog; everything else is MODULES.md.
 *
 * @param {{kind: string, label?: string}} edit
 * @returns {{title: string, lead: string}}
 */
export function describeSkeletonEdit(edit) {
    var what = (edit && edit.label) || '';
    var k = edit && edit.kind;
    if (k === 'add-node') {
        return {
            title: 'Add node “' + what + '” to the skeleton?',
            lead: 'This project already has annotations. The skeleton is the shape every one ' +
                'of them is stored against, so adding a node re-shapes all of them — hand-' +
                'labelled instances get the node placed beside the animal and switched off, ' +
                'predicted ones get an empty slot.',
        };
    }
    if (k === 'remove-node') {
        return {
            title: 'Remove node “' + what + '” from the skeleton?',
            lead: 'This project already has annotations. Removing a node deletes that node’s ' +
                '2D and 3D coordinates from every one of them, in every session, and removes ' +
                'every edge touching it.',
        };
    }
    if (k === 'rename-node') {
        return {
            title: 'Rename node to “' + what + '”?',
            lead: 'No coordinates move — a rename changes the node’s NAME, which is how ' +
                'every other tool identifies it. A model, an analysis script or a SLEAP project ' +
                'keyed on the old name will no longer match this skeleton.',
        };
    }
    if (k === 'add-edge') {
        return {
            title: 'Add edge “' + what + '”?',
            lead: 'No coordinates move — an edge is how the skeleton is DRAWN and exported, ' +
                'not where any point is. Exported .slp files carry the new edge, so this ' +
                'skeleton no longer matches a model or project built on the old one.',
        };
    }
    return {
        title: 'Remove edge “' + what + '”?',
        lead: 'No coordinates move — an edge is how the skeleton is DRAWN and exported, ' +
            'not where any point is. Exported .slp files no longer carry the edge, so this ' +
            'skeleton no longer matches a model or project built on the old one.',
    };
}

/**
 * Show the confirmation and run `onConfirm()` if the user accepts.
 *
 * Applies the edit immediately, without a dialog, in two cases: when there is
 * nothing to warn about (`skeletonEditNeedsConfirmation`), and when the user
 * has ticked "Do not show again". The callback is what mutates; this function
 * never touches the skeleton.
 *
 * **The suppression check comes FIRST**, before the tally. The tally walks a
 * lazy project's whole columnar store, and a user who has turned the dialog off
 * should not keep paying for a dialog that will not open.
 *
 * @param {{kind: string, label?: string}} edit
 * @param {Function} onConfirm
 */
export function confirmSkeletonEdit(edit, onConfirm) {
    if (isSkeletonEditWarningSuppressed()) {
        if (onConfirm) onConfirm();
        return;
    }

    var sessions = (state.sessions && state.sessions.length)
        ? state.sessions
        : (state.session ? [state.session] : []);
    var skeleton = state.session && state.session.skeleton;
    var split = splitSessionsBySkeleton(sessions, skeleton);
    var t = countSkeletonEditImpact(split.shared);

    if (!skeletonEditNeedsConfirmation(t)) {
        if (onConfirm) onConfirm();
        return;
    }

    var copy = describeSkeletonEdit(edit);

    var overlay = document.createElement('div');
    overlay.className = 'plane-confirm-overlay';
    overlay.id = 'skeletonEditConfirm';

    var modal = document.createElement('div');
    modal.className = 'plane-confirm-modal skeleton-edit-modal';

    var h = document.createElement('h3');
    h.textContent = copy.title;
    modal.appendChild(h);

    var lead = document.createElement('div');
    lead.className = 'plane-confirm-message';
    lead.id = 'skeletonEditLead';
    lead.textContent = copy.lead;
    modal.appendChild(lead);

    // ---- the totals ----
    //
    // Across EVERY session sharing this skeleton, which on a LUCID project is
    // every session loaded. The 2D rows are the whole population — grouped and
    // ungrouped — because most of an imported `.slp` is ungrouped predictions
    // and quoting only the grouped half says a few dozen on a project holding
    // hundreds of thousands.
    var rows = [
        ['Sessions on this skeleton', n(t.sessions), null],
        ['User 2D instances', n(t.userInstances), 'sub'],
        ['Predicted 2D instances', n(t.predictedInstances), 'sub'],
        ['Instance groups (3D)', n(t.groups), 'sub'],
        [' triangulated keypoints', n(t.keypoints3d), 'sub2'],
        ['Cached reprojections', n(t.reprojectedInstances), 'sub'],
    ];
    buildTable(modal, 'skeletonEditTotals', 'Annotations affected — whole project', null, rows);

    // ---- per session ----
    //
    // Only when there is more than one, because with one session the table
    // above IS the per-session table and repeating it would read as two
    // different measurements of the same thing.
    //
    // **No Total row.** It used to carry one, and it was the same arithmetic
    // printed twice: the whole-project block directly above IS the total, so a
    // second copy of it a few rows down invites the reader to check one against
    // the other instead of reading either. This block answers the one question
    // the block above cannot — WHICH session the number is in.
    if (t.perSession.length > 1) {
        var perRows = [];
        for (var i = 0; i < t.perSession.length; i++) {
            var ps = t.perSession[i];
            perRows.push([
                ps.name + (ps.lazy ? ' — partially loaded' : ''),
                n(ps.userInstances) + ' user · ' + n(ps.predictedInstances) +
                    ' pred · ' + n(ps.groups) + ' 3D',
                'sub',
            ]);
        }
        buildTable(modal, 'skeletonEditBySession', 'By session',
            'One skeleton is shared by every session, so this edit applies to all of them.',
            perRows);
    }

    // A session on a DIFFERENT skeleton is not touched and is not counted. It
    // should not exist in a LUCID project, so say so rather than leaving the
    // totals quietly short.
    if (split.others.length > 0) {
        var oth = document.createElement('div');
        oth.className = 'plane-confirm-message';
        oth.id = 'skeletonEditOtherSkeletons';
        oth.textContent = n(split.others.length) + ' loaded session(s) carry a different ' +
            'skeleton and are not counted above. They keep the skeleton they have.';
        modal.appendChild(oth);
    }

    // ---- the lazy hazard, which is the loud one ----
    //
    // Red and first, because it is the only failure here that is SILENT. The
    // edit succeeds, the panel updates, nothing looks wrong — and the frames
    // still in the store come back on the old skeleton the next time they are
    // hydrated. The advice is concrete, because "be careful" is not advice.
    if (t.anyLazy) {
        var lazyWarn = document.createElement('div');
        lazyWarn.className = 'origin-rebase-caution';
        lazyWarn.id = 'skeletonEditLazyWarning';
        lazyWarn.textContent =
            'Strongly not recommended on this project. ' + n(t.lazySessions) +
            ' session(s) are loaded lazily: only ' + n(t.residentFrames) + ' of ' +
            n(t.totalFrames) + ' frames are in memory, and a skeleton edit can only reach ' +
            'those. The remaining ' + n(t.nonResidentFrames) + ' frames are rebuilt from the ' +
            'file with their old node count, so they keep the PREVIOUS skeleton — with no ' +
            'error and nothing on screen to show it, until a save writes two different ' +
            'skeletons into one project. Edit the skeleton on a smaller project, or before ' +
            'importing predictions, and keep large files on the skeleton they were ' +
            'predicted with.';
        modal.appendChild(lazyWarn);
    }

    // There is deliberately no second, always-on caution here. The lazy
    // warning above is the only hazard that is SILENT; "there is no undo" and
    // "re-run Triangulate" are things the Cancel button and the panel already
    // say, and a box that appears on every edit is a box nobody reads by the
    // third one — which would cost the lazy warning its weight too.

    // ---- actions ----
    var actions = document.createElement('div');
    actions.className = 'modal-actions skeleton-edit-actions';

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

    // "Do not show again", on the LEFT of the two buttons, because it is not a
    // third action — it qualifies the one the user is about to take.
    //
    // **It is recorded only when the edit is APPLIED.** Ticked and then
    // cancelled it does nothing: "do not show this again" alongside "do not do
    // this" is two different intentions, and guessing which one won would
    // silence a warning about silent data loss on the strength of a dialog the
    // user rejected. `#skeletonWarnOffNote` in the Skeleton tab is the way back
    // on — it appears only while this is set.
    var again = document.createElement('label');
    again.className = 'skeleton-edit-again';
    var againBox = document.createElement('input');
    againBox.type = 'checkbox';
    againBox.id = 'skeletonEditDontAsk';
    var againText = document.createElement('span');
    againText.textContent = 'Do not show again';
    again.appendChild(againBox);
    again.appendChild(againText);
    actions.appendChild(again);

    var buttons = document.createElement('div');
    buttons.className = 'skeleton-edit-buttons';

    var cancel = document.createElement('button');
    cancel.id = 'btnSkeletonEditCancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', close);
    buttons.appendChild(cancel);

    var ok = document.createElement('button');
    ok.id = 'btnSkeletonEditConfirm';
    ok.className = 'primary';
    ok.textContent = t.sessions > 1
        ? 'Apply to all ' + n(t.sessions) + ' sessions'
        : 'Apply';
    ok.addEventListener('click', function () {
        if (againBox.checked) setSkeletonEditWarningSuppressed(true);
        close();
        if (onConfirm) onConfirm();
    });
    buttons.appendChild(ok);

    actions.appendChild(buttons);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
}

/**
 * One titled block with a table, appended to `modal`.
 *
 * A plain `div`, not a `<details>`: this dialog's blocks are short, and the
 * folding in `ui/origin-rebase.js` exists because that one stacks three tall
 * tables plus two cautions. Rows are `[label, value, className]`.
 */
function buildTable(modal, id, title, note, rows) {
    var wrap = document.createElement('div');
    wrap.className = 'origin-rebase-block';

    var bh = document.createElement('div');
    bh.className = 'origin-rebase-block-title';
    bh.textContent = title;
    wrap.appendChild(bh);

    if (note) {
        var sub = document.createElement('div');
        sub.className = 'origin-rebase-block-note';
        sub.textContent = note;
        wrap.appendChild(sub);
    }

    var table = document.createElement('table');
    table.className = 'origin-rebase-table';
    table.id = id;
    rows.forEach(function (row) {
        var tr = document.createElement('tr');
        if (row[2]) tr.className = 'origin-rebase-' + row[2];
        var td1 = document.createElement('td');
        td1.textContent = row[0];
        var td2 = document.createElement('td');
        td2.className = 'origin-rebase-num';
        td2.textContent = row[1];
        tr.appendChild(td1); tr.appendChild(td2);
        table.appendChild(tr);
    });
    wrap.appendChild(table);
    modal.appendChild(wrap);
    return table;
}
