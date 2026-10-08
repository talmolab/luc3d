// ui/origin-rebase.js — "Set as New Calibration", the Danger Zone's other half.
//
// `Export New Calibration` writes a re-based calibration and leaves the project
// exactly as it was. This one commits: it rewrites every 3D number in the
// project, so the world the project is expressed in becomes the origin the user
// defined, and writes the calibration that matches. Afterwards there is no
// offset left to report, and the Defined Origin block disappears with it.
//
// ## Nothing on disk is overwritten, and that has a cost worth naming
//
// The calibration goes to a NEW file (`REBASED_CALIBRATION_NAME`), never over
// the `calibration.toml` the project was annotated against — that file is
// usually shared with tools outside LUCID, and silently rewriting it is not
// this action's business. It is the SAME name `Export New Calibration` writes,
// because for a given origin the two produce byte-identical TOML; what differs
// is whether the project moved to match, which is not a property of the file.
//
// ## The project IS written, automatically
//
// The re-base itself is an in-memory edit, so `project.slp` keeps the old
// coordinates until something saves it. `autoSaveAfterRebase` does that as the
// last step, rather than telling the user to. Leaving it to them opened a
// window in which the calibration just written to disk disagreed with the
// project sitting beside it, and nothing about that window was useful. A
// project with no file handle yet cannot be saved without a picker — which
// needs a user gesture this flow no longer has — so that one case asks for a
// Save As in the status bar.
//
// What the user still has to know is that the old `calibration.toml` is not
// the project's calibration any more: `pickCalibrationFile` takes
// `REBASED_CALIBRATION_NAME` when a folder holds both. That is said once, in
// the confirmation (`#originRebaseStaleWarning`), before anything happens.
// There is no completion modal: it listed two obligations, one of which is now
// done automatically and the other of which had already been stated.
//
// ## On a multi-session project, the user chooses which sessions move
//
// There is one calibration file per session FOLDER and this action writes
// exactly one of them, so re-basing all of them unconditionally was a decision
// the dialog was making on the user's behalf. The "By session" block carries a
// checkbox per row and `runSetCalibration` is handed the FILTERED array — no
// mode flag, so there is no partial code path to drift.
//
// Two things constrain it. The ACTIVE session's box is checked and disabled:
// its cameras are what the new calibration describes, and the project-wide
// `PlaneModel` moves once, with it. And deselecting anything is a real hazard —
// the sessions left behind keep their old 3D while the rest of the project
// moves, so the project holds 3D in two frames, which is what
// `pose/calibration-compare.js` detects and `ui/calibration-notice.js` reports
// on the next load. `#originRebaseSubsetWarning` says so, in two sentences, and
// only while something is actually switched off.
//
// The maths and the copy-on-write plan are in `pose/origin-rebase.js`; this
// file is the dialog, the progress bar, the cancel button and the file write.
//
// ## Order of operations, which is not arbitrary
//
//   1. Confirm, with the counts.
//   2. **Get the file handle, still inside the click.** `showSaveFilePicker`
//      needs transient user activation, and activation expires in a few
//      seconds — asking for it AFTER a minute of re-basing throws
//      `SecurityError`, so the picker has to come first even though it reads
//      oddly. Declining here aborts with nothing touched. The picker is a
//      SAVE picker pointed at a new name, not at an existing file.
//   3. Plan (the slow part), behind a blocking progress modal with Cancel.
//   4. Write the file.
//   5. Only then swap the new buffers in.
//
// Steps 3-5 are ordered so that every failure mode leaves the project
// untouched: a cancel discards the plan, and a failed write discards it too.
// The one irreversible moment is step 5, which is synchronous and cannot fail
// part-way.
//
// The handle is remembered for the page session, so the picker appears once.

import { state, viewport3d } from './app-state.js?v=37dadb6545b9';
import { setStatus, markDirty, quickSave } from '../import-export/save-load.js?v=37dadb6545b9';
import { exportCalibrationTOML, downloadTOML } from '../import-export/file-io.js?v=37dadb6545b9';
import { REBASED_CALIBRATION_NAME } from '../loading/calibration-pick.js?v=37dadb6545b9';
import { countRebaseTargets, subsetRebaseTally, planOriginRebase, applyOriginRebase } from '../pose/origin-rebase.js?v=37dadb6545b9';
// Both circular by design and used only inside function bodies, the same rule
// the rest of this directory's cycles follow.
import { originState, renderOriginResult } from './origin-definition.js?v=37dadb6545b9';
import { planeModel, syncPlanes3D, refreshPlanePanel } from './plane-definition.js?v=37dadb6545b9';
import { drawAllOverlays } from './rendering.js?v=37dadb6545b9';
import { update3DViewport } from '../pose/initialization.js?v=37dadb6545b9';

/**
 * @type {FileSystemFileHandle|null} Where `calibration.toml` lives, once the
 * user has pointed at it. Page-session only — a handle is not serializable and
 * re-granting it is one click.
 */
var calibHandle = null;

/** Test seam: forget the remembered file. */
export function resetCalibrationHandle() {
    calibHandle = null;
}

// ============================================
// Step 1 — the confirmation, with the counts
// ============================================

/** `1,234` rather than `1234`, because these numbers get large. */
function n(v) {
    return (v || 0).toLocaleString();
}

/**
 * The warning modal. Lists what will be updated, split by provenance, and
 * says plainly that the tab has to stay open.
 *
 * Built by hand rather than through `showPlaneDialog` because it needs a table
 * and a highlighted caution line, and because Continue has to kick off an async
 * flow that the dialog helper has no way to express.
 */
export function showSetCalibrationModal() {
    var f = originState.frame;
    if (!f) {
        setStatus('Define an origin first — there is nothing to re-base the project onto', 'warning');
        return;
    }
    var sessions = state.sessions && state.sessions.length ? state.sessions
        : (state.session ? [state.session] : []);
    // Falsy entries are dropped BEFORE anything is counted, because
    // `countRebaseTargets` skips them too — and the per-session checkboxes are
    // keyed by `perSession` index, so one hole in the middle would seat every
    // toggle past it on its neighbour's session. Same class of bug as indexing
    // plane nodes by position instead of by id.
    sessions = sessions.filter(function (s) { return !!s; });
    if (!sessions.length) {
        setStatus('No session loaded', 'error');
        return;
    }
    var tFull = countRebaseTargets(sessions, planeModel());

    // ---- which sessions move ----
    //
    // A multi-session project loads one calibration per session FOLDER, and
    // this action writes exactly one of them, so "re-base everything" is not
    // always what the user wants: the session whose folder gets the new file is
    // the one that has to move, and the rest are a choice. `chosen[i]` is that
    // choice, and everything downstream reads the FILTERED session array rather
    // than a flag, so there is no partial-mode code path to get wrong.
    //
    // The ACTIVE session is found by IDENTITY, and specifically by `===` against
    // `state.session` — not `state.activeSessionIdx`, and certainly not 0.
    // `state.session` is a plain property that `switchToSession` keeps in step
    // with the index, and it is what `runSetCalibration` reads to pick the
    // cameras that go in the file. Pinning the row by anything else would let
    // the pinned row and the written calibration name different sessions.
    var activeIdx = sessions.indexOf(state.session);
    if (activeIdx < 0) activeIdx = 0;
    var chosen = sessions.map(function () { return true; });
    var t = tFull;

    var overlay = document.createElement('div');
    overlay.className = 'plane-confirm-overlay';
    overlay.id = 'originRebaseConfirm';

    var modal = document.createElement('div');
    modal.className = 'plane-confirm-modal origin-rebase-modal';

    var h = document.createElement('h3');
    h.textContent = 'Set as New Calibration?';
    modal.appendChild(h);

    var intro = document.createElement('div');
    intro.className = 'plane-confirm-message';
    intro.textContent =
        'This rewrites every 3D point in the project so that "' +
        f.sourceNode + '" on plane "' + f.sourcePlane + '" becomes the origin, and writes a ' +
        'new calibration to match. All 2D annotation stays exactly where it is, and so does ' +
        'every reprojection — the world and the cameras move together, so no pixel changes. ' +
        'Nothing on disk is overwritten: save the project to keep the new 3D.';
    modal.appendChild(intro);

    // TWO tables, because the single one answered two different questions in
    // one column and left the reader to sort out which row was which. The
    // split is the only thing about this action a user actually has to trust:
    // **what moves** and **what does not**. A camera appears in both, and that
    // is not a compromise — its extrinsics move and its lens model does not,
    // and "does this rewrite my intrinsics?" is the most common fear about
    // pressing the button.
    //
    // Every row is present for EVERY project, zeros included. A per-camera
    // session with no `project.slp` has no instance groups and no pose 3D, so
    // those rows read 0 — which is exactly how a user tells an un-triangulated
    // session from a triangulated one. Hiding them would make the modal's
    // shape depend on the load path and turn "there is no 3D here" into
    // silence, which is the failure this dialog already had once.
    var grp = function (v, what) {
        return '\u2003\u2003from ' + n(v) + ' ' + what + ' group' + (v === 1 ? '' : 's');
    };
    // The 2D rows are the WHOLE population — every instance in the project,
    // grouped or not — because most of what an imported `.slp` carries is
    // ungrouped predictions, and reporting only the grouped ones said `0`
    // on a project holding hundreds of thousands. The grouped subtotal rides
    // along because it is the answer to the question the two numbers raise:
    // why there is so little 3D under so much 2D.
    var twoD = function (total, grouped) {
        if (!total) return n(total);
        return n(total) + ' \u2014 ' + n(grouped) + ' in instance groups';
    };

    /**
     * One session's name, with the checkbox that says whether it moves.
     *
     * The ACTIVE session's box is checked and DISABLED, which is the honest
     * shape for something that is not a choice: its cameras are what
     * `calibration-rebased.toml` describes, and the project-wide `PlaneModel`
     * — the node pool and every plane fit — moves once, with it. Leaving it
     * behind would mean writing a calibration for a frame the project's own
     * plane geometry is not in. The reason is in the block note rather than in
     * the row, so the cell stays nothing but the folder name the user is going
     * to go and find on disk.
     *
     * The row is a `<label>`, so the name is part of the hit target — these
     * names are long timestamped folders and a 13px checkbox is not.
     */
    function sessionCell(ps, idx) {
        var lbl = document.createElement('label');
        lbl.className = 'origin-rebase-session';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'origin-rebase-session-toggle';
        cb.dataset.sessionIndex = String(idx);
        cb.checked = true;
        if (idx === activeIdx) {
            cb.disabled = true;
            cb.setAttribute('aria-label', ps.name + ' (active session, always re-based)');
            lbl.classList.add('origin-rebase-session-pinned');
        } else {
            cb.addEventListener('change', function () {
                chosen[idx] = cb.checked;
                renderSelection();
            });
        }
        lbl.appendChild(cb);
        var nm = document.createElement('span');
        nm.textContent = ps.name;
        lbl.appendChild(nm);
        return lbl;
    }

    /** Clear a table and re-fill it. A row's first cell may be a string or a
     *  Node, so the per-session rows can carry their own checkbox. */
    function fillTable(table, rows) {
        table.textContent = '';
        rows.forEach(function (row) {
            var tr = document.createElement('tr');
            if (row[2]) tr.className = 'origin-rebase-' + row[2];
            var td1 = document.createElement('td');
            if (row[0] && row[0].nodeType) td1.appendChild(row[0]);
            else td1.textContent = row[0];
            var td2 = document.createElement('td');
            td2.className = 'origin-rebase-num';
            td2.textContent = row[1];
            tr.appendChild(td1); tr.appendChild(td2);
            table.appendChild(tr);
        });
    }

    /**
     * One titled block: a title, an optional note and the table.
     *
     * `collapsible` makes it a real `<details open>` / `<summary>` rather than
     * a pair of `div`s, so folding comes with the keyboard, the accessibility
     * tree and the `open` attribute the browser already implements — a click
     * handler on a `div` would have to re-invent all three and would get the
     * last one wrong. The note and the table both go INSIDE, so folding hides
     * the whole body rather than leaving an orphaned sentence behind.
     *
     * **The open state is deliberately NOT persisted** — no
     * `persistSectionState`, no `localStorage`. That helper is for display
     * taste in a long-lived panel; this is the confirmation for an operation
     * whose two-table split IS the claim being made about it, and is the only
     * thing about the action a user has to trust. Someone who folded these
     * once must not thereafter be asked to confirm a re-base with the numbers
     * hidden, so every open of the dialog builds them expanded again.
     *
     * Only the two headline tables pass `collapsible`. The `By session` block
     * stays a plain `div`: it holds the per-session checkboxes, and folding
     * away the control the user came to use is worse than an uneven stack.
     */
    function buildTable(id, title, note, rows, collapsible) {
        var wrap = document.createElement(collapsible ? 'details' : 'div');
        wrap.className = 'origin-rebase-block';
        // Expanded at build time, which is the only time there is: the dialog
        // is rebuilt from scratch on every open, so there is no state to carry.
        if (collapsible) wrap.open = true;

        var bh = document.createElement(collapsible ? 'summary' : 'div');
        // Same class in both shapes, so the title keeps one appearance; the
        // disclosure triangle is drawn in CSS off the `summary` selector, which
        // keeps `textContent` exactly the title the readers scrape.
        bh.className = 'origin-rebase-block-title';
        bh.textContent = title;
        wrap.appendChild(bh);

        var sub = null;
        if (note) {
            sub = document.createElement('div');
            sub.className = 'origin-rebase-block-note';
            sub.textContent = note;
            wrap.appendChild(sub);
        }

        var table = document.createElement('table');
        table.className = 'origin-rebase-table';
        table.id = id;
        fillTable(table, rows);
        wrap.appendChild(table);
        modal.appendChild(wrap);
        return { table: table, note: sub, block: wrap };
    }

    // The two headline tables are FUNCTIONS of the tally rather than literals,
    // because the tally MOVES: unchecking a session re-folds it, and a dialog
    // still quoting the whole project while three of five sessions are switched
    // off would be lying about what Continue is going to do.
    function originRows(tt) {
        return [
            ['3D points to update', n(tt.points3d), null],
            ['\u2003pose keypoints', n(tt.keypoints3d), 'sub'],
            [grp(tt.userGroups, 'User instance'), n(tt.userKeypoints3d), 'sub2'],
            [grp(tt.predictedGroups, 'Predicted instance'), n(tt.predictedKeypoints3d), 'sub2'],
            [grp(tt.untypedGroups, 'ungrouped / untyped'), n(tt.untypedKeypoints3d), 'sub2'],
            ['\u2003plane nodes', n(tt.planeNodes), 'sub'],
            ['Plane fits', n(tt.planeFits) + ' \u2014 centroid and normal', null],
            ['Camera extrinsics', n(tt.cameras) + ' \u2014 rvec and tvec', null],
        ];
    }
    function keepRows(tt) {
        return [
            ['User 2D instances', twoD(tt.userInstances, tt.userMembers), null],
            ['Predicted 2D instances', twoD(tt.predictedInstances, tt.predictedMembers), null],
            ['Reprojection instances', n(tt.reprojectedInstances), null],
            ['Plane placements (2D)', n(tt.planePoints2d), null],
            ['Camera intrinsics + distortion', n(tt.cameras), null],
            ['Image size, camera order', n(tt.cameras), null],
        ];
    }

    // ---------- table 1: what the re-base rewrites ----------
    // "updated" rather than "rewritten": these numbers are re-expressed in a
    // new frame, which is not the same threat as being overwritten \u2014 and this
    // dialog's other job is saying what is NOT overwritten.
    var countsTable = buildTable('originRebaseCounts', 'Origin-dependent \u2014 updated',
        'Every number here is re-expressed in the new origin.', originRows(t), true).table;

    // ---------- table 2: what it does not touch ----------
    var keepsTable = buildTable('originRebaseKeeps', 'Not origin-dependent \u2014 unchanged',
        'Nothing here moves, and no pixel changes: the world and the cameras ' +
        'move together.', keepRows(t), true).table;

    // ---------- per-session, only when there is more than one ----------
    //
    // A multi-session project can carry a DIFFERENT `calibration.toml` per
    // session, so "8 cameras in 3 sessions" is not enough to check the
    // operation against — the user needs to see which session contributes
    // what, AND to say which of them move. Kept as its own block rather than
    // as sub-rows of the totals: the rows above already decompose by
    // provenance and sum exactly to their headline, and a second, orthogonal
    // decomposition under the same parent would break that column-adds-up rule.
    var sessionNote = null;
    var subsetWarn = null;
    if (t.perSession.length > 1) {
        var perRows = [];
        for (var psi = 0; psi < t.perSession.length; psi++) {
            var ps = t.perSession[psi];
            perRows.push([
                sessionCell(ps, psi),
                n(ps.keypoints3d) + ' 3D \u00b7 ' + n(ps.cameras) + ' cam \u00b7 ' +
                    n(ps.userInstances + ps.predictedInstances) + ' 2D',
                'sub',
            ]);
        }
        // The note is filled by `renderSelection`, which owns every string in
        // this block that depends on the selection.
        sessionNote = buildTable('originRebaseBySession', 'By session', ' ', perRows).note;

        // The hazard, stated only when it is real. A session left behind keeps
        // its old 3D while the rest of the project moves, so the project then
        // holds 3D in TWO frames — which is exactly the condition
        // `pose/calibration-compare.js` detects and `ui/calibration-notice.js`
        // reports on the next load. It sits directly under the checkboxes
        // rather than with the two cautions further down, because it is
        // feedback on the control that causes it.
        subsetWarn = document.createElement('div');
        subsetWarn.className = 'origin-rebase-caution origin-rebase-caution-warn';
        subsetWarn.id = 'originRebaseSubsetWarning';
        modal.appendChild(subsetWarn);
    }

    var caution = document.createElement('div');
    caution.className = 'origin-rebase-caution';
    caution.id = 'originRebaseCaution';
    caution.textContent =
        'Do not close this tab, reload, or switch away from the browser while the update runs. ' +
        'It cannot resume, and a project left half-updated would mix two coordinate frames.';
    modal.appendChild(caution);

    // The second warning, and the one with a life after this dialog closes.
    // Writing a NEW file rather than overwriting `calibration.toml` is what
    // keeps this action from reaching into something other tools share — but it
    // leaves a calibration on disk that no longer matches the project.
    //
    // What this says is EXACTLY what `pickCalibrationFile` does: given both
    // names in one folder it takes `REBASED_CALIBRATION_NAME`. It used to also
    // claim a folder `.toml` is preferred over the calibration embedded in the
    // `.slp` — true of `handleLoadSessionFolderSingleSlp`, which falls back to
    // the embedded copy only when the folder has no `.toml`, but NOT of
    // reopening the `project.slp`, which never scans a folder at all. Stating
    // it unconditionally overstated the hazard for the ordinary reopen, so the
    // warning now makes only the claim that always holds.
    var stale = document.createElement('div');
    stale.className = 'origin-rebase-caution origin-rebase-caution-warn';
    stale.id = 'originRebaseStaleWarning';
    stale.textContent =
        'Your existing calibration.toml is NOT overwritten — the re-based one is exported ' +
        'as a new file, ' + REBASED_CALIBRATION_NAME + '. It takes precedence over ' +
        'calibration.toml when both are in the folder, so that is the calibration this ' +
        'project will load from now on.';
    modal.appendChild(stale);

    // The multi-session note is selection-dependent too: its first clause is
    // the count that moves. Left as a literal it would keep saying "all", which
    // is the one sentence in the dialog a user checks their intent against.
    var multi = null;
    if (t.sessions > 1) {
        multi = document.createElement('div');
        multi.className = 'plane-confirm-message';
        multi.id = 'originRebaseMultiNote';
        modal.appendChild(multi);
    }

    // ---- everything the selection changes, in one place ----
    //
    // One renderer rather than a handler per string: the tables, the block
    // note, the hazard warning and the multi-session note all describe the same
    // one fact, and a checkbox that updated three of the four would leave the
    // dialog self-contradicting. Called once at build time so the initial
    // strings come from here too, and never from a literal that could drift.
    function renderSelection() {
        // Re-FOLD, not re-count: every session-scoped number is already in
        // `tFull.perSession`, and re-counting would re-walk a lazy project's
        // whole columnar store on every click (see `subsetRebaseTally`).
        t = subsetRebaseTally(tFull, function (ps, i) { return chosen[i]; });
        fillTable(countsTable, originRows(t));
        fillTable(keepsTable, keepRows(t));

        var total = tFull.perSession.length;
        var picked = t.perSession.length;
        var left = total - picked;

        if (sessionNote) {
            sessionNote.textContent =
                'Choose which sessions move. "' + tFull.perSession[activeIdx].name +
                '" is the active session and always moves \u2014 its cameras are what the new ' +
                'calibration file describes \u2014 and plane nodes and plane fits are ' +
                'project-wide, so they are not split here.';
        }
        if (subsetWarn) {
            // SHORT, and only when a session is actually switched off. The
            // consequence is one thing: the project ends up holding 3D in two
            // frames, and nothing on screen contradicts that until someone
            // compares a distance across sessions.
            subsetWarn.style.display = left > 0 ? '' : 'none';
            subsetWarn.textContent = left === 0 ? '' :
                (left === 1 ? '1 session will keep its current 3D, '
                            : n(left) + ' sessions will keep their current 3D, ') +
                'so this project will hold 3D in TWO different coordinate frames and distances ' +
                'will not compare across sessions. LUCID reports the mismatch the next time it ' +
                'loads the project.';
        }
        if (multi) {
            // The trailing count is `picked - 1`, NOT `total - 1`: the folders
            // this note is about are the RE-BASED sessions other than the
            // current one, whose calibration.toml no longer matches their 3D.
            // A deselected session kept its old 3D and its old calibration, so
            // those two still agree — counting it would send the user to update
            // a folder that is already consistent. With everything selected the
            // two are the same number, which is the all-sessions case.
            var others = picked - 1;
            multi.textContent =
                (left === 0
                    ? 'All ' + n(total) + ' loaded sessions are re-based, but only the '
                    : n(picked) + ' of ' + n(total) + ' loaded sessions are re-based, and only the ') +
                'current session\u2019s cameras are written to a new calibration file.' +
                // Nothing to say when the current session is the only one
                // moving: there are no other re-based folders, and an
                // instruction about sessions that do not exist reads as a
                // defect in the dialog.
                (others > 0
                    ? ' The other ' + n(others) + ' session folder(s) keep their old ' +
                      'calibration.toml. Ensure other re-based sessions have an updated ' +
                      'calibration file in their folders.'
                    : '');
        }
    }
    renderSelection();


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

    var cancel = document.createElement('button');
    cancel.id = 'btnRebaseCancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', close);
    actions.appendChild(cancel);

    var ok = document.createElement('button');
    ok.id = 'btnRebaseContinue';
    ok.className = 'primary';
    ok.textContent = 'Continue';
    ok.addEventListener('click', function () {
        // The CHOSEN sessions, not all of them. Passing the filtered array is
        // the whole mechanism: `planOriginRebase` re-bases the 3D and the
        // cameras of exactly what it is handed, so a deselected session's
        // points and its extrinsics both stay where they are — which is what
        // keeps that session internally consistent, and every one of its
        // pixels where it was.
        var picked = sessions.filter(function (s, i) { return chosen[i]; });
        close();
        // Not awaited: the click handler must return so the browser does not
        // sit on a blocked gesture. Errors are reported inside.
        runSetCalibration(picked);
    });
    actions.appendChild(ok);

    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
}

// ============================================
// Step 2 — a NEW calibration file, never the old one
// ============================================

/**
 * Where to write it, asked for once.
 *
 * Load Calibration goes through a plain `<input type=file>`, which hands back
 * bytes and no write handle, and a session-folder load gives no handles at all
 * — so there is nothing to inherit and the user has to point somewhere once.
 * MUST be called synchronously from the Continue click: `showSaveFilePicker`
 * requires transient user activation.
 *
 * @returns {Promise<FileSystemFileHandle|null|'download'>} a handle, `'download'`
 *   when the browser has no File System Access API (the caller falls back to a
 *   plain download), or null when the user declined.
 */
async function acquireCalibrationTarget() {
    if (calibHandle) return calibHandle;
    if (!window.showSaveFilePicker) return 'download';
    try {
        calibHandle = await window.showSaveFilePicker({
            suggestedName: REBASED_CALIBRATION_NAME,
            types: [{ description: 'Calibration', accept: { 'application/toml': ['.toml'] } }],
        });
        return calibHandle;
    } catch (e) {
        if (e && e.name === 'AbortError') return null;
        throw e;
    }
}

// ============================================
// Step 3 — the blocking progress modal
// ============================================

/**
 * A modal that blocks everything but its own Cancel button.
 *
 * The full-screen scrim stops the pointer; a capture-phase `keydown` swallower
 * stops the app's shortcuts, which are bound on `document` and would otherwise
 * happily scrub the timeline or start a triangulation on top of a re-base. Esc
 * is passed through as Cancel, per the project's modal rule.
 */
function openProgressModal(onCancel) {
    var overlay = document.createElement('div');
    overlay.className = 'plane-confirm-overlay';
    overlay.id = 'originRebaseProgress';

    var modal = document.createElement('div');
    modal.className = 'plane-confirm-modal origin-rebase-modal';
    modal.innerHTML =
        '<h3>Updating 3D points…</h3>' +
        '<div class="plane-confirm-message" id="rebaseProgressNote">' +
        'Keep this tab open until it finishes.</div>' +
        '<div class="multi-frame-progress">' +
        '  <div class="progress-label" id="rebaseProgressLabel">Preparing…</div>' +
        '  <div class="progress-bar-track"><div class="progress-bar-fill" id="rebaseProgressFill" style="width:0%"></div></div>' +
        '</div>' +
        '<div class="modal-actions"><button id="btnRebaseAbort">Cancel</button></div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function swallow(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
        e.preventDefault();
        e.stopPropagation();
    }
    document.addEventListener('keydown', swallow, true);
    modal.querySelector('#btnRebaseAbort').addEventListener('click', onCancel);

    return {
        setProgress: function (done, total) {
            var pct = total > 0 ? Math.round((done / total) * 100) : 0;
            var label = document.getElementById('rebaseProgressLabel');
            var fill = document.getElementById('rebaseProgressFill');
            if (label) label.textContent = n(done) + ' / ' + n(total) + ' (' + pct + '%)';
            if (fill) fill.style.width = pct + '%';
        },
        setPhase: function (text) {
            var label = document.getElementById('rebaseProgressLabel');
            if (label) label.textContent = text;
        },
        disableCancel: function () {
            var b = document.getElementById('btnRebaseAbort');
            if (b) b.disabled = true;
        },
        close: function () {
            document.removeEventListener('keydown', swallow, true);
            if (overlay.parentNode) overlay.remove();
        },
    };
}

// ============================================
// Steps 2-5 — the flow
// ============================================

/**
 * Acquire the file, plan, write, apply. Every early exit leaves the project
 * byte-for-byte as it was.
 *
 * @param {Array} sessions - the sessions to re-base. On a multi-session project
 *   this is the SUBSET the confirmation dialog's checkboxes chose, and the
 *   filtering is the whole mechanism: the 3D and the cameras of a session that
 *   is not in this array are both left alone, so it stays internally
 *   consistent (and the project then holds 3D in two frames, which the dialog
 *   warns about). The ACTIVE session must be in it — its cameras are what gets
 *   written — and is force-included below rather than trusted.
 * @returns {Promise<Object|null>} the applied tally, or null if nothing happened
 */
export async function runSetCalibration(sessions) {
    var f = originState.frame;
    if (!f) return null;

    // Without the active session in the list, `exportCalibrationTOML` below
    // would be handed zero cameras and write a valid, empty calibration —
    // silently, and after the 3D had already moved. The dialog pins its
    // checkbox on, so this is unreachable from the UI; it is here because the
    // failure mode is silent and this function is exported.
    sessions = (sessions || []).slice();
    if (state.session && sessions.indexOf(state.session) < 0) sessions.unshift(state.session);
    if (!sessions.length) return null;

    var target;
    try {
        target = await acquireCalibrationTarget();
    } catch (e) {
        setStatus('Could not create the new calibration file: ' + (e && e.message ? e.message : e), 'error');
        return null;
    }
    if (target === null) {
        setStatus('Cancelled — the project is unchanged');
        return null;
    }

    var cancelled = false;
    var ui = openProgressModal(function () {
        cancelled = true;
        ui.setPhase('Cancelling…');
        ui.disableCancel();
    });

    var plan;
    try {
        plan = await planOriginRebase(sessions, planeModel(), f, {
            onProgress: ui.setProgress,
            shouldCancel: function () { return cancelled; },
        });
    } catch (e) {
        ui.close();
        setStatus('Re-base failed: ' + (e && e.message ? e.message : e), 'error');
        return null;
    }

    if (!plan) {
        ui.close();
        setStatus('Cancelled — no points were changed and the calibration was not written', 'warning');
        return null;
    }
    if (plan.failed) {
        ui.close();
        setStatus('Camera "' + plan.camera + '" has extrinsics that cannot be re-based — nothing was changed', 'error');
        return null;
    }

    // ---- write the calibration, still before anything is committed ----
    ui.disableCancel();
    ui.setPhase('Writing calibration…');
    var active = state.session || sessions[0];
    var rebasedCams = [];
    for (var i = 0; i < plan.cameras.length; i++) {
        var cp = plan.cameras[i];
        if (!active || !active.cameras || active.cameras.indexOf(cp.camera) < 0) continue;
        // A shallow stand-in, not a `Camera`: `exportCalibrationTOML` reads six
        // fields and nothing else, and the live camera must not be mutated yet.
        rebasedCams.push({
            name: cp.camera.name, matrix: cp.camera.matrix, dist: cp.camera.dist,
            size: cp.camera.size, rvec: cp.rvec, tvec: cp.tvec,
        });
    }
    var toml = exportCalibrationTOML(rebasedCams);
    var wroteTo;
    try {
        if (target === 'download') {
            downloadTOML(toml, REBASED_CALIBRATION_NAME);
            wroteTo = 'downloaded ' + REBASED_CALIBRATION_NAME;
        } else {
            var writable = await target.createWritable();
            await writable.write(toml);
            await writable.close();
            wroteTo = 'wrote ' + target.name;
        }
    } catch (e) {
        ui.close();
        // The plan is dropped here, so a failed write leaves the 3D alone
        // rather than stranding it in a frame the calibration does not share.
        setStatus('Could not write the calibration: ' + (e && e.message ? e.message : e) +
            ' — no points were changed', 'error');
        return null;
    }

    // ---- commit ----
    ui.setPhase('Applying…');
    var tally = applyOriginRebase(plan);
    finishRebase();
    ui.close();

    // Same rule as the dialog's headline: "3D points" is the TOTAL, and the
    // split is spelled out rather than left to a reader who would otherwise
    // read "0 3D points, 9 plane nodes" as a contradiction.
    // The save runs BEFORE the status line rather than after it, so the one
    // line left on screen describes the whole operation. `quickSave` writes its
    // own progress into the status bar, so a summary set first would simply be
    // overwritten by "Saved (12.3 MB)" and the re-base counts would be lost.
    var saved = await autoSaveAfterRebase();
    setStatus('Set as new calibration — ' + wroteTo + ', re-based ' + n(tally.points3d) +
        ' 3D points (' + n(tally.keypoints3d) + ' pose keypoints, ' +
        n(tally.planeNodes) + ' plane nodes) and ' + n(tally.cameras) +
        ' cameras' + saved.note, saved.level);
    return tally;
}

/**
 * Write the re-based project to disk, without asking.
 *
 * The re-base is an in-memory edit, so `project.slp` holds the OLD coordinates
 * until something saves. That used to be the user's job, stated as the first
 * of two obligations in a completion modal. It is a bad thing to leave to a
 * human: the file on disk now disagrees with the calibration that was just
 * written beside it, and the window where that is true has no reason to exist.
 * So the save happens here.
 *
 * **It only saves when the project already has a file handle.** `quickSave`
 * would otherwise open `showSaveFilePicker`, which requires transient user
 * activation — and the activation from the Continue click is long gone after a
 * re-base, so the picker would throw `SecurityError` and the auto-save would
 * report a failure for a project that was never on disk in the first place.
 * That case gets a status line asking for a Save instead, which is the honest
 * answer: there is no file to update.
 *
 * Failures are reported by `quickSave` itself and deliberately not re-raised —
 * the re-base already succeeded and is already in memory, so a failed save is
 * a save problem, not a reason to make the caller think the commit did not
 * happen.
 */
async function autoSaveAfterRebase() {
    if (!state.slpFileHandle) {
        return {
            note: ' — this project has no file yet, so use File ▸ Save As to write the new 3D to disk',
            level: 'warning',
        };
    }
    try {
        await quickSave();
    } catch (e) {
        console.error('[origin-rebase] auto-save after re-base failed:', e);
    }
    // `quickSave` reports its own failures and does not re-raise, so the
    // DIRTY FLAG is what says whether it worked: `finishRebase` set it, and
    // only a successful save clears it. Inferring success from the absence of
    // an exception would call a failed save a success.
    if (state.isDirty) {
        return {
            note: ' — but the project could NOT be saved, so the new 3D is still only in memory',
            level: 'error',
        };
    }
    return { note: ', and saved the project', level: 'success' };
}

/**
 * Put the app back in a consistent state after the swap.
 *
 * The defined origin is CLEARED, not kept: the project is now expressed in that
 * frame, so the offset from it is zero and a table still reporting the old
 * rotation would be describing a transform that has already happened. The grid
 * goes back to the world axes for the same reason — it is already drawing the
 * new origin.
 *
 * `triangulationResults` is derived from 3D that just moved, so it is dropped
 * rather than transformed; it refills on the next draw.
 */
function finishRebase() {
    originState.frame = null;
    if (viewport3d) viewport3d.setOriginFrame(null);

    if (state.triangulationResults) state.triangulationResults.clear();
    var list = state.sessions || [];
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].triangulationResults) list[i].triangulationResults.clear();
    }

    markDirty();
    renderOriginResult();
    refreshPlanePanel();
    syncPlanes3D();
    // The pose skeletons in the 3D scene are built from `points3d`, which every
    // one of them just had replaced, so the viewport has to be rebuilt rather
    // than merely re-framed. 2D is untouched but `drawAllOverlays` re-derives
    // the reprojection errors it draws, which now come from the new numbers.
    update3DViewport(state.currentFrame);
    drawAllOverlays(state.currentFrame);
    if (viewport3d && viewport3d.fitToScene) viewport3d.fitToScene();
}
