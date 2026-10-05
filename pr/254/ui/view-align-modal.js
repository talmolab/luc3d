/**
 * ui/view-align-modal.js — View ▸ "Align Views to References…" (issue #226).
 *
 * The user rotates two (or more) views the way they like (Visibility ▸ Video
 * Rotation, or the Shift+R+←/→ chord), ticks them here as references, and every
 * other view is turned to match. The geometry — why at least two references,
 * and how one rotation per camera falls out of them — lives in
 * `pose/view-align.js`; this module is the dialog and the write-back.
 *
 * Writes go through the same two copies every rotation edit updates (see
 * `populateVideoRotationTable` in `ui/sessions-panes.js`): the session store
 * (`setSessionRotation`, the durable `.slp` state) and, for the active
 * session's live panes, `view.rotation` + `applyZoom`. Hit-testing, labels and
 * the overlay export already handle arbitrary angles, so nothing else changes.
 *
 * "Apply to all sessions" re-solves each other session from its OWN
 * calibration, carrying over the references' angles from this one — the
 * per-session redo the issue asks to remove.
 *
 * Depends on: pose/view-align.js, ui/video-filters.js, ui/app-state.js,
 * ui/sessions-panes.js (syncRotationUI), ui/rendering.js, save-load.js.
 */

import { state, videoController, getActiveSession } from './app-state.js?v=9da3025335eb';
import { setStatus, markDirty } from '../import-export/save-load.js?v=9da3025335eb';
import { drawAllOverlays } from './rendering.js?v=9da3025335eb';
import { syncRotationUI } from './sessions-panes.js?v=9da3025335eb';
import { getSessionRotation, setSessionRotation, clampRotationSetting } from './video-filters.js?v=9da3025335eb';
import { alignViewRotations } from '../pose/view-align.js?v=9da3025335eb';

// The last references applied, by camera name, so reopening the dialog (or
// opening it on the next session of the same rig) starts from the same ones.
// In-memory only: the result is what persists, as ordinary `videoRotation`.
var _lastRefs = [];

/** A camera with a real extrinsic calibration (not the all-zero placeholder). */
function isCalibrated(cam) {
    if (!cam || !cam.matrix || !cam.rvec || !cam.tvec) return false;
    var r = cam.rvec, t = cam.tvec;
    if (Array.isArray(r[0])) return true;  // anipose 3x3 rotation matrix
    return r[0] !== 0 || r[1] !== 0 || r[2] !== 0 || t[0] !== 0 || t[1] !== 0 || t[2] !== 0;
}

function calibratedCameras(session) {
    return ((session && session.cameras) || []).filter(isCalibrated);
}

function currentRotations(session, cams) {
    var out = {};
    for (var i = 0; i < cams.length; i++) out[cams[i].name] = getSessionRotation(session, cams[i].name);
    return out;
}

/**
 * Initial references: the last set used (if this session has them all), else
 * the views the user has already turned, if there are at least two of them.
 */
function defaultReferences(cams, rotations) {
    var names = cams.map(function (c) { return c.name; });
    if (_lastRefs.length >= 2 && _lastRefs.every(function (n) { return names.indexOf(n) >= 0; })) {
        return _lastRefs.slice();
    }
    var turned = names.filter(function (n) { return rotations[n] !== 0; });
    return turned.length >= 2 ? turned : [];
}

// Reference mismatch (degrees) above which the dialog says so. Below it the
// references are consistent within calibration noise.
var DISAGREEMENT_NOTE_DEG = 10;

function fmtDeg(v) { return v + '°'; }

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

/**
 * Write a solve's rotations into `session`. For the active session the live
 * views are updated too. Returns the number of NON-reference cameras changed.
 */
function applyToSession(session, res, refs) {
    var changed = 0;
    var names = Object.keys(res.rotations);
    for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var before = getSessionRotation(session, name);
        var stored = setSessionRotation(session, name, res.rotations[name]);
        if (refs.indexOf(name) < 0 && stored !== before) changed++;
    }
    if (session === state.session) {
        for (var v = 0; v < state.views.length; v++) {
            var view = state.views[v];
            if (!(view.name in res.rotations)) continue;
            view.rotation = getSessionRotation(session, view.name);
            if (videoController) videoController.applyZoom(view);
            syncRotationUI(view);
        }
    }
    return changed;
}

/**
 * Re-solve every other session from its own calibration with the active
 * session's reference angles. Sessions lacking a reference camera (or a
 * calibration) are reported, never half-applied.
 */
function applyToOtherSessions(refs, refRotations) {
    var done = 0, changed = 0, skipped = [];
    for (var i = 0; i < state.sessions.length; i++) {
        var s = state.sessions[i];
        if (!s || s === state.session) continue;
        var cams = calibratedCameras(s);
        var names = cams.map(function (c) { return c.name; });
        var absent = refs.filter(function (n) { return names.indexOf(n) < 0; });
        if (absent.length) {
            skipped.push(s.name + ' (no calibrated ' + absent.join(', ') + ')');
            continue;
        }
        var res = alignViewRotations(cams, refRotations, refs);
        if (!res.ok) { skipped.push(s.name + ' (' + res.error + ')'); continue; }
        changed += applyToSession(s, res, refs);
        // `markDirty()` flags only the ACTIVE session, but the switch-away save
        // prompt and lazy eviction key off each session's own flag — an edited
        // background session must not look clean.
        s.isDirty = true;
        done++;
    }
    return { done: done, changed: changed, skipped: skipped };
}

/** Show the Align Views to References dialog. Cancel / Esc / backdrop close it unchanged. */
export function showAlignViewsModal() {
    var session = getActiveSession();
    if (!session || !session.cameras || session.cameras.length === 0) {
        setStatus('No session with cameras loaded', 'error');
        return;
    }
    var cams = calibratedCameras(session);
    if (cams.length < 3) {
        setStatus(cams.length < 2
            ? 'Aligning views needs a calibrated session — load a calibration first'
            : 'Aligning views needs at least three calibrated cameras', 'error');
        return;
    }
    var rotations = currentRotations(session, cams);
    var refs = defaultReferences(cams, rotations);
    var otherSessions = state.sessions.filter(function (s) { return s && s !== session; }).length;

    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'multi-frame-modal align-views-modal';
    var rowsHtml = cams.map(function (c, i) {
        return '<tr data-cam="' + i + '">' +
            '<td><input type="checkbox" class="align-views-ref" data-cam="' + i + '"></td>' +
            '<td class="align-views-name">' + escapeHtml(c.name) + '</td>' +
            '<td class="align-views-num">' + fmtDeg(rotations[c.name]) + '</td>' +
            '<td class="align-views-result"></td>' +
            '</tr>';
    }).join('');
    modal.innerHTML =
        '<h3>Align Views to References</h3>' +
        '<p>Rotate two or more views the way you want them (Visibility ▸ Video Rotation, ' +
        'or hold <kbd>Shift</kbd>+<kbd>R</kbd> and press ←/→), then tick them as references. ' +
        'Every other view is rotated to match, using the camera calibration: cameras ' +
        'near a reference take after it, so a top view and a side view can both be references.</p>' +
        '<table class="align-views-table">' +
        '<thead><tr><th>Ref</th><th>Camera</th><th class="align-views-num">Now</th><th>After</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody></table>' +
        (otherSessions > 0
            ? '<label class="align-views-all"><input type="checkbox" id="alignViewsAll"> ' +
              'Also apply to the other ' + otherSessions + ' session' + (otherSessions === 1 ? '' : 's') +
              ' (each uses its own calibration)</label>'
            : '') +
        '<div class="track-range-summary" id="alignViewsSummary"></div>' +
        '<div class="modal-error" id="alignViewsError"></div>' +
        '<div class="modal-actions">' +
        '<button id="alignViewsCancel">Cancel</button>' +
        '<button class="primary" id="alignViewsApply">Apply</button>' +
        '</div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var boxes = modal.querySelectorAll('.align-views-ref');
    var resultCells = modal.querySelectorAll('.align-views-result');
    var summaryEl = modal.querySelector('#alignViewsSummary');
    var errorEl = modal.querySelector('#alignViewsError');
    var applyBtn = modal.querySelector('#alignViewsApply');
    var allBox = modal.querySelector('#alignViewsAll');
    var lastResult = null;

    function solve() {
        if (refs.length < 2) return null;
        return alignViewRotations(cams, rotations, refs);
    }

    function refresh() {
        for (var i = 0; i < cams.length; i++) boxes[i].checked = refs.indexOf(cams[i].name) >= 0;
        var res = solve();
        lastResult = res && res.ok ? res : null;
        var skippedBy = {};
        if (lastResult) lastResult.skipped.forEach(function (s) { skippedBy[s.name] = s.reason; });
        var turning = 0;
        for (var k = 0; k < cams.length; k++) {
            var name = cams[k].name;
            var cell = resultCells[k];
            cell.className = 'align-views-result';
            if (refs.indexOf(name) >= 0) {
                cell.textContent = 'reference';
                cell.classList.add('is-ref');
            } else if (!lastResult) {
                cell.textContent = '';
            } else if (name in skippedBy) {
                cell.textContent = 'unchanged — ' + skippedBy[name];
                cell.classList.add('is-skipped');
            } else {
                var after = clampRotationSetting(lastResult.rotations[name]);
                cell.textContent = fmtDeg(after);
                if (after !== rotations[name]) turning++;
            }
        }
        if (refs.length < 2) {
            errorEl.textContent = '';
            summaryEl.textContent = 'Tick ' + (2 - refs.length) + ' more reference view' + (refs.length === 1 ? '' : 's') + '.';
        } else if (!lastResult) {
            errorEl.textContent = res ? res.error : '';
            summaryEl.textContent = '';
        } else {
            errorEl.textContent = '';
            var n = lastResult.skipped.length;
            summaryEl.textContent = turning + ' view' + (turning === 1 ? '' : 's') + ' will rotate' +
                (n ? ' · ' + n + ' left unchanged' : '') + '.' +
                (lastResult.disagreementDeg > DISAGREEMENT_NOTE_DEG
                    ? ' The references disagree by about ' + Math.round(lastResult.disagreementDeg) +
                      '°, so views between them get a compromise.'
                    : '');
        }
        applyBtn.disabled = !lastResult;
    }

    function onToggle(e) {
        var name = cams[parseInt(e.target.dataset.cam, 10)].name;
        var at = refs.indexOf(name);
        if (e.target.checked && at < 0) {
            refs.push(name);
        } else if (!e.target.checked && at >= 0) {
            refs.splice(at, 1);
        }
        refresh();
    }

    function close() {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
    }

    function apply() {
        if (!lastResult) return;
        var res = lastResult;
        var chosen = refs.slice();
        _lastRefs = chosen.slice();
        var changed = applyToSession(session, res, chosen);
        var msg = 'Aligned ' + changed + ' view' + (changed === 1 ? '' : 's') + ' to ' + chosen.join(' + ');
        var level = 'success';
        if (allBox && allBox.checked) {
            var refRot = {};
            chosen.forEach(function (n) { refRot[n] = rotations[n]; });
            var other = applyToOtherSessions(chosen, refRot);
            msg += ' · ' + other.done + ' other session' + (other.done === 1 ? '' : 's') +
                ' (' + other.changed + ' view' + (other.changed === 1 ? '' : 's') + ')';
            if (other.skipped.length) {
                msg += ' · skipped ' + other.skipped.join('; ');
                level = 'warning';
            }
        }
        if (res.skipped.length) {
            msg += ' · unchanged: ' + res.skipped.map(function (s) { return s.name; }).join(', ');
        }
        close();
        drawAllOverlays(state.currentFrame);
        // Rotation is project state (saved into the .slp), like every other
        // rotation edit.
        markDirty();
        setStatus(msg, level);
    }

    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'Enter' && !applyBtn.disabled) { e.preventDefault(); apply(); }
    }
    document.addEventListener('keydown', onKey);

    for (var b = 0; b < boxes.length; b++) boxes[b].addEventListener('change', onToggle);
    modal.querySelector('#alignViewsCancel').addEventListener('click', close);
    applyBtn.addEventListener('click', apply);
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
    });

    refresh();
    (boxes[0] || applyBtn).focus();
}
