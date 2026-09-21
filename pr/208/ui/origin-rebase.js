// ui/origin-rebase.js — "Set as New Calibration", the Danger Zone's other half.
//
// `Export New Calibration` writes a re-based calibration and leaves the project
// exactly as it was. This one commits: it writes the calibration over the file
// on disk AND rewrites every 3D number in the project, so the world the project
// is expressed in becomes the origin the user defined. Afterwards there is no
// offset left to report, and the Defined Origin block disappears with it.
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
//      oddly. Declining here aborts with nothing touched.
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

import { state, viewport3d } from './app-state.js';
import { setStatus, markDirty } from '../import-export/save-load.js';
import { exportCalibrationTOML, downloadTOML } from '../import-export/file-io.js';
import { countRebaseTargets, planOriginRebase, applyOriginRebase } from '../pose/origin-rebase.js';
// Both circular by design and used only inside function bodies, the same rule
// the rest of this directory's cycles follow.
import { originState, renderOriginResult } from './origin-definition.js';
import { planeModel, syncPlanes3D, refreshPlanePanel } from './plane-definition.js';
import { drawAllOverlays } from './rendering.js';
import { update3DViewport } from '../pose/initialization.js';

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
 * The warning modal. Lists what will be rewritten, split by provenance, and
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
    if (!sessions.length) {
        setStatus('No session loaded', 'error');
        return;
    }
    var t = countRebaseTargets(sessions, planeModel());

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
        'This rewrites the calibration on disk AND every 3D point in the project so that "' +
        f.sourceNode + '" on plane "' + f.sourcePlane + '" becomes the origin. ' +
        'All 2D annotation stays exactly where it is, and so does every reprojection — ' +
        'the world and the cameras move together, so no pixel changes.';
    modal.appendChild(intro);

    var table = document.createElement('table');
    table.className = 'origin-rebase-table';
    table.id = 'originRebaseCounts';
    [
        ['3D points to update', n(t.keypoints3d), null],
        [' from User instance groups', n(t.userGroups), 'sub'],
        [' from Predicted instance groups', n(t.predictedGroups), 'sub'],
        [' from ungrouped / untyped', n(t.untypedGroups), 'sub'],
        ['User 2D instances', n(t.userInstances), 'quiet'],
        ['Predicted 2D instances', n(t.predictedInstances), 'quiet'],
        ['Reprojection instances', n(t.reprojectedInstances) + ' — unchanged', 'quiet'],
        ['Plane nodes', n(t.planeNodes), null],
        ['Plane fits', n(t.planeFits), null],
        ['Cameras', n(t.cameras) + ' in ' + n(t.sessions) + ' session' + (t.sessions === 1 ? '' : 's'), null],
    ].forEach(function (row) {
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
    modal.appendChild(table);

    var caution = document.createElement('div');
    caution.className = 'origin-rebase-caution';
    caution.id = 'originRebaseCaution';
    caution.textContent =
        'Do not close this tab, reload, or switch away from the browser while the update runs. ' +
        'It cannot resume, and a project left half-updated would mix two coordinate frames.';
    modal.appendChild(caution);

    if (t.sessions > 1) {
        var multi = document.createElement('div');
        multi.className = 'plane-confirm-message';
        multi.id = 'originRebaseMultiNote';
        multi.textContent = 'All ' + n(t.sessions) + ' loaded sessions are re-based, but only the ' +
            'ACTIVE session’s cameras are written to the calibration file.';
        modal.appendChild(multi);
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
        close();
        // Not awaited: the click handler must return so the browser does not
        // sit on a blocked gesture. Errors are reported inside.
        runSetCalibration(sessions);
    });
    actions.appendChild(ok);

    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
}

// ============================================
// Step 2 — where calibration.toml lives
// ============================================

/**
 * The file to overwrite, asked for once.
 *
 * Load Calibration goes through a plain `<input type=file>`, which hands back
 * bytes and no write handle, and a session-folder load gives no handles at all
 * — so there is nothing to inherit and the user has to point at the file once.
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
            suggestedName: 'calibration.toml',
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
 * @param {Array} sessions
 * @returns {Promise<Object|null>} the applied tally, or null if nothing happened
 */
export async function runSetCalibration(sessions) {
    var f = originState.frame;
    if (!f) return null;

    var target;
    try {
        target = await acquireCalibrationTarget();
    } catch (e) {
        setStatus('Could not open the calibration file: ' + (e && e.message ? e.message : e), 'error');
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
            downloadTOML(toml, 'calibration.toml');
            wroteTo = 'downloaded calibration.toml';
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

    setStatus('Set as new calibration — ' + wroteTo + ', re-based ' + n(tally.keypoints3d) +
        ' 3D points, ' + n(tally.planeNodes) + ' plane nodes and ' + n(tally.cameras) +
        ' cameras', 'success');
    return tally;
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
